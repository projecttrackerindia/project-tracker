using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Features.Attendance;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Attendance (/api/v1/me/attendance, /api/v1/attendance): check in (office, home or a client's office), check out with the day's summary,
/// correct today only, on the organization's clock whatever the person's own zone; managers see their team, members only themselves; the
/// workspace's rules; and the reminder worker (check in?, still checked in?, auto-close) with a fixed clock.
/// </summary>
[Collection("api")]
public class AttendanceTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private static int I(JsonNode? n) => n!.GetValue<int>();
    private static bool B(JsonNode? n) => n!.GetValue<bool>();
    private static readonly NodaTime.DateTimeZone Kolkata = ZoneTime.Find("Asia/Kolkata");

    private sealed record Team(TestClient Owner, TestClient Manager, TestClient Dev, TestClient Peer, Guid TenantId);

    private async Task<Team> Setup()
    {
        var owner = await TestClient.RegisterAsync(factory, "Olivia Owner");
        var tid = await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var manager = await owner.AddMemberAsync(factory, TenantRole.Manager, "Maya Manager");
        var dev = await owner.AddMemberAsync(factory, TenantRole.Member, "Dev Developer");
        var peer = await owner.AddMemberAsync(factory, TenantRole.Member, "Pat Peer");
        Assert.True((await owner.Put($"/api/v1/org/members/{dev.UserId}/reports-to", new { reportsToUserId = manager.UserId })).Ok);
        // The workspace runs on India time; the developer's own profile (and browser) is in California.
        factory.WithDb(db =>
        {
            db.Tenants.IgnoreQueryFilters().First(t => t.Id == tid).TimeZone = "Asia/Kolkata";
            db.Users.First(u => u.Id == dev.UserId).TimeZone = "America/Los_Angeles";
            return db.SaveChanges();
        });
        return new Team(owner, manager, dev, peer, tid);
    }

    [Fact]
    public async Task Check_in_and_out_follow_the_organization_clock_and_validate_the_place()
    {
        var t = await Setup();
        var today = await t.Dev.Get("/api/v1/me/attendance/today");
        Assert.True(today.Ok, today.ToString());
        // "Today" is India's date, not California's.
        Assert.Equal(DateOnly.FromDateTime(ZoneTime.ToLocal(DateTime.UtcNow, Kolkata)).ToString("yyyy-MM-dd"), S(today.Data!["date"]));
        Assert.Equal("Asia/Kolkata", S(today.Data["timeZone"]));
        Assert.Null(today.Data["record"]);
        Assert.Equal(3, today.Data["policy"]!["allowedModes"]!.AsArray().Count);

        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await t.Dev.Post("/api/v1/me/attendance/check-in", new { mode = "ClientSite" })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await t.Dev.Post("/api/v1/me/attendance/check-in", new { mode = "Beach" })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await t.Dev.Post("/api/v1/me/attendance/check-in", new { mode = "Home", note = new string('x', 301) })).Status);
        var inn = await t.Dev.Post("/api/v1/me/attendance/check-in", new { mode = "ClientSite", place = "Northwind Traders, Hitech City", note = "Sprint demo", source = "phone" });
        Assert.Equal(HttpStatusCode.Created, inn.Status);
        Assert.Equal("ClientSite", S(inn.Data!["mode"]));
        Assert.Equal("phone", S(inn.Data["source"]));
        Assert.Equal(HttpStatusCode.Conflict, (await t.Dev.Post("/api/v1/me/attendance/check-in", new { mode = "Office" })).Status);

        var after = (await t.Dev.Get("/api/v1/me/attendance/today")).Data!;
        Assert.False(B(after["shouldPrompt"]));
        Assert.Equal("Northwind Traders, Hitech City", S(after["record"]!["place"]));
        Assert.Contains("Northwind Traders, Hitech City", after["recentPlaces"]!.AsArray().Select(S));

        var outt = await t.Dev.Post("/api/v1/me/attendance/check-out", new { note = "Demo went well" });
        Assert.True(outt.Ok, outt.ToString());
        Assert.NotNull(outt.Data!["day"]!["checkOutAt"]);
        Assert.Equal(0, I(outt.Data["tasksDone"]));
        Assert.Contains("Demo went well", S(outt.Data["day"]!["note"]));
        Assert.Equal(HttpStatusCode.Conflict, (await t.Dev.Post("/api/v1/me/attendance/check-out", new { })).Status);
    }

    [Fact]
    public async Task Only_todays_own_day_can_be_corrected()
    {
        var t = await Setup();
        Assert.Equal(HttpStatusCode.Created, (await t.Peer.Post("/api/v1/me/attendance/check-in", new { mode = "Office" })).Status);
        var date = S((await t.Peer.Get("/api/v1/me/attendance/today")).Data!["date"]);
        var fixedDay = await t.Peer.Put($"/api/v1/me/attendance/{date}", new { mode = "Home", note = "Worked from home after all" });
        Assert.True(fixedDay.Ok, fixedDay.ToString());
        Assert.Equal("Home", S(fixedDay.Data!["mode"]));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await t.Peer.Put($"/api/v1/me/attendance/{date}", new { checkIn = "10:00", checkOut = "09:00" })).Status);
        var yesterday = DateOnly.Parse(date).AddDays(-1).ToString("yyyy-MM-dd");
        Assert.Equal(HttpStatusCode.Forbidden, (await t.Peer.Put($"/api/v1/me/attendance/{yesterday}", new { mode = "Office" })).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await t.Dev.Put($"/api/v1/me/attendance/{date}", new { mode = "Office" })).Status);
    }

    [Fact]
    public async Task Managers_see_their_team_and_members_only_themselves()
    {
        var t = await Setup();
        Assert.Equal(HttpStatusCode.Created, (await t.Dev.Post("/api/v1/me/attendance/check-in", new { mode = "Home" })).Status);
        Assert.Equal(HttpStatusCode.Created, (await t.Peer.Post("/api/v1/me/attendance/check-in", new { mode = "Office" })).Status);
        var date = S((await t.Dev.Get("/api/v1/me/attendance/today")).Data!["date"]);

        Assert.Equal(HttpStatusCode.Forbidden, (await t.Peer.Get($"/api/v1/attendance?from={date}&to={date}&scope=team")).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await t.Peer.Get("/api/v1/attendance/team/today")).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await t.Peer.Get($"/api/v1/attendance?from={date}&to={date}&userId={t.Dev.UserId}")).Status);
        Assert.False(B((await t.Peer.Get("/api/v1/me/attendance/today")).Data!["canViewTeam"]));
        var mine = await t.Peer.Get($"/api/v1/attendance?from={date}&to={date}");
        Assert.Single(mine.Data!.AsArray());

        var team = await t.Manager.Get($"/api/v1/attendance?from={date}&to={date}&scope=team");
        Assert.True(team.Ok, team.ToString());
        var rows = team.Data!.AsArray();
        Assert.Contains(rows, r => S(r!["userId"]) == t.Dev.UserId.ToString() && S(r["mode"]) == "Home");
        Assert.DoesNotContain(rows, r => S(r!["userId"]) == t.Peer.UserId.ToString());   // not in the manager's line
        Assert.Equal(HttpStatusCode.Forbidden, (await t.Manager.Get($"/api/v1/attendance?from={date}&to={date}&userId={t.Peer.UserId}")).Status);
        Assert.True(B((await t.Manager.Get("/api/v1/me/attendance/today")).Data!["canViewTeam"]));

        var everyone = (await t.Owner.Get("/api/v1/attendance/team/today")).Data!;
        Assert.Equal(1, I(everyone["home"]));
        Assert.Equal(1, I(everyone["office"]));
        Assert.Equal(2, I(everyone["notIn"]));
    }

    [Fact]
    public async Task Admins_set_the_rules_and_check_in_follows_them()
    {
        var t = await Setup();
        Assert.Equal(HttpStatusCode.Forbidden, (await t.Manager.Put("/api/v1/attendance/settings", new { enabled = false })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await t.Owner.Put("/api/v1/attendance/settings", new { workStart = "18:00", workEnd = "09:00" })).Status);
        var saved = await t.Owner.Put("/api/v1/attendance/settings", new { allowedModes = new[] { "Office", "Home" }, workStart = "10:00", workEnd = "19:00", checkInGraceMinutes = 15, requireClientPlace = false });
        Assert.True(saved.Ok, saved.ToString());
        Assert.Equal("10:00", S(saved.Data!["workStart"]));
        Assert.Equal(2, saved.Data["allowedModes"]!.AsArray().Count);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await t.Dev.Post("/api/v1/me/attendance/check-in", new { mode = "ClientSite", place = "Contoso" })).Status);
        Assert.Equal("10:00", S((await t.Dev.Get("/api/v1/me/attendance/today")).Data!["workStart"]));

        Assert.True((await t.Owner.Put("/api/v1/attendance/settings", new { enabled = false })).Ok);
        Assert.Equal(HttpStatusCode.Conflict, (await t.Dev.Post("/api/v1/me/attendance/check-in", new { mode = "Office" })).Status);
        Assert.False(B((await t.Dev.Get("/api/v1/me/attendance/today")).Data!["shouldPrompt"]));
    }

    private sealed class FixedTime(DateTimeOffset now) : TimeProvider { public override DateTimeOffset GetUtcNow() => now; }

    [Fact]
    public async Task The_worker_reminds_once_skips_leave_and_weekends_and_closes_forgotten_days()
    {
        var t = await Setup();
        // A Wednesday at least a week ahead (no holidays were added to this workspace).
        var day = DateOnly.FromDateTime(DateTime.UtcNow).AddDays(7);
        while (day.DayOfWeek != DayOfWeek.Wednesday) day = day.AddDays(1);
        DateTimeOffset At(DateOnly d, int h, int m) => new(ZoneTime.ToUtc(ZoneTime.At(d, new TimeOnly(h, m)), Kolkata), TimeSpan.Zero);
        var people = new[] { t.Dev.UserId, t.Peer.UserId, t.Manager.UserId };
        void SeenAt(DateTimeOffset when) => factory.WithDb(db =>
        {
            foreach (var s in db.UserSessions.Where(s => people.Contains(s.UserId))) s.LastSeenAt = when.UtcDateTime;
            return db.SaveChanges();
        });
        factory.WithDb(db =>
        {
            // The peer is on leave that day.
            db.PlannedLeaves.Add(new PlannedLeave { TenantId = t.TenantId, UserId = t.Peer.UserId, WorkDate = day, RequestId = Guid.NewGuid(), CreatedAt = DateTime.UtcNow });
            return db.SaveChanges();
        });

        async Task Run(DateTimeOffset now)
        {
            using var scope = factory.Services.CreateScope();
            var sp = scope.ServiceProvider;
            var clock = new AppClock(new FixedTime(now), sp.GetRequiredService<IOptions<AppOptions>>());
            await new AttendanceMonitor(sp.GetRequiredService<IAppDbContext>(), clock, sp.GetRequiredService<NotificationRouter>(), NullLogger<AttendanceMonitor>.Instance).RunAsync();
        }
        int Count(Guid user, string prefix) => factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Count(n => n.UserId == user && n.DedupeKey != null && n.DedupeKey.StartsWith(prefix)));

        // 09:45: within the grace (start 09:30 + 30 minutes) - nothing yet.
        SeenAt(At(day, 9, 0));
        await Run(At(day, 9, 45));
        Assert.Equal(0, Count(t.Dev.UserId, "att-in:"));
        // 10:05: the developer and the manager used the app today and are not checked in; the peer is on leave; the owner was not seen today.
        await Run(At(day, 10, 5));
        await Run(At(day, 10, 20));
        Assert.Equal(1, Count(t.Dev.UserId, "att-in:"));
        Assert.Equal(1, Count(t.Manager.UserId, "att-in:"));
        Assert.Equal(0, Count(t.Peer.UserId, "att-in:"));
        Assert.Equal(0, Count(t.Owner.UserId, "att-in:"));
        var note = factory.WithDb(db => db.Notifications.IgnoreQueryFilters().First(n => n.UserId == t.Dev.UserId && n.DedupeKey!.StartsWith("att-in:")));
        Assert.Equal("Good morning — check in?", note.Title);
        Assert.Equal(NotificationType.Reminder, note.Type);

        // The developer checks in at 10:10 and forgets to check out.
        factory.WithDb(db =>
        {
            db.AttendanceDays.Add(new AttendanceDay { TenantId = t.TenantId, UserId = t.Dev.UserId, Date = day, CheckInAt = At(day, 10, 10).UtcDateTime, Mode = "Office", CreatedAt = DateTime.UtcNow });
            return db.SaveChanges();
        });
        await Run(At(day, 18, 45));                    // before the end (18:30) + 30 minutes
        Assert.Equal(0, Count(t.Dev.UserId, "att-out:"));
        await Run(At(day, 19, 5));
        await Run(At(day, 19, 30));
        Assert.Equal(1, Count(t.Dev.UserId, "att-out:"));
        Assert.Equal(0, Count(t.Manager.UserId, "att-out:"));   // never checked in: nothing to close

        // 22:35: four hours after the end, the day is closed at 18:30 and the developer is told.
        await Run(At(day, 22, 35));
        var closed = factory.WithDb(db => db.AttendanceDays.IgnoreQueryFilters().First(a => a.UserId == t.Dev.UserId && a.Date == day));
        Assert.True(closed.AutoClosed);
        Assert.Equal(At(day, 18, 30).UtcDateTime, closed.CheckOutAt);
        Assert.Equal(1, Count(t.Dev.UserId, "att-auto:"));
        await Run(At(day, 23, 0));
        Assert.Equal(1, Count(t.Dev.UserId, "att-auto:"));

        // Saturday: no "check in?" for anyone.
        var saturday = day.AddDays(3);
        SeenAt(At(saturday, 9, 0));
        await Run(At(saturday, 10, 30));
        Assert.Equal(1, Count(t.Dev.UserId, "att-in:"));
        Assert.Equal(1, Count(t.Manager.UserId, "att-in:"));
    }

    [Fact]
    public void Personal_hours_are_used_only_when_the_workspace_says_so()
    {
        var policy = new AttendancePolicy { WorkStart = new TimeOnly(9, 30), WorkEnd = new TimeOnly(18, 30) };
        var own = new ReminderSettings { WorkStart = new TimeOnly(7, 0), WorkEnd = new TimeOnly(15, 0), WorkDays = "1,2,3,4,5,6" };
        Assert.Equal(new TimeOnly(9, 30), AttendanceHours.For(policy, own).Start);
        policy.HoursSource = "personal";
        var h = AttendanceHours.For(policy, own);
        Assert.Equal(new TimeOnly(7, 0), h.Start);
        Assert.True(h.IsWorkingDay(new DateOnly(2026, 11, 21)));   // a Saturday is a working day for them
        Assert.Equal(new TimeOnly(9, 30), AttendanceHours.For(policy, null).Start);
    }
}
