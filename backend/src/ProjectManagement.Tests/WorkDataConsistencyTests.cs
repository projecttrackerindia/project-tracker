using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// The work/reminder data audit: stale Done/Snooze, optimistic concurrency on every kind, issue due dates in every view, one reminder sync
/// per piece of work (delete, restore, due date, assignee, rename), numbering under load, atomic issue PATCH, "Raised by me",
/// completing follow-ups of an archived project, and the inbox briefing counting flags rather than words.
/// </summary>
[Collection("api")]
public class WorkDataConsistencyTests(ApiFactory factory)
{
    private static readonly NodaTime.DateTimeZone Kolkata = ZoneTime.Find("Asia/Kolkata");
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private static Guid G(JsonNode? n) => Guid.Parse(S(n));
    private static string Iso(int days) => AppDay.Today.AddDays(days).ToString("yyyy-MM-dd");
    private static string Local(DateTime utc) => ZoneTime.Write(ZoneTime.ToLocal(utc, Kolkata));
    private const string Items = "/api/v1/work-items";

    private sealed record World(TestClient Owner, TestClient Dev, Guid Project, string BugFix);

    private async Task<World> Setup()
    {
        var owner = await TestClient.RegisterAsync(factory, "Odette Ferris");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var dev = await owner.AddMemberAsync(factory, TenantRole.Member, "Devika Rao");
        var project = await owner.CreateProjectAsync("Harbor");
        Assert.True((await owner.Post($"/api/v1/projects/{project}/members", new { userId = dev.UserId })).Ok);
        var types = (await owner.Get("/api/v1/work-types?includeInactive=true")).Data!.AsArray();
        return new World(owner, dev, project, S(types.First(t => S(t!["name"]) == "Bug Fix")!["id"]));
    }

    private async Task Run(DateTime at)
    {
        using var scope = factory.Services.CreateScope();
        await scope.ServiceProvider.GetRequiredService<ReminderEngine>().RunAsync(at);
    }

    private static async Task<JsonNode> New(TestClient c, object body)
    {
        var r = await c.Post(Items, body);
        Assert.True(r.Status == HttpStatusCode.Created, r.ToString());
        return r.Data!;
    }

    private List<Reminder> RemindersOf(Guid target) => factory.WithDb(db => db.Reminders.IgnoreQueryFilters().AsNoTracking().Where(r => r.TargetId == target).ToList());

    // ------------------------------------------------------------------ P1-1 double Done / stale Snooze

    [Fact]
    public async Task A_second_Done_on_the_same_occurrence_is_refused_instead_of_skipping_the_next_one()
    {
        var w = await Setup();
        var first = DateTime.UtcNow.AddMinutes(30);
        var made = await w.Owner.Post("/api/v1/reminders", new { title = "Stand-up notes", when = new { at = Local(first), timeZone = "Asia/Kolkata", recurrence = "FREQ=DAILY" } });
        Assert.True(made.Ok, made.ToString());
        var id = S(made.Data!["id"]);
        await Run(first.AddMinutes(1));
        var fired = (await w.Owner.Get("/api/v1/reminders")).Data!["open"]!.AsArray().Single(r => S(r!["id"]) == id)!;
        Assert.Equal("Fired", S(fired["state"]));
        var seen = new { expectedNextFireAt = fired["nextFireAt"]?.GetValue<string>(), expectedLastFiredAt = fired["lastFiredAt"]?.GetValue<string>(), expect = true };

        var done = await w.Owner.Post($"/api/v1/reminders/{id}/done", seen);
        Assert.True(done.Ok, done.ToString());
        var series = (await w.Owner.Get("/api/v1/reminders")).Data!["open"]!.AsArray().Single(r => S(r!["id"]) == id)!;
        var nextAfterFirstDone = S(series["nextFireAt"]);

        // The double tap: same occurrence again -> 409, and the series still waits for tomorrow's occurrence.
        var again = await w.Owner.Post($"/api/v1/reminders/{id}/done", seen);
        Assert.Equal(HttpStatusCode.Conflict, again.Status);
        Assert.Contains("REMINDER_STALE", again.ToString());
        var after = (await w.Owner.Get("/api/v1/reminders")).Data!["open"]!.AsArray().Single(r => S(r!["id"]) == id)!;
        Assert.Equal(nextAfterFirstDone, S(after["nextFireAt"]));
        Assert.Equal(1, (await w.Owner.Get("/api/v1/reminders")).Data!["completed"]!.AsArray().Count(r => r!["seriesId"]?.GetValue<string>() == id));

        // A stale snooze is refused the same way; one with the current occurrence works.
        Assert.Equal(HttpStatusCode.Conflict, (await w.Owner.Post($"/api/v1/reminders/{id}/snooze", new { preset = "1h", seen.expectedNextFireAt, seen.expectedLastFiredAt, expect = true })).Status);
        var ok = await w.Owner.Post($"/api/v1/reminders/{id}/snooze", new { preset = "1h", expectedNextFireAt = S(after["nextFireAt"]), expectedLastFiredAt = after["lastFiredAt"]?.GetValue<string>(), expect = true });
        Assert.True(ok.Ok, ok.ToString());
        // Without an expectation (e-mail links, older apps) Done still works.
        Assert.True((await w.Owner.Post($"/api/v1/reminders/{id}/done")).Ok);
    }

