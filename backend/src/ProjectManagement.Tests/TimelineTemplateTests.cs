using System.Net;
using System.Text.Json.Nodes;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>A workspace's own project timelines (created, edited, saved from a project) and reordering the stages of a project.</summary>
[Collection("api")]
public class TimelineTemplateTests(ApiFactory factory)
{
    private async Task<TestClient> Owner(string plan = "PRO")
    {
        var c = await TestClient.RegisterAsync(factory);
        await c.CreateOrgAsync();
        if (plan != "FREE") await c.UpgradeAsync(plan);
        return c;
    }

    private static object Template(string name, params (string Name, int Weight)[] stages) =>
        new { name, description = $"About {name}", stages = stages.Select(s => new { name = s.Name, weight = s.Weight }).ToArray() };

    private static (string, int)[] Sample => [("Design", 2), ("Build", 4), ("Ship", 1)];

    private static async Task<JsonNode> Create(TestClient c, string name = "Agency delivery", params (string Name, int Weight)[] stages)
    {
        var res = await c.Post("/api/v1/projects/timeline-templates", Template(name, stages.Length == 0 ? Sample : stages));
        Assert.Equal(HttpStatusCode.Created, res.Status);
        return res.Data!;
    }

    private static string[] Names(JsonNode? array) => array!.AsArray().Select(s => s!["name"]!.GetValue<string>()).ToArray();

    private static async Task<Dictionary<string, JsonNode>> Stages(TestClient c, Guid project) =>
        (await c.Get($"/api/v1/projects/{project}/stages")).Data!.AsArray().ToDictionary(s => s!["name"]!.GetValue<string>(), s => s!);

    // ------------------------------------------------------------------ custom timelines

    [Fact]
    public async Task A_workspace_can_create_edit_and_delete_its_own_timelines_which_join_the_built_in_ones()
    {
        var c = await Owner();
        var made = await Create(c);
        var id = made["id"]!.GetValue<string>();
        Assert.Equal($"custom:{id}", made["key"]!.GetValue<string>());
        Assert.True(made["isCustom"]!.GetValue<bool>());
        Assert.Equal(new[] { "Design", "Build", "Ship" }, made["stages"]!.AsArray().Select(s => s!.GetValue<string>()).ToArray());
        Assert.Equal(new[] { 2, 4, 1 }, made["weights"]!.AsArray().Select(s => s!.GetValue<int>()).ToArray());

        var list = (await c.Get("/api/v1/projects/timeline-templates")).Data!.AsArray();
        Assert.Equal(new[] { "software", "simple", "marketing", $"custom:{id}" }, list.Select(t => t!["key"]!.GetValue<string>()).ToArray());   // built-in first, then custom
        Assert.False(list[0]!["isCustom"]!.GetValue<bool>());

        var updated = await c.Put($"/api/v1/projects/timeline-templates/{id}", Template("Agency delivery v2", ("Discovery", 1), ("Design", 2), ("Build", 4), ("Ship", 1)));
        Assert.True(updated.Ok, updated.ToString());
        Assert.Equal("Agency delivery v2", updated.Data!["name"]!.GetValue<string>());
        Assert.Equal(4, updated.Data["stages"]!.AsArray().Count);

        Assert.Equal(HttpStatusCode.NoContent, (await c.Delete($"/api/v1/projects/timeline-templates/{id}")).Status);
        Assert.Equal(3, (await c.Get("/api/v1/projects/timeline-templates")).Data!.AsArray().Count);
        Assert.Equal(HttpStatusCode.NotFound, (await c.Delete($"/api/v1/projects/timeline-templates/{id}")).Status);
    }

