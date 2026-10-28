using System.Diagnostics;
using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// GET /api/v1/timeline: the one day/week timeline Today and the Calendar share. Work finished, calls held, time logged (timer and typed-in),
/// attendance, reminders and meetings land on the right day in the person's zone (Asia/Kolkata here, with the server on UTC), and the same
/// permission rules as the underlying records apply.
/// </summary>
[Collection("api")]
public class TimelineTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private static readonly NodaTime.DateTimeZone Kolkata = ZoneTime.Find("Asia/Kolkata");
    private static DateOnly TodayIst => DateOnly.FromDateTime(ZoneTime.ToLocal(DateTime.UtcNow, Kolkata));
    private static DateTime Ist(DateOnly d, int h, int m) => DateTime.SpecifyKind(ZoneTime.ToUtc(ZoneTime.At(d, new TimeOnly(h, m)), Kolkata), DateTimeKind.Utc);
    private static string Iso(DateOnly d) => d.ToString("yyyy-MM-dd");

    private sealed record World(TestClient Owner, TestClient Peer, Guid Tenant, Guid Project, Guid Task, DateOnly Day);

    private async Task<World> Setup()
    {
        var owner = await TestClient.RegisterAsync(factory, "Tara Timeline");
        var tid = await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var peer = await owner.AddMemberAsync(factory, TenantRole.Member, "Pavan Peer");
        var project = await owner.CreateProjectAsync("Infra Upgrade");
        var task = Guid.Parse(S((await owner.CreateTaskAsync(project, "Patch the gateway", new { title = "Patch the gateway", priority = "High", assigneeId = owner.UserId }))["id"]));
        var day = TodayIst.AddDays(-1);
        factory.WithDb(db =>
        {
            db.Tenants.IgnoreQueryFilters().First(t => t.Id == tid).TimeZone = "Asia/Kolkata";
            db.Users.First(u => u.Id == owner.UserId).TimeZone = "Asia/Kolkata";
            // Finished late in the evening, India time: 23:50 IST is 18:20 UTC the same day, never the next day.
            var done = db.WorkflowStatuses.IgnoreQueryFilters().First(s => s.ProjectId == project && s.Category == StatusCategory.Done);
            db.Tasks.IgnoreQueryFilters().First(x => x.Id == task).StatusId = done.Id;
            return db.SaveChanges();
        });
        factory.WithDb(db =>
        {
            db.Tasks.IgnoreQueryFilters().First(x => x.Id == task).CompletedAt = Ist(day, 23, 50);
            var call = new CallRoom { TenantId = tid, Title = "Gateway war room", RoomName = $"pt-{Guid.NewGuid():N}", Kind = "project", ProjectId = project,
                StartedBy = owner.UserId, StartedAt = Ist(day, 11, 0), EndedAt = Ist(day, 11, 40), Status = "ended", PeakParticipants = 2 };
            db.CallRooms.Add(call);
            db.CallParticipants.Add(new CallParticipant { TenantId = tid, CallId = call.Id, UserId = owner.UserId, Role = "host", JoinedAt = call.StartedAt, LeftAt = call.EndedAt, Seconds = 2400 });
            db.CallParticipants.Add(new CallParticipant { TenantId = tid, CallId = call.Id, UserId = peer.UserId, Role = "member", JoinedAt = call.StartedAt, LeftAt = call.EndedAt, Seconds = 2400 });
            db.TimeEntries.Add(new TimeEntry { TenantId = tid, TaskId = task, ProjectId = project, UserId = owner.UserId, WorkDate = day, Minutes = 60,
                StartedAt = Ist(day, 14, 0), EndedAt = Ist(day, 15, 0) });
            db.TimeEntries.Add(new TimeEntry { TenantId = tid, TaskId = task, ProjectId = project, UserId = owner.UserId, WorkDate = day, Minutes = 90, Note = "Typed in", CreatedAt = DateTime.UtcNow });
            db.AttendanceDays.Add(new AttendanceDay { TenantId = tid, UserId = owner.UserId, Date = day, CheckInAt = Ist(day, 9, 30), CheckOutAt = Ist(day, 18, 45), Mode = "Office" });
            db.Reminders.Add(new Reminder { TenantId = tid, UserId = owner.UserId, Title = "Send the patch notes", TimeZone = "Asia/Kolkata",
                State = ReminderState.Fired, LastFiredAt = Ist(day, 16, 30), FireCount = 1 });
            return db.SaveChanges();
        });
        return new World(owner, peer, tid, project, task, day);
    }

    private static JsonArray Events(ApiResult r) => r.Data!["events"]!.AsArray();

    [Fact]
    public async Task A_day_carries_done_work_calls_time_attendance_and_reminders_on_the_persons_own_day()
    {
        var w = await Setup();
        var res = await w.Owner.Get($"/api/v1/timeline?from={Iso(w.Day)}&to={Iso(w.Day)}&scope=me");
        Assert.True(res.Ok, res.ToString());
        Assert.Equal("Asia/Kolkata", S(res.Data!["timeZone"]));
        var ev = Events(res);

        var done = ev.Single(e => S(e!["type"]) == "done");
        Assert.Equal(w.Task.ToString(), S(done!["sourceId"]));
        Assert.Equal(Iso(w.Day), S(done["date"]));
        Assert.Equal("Patch the gateway", S(done["title"]));
        Assert.Equal("Infra Upgrade", S(done["projectName"]));
        Assert.Matches(@"^[A-Z0-9]+-\d+$", S(done["key"]));
        Assert.Equal($"/work?item={w.Task}", S(done["link"]));

        var call = ev.Single(e => S(e!["type"]) == "call");
        Assert.Equal("Gateway war room", S(call!["title"]));
        Assert.Contains("Pavan Peer", call["people"]!.AsArray().Select(S));
        Assert.Equal(Ist(w.Day, 11, 0), call["start"]!.GetValue<DateTime>().ToUniversalTime());

        var time = ev.Where(e => S(e!["type"]) == "time").ToList();
        Assert.Equal(2, time.Count);
        Assert.Contains(time, t => !t!["approximated"]!.GetValue<bool>() && t["start"]!.GetValue<DateTime>().ToUniversalTime() == Ist(w.Day, 14, 0));
        var typed = time.Single(t => t!["approximated"]!.GetValue<bool>())!;
        Assert.Equal(90, typed["minutes"]!.GetValue<int>());
        // Typed in today about yesterday: placed from yesterday's check-in, on yesterday.
        Assert.Equal(Iso(w.Day), S(typed["date"]));
        Assert.Equal(Ist(w.Day, 9, 30), typed["start"]!.GetValue<DateTime>().ToUniversalTime());

        Assert.Single(ev, e => S(e!["type"]) == "attendance");
        Assert.Single(ev, e => S(e!["type"]) == "reminder" && S(e!["status"]) == "fired");
    }

    [Fact]
    public async Task Work_finished_at_23_50_IST_is_not_on_the_next_day()
    {
        var w = await Setup();
        var next = Events(await w.Owner.Get($"/api/v1/timeline?from={Iso(w.Day.AddDays(1))}&to={Iso(w.Day.AddDays(1))}"));
        Assert.DoesNotContain(next, e => S(e!["type"]) == "done");
        Assert.DoesNotContain(next, e => S(e!["type"]) == "call");
        var week = Events(await w.Owner.Get($"/api/v1/timeline?from={Iso(w.Day.AddDays(-3))}&to={Iso(w.Day.AddDays(1))}"));
        Assert.Equal(Iso(w.Day), S(week.Single(e => S(e!["type"]) == "done")!["date"]));
    }

    [Fact]
    public async Task Open_work_shows_as_due_and_scheduled_meetings_show_at_their_time()
    {
        var w = await Setup();
        var due = TodayIst.AddDays(1);
        var open = Guid.Parse(S((await w.Owner.CreateTaskAsync(w.Project, "Rotate the certificates", new { title = "Rotate the certificates", priority = "High", assigneeId = w.Owner.UserId, dueDate = Iso(due) }))["id"]));
        var start = Ist(due, 15, 0);
        factory.WithDb(db =>
        {
            db.ProjectMeetings.Add(new ProjectMeeting { TenantId = w.Tenant, ProjectId = w.Project, OrganizerUserId = w.Owner.UserId, Title = "Cutover review",
                StartTimeUtc = start, EndTimeUtc = start.AddMinutes(45), TimeZone = "Asia/Kolkata", GoogleCalendarEventId = "tl-" + Guid.NewGuid().ToString("N"), CreatedAt = DateTime.UtcNow });
            return db.SaveChanges();
        });

        var ev = Events(await w.Owner.Get($"/api/v1/timeline?from={Iso(due)}&to={Iso(due)}"));
        var d = ev.Single(e => S(e!["type"]) == "due" && S(e!["sourceId"]) == open.ToString())!;
        Assert.True(d["allDay"]!.GetValue<bool>());
        Assert.False(d["overdue"]!.GetValue<bool>());
        var m = ev.Single(e => S(e!["type"]) == "meeting")!;
        Assert.Equal("Cutover review", S(m["title"]));
        Assert.Equal(start, m["start"]!.GetValue<DateTime>().ToUniversalTime());
        Assert.Equal(start.AddMinutes(45), m["end"]!.GetValue<DateTime>().ToUniversalTime());
    }

    [Fact]
    public async Task Scope_follows_the_calendar_rules_and_reminders_and_calls_stay_private()
    {
        var w = await Setup();
        // A member cannot open the owner's day.
        Assert.Equal(HttpStatusCode.Forbidden, (await w.Peer.Get($"/api/v1/timeline?from={Iso(w.Day)}&to={Iso(w.Day)}&scope=user&userId={w.Owner.UserId}")).Status);
        // Their own day has the call they were in, but not the owner's reminder, time or finished work.
        var mine = Events(await w.Peer.Get($"/api/v1/timeline?from={Iso(w.Day)}&to={Iso(w.Day)}"));
        Assert.Single(mine, e => S(e!["type"]) == "call");
        Assert.DoesNotContain(mine, e => S(e!["type"]) is "reminder" or "time" or "done" or "attendance");
        // The owner (broad access) may look at the member's day: no reminders of theirs ever show.
        var theirs = Events(await w.Owner.Get($"/api/v1/timeline?from={Iso(w.Day)}&to={Iso(w.Day)}&scope=user&userId={w.Peer.UserId}"));
        Assert.DoesNotContain(theirs, e => S(e!["type"]) == "reminder");
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await w.Owner.Get($"/api/v1/timeline?from={Iso(w.Day)}&to={Iso(w.Day.AddDays(90))}")).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await w.Owner.Get($"/api/v1/timeline?from={Iso(w.Day)}&to={Iso(w.Day)}&scope=everyone")).Status);
    }

    [Fact]
    public async Task A_busy_week_is_read_quickly()
    {
        var w = await Setup();
        factory.WithDb(db =>
        {
            for (var i = 0; i < 40; i++)
                db.TimeEntries.Add(new TimeEntry { TenantId = w.Tenant, TaskId = w.Task, ProjectId = w.Project, UserId = w.Owner.UserId, WorkDate = w.Day.AddDays(-(i % 5)), Minutes = 15, CreatedAt = DateTime.UtcNow });
            return db.SaveChanges();
        });
        var url = $"/api/v1/timeline?from={Iso(w.Day.AddDays(-6))}&to={Iso(w.Day)}";
        Assert.True((await w.Owner.Get(url)).Ok);   // warm up
        var best = long.MaxValue;
        for (var i = 0; i < 3; i++)
        {
            var sw = Stopwatch.StartNew();
            var r = await w.Owner.Get(url);
            sw.Stop();
            Assert.True(r.Ok, r.ToString());
            Assert.True(Events(r).Count(e => S(e!["type"]) == "time") >= 42);
            best = Math.Min(best, sw.ElapsedMilliseconds);
        }
        Assert.True(best < 300, $"A busy week took {best} ms");
    }
}