    // ------------------------------------------------------------------ P1-2 optimistic concurrency

    [Fact]
    public async Task Every_kind_refuses_a_change_made_on_a_version_someone_has_since_changed()
    {
        var w = await Setup();
        var task = await New(w.Owner, new { kind = "task", projectId = w.Project, title = "Wire refunds" });
        var ticket = await New(w.Owner, new { kind = "ticket", workTypeId = w.BugFix, title = "Printer jam" });
        var action = await New(w.Owner, new { kind = "action", projectId = w.Project, title = "Collect sign-off" });
        var issue = await New(w.Owner, new { kind = "issue", projectId = w.Project, title = "Total off by one" });

        foreach (var item in new[] { task, ticket, action, issue })
        {
            var id = S(item["id"]); var v = item["version"]!.GetValue<int>();
            var first = await w.Owner.Patch($"{Items}/{id}", new { version = v, title = $"{S(item["title"])} (edited)" });
            Assert.True(first.Ok, first.ToString());
            var stale = await w.Owner.Patch($"{Items}/{id}", new { version = v, title = "Lost update" });
            Assert.Equal(HttpStatusCode.Conflict, stale.Status);
            Assert.EndsWith("(edited)", S((await w.Owner.Get($"{Items}/{id}")).Data!["title"]));
        }

        // The kinds' own status endpoints take the version too.
        var t = (await w.Owner.Get($"{Items}/{S(task["id"])}")).Data!;
        var statuses = (await w.Owner.Get($"/api/v1/projects/{w.Project}")).Data!["statuses"]!.AsArray();
        var doneCol = S(statuses.First(s => S(s!["category"]) == "Done")!["id"]);
        Assert.Equal(HttpStatusCode.Conflict, (await w.Owner.Patch($"/api/v1/tasks/{S(task["id"])}/move", new { statusId = doneCol, version = t["version"]!.GetValue<int>() - 1 })).Status);
        Assert.True((await w.Owner.Patch($"/api/v1/tasks/{S(task["id"])}/move", new { statusId = doneCol, version = t["version"]!.GetValue<int>() })).Ok);
        var wt = (await w.Owner.Get($"{Items}/{S(ticket["id"])}")).Data!;
        Assert.Equal(HttpStatusCode.Conflict, (await w.Owner.Put($"/api/v1/work-tasks/{S(ticket["id"])}/status", new { status = "Completed", version = wt["version"]!.GetValue<int>() - 1 })).Status);
        Assert.True((await w.Owner.Put($"/api/v1/work-tasks/{S(ticket["id"])}/status", new { status = "Completed", version = wt["version"]!.GetValue<int>() })).Ok);

        // The list rows carry the version, so My Work never re-reads an item before changing it.
        var rows = (await w.Owner.Get($"{Items}?status=all")).Data!["items"]!.AsArray();
        Assert.All(rows, r => Assert.True(r!["version"]!.GetValue<int>() >= 1));
    }

