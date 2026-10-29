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
/// "Your day" and reminders behave: a reminder planned after its time is not sent at once, one about work the person has just worked on (or
/// dated themselves) is skipped, several due-today reminders of one quarter hour are one notification, every reminder says why it came, and
/// time logged as a duration ends now instead of in the future.
/// </summary>
[Collection("api")]
public class DayFixTests(ApiFactory factory)
{
    private static readonly NodaTime.DateTimeZone Kolkata = ZoneTime.Find("Asia/Kolkata");
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private static DateTime At(DateOnly day, int hour, int minute = 0) => ZoneTime.ToUtc(ZoneTime.At(day, new TimeOnly(hour, minute)), Kolkata);
    private static DateOnly LocalToday => DateOnly.FromDateTime(ZoneTime.ToLocal(DateTime.UtcNow, Kolkata));
    /// <summary>A working day a few days ahead, so the clock can be set to any hour of it.</summary>
    private static DateOnly Day => new WorkCalendar(new ReminderSettings()).WorkingOnOrAfter(LocalToday.AddDays(3));

    private async Task Run(DateTime at)
    {
        using var scope = factory.Services.CreateScope();
        await scope.ServiceProvider.GetRequiredService<ReminderEngine>().RunAsync(at);
    }

    private sealed record Org(TestClient Owner, TestClient Dev, Guid Project, string Key, Guid Tenant);

    private async Task<Org> Setup()
    {
        var owner = await TestClient.RegisterAsync(factory, "Olivia Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("PRO");
        var dev = await owner.AddMemberAsync(factory, TenantRole.Member, "Dev Developer");
        var project = await owner.CreateProjectAsync("Atlas");
        var key = S((await owner.Get($"/api/v1/projects/{project}")).Data!["project"]!["key"]);
        var tenant = factory.WithDb(db => db.Projects.IgnoreQueryFilters().First(p => p.Id == project).TenantId);
        return new Org(owner, dev, project, key, tenant);
    }

    private async Task<Guid> DueTask(Org o, string title, DateOnly due) =>
        Guid.Parse(S((await o.Owner.CreateTaskAsync(o.Project, title, new { title, priority = "High", assigneeId = o.Dev.UserId, dueDate = due.ToString("yyyy-MM-dd") }))["id"]));

    private List<Notification> DueNotes(Org o) =>
        factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Where(n => n.UserId == o.Dev.UserId && n.Type == NotificationType.DueSoon).ToList());

    private Reminder DueReminder(Guid task) =>
        factory.WithDb(db => db.Reminders.IgnoreQueryFilters().Single(r => r.TargetId == task && r.Source == ReminderSource.DueDate));

    // ------------------------------------------------------------------ (b) planned late: the next sensible moment, never "now"

    [Fact]
    public void A_late_reminder_waits_for_the_next_sensible_moment()
    {
        var cal = new WorkCalendar(new ReminderSettings());   // 9 to 6, quiet 21:00-08:00
        var d = new DateOnly(2026, 10, 29);                   // a Thursday
        DateTime L(int h, int m = 0) => ZoneTime.At(d, new TimeOnly(h, m));
        // Due today, noticed at 10:30: not before two hours ahead of the end of the day.
        Assert.Equal(L(16), DueReminderRules.LateSlot(L(10, 30), cal, ReminderSource.DueDate, d));
        // Noticed at 15:50: never sooner than 30 minutes, on a quarter hour.
        Assert.Equal(L(16, 30), DueReminderRules.LateSlot(L(15, 50), cal, ReminderSource.DueDate, d));
        // Noticed at 17:45: nothing sensible is left of the day - not sent (the overdue follow-up takes over).
        Assert.Null(DueReminderRules.LateSlot(L(17, 45), cal, ReminderSource.DueDate, d));
        // Other automatic reminders: 30 minutes on, at a good time.
        Assert.Equal(L(11, 15), DueReminderRules.LateSlot(L(10, 40), cal, ReminderSource.Overdue, d));
        Assert.Equal(new DateTime(2026, 10, 30, 9, 0, 0), DueReminderRules.LateSlot(L(17, 50), cal, ReminderSource.Overdue, d));
    }

