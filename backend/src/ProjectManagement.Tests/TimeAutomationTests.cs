using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Time entries and the timer, and project automation rules.</summary>
[Collection("api")]
public class TimeAutomationTests(ApiFactory factory)
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

    private static async Task<Guid> NewTask(TestClient c, Guid project, string title = "Task", object? extra = null) =>
        Guid.Parse((await c.CreateTaskAsync(project, title, extra))["id"]!.GetValue<string>());

    private static async Task<JsonNode> TaskOf(TestClient c, Guid id) => (await c.Get($"/api/v1/tasks/{id}")).Data!["task"]!;

    private static Task<ApiResult> Move(TestClient c, Guid task, Guid status) =>
        c.Send(HttpMethod.Patch, $"/api/v1/tasks/{task}/move", new { statusId = status });

    private static Task<ApiResult> Rule(TestClient c, Guid project, object body) => c.Post($"/api/v1/projects/{project}/automations", body);

    // ------------------------------------------------------------------ time

    [Fact]
    public async Task Logged_time_adds_up_and_drives_the_tasks_actual_hours()
    {
        var (c, project, _) = await Setup("FREE");
        var task = await NewTask(c, project);

        var first = await c.Post($"/api/v1/tasks/{task}/time", new { minutes = 90, note = "Design" });
        Assert.True(first.Ok, first.ToString());
        var second = await c.Post($"/api/v1/tasks/{task}/time", new { minutes = 30 });
        Assert.Equal(HttpStatusCode.Created, second.Status);

        var timeRes = await c.Get($"/api/v1/tasks/{task}/time");
        Assert.True(timeRes.Ok, timeRes.ToString());
        var time = timeRes.Data!;
        Assert.Equal(120, time["totalMinutes"]!.GetValue<int>());
        Assert.Equal(2, time["entries"]!.AsArray().Count);
        Assert.Equal(2.0m, (await TaskOf(c, task))["actualHours"]!.GetValue<decimal>());

        // Edit and delete keep the total honest.
        var id = Guid.Parse(second.Data!["id"]!.GetValue<string>());
        Assert.True((await c.Put($"/api/v1/time/{id}", new { minutes = 60, workDate = DateTime.UtcNow.ToString("yyyy-MM-dd"), note = "Review" })).Ok);
        Assert.Equal(2.5m, (await TaskOf(c, task))["actualHours"]!.GetValue<decimal>());
        Assert.Equal(HttpStatusCode.NoContent, (await c.Delete($"/api/v1/time/{id}")).Status);
        Assert.Equal(1.5m, (await TaskOf(c, task))["actualHours"]!.GetValue<decimal>());
    }

    [Fact]
    public async Task Time_entries_are_validated()
    {
        var (c, project, _) = await Setup("FREE");
        var task = await NewTask(c, project);

        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Post($"/api/v1/tasks/{task}/time", new { minutes = 0 })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Post($"/api/v1/tasks/{task}/time", new { minutes = 1441 })).Status);
        var future = DateTime.UtcNow.AddDays(3).ToString("yyyy-MM-dd");
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Post($"/api/v1/tasks/{task}/time", new { minutes = 30, workDate = future })).Status);

        // No more than 24 h in a day.
        Assert.True((await c.Post($"/api/v1/tasks/{task}/time", new { minutes = 1000 })).Ok);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Post($"/api/v1/tasks/{task}/time", new { minutes = 500 })).Status);
    }

    [Fact]
    public async Task Timer_starts_stops_and_only_one_runs_at_a_time()
    {
        var (c, project, _) = await Setup("FREE");
        var a = await NewTask(c, project, "A");
        var b = await NewTask(c, project, "B");

        Assert.Null((await c.Get("/api/v1/timer")).Data);
        Assert.Equal(HttpStatusCode.Conflict, (await c.Post("/api/v1/timer/stop")).Status);

        var start = await c.Post($"/api/v1/tasks/{a}/timer/start");
        Assert.True(start.Ok, start.ToString());
        Assert.True(start.Data!["isRunning"]!.GetValue<bool>());
        // Pretend it started 45 minutes ago.
        factory.WithDb(db => { db.TimeEntries.IgnoreQueryFilters().Where(e => e.TaskId == a).ExecuteUpdate(s => s.SetProperty(e => e.StartedAt, DateTime.UtcNow.AddMinutes(-45))); return 0; });

        // Starting on another task stops the first and keeps its time.
        Assert.True((await c.Post($"/api/v1/tasks/{b}/timer/start")).Ok);
        var first = (await c.Get($"/api/v1/tasks/{a}/time")).Data!;
        Assert.InRange(first["totalMinutes"]!.GetValue<int>(), 44, 46);
        Assert.Equal(b.ToString(), (await c.Get("/api/v1/timer")).Data!["taskId"]!.GetValue<string>());

        var stop = await c.Post("/api/v1/timer/stop");
        Assert.True(stop.Ok, stop.ToString());
        Assert.False(stop.Data!["isRunning"]!.GetValue<bool>());
        Assert.True(stop.Data["minutes"]!.GetValue<int>() >= 1);
        Assert.Null((await c.Get("/api/v1/timer")).Data);
    }

    [Fact]
    public async Task Timesheet_shows_my_days_and_others_need_the_reports_permission()
    {
        var (c, project, _) = await Setup("PRO");
        var task = await NewTask(c, project);
        await c.Post($"/api/v1/tasks/{task}/time", new { minutes = 45 });

        var sheet = (await c.Get("/api/v1/time")).Data!;
        Assert.Equal(45, sheet["totalMinutes"]!.GetValue<int>());
        Assert.Equal(7, sheet["byDay"]!.AsArray().Count);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Get("/api/v1/time?from=2020-01-01&to=2026-01-01")).Status);

        var guest = await c.AddMemberAsync(factory, TenantRole.Guest, "Guest");
        Assert.Equal(HttpStatusCode.Forbidden, (await guest.Get($"/api/v1/time?userId={c.UserId}")).Status);
    }

    [Fact]
    public async Task A_plain_manager_is_limited_to_their_reporting_line_even_though_reports_view_is_a_default()
    {
        var (c, project, _) = await Setup();
        var task = await NewTask(c, project);
        var manager = await c.AddMemberAsync(factory, TenantRole.Manager, "Max");     // has reports.view by default
        var stranger = await c.AddMemberAsync(factory, TenantRole.Member, "Stan");
        await c.Post($"/api/v1/tasks/{task}/time", new { minutes = 30 });

        // reports.view lets Max open the Reports page, but not read a stranger's timesheet - only Owners/Admins
        // (or a job-role profile that explicitly widens it) reach beyond a manager's own reporting line.
        Assert.True((await manager.Get("/api/v1/reports/summary")).Ok);
        Assert.Equal(HttpStatusCode.Forbidden, (await manager.Get($"/api/v1/time?userId={c.UserId}")).Status);
        Assert.True((await c.Get($"/api/v1/time?userId={manager.UserId}")).Ok);          // the owner still can, of course
    }

    [Fact]
    public async Task Only_the_owner_or_an_admin_can_change_a_time_entry()
    {
        var (c, project, _) = await Setup("BUSINESS");
        var task = await NewTask(c, project);
        var member = await c.AddMemberAsync(factory, TenantRole.Member, "Mem");
        var admin = await c.AddMemberAsync(factory, TenantRole.Admin, "Adm");
        await c.Post($"/api/v1/projects/{project}/members", new { userId = member.UserId, role = "Member" });

        var entry = (await c.Post($"/api/v1/tasks/{task}/time", new { minutes = 20 })).Data!["id"]!.GetValue<string>();
        Assert.False((await member.Delete($"/api/v1/time/{entry}")).Ok);
        Assert.Equal(HttpStatusCode.NoContent, (await admin.Delete($"/api/v1/time/{entry}")).Status);
    }

    [Fact]
    public async Task Project_time_summary_groups_by_person_and_task()
    {
        var (c, project, _) = await Setup("FREE");
        var a = await NewTask(c, project, "A");
        var b = await NewTask(c, project, "B", new { title = "B", priority = "Low", estimatedHours = 4 });
        await c.Post($"/api/v1/tasks/{a}/time", new { minutes = 60 });
        await c.Post($"/api/v1/tasks/{b}/time", new { minutes = 30 });

        var s = (await c.Get($"/api/v1/projects/{project}/time")).Data!;
        Assert.Equal(90, s["totalMinutes"]!.GetValue<int>());
        Assert.Single(s["byPerson"]!.AsArray());
        Assert.Equal(2, s["topTasks"]!.AsArray().Count);
        Assert.Equal(4m, s["estimatedHours"]!.GetValue<decimal>());
    }

    // ------------------------------------------------------------------ automation

    [Fact]
    public async Task Automation_needs_a_plan_that_includes_it()
    {
        var (c, project, _) = await Setup("FREE");
        var res = await Rule(c, project, new { name = "x", isEnabled = true, trigger = "TaskCreated", action = "SetPriority", actionPriority = "High" });
        Assert.False(res.Ok);
        Assert.Equal(HttpStatusCode.Forbidden, res.Status);
    }

    [Fact]
    public async Task Rule_on_task_creation_sets_priority_and_labels_and_is_counted()
    {
        var (c, project, _) = await Setup();
        var label = (await c.Post("/api/v1/labels", new { name = "Triage", color = "#ff0000" })).Data!["id"]!.GetValue<string>();
        Assert.True((await Rule(c, project, new { name = "Escalate", isEnabled = true, trigger = "TaskCreated", action = "SetPriority", actionPriority = "Critical" })).Ok);
        var made = await Rule(c, project, new { name = "Triage new", isEnabled = true, trigger = "TaskCreated", action = "AddLabel", actionLabelId = label });
        Assert.Equal(HttpStatusCode.Created, made.Status);
        Assert.Contains("add the label", made.Data!["summary"]!.GetValue<string>());

        var task = await TaskOf(c, await NewTask(c, project, "Outage", new { title = "Outage", priority = "Low", labelIds = new[] { label } }));
        Assert.Equal("Critical", task["priority"]!.GetValue<string>());
        Assert.Single(task["labels"]!.AsArray()); // the label the person chose is not duplicated by the rule

        var rules = (await c.Get($"/api/v1/projects/{project}/automations")).Data!.AsArray();
        Assert.Equal(1, rules.Single(r => r!["name"]!.GetValue<string>() == "Escalate")!["runCount"]!.GetValue<int>());
        Assert.Equal(0, rules.Single(r => r!["name"]!.GetValue<string>() == "Triage new")!["runCount"]!.GetValue<int>()); // label was already there
    }

    [Fact]
    public async Task Rule_on_status_change_moves_notifies_and_comments()
    {
        var (c, project, status) = await Setup();
        var member = await c.AddMemberAsync(factory, TenantRole.Member, "Reviewer");
        Assert.True((await Rule(c, project, new
        {
            name = "Ping reviewer on Done", isEnabled = true, trigger = "StatusChanged", whenStatusId = status["Done"],
            action = "Notify", actionTarget = "User", actionUserId = member.UserId, actionText = "Please review",
        })).Ok);
        Assert.True((await Rule(c, project, new
        {
            name = "Note", isEnabled = true, trigger = "StatusChanged", whenStatusId = status["Done"], action = "AddComment", actionText = "Shipped",
        })).Ok);

        var task = await NewTask(c, project);
        Assert.True((await Move(c, task, status["In Progress"])).Ok);     // not Done: nothing happens
        Assert.Empty((await c.Get($"/api/v1/tasks/{task}/comments")).Data!.AsArray());
        Assert.True((await Move(c, task, status["Done"])).Ok);

        var comments = (await c.Get($"/api/v1/tasks/{task}/comments")).Data!.AsArray();
        Assert.Contains("Shipped", comments.Single()!["body"]!.GetValue<string>());
        var inbox = (await member.Get("/api/v1/notifications?pageSize=50")).Data!.ToJsonString();
        Assert.Contains("Please review", inbox);
    }

    [Fact]
    public async Task Rules_do_not_chain_and_respect_dependencies()
    {
        var (c, project, status) = await Setup();
        // A -> B and B -> A would loop if actions triggered rules. They must not.
        Assert.True((await Rule(c, project, new { name = "To progress", isEnabled = true, trigger = "StatusChanged", whenStatusId = status["Done"], action = "MoveToStatus", actionStatusId = status["In Progress"] })).Ok);
        Assert.True((await Rule(c, project, new { name = "To done", isEnabled = true, trigger = "StatusChanged", whenStatusId = status["In Progress"], action = "MoveToStatus", actionStatusId = status["Done"] })).Ok);

        var task = await NewTask(c, project);
        var moved = await Move(c, task, status["Done"]);
        Assert.True(moved.Ok, moved.ToString());
        Assert.Equal("In Progress", moved.Data!["statusName"]!.GetValue<string>());
    }

    [Fact]
    public async Task Priority_rule_assigns_and_disabled_or_deleted_rules_stop_running()
    {
        var (c, project, _) = await Setup();
        var member = await c.AddMemberAsync(factory, TenantRole.Member, "Oncall");
        var made = await Rule(c, project, new { name = "Oncall gets Critical", isEnabled = true, trigger = "PriorityChanged", whenPriority = "Critical", action = "SetAssignee", actionTarget = "User", actionUserId = member.UserId });
        Assert.True(made.Ok, made.ToString());
        var ruleId = made.Data!["id"]!.GetValue<string>();

        var task = await NewTask(c, project);
        var current = await TaskOf(c, task);
        object Edit(string priority) => new
        {
            title = "Task", statusId = current["statusId"]!.GetValue<string>(), priority, version = current["version"]!.GetValue<int>(), labelIds = Array.Empty<Guid>(),
        };
        var up = await c.Put($"/api/v1/tasks/{task}", Edit("Critical"));
        Assert.True(up.Ok, up.ToString());
        Assert.Equal(member.UserId.ToString(), up.Data!["assignee"]!["id"]!.GetValue<string>());

        // Disable the rule: a second task is not assigned.
        Assert.True((await c.Put($"/api/v1/projects/{project}/automations/{ruleId}", new { name = "Oncall gets Critical", isEnabled = false, trigger = "PriorityChanged", whenPriority = "Critical", action = "SetAssignee", actionTarget = "User", actionUserId = member.UserId })).Ok);
        var other = await NewTask(c, project, "Other");
        var otherNow = await TaskOf(c, other);
        var again = await c.Put($"/api/v1/tasks/{other}", new { title = "Other", statusId = otherNow["statusId"]!.GetValue<string>(), priority = "Critical", version = otherNow["version"]!.GetValue<int>(), labelIds = Array.Empty<Guid>() });
        Assert.Null(again.Data!["assignee"]);

        Assert.Equal(HttpStatusCode.NoContent, (await c.Delete($"/api/v1/projects/{project}/automations/{ruleId}")).Status);
        Assert.Empty((await c.Get($"/api/v1/projects/{project}/automations")).Data!.AsArray());
    }

    [Fact]
    public async Task Rules_are_validated_and_only_editors_can_manage_them()
    {
        var (c, project, status) = await Setup();
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await Rule(c, project, new { name = "", isEnabled = true, trigger = "TaskCreated", action = "SetPriority", actionPriority = "High" })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await Rule(c, project, new { name = "x", isEnabled = true, trigger = "TaskCreated", action = "SetPriority" })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await Rule(c, project, new { name = "x", isEnabled = true, trigger = "TaskCreated", action = "AddComment" })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await Rule(c, project, new { name = "x", isEnabled = true, trigger = "TaskCreated", action = "MoveToStatus", actionStatusId = Guid.NewGuid() })).Status);
        var stranger = await TestClient.RegisterAsync(factory);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await Rule(c, project, new { name = "x", isEnabled = true, trigger = "TaskCreated", action = "SetAssignee", actionTarget = "User", actionUserId = stranger.UserId })).Status);

        var guest = await c.AddMemberAsync(factory, TenantRole.Guest, "Guest");
        Assert.False((await Rule(guest, project, new { name = "x", isEnabled = true, trigger = "TaskCreated", action = "SetPriority", actionPriority = "High" })).Ok);
        _ = status;
    }
}