    [Fact]
    public async Task A_new_project_starts_from_a_custom_timeline_and_later_edits_do_not_touch_it()
    {
        var c = await Owner();
        var made = await Create(c, "Agency delivery", ("Design", 2), ("Build", 4), ("Ship", 1));
        var key = made["key"]!.GetValue<string>();
        var res = await c.Post("/api/v1/projects", new { name = "Client site", priority = "Medium", status = "Active", startDate = "2027-01-01", dueDate = "2027-03-01", timelineTemplate = key });
        Assert.True(res.Ok, res.ToString());
        var project = Guid.Parse(res.Data!["project"]!["id"]!.GetValue<string>());
        Assert.Equal(new[] { "Design", "Build", "Ship" }, Names(res.Data["stages"]));

        // The first stage has a duration, so it is not a done-at-the-start marker: it is simply the one under way.
        var s = await Stages(c, project);
        Assert.Equal("InProgress", s["Design"]["status"]!.GetValue<string>());
        Assert.Equal("Pending", s["Build"]["status"]!.GetValue<string>());
        Assert.True(s["Build"]["locked"]!.GetValue<bool>());
        Assert.Equal("2027-01-01", s["Design"]["plannedStart"]!.GetValue<string>());   // dates are spread over the project by the time shares (2:4:1 of 59 days)

        // Editing or deleting the timeline afterwards leaves the project as it was.
        var id = made["id"]!.GetValue<string>();
        Assert.True((await c.Put($"/api/v1/projects/timeline-templates/{id}", Template("Agency delivery", ("Only step", 1)))).Ok);
        Assert.Equal(HttpStatusCode.NoContent, (await c.Delete($"/api/v1/projects/timeline-templates/{id}")).Status);
        Assert.Equal(new[] { "Design", "Build", "Ship" }, (await Stages(c, project)).Keys.ToArray());
    }

    [Fact]
    public async Task A_leading_stage_with_no_duration_is_done_from_the_start()
    {
        var c = await Owner();
        var made = await Create(c, "With a marker", ("Kick-off", 0), ("Work", 3), ("Handover", 1));
        var res = await c.Post("/api/v1/projects", new { name = "Marker project", priority = "Low", status = "Active", timelineTemplate = made["key"]!.GetValue<string>() });
        var s = await Stages(c, Guid.Parse(res.Data!["project"]!["id"]!.GetValue<string>()));
        Assert.Equal("Completed", s["Kick-off"]["status"]!.GetValue<string>());
        Assert.Equal("InProgress", s["Work"]["status"]!.GetValue<string>());
        Assert.False(s["Work"]["locked"]!.GetValue<bool>());
        Assert.True(s["Handover"]["locked"]!.GetValue<bool>());
    }