    [Fact]
    public async Task Work_that_becomes_due_today_after_the_reminder_time_is_not_announced_at_once()
    {
        var o = await Setup();
        var d = Day;
        var task = await DueTask(o, "Rotate the gateway keys", d);
        // The planner first sees it at 10:29 (the date became today after 09:00).
        await Run(At(d, 10, 29));
        var r = DueReminder(task);
        Assert.Equal(At(d, 16), r.NextFireAt);
        await Run(At(d, 10, 31));
        Assert.DoesNotContain(DueNotes(o), n => n.Title.Contains($"{o.Key}-1"));

        // At 16:00 it goes off, and says why.
        await Run(At(d, 16, 1));
        var note = Assert.Single(DueNotes(o), n => n.Title.StartsWith($"{o.Key}-1 is due today"));
        Assert.StartsWith(DueReminderRules.ReasonPrefix + "Due today · no time set", note.Body);
        var item = (await o.Dev.Get("/api/v1/notifications")).Data!["items"]!.AsArray().First(n => S(n!["id"]) == note.Id.ToString())!;
        Assert.Equal("Due today · no time set", S(item["reason"]));
        Assert.DoesNotContain("Why:", item["body"]?.GetValue<string>() ?? "");
    }

    // ------------------------------------------------------------------ (a) the person already knows

    [Fact]
    public async Task No_due_today_reminder_about_work_the_person_worked_on_in_the_last_two_hours()
    {
        var o = await Setup();
        var d = Day;
        var task = await DueTask(o, "Patch the gateway", d);
        await Run(At(d, 8));
        Assert.Equal(At(d, 9), DueReminder(task).NextFireAt);
        // Dev logged time on it at 8:15 (within two hours of 9:00).
        factory.WithDb(db =>
        {
            db.Activities.Add(new Activity { TenantId = o.Tenant, ActorId = o.Dev.UserId, Action = "task.time_logged", EntityType = "Task", EntityId = task, Summary = "Logged 45m", CreatedAt = At(d, 8, 15) });
            return db.SaveChanges();
        });
        await Run(At(d, 9, 1));
        Assert.DoesNotContain(DueNotes(o), n => n.Title.Contains($"{o.Key}-1"));
        Assert.Equal(ReminderState.Cancelled, DueReminder(task).State);
        // Skipped, not remade by the next planning pass.
        await Run(At(d, 9, 20));
        Assert.Equal(ReminderState.Cancelled, DueReminder(task).State);
    }

    [Fact]
    public async Task No_due_today_reminder_when_the_person_set_the_date_themselves_after_the_reminder_time()
    {
        var o = await Setup();
        var d = Day;
        var task = await DueTask(o, "Renew the certificate", d);
        // Dev moved the date to today at 10:28; the planner sees it at 10:29 and places it at 16:00.
        factory.WithDb(db =>
        {
            db.Activities.Add(new Activity { TenantId = o.Tenant, ActorId = o.Dev.UserId, Action = "task.due_changed", EntityType = "Task", EntityId = task, Summary = "Due today", CreatedAt = At(d, 10, 28) });
            return db.SaveChanges();
        });
        await Run(At(d, 10, 29));
        Assert.Equal(At(d, 16), DueReminder(task).NextFireAt);
        // At 16:00 that is more than two hours ago, but it was after the reminder time: they know.
        await Run(At(d, 16, 1));
        Assert.DoesNotContain(DueNotes(o), n => n.Title.Contains($"{o.Key}-1"));
        Assert.Equal(ReminderState.Cancelled, DueReminder(task).State);
    }

    [Fact]
    public async Task Work_touched_by_someone_else_still_reminds_the_assignee()
    {
        var o = await Setup();
        var d = Day;
        var task = await DueTask(o, "Close the audit", d);
        await Run(At(d, 8));
        factory.WithDb(db =>
        {
            db.Activities.Add(new Activity { TenantId = o.Tenant, ActorId = o.Owner.UserId, Action = "task.commented", EntityType = "Task", EntityId = task, Summary = "Any news?", CreatedAt = At(d, 8, 30) });
            return db.SaveChanges();
        });
        await Run(At(d, 9, 1));
        Assert.Contains(DueNotes(o), n => n.Title.StartsWith($"{o.Key}-1 is due today"));
    }