    [Fact]
    public async Task An_issue_patch_on_a_stale_version_changes_nothing_at_all()
    {
        var w = await Setup();
        var issue = await New(w.Owner, new { kind = "issue", projectId = w.Project, title = "Rounding error" });
        var id = S(issue["id"]); var v = issue["version"]!.GetValue<int>();
        Assert.True((await w.Owner.Patch($"{Items}/{id}", new { version = v, priority = "High" })).Ok);
        // Stale: title, assignee and due date all refused together - none of them applied.
        var stale = await w.Owner.Patch($"{Items}/{id}", new { version = v, title = "Half applied?", assigneeId = w.Dev.UserId, dueDate = Iso(3) });
        Assert.Equal(HttpStatusCode.Conflict, stale.Status);
        var now = (await w.Owner.Get($"{Items}/{id}")).Data!;
        Assert.Equal("Rounding error", S(now["title"]));
        Assert.Null(now["assignee"]);
        Assert.Null(now["dueDate"]);
        Assert.Equal(v + 1, now["version"]!.GetValue<int>());
    }

    // ------------------------------------------------------------------ P1-3 issue due dates

    [Fact]
    public async Task An_issue_due_date_shows_in_my_work_overdue_filters_the_calendar_and_gets_automatic_reminders()
    {
        var w = await Setup();
        var issue = await New(w.Owner, new { kind = "issue", projectId = w.Project, title = "Login loop on Safari", assigneeId = w.Dev.UserId });
        var id = S(issue["id"]);
        Assert.True((await w.Owner.Patch($"{Items}/{id}", new { version = issue["version"]!.GetValue<int>(), dueDate = Iso(-2) })).Ok);

        var mine = (await w.Dev.Get($"{Items}?mine=true")).Data!["items"]!.AsArray().Single(r => S(r!["id"]) == id)!;
        Assert.Equal(Iso(-2), S(mine["dueDate"]));
        Assert.True(mine["isOverdue"]!.GetValue<bool>());
        Assert.Contains((await w.Dev.Get($"{Items}?mine=true&overdue=true")).Data!["items"]!.AsArray(), r => S(r!["id"]) == id);
        var cal = (await w.Dev.Get($"/api/v1/calendar?from={Iso(-5)}&to={Iso(5)}&mine=true")).Data!.AsArray();
        Assert.Contains(cal, e => S(e!["type"]) == "issue" && S(e["id"]) == id);

        // Due in a few days: the planner gives the assignee the same automatic reminder as any other work.
        var v = (await w.Owner.Get($"{Items}/{id}")).Data!["version"]!.GetValue<int>();
        Assert.True((await w.Owner.Patch($"{Items}/{id}", new { version = v, dueDate = Iso(5) })).Ok);
        await Run(DateTime.UtcNow);
        var auto = RemindersOf(Guid.Parse(id)).Where(r => r.Source == ReminderSource.DueDate).ToList();
        var one = Assert.Single(auto);
        Assert.Equal(ReminderTarget.Issue, one.TargetType);
        Assert.Equal(w.Dev.UserId, one.UserId);
        Assert.Contains("tab=issues", one.Link);
    }

    // ------------------------------------------------------------------ P2-7..11 one reminder sync

