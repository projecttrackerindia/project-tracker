using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Reminders: time zones and repeat rules, personal reminders end to end, one-time links, automatic reminders that follow the work,
/// quiet hours, reminding other people, escalation, the morning briefing and the calendar feed.</summary>
[Collection("api")]
public class ReminderTests(ApiFactory factory)
{
    private static readonly NodaTime.DateTimeZone Kolkata = ZoneTime.Find("Asia/Kolkata");
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private static DateTime Utc(string iso) => DateTime.Parse(iso, null, System.Globalization.DateTimeStyles.AdjustToUniversal | System.Globalization.DateTimeStyles.AssumeUniversal);
    private static string Local(DateTime utc) => ZoneTime.Write(ZoneTime.ToLocal(utc, Kolkata));
    private static DateOnly LocalToday => DateOnly.FromDateTime(ZoneTime.ToLocal(DateTime.UtcNow, Kolkata));
    private static DateTime At(DateOnly day, int hour, int minute = 0) => ZoneTime.ToUtc(ZoneTime.At(day, new TimeOnly(hour, minute)), Kolkata);

    private async Task<int> Run(DateTime at)
    {
        using var scope = factory.Services.CreateScope();
        return await scope.ServiceProvider.GetRequiredService<ReminderEngine>().RunAsync(at);
    }

    private sealed record Org(TestClient Owner, TestClient Dev, Guid Project, string Key);

    private async Task<Org> Setup(string plan = "PRO", bool colleague = true)
    {
        var owner = await TestClient.RegisterAsync(factory, "Olivia Owner");
        await owner.CreateOrgAsync();
        if (plan != "FREE") await owner.UpgradeAsync(plan);
        var dev = colleague ? await owner.AddMemberAsync(factory, TenantRole.Member, "Dev Developer") : owner;
        var project = await owner.CreateProjectAsync("Atlas");
        var key = S((await owner.Get($"/api/v1/projects/{project}")).Data!["project"]!["key"]);
        return new Org(owner, dev, project, key);
    }

    private Task<ApiResult> Remind(TestClient c, object body) => c.Post("/api/v1/reminders", body);

    // ------------------------------------------------------------------ time

    [Fact]
    public void Wall_clock_times_repeat_rules_and_working_days_are_worked_out_in_the_persons_zone()
    {
        var ny = ZoneTime.Find("America/New_York");
        // 02:30 does not exist when New York's clocks go forward: the first minute after the gap (03:00 EDT = 07:00 UTC).
        Assert.Equal(new DateTime(2026, 3, 8, 7, 0, 0, DateTimeKind.Utc), ZoneTime.ToUtc(new DateTime(2026, 3, 8, 2, 30, 0), ny));
        // 01:30 happens twice when they go back: the first of the two (EDT, UTC-4).
        Assert.Equal(new DateTime(2026, 11, 1, 5, 30, 0, DateTimeKind.Utc), ZoneTime.ToUtc(new DateTime(2026, 11, 1, 1, 30, 0), ny));

        // "Every weekday at 09:00" stays 09:00 across the change: 14:00 UTC on Friday, 13:00 UTC on Monday.
        var r = new Reminder { TimeZone = "America/New_York", LocalAt = "2026-03-06T09:00", Recurrence = "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" };
        Assert.Equal(new DateTime(2026, 3, 6, 14, 0, 0, DateTimeKind.Utc), ReminderService.NextOccurrence(r, new DateTime(2026, 3, 6, 12, 0, 0, DateTimeKind.Utc)));
        Assert.Equal(new DateTime(2026, 3, 9, 13, 0, 0, DateTimeKind.Utc), ReminderService.NextOccurrence(r, new DateTime(2026, 3, 6, 14, 0, 0, DateTimeKind.Utc)));

        var weekdays = RecurrenceRule.Parse("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR")!;
        Assert.Equal("every weekday", weekdays.Describe(new DateOnly(2026, 10, 2)));
        var lastWorking = RecurrenceRule.Parse("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1")!;
        Assert.Equal("every month on the last working day", lastWorking.Describe(new DateOnly(2026, 10, 2)));
        Assert.Equal(new DateOnly(2026, 10, 30), lastWorking.NextDate(new DateOnly(2026, 10, 2), new DateOnly(2026, 10, 2), true));   // the 31st is a Saturday
        var the31st = RecurrenceRule.Parse("FREQ=MONTHLY;BYMONTHDAY=31")!;
        Assert.Equal(new DateOnly(2027, 2, 28), the31st.NextDate(new DateOnly(2027, 2, 1), new DateOnly(2027, 1, 31), true));   // short months: their last day
        Assert.Equal("every 2 weeks on Monday", RecurrenceRule.Parse("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO")!.Describe(new DateOnly(2026, 10, 5)));
        Assert.Null(RecurrenceRule.Parse("FREQ=HOURLY"));

        var cal = new WorkCalendar(new ReminderSettings());
        Assert.Equal(new DateOnly(2026, 10, 2), cal.WorkingDaysBefore(new DateOnly(2026, 10, 5), 1));   // the working day before Monday is Friday
        Assert.Equal(new DateOnly(2026, 10, 2), cal.WorkingDaysBefore(new DateOnly(2026, 10, 4), 0));   // due on a Sunday: Friday
        Assert.True(cal.InQuietHours(new TimeOnly(23, 0)));
        Assert.True(cal.InQuietHours(new TimeOnly(7, 59)));
        Assert.False(cal.InQuietHours(new TimeOnly(8, 0)));
        Assert.Equal(new DateTime(2026, 10, 5, 9, 0, 0), cal.NextGoodTime(new DateTime(2026, 10, 3, 10, 0, 0)));   // Saturday morning waits for Monday
    }

