using System.Net;
using System.Text.Json.Nodes;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Milestones, and task dependencies with their four link types (spec sections 18 and 19).</summary>
[Collection("api")]
public class PlanningTests(ApiFactory factory)
{
    private async Task<(TestClient C, Guid Project, Dictionary<string, Guid> Statuses)> Setup(string plan = "BUSINESS")
    {
        var c = await TestClient.RegisterAsync(factory);
        await c.CreateOrgAsync();
        if (plan != "FREE") await c.UpgradeAsync(plan);
        var project = await c.CreateProjectAsync("Atlas");
        var statuses = (await c.Get($"/api/v1/projects/{project}/statuses")).Data!.AsArray();
        return (c, project, statuses.ToDictionary(s => s!["name"]!.GetValue<string>(), s => Guid.Parse(s!["id"]!.GetValue<string>())));
    }

    private static async Task<Guid> NewTask(TestClient c, Guid project, string title, object? extra = null) =>
        Guid.Parse((await c.CreateTaskAsync(project, title, extra))["id"]!.GetValue<string>());

    private static Task<ApiResult> Depend(TestClient c, Guid task, Guid on, string type = "FinishToStart") =>
        c.Post($"/api/v1/tasks/{task}/dependencies", new { dependsOnTaskId = on, type });

    private static Task<ApiResult> Move(TestClient c, Guid task, Guid status) =>
        c.Send(HttpMethod.Patch, $"/api/v1/tasks/{task}/move", new { statusId = status });

    private static string Status(JsonNode task) => task["statusName"]!.GetValue<string>();

    // ------------------------------------------------------------------ milestones

    [Fact]
    public async Task Milestones_can_be_planned_edited_and_removed_and_track_their_tasks()
    {
        var (c, project, status) = await Setup();
        var create = await c.Post($"/api/v1/projects/{project}/milestones", new { name = "Beta release", description = "First customers", dueDate = "2027-03-01", status = "Pending" });
        Assert.Equal(HttpStatusCode.Created, create.Status);
        var milestone = Guid.Parse(create.Data![0]!["id"]!.GetValue<string>());

        var a = await c.CreateTaskAsync(project, "Login", new { title = "Login", priority = "Low", milestoneId = milestone });
        var b = await c.CreateTaskAsync(project, "Billing", new { title = "Billing", priority = "Low", milestoneId = milestone });
        Assert.Equal("Beta release", a["milestoneName"]!.GetValue<string>());
        var done = status.First(s => s.Key is "Done").Value;
        Assert.True((await Move(c, Guid.Parse(a["id"]!.GetValue<string>()), done)).Ok);

        var list = (await c.Get($"/api/v1/projects/{project}/milestones")).Data!.AsArray();
        Assert.Equal(2, list[0]!["taskTotal"]!.GetValue<int>());
        Assert.Equal(1, list[0]!["taskDone"]!.GetValue<int>());
        Assert.Equal(50, list[0]!["progress"]!.GetValue<int>());

        // Edit, complete, overdue detection.
        var edit = await c.Put($"/api/v1/projects/{project}/milestones/{milestone}", new { name = "Beta", description = (string?)null, dueDate = "2020-01-01", status = "InProgress" });
        Assert.True(edit.Ok, edit.ToString());
        Assert.True(edit.Data![0]!["isOverdue"]!.GetValue<bool>());
        var complete = await c.Put($"/api/v1/projects/{project}/milestones/{milestone}", new { name = "Beta", dueDate = "2020-01-01", status = "Completed" });
        Assert.Equal(100, complete.Data![0]!["progress"]!.GetValue<int>());
        Assert.False(complete.Data[0]!["isOverdue"]!.GetValue<bool>());
        Assert.NotNull(complete.Data[0]!["completedAt"]);

        // Deleting a milestone keeps its tasks.
        var removed = await c.Delete($"/api/v1/projects/{project}/milestones/{milestone}");
        Assert.True(removed.Ok);
        Assert.Empty(removed.Data!.AsArray());
        var task = (await c.Get($"/api/v1/tasks/{a["id"]!.GetValue<string>()}")).Data!["task"]!;
        Assert.Null(task["milestoneId"]);
    }

