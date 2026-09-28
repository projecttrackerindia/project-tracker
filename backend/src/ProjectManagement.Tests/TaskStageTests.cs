using System.Net;
using System.Text.Json.Nodes;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Tasks belong to a timeline stage (phase). A task is only done once its subtasks and checklist are, and a stage is only
/// completed once every task under it is.
/// </summary>
[Collection("api")]
public class TaskStageTests(ApiFactory factory)
{
    private const string PendingMessage =
        "Unable to change the status. Please complete all pending subtasks and checklist items before marking this task as completed.";

    private async Task<(TestClient C, Guid Project, Dictionary<string, Guid> Statuses, Dictionary<string, Guid> Stages)> Setup()
    {
        var c = await TestClient.RegisterAsync(factory);
        await c.CreateOrgAsync();
        await c.UpgradeAsync("BUSINESS");   // custom statuses (a "cancelled" one) need the workflow feature
        var project = await c.CreateProjectAsync("Atlas");
        var statuses = (await c.Get($"/api/v1/projects/{project}/statuses")).Data!.AsArray()
            .ToDictionary(s => s!["name"]!.GetValue<string>(), s => Guid.Parse(s!["id"]!.GetValue<string>()));
        var stages = (await c.Get($"/api/v1/projects/{project}/stages")).Data!.AsArray()
            .ToDictionary(s => s!["name"]!.GetValue<string>(), s => Guid.Parse(s!["id"]!.GetValue<string>()));
        // Stages are worked through in order, so tick off the (task-less) stage before Development to make Development available.
        var planning = await c.Put($"/api/v1/projects/{project}/stages/{stages["Requirements & Planning"]}", new { name = "Requirements & Planning", status = "Completed" });
        Assert.True(planning.Ok, planning.ToString());
        return (c, project, statuses, stages);
    }

    private static async Task<Guid> NewTask(TestClient c, Guid project, string title, Guid? stage = null, Guid? parent = null) =>
        Guid.Parse((await c.CreateTaskAsync(project, title, new { title, priority = "Medium", stageId = stage, parentTaskId = parent }))["id"]!.GetValue<string>());

    private static Task<ApiResult> Move(TestClient c, Guid task, Guid status) =>
        c.Send(HttpMethod.Patch, $"/api/v1/tasks/{task}/move", new { statusId = status });

    private static async Task<JsonNode> Task(TestClient c, Guid id) => (await c.Get($"/api/v1/tasks/{id}")).Data!["task"]!;

    private static async Task<JsonNode> Stage(TestClient c, Guid project, Guid stage) =>
        (await c.Get($"/api/v1/projects/{project}/stages")).Data!.AsArray().First(s => s!["id"]!.GetValue<string>() == stage.ToString())!;

    private static string StageStatus(JsonNode stage) => stage["status"]!.GetValue<string>();

    // ------------------------------------------------------------------ linking

    [Fact]
    public async Task A_task_carries_its_stage_and_subtasks_follow_their_parent()
    {
        var (c, project, _, stages) = await Setup();
        var dev = stages["Development"]; var review = stages["Code Review"];
        var parent = await NewTask(c, project, "Build login", dev);
        var dto = await Task(c, parent);
        Assert.Equal(dev.ToString(), dto["stageId"]!.GetValue<string>());
        Assert.Equal("Development", dto["stageName"]!.GetValue<string>());

        // A subtask sits in its parent's stage whatever the request says.
        var sub = await NewTask(c, project, "Form", review, parent);
        Assert.Equal(dev.ToString(), (await Task(c, sub))["stageId"]!.GetValue<string>());

        // Updating without a stage leaves the task where it is; naming another one moves it and its subtasks.
        var version = dto["version"]!.GetValue<int>();
        var body = new { title = "Build login", priority = "Medium", statusId = dto["statusId"]!.GetValue<string>(), version };
        var kept = await c.Put($"/api/v1/tasks/{parent}", body);
        Assert.True(kept.Ok, kept.ToString());
        Assert.Equal("Development", kept.Data!["stageName"]!.GetValue<string>());
        var moved = await c.Put($"/api/v1/tasks/{parent}", new { body.title, body.priority, body.statusId, version = version + 1, stageId = review });
        Assert.True(moved.Ok, moved.ToString());
        Assert.Equal("Code Review", moved.Data!["stageName"]!.GetValue<string>());
        Assert.Equal("Code Review", (await Task(c, sub))["stageName"]!.GetValue<string>());

        // The tasks of a stage can be listed.
        var listed = (await c.Get($"/api/v1/projects/{project}/tasks?stageId={review}")).Data!["items"]!.AsArray();
        Assert.Single(listed);
    }