    [Fact]
    public async Task Custom_timelines_are_checked_and_limited()
    {
        var c = await Owner();
        async Task<ApiResult> Try(object body) => await c.Post("/api/v1/projects/timeline-templates", body);
        var ok = new[] { new { name = "A", weight = 1 } };

        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await Try(new { name = " ", stages = ok })).Status);                                 // needs a name
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await Try(new { name = new string('x', 81), stages = ok })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await Try(new { name = "No stages", stages = Array.Empty<object>() })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await Try(new { name = "Blank stage", stages = new[] { new { name = " ", weight = 1 } } })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await Try(new { name = "Bad share", stages = new[] { new { name = "A", weight = 101 } } })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await Try(new { name = "Too long", stages = Enumerable.Range(0, 31).Select(i => new { name = $"S{i}", weight = 1 }).ToArray() })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await Try(new { name = "software delivery", stages = ok })).Status);                // a built-in name, whatever the case

        await Create(c, "Mine");
        var dup = await Try(new { name = "mine", stages = ok });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, dup.Status);
        Assert.Equal("name", dup.Json!["errors"]![0]!["field"]!.GetValue<string>());

        for (var i = 1; i < 20; i++) await Create(c, $"Timeline {i}");
        var over = await Try(new { name = "One too many", stages = ok });
        Assert.Equal(HttpStatusCode.Conflict, over.Status);
        Assert.Equal("TEMPLATE_LIMIT", over.ErrorCode);
    }

    [Fact]
    public async Task Managing_timelines_needs_the_permission_and_a_plan_with_custom_workflows_and_stays_inside_the_workspace()
    {
        var free = await Owner("FREE");
        Assert.Equal("FEATURE_NOT_AVAILABLE", (await free.Post("/api/v1/projects/timeline-templates", Template("X", ("A", 1)))).ErrorCode);
        Assert.Equal(3, (await free.Get("/api/v1/projects/timeline-templates")).Data!.AsArray().Count);   // choosing one of the built-in ones is always possible

        var owner = await Owner("BUSINESS");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member);
        var manager = await owner.AddMemberAsync(factory, TenantRole.Manager);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Post("/api/v1/projects/timeline-templates", Template("Nope", ("A", 1)))).Status);
        var byManager = await manager.Post("/api/v1/projects/timeline-templates", Template("Manager's timeline", ("A", 1), ("B", 1)));
        Assert.Equal(HttpStatusCode.Created, byManager.Status);   // managers hold "manage workflows" by default
        // ...and everybody who can create a project can pick it.
        Assert.Equal(4, (await member.Get("/api/v1/projects/timeline-templates")).Data!.AsArray().Count);
        var used = await member.Post("/api/v1/projects", new { name = "Uses it", priority = "Low", timelineTemplate = byManager.Data!["key"]!.GetValue<string>() });
        Assert.True(used.Ok, used.ToString());

        // Another workspace neither sees, uses, edits nor deletes it.
        var other = await Owner("BUSINESS");
        var id = byManager.Data["id"]!.GetValue<string>();
        Assert.Equal(3, (await other.Get("/api/v1/projects/timeline-templates")).Data!.AsArray().Count);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await other.Post("/api/v1/projects", new { name = "Sneaky", priority = "Low", timelineTemplate = $"custom:{id}" })).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await other.Put($"/api/v1/projects/timeline-templates/{id}", Template("Mine now", ("A", 1)))).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await other.Delete($"/api/v1/projects/timeline-templates/{id}")).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await other.Post("/api/v1/projects", new { name = "Junk", priority = "Low", timelineTemplate = "custom:not-a-guid" })).Status);
    }

    [Fact]
    public async Task A_projects_stages_can_be_saved_as_a_timeline_keeping_their_order_and_proportions()
    {
        var c = await Owner();
        var res = await c.Post("/api/v1/projects", new { name = "Source", priority = "Low", status = "Active", startDate = "2027-01-01", dueDate = "2027-04-11", timelineTemplate = "simple" });
        var project = Guid.Parse(res.Data!["project"]!["id"]!.GetValue<string>());
        // Put an extra stage right after Planning, so the saved order is not the built-in one.
        Assert.True((await c.Post($"/api/v1/projects/{project}/stages", new { name = "Design review", status = "Pending", order = 2 })).Ok);

        var saved = await c.Post($"/api/v1/projects/{project}/timeline-templates", new { name = "Our simple flow", description = "Simple, plus a design review" });
        Assert.Equal(HttpStatusCode.Created, saved.Status);
        Assert.Equal(new[] { "Project Created", "Planning", "Design review", "Execution", "Review", "Project Completed" },
            saved.Data!["stages"]!.AsArray().Select(s => s!.GetValue<string>()).ToArray());
        var w = saved.Data["weights"]!.AsArray().Select(s => s!.GetValue<int>()).ToArray();
        Assert.Equal(0, w[0]);            // "Project Created" had no length
        Assert.Equal(10, w[3]);           // Execution is the longest stage
        Assert.Equal(1, w[2]);            // the stage added by hand had no dates
        Assert.Equal(0, w[^1]);

        // A project made from it has the same stages, in the same order.
        var again = await c.Post("/api/v1/projects", new { name = "From saved", priority = "Low", timelineTemplate = saved.Data["key"]!.GetValue<string>() });
        Assert.Equal(saved.Data["stages"]!.AsArray().Select(s => s!.GetValue<string>()).ToArray(), Names(again.Data!["stages"]));
        Assert.Equal(HttpStatusCode.NotFound, (await c.Post($"/api/v1/projects/{Guid.NewGuid()}/timeline-templates", new { name = "Ghost" })).Status);
    }

    // ------------------------------------------------------------------ reordering the stages of a project

    [Fact]
    public async Task Stages_can_be_reordered_in_one_call_and_who_is_locked_follows_the_new_order()
    {
        var c = await Owner();
        var res = await c.Post("/api/v1/projects", new { name = "Atlas", priority = "Medium", status = "Active" });
        var project = Guid.Parse(res.Data!["project"]!["id"]!.GetValue<string>());
        var url = $"/api/v1/projects/{project}/stages";
        var s = await Stages(c, project);
        var ids = (await c.Get(url)).Data!.AsArray().Select(x => x!["id"]!.GetValue<string>()).ToList();   // Project Created, R&P, Development, Code Review, ...
        Assert.True(s["Code Review"]["locked"]!.GetValue<bool>());

        // Code Review moves up to sit right after Project Created (which is done): it opens, and Requirements & Planning now waits for it.
        var reordered = ids.ToList(); reordered.Remove(s["Code Review"]["id"]!.GetValue<string>()); reordered.Insert(1, s["Code Review"]["id"]!.GetValue<string>());
        var ok = await c.Put($"{url}/order", new { stageIds = reordered });
        Assert.True(ok.Ok, ok.ToString());
        Assert.Equal(new[] { "Project Created", "Code Review", "Requirements & Planning", "Development", "Testing / QA", "UAT", "Production Deployment", "Project Completed" }, Names(ok.Data));
        Assert.Equal(reordered, (await c.Get(url)).Data!.AsArray().Select(x => x!["id"]!.GetValue<string>()).ToList());
        s = await Stages(c, project);
        Assert.False(s["Code Review"]["locked"]!.GetValue<bool>());
        Assert.True(s["Requirements & Planning"]["locked"]!.GetValue<bool>());
        Assert.Equal("Code Review", s["Requirements & Planning"]["lockedBy"]!.GetValue<string>());
        Assert.Equal("InProgress", s["Requirements & Planning"]["status"]!.GetValue<string>());   // moving a stage never changes what has been done
        Assert.Contains("Reordered the timeline", (await c.Get($"/api/v1/projects/{project}/activity")).Data!.ToJsonString());

        // Every stage exactly once: nothing changes when the list is wrong.
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Put($"{url}/order", new { stageIds = reordered.Skip(1) })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Put($"{url}/order", new { stageIds = reordered.Append(reordered[0]) })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Put($"{url}/order", new { stageIds = reordered.Skip(1).Append(Guid.NewGuid().ToString()) })).Status);
        Assert.Equal(reordered, (await c.Get(url)).Data!.AsArray().Select(x => x!["id"]!.GetValue<string>()).ToList());

        // A stage can also be added in the middle, not just at the end.
        var inserted = await c.Post(url, new { name = "Security review", status = "Pending", order = 2 });
        Assert.True(inserted.Ok, inserted.ToString());
        Assert.Equal("Security review", Names((await c.Get(url)).Data)[2]);
    }

    [Fact]
    public async Task Only_people_who_may_edit_the_project_can_reorder_its_stages()
    {
        var owner = await Owner("BUSINESS");
        var project = await owner.CreateProjectAsync("Atlas");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member);
        var ids = (await owner.Get($"/api/v1/projects/{project}/stages")).Data!.AsArray().Select(x => x!["id"]!.GetValue<string>()).ToList();
        ids.Reverse();
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Put($"/api/v1/projects/{project}/stages/order", new { stageIds = ids })).Status);
    }
}