    // ------------------------------------------------------------------ personal reminders

    [Fact]
    public async Task A_personal_reminder_goes_off_once_and_can_be_snoozed_finished_and_restored()
    {
        var o = await Setup();
        var task = await o.Owner.CreateTaskAsync(o.Project, "Send the invoice");
        var fire = DateTime.UtcNow.AddHours(2);
        var made = await Remind(o.Owner, new { title = "Call Priya about the invoice", targetType = "Task", targetId = S(task["id"]), when = new { at = Local(fire), timeZone = "Asia/Kolkata" } });
        Assert.True(made.Ok, made.ToString());
        var id = S(made.Data!["id"]);
        Assert.Equal("Scheduled", S(made.Data["state"]));
        Assert.Equal($"{o.Key}-1", S(made.Data["targetKey"]));
        Assert.True(Math.Abs((Utc(S(made.Data["nextFireAt"])) - fire).TotalMinutes) < 1.5);
        Assert.Equal(0, (await o.Owner.Get("/api/v1/reminders/counts")).Data!["now"]!.GetValue<int>());

        await Run(fire.AddMinutes(1));
        var list = (await o.Owner.Get("/api/v1/reminders")).Data!;
        var fired = list["open"]!.AsArray().Single(r => S(r!["id"]) == id)!;
        Assert.Equal("Fired", S(fired["state"]));
        Assert.Equal(1, (await o.Owner.Get("/api/v1/reminders/counts")).Data!["now"]!.GetValue<int>());
        await Run(fire.AddMinutes(2));   // a second run does not send it again
        var notes = factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Where(n => n.UserId == o.Owner.UserId && n.Type == NotificationType.Reminder).ToList());
        var note = Assert.Single(notes);
        Assert.Equal("Call Priya about the invoice", note.Title);
        Assert.StartsWith("/r/", note.Link);
        Assert.True(note.PushPending);   // reminders reach the person's devices by default

        var snoozed = (await o.Owner.Post($"/api/v1/reminders/{id}/snooze", new { preset = "1h" })).Data!;
        Assert.Equal("Scheduled", S(snoozed["state"]));
        Assert.True(snoozed["isSnoozed"]!.GetValue<bool>());
        Assert.Equal(1, snoozed["snoozeCount"]!.GetValue<int>());

