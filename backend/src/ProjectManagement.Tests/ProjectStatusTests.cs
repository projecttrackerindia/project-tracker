using System.Text.Json.Nodes;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// The delivery-date history (who moved a date, when, from what to what, why) and the Project Status page's data: the projects by group and
/// one project's tasks, delays and what is blocking work.
/// </summary>
[Collection("api")]
public class ProjectStatusTests(ApiFactory factory)
{
    private static string Iso(int daysFromToday) => DateOnly.FromDateTime(DateTime.UtcNow).AddDays(daysFromToday).ToString("yyyy-MM-dd");

    private async Task<(TestClient Owner, Guid Project, Guid Todo)> Setup(string name = "Atlas")
    {
        var owner = await TestClient.RegisterAsync(factory, "Olivia Owner");
        await owner.CreateOrgAsync();
        var project = await owner.CreateProjectAsync(name);
        var statuses = (await owner.Get($"/api/v1/projects/{project}/statuses")).Data!.AsArray();
        return (owner, project, Guid.Parse(statuses[0]!["id"]!.GetValue<string>()));
    }

    private static async Task<Guid> NewTask(TestClient c, Guid project, string title, string? due = null, string? start = null) =>
        Guid.Parse((await c.CreateTaskAsync(project, title, new { title, priority = "Medium", dueDate = due, startDate = start }))["id"]!.GetValue<string>());

    private static async Task<int> Version(TestClient c, Guid task) => (await c.Get($"/api/v1/tasks/{task}")).Data!["task"]!["version"]!.GetValue<int>();

    private static async Task<ApiResult> Reschedule(TestClient c, Guid task, Guid status, string? due, string? reason = null, string? dependency = null, string title = "Task")
    {
        var v = await Version(c, task);
        return await c.Put($"/api/v1/tasks/{task}", new { title, priority = "Medium", statusId = status, dueDate = due, version = v, dueDateReason = reason, dueDateDependency = dependency });
    }

    private static async Task<JsonNode> Report(TestClient c, Guid project) => (await c.Get($"/api/v1/project-status/projects/{project}")).Data!;

    // ------------------------------------------------------------------ recording

    [Fact]
    public async Task A_delay_needs_a_reason_and_every_change_is_kept_with_who_when_from_what_to_what_and_why()
    {
        var (c, project, todo) = await Setup();
        var task = await NewTask(c, project, "Build login", due: Iso(10), start: Iso(0));

        // Pushing the date later without saying why is refused; the field is named.
        var refused = await Reschedule(c, task, todo, Iso(20), title: "Build login");
        Assert.Equal(422, (int)refused.Status);
        Assert.Equal("dueDateReason", refused.Json!["errors"]![0]!["field"]!.GetValue<string>());

        var delayed = await Reschedule(c, task, todo, Iso(20), "Waiting for client sign-off", "Client answer on the design", "Build login");
        Assert.True(delayed.Ok, delayed.ToString());
        // Bringing it forward again needs no reason.
        Assert.True((await Reschedule(c, task, todo, Iso(18), title: "Build login")).Ok);
        // Saving without moving the date records nothing.
        Assert.True((await Reschedule(c, task, todo, Iso(18), title: "Build login (edited)")).Ok);

        var report = await Report(c, project);
        var changes = report["changes"]!.AsArray();
        Assert.Equal(2, changes.Count);                                       // newest first
        var back = changes[0]!; var slip = changes[1]!;
        Assert.Equal(Iso(20), back["previous"]!.GetValue<string>()); Assert.Equal(Iso(18), back["revised"]!.GetValue<string>());
        Assert.Equal(-2, back["daysShifted"]!.GetValue<int>());
        Assert.Equal(Iso(10), slip["previous"]!.GetValue<string>()); Assert.Equal(Iso(20), slip["revised"]!.GetValue<string>());
        Assert.Equal(10, slip["daysShifted"]!.GetValue<int>());
        Assert.Equal("Waiting for client sign-off", slip["reason"]!.GetValue<string>());
        Assert.Equal("Client answer on the design", slip["dependency"]!.GetValue<string>());
        Assert.Equal("Olivia Owner", slip["changedBy"]!["name"]!.GetValue<string>());
        Assert.True(DateTime.Parse(slip["changedAt"]!.GetValue<string>()).ToUniversalTime() > DateTime.UtcNow.AddMinutes(-5));
        Assert.Equal("Task", slip["scope"]!.GetValue<string>());
        Assert.EndsWith("-1", slip["taskKey"]!.GetValue<string>());
        Assert.Equal("Yet To Start", slip["currentStatus"]!.GetValue<string>());

        // The task keeps its original date, how far it has slipped, and how many times it moved.
        var row = report["tasks"]!.AsArray().Single()!;
        Assert.Equal(Iso(10), row["originalDueDate"]!.GetValue<string>());
        Assert.Equal(Iso(18), row["dueDate"]!.GetValue<string>());
        Assert.Equal(8, row["delayedDays"]!.GetValue<int>());
        Assert.Equal(2, row["revisions"]!.GetValue<int>());

        // The activity feed says it in full: the year, how many days, and why.
        var activity = (await c.Get($"/api/v1/projects/{project}/activity")).Data!["items"]!.AsArray().Select(a => a!["summary"]!.GetValue<string>()).ToArray();
        var text = Iso(10).Length > 0 ? DateOnly.Parse(Iso(10)).ToString("dd MMM yyyy") : "";
        Assert.Contains(activity, s => s.Contains($"due date {text} → {DateOnly.Parse(Iso(20)):dd MMM yyyy} (10 days later): Waiting for client sign-off"));
    }