    [Fact]
    public async Task Reminders_follow_their_work_through_rename_reassignment_due_date_changes_delete_and_restore()
    {
        var w = await Setup();
        var ticket = await New(w.Owner, new { kind = "ticket", workTypeId = w.BugFix, title = "VPN drops", assigneeId = w.Dev.UserId, dueDate = Iso(5) });
        var id = Guid.Parse(S(ticket["id"]));

        // A personal reminder counted from the due date, and one at a fixed time.
        var anchored = await w.Dev.Post("/api/v1/reminders", new { targetType = "Operational", targetId = id, when = new { anchorDays = -1, anchorTime = "09:00", timeZone = "Asia/Kolkata" } });
        Assert.True(anchored.Ok, anchored.ToString());
        var fixedAt = await w.Dev.Post("/api/v1/reminders", new { title = "Ping vendor", targetType = "Operational", targetId = id, when = new { at = Local(DateTime.UtcNow.AddDays(2)), timeZone = "Asia/Kolkata" } });
        Assert.True(fixedAt.Ok, fixedAt.ToString());
        await Run(DateTime.UtcNow);
        Assert.Single(RemindersOf(id), r => r.Source == ReminderSource.DueDate && r.State == ReminderState.Scheduled);

        async Task<int> Ver() => (await w.Owner.Get($"{Items}/{id}")).Data!["version"]!.GetValue<int>();

        // Rename: every reminder shows the new title at once.
        Assert.True((await w.Owner.Patch($"{Items}/{id}", new { version = await Ver(), title = "VPN drops every hour" })).Ok);
        Assert.All(RemindersOf(id), r => Assert.Equal("VPN drops every hour", r.TargetTitle));

        // Due date moved: the anchored one moves; the automatic one planned for the old date is withdrawn.
        Assert.True((await w.Owner.Patch($"{Items}/{id}", new { version = await Ver(), dueDate = Iso(6) })).Ok);
        Assert.DoesNotContain(RemindersOf(id), r => r.Source == ReminderSource.DueDate && r.SystemKey!.EndsWith(AppDay.Today.AddDays(5).ToString("yyyyMMdd")));
        var moved = RemindersOf(id).Single(r => r.AnchorDays == -1);
        Assert.Equal(ReminderService.AnchoredFire(moved, AppDay.Today.AddDays(6)), moved.NextFireAt);

        // Due date cleared: the anchored reminder pauses and the person is told; a new date brings it back.
        Assert.True((await w.Owner.Patch($"{Items}/{id}", new { version = await Ver(), dueDate = (string?)null })).Ok);
        var paused = RemindersOf(id).Single(r => r.AnchorDays == -1);
        Assert.True(ReminderSync.IsDuePaused(paused));
        Assert.Contains(factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Where(n => n.UserId == w.Dev.UserId).Select(n => n.Title).ToList()), t => t.StartsWith("Reminder paused"));
        Assert.True((await w.Owner.Patch($"{Items}/{id}", new { version = await Ver(), dueDate = Iso(8) })).Ok);
        var back = RemindersOf(id).Single(r => r.AnchorDays == -1);
        Assert.Equal(ReminderState.Scheduled, back.State);
        Assert.Equal(ReminderService.AnchoredFire(back, AppDay.Today.AddDays(8)), back.NextFireAt);

        // Reassigned: an automatic reminder for the old assignee that already went off is closed.
        Assert.True((await w.Owner.Patch($"{Items}/{id}", new { version = await Ver(), dueDate = Iso(2) })).Ok);
        await Run(DateTime.UtcNow);
        factory.WithDb(db => { foreach (var r in db.Reminders.IgnoreQueryFilters().Where(r => r.TargetId == id && r.Source == ReminderSource.DueDate)) { r.State = ReminderState.Fired; r.LastFiredAt = DateTime.UtcNow; } db.SaveChanges(); return 0; });
        Assert.True((await w.Owner.Patch($"{Items}/{id}", new { version = await Ver(), assigneeId = w.Owner.UserId })).Ok);
        Assert.DoesNotContain(RemindersOf(id), r => r.Source == ReminderSource.DueDate && r.UserId == w.Dev.UserId && r.State is ReminderState.Fired or ReminderState.Scheduled);

        // Deleted: the personal reminders are orphaned (not open, not lost)...
        Assert.True((await w.Owner.Delete($"{Items}/{id}")).Status is HttpStatusCode.NoContent or HttpStatusCode.OK);
        var orphaned = RemindersOf(id).Where(r => r.Source == ReminderSource.Personal).ToList();
        Assert.NotEmpty(orphaned);
        Assert.All(orphaned, r => Assert.True(ReminderSync.IsOrphaned(r)));
        Assert.DoesNotContain((await w.Dev.Get("/api/v1/reminders")).Data!["open"]!.AsArray(), r => r!["targetId"]?.GetValue<string>() == id.ToString());

