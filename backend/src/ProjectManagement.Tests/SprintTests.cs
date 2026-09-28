using System.Net;
using System.Text.Json.Nodes;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Sprints: planning tasks into time-boxed batches, one running sprint per project, completing, and the backlog.</summary>
[Collection("api")]
public class SprintTests(ApiFactory factory)
{
    private static string Day(int offset) => DateTime.UtcNow.AddDays(offset).ToString("yyyy-MM-dd");

    private async Task<(TestClient C, Guid Project, Dictionary<string, Guid> Statuses)> Setup()
    {
        var c = await TestClient.RegisterAsync(factory);
        await c.CreateOrgAsync();
        await c.UpgradeAsync("PRO");
        var project = await c.CreateProjectAsync("Atlas");
        var statuses = (await c.Get($"/api/v1/projects/{project}/statuses")).Data!.AsArray();
        return (c, project, statuses.ToDictionary(s => s!["name"]!.GetValue<string>(), s => Guid.Parse(s!["id"]!.GetValue<string>())));
    }

    private static async Task<Guid> NewTask(TestClient c, Guid project, string title = "Task") =>
        Guid.Parse((await c.CreateTaskAsync(project, title))["id"]!.GetValue<string>());

    private static async Task<Guid> NewSprint(TestClient c, Guid project, string name = "Sprint 1", int start = 0, int end = 13)
    {
        var res = await c.Post($"/api/v1/projects/{project}/sprints", new { name, goal = "Ship it", startDate = Day(start), endDate = Day(end) });
        Assert.Equal(HttpStatusCode.Created, res.Status);
        return Guid.Parse(res.Data!["id"]!.GetValue<string>());
    }

    private static Task<ApiResult> Plan(TestClient c, Guid project, Guid sprint, params Guid[] tasks) =>
        c.Post($"/api/v1/projects/{project}/sprints/{sprint}/tasks", new { taskIds = tasks });

    private static Task<ApiResult> Move(TestClient c, Guid task, Guid status) =>
        c.Send(HttpMethod.Patch, $"/api/v1/tasks/{task}/move", new { statusId = status });

    private static async Task<JsonNode> SprintOf(TestClient c, Guid project, Guid id) => (await c.Get($"/api/v1/projects/{project}/sprints/{id}")).Data!["sprint"]!;

    [Fact]
    public async Task A_sprint_is_planned_with_tasks_started_and_completed()
    {
        var (c, project, status) = await Setup();
        var sprint = await NewSprint(c, project);
        var a = await NewTask(c, project, "A"); var b = await NewTask(c, project, "B"); var d = await NewTask(c, project, "D");

        Assert.Equal(HttpStatusCode.NoContent, (await Plan(c, project, sprint, a, b)).Status);
        var planned = await SprintOf(c, project, sprint);
        Assert.Equal("Planned", planned["status"]!.GetValue<string>());
        Assert.Equal(2, planned["taskTotal"]!.GetValue<int>());

        var start = await c.Post($"/api/v1/projects/{project}/sprints/{sprint}/start");
        Assert.True(start.Ok, start.ToString());
        Assert.Equal("Active", start.Data!["status"]!.GetValue<string>());
        Assert.Equal(2, start.Data["committed"]!.GetValue<int>());

        Assert.True((await Move(c, a, status["Done"])).Ok);
        var running = await SprintOf(c, project, sprint);
        Assert.Equal(1, running["taskDone"]!.GetValue<int>());
        Assert.Equal(50, running["progress"]!.GetValue<int>());

        // Adding a task while it runs is visible as a change of scope.
        await Plan(c, project, sprint, d);
        Assert.Equal(3, (await SprintOf(c, project, sprint))["committed"]!.GetValue<int>());

        var done = await c.Post($"/api/v1/projects/{project}/sprints/{sprint}/complete", new { moveUnfinishedTo = (Guid?)null });
        Assert.True(done.Ok, done.ToString());
        Assert.Equal("Completed", done.Data!["status"]!.GetValue<string>());

        // The finished task stays in the sprint; the two unfinished ones went back to the backlog.
        var backlog = (await c.Get($"/api/v1/projects/{project}/tasks?backlog=true")).Data!["items"]!.AsArray();
        Assert.Equal(2, backlog.Count);
        var inSprint = (await c.Get($"/api/v1/projects/{project}/tasks?sprintId={sprint}")).Data!["items"]!.AsArray();
        Assert.Single(inSprint);
        Assert.Equal("Sprint 1", inSprint[0]!["sprintName"]!.GetValue<string>());
    }