    [Fact]
    public async Task A_projects_own_due_date_is_recorded_too_even_when_its_status_changes_in_the_same_edit()
    {
        var (c, project, _) = await Setup("Payments");
        var first = (await c.Get($"/api/v1/projects/{project}")).Data!["project"]!;
        var edit = new
        {
            name = "Payments", priority = "Medium", status = "Active", version = first["version"]!.GetValue<int>(), dueDate = Iso(30),
            dueDateReason = "Vendor delayed the API", dueDateDependency = "Payment provider",
        };
        Assert.True((await c.Put($"/api/v1/projects/{project}", edit)).Ok);      // first date set: not a delay, nothing to explain
        var second = (await c.Get($"/api/v1/projects/{project}")).Data!["project"]!;
        var noReason = await c.Put($"/api/v1/projects/{project}", new { name = "Payments", priority = "Medium", status = "OnHold", version = second["version"]!.GetValue<int>(), dueDate = Iso(45) });
        Assert.Equal(422, (int)noReason.Status);
        Assert.Equal("dueDateReason", noReason.Json!["errors"]![0]!["field"]!.GetValue<string>());

        var both = await c.Put($"/api/v1/projects/{project}", new
        {
            name = "Payments", priority = "Medium", status = "OnHold", version = second["version"]!.GetValue<int>(), dueDate = Iso(45),
            dueDateReason = "Vendor delayed the API", dueDateDependency = "Payment provider",
        });
        Assert.True(both.Ok, both.ToString());

        var report = await Report(c, project);
        var change = report["changes"]!.AsArray().First(x => x!["reason"] is not null)!;
        Assert.Equal("Project", change["scope"]!.GetValue<string>());
        Assert.Equal(Iso(30), change["previous"]!.GetValue<string>());
        Assert.Equal(Iso(45), change["revised"]!.GetValue<string>());
        Assert.Equal(15, change["daysShifted"]!.GetValue<int>());
        Assert.Equal("OnHold", change["currentStatus"]!.GetValue<string>());
        Assert.Equal(15, report["project"]!["delayedDays"]!.GetValue<int>());
        Assert.Equal(Iso(30), report["project"]!["originalDueDate"]!.GetValue<string>());
        // Both the status change and the date change are in the activity feed.
        var actions = (await c.Get($"/api/v1/projects/{project}/activity")).Data!["items"]!.AsArray().Select(a => a!["summary"]!.GetValue<string>()).ToArray();
        Assert.Contains(actions, s => s.Contains("status:") && s.Contains("OnHold"));
        Assert.Contains(actions, s => s.Contains("→") && s.Contains("Vendor delayed the API"));
    }

    // ------------------------------------------------------------------ one project's status

