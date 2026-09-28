using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Projects start from a chosen timeline, and its stages have to be worked through in order: none can be started or completed before the one before it.</summary>
[Collection("api")]
public class TimelineSequenceTests(ApiFactory factory)
{
    private static readonly string[] Software =
        ["Project Created", "Requirements & Planning", "Development", "Code Review", "Testing / QA", "UAT", "Production Deployment", "Project Completed"];

    private async Task<(TestClient C, Guid Project)> Setup(string plan = "BUSINESS", string? template = null)
    {
        var c = await TestClient.RegisterAsync(factory);
        await c.CreateOrgAsync();
        if (plan != "FREE") await c.UpgradeAsync(plan);
        var res = await c.Post("/api/v1/projects", new { name = "Atlas", priority = "Medium", status = "Active", timelineTemplate = template });
        Assert.True(res.Ok, res.ToString());
        return (c, Guid.Parse(res.Data!["project"]!["id"]!.GetValue<string>()));
    }

    private static async Task<Dictionary<string, JsonNode>> Stages(TestClient c, Guid project) =>
        (await c.Get($"/api/v1/projects/{project}/stages")).Data!.AsArray().ToDictionary(s => s!["name"]!.GetValue<string>(), s => s!);

    private static Task<ApiResult> SetStage(TestClient c, Guid project, JsonNode stage, string status) =>
        c.Put($"/api/v1/projects/{project}/stages/{stage["id"]!.GetValue<string>()}", new { name = stage["name"]!.GetValue<string>(), status });

    private static string Message(ApiResult r) => r.Json!["errors"]![0]!["message"]!.GetValue<string>();

    private static async Task<Guid> NewTask(TestClient c, Guid project, string title, JsonNode stage) =>
        Guid.Parse((await c.CreateTaskAsync(project, title, new { title, priority = "Medium", stageId = stage["id"]!.GetValue<string>() }))["id"]!.GetValue<string>());

    private static async Task<Dictionary<string, Guid>> StatusIds(TestClient c, Guid project) =>
        (await c.Get($"/api/v1/projects/{project}/statuses")).Data!.AsArray().ToDictionary(s => s!["name"]!.GetValue<string>(), s => Guid.Parse(s!["id"]!.GetValue<string>()));

    private static Task<ApiResult> Move(TestClient c, Guid task, Guid status) => c.Send(HttpMethod.Patch, $"/api/v1/tasks/{task}/move", new { statusId = status });

    // ------------------------------------------------------------------ choosing a timeline