    [Fact]
    public async Task Only_one_sprint_runs_at_a_time()
    {
        var (c, project, _) = await Setup();
        var one = await NewSprint(c, project, "One");
        var two = await NewSprint(c, project, "Two", 14, 27);
        Assert.True((await c.Post($"/api/v1/projects/{project}/sprints/{one}/start")).Ok);

        var second = await c.Post($"/api/v1/projects/{project}/sprints/{two}/start");
        Assert.Equal(HttpStatusCode.Conflict, second.Status);
        Assert.Equal("SPRINT_ACTIVE", second.ErrorCode);
        Assert.Equal(HttpStatusCode.Conflict, (await c.Post($"/api/v1/projects/{project}/sprints/{one}/start")).Status);

        // Completing the first frees the slot.
        Assert.True((await c.Post($"/api/v1/projects/{project}/sprints/{one}/complete", new { })).Ok);
        Assert.True((await c.Post($"/api/v1/projects/{project}/sprints/{two}/start")).Ok);
    }

    [Fact]
    public async Task Unfinished_tasks_can_roll_into_the_next_sprint()
    {
        var (c, project, status) = await Setup();
        var one = await NewSprint(c, project, "One");
        var two = await NewSprint(c, project, "Two", 14, 27);
        var done = await NewTask(c, project, "Done one"); var open = await NewTask(c, project, "Open one");
        await Plan(c, project, one, done, open);
        await c.Post($"/api/v1/projects/{project}/sprints/{one}/start");
        await Move(c, done, status["Done"]);

        var res = await c.Post($"/api/v1/projects/{project}/sprints/{one}/complete", new { moveUnfinishedTo = two });
        Assert.True(res.Ok, res.ToString());
        var next = (await c.Get($"/api/v1/projects/{project}/tasks?sprintId={two}")).Data!["items"]!.AsArray();
        Assert.Equal("Open one", Assert.Single(next)!["title"]!.GetValue<string>());

        // Not into a sprint that already finished, nor a running one.
        var three = await NewSprint(c, project, "Three", 28, 40);
        await c.Post($"/api/v1/projects/{project}/sprints/{two}/start");
        var bad = await c.Post($"/api/v1/projects/{project}/sprints/{two}/complete", new { moveUnfinishedTo = one });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, bad.Status);
        _ = three;
    }

    [Fact]
    public async Task Sprint_details_are_validated_and_completed_sprints_are_frozen()
    {
        var (c, project, _) = await Setup();
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Post($"/api/v1/projects/{project}/sprints", new { name = "", startDate = Day(0), endDate = Day(5) })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Post($"/api/v1/projects/{project}/sprints", new { name = "Backwards", startDate = Day(5), endDate = Day(0) })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Post($"/api/v1/projects/{project}/sprints", new { name = "Forever", startDate = Day(0), endDate = Day(400) })).Status);

        var sprint = await NewSprint(c, project);
        var edit = await c.Put($"/api/v1/projects/{project}/sprints/{sprint}", new { name = "Renamed", goal = "New goal", startDate = Day(1), endDate = Day(10) });
        Assert.True(edit.Ok, edit.ToString());
        Assert.Equal("Renamed", edit.Data!["name"]!.GetValue<string>());

        await c.Post($"/api/v1/projects/{project}/sprints/{sprint}/start");
        // A running sprint keeps its start date.
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Put($"/api/v1/projects/{project}/sprints/{sprint}", new { name = "Renamed", startDate = Day(3), endDate = Day(10) })).Status);
        Assert.Equal(HttpStatusCode.Conflict, (await c.Delete($"/api/v1/projects/{project}/sprints/{sprint}")).Status);

        await c.Post($"/api/v1/projects/{project}/sprints/{sprint}/complete", new { });
        Assert.Equal(HttpStatusCode.Conflict, (await c.Put($"/api/v1/projects/{project}/sprints/{sprint}", new { name = "Late", startDate = Day(1), endDate = Day(10) })).Status);
        var task = await NewTask(c, project);
        Assert.Equal(HttpStatusCode.Conflict, (await Plan(c, project, sprint, task)).Status);
    }

    [Fact]
    public async Task Deleting_a_planned_sprint_returns_its_tasks_to_the_backlog()
    {
        var (c, project, _) = await Setup();
        var sprint = await NewSprint(c, project);
        var task = await NewTask(c, project);
        await Plan(c, project, sprint, task);
        Assert.Empty((await c.Get($"/api/v1/projects/{project}/tasks?backlog=true")).Data!["items"]!.AsArray());

        Assert.Equal(HttpStatusCode.NoContent, (await c.Delete($"/api/v1/projects/{project}/sprints/{sprint}")).Status);
        Assert.Single((await c.Get($"/api/v1/projects/{project}/tasks?backlog=true")).Data!["items"]!.AsArray());
        Assert.Equal(HttpStatusCode.NotFound, (await c.Get($"/api/v1/projects/{project}/sprints/{sprint}")).Status);
    }

    [Fact]
    public async Task Tasks_move_between_sprints_and_back_to_the_backlog_one_at_a_time_or_in_bulk()
    {
        var (c, project, _) = await Setup();
        var one = await NewSprint(c, project, "One");
        var two = await NewSprint(c, project, "Two", 14, 27);
        var t = await NewTask(c, project);

        Assert.Equal(HttpStatusCode.NoContent, (await c.Put($"/api/v1/tasks/{t}/sprint", new { sprintId = one })).Status);
        Assert.Equal("One", (await c.Get($"/api/v1/tasks/{t}")).Data!["task"]!["sprintName"]!.GetValue<string>());
        await Plan(c, project, two, t);
        Assert.Equal("Two", (await c.Get($"/api/v1/tasks/{t}")).Data!["task"]!["sprintName"]!.GetValue<string>());
        Assert.Equal(HttpStatusCode.NoContent, (await c.Post($"/api/v1/projects/{project}/backlog", new { taskIds = new[] { t } })).Status);
        Assert.Null((await c.Get($"/api/v1/tasks/{t}")).Data!["task"]!["sprintId"]);
    }

    [Fact]
    public async Task Planning_rejects_foreign_tasks_subtasks_and_unknown_sprints()
    {
        var (c, project, _) = await Setup();
        var other = await c.CreateProjectAsync("Other");
        var sprint = await NewSprint(c, project);
        var foreign = await NewTask(c, other, "Elsewhere");
        var parent = await NewTask(c, project, "Parent");
        var sub = Guid.Parse((await c.CreateTaskAsync(project, "Sub", new { title = "Sub", priority = "Low", parentTaskId = parent }))["id"]!.GetValue<string>());

        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await Plan(c, project, sprint, foreign)).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await Plan(c, project, sprint, sub)).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await Plan(c, project, Guid.NewGuid(), parent)).Status);
    }

    [Fact]
    public async Task Burndown_counts_remaining_tasks_and_planning_needs_edit_rights()
    {
        var (c, project, status) = await Setup();
        var sprint = await NewSprint(c, project, "S", 0, 6);
        var a = await NewTask(c, project, "A"); var b = await NewTask(c, project, "B");
        await Plan(c, project, sprint, a, b);
        Assert.Empty((await c.Get($"/api/v1/projects/{project}/sprints/{sprint}")).Data!["burndown"]!.AsArray()); // planned: nothing to burn yet

        await c.Post($"/api/v1/projects/{project}/sprints/{sprint}/start");
        await Move(c, a, status["Done"]);
        var burn = (await c.Get($"/api/v1/projects/{project}/sprints/{sprint}")).Data!["burndown"]!.AsArray();
        Assert.NotEmpty(burn);
        Assert.Equal(1, burn[^1]!["remaining"]!.GetValue<int>());
        Assert.Equal(2.0, burn[0]!["ideal"]!.GetValue<double>());

        var guest = await c.AddMemberAsync(factory, TenantRole.Guest, "Guest");
        Assert.False((await guest.Post($"/api/v1/projects/{project}/sprints", new { name = "Nope", startDate = Day(0), endDate = Day(3) })).Ok);
    }
}