    [Fact]
    public async Task The_report_lists_the_tasks_with_their_dates_overdue_days_and_what_they_are_waiting_on()
    {
        var (c, project, todo) = await Setup("Portal");
        var api = await NewTask(c, project, "Backend API", due: Iso(-5), start: Iso(-20));
        var ui = await NewTask(c, project, "Frontend", due: Iso(7));
        var sub = Guid.Parse((await c.CreateTaskAsync(project, "Wire the form", new { title = "Wire the form", priority = "Low", parentTaskId = ui, dueDate = Iso(3) }))["id"]!.GetValue<string>());
        // The frontend cannot finish before the API does.
        var dep = await c.Post($"/api/v1/tasks/{ui}/dependencies", new { dependsOnTaskId = api, type = "FinishToStart" });
        Assert.True(dep.Ok, dep.ToString());

        var report = await Report(c, project);
        Assert.Equal("Portal", report["project"]!["name"]!.GetValue<string>());
        Assert.Equal("Other Projects", report["project"]!["groupName"]!.GetValue<string>());
        var tasks = report["tasks"]!.AsArray();
        Assert.Equal(new[] { "Backend API", "Frontend", "Wire the form" }, tasks.Select(t => t!["title"]!.GetValue<string>()).ToArray());   // sub-tasks sit under their parent
        Assert.Equal(sub.ToString(), tasks[2]!["id"]!.GetValue<string>());
        Assert.Equal(ui.ToString(), tasks[2]!["parentTaskId"]!.GetValue<string>());

        var apiRow = tasks[0]!;
        Assert.InRange(apiRow["overdueDays"]!.GetValue<int>(), 4, 6);
        Assert.Equal(0, apiRow["delayedDays"]!.GetValue<int>());
        var uiRow = tasks[1]!;
        Assert.Equal(0, uiRow["overdueDays"]!.GetValue<int>());
        var blocker = uiRow["blockedBy"]!.AsArray().Single()!;
        Assert.Equal("Backend API", blocker["title"]!.GetValue<string>());
        Assert.Equal("Yet To Start", blocker["statusName"]!.GetValue<string>());
        Assert.Equal(1, report["blockedTasks"]!.GetValue<int>());
        _ = todo;
    }

    [Fact]
    public async Task The_status_page_groups_projects_and_leaves_out_empty_groups_and_archived_projects()
    {
        var owner = await TestClient.RegisterAsync(factory);
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var sf = Guid.Parse((await owner.Post("/api/v1/project-groups", new { name = "Salesforce Projects" })).Data!["id"]!.GetValue<string>());
        var hr = Guid.Parse((await owner.Post("/api/v1/project-groups", new { name = "HRMS" })).Data!["id"]!.GetValue<string>());
        await owner.Post("/api/v1/project-groups", new { name = "Empty Group" });
        owner.AutoProjectGroup = false;
        async Task<Guid> Create(string name, Guid group) => Guid.Parse((await owner.Post("/api/v1/projects", new { name, priority = "Medium", projectGroupId = group })).Data!["project"]!["id"]!.GetValue<string>());
        await Create("CRM rollout", sf); await Create("CRM migration", sf);
        var payroll = await Create("Payroll", hr);
        var old = await Create("Archived thing", hr);
        Assert.True((await owner.Send(HttpMethod.Patch, $"/api/v1/projects/{old}/move", new { status = "Archived" })).Ok);

        var groups = (await owner.Get("/api/v1/project-status/groups")).Data!.AsArray();
        Assert.Equal(new[] { "Salesforce Projects", "HRMS" }, groups.Select(g => g!["name"]!.GetValue<string>()).ToArray());
        Assert.Equal(new[] { 2, 1 }, groups.Select(g => g!["count"]!.GetValue<int>()).ToArray());
        Assert.Equal(new[] { "CRM migration", "CRM rollout" }, groups[0]!["projects"]!.AsArray().Select(p => p!["name"]!.GetValue<string>()).ToArray());
        Assert.Equal("Payroll", groups[1]!["projects"]![0]!["name"]!.GetValue<string>());

        // A guest sees only the projects they were added to.
        var guest = await owner.AddMemberAsync(factory, TenantRole.Guest);
        Assert.True((await owner.Post($"/api/v1/projects/{payroll}/members", new { userId = guest.UserId })).Ok);
        var seen = (await guest.Get("/api/v1/project-status/groups")).Data!.AsArray();
        Assert.Equal("Payroll", seen.Single()!["projects"]![0]!["name"]!.GetValue<string>());
        Assert.Equal(404, (int)(await guest.Get($"/api/v1/project-status/projects/{await Create("Hidden", sf)}")).Status);
    }

