using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Features.Work;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Infrastructure.Persistence;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Timesheet approval, billable time, capacity and cost, project budgets, and service levels on operational work.</summary>
[Collection("api")]
public class ResourcingTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private static int I(JsonNode? n) => n!.GetValue<int>();
    private static decimal D(JsonNode? n) => n!.GetValue<decimal>();
    private static DateOnly Today => DateOnly.FromDateTime(DateTime.UtcNow);
    private static DateOnly LastMonday => Today.AddDays(-(((int)Today.DayOfWeek + 6) % 7) - 7);
    private static string Iso(DateOnly d) => d.ToString("yyyy-MM-dd");

    private sealed record Team(TestClient Owner, TestClient Manager, TestClient Dev, TestClient Peer, Guid Project, string TaskId);

    /// <summary>A Business organization: Dev reports to Manager; Peer is another member outside that line; a billable project with a task for Dev.</summary>
    private async Task<Team> Setup()
    {
        var owner = await TestClient.RegisterAsync(factory, "Olivia Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var manager = await owner.AddMemberAsync(factory, TenantRole.Manager, "Maya Manager");
        var dev = await owner.AddMemberAsync(factory, TenantRole.Member, "Dev Developer");
        var peer = await owner.AddMemberAsync(factory, TenantRole.Member, "Pat Peer");
        Assert.True((await owner.Put($"/api/v1/org/members/{dev.UserId}/reports-to", new { reportsToUserId = manager.UserId })).Ok);
        var project = await owner.CreateProjectAsync("Client Portal");
        var task = await owner.CreateTaskAsync(project, "Build the login page", new { title = "Build the login page", priority = "Medium", assigneeId = dev.UserId });
        return new Team(owner, manager, dev, peer, project, S(task["id"]));
    }

    private static async Task<ApiResult> Log(TestClient c, string taskId, int minutes, DateOnly date, bool? billable = null) =>
        await c.Post($"/api/v1/tasks/{taskId}/time", new { minutes, workDate = Iso(date), billable });

    // ------------------------------------------------------------------ timesheet approval

    [Fact]
    public async Task A_submitted_week_is_locked_until_a_manager_approves_or_returns_it()
    {
        var t = await Setup();
        var budget = await t.Owner.Put($"/api/v1/resources/projects/{t.Project}/budget", new { isBillable = true, budgetHours = 10, budgetAmount = 1000, billRate = (decimal?)null });
        Assert.True(budget.Ok, budget.ToString());

        // Time on a billable project starts out billable; it can be marked otherwise per entry.
        var first = await Log(t.Dev, t.TaskId, 120, LastMonday);
        Assert.True(first.Ok, first.ToString());
        Assert.True(first.Data!["billable"]!.GetValue<bool>());
        Assert.False((await Log(t.Dev, t.TaskId, 60, LastMonday.AddDays(1), billable: false)).Data!["billable"]!.GetValue<bool>());

        var week = (await t.Dev.Get($"/api/v1/time/week?weekStart={Iso(LastMonday)}")).Data!;
        Assert.Equal("NotSubmitted", S(week["status"]));
        Assert.Equal(180, I(week["totalMinutes"]));
        Assert.Equal(120, I(week["billableMinutes"]));
        Assert.True(week["canSubmit"]!.GetValue<bool>());
        Assert.Equal(422, (int)(await t.Dev.Post("/api/v1/time/week/submit", new { weekStart = Iso(Today.AddDays(14)) })).Status);   // a future week

        var submitted = await t.Dev.Post("/api/v1/time/week/submit", new { weekStart = Iso(LastMonday.AddDays(3)), note = "Thursday off" });   // any day of the week will do
        Assert.True(submitted.Ok, submitted.ToString());
        Assert.Equal("Submitted", S(submitted.Data!["status"]));
        Assert.Equal(Iso(LastMonday), S(submitted.Data!["weekStart"]));
        var id = S(submitted.Data!["id"]);
        // Dev's manager is told.
        Assert.Contains((await t.Manager.Get("/api/v1/notifications")).Data!["items"]!.AsArray(), n => S(n!["type"]) == "Approval" && S(n["title"]).Contains("Dev Developer"));

        // Locked: no new time, no edits, no deletions in that week - for anyone, admins included.
        var locked = await Log(t.Dev, t.TaskId, 30, LastMonday.AddDays(2));
        Assert.Equal(HttpStatusCode.Conflict, locked.Status);
        Assert.Equal("TIMESHEET_LOCKED", locked.ErrorCode);
        var entryId = S(first.Data!["id"]);
        Assert.Equal("TIMESHEET_LOCKED", (await t.Owner.Delete($"/api/v1/time/{entryId}")).ErrorCode);
        Assert.Equal("TIMESHEET_LOCKED", (await t.Dev.Put($"/api/v1/time/{entryId}", new { minutes = 90, workDate = Iso(LastMonday) })).ErrorCode);
        var sheet = (await t.Dev.Get($"/api/v1/time?from={Iso(LastMonday)}&to={Iso(LastMonday.AddDays(6))}")).Data!;
        Assert.All(sheet["entries"]!.AsArray(), e => { Assert.True(e!["locked"]!.GetValue<bool>()); Assert.False(e["canEdit"]!.GetValue<bool>()); });
        Assert.Equal(120, I(sheet["billableMinutes"]));

        // Nobody reviews their own week; someone outside the reporting line cannot either.
        Assert.Equal(HttpStatusCode.Forbidden, (await t.Dev.Post($"/api/v1/time/approvals/{id}/approve", new { })).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await t.Peer.Post($"/api/v1/time/approvals/{id}/approve", new { })).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await t.Peer.Get("/api/v1/time/approvals")).Status);

        // The manager's view: Dev's week waiting, also in the pending list.
        var queue = (await t.Manager.Get($"/api/v1/time/approvals?weekStart={Iso(LastMonday)}")).Data!;
        var row = queue["week"]!.AsArray().Single(r => S(r!["user"]!["id"]) == t.Dev.UserId.ToString())!;
        Assert.Equal("Submitted", S(row["status"]));
        Assert.Equal("Thursday off", S(row["note"]));
        Assert.Contains(queue["pending"]!.AsArray(), r => S(r!["id"]) == id);

        // Returning needs a reason; once returned the week is open again.
        Assert.Equal(422, (int)(await t.Manager.Post($"/api/v1/time/approvals/{id}/reject", new { note = " " })).Status);
        var returned = await t.Manager.Post($"/api/v1/time/approvals/{id}/reject", new { note = "Tuesday is missing its notes" });
        Assert.Equal("Rejected", S(returned.Data!["status"]));
        Assert.True((await Log(t.Dev, t.TaskId, 30, LastMonday.AddDays(2))).Ok);
        Assert.Contains((await t.Dev.Get("/api/v1/notifications")).Data!["items"]!.AsArray(), n => S(n!["type"]) == "Approval" && S(n["body"]).Contains("Tuesday is missing"));

        // Submitted again (the snapshot now includes the new 30 minutes) and approved; an approved week cannot be withdrawn.
        var again = await t.Dev.Post("/api/v1/time/week/submit", new { weekStart = Iso(LastMonday) });
        Assert.Equal(210, I(again.Data!["totalMinutes"]));
        var approved = await t.Manager.Post($"/api/v1/time/approvals/{id}/approve", new { note = "Thanks" });
        Assert.True(approved.Ok, approved.ToString());
        Assert.Equal("Approved", S(approved.Data!["status"]));
        Assert.Equal("Maya Manager", S(approved.Data!["reviewer"]!["name"]));
        Assert.Equal("TIMESHEET_NOT_PENDING", (await t.Dev.Post("/api/v1/time/week/withdraw", new { weekStart = Iso(LastMonday) })).ErrorCode);

        // Someone with access to everyone's reports (the Owner) can reopen an approved week.
        var reopened = await t.Owner.Post($"/api/v1/time/approvals/{id}/reject", new { note = "Client asked for a correction" });
        Assert.Equal("Rejected", S(reopened.Data!["status"]));
    }

    [Fact]
    public async Task A_pending_week_can_be_withdrawn_and_a_running_timer_blocks_submitting()
    {
        var t = await Setup();
        Assert.True((await t.Dev.Post($"/api/v1/tasks/{t.TaskId}/timer/start")).Ok);
        var monday = Today.AddDays(-(((int)Today.DayOfWeek + 6) % 7));
        Assert.Equal("TIMER_RUNNING", (await t.Dev.Post("/api/v1/time/week/submit", new { weekStart = Iso(monday) })).ErrorCode);
        Assert.True((await t.Dev.Post("/api/v1/timer/stop")).Ok);

        Assert.True((await t.Dev.Post("/api/v1/time/week/submit", new { weekStart = Iso(monday) })).Ok);
        // The timer cannot start inside a submitted week either.
        Assert.Equal("TIMESHEET_LOCKED", (await t.Dev.Post($"/api/v1/tasks/{t.TaskId}/timer/start")).ErrorCode);
        var withdrawn = await t.Dev.Post("/api/v1/time/week/withdraw", new { weekStart = Iso(monday) });
        Assert.Equal("NotSubmitted", S(withdrawn.Data!["status"]));
        Assert.True((await t.Dev.Post($"/api/v1/tasks/{t.TaskId}/timer/start")).Ok);
        Assert.True((await t.Dev.Post("/api/v1/timer/stop")).Ok);
    }

    [Fact]
    public async Task Approval_and_budgets_need_a_plan_that_includes_resource_management()
    {
        var owner = await TestClient.RegisterAsync(factory, "Free Owner");
        await owner.CreateOrgAsync();
        var project = await owner.CreateProjectAsync("Side Project");
        var week = (await owner.Get("/api/v1/time/week")).Data!;
        Assert.False(week["entitled"]!.GetValue<bool>());
        Assert.False(week["canSubmit"]!.GetValue<bool>());
        Assert.Equal(HttpStatusCode.Forbidden, (await owner.Post("/api/v1/time/week/submit", new { weekStart = Iso(LastMonday) })).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await owner.Put($"/api/v1/resources/projects/{project}/budget", new { isBillable = true, budgetHours = 5 })).Status);
        Assert.False((await owner.Get("/api/v1/resources/utilisation")).Data!["entitled"]!.GetValue<bool>());
    }

    // ------------------------------------------------------------------ capacity and cost

    [Fact]
    public async Task Rates_drive_utilisation_cost_and_the_project_budget()
    {
        var t = await Setup();
        Assert.True((await t.Owner.Put($"/api/v1/resources/projects/{t.Project}/budget", new { isBillable = true, budgetHours = 10, budgetAmount = 1000 })).Ok);
        var rates = await t.Owner.Put($"/api/v1/resources/rates/{t.Dev.UserId}", new { weeklyCapacityHours = 30, costRate = 20, billRate = 50 });
        Assert.True(rates.Ok, rates.ToString());
        var devRate = rates.Data!["members"]!.AsArray().Single(m => S(m!["userId"]) == t.Dev.UserId.ToString())!;
        Assert.Equal(30m, D(devRate["weeklyCapacityHours"]));
        Assert.False(devRate["standardCapacity"]!.GetValue<bool>());
        Assert.Equal(422, (int)(await t.Owner.Put($"/api/v1/resources/rates/{t.Dev.UserId}", new { weeklyCapacityHours = 200 })).Status);
        // Rates are for Owners and Admins only.
        Assert.Equal(HttpStatusCode.Forbidden, (await t.Manager.Get("/api/v1/resources/rates")).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await t.Dev.Put($"/api/v1/resources/rates/{t.Dev.UserId}", new { costRate = 1 })).Status);
        Assert.Equal("USD", S((await t.Owner.Put("/api/v1/resources/currency", new { currency = "usd" })).Data!["currency"]));

        Assert.True((await Log(t.Dev, t.TaskId, 120, LastMonday)).Ok);                     // billable
        Assert.True((await Log(t.Dev, t.TaskId, 60, LastMonday.AddDays(1), false)).Ok);    // not billable

        var util = (await t.Owner.Get($"/api/v1/resources/utilisation?scope=Everyone&from={Iso(LastMonday)}&to={Iso(LastMonday.AddDays(6))}")).Data!;
        Assert.True(util["showMoney"]!.GetValue<bool>());
        Assert.Equal(5, I(util["workingDays"]));
        var dev = util["people"]!.AsArray().Single(p => S(p!["userId"]) == t.Dev.UserId.ToString())!;
        Assert.Equal(30 * 60, I(dev["capacityMinutes"]));
        Assert.Equal(180, I(dev["loggedMinutes"]));
        Assert.Equal(120, I(dev["billableMinutes"]));
        Assert.Equal(0.1m, D(dev["utilisation"]));
        Assert.Equal(60m, D(dev["cost"]));              // 3 h x 20
        Assert.Equal(100m, D(dev["billableValue"]));    // 2 h x 50 (the project has no rate of its own)

        // The manager sees their line's hours but no money.
        var line = (await t.Manager.Get($"/api/v1/resources/utilisation?scope=Reports&from={Iso(LastMonday)}&to={Iso(LastMonday.AddDays(6))}")).Data!;
        Assert.False(line["showMoney"]!.GetValue<bool>());
        Assert.Null(line["people"]!.AsArray().Single()!["cost"]);
        Assert.Equal(HttpStatusCode.Forbidden, (await t.Dev.Get("/api/v1/resources/utilisation?scope=Everyone")).Status);

        // A project rate takes precedence over the person's own.
        Assert.True((await t.Owner.Put($"/api/v1/resources/projects/{t.Project}/budget", new { isBillable = true, budgetHours = 10, budgetAmount = 1000, billRate = 80 })).Ok);
        var money = (await t.Owner.Get($"/api/v1/resources/projects/{t.Project}")).Data!;
        Assert.Equal("USD", S(money["currency"]));
        Assert.Equal(180, I(money["loggedMinutes"]));
        Assert.Equal(60m, D(money["cost"]));
        Assert.Equal(160m, D(money["billableValue"]));  // 2 h x 80
        Assert.Equal(0.3m, D(money["hoursUsed"]));       // 3 of 10 hours
        Assert.Equal(0.06m, D(money["budgetUsed"]));     // 60 of 1,000
        Assert.True(money["canEdit"]!.GetValue<bool>());

        var managerView = (await t.Manager.Get($"/api/v1/resources/projects/{t.Project}")).Data!;
        Assert.False(managerView["showMoney"]!.GetValue<bool>());
        Assert.Null(managerView["cost"]);
        Assert.Null(managerView["budgetAmount"]);
        Assert.Equal(0.3m, D(managerView["hoursUsed"]));
        Assert.Equal(HttpStatusCode.Forbidden, (await t.Manager.Put($"/api/v1/resources/projects/{t.Project}/budget", new { isBillable = false })).Status);
    }

    // ------------------------------------------------------------------ service levels

    private static async Task<string> TypeId(TestClient c, string name) =>
        S((await c.Get("/api/v1/work-types?includeInactive=true")).Data!.AsArray().Single(t => S(t!["name"]) == name)!["id"]);

    private async Task<JsonNode> CreateWork(TestClient c, string title, string type, string priority, Guid? assignee = null)
    {
        var r = await c.Post("/api/v1/work-tasks", new { title, workTypeId = await TypeId(c, type), priority, assigneeId = assignee });
        Assert.True(r.Ok, r.ToString());
        return r.Data!;
    }

    private static DateTime At(JsonNode? n) => DateTime.Parse(S(n), null, System.Globalization.DateTimeStyles.RoundtripKind).ToUniversalTime();

    [Fact]
    public async Task Service_levels_fix_due_times_pause_on_hold_and_alert_once_when_missed()
    {
        var t = await Setup();
        var saved = await t.Owner.Put("/api/v1/work/sla", new
        {
            workTypeId = (Guid?)null,
            targets = new[] { new { priority = "High", responseMinutes = (int?)60, resolutionMinutes = (int?)240 }, new { priority = "Low", responseMinutes = (int?)null, resolutionMinutes = (int?)(3 * 24 * 60) } },
        });
        Assert.True(saved.Ok, saved.ToString());
        Assert.Equal(422, (int)(await t.Owner.Put("/api/v1/work/sla", new { targets = new[] { new { priority = "High", responseMinutes = 300, resolutionMinutes = 60 } } })).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await t.Dev.Put("/api/v1/work/sla", new { targets = Array.Empty<object>() })).Status);
        // Bug fixes get tighter targets of their own.
        var bug = await TypeId(t.Owner, "Bug Fix");
        Assert.True((await t.Owner.Put("/api/v1/work/sla", new { workTypeId = bug, targets = new[] { new { priority = "High", responseMinutes = 30, resolutionMinutes = 120 } } })).Ok);
        var settings = (await t.Dev.Get("/api/v1/work/sla")).Data!;
        Assert.Single(settings["overrides"]!.AsArray());

        var support = await CreateWork(t.Owner, "Printer queue stuck", "Production Support", "High", t.Dev.UserId);
        var created = At(support["createdAt"]);
        Assert.Equal(created.AddMinutes(60), At(support["sla"]!["response"]!["dueAt"]));
        Assert.Equal(created.AddMinutes(240), At(support["sla"]!["resolution"]!["dueAt"]));
        Assert.Equal("OnTrack", S(support["sla"]!["state"]));
        var fix = await CreateWork(t.Owner, "Totals are wrong", "Bug Fix", "High", t.Dev.UserId);
        Assert.Equal(At(fix["createdAt"]).AddMinutes(120), At(fix["sla"]!["resolution"]!["dueAt"]));
        Assert.Null((await CreateWork(t.Owner, "Nice to have", "Production Support", "Medium"))["sla"]);   // no target for Medium

        // A comment from the person who raised it is not a response; moving it on is.
        var id = S(support["id"]);
        Assert.True((await t.Owner.Post($"/api/v1/work-tasks/{id}/comments", new { body = "Any news?" })).Ok);
        Assert.Null((await t.Owner.Get($"/api/v1/work-tasks/{id}")).Data!["sla"]!["response"]!["metAt"]);
        var moved = await t.Dev.Put($"/api/v1/work-tasks/{id}/status", new { status = "InProgress" });
        Assert.Equal("Met", S(moved.Data!["sla"]!["response"]!["state"]));

        // On Hold stops the resolution clock; the time spent there is added back.
        Assert.Equal("Paused", S((await t.Dev.Put($"/api/v1/work-tasks/{id}/status", new { status = "OnHold" })).Data!["sla"]!["state"]));
        factory.WithDb(db =>
        {
            var w = db.WorkTasks.IgnoreQueryFilters().Single(x => x.Id == Guid.Parse(id));
            w.SlaPausedAt = DateTime.UtcNow.AddMinutes(-30);
            return db.SaveChanges();
        });
        var resumed = (await t.Dev.Put($"/api/v1/work-tasks/{id}/status", new { status = "InProgress" })).Data!;
        var shift = (At(resumed["sla"]!["resolution"]!["dueAt"]) - created.AddMinutes(240)).TotalMinutes;
        Assert.InRange(shift, 30, 32);

        // Missed: the monitor tells the assignee and the person who raised it, once.
        var fixId = Guid.Parse(S(fix["id"]));
        factory.WithDb(db =>
        {
            var w = db.WorkTasks.IgnoreQueryFilters().Single(x => x.Id == fixId);
            w.ResponseDueAt = DateTime.UtcNow.AddMinutes(-90); w.ResolutionRiskAt = DateTime.UtcNow.AddMinutes(-20); w.ResolutionDueAt = DateTime.UtcNow.AddMinutes(-1);
            return db.SaveChanges();
        });
        int Alerts(Guid user) => factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Count(n => n.UserId == user && n.Type == NotificationType.ServiceLevel && n.Link!.Contains(fixId.ToString())));
        async Task Monitor() { using var scope = factory.Services.CreateScope(); await scope.ServiceProvider.GetRequiredService<SlaMonitor>().RunAsync(); }
        await Monitor();
        Assert.Equal(2, Alerts(t.Dev.UserId));      // response missed, resolution missed (no "at risk" once it is late)
        Assert.Equal(2, Alerts(t.Owner.UserId));
        await Monitor();
        Assert.Equal(2, Alerts(t.Dev.UserId));

        var breached = (await t.Owner.Get("/api/v1/work-tasks?sla=breached")).Data!["items"]!.AsArray();
        Assert.Contains(breached, x => S(x!["id"]) == fixId.ToString());
        Assert.DoesNotContain(breached, x => S(x!["id"]) == id);
        Assert.Equal("Breached", S((await t.Owner.Get($"/api/v1/work-tasks/{fixId}")).Data!["sla"]!["state"]));

        // Finished late counts as missed in the summary.
        Assert.True((await t.Dev.Put($"/api/v1/work-tasks/{fixId}/status", new { status = "Completed" })).Ok);
        var summary = (await t.Owner.Get("/api/v1/work-tasks/summary")).Data!["sla"]!;
        Assert.Equal(1, I(summary["tracked"]));
        Assert.Equal(1, I(summary["missed"]));
        Assert.Equal(0m, D(summary["compliance"]));
    }

    [Fact]
    public async Task Without_service_levels_in_the_plan_no_targets_apply()
    {
        var owner = await TestClient.RegisterAsync(factory, "Pro Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("PRO");
        Assert.False((await owner.Get("/api/v1/work/sla")).Data!["entitled"]!.GetValue<bool>());
        Assert.Equal(HttpStatusCode.Forbidden, (await owner.Put("/api/v1/work/sla", new { targets = new[] { new { priority = "High", resolutionMinutes = 60 } } })).Status);
        Assert.Null((await CreateWork(owner, "Reset a password", "Production Support", "High"))["sla"]);
    }
}