    // ------------------------------------------------------------------ (c) one notification for one quarter hour

    [Fact]
    public async Task Several_things_due_today_in_one_slot_are_one_notification()
    {
        var o = await Setup();
        var d = Day;
        await DueTask(o, "Board pack", d);
        await DueTask(o, "Release notes", d);
        await DueTask(o, "Vendor invoice", d);
        await Run(At(d, 8));
        await Run(At(d, 9, 1));
        var notes = DueNotes(o);
        var grouped = Assert.Single(notes, n => n.Title == "3 things are due today");
        Assert.StartsWith(DueReminderRules.ReasonPrefix + "Due today · no time set", grouped.Body);
        Assert.Contains($"{o.Key}-1", grouped.Body);
        Assert.DoesNotContain(notes, n => n.Title.EndsWith("is due today"));
    }

    // ------------------------------------------------------------------ (d) every reminder says why

    [Fact]
    public void Reasons_are_short_and_say_why()
    {
        var today = new DateOnly(2026, 10, 29);
        Assert.Equal("Due today · no time set", DueReminderRules.Reason(new Reminder { Source = ReminderSource.DueDate }, today, today));
        Assert.Equal("Due tomorrow", DueReminderRules.Reason(new Reminder { Source = ReminderSource.DueDate }, today.AddDays(1), today));
        Assert.Equal("Overdue · was due Tue 27 Oct", DueReminderRules.Reason(new Reminder { Source = ReminderSource.Overdue }, today.AddDays(-2), today));
        Assert.Equal("You set this for 15:30", DueReminderRules.Reason(new Reminder { Source = ReminderSource.Personal, LocalAt = "2026-10-29T15:30" }, null, today));
        Assert.Equal("Priya asked to remind you", DueReminderRules.Reason(new Reminder { Source = ReminderSource.Nudge }, null, today, "Priya"));
        var (why, body) = DueReminderRules.SplitReason(DueReminderRules.WithReason("Due tomorrow", "ATL-3 · Board pack"));
        Assert.Equal("Due tomorrow", why);
        Assert.Equal("ATL-3 · Board pack", body);
        Assert.Null(DueReminderRules.SplitReason("Plain").Reason);
        Assert.Equal("Plain", DueReminderRules.SplitReason("Plain").Body);
    }

