using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// One day, one story: time entries that share wall-clock time are saved (a warning, never an error) and the response says which entry they
/// overlap ("Overlaps ATL-1 09:31–11:31"); the timesheet still counts both in full and marks each; a duration logged for today that would
/// overlap goes into the latest free gap before now that fits it, or stays ending now and warns; the timeline names the work a time entry was
/// logged on, and tells an automatic due-date reminder from one the person set.
/// </summary>
[Collection("api")]
public class TimeOverlapTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private static string Iso(DateOnly d) => d.ToString("yyyy-MM-dd");
    /// <summary>A wall-clock time on a day in the application's zone (India by default), as UTC.</summary>
    private static DateTime At(DateOnly d, int h, int m = 0) => DateTime.SpecifyKind(d.ToDateTime(new TimeOnly(h, m)).AddMinutes(-AppDay.OffsetMinutes), DateTimeKind.Utc);
    /// <summary>Minutes since local midnight now.</summary>
    private static double LocalMinutes => DateTime.UtcNow.AddMinutes(AppDay.OffsetMinutes).TimeOfDay.TotalMinutes;

    private sealed record World(TestClient Owner, Guid Project, Guid TaskA, Guid TaskB, Guid Tenant);

    private async Task<World> Setup()
    {
        var owner = await TestClient.RegisterAsync(factory, "Rhea Overlap");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var project = await owner.CreateProjectAsync("Juspay Rollout");
        var a = Guid.Parse(S((await owner.CreateTaskAsync(project, "Production issue on settlement", new { title = "Production issue on settlement", assigneeId = owner.UserId }))["id"]));
        var b = Guid.Parse(S((await owner.CreateTaskAsync(project, "QR payment discussion", new { title = "QR payment discussion", assigneeId = owner.UserId }))["id"]));
        var tenant = factory.WithDb(db => db.Projects.IgnoreQueryFilters().First(p => p.Id == project).TenantId);
        return new World(owner, project, a, b, tenant);
    }

    [Fact]
    public async Task Overlapping_entries_are_saved_with_a_warning_and_both_count_in_full()
    {
        var w = await Setup();
        var day = AppDay.Today.AddDays(-1);
        var first = await w.Owner.Post($"/api/v1/tasks/{w.TaskA}/time", new { minutes = 0, startedAt = At(day, 9, 31), endedAt = At(day, 11, 31) });
        Assert.True(first.Ok, first.ToString());
        Assert.Null(first.Data!["warning"]?.GetValue<string>());
        var keyA = S(first.Data["taskKey"]);

        // 10:31-13:31 shares an hour with 09:31-11:31: saved, with the warning and the other entry named.
        var second = await w.Owner.Post($"/api/v1/tasks/{w.TaskB}/time", new { minutes = 0, startedAt = At(day, 10, 31), endedAt = At(day, 13, 31) });
        Assert.True(second.Ok, second.ToString());
        Assert.Equal(180, second.Data!["minutes"]!.GetValue<int>());
        Assert.Equal($"Overlaps {keyA} 09:31–11:31", S(second.Data["warning"]));
        var ov = second.Data["overlaps"]!.AsArray();
        Assert.Single(ov);
        Assert.Equal(S(first.Data["id"]), S(ov[0]!["id"]));
        Assert.Equal("09:31–11:31", S(ov[0]!["span"]));

        // The timesheet counts both in full (5h, as the Time grid) and marks each entry.
        var sheet = (await w.Owner.Get($"/api/v1/time?from={Iso(day)}&to={Iso(day)}")).Data!;
        Assert.Equal(300, sheet["totalMinutes"]!.GetValue<int>());
        foreach (var e in sheet["entries"]!.AsArray()) Assert.StartsWith("Overlaps ", S(e!["warning"]));

        // Trimmed to start when the other ends (touching is not overlapping): the warning goes.
        var trimmed = await w.Owner.Put($"/api/v1/time/{S(second.Data["id"])}", new { minutes = 0, workDate = Iso(day), startedAt = At(day, 11, 31), endedAt = At(day, 13, 31), stamp = S(second.Data["stamp"]) });
        Assert.True(trimmed.Ok, trimmed.ToString());
        Assert.Null(trimmed.Data!["warning"]?.GetValue<string>());
        Assert.Equal(120, trimmed.Data["minutes"]!.GetValue<int>());

        // The timeline names the work each entry was logged on (its key and item), so a day knows what already has time.
        var events = (await w.Owner.Get($"/api/v1/timeline?from={Iso(day)}&to={Iso(day)}")).Data!["events"]!.AsArray();
        var ta = events.First(e => S(e!["id"]) == $"time:{S(first.Data["id"])}")!;
        Assert.Equal(keyA, S(ta["key"]));
        Assert.Equal(w.TaskA.ToString(), S(ta["itemId"]));
        Assert.Equal("task", S(ta["itemType"]));
    }

    [Fact]
    public async Task A_duration_for_today_that_would_overlap_goes_into_the_latest_free_gap_before_now()
    {
        if (LocalMinutes < 150) return;   // the first hours after midnight have no room for the gap this test needs
        var w = await Setup();
        var now = DateTime.UtcNow;
        // Checked in two hours ago; already logged on the clock from 60 to 10 minutes ago.
        var busyStart = now.AddMinutes(-60);
        factory.WithDb(db =>
        {
            db.AttendanceDays.Add(new AttendanceDay { TenantId = w.Tenant, UserId = w.Owner.UserId, Date = AppDay.Today, CheckInAt = now.AddMinutes(-120), Mode = "Office" });
            db.TimeEntries.Add(new TimeEntry { TenantId = w.Tenant, TaskId = w.TaskA, ProjectId = w.Project, UserId = w.Owner.UserId, WorkDate = AppDay.Today, Minutes = 50,
                StartedAt = busyStart, EndedAt = now.AddMinutes(-10), CreatedAt = now, CreatedBy = w.Owner.UserId });
            return db.SaveChanges();
        });
        // "30m" ending now would overlap it; the 10 minutes since do not fit, so it goes before it: ending when the other started.
        var res = await w.Owner.Post($"/api/v1/tasks/{w.TaskB}/time", new { minutes = 30 });
        Assert.True(res.Ok, res.ToString());
        var start = DateTime.Parse(S(res.Data!["startedAt"])).ToUniversalTime();
        var end = DateTime.Parse(S(res.Data["endedAt"])).ToUniversalTime();
        Assert.Equal(30.0, (end - start).TotalMinutes, 3);
        Assert.True(Math.Abs((end - busyStart).TotalSeconds) < 61, $"ends {end:o}, the other starts {busyStart:o}");
        Assert.Null(res.Data["warning"]?.GetValue<string>());
    }

    [Fact]
    public async Task A_duration_for_today_with_no_free_gap_keeps_ending_now_and_warns()
    {
        if (LocalMinutes < 90 || LocalMinutes > 1380) return;   // room for the day so far plus 30 minutes
        var w = await Setup();
        var now = DateTime.UtcNow;
        var midnight = At(AppDay.Today, 0, 0);
        // The whole day so far is logged, but for the last 5 minutes.
        factory.WithDb(db =>
        {
            db.TimeEntries.Add(new TimeEntry { TenantId = w.Tenant, TaskId = w.TaskA, ProjectId = w.Project, UserId = w.Owner.UserId, WorkDate = AppDay.Today,
                Minutes = (int)(now.AddMinutes(-5) - midnight.AddMinutes(1)).TotalMinutes, StartedAt = midnight.AddMinutes(1), EndedAt = now.AddMinutes(-5), CreatedAt = now, CreatedBy = w.Owner.UserId });
            return db.SaveChanges();
        });
        var res = await w.Owner.Post($"/api/v1/tasks/{w.TaskB}/time", new { minutes = 30 });
        Assert.True(res.Ok, res.ToString());
        var end = DateTime.Parse(S(res.Data!["endedAt"])).ToUniversalTime();
        Assert.True(end <= DateTime.UtcNow.AddSeconds(1) && end >= now.AddMinutes(-1), $"ends {end:o}: now");
        Assert.StartsWith("Overlaps ", S(res.Data["warning"]));
    }

    [Fact]
    public async Task The_timeline_tells_an_automatic_due_reminder_from_a_personal_one()
    {
        var w = await Setup();
        var day = AppDay.Today.AddDays(-1);
        factory.WithDb(db =>
        {
            db.Reminders.Add(new Reminder { TenantId = w.Tenant, UserId = w.Owner.UserId, Title = "Production issue is due today", TimeZone = "Asia/Kolkata", Source = ReminderSource.DueDate,
                TargetType = ReminderTarget.Task, TargetId = w.TaskA, State = ReminderState.Fired, LastFiredAt = At(day, 10, 30), FireCount = 1 });
            db.Reminders.Add(new Reminder { TenantId = w.Tenant, UserId = w.Owner.UserId, Title = "Call the bank", TimeZone = "Asia/Kolkata", Source = ReminderSource.Personal,
                State = ReminderState.Fired, LastFiredAt = At(day, 16, 0), FireCount = 1 });
            return db.SaveChanges();
        });
        var events = (await w.Owner.Get($"/api/v1/timeline?from={Iso(day)}&to={Iso(day)}")).Data!["events"]!.AsArray().Where(e => S(e!["type"]) == "reminder").ToList();
        var auto = events.First(e => S(e!["title"]) == "Production issue is due today")!;
        Assert.Equal("dueDate", S(auto["origin"]));
        Assert.Equal(w.TaskA.ToString(), S(auto["itemId"]));
        Assert.Equal("personal", S(events.First(e => S(e!["title"]) == "Call the bank")!["origin"]));
    }

    [Fact]
    public async Task Gap_placement_never_reaches_before_the_check_in()
    {
        if (LocalMinutes < 150) return;
        var w = await Setup();
        var now = DateTime.UtcNow;
        // Checked in 70 minutes ago, logged from 60 to 10 minutes ago: the only gaps after the check-in are 10 minutes each, so "30m"
        // is not pushed before the check-in; it ends now and warns.
        factory.WithDb(db =>
        {
            db.AttendanceDays.Add(new AttendanceDay { TenantId = w.Tenant, UserId = w.Owner.UserId, Date = AppDay.Today, CheckInAt = now.AddMinutes(-70), Mode = "Office" });
            db.TimeEntries.Add(new TimeEntry { TenantId = w.Tenant, TaskId = w.TaskA, ProjectId = w.Project, UserId = w.Owner.UserId, WorkDate = AppDay.Today, Minutes = 50,
                StartedAt = now.AddMinutes(-60), EndedAt = now.AddMinutes(-10), CreatedAt = now, CreatedBy = w.Owner.UserId });
            return db.SaveChanges();
        });
        var res = await w.Owner.Post($"/api/v1/tasks/{w.TaskB}/time", new { minutes = 30 });
        Assert.True(res.Ok, res.ToString());
        var start = DateTime.Parse(S(res.Data!["startedAt"])).ToUniversalTime();
        var end = DateTime.Parse(S(res.Data["endedAt"])).ToUniversalTime();
        Assert.True(start >= now.AddMinutes(-70).AddSeconds(-61), $"starts {start:o}, before the check-in");
        Assert.True(end >= now.AddMinutes(-1), $"ends {end:o}: now");
        Assert.StartsWith("Overlaps ", S(res.Data["warning"]));
    }
}