        Assert.Equal("Done", S((await o.Owner.Post($"/api/v1/reminders/{id}/done")).Data!["state"]));
        list = (await o.Owner.Get("/api/v1/reminders")).Data!;
        Assert.DoesNotContain(list["open"]!.AsArray(), r => S(r!["id"]) == id);
        Assert.Contains(list["completed"]!.AsArray(), r => S(r!["id"]) == id);
        Assert.Equal("Fired", S((await o.Owner.Post($"/api/v1/reminders/{id}/reopen")).Data!["state"]));
        Assert.Equal(HttpStatusCode.NoContent, (await o.Owner.Delete($"/api/v1/reminders/{id}")).Status);
        Assert.Empty((await o.Owner.Get("/api/v1/reminders")).Data!["open"]!.AsArray());

        // Things in the past, unknown zones and work the caller cannot see are refused.
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await Remind(o.Owner, new { title = "Too late", when = new { at = Local(DateTime.UtcNow.AddHours(-1)), timeZone = "Asia/Kolkata" } })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await Remind(o.Owner, new { title = "Nowhere", when = new { at = Local(fire), timeZone = "Mars/Olympus" } })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await Remind(o.Owner, new { targetType = "Task", targetId = Guid.NewGuid(), when = new { at = Local(fire), timeZone = "Asia/Kolkata" } })).Status);
    }

    [Fact]
    public async Task The_links_in_emails_and_push_notifications_work_once_without_signing_in()
    {
        var o = await Setup();
        var fire = DateTime.UtcNow.AddHours(1);
        Assert.True((await Remind(o.Owner, new { title = "Renew the domain", when = new { at = Local(fire), timeZone = "Asia/Kolkata" } })).Ok);
        await Run(fire.AddMinutes(1));
        var link = factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Where(n => n.UserId == o.Owner.UserId && n.Type == NotificationType.Reminder).Select(n => n.Link).Single())!;
        var token = link["/r/".Length..];

        var info = await o.Owner.Send(HttpMethod.Get, $"/api/v1/reminder-actions/{token}", null, anonymous: true);
        Assert.True(info.Data!["valid"]!.GetValue<bool>());
        Assert.Equal("Renew the domain", S(info.Data["title"]));
        var acted = await o.Owner.Send(HttpMethod.Post, $"/api/v1/reminder-actions/{token}", new { action = "snooze", preset = "1h" }, anonymous: true);
        Assert.True(acted.Ok, acted.ToString());
        Assert.Equal("Scheduled", S(acted.Data!["state"]));
        Assert.True(acted.Data["isSnoozed"]!.GetValue<bool>());
        Assert.False(acted.Data["valid"]!.GetValue<bool>());
        // Used once: it now only shows where the reminder stands.
        Assert.Equal("REMINDER_LINK_USED", (await o.Owner.Send(HttpMethod.Post, $"/api/v1/reminder-actions/{token}", new { action = "done" }, anonymous: true)).ErrorCode);
        Assert.False((await o.Owner.Send(HttpMethod.Get, "/api/v1/reminder-actions/not-a-real-token", null, anonymous: true)).Data!["valid"]!.GetValue<bool>());
    }

    [Fact]
    public async Task Repeating_reminders_carry_on_after_each_occurrence_and_the_free_plan_allows_five()
    {
        var o = await Setup("FREE", colleague: false);
        var first = DateTime.UtcNow.AddHours(1);
        var made = (await Remind(o.Owner, new { title = "Standup notes", when = new { at = Local(first), timeZone = "Asia/Kolkata", recurrence = "FREQ=DAILY" } })).Data!;
        Assert.Equal("every day", S(made["recurrenceText"]));
        var id = S(made["id"]);
        var at = Utc(S(made["nextFireAt"]));
        await Run(at.AddMinutes(1));
        var series = (await o.Owner.Get("/api/v1/reminders")).Data!["open"]!.AsArray().Single(r => S(r!["id"]) == id)!;
        Assert.Equal("Fired", S(series["state"]));
        Assert.Equal(at.AddDays(1), Utc(S(series["nextFireAt"])));   // Kolkata keeps the same offset all year

        // Finishing this occurrence keeps a finished copy; the series waits for tomorrow.
        var done = (await o.Owner.Post($"/api/v1/reminders/{id}/done")).Data!;
        Assert.Equal(id, S(done["seriesId"]));
        var after = (await o.Owner.Get("/api/v1/reminders")).Data!;
        Assert.Equal("Scheduled", S(after["open"]!.AsArray().Single(r => S(r!["id"]) == id)!["state"]));
        Assert.Contains(after["completed"]!.AsArray(), r => S(r!["seriesId"]) == id);

        for (var i = 0; i < 4; i++)
            Assert.True((await Remind(o.Owner, new { title = $"Weekly {i}", when = new { at = Local(first.AddDays(i + 1)), timeZone = "Asia/Kolkata", recurrence = "FREQ=WEEKLY" } })).Ok);
        var sixth = await Remind(o.Owner, new { title = "One too many", when = new { at = Local(first), timeZone = "Asia/Kolkata", recurrence = "FREQ=WEEKLY" } });
        Assert.Equal("PLAN_LIMIT_REACHED", sixth.ErrorCode);
        Assert.True((await Remind(o.Owner, new { title = "A one-off is still fine", when = new { at = Local(first), timeZone = "Asia/Kolkata" } })).Ok);
    }

    // ------------------------------------------------------------------ automatic reminders

    [Fact]
    public async Task Automatic_due_date_reminders_follow_the_work_and_finish_with_it()
    {
        var o = await Setup();
        var due = LocalToday.AddDays(6);
        var task = await o.Owner.CreateTaskAsync(o.Project, "Board pack", new { title = "Board pack", priority = "High", assigneeId = o.Dev.UserId, dueDate = due.ToString("yyyy-MM-dd") });
        var taskId = Guid.Parse(S(task["id"]));
        await Run(DateTime.UtcNow);
        List<Reminder> Auto() => factory.WithDb(db => db.Reminders.IgnoreQueryFilters().Where(r => r.TargetId == taskId).ToList());
        var leads = Auto().Where(r => r.Source == ReminderSource.DueDate).ToList();
        Assert.Equal(2, leads.Count);   // the working day before, and the day itself
        Assert.All(leads, r => Assert.Equal(o.Dev.UserId, r.UserId));
        Assert.All(leads, r => Assert.False(r.Exact));
        var cal = new WorkCalendar(new ReminderSettings());
        var dayBefore = leads.Single(r => r.SystemKey!.Contains(":L1:"));
        Assert.Equal(At(cal.WorkingDaysBefore(due, 1), 9), dayBefore.NextFireAt);
        // The person sees them too.
        Assert.Equal(2, (await o.Dev.Get("/api/v1/reminders")).Data!["open"]!.AsArray().Count(r => S(r!["source"]) == "DueDate"));

        // The due date moves: the waiting reminders move with it.
        factory.WithDb(db => { db.Tasks.IgnoreQueryFilters().First(t => t.Id == taskId).DueDate = due.AddDays(30); db.SaveChanges(); return 0; });
        await Run(DateTime.UtcNow);
        Assert.Empty(Auto().Where(r => r.State == ReminderState.Scheduled && r.SystemKey!.EndsWith(due.ToString("yyyyMMdd"))));
        factory.WithDb(db => { db.Tasks.IgnoreQueryFilters().First(t => t.Id == taskId).DueDate = due; db.SaveChanges(); return 0; });
        await Run(DateTime.UtcNow);
        Assert.Equal(2, Auto().Count(r => r.State == ReminderState.Scheduled && r.Source == ReminderSource.DueDate));   // and come back when it moves back

        // It goes off at 09:00 on the working day before.
        var at = dayBefore.NextFireAt!.Value.AddMinutes(1);
        await Run(at);
        var sent = factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Where(n => n.UserId == o.Dev.UserId && n.Type == NotificationType.DueSoon).ToList());
        Assert.Contains(sent, n => n.Title.StartsWith($"{o.Key}-1 is due"));
        Assert.Contains(Auto(), r => r.State == ReminderState.Fired);

        // Finishing the work finishes its reminders: the one that went off counts as done, the one still waiting goes away.
        factory.WithDb(db =>
        {
            var t = db.Tasks.IgnoreQueryFilters().First(x => x.Id == taskId);
            t.StatusId = db.WorkflowStatuses.IgnoreQueryFilters().First(s => s.ProjectId == o.Project && s.Category == StatusCategory.Done).Id;
            db.SaveChanges();
            return 0;
        });
        await Run(at.AddMinutes(1));
        var final = Auto();
        Assert.DoesNotContain(final, r => r.State is ReminderState.Scheduled or ReminderState.Fired);
        Assert.Contains(final, r => r.State == ReminderState.Done);
    }

    [Fact]
    public async Task Action_items_are_reminded_like_every_other_kind_of_work_automatically_and_on_request()
    {
        var o = await Setup();
        var due = LocalToday.AddDays(6);
        var made = await o.Owner.Post($"/api/v1/projects/{o.Project}/action-items", new { title = "Get the client's sign-off", assigneeId = o.Dev.UserId, dueDate = due.ToString("yyyy-MM-dd"), priority = "High" });
        Assert.True(made.Ok, made.ToString());
        var id = Guid.Parse(S(made.Data!["id"]));

        // Automatically: the assignee is reminded the working day before and on the day, as for a task, and the reminder opens the action item.
        await Run(DateTime.UtcNow);
        List<Reminder> Mine() => factory.WithDb(db => db.Reminders.IgnoreQueryFilters().Where(r => r.TargetId == id).ToList());
        var auto = Mine().Where(r => r.Source == ReminderSource.DueDate).ToList();
        Assert.Equal(2, auto.Count);
        Assert.All(auto, r => { Assert.Equal(ReminderTarget.ActionItem, r.TargetType); Assert.Equal(o.Dev.UserId, r.UserId); Assert.Contains($"/projects/{o.Project}", r.Link); Assert.Contains("action", r.Link); });

        // On request: "Remind me" on the action item, by the assignee, and also by the project owner about someone else's.
        var fire = DateTime.UtcNow.AddHours(3);
        var own = await Remind(o.Dev, new { title = "Chase the client", targetType = "ActionItem", targetId = id, when = new { at = Local(fire), timeZone = "Asia/Kolkata" } });
        Assert.True(own.Ok, own.ToString());
        Assert.Equal("ActionItem", S(own.Data!["targetType"]));
        Assert.Contains("-AI", S(own.Data["targetKey"]).Replace("AI-", "-AI"), StringComparison.Ordinal);
        Assert.True((await Remind(o.Owner, new { title = "Is the sign-off in?", forUserId = o.Dev.UserId, targetType = "ActionItem", targetId = id, when = new { at = Local(fire), timeZone = "Asia/Kolkata" } })).Ok);

        // Finishing the action item finishes its reminders.
        factory.WithDb(db => { var w = db.WorkTasks.IgnoreQueryFilters().First(x => x.Id == id); w.Status = WorkTaskStatus.Completed; w.CompletedAt = DateTime.UtcNow; db.SaveChanges(); return 0; });
        await Run(DateTime.UtcNow.AddMinutes(1));
        Assert.DoesNotContain(Mine(), r => r.State == ReminderState.Scheduled);

        // Somebody who cannot open the project cannot set one either.
        var outsider = await TestClient.RegisterAsync(factory, "Outsider");
        await outsider.CreateOrgAsync();
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await Remind(outsider, new { title = "Spy", targetType = "ActionItem", targetId = id, when = new { at = Local(fire), timeZone = "Asia/Kolkata" } })).Status);
    }

    [Fact]
    public async Task Reminders_from_others_wait_for_working_hours_while_your_own_go_off_on_the_dot()
    {
        var o = await Setup();
        var saturday = LocalToday.AddDays(7);
        while (saturday.DayOfWeek != DayOfWeek.Saturday) saturday = saturday.AddDays(1);
        var late = At(saturday, 22);
        var nudge = await Remind(o.Owner, new { title = "Send me the deck", forUserId = o.Dev.UserId, when = new { at = Local(late), timeZone = "Asia/Kolkata" } });
        Assert.True(nudge.Ok, nudge.ToString());
        Assert.Equal("Nudge", S(nudge.Data!["source"]));
        Assert.True((await Remind(o.Dev, new { title = "Water the plants", when = new { at = Local(late), timeZone = "Asia/Kolkata" } })).Ok);

        await Run(late.AddMinutes(1));
        var mine = factory.WithDb(db => db.Reminders.IgnoreQueryFilters().Where(r => r.UserId == o.Dev.UserId).ToList());
        Assert.Equal(ReminderState.Fired, mine.Single(r => r.Title == "Water the plants").State);
        var waiting = mine.Single(r => r.Title == "Send me the deck");
        Assert.Equal(ReminderState.Scheduled, waiting.State);
        Assert.Equal(At(saturday.AddDays(2), 9), waiting.NextFireAt);   // Monday, 09:00

        // The sender sees what they sent; the recipient sees who it is from.
        Assert.Contains((await o.Owner.Get("/api/v1/reminders")).Data!["sent"]!.AsArray(), r => S(r!["title"]) == "Send me the deck");
        Assert.Equal("Olivia Owner", S((await o.Dev.Get("/api/v1/reminders")).Data!["open"]!.AsArray().Single(r => S(r!["title"]) == "Send me the deck")!["from"]!["name"]));
    }

    [Fact]
    public async Task People_can_remind_others_only_about_their_own_work_once_a_day_and_can_pause_it()
    {
        var o = await Setup();
        var colleague = await o.Owner.AddMemberAsync(factory, TenantRole.Member, "Cara Colleague");
        var task = await o.Owner.CreateTaskAsync(o.Project, "Fix the login page", new { title = "Fix the login page", priority = "High", assigneeId = o.Dev.UserId });
        var when = new { at = Local(DateTime.UtcNow.AddHours(3)), timeZone = "Asia/Kolkata" };

        Assert.Equal(HttpStatusCode.Forbidden, (await Remind(colleague, new { title = "Lunch?", forUserId = o.Dev.UserId, when })).Status);
        var ok = await Remind(colleague, new { forUserId = o.Dev.UserId, targetType = "Task", targetId = S(task["id"]), when });
        Assert.True(ok.Ok, ok.ToString());
        Assert.Equal("NUDGE_REPEATED", (await Remind(colleague, new { forUserId = o.Dev.UserId, targetType = "Task", targetId = S(task["id"]), when })).ErrorCode);
        Assert.True((await Remind(o.Owner, new { title = "Team photo at 4", forUserId = o.Dev.UserId, when })).Ok);   // owners and managers may

        var settings = (await o.Dev.Get("/api/v1/reminders/settings")).Data!.AsObject();
        settings["muteNudges"] = true;
        Assert.True((await o.Dev.Put("/api/v1/reminders/settings", settings)).Ok);
        Assert.Equal("NUDGES_MUTED", (await Remind(o.Owner, new { title = "One more thing", forUserId = o.Dev.UserId, when })).ErrorCode);
    }

    [Fact]
    public async Task Escalation_needs_a_business_plan_and_reaches_the_assignees_manager()
    {
        var o = await Setup("PRO");
        Assert.Equal("FEATURE_NOT_AVAILABLE", (await o.Owner.Put("/api/v1/reminders/policy", new { escalationEnabled = true, steps = "2:Manager" })).ErrorCode);
        await o.Owner.UpgradeAsync("BUSINESS");
        var manager = await o.Owner.AddMemberAsync(factory, TenantRole.Manager, "Mona Manager");
        Assert.Equal(HttpStatusCode.Forbidden, (await manager.Put("/api/v1/reminders/policy", new { escalationEnabled = true, steps = "2:Manager" })).Status);
        var policy = await o.Owner.Put("/api/v1/reminders/policy", new { escalationEnabled = true, steps = "2:Manager,5:Owner" });
        Assert.True(policy.Ok, policy.ToString());
        Assert.Equal("2:Manager,5:Owner", S(policy.Data!["steps"]));

        factory.WithDb(db => { db.TenantMembers.IgnoreQueryFilters().First(m => m.TenantId == o.Owner.WorkspaceId && m.UserId == o.Dev.UserId).ReportsToUserId = manager.UserId; db.SaveChanges(); return 0; });
        var task = await o.Owner.CreateTaskAsync(o.Project, "Quarterly filing", new { title = "Quarterly filing", priority = "High", assigneeId = o.Dev.UserId, dueDate = LocalToday.AddDays(-1).ToString("yyyy-MM-dd") });
        var taskId = Guid.Parse(S(task["id"]));
        await Run(DateTime.UtcNow);
        var escalation = factory.WithDb(db => db.Reminders.IgnoreQueryFilters().Where(r => r.TargetId == taskId && r.Source == ReminderSource.Escalation).ToList());
        var toManager = Assert.Single(escalation, r => r.UserId == manager.UserId);
        Assert.Equal($"{o.Key}-1 is 2 days overdue (Dev Developer)", toManager.Title);
    }

    // ------------------------------------------------------------------ briefing, settings, calendar

    [Fact]
    public async Task The_morning_briefing_sums_up_the_day_once()
    {
        var o = await Setup();
        var day = new WorkCalendar(new ReminderSettings()).WorkingOnOrAfter(LocalToday.AddDays(1));
        await o.Owner.CreateTaskAsync(o.Project, "Ship the release", new { title = "Ship the release", priority = "High", assigneeId = o.Dev.UserId, dueDate = day.ToString("yyyy-MM-dd") });
        await Run(At(day, 8, 35));
        await Run(At(day, 8, 45));
        var briefs = factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Where(n => n.UserId == o.Dev.UserId && n.TenantId == o.Owner.WorkspaceId && n.Type == NotificationType.Briefing).ToList());
        var brief = Assert.Single(briefs);
        Assert.StartsWith("Your day: 1 due today", brief.Title);
        Assert.Contains("Ship the release", brief.Body);
        Assert.Equal("/reminders", brief.Link);
    }

    [Fact]
    public async Task Settings_follow_the_device_and_upcoming_reminders_appear_in_the_calendar_feed()
    {
        var o = await Setup("BUSINESS");
        var s = (await o.Dev.Get("/api/v1/reminders/settings")).Data!;
        Assert.Equal([1, 2, 3, 4, 5], s["workDays"]!.AsArray().Select(d => d!.GetValue<int>()));
        Assert.Equal("09:00", S(s["defaultTime"]));
        Assert.Equal([1, 0], s["dueLeads"]!.AsArray().Select(d => d!.GetValue<int>()));
        Assert.Equal([1, 3, 7], s["overdueSteps"]!.AsArray().Select(d => d!.GetValue<int>()));
        var bad = s.DeepClone().AsObject();
        bad["workEnd"] = "08:00";
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await o.Dev.Put("/api/v1/reminders/settings", bad)).Status);

        Assert.Equal("America/New_York", S((await o.Dev.Put("/api/v1/reminders/time-zone", new { timeZone = "America/New_York" })).Data!["timeZone"]));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await o.Dev.Put("/api/v1/reminders/time-zone", new { timeZone = "Not/AZone" })).Status);

        var fire = DateTime.UtcNow.AddDays(2);
        Assert.True((await Remind(o.Dev, new { title = "Call the bank", when = new { at = Local(fire), timeZone = "Asia/Kolkata" } })).Ok);
        Assert.True((await Remind(o.Dev, new { title = "Timesheet", when = new { at = Local(fire), timeZone = "Asia/Kolkata", recurrence = "FREQ=WEEKLY;BYDAY=FR" } })).Ok);
        var url = S((await o.Dev.Post("/api/v1/calendar/feed")).Data!["url"]);
        var ics = await (await factory.CreateClient().GetAsync(new Uri(url).PathAndQuery)).Content.ReadAsStringAsync();
        Assert.Contains("⏰ Call the bank", ics);
        Assert.Contains("BEGIN:VALARM", ics);
        Assert.Contains("RRULE:FREQ=WEEKLY;BYDAY=FR", ics);
        Assert.Contains("DTSTART;TZID=Asia/Kolkata:", ics);

        var insights = (await o.Dev.Get("/api/v1/reminders/insights")).Data!;
        Assert.Equal(0, insights["doneThisWeek"]!.GetValue<int>());
    }
}