    [Fact]
    public async Task A_project_starts_from_the_timeline_chosen_for_it()
    {
        var (c, _) = await Setup("PRO");
        var list = (await c.Get("/api/v1/projects/timeline-templates")).Data!.AsArray();
        Assert.True(list.Count >= 3);
        var software = list.Single(t => t!["isDefault"]!.GetValue<bool>())!;
        Assert.Equal("software", software["key"]!.GetValue<string>());
        Assert.Equal(Software, software["stages"]!.AsArray().Select(s => s!.GetValue<string>()).ToArray());

        // Each template's stages, in order, become the project's stages.
        foreach (var t in list)
        {
            var res = await c.Post("/api/v1/projects", new { name = $"From {t!["key"]}", priority = "Low", timelineTemplate = t["key"]!.GetValue<string>() });
            Assert.True(res.Ok, res.ToString());
            Assert.Equal(t["stages"]!.AsArray().Select(s => s!.GetValue<string>()).ToArray(),
                res.Data!["stages"]!.AsArray().Select(s => s!["name"]!.GetValue<string>()).ToArray());
        }

        // Leaving it out gives the standard software timeline; an unknown one is refused and creates nothing.
        var plain = await c.Post("/api/v1/projects", new { name = "Plain", priority = "Low" });
        Assert.Equal(Software, plain.Data!["stages"]!.AsArray().Select(s => s!["name"]!.GetValue<string>()).ToArray());
        var bad = await c.Post("/api/v1/projects", new { name = "Nope", priority = "Low", timelineTemplate = "waterfall-9000" });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, bad.Status);
        Assert.Equal("timelineTemplate", bad.Json!["errors"]![0]!["field"]!.GetValue<string>());
    }

    // ------------------------------------------------------------------ the order of stages

    [Fact]
    public async Task Stages_are_locked_until_the_one_before_them_is_completed()
    {
        var (c, project) = await Setup();
        var s = await Stages(c, project);
        Assert.Equal(Software, s.Keys.ToArray());
        Assert.False(s["Project Created"]["locked"]!.GetValue<bool>());
        Assert.False(s["Requirements & Planning"]["locked"]!.GetValue<bool>());   // available: the one before it is done
        foreach (var name in Software.Skip(2)) Assert.True(s[name]["locked"]!.GetValue<bool>(), name);
        Assert.Equal("Requirements & Planning", s["Development"]["lockedBy"]!.GetValue<string>());
        Assert.Equal("Development", s["Code Review"]["lockedBy"]!.GetValue<string>());

        // Skipping ahead is refused with the reason, whether completing or just starting.
        var skip = await SetStage(c, project, s["Code Review"], "Completed");
        Assert.Equal(HttpStatusCode.Conflict, skip.Status);
        Assert.Equal("STAGE_PREVIOUS_INCOMPLETE", skip.ErrorCode);
        Assert.Equal("Please complete Development before completing Code Review.", Message(skip));
        Assert.Equal("Please complete Requirements & Planning before completing Development.", Message(await SetStage(c, project, s["Development"], "Completed")));
        Assert.Equal("Please complete Requirements & Planning before starting Development.", Message(await SetStage(c, project, s["Development"], "InProgress")));
        Assert.Equal("Please complete Testing / QA before completing UAT.", Message(await SetStage(c, project, s["UAT"], "Completed")));
        Assert.True((await SetStage(c, project, s["Development"], "Pending")).Ok);   // staying (or going back to) pending is never refused
        Assert.Equal("Pending", (await Stages(c, project))["Development"]["status"]!.GetValue<string>());

        // Finishing a stage opens the next one, one at a time, all the way to the end.
        foreach (var (name, i) in Software.Skip(1).Select((n, i) => (n, i + 1)))
        {
            var now = await Stages(c, project);
            Assert.False(now[name]["locked"]!.GetValue<bool>(), $"{name} should be available");
            if (i + 1 < Software.Length) Assert.True(now[Software[i + 1]]["locked"]!.GetValue<bool>(), $"{Software[i + 1]} should still be locked");
            var done = await SetStage(c, project, now[name], "Completed");
            Assert.True(done.Ok, $"{name}: {done}");
        }
        Assert.All((await Stages(c, project)).Values, st => Assert.Equal("Completed", st["status"]!.GetValue<string>()));
    }

    [Fact]
    public async Task Reopening_a_stage_locks_the_ones_after_it_that_are_not_finished_and_adding_or_deleting_stages_follows_the_order()
    {
        var (c, project) = await Setup();
        foreach (var name in Software.Skip(1).Take(3)) Assert.True((await SetStage(c, project, (await Stages(c, project))[name], "Completed")).Ok);   // up to Code Review
        var s = await Stages(c, project);
        Assert.False(s["Testing / QA"]["locked"]!.GetValue<bool>());

        Assert.True((await SetStage(c, project, s["Development"], "InProgress")).Ok);   // Development is reopened
        s = await Stages(c, project);
        Assert.Equal("Completed", s["Code Review"]["status"]!.GetValue<string>());      // finished work stays finished
        Assert.False(s["Code Review"]["locked"]!.GetValue<bool>());
        Assert.False(s["Testing / QA"]["locked"]!.GetValue<bool>());                    // its own predecessor (Code Review) is still complete

        // A new stage cannot be created already started or finished when the one before it is not.
        var created = await c.Post($"/api/v1/projects/{project}/stages", new { name = "Security review", status = "Completed", order = 3 });   // right after Development (reopened)
        Assert.Equal("STAGE_PREVIOUS_INCOMPLETE", created.ErrorCode);
        Assert.True((await c.Post($"/api/v1/projects/{project}/stages", new { name = "Security review", status = "Pending", order = 3 })).Ok);
        s = await Stages(c, project);
        Assert.True(s["Security review"]["locked"]!.GetValue<bool>());
        Assert.Equal("Development", s["Security review"]["lockedBy"]!.GetValue<string>());

        // Taking the extra stage out again puts the order back, and Development can be finished.
        Assert.True((await c.Delete($"/api/v1/projects/{project}/stages/{s["Security review"]["id"]!.GetValue<string>()}")).Ok);
        Assert.True((await SetStage(c, project, (await Stages(c, project))["Development"], "Completed")).Ok);
    }

    // ------------------------------------------------------------------ tasks follow the same order

    [Fact]
    public async Task A_task_cannot_be_completed_in_a_stage_that_is_still_locked_but_can_be_worked_on()
    {
        var (c, project) = await Setup();
        var st = await StatusIds(c, project);
        var s = await Stages(c, project);
        var task = await NewTask(c, project, "Review the login PR", s["Code Review"]);

        var refused = await Move(c, task, st["Done"]);
        Assert.Equal(HttpStatusCode.Conflict, refused.Status);
        Assert.Equal("STAGE_PREVIOUS_INCOMPLETE", refused.ErrorCode);
        Assert.Equal("Please complete Development before completing Code Review.", Message(refused));

        var dto = (await c.Get($"/api/v1/tasks/{task}")).Data!["task"]!;
        var edit = await c.Put($"/api/v1/tasks/{task}", new { title = "Review the login PR", priority = "Medium", statusId = st["Done"], version = dto["version"]!.GetValue<int>() });
        Assert.Equal("STAGE_PREVIOUS_INCOMPLETE", edit.ErrorCode);
        var born = await c.Post($"/api/v1/projects/{project}/tasks", new { title = "Already done", priority = "Low", statusId = st["Done"], stageId = s["Code Review"]["id"]!.GetValue<string>() });
        Assert.Equal("STAGE_PREVIOUS_INCOMPLETE", born.ErrorCode);

        // Working on it is fine, but the stage itself stays locked and pending.
        Assert.True((await Move(c, task, st["In Progress"])).Ok);
        s = await Stages(c, project);
        Assert.Equal("Pending", s["Code Review"]["status"]!.GetValue<string>());
        Assert.True(s["Code Review"]["locked"]!.GetValue<bool>());

        // Once the stages before it are finished the task can be completed, which completes its stage and opens the next.
        Assert.True((await SetStage(c, project, s["Requirements & Planning"], "Completed")).Ok);
        Assert.True((await SetStage(c, project, (await Stages(c, project))["Development"], "Completed")).Ok);
        var after = await Stages(c, project);
        Assert.False(after["Code Review"]["locked"]!.GetValue<bool>());
        Assert.Equal("InProgress", after["Code Review"]["status"]!.GetValue<string>());   // its started task moved it along the moment it was unlocked
        Assert.True((await Move(c, task, st["Done"])).Ok);
        after = await Stages(c, project);
        Assert.Equal("Completed", after["Code Review"]["status"]!.GetValue<string>());
        Assert.False(after["Testing / QA"]["locked"]!.GetValue<bool>());
        Assert.True(after["UAT"]["locked"]!.GetValue<bool>());
    }

    [Fact]
    public async Task Completing_a_stage_cascades_through_later_stages_whose_work_is_already_finished()
    {
        var (c, project) = await Setup();
        var st = await StatusIds(c, project);
        var s = await Stages(c, project);
        // Testing / QA has a finished task from before the order was enforced (written straight to the database).
        var qaTask = await NewTask(c, project, "Regression pass", s["Testing / QA"]);
        factory.WithDb(db =>
        {
            db.Tasks.IgnoreQueryFilters().Single(t => t.Id == qaTask).StatusId = st["Done"];
            db.SaveChanges();
            return 0;
        });
        Assert.NotEqual("Completed", (await Stages(c, project))["Testing / QA"]["status"]!.GetValue<string>());   // still locked: nothing has completed it

        foreach (var name in new[] { "Requirements & Planning", "Development", "Code Review" })
            Assert.True((await SetStage(c, project, (await Stages(c, project))[name], "Completed")).Ok);
        var after = await Stages(c, project);
        Assert.Equal("Completed", after["Testing / QA"]["status"]!.GetValue<string>());   // its work was done, so finishing Code Review closes it
        Assert.False(after["UAT"]["locked"]!.GetValue<bool>());                           // and UAT is next in line
    }

    [Fact]
    public async Task An_automation_rule_will_not_complete_a_task_in_a_locked_stage()
    {
        var (c, project) = await Setup();
        var st = await StatusIds(c, project);
        Assert.True((await c.Post($"/api/v1/projects/{project}/automations", new
        {
            name = "Done after testing", trigger = "StatusChanged", whenStatusId = st["Testing"], action = "MoveToStatus", actionStatusId = st["Done"], isEnabled = true,
        })).Ok);
        var s = await Stages(c, project);
        var locked = await NewTask(c, project, "In a locked stage", s["Development"]);
        var open = await NewTask(c, project, "In an open stage", s["Requirements & Planning"]);

        Assert.Equal("Testing", (await Move(c, locked, st["Testing"])).Data!["statusName"]!.GetValue<string>());   // the rule stood down
        Assert.Equal("Done", (await Move(c, open, st["Testing"])).Data!["statusName"]!.GetValue<string>());
    }
}