    [Fact]
    public void Outbound_channels_never_show_the_raw_why_line()
    {
        // E-mail, push, digests, Slack, the inbox and Aura all read a body through ForChannel / SplitReason: the reason is a secondary last line.
        var stored = DueReminderRules.WithReason("Due today · no time set", "ATL-3 · Board pack");
        Assert.Equal("ATL-3 · Board pack\nDue today · no time set", DueReminderRules.ForChannel(stored));
        Assert.Equal("Due today · no time set", DueReminderRules.ForChannel(DueReminderRules.WithReason("Due today · no time set", null)));
        Assert.Equal("Plain body", DueReminderRules.ForChannel("Plain body"));
        Assert.Null(DueReminderRules.ForChannel(null));
        Assert.DoesNotContain(DueReminderRules.ReasonPrefix, DueReminderRules.ForChannel(stored));
        // No outbound sender reads the stored body directly any more.
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && dir.Name != "src") dir = dir.Parent;
        var app = Path.Combine(dir!.FullName, "ProjectManagement.Application", "Features");
        foreach (var (file, raw) in new[] { ("Notifications/PushService.cs", "body = n.Body"), ("Notifications/NotificationService.cs", ": n.Body!;"),
                     ("Integrations/ConnectedAccountsService.cs", "Escape(n.Body)") })
            Assert.DoesNotContain(raw, File.ReadAllText(Path.Combine(app, file)));
    }

    [Fact]
    public async Task A_personal_reminder_notification_carries_its_reason()
    {
        var o = await Setup();
        var at = DateTime.UtcNow.AddHours(2);
        var local = ZoneTime.ToLocal(at, Kolkata);
        var made = await o.Dev.Post("/api/v1/reminders", new { title = "Call the vendor", when = new { at = ZoneTime.Write(local), timeZone = "Asia/Kolkata" } });
        Assert.True(made.Ok, made.ToString());
        await Run(at.AddMinutes(2));
        var item = (await o.Dev.Get("/api/v1/notifications")).Data!["items"]!.AsArray().First(n => S(n!["title"]).Contains("Call the vendor"))!;
        Assert.StartsWith("You set this for", S(item["reason"]));
    }

    // ------------------------------------------------------------------ logged time ends at now

    [Fact]
    public async Task Time_logged_as_a_duration_today_ends_now_and_never_in_the_future()
    {
        var o = await Setup();
        var task = Guid.Parse(S((await o.Owner.CreateTaskAsync(o.Project, "Gateway soak test", new { title = "Gateway soak test", assigneeId = o.Owner.UserId }))["id"]));
        var before = DateTime.UtcNow;
        var res = await o.Owner.Post($"/api/v1/tasks/{task}/time", new { minutes = 20 });
        Assert.True(res.Ok, res.ToString());
        var e = res.Data!;
        // Placed when 20 minutes ago is still today (always, except in the first 20 minutes after midnight).
        if (DateOnly.FromDateTime(before.AddMinutes(AppDay.OffsetMinutes - 21)) == AppDay.Today)
        {
            var end = DateTime.Parse(S(e["endedAt"])).ToUniversalTime();
            var start = DateTime.Parse(S(e["startedAt"])).ToUniversalTime();
            Assert.True(end <= DateTime.UtcNow.AddSeconds(1), $"ends {end:o}, in the future");
            Assert.True(end >= before.AddMinutes(-1));
            Assert.Equal(20.0, (end - start).TotalMinutes);
        }
        // The timeline never draws it past now.
        var day = AppDay.Today.ToString("yyyy-MM-dd");
        var ev = (await o.Owner.Get($"/api/v1/timeline?from={day}&to={day}")).Data!["events"]!.AsArray().First(x => S(x!["id"]) == $"time:{S(e["id"])}")!;
        Assert.True(DateTime.Parse(S(ev["end"])).ToUniversalTime() <= DateTime.UtcNow.AddSeconds(1));

        // An explicit end in the future is refused with a clear message.
        var future = await o.Owner.Post($"/api/v1/tasks/{task}/time", new { minutes = 0, startedAt = DateTime.UtcNow.AddMinutes(-30), endedAt = DateTime.UtcNow.AddMinutes(30) });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, future.Status);
        Assert.Contains("not happened yet", future.ToString());
    }

    [Fact]
    public async Task An_old_entry_stored_to_end_in_the_future_is_drawn_up_to_now()
    {
        var o = await Setup();
        var task = Guid.Parse(S((await o.Owner.CreateTaskAsync(o.Project, "Sensor bench", new { title = "Sensor bench", assigneeId = o.Owner.UserId }))["id"]));
        var now = DateTime.UtcNow;
        var id = factory.WithDb(db =>
        {
            var row = new TimeEntry { TenantId = o.Tenant, TaskId = task, ProjectId = o.Project, UserId = o.Owner.UserId, WorkDate = AppDay.Today, Minutes = 10,
                StartedAt = now.AddMinutes(-2), EndedAt = now.AddMinutes(8), CreatedAt = now, CreatedBy = o.Owner.UserId };
            db.TimeEntries.Add(row);
            db.SaveChanges();
            return row.Id;
        });
        var day = AppDay.Today.ToString("yyyy-MM-dd");
        var ev = (await o.Owner.Get($"/api/v1/timeline?from={day}&to={day}")).Data!["events"]!.AsArray().First(x => S(x!["id"]) == $"time:{id}")!;
        var end = DateTime.Parse(S(ev["end"])).ToUniversalTime();
        Assert.True(end <= DateTime.UtcNow.AddSeconds(1));
        Assert.Equal(10.0, Math.Round((end - DateTime.Parse(S(ev["start"])).ToUniversalTime()).TotalMinutes));
    }
}