    [Fact]
    public async Task A_stage_from_another_project_is_refused()
    {
        var (c, project, _, _) = await Setup();
        var other = await c.CreateProjectAsync("Borealis");
        var foreign = Guid.Parse((await c.Get($"/api/v1/projects/{other}/stages")).Data![2]!["id"]!.GetValue<string>());
        var res = await c.Post($"/api/v1/projects/{project}/tasks", new { title = "Nope", priority = "Medium", stageId = foreign });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, res.Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Post($"/api/v1/projects/{project}/tasks", new { title = "Nope", priority = "Medium", stageId = Guid.NewGuid() })).Status);
    }

    // ------------------------------------------------------------------ completing a task

    [Fact]
    public async Task A_task_with_pending_subtasks_or_checklist_items_cannot_be_completed()
    {
        var (c, project, s, stages) = await Setup();
        var parent = await NewTask(c, project, "Release", stages["Development"]);
        var sub = await NewTask(c, project, "Write notes", parent: parent);
        var list = await c.Post($"/api/v1/tasks/{parent}/checklist", new { title = "Tag the build" });
        var item = Guid.Parse(list.Data!["items"]![0]!["id"]!.GetValue<string>());

        // Both ways of changing status are refused, with the same message, and nothing changes.
        var refused = await Move(c, parent, s["Done"]);
        Assert.Equal(HttpStatusCode.Conflict, refused.Status);
        Assert.Equal("TASK_INCOMPLETE_CHILDREN", refused.ErrorCode);
        Assert.Equal(PendingMessage, refused.Json!["errors"]![0]!["message"]!.GetValue<string>());
        var dto = await Task(c, parent);
        var edit = await c.Put($"/api/v1/tasks/{parent}", new { title = "Release", priority = "Medium", statusId = s["Done"], version = dto["version"]!.GetValue<int>() });
        Assert.Equal("TASK_INCOMPLETE_CHILDREN", edit.ErrorCode);
        Assert.Equal("Yet To Start", (await Task(c, parent))["statusName"]!.GetValue<string>());

        // Subtask done, checklist item still open: still refused.
        Assert.True((await Move(c, sub, s["Done"])).Ok);
        Assert.Equal("TASK_INCOMPLETE_CHILDREN", (await Move(c, parent, s["Done"])).ErrorCode);

        // Checklist ticked too: now it can be completed. Other moves were never blocked.
        Assert.True((await Move(c, parent, s["In Progress"])).Ok);
        await c.Put($"/api/v1/tasks/{parent}/checklist/{item}", new { isDone = true });
        var done = await Move(c, parent, s["Done"]);
        Assert.True(done.Ok, done.ToString());
        Assert.Equal("Done", done.Data!["statusName"]!.GetValue<string>());
    }

    [Fact]
    public async Task Only_open_subtasks_count_and_a_task_without_any_moves_freely()
    {
        var (c, project, s, _) = await Setup();
        var cancelled = (await c.Post($"/api/v1/projects/{project}/statuses", new { name = "Dropped", category = "Cancelled" })).Data!.AsArray()
            .First(x => x!["name"]!.GetValue<string>() == "Dropped")!["id"]!.GetValue<string>();

        var plain = await NewTask(c, project, "Plain");
        Assert.True((await Move(c, plain, s["Done"])).Ok);

        var parent = await NewTask(c, project, "With subtasks");
        var kept = await NewTask(c, project, "Dropped one", parent: parent);
        var later = await NewTask(c, project, "Still to do", parent: parent);
        Assert.True((await Move(c, kept, Guid.Parse(cancelled))).Ok);   // a cancelled subtask no longer holds the parent back
        Assert.Equal("TASK_INCOMPLETE_CHILDREN", (await Move(c, parent, s["Done"])).ErrorCode);
        Assert.True((await Move(c, later, s["Done"])).Ok);
        Assert.True((await Move(c, parent, s["Done"])).Ok);

        // A deleted subtask does not hold anything back either.
        var other = await NewTask(c, project, "Other parent");
        var gone = await NewTask(c, project, "Removed", parent: other);
        Assert.True((await c.Delete($"/api/v1/tasks/{gone}")).Ok);
        Assert.True((await Move(c, other, s["Done"])).Ok);
    }

    [Fact]
    public async Task An_automation_rule_will_not_complete_a_task_with_open_subtasks()
    {
        var c = await TestClient.RegisterAsync(factory);
        await c.CreateOrgAsync();
        await c.UpgradeAsync("BUSINESS");
        var project = await c.CreateProjectAsync("Atlas");
        var s = (await c.Get($"/api/v1/projects/{project}/statuses")).Data!.AsArray()
            .ToDictionary(x => x!["name"]!.GetValue<string>(), x => x!["id"]!.GetValue<string>());
        var rule = await c.Post($"/api/v1/projects/{project}/automations", new
        {
            name = "Finish after testing", trigger = "StatusChanged", whenStatusId = s["Testing"], action = "MoveToStatus", actionStatusId = s["Done"], isEnabled = true,
        });
        Assert.True(rule.Ok, rule.ToString());

        var parent = await NewTask(c, project, "Parent");
        await NewTask(c, project, "Open child", parent: parent);
        var moved = await Move(c, parent, Guid.Parse(s["Testing"]));
        Assert.True(moved.Ok, moved.ToString());
        Assert.Equal("Testing", moved.Data!["statusName"]!.GetValue<string>());   // the rule stood down

        var free = await NewTask(c, project, "No children");
        Assert.Equal("Done", (await Move(c, free, Guid.Parse(s["Testing"]))).Data!["statusName"]!.GetValue<string>());
    }

    // ------------------------------------------------------------------ completing a stage

    [Fact]
    public async Task A_stage_completes_when_all_its_tasks_are_done_and_reopens_when_another_arrives()
    {
        var (c, project, s, stages) = await Setup();
        var dev = stages["Development"];
        var untouched = stages["UAT"];
        Assert.Equal("Pending", StageStatus(await Stage(c, project, dev)));

        var a = await NewTask(c, project, "A", dev);
        var b = await NewTask(c, project, "B", dev);
        Assert.Equal("Pending", StageStatus(await Stage(c, project, dev)));        // nothing started

        Assert.True((await Move(c, a, s["In Progress"])).Ok);
        Assert.Equal("InProgress", StageStatus(await Stage(c, project, dev)));    // work began

        Assert.True((await Move(c, a, s["Done"])).Ok);
        var half = await Stage(c, project, dev);
        Assert.Equal("InProgress", StageStatus(half));                             // one of two is not enough
        Assert.Equal(2, half["taskTotal"]!.GetValue<int>());
        Assert.Equal(1, half["taskDone"]!.GetValue<int>());

        Assert.True((await Move(c, b, s["Done"])).Ok);
        var complete = await Stage(c, project, dev);
        Assert.Equal("Completed", StageStatus(complete));
        Assert.NotNull(complete["actualEnd"]);
        Assert.Equal(2, complete["taskDone"]!.GetValue<int>());

        // A new task under a completed stage reopens it; finishing it completes the stage again.
        var late = await NewTask(c, project, "Late addition", dev);
        var reopened = await Stage(c, project, dev);
        Assert.Equal("InProgress", StageStatus(reopened));
        Assert.Null(reopened["actualEnd"]);
        Assert.True((await Move(c, late, s["Done"])).Ok);
        Assert.Equal("Completed", StageStatus(await Stage(c, project, dev)));

        // Reopening a task does the same; a stage with no tasks is never touched.
        Assert.True((await Move(c, a, s["Review"])).Ok);
        Assert.Equal("InProgress", StageStatus(await Stage(c, project, dev)));
        Assert.Equal("Pending", StageStatus(await Stage(c, project, untouched)));
    }

    [Fact]
    public async Task Moving_deleting_or_cancelling_tasks_keeps_their_stages_in_step()
    {
        var (c, project, s, stages) = await Setup();
        var dev = stages["Development"]; var review = stages["Code Review"];
        var cancelled = Guid.Parse((await c.Post($"/api/v1/projects/{project}/statuses", new { name = "Dropped", category = "Cancelled" })).Data!.AsArray()
            .First(x => x!["name"]!.GetValue<string>() == "Dropped")!["id"]!.GetValue<string>());

        var done = await NewTask(c, project, "Finished", dev);
        var open = await NewTask(c, project, "Open", dev);
        Assert.True((await Move(c, done, s["Done"])).Ok);
        Assert.Equal("InProgress", StageStatus(await Stage(c, project, dev)));

        // Cancelling the open task, or deleting it, leaves nothing to wait for.
        Assert.True((await Move(c, open, cancelled)).Ok);
        Assert.Equal("Completed", StageStatus(await Stage(c, project, dev)));
        Assert.True((await Move(c, open, s["In Progress"])).Ok);
        Assert.Equal("InProgress", StageStatus(await Stage(c, project, dev)));
        Assert.True((await c.Delete($"/api/v1/tasks/{open}")).Ok);
        Assert.Equal("Completed", StageStatus(await Stage(c, project, dev)));

        // Moving the finished task to another stage takes it out of the first (no tasks left: left as it is) and into the second.
        var dto = await Task(c, done);
        var res = await c.Put($"/api/v1/tasks/{done}", new { title = "Finished", priority = "Medium", statusId = s["Done"], version = dto["version"]!.GetValue<int>(), stageId = review });
        Assert.True(res.Ok, res.ToString());
        Assert.Equal("Completed", StageStatus(await Stage(c, project, review)));
        Assert.Equal(0, (await Stage(c, project, dev))["taskTotal"]!.GetValue<int>());
    }

    [Fact]
    public async Task A_stage_cannot_be_completed_by_hand_while_tasks_under_it_are_open()
    {
        var (c, project, s, stages) = await Setup();
        var dev = stages["Development"];
        var task = await NewTask(c, project, "Build", dev);
        await NewTask(c, project, "Test it", dev);

        var refused = await c.Put($"/api/v1/projects/{project}/stages/{dev}", new { name = "Development", status = "Completed" });
        Assert.Equal(HttpStatusCode.Conflict, refused.Status);
        Assert.Equal("STAGE_HAS_OPEN_TASKS", refused.ErrorCode);
        Assert.Contains("2 tasks are still open", refused.Json!["errors"]![0]!["message"]!.GetValue<string>());
        Assert.NotEqual("Completed", StageStatus(await Stage(c, project, dev)));

        // Other manual states are still the owner's call.
        Assert.True((await c.Put($"/api/v1/projects/{project}/stages/{dev}", new { name = "Development", status = "InProgress" })).Ok);

        // A stage with no tasks can still be ticked off by hand (as Requirements & Planning was in the setup).
        Assert.Equal("Completed", StageStatus(await Stage(c, project, stages["Requirements & Planning"])));
    }

    [Fact]
    public async Task Deleting_a_stage_leaves_its_tasks_in_the_project_without_a_phase()
    {
        var (c, project, _, stages) = await Setup();
        var task = await NewTask(c, project, "Orphan", stages["UAT"]);
        Assert.True((await c.Delete($"/api/v1/projects/{project}/stages/{stages["UAT"]}")).Ok);
        var dto = await Task(c, task);
        Assert.Null(dto["stageId"]);
    }
}