        // ...and a restore (Undo, through the ticket service itself) brings them back.
        using (var scope = factory.Services.CreateScope())
        {
            var ctx = scope.ServiceProvider.GetRequiredService<ProjectManagement.Application.Abstractions.CurrentContext>();
            ctx.UserId = w.Owner.UserId; ctx.TenantId = w.Owner.WorkspaceId; ctx.Role = TenantRole.Owner;
            await scope.ServiceProvider.GetRequiredService<ProjectManagement.Application.Features.Work.WorkTaskService>().RestoreAsync(id);
        }
        Assert.Contains((await w.Dev.Get("/api/v1/reminders")).Data!["open"]!.AsArray(), r => S(r!["title"]) == "Ping vendor");
    }

    [Fact]
    public async Task Finishing_work_finishes_its_open_only_reminders_at_once_not_at_the_next_planner_pass()
    {
        var w = await Setup();
        var action = await New(w.Owner, new { kind = "action", projectId = w.Project, title = "Send minutes", assigneeId = w.Dev.UserId, dueDate = Iso(4) });
        var id = Guid.Parse(S(action["id"]));
        Assert.True((await w.Dev.Post("/api/v1/reminders", new { targetType = "ActionItem", targetId = id, when = new { at = Local(DateTime.UtcNow.AddDays(1)), timeZone = "Asia/Kolkata" } })).Ok);
        Assert.True((await w.Dev.Put($"/api/v1/projects/{w.Project}/action-items/{id}/status", new { status = "Completed" })).Ok);
        Assert.All(RemindersOf(id).Where(r => r.Source == ReminderSource.Personal), r => Assert.Equal(ReminderState.Done, r.State));
    }

    // ------------------------------------------------------------------ P2-13 numbering

    [Fact]
    public async Task Tickets_raised_at_the_same_moment_get_different_numbers()
    {
        var w = await Setup();
        // A taken number is recognised from either database, so the save retries with the next one (SaveNewAsync) instead of failing.
        var sqlite = new DbUpdateException("save", new Exception("SQLite Error 19: 'UNIQUE constraint failed: WorkItems.TenantId, WorkItems.Number'."));
        Assert.True(ProjectManagement.Application.Common.DbErrors.IsWorkNumberTaken(sqlite));
        Assert.False(ProjectManagement.Application.Common.DbErrors.IsWorkNumberTaken(new DbUpdateException("save", new Exception("UNIQUE constraint failed: WorkItems.ProjectId, WorkItems.Number"))));
        // Tickets and action items share the running number and never collide.
        var made = new List<ApiResult>();
        for (var i = 1; i <= 3; i++) made.Add(await w.Owner.Post(Items, new { kind = i % 2 == 0 ? "action" : "ticket", workTypeId = w.BugFix, projectId = w.Project, title = $"Burst {i}" }));
        Assert.All(made, r => Assert.Equal(HttpStatusCode.Created, r.Status));
        Assert.Equal(3, made.Select(r => r.Data!["key"]!.GetValue<string>().Split('-')[1]).Distinct().Count());
    }

    // ------------------------------------------------------------------ P2-20 raised by me

    [Fact]
    public async Task Raised_by_me_lists_what_I_reported_whoever_it_is_assigned_to()
    {
        var w = await Setup();
        await New(w.Owner, new { kind = "ticket", workTypeId = w.BugFix, title = "Mine for Devika", assigneeId = w.Dev.UserId });
        await New(w.Dev, new { kind = "task", projectId = w.Project, title = "Devika's own", assigneeId = w.Owner.UserId });
        var raised = (await w.Owner.Get($"{Items}?raisedByMe=true")).Data!["items"]!.AsArray();
        Assert.Contains(raised, r => S(r!["title"]) == "Mine for Devika");
        Assert.DoesNotContain(raised, r => S(r!["title"]) == "Devika's own");
        Assert.All(raised, r => Assert.Equal(w.Owner.UserId.ToString(), S(r!["reporterId"])));
    }

    // ------------------------------------------------------------------ P2-21 archived projects

    [Fact]
    public async Task An_archived_projects_action_items_can_be_completed_but_not_edited_or_reopened()
    {
        var w = await Setup();
        var made = await w.Owner.Post($"/api/v1/projects/{w.Project}/action-items", new { title = "Return the badges", assigneeId = w.Dev.UserId });
        var id = S(made.Data!["id"]);
        Assert.True((await w.Owner.Send(HttpMethod.Patch, $"/api/v1/projects/{w.Project}/move", new { status = "Archived" })).Ok);
        var row = (await w.Dev.Get($"/api/v1/projects/{w.Project}/action-items")).Data!.AsArray().Single(r => S(r!["id"]) == id)!;
        Assert.True(row["can"]!["complete"]!.GetValue<bool>());
        Assert.False(row["can"]!["edit"]!.GetValue<bool>());
        Assert.True((await w.Dev.Put($"/api/v1/projects/{w.Project}/action-items/{id}/status", new { status = "Completed" })).Ok);
        Assert.Equal(HttpStatusCode.Conflict, (await w.Dev.Put($"/api/v1/projects/{w.Project}/action-items/{id}/status", new { status = "Open" })).Status);
        Assert.Equal(HttpStatusCode.Conflict, (await w.Dev.Put($"/api/v1/projects/{w.Project}/action-items/{id}", new { title = "Edited", priority = "Low", status = "Completed" })).Status);
    }

    // ------------------------------------------------------------------ P3-25 briefing flags

    [Fact]
    public async Task The_briefing_counts_overdue_and_due_today_from_flags_not_from_the_words_of_a_row()
    {
        var w = await Setup();
        await New(w.Owner, new { kind = "task", projectId = w.Project, title = "Late one", assigneeId = w.Owner.UserId, dueDate = Iso(-1) });
        await New(w.Owner, new { kind = "task", projectId = w.Project, title = "Today one", assigneeId = w.Owner.UserId, dueDate = Iso(0) });
        // A critical ticket with no date whose title says "overdue": urgent, but neither overdue nor due today.
        await New(w.Owner, new { kind = "ticket", workTypeId = w.BugFix, title = "Customer says invoice overdue due today", priority = "Critical", assigneeId = w.Owner.UserId });
        var rows = (await w.Owner.Get("/api/v1/inbox")).Data!["rows"]!.AsArray();
        Assert.Contains(rows, r => r!["overdue"]!.GetValue<bool>());
        var stats = (await w.Owner.Get("/api/v1/inbox/briefing")).Data!["stats"]!;
        Assert.Equal(1, stats["overdue"]!.GetValue<int>());
        Assert.Equal(1, stats["dueToday"]!.GetValue<int>());
    }

    // ------------------------------------------------------------------ the sync rules, without a database

    [Fact]
    public void The_sync_rules_orphan_on_delete_revive_on_restore_and_pause_without_a_due_date()
    {
        var now = new DateTime(2026, 11, 2, 6, 0, 0, DateTimeKind.Utc);
        var personal = new Reminder { Source = ReminderSource.Personal, State = ReminderState.Scheduled, NextFireAt = now.AddDays(1), OnlyIfOpen = true, TimeZone = "Asia/Kolkata" };
        var anchored = new Reminder { Source = ReminderSource.Personal, State = ReminderState.Scheduled, NextFireAt = now.AddDays(2), AnchorDays = 0, AnchorTime = new TimeOnly(9, 0), TimeZone = "Asia/Kolkata" };
        ReminderSync.Apply(null!, [personal, anchored], null, null, now, out _);
        Assert.True(ReminderSync.IsOrphaned(personal));
        Assert.True(ReminderSync.IsOrphaned(anchored));

        var display = new ReminderSync.Display("HRB-3", "Renamed", null, "/projects/x?task=y");
        ReminderSync.Apply(null!, [personal, anchored], new TargetState(true, null, null, null), display, now, out var paused);
        Assert.Equal(ReminderState.Scheduled, personal.State);
        Assert.Equal("Renamed", personal.TargetTitle);
        Assert.True(ReminderSync.IsDuePaused(anchored));
        Assert.Same(anchored, Assert.Single(paused));

        var due = new DateOnly(2026, 11, 6);
        ReminderSync.Apply(null!, [anchored], new TargetState(true, due, null, null), display, now, out _);
        Assert.Equal(ReminderState.Scheduled, anchored.State);
        Assert.Equal(ReminderService.AnchoredFire(anchored, due), anchored.NextFireAt);
    }
}