    [Fact]
    public async Task Milestone_input_is_validated_and_stays_inside_the_project_and_workspace()
    {
        var (c, project, _) = await Setup();
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Post($"/api/v1/projects/{project}/milestones", new { name = "", status = "Pending" })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Post($"/api/v1/projects/{project}/milestones", new { name = "Bad dates", startDate = "2027-05-01", dueDate = "2027-04-01", status = "Pending" })).Status);

        var otherProject = await c.CreateProjectAsync("Other");
        var mine = Guid.Parse((await c.Post($"/api/v1/projects/{project}/milestones", new { name = "Mine", status = "Pending" })).Data![0]!["id"]!.GetValue<string>());
        // A task cannot count towards another project's milestone.
        var wrong = await c.Post($"/api/v1/projects/{otherProject}/tasks", new { title = "X", priority = "Low", milestoneId = mine });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, wrong.Status);

        // Another workspace cannot see, change or use it.
        var (other, otherWs, _) = await Setup();
        Assert.Equal(HttpStatusCode.NotFound, (await other.Get($"/api/v1/projects/{project}/milestones")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await other.Put($"/api/v1/projects/{project}/milestones/{mine}", new { name = "Hijack", status = "Pending" })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await other.Post($"/api/v1/projects/{otherWs}/tasks", new { title = "X", priority = "Low", milestoneId = mine })).Status);
    }

    [Fact]
    public async Task Milestones_show_up_on_the_calendar_and_need_edit_access()
    {
        var (owner, project, _) = await Setup();
        await owner.Post($"/api/v1/projects/{project}/milestones", new { name = "Go live", dueDate = "2027-06-15", status = "Pending" });
        var events = (await owner.Get("/api/v1/calendar?from=2027-06-01&to=2027-06-30")).Data!.AsArray();
        Assert.Contains(events, e => e!["type"]!.GetValue<string>() == "milestone" && e["title"]!.GetValue<string>() == "Go live");

        var guest = await owner.AddMemberAsync(factory, TenantRole.Guest, "Gus");
        Assert.True((await owner.Post($"/api/v1/projects/{project}/members", new { userId = guest.UserId })).Ok);
        Assert.True((await guest.Get($"/api/v1/projects/{project}/milestones")).Ok);
        Assert.Equal(HttpStatusCode.Forbidden, (await guest.Post($"/api/v1/projects/{project}/milestones", new { name = "Nope", status = "Pending" })).Status);
    }

    // ------------------------------------------------------------------ dependencies

    [Fact]
    public async Task Links_can_be_added_listed_and_removed_in_both_directions()
    {
        var (c, project, _) = await Setup();
        var design = await NewTask(c, project, "Design");
        var build = await NewTask(c, project, "Build");

        var added = await Depend(c, build, design);
        Assert.Equal(HttpStatusCode.Created, added.Status);
        Assert.Single(added.Data!["blockedBy"]!.AsArray());
        Assert.Equal("Design", added.Data["blockedBy"]![0]!["task"]!["title"]!.GetValue<string>());
        Assert.False(added.Data["blockedBy"]![0]!["satisfied"]!.GetValue<bool>());
        Assert.Contains("Design", added.Data["blockedReason"]!.GetValue<string>());

        var reverse = (await c.Get($"/api/v1/tasks/{design}/dependencies")).Data!;
        Assert.Single(reverse["blocks"]!.AsArray());
        Assert.Equal("Build", reverse["blocks"]![0]!["task"]!["title"]!.GetValue<string>());

        // The task lists show the counts and the blocked flag.
        var dto = (await c.Get($"/api/v1/tasks/{build}")).Data!["task"]!;
        Assert.Equal(1, dto["dependsOnCount"]!.GetValue<int>());
        Assert.True(dto["isBlocked"]!.GetValue<bool>());
        Assert.Equal(1, (await c.Get($"/api/v1/tasks/{design}")).Data!["task"]!["blocksCount"]!.GetValue<int>());

        var linkId = added.Data["blockedBy"]![0]!["id"]!.GetValue<string>();
        var removed = await c.Delete($"/api/v1/tasks/{build}/dependencies/{linkId}");
        Assert.True(removed.Ok);
        Assert.Empty(removed.Data!["blockedBy"]!.AsArray());
        Assert.False((await c.Get($"/api/v1/tasks/{build}")).Data!["task"]!["isBlocked"]!.GetValue<bool>());
    }

    [Fact]
    public async Task Bad_links_are_refused_self_duplicates_loops_and_other_projects()
    {
        var (c, project, _) = await Setup();
        var a = await NewTask(c, project, "A");
        var b = await NewTask(c, project, "B");
        var cc = await NewTask(c, project, "C");

        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await Depend(c, a, a)).Status);
        Assert.True((await Depend(c, b, a)).Ok);                        // B waits for A
        var dup = await Depend(c, b, a, "StartToStart");
        Assert.Equal(HttpStatusCode.Conflict, dup.Status);
        Assert.Equal("DEPENDENCY_EXISTS", dup.ErrorCode);

        // A -> B -> C would be fine, but closing the ring is not.
        Assert.True((await Depend(c, cc, b)).Ok);                       // C waits for B
        var loop = await Depend(c, a, cc);                              // A waits for C: A -> C -> B -> A
        Assert.Equal(HttpStatusCode.Conflict, loop.Status);
        Assert.Equal("DEPENDENCY_CYCLE", loop.ErrorCode);
        Assert.Equal("DEPENDENCY_CYCLE", (await Depend(c, a, b)).ErrorCode);   // the direct two-step loop

        var otherProject = await c.CreateProjectAsync("Other");
        var far = await NewTask(c, otherProject, "Elsewhere");
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await Depend(c, a, far)).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await Depend(c, a, Guid.NewGuid())).Status);
        Assert.Equal(HttpStatusCode.BadRequest, (await c.Post($"/api/v1/tasks/{a}/dependencies", new { dependsOnTaskId = b, type = "Sideways" })).Status);   // not a link type
    }

    [Fact]
    public async Task Finish_to_start_blocks_starting_until_the_predecessor_is_done_or_cancelled()
    {
        var (c, project, s) = await Setup();
        var first = await NewTask(c, project, "First");
        var second = await NewTask(c, project, "Second");
        await Depend(c, second, first);

        var blocked = await Move(c, second, s["In Progress"]);
        Assert.Equal(HttpStatusCode.Conflict, blocked.Status);
        Assert.Equal("DEPENDENCY_BLOCKED", blocked.ErrorCode);
        Assert.Contains("First", blocked.Json!["errors"]![0]!["message"]!.GetValue<string>());
        Assert.Equal("Yet To Start", Status((await c.Get($"/api/v1/tasks/{second}")).Data!["task"]!));   // nothing changed

        Assert.Equal(HttpStatusCode.Conflict, (await Move(c, second, s["Done"])).Status);                 // and it cannot jump to done either
        // Going backwards, or standing still, is never refused.
        Assert.True((await Move(c, second, s["Yet To Start"])).Ok);

        Assert.True((await Move(c, first, s["Done"])).Ok);
        Assert.True((await Move(c, second, s["In Progress"])).Ok);                                        // now allowed
        Assert.False((await c.Get($"/api/v1/tasks/{second}")).Data!["task"]!["isBlocked"]!.GetValue<bool>());
    }

    [Fact]
    public async Task A_cancelled_predecessor_no_longer_holds_the_plan_up()
    {
        var (c, project, s) = await Setup();
        var first = await NewTask(c, project, "First");
        var second = await NewTask(c, project, "Second");
        await Depend(c, second, first);
        Assert.Equal(HttpStatusCode.Conflict, (await Move(c, second, s["In Progress"])).Status);

        // A project can add a "Cancelled" status; a task in it is never going to happen, so it stops holding the plan up.
        var made = await c.Post($"/api/v1/projects/{project}/statuses", new { name = "Dropped", category = "Cancelled" });
        Assert.True(made.Ok, made.ToString());
        var dropped = Guid.Parse(made.Data!.AsArray().First(x => x!["name"]!.GetValue<string>() == "Dropped")!["id"]!.GetValue<string>());
        Assert.True((await Move(c, first, dropped)).Ok);
        Assert.True((await Move(c, second, s["In Progress"])).Ok);
    }

    [Fact]
    public async Task The_other_three_link_types_follow_their_own_rules()
    {
        var (c, project, s) = await Setup();
        var pred = await NewTask(c, project, "Predecessor");

        // Start-to-start: the successor may start once the predecessor has started (not finished).
        var ss = await NewTask(c, project, "Start-to-start");
        await Depend(c, ss, pred, "StartToStart");
        Assert.Equal("DEPENDENCY_BLOCKED", (await Move(c, ss, s["In Progress"])).ErrorCode);
        Assert.True((await Move(c, pred, s["In Progress"])).Ok);
        Assert.True((await Move(c, ss, s["In Progress"])).Ok);

        // Finish-to-finish: it may start any time but cannot finish before the predecessor does.
        var ff = await NewTask(c, project, "Finish-to-finish");
        await Depend(c, ff, pred, "FinishToFinish");
        Assert.True((await Move(c, ff, s["In Progress"])).Ok);
        Assert.Equal("DEPENDENCY_BLOCKED", (await Move(c, ff, s["Done"])).ErrorCode);

        // Start-to-finish: it cannot finish until the predecessor has at least started.
        var idle = await NewTask(c, project, "Not started");
        var sf = await NewTask(c, project, "Start-to-finish");
        await Depend(c, sf, idle, "StartToFinish");
        Assert.True((await Move(c, sf, s["In Progress"])).Ok);
        Assert.Equal("DEPENDENCY_BLOCKED", (await Move(c, sf, s["Done"])).ErrorCode);
        Assert.True((await Move(c, idle, s["In Progress"])).Ok);
        Assert.True((await Move(c, sf, s["Done"])).Ok);

        Assert.True((await Move(c, pred, s["Done"])).Ok);
        Assert.True((await Move(c, ff, s["Done"])).Ok);
    }

    [Fact]
    public async Task Editing_a_task_is_held_to_the_same_rule_and_projects_can_switch_the_rule_off()
    {
        var (c, project, s) = await Setup();
        var first = await NewTask(c, project, "First");
        var second = await NewTask(c, project, "Second");
        await Depend(c, second, first);

        var dto = (await c.Get($"/api/v1/tasks/{second}")).Data!["task"]!;
        object Edit(Guid status) => new { title = "Second", priority = "Medium", statusId = status, version = dto["version"]!.GetValue<int>() };
        var refused = await c.Put($"/api/v1/tasks/{second}", Edit(s["In Progress"]));
        Assert.Equal(HttpStatusCode.Conflict, refused.Status);
        Assert.Equal("DEPENDENCY_BLOCKED", refused.ErrorCode);

        // The project decides whether links are enforced.
        var p = (await c.Get($"/api/v1/projects/{project}")).Data!["project"]!;
        Assert.True(p["enforceDependencies"]!.GetValue<bool>());
        var off = await c.Put($"/api/v1/projects/{project}", new { name = "Atlas", priority = "Medium", status = "Planning", version = p["version"]!.GetValue<int>(), enforceDependencies = false });
        Assert.True(off.Ok, off.ToString());
        Assert.False(off.Data!["project"]!["enforceDependencies"]!.GetValue<bool>());
        Assert.True((await Move(c, second, s["In Progress"])).Ok);
        Assert.Null((await c.Get($"/api/v1/tasks/{second}/dependencies")).Data!["blockedReason"]);
    }

    [Fact]
    public async Task Links_follow_permissions_and_workspace_boundaries()
    {
        var (owner, project, _) = await Setup();
        var guest = await owner.AddMemberAsync(factory, TenantRole.Guest, "Gus");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Mia");
        var a = await NewTask(owner, project, "A");
        // A member can only plan (or otherwise edit) a task assigned to them - "B" is, so Mia may link it to "A".
        var b = await NewTask(owner, project, "B", new { title = "B", priority = "Medium", assigneeId = member.UserId });

        Assert.Equal(HttpStatusCode.NotFound, (await guest.Get($"/api/v1/tasks/{a}/dependencies")).Status);   // not on the project
        Assert.True((await owner.Post($"/api/v1/projects/{project}/members", new { userId = guest.UserId })).Ok);
        Assert.True((await guest.Get($"/api/v1/tasks/{a}/dependencies")).Ok);
        Assert.Equal(HttpStatusCode.Forbidden, (await Depend(guest, b, a)).Status);                            // read-only
        Assert.True((await Depend(member, b, a)).Ok);                                                          // members may plan a task assigned to them

        var (other, otherProject, _) = await Setup();
        var foreign = await NewTask(other, otherProject, "Foreign");
        Assert.Equal(HttpStatusCode.NotFound, (await Depend(other, foreign, a)).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await other.Get($"/api/v1/tasks/{a}/dependencies")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await other.Delete($"/api/v1/tasks/{b}/dependencies/{Guid.NewGuid()}")).Status);
    }
}