    [Fact]
    public async Task Work_under_way_shows_next_to_what_is_done_so_a_project_with_a_task_in_progress_is_not_shown_as_untouched()
    {
        var (owner, project, todo) = await Setup();
        var a = await NewTask(owner, project, "Build the API");
        await NewTask(owner, project, "Write the docs");
        var statuses = (await owner.Get($"/api/v1/projects/{project}/statuses")).Data!.AsArray();
        var active = Guid.Parse(statuses.First(x => x!["category"]!.GetValue<string>() == "Active")!["id"]!.GetValue<string>());
        var done = Guid.Parse(statuses.First(x => x!["category"]!.GetValue<string>() == "Done")!["id"]!.GetValue<string>());
        async Task Move(Guid task, Guid status) { var res = await Reschedule(owner, task, status, null); Assert.True(res.Ok, res.ToString()); }
        await Move(a, active);

        // "Done" stays strict (nothing is finished), and the page also says how much is being worked on.
        var list = (await owner.Get("/api/v1/project-status/groups")).Data!.ToJsonString();
        var detailRes = await owner.Get($"/api/v1/project-status/projects/{project}"); Assert.True(detailRes.Ok, detailRes.ToString());
        var detail = detailRes.Data!["project"]!;
        Assert.Equal(0, detail["progress"]!.GetValue<int>());
        Assert.Equal(1, detail["stats"]!["inProgress"]!.GetValue<int>());
        Assert.Contains("\"active\":50", list);
        var brief = (await owner.Get("/api/v1/ai/portfolio/brief")).Data!["ranked"]![0]!;
        Assert.Equal(1, brief["inProgressTasks"]!.GetValue<int>());

        await Move(a, done);
        Assert.Contains("\"active\":0", (await owner.Get("/api/v1/project-status/groups")).Data!.ToJsonString());
        Assert.Equal(50, (await owner.Get($"/api/v1/project-status/projects/{project}")).Data!["project"]!["progress"]!.GetValue<int>());
        Assert.Equal(0, ProjectManagement.Application.Features.Projects.ProjectMetrics.ActiveShare(new(0, 0, 0, 0, 0, 0)));
        Assert.Equal(25, ProjectManagement.Application.Features.Projects.ProjectMetrics.ActiveShare(new(4, 1, 1, 2, 0, 0)));
    }

    [Fact]
    public async Task A_project_in_planning_becomes_active_when_work_on_it_starts_and_never_completes_by_itself()
    {
        var (owner, project, _) = await Setup();
        async Task<string> StatusOf() => (await owner.Get($"/api/v1/projects/{project}")).Data!["project"]!["status"]!.GetValue<string>();
        Assert.Equal("Planning", await StatusOf());
        var t = await NewTask(owner, project, "Build it");
        Assert.Equal("Planning", await StatusOf());                              // a task that has not been started changes nothing

        var statuses = (await owner.Get($"/api/v1/projects/{project}/statuses")).Data!.AsArray();
        Guid Of(string category) => Guid.Parse(statuses.First(x => x!["category"]!.GetValue<string>() == category)!["id"]!.GetValue<string>());
        Assert.True((await Reschedule(owner, t, Of("Active"), null)).Ok);
        Assert.Equal("Active", await StatusOf());                                // work started

        Assert.True((await Reschedule(owner, t, Of("Done"), null)).Ok);
        Assert.Equal("Active", await StatusOf());                                // everything is done, yet closing the project stays a decision

        // On hold is respected: later movement does not restart a project somebody paused.
        Assert.True((await owner.Patch($"/api/v1/projects/{project}/move", new { status = "OnHold" })).Ok);
        Assert.True((await Reschedule(owner, t, Of("Active"), null)).Ok);
        Assert.Equal("OnHold", await StatusOf());
    }
}
