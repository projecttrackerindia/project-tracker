using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Time;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Infrastructure.Persistence;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>The week grid (typing totals into cells), copying last week, bulk approval, insights and timesheet reminders.</summary>
[Collection("api")]
public class TimesheetGridTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private static int I(JsonNode? n) => n!.GetValue<int>();
    private static DateOnly Today => AppDay.Today;
    private static DateOnly ThisMonday => Today.AddDays(-(((int)Today.DayOfWeek + 6) % 7));
    private static DateOnly LastMonday => ThisMonday.AddDays(-7);
    private static string Iso(DateOnly d) => d.ToString("yyyy-MM-dd");

    private sealed record Team(TestClient Owner, TestClient Manager, TestClient Dev, TestClient Peer, Guid Project, string TaskId, string OtherTaskId);

    private async Task<Team> Setup()
    {
        var owner = await TestClient.RegisterAsync(factory, "Olivia Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var manager = await owner.AddMemberAsync(factory, TenantRole.Manager, "Maya Manager");
        var dev = await owner.AddMemberAsync(factory, TenantRole.Member, "Dev Developer");
        var peer = await owner.AddMemberAsync(factory, TenantRole.Member, "Pat Peer");
        Assert.True((await owner.Put($"/api/v1/org/members/{dev.UserId}/reports-to", new { reportsToUserId = manager.UserId })).Ok);
        Assert.True((await owner.Put($"/api/v1/org/members/{peer.UserId}/reports-to", new { reportsToUserId = manager.UserId })).Ok);
        var project = await owner.CreateProjectAsync("Client Portal");
        var task = await owner.CreateTaskAsync(project, "Build the login page", new { title = "Build the login page", priority = "Medium", assigneeId = dev.UserId });
        var other = await owner.CreateTaskAsync(project, "Write the API docs", new { title = "Write the API docs", priority = "Medium", assigneeId = dev.UserId });
        return new Team(owner, manager, dev, peer, project, S(task["id"]), S(other["id"]));
    }

    private static Task<ApiResult> Save(TestClient c, DateOnly week, params object[] cells) => c.Put("/api/v1/time/grid", new { weekStart = Iso(week), cells });
    private static object Cell(string taskId, DateOnly date, int minutes, string? note = null) => new { kind = "task", targetId = taskId, date = Iso(date), minutes, note };
    private static JsonNode? Row(JsonNode grid, string taskId) => grid["rows"]!.AsArray().FirstOrDefault(r => S(r!["targetId"]) == taskId);
    private static int CellMinutes(JsonNode grid, string taskId, DateOnly date) =>
        Row(grid, taskId) is { } row ? I(row["cells"]!.AsArray().First(c => S(c!["date"]) == Iso(date))!["minutes"]) : 0;

    [Fact]
    public async Task Typing_totals_into_the_grid_logs_changes_and_removes_time()
    {
        var t = await Setup();
        // Before anything is logged, the person's assigned work is suggested and the week shows their normal day.
        var empty = (await t.Dev.Get($"/api/v1/time/grid?weekStart={Iso(LastMonday)}")).Data!;
        Assert.True(empty["editable"]!.GetValue<bool>());
        Assert.Equal(7, empty["days"]!.AsArray().Count);
        Assert.Equal(480, I(empty["days"]![0]!["targetMinutes"]));          // 40 h over five days
        Assert.Equal(0, I(empty["days"]![5]!["targetMinutes"]));            // Saturday
        Assert.Equal(5 * 480, I(empty["targetMinutes"]));
        Assert.Equal(5, I(empty["missingDays"]));
        Assert.Contains(empty["suggestions"]!.AsArray(), s => S(s!["targetId"]) == t.TaskId && S(s["reason"]) == "assigned");

        // A new cell logs an entry; a changed total changes it; the week's totals follow.
        var saved = await Save(t.Dev, LastMonday, Cell(t.TaskId, LastMonday, 90, "Login form"), Cell(t.OtherTaskId, LastMonday.AddDays(1), 30));
        Assert.True(saved.Ok, saved.ToString());
        Assert.Equal(2, I(saved.Data!["saved"]));
        var grid = saved.Data!["grid"]!;
        Assert.Equal(90, CellMinutes(grid, t.TaskId, LastMonday));
        Assert.Equal(120, I(grid["totalMinutes"]));
        Assert.DoesNotContain(grid["suggestions"]!.AsArray(), s => S(s!["targetId"]) == t.TaskId);   // it has a row now
        Assert.Equal(3, I(grid["missingDays"]));

        grid = (await Save(t.Dev, LastMonday, Cell(t.TaskId, LastMonday, 150))).Data!["grid"]!;
        Assert.Equal(150, CellMinutes(grid, t.TaskId, LastMonday));
        Assert.Equal("Login form", S(Row(grid, t.TaskId)!["cells"]![0]!["note"]));                    // the note survives a new total
        var task = (await t.Dev.Get($"/api/v1/tasks/{t.TaskId}/time")).Data!;
        Assert.Single(task["entries"]!.AsArray());
        Assert.Equal(150, I(task["totalMinutes"]));

        // Several entries in one cell shrink from the newest; zero removes the time.
        Assert.True((await t.Dev.Post($"/api/v1/tasks/{t.TaskId}/time", new { minutes = 60, workDate = Iso(LastMonday), note = "Review" })).Ok);
        grid = (await Save(t.Dev, LastMonday, Cell(t.TaskId, LastMonday, 180))).Data!["grid"]!;
        Assert.Equal(180, CellMinutes(grid, t.TaskId, LastMonday));
        var minutes = (await t.Dev.Get($"/api/v1/tasks/{t.TaskId}/time")).Data!["entries"]!.AsArray().Select(e => I(e!["minutes"])).OrderBy(x => x).ToList();
        Assert.Equal([30, 150], minutes);
        grid = (await Save(t.Dev, LastMonday, Cell(t.OtherTaskId, LastMonday.AddDays(1), 0))).Data!["grid"]!;
        Assert.Null(Row(grid, t.OtherTaskId));

        // Cells that cannot be saved come back with the reason; the others are kept.
        var mixed = await Save(t.Dev, LastMonday, Cell(t.TaskId, LastMonday.AddDays(2), 60), Cell(t.TaskId, ThisMonday, 60), Cell(t.TaskId, LastMonday.AddDays(3), 25 * 60));
        Assert.True(mixed.Ok, mixed.ToString());
        Assert.Equal(1, I(mixed.Data!["saved"]));
        Assert.Equal(2, mixed.Data!["errors"]!.AsArray().Count);
        if (Today.DayOfWeek != DayOfWeek.Sunday)
        {
            var future = await Save(t.Dev, ThisMonday, Cell(t.TaskId, Today.AddDays(1), 60));
            Assert.Contains("future", S(future.Data!["errors"]![0]!["message"]));
        }

        // Their manager sees the week read-only; and someone outside the line cannot see it.
        var asManager = (await t.Manager.Get($"/api/v1/time/grid?weekStart={Iso(LastMonday)}&userId={t.Dev.UserId}")).Data!;
        Assert.False(asManager["editable"]!.GetValue<bool>());
        Assert.Empty(asManager["suggestions"]!.AsArray());
        Assert.Equal(240, I(asManager["totalMinutes"]));
        Assert.Equal(HttpStatusCode.Forbidden, (await t.Peer.Get($"/api/v1/time/grid?weekStart={Iso(LastMonday)}&userId={t.Dev.UserId}")).Status);

        // A submitted week is locked in the grid too.
        Assert.True((await t.Dev.Post("/api/v1/time/week/submit", new { weekStart = Iso(LastMonday) })).Ok);
        var locked = await Save(t.Dev, LastMonday, Cell(t.TaskId, LastMonday, 60));
        Assert.Equal(0, I(locked.Data!["saved"]));
        Assert.False(locked.Data!["grid"]!["editable"]!.GetValue<bool>());
        Assert.Equal(180, CellMinutes(locked.Data!["grid"]!, t.TaskId, LastMonday));
    }

    [Fact]
    public async Task Copying_last_week_fills_only_empty_past_working_days()
    {
        var t = await Setup();
        var before = LastMonday.AddDays(-7);
        Assert.True((await Save(t.Dev, before, Cell(t.TaskId, before, 120), Cell(t.TaskId, before.AddDays(1), 60), Cell(t.OtherTaskId, before.AddDays(5), 45))).Ok);
        Assert.True((await Save(t.Dev, LastMonday, Cell(t.TaskId, LastMonday, 30))).Ok);
        var copied = await t.Dev.Post("/api/v1/time/grid/copy-previous", new { weekStart = Iso(LastMonday) });
        Assert.True(copied.Ok, copied.ToString());
        var grid = copied.Data!["grid"]!;
        Assert.Equal(30, CellMinutes(grid, t.TaskId, LastMonday));                 // already logged: not overwritten
        Assert.Equal(60, CellMinutes(grid, t.TaskId, LastMonday.AddDays(1)));      // copied
        Assert.Equal(0, CellMinutes(grid, t.OtherTaskId, LastMonday.AddDays(5)));  // Saturday: left alone
        Assert.Equal(1, I(copied.Data!["saved"]));
    }

    [Fact]
    public async Task Drafting_the_week_shares_the_free_day_across_what_was_worked_on_and_saves_nothing()
    {
        var t = await Setup();
        // Last Monday: three changes on the login page and one on the docs; last Tuesday: nothing; last Wednesday: already logged.
        var monday = DateTime.SpecifyKind(LastMonday.ToDateTime(new TimeOnly(11, 0)).AddMinutes(-AppDay.OffsetMinutes), DateTimeKind.Utc);   // 11:00 local
        factory.WithDb(db =>
        {
            void Act(string id, int minutes) => db.Activities.Add(new Activity { Id = Guid.NewGuid(), TenantId = t.Owner.WorkspaceId, ActorId = t.Dev.UserId, ProjectId = t.Project,
                Action = "task.updated", EntityType = "Task", EntityId = Guid.Parse(id), Summary = "changed", CreatedAt = monday.AddMinutes(minutes) });
            Act(t.TaskId, 0); Act(t.TaskId, 30); Act(t.TaskId, 60); Act(t.OtherTaskId, 90);
            db.Activities.Add(new Activity { Id = Guid.NewGuid(), TenantId = t.Owner.WorkspaceId, ActorId = t.Dev.UserId, ProjectId = t.Project,
                Action = "task.updated", EntityType = "Task", EntityId = Guid.Parse(t.TaskId), Summary = "changed", CreatedAt = monday.AddDays(2) });
            return db.SaveChanges();
        });
        Assert.True((await Save(t.Dev, LastMonday, Cell(t.OtherTaskId, LastMonday.AddDays(2), 60))).Ok);

        var draft = await t.Dev.Get($"/api/v1/time/grid/draft?weekStart={Iso(LastMonday)}");
        Assert.True(draft.Ok, draft.ToString());
        var cells = draft.Data!["cells"]!.AsArray();
        int Minutes(string id, DateOnly d) => cells.Where(c => S(c!["targetId"]) == id && S(c["date"]) == Iso(d)).Sum(c => I(c!["minutes"]));
        Assert.Equal(360, Minutes(t.TaskId, LastMonday));        // 8 h shared 3 : 1
        Assert.Equal(120, Minutes(t.OtherTaskId, LastMonday));
        Assert.Contains("3 changes or comments", S(cells.First(c => S(c!["targetId"]) == t.TaskId)!["why"]));
        var days = draft.Data!["days"]!.AsArray();
        Assert.Equal("No changes or comments that day", S(days[1]!["skipped"]));
        Assert.Equal("Already logged", S(days[2]!["skipped"]));
        Assert.Equal("Weekend", S(days[5]!["skipped"]));
        Assert.DoesNotContain(cells, c => S(c!["date"]) == Iso(LastMonday.AddDays(2)));

        // Nothing was saved: the week still has only the hour typed in by hand.
        var grid = (await t.Dev.Get($"/api/v1/time/grid?weekStart={Iso(LastMonday)}")).Data!;
        Assert.Equal(60, I(grid["totalMinutes"]));
        // Someone else's week cannot be drafted from here: it is always the caller's own.
        Assert.Equal(0, (await t.Peer.Get($"/api/v1/time/grid/draft?weekStart={Iso(LastMonday)}")).Data!["cells"]!.AsArray().Count);
    }

    [Fact]
    public void Quarter_hours_are_shared_so_the_parts_add_up()
    {
        Assert.Equal(new[] { 360, 120 }, TimesheetGridService.SplitQuarterHours(480, new[] { 3, 1 }));
        Assert.Equal(new[] { 165, 150, 150 }, TimesheetGridService.SplitQuarterHours(465, new[] { 1, 1, 1 }));
        Assert.Equal(new[] { 0, 0 }, TimesheetGridService.SplitQuarterHours(10, new[] { 1, 1 }));
    }

    [Fact]
    public async Task Several_weeks_are_approved_at_once_and_insights_follow_the_time()
    {
        var t = await Setup();
        Assert.True((await Save(t.Dev, LastMonday, Cell(t.TaskId, LastMonday, 600), Cell(t.TaskId, LastMonday.AddDays(1), 240))).Ok);
        var peerTask = S((await t.Owner.CreateTaskAsync(t.Project, "Peer work", new { title = "Peer work", priority = "Medium", assigneeId = t.Peer.UserId }))["id"]);
        Assert.True((await Save(t.Peer, LastMonday, Cell(peerTask, LastMonday, 120))).Ok);
        var a = S((await t.Dev.Post("/api/v1/time/week/submit", new { weekStart = Iso(LastMonday) })).Data!["id"]);
        var b = S((await t.Peer.Post("/api/v1/time/week/submit", new { weekStart = Iso(LastMonday) })).Data!["id"]);

        var notMine = await t.Dev.Post("/api/v1/time/approvals/approve", new { ids = new[] { b } });   // not Dev's to review
        Assert.Equal(0, I(notMine.Data!["approved"]));
        Assert.Single(notMine.Data!["failed"]!.AsArray());
        var bulk = await t.Manager.Post("/api/v1/time/approvals/approve", new { ids = new[] { a, b, Guid.NewGuid().ToString() }, note = "Thanks" });
        Assert.True(bulk.Ok, bulk.ToString());
        Assert.Equal(2, I(bulk.Data!["approved"]));
        Assert.Single(bulk.Data!["failed"]!.AsArray());
        Assert.Equal("Approved", S((await t.Dev.Get($"/api/v1/time/week?weekStart={Iso(LastMonday)}")).Data!["status"]));

        var insights = (await t.Dev.Get("/api/v1/time/insights?weeks=4")).Data!;
        Assert.Equal(4, insights["weeks"]!.AsArray().Count);
        var last = insights["weeks"]!.AsArray().First(w => S(w!["weekStart"]) == Iso(LastMonday))!;
        Assert.Equal(840, I(last["loggedMinutes"]));
        Assert.Equal(120, I(last["overtimeMinutes"]));    // ten hours on Monday against an eight-hour day
        Assert.Equal(3, I(last["missingDays"]));
        Assert.Equal("Approved", S(last["status"]));
        Assert.Equal("Client Portal", S(insights["byProject"]![0]!["label"]));
        Assert.Equal(7, insights["byWeekday"]!.AsArray().Count);
        Assert.Equal(HttpStatusCode.Forbidden, (await t.Peer.Get($"/api/v1/time/insights?userId={t.Dev.UserId}")).Status);
        Assert.True((await t.Manager.Get($"/api/v1/time/insights?userId={t.Dev.UserId}")).Ok);
    }

    private sealed class FixedTime(DateTimeOffset now) : TimeProvider { public override DateTimeOffset GetUtcNow() => now; }

    [Fact]
    public async Task A_working_day_without_time_is_reminded_once_in_working_hours()
    {
        var t = await Setup();
        // "Now" is the latest weekday up to today, noon UTC (17:30 in India); the day before it (Friday for a Monday) went by with nothing logged.
        var day = Today;
        while (day.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday) day = day.AddDays(-1);
        var previous = day.AddDays(day.DayOfWeek == DayOfWeek.Monday ? -3 : -1);
        Assert.True((await t.Dev.Post($"/api/v1/tasks/{t.TaskId}/time", new { minutes = 60, workDate = Iso(previous.AddDays(-7)) })).Ok);
        var now = new DateTimeOffset(day.ToDateTime(new TimeOnly(12, 0)), TimeSpan.Zero);

        async Task Run()
        {
            using var scope = factory.Services.CreateScope();
            var sp = scope.ServiceProvider;
            var clock = new AppClock(new FixedTime(now), sp.GetRequiredService<IOptions<AppOptions>>());
            await new TimesheetNudgeMonitor(sp.GetRequiredService<IAppDbContext>(), clock, sp.GetRequiredService<NotificationRouter>(), NullLogger<TimesheetNudgeMonitor>.Instance).RunAsync();
        }
        int Count(Guid user) => factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Count(n => n.UserId == user && n.Type == NotificationType.TimesheetReminder));

        await Run();
        await Run();
        Assert.Equal(1, Count(t.Dev.UserId));        // once, however often the monitor runs
        Assert.Equal(0, Count(t.Peer.UserId));       // never tracked time: not reminded
        var note = factory.WithDb(db => db.Notifications.IgnoreQueryFilters().First(n => n.UserId == t.Dev.UserId && n.Type == NotificationType.TimesheetReminder));
        Assert.Contains(previous.ToString("d MMM"), note.Title);
        Assert.Equal($"/timesheet?week={Iso(previous.AddDays(-(((int)previous.DayOfWeek + 6) % 7)))}", note.Link);
    }
}
