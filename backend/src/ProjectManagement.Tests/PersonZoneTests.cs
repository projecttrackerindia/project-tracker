using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// One zone per person for every day calculation: their own zone when it says where they are (or they chose it, UTC included), else the
/// organization's, else the platform's (Asia/Kolkata). A "UTC" that a desktop shell or a browser without a zone reported, or that a column
/// default left behind, counts as "not set" - so an Indian organization's Your day, reminders and time logging stay on India time.
/// </summary>
[Collection("api")]
public class PersonZoneTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private sealed class FixedTime(DateTimeOffset now) : TimeProvider { public override DateTimeOffset GetUtcNow() => now; }
    private static AppClock Clock(DateTimeOffset now, RequestZone? zone = null) => new(new FixedTime(now), Options.Create(new AppOptions()), zone);

    // ------------------------------------------------------------------ resolution order (pure)

    [Theory]
    [InlineData("America/New_York", false, "Asia/Dubai", "America/New_York")]   // the person's own zone wins
    [InlineData("UTC", false, "Asia/Dubai", "Asia/Dubai")]                      // a device's / column default's UTC falls back to the organization
    [InlineData("Etc/UTC", false, "Asia/Dubai", "Asia/Dubai")]
    [InlineData("Etc/GMT", false, null, "Asia/Kolkata")]                       // ... and without one, to the platform default
    [InlineData("", false, null, "Asia/Kolkata")]
    [InlineData(null, false, "Europe/London", "Europe/London")]
    [InlineData("Not/AZone", false, "Asia/Dubai", "Asia/Dubai")]
    [InlineData("UTC", true, "Asia/Dubai", "UTC")]                             // chosen by hand in settings: UTC it is
    [InlineData("UTC", false, "UTC", "UTC")]                                   // an organization set to UTC by its admin
    public void A_person_s_zone_is_their_own_then_the_organization_s_then_the_platform_s(string? user, bool chose, string? org, string expected)
    {
        Assert.Equal(expected, Clock(DateTimeOffset.UtcNow).ZoneIdFor(user, chose, org));
        var clock = Clock(DateTimeOffset.UtcNow, new RequestZone { UserZoneId = user, UserZoneChosen = chose, WorkspaceZoneId = org });
        Assert.Equal(expected, clock.ZoneId);
    }

    [Fact]
    public void Placeholder_zones_are_the_utc_family_and_unknown_names_only()
    {
        foreach (var z in new[] { "UTC", "Etc/UTC", "etc/utc", "GMT", "Etc/GMT", "Etc/Universal", "Zulu", "", null, "Mars/Olympus" })
            Assert.True(ZoneTime.IsPlaceholder(z), z ?? "null");
        foreach (var z in new[] { "Asia/Kolkata", "Asia/Calcutta", "Europe/London", "Africa/Abidjan" })
            Assert.False(ZoneTime.IsPlaceholder(z), z);
    }

    [Fact]
    public void Day_boundaries_follow_India_when_the_profile_only_holds_a_reported_UTC()
    {
        // 19:00 UTC on 28 Oct is 00:30 on 29 Oct in India.
        var at = new DateTimeOffset(2026, 10, 28, 19, 0, 0, TimeSpan.Zero);
        var clock = Clock(at, new RequestZone { UserZoneId = "UTC", UserZoneChosen = false, WorkspaceZoneId = null });
        Assert.Equal("Asia/Kolkata", clock.ZoneId);
        Assert.Equal(new DateOnly(2026, 10, 29), clock.Today);
        Assert.Equal(new DateTime(2026, 10, 28, 18, 30, 0, DateTimeKind.Utc), clock.StartOfDayUtc(new DateOnly(2026, 10, 29)));
        Assert.Equal(new TimeOnly(0, 30), clock.TimeOfDay);
        // Due today at 23:00 India time has not passed; due yesterday has.
        Assert.False(clock.IsPastDue(new DateOnly(2026, 10, 29), new TimeOnly(23, 0)));
        Assert.True(clock.IsPastDue(new DateOnly(2026, 10, 28), null));

        // The same person, had they chosen UTC by hand, is still on the 28th.
        var utc = Clock(at, new RequestZone { UserZoneId = "UTC", UserZoneChosen = true });
        Assert.Equal(new DateOnly(2026, 10, 28), utc.Today);
    }

    // ------------------------------------------------------------------ the API

    private async Task<(TestClient Owner, Guid Tenant)> Setup(string name)
    {
        var owner = await TestClient.RegisterAsync(factory, name);
        var tid = await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        return (owner, tid);
    }

    private void SetZones(Guid user, string? userZone, Guid? tenant = null, string? orgZone = null) => factory.WithDb(db =>
    {
        db.Users.First(u => u.Id == user).TimeZone = userZone!;
        if (tenant is { } t) db.Tenants.IgnoreQueryFilters().First(x => x.Id == t).TimeZone = orgZone;
        return db.SaveChanges();
    });

    [Fact]
    public async Task The_context_carries_the_effective_zone_and_a_reported_UTC_falls_back_to_the_organization()
    {
        var (owner, tid) = await Setup("Kavya Zone");
        // A desktop shell reported UTC into the profile; the organization has no zone of its own: the platform's India time applies.
        SetZones(owner.UserId, "UTC", tid, null);
        var me = (await owner.Get("/api/v1/me")).Data!;
        Assert.Equal("UTC", S(me["user"]!["timeZone"]));
        Assert.Equal("Asia/Kolkata", S(me["timeZone"]));
        Assert.False(me["timeZoneChosen"]!.GetValue<bool>());

        // The organization is set to Dubai: the person follows it.
        SetZones(owner.UserId, "Etc/UTC", tid, "Asia/Dubai");
        Assert.Equal("Asia/Dubai", S((await owner.Get("/api/v1/me")).Data!["timeZone"]));

        // Their own real zone always wins.
        SetZones(owner.UserId, "America/New_York", tid, "Asia/Dubai");
        Assert.Equal("America/New_York", S((await owner.Get("/api/v1/me")).Data!["timeZone"]));

        // Choosing UTC by hand in settings counts (and stops following the device).
        var saved = await owner.Put("/api/v1/me", new { displayName = "Kavya Zone", timeZone = "UTC" });
        Assert.True(saved.Ok, saved.ToString());
        var after = (await owner.Get("/api/v1/me")).Data!;
        Assert.Equal("UTC", S(after["timeZone"]));
        Assert.True(after["timeZoneChosen"]!.GetValue<bool>());
        Assert.False((await owner.Get("/api/v1/reminders/settings")).Data!["followDeviceTimeZone"]!.GetValue<bool>());
    }

    [Fact]
    public async Task A_device_reporting_UTC_never_replaces_the_person_s_zone()
    {
        var (owner, _) = await Setup("Arjun Device");
        SetZones(owner.UserId, "Asia/Kolkata");
        foreach (var reported in new[] { "UTC", "Etc/UTC" })
        {
            var res = await owner.Put("/api/v1/reminders/time-zone", new { timeZone = reported });
            Assert.True(res.Ok, res.ToString());
            Assert.Equal("Asia/Kolkata", S(res.Data!["timeZone"]));
        }
        Assert.Equal("Asia/Kolkata", factory.WithDb(db => db.Users.AsNoTracking().First(u => u.Id == owner.UserId).TimeZone));
        // A real zone still moves with the device.
        Assert.Equal("Europe/London", S((await owner.Put("/api/v1/reminders/time-zone", new { timeZone = "Europe/London" })).Data!["timeZone"]));
    }

    [Fact]
    public async Task Reminders_without_a_zone_are_written_in_India_time_when_the_profile_holds_a_reported_UTC()
    {
        var (owner, tid) = await Setup("Meera Remind");
        SetZones(owner.UserId, "UTC", tid, null);
        // Settings show the zone reminders really use.
        Assert.Equal("Asia/Kolkata", S((await owner.Get("/api/v1/reminders/settings")).Data!["timeZone"]));

        var day = AppDay.Today.AddDays(3).ToString("yyyy-MM-dd");
        var res = await owner.Post("/api/v1/reminders", new { title = "Send the settlement file", when = new { at = $"{day}T09:00" } });
        Assert.True(res.Ok, res.ToString());
        Assert.Equal("Asia/Kolkata", S(res.Data!["timeZone"]));
        var fire = DateTime.Parse(S(res.Data["nextFireAt"])).ToUniversalTime();
        Assert.Equal(new TimeOnly(3, 30), TimeOnly.FromDateTime(fire));   // 09:00 in India
    }

    [Fact]
    public async Task Time_logged_for_today_is_placed_after_the_India_work_start_not_the_UTC_one()
    {
        // Needs India time past 10:45 so the day has a 40-minute gap after its 09:30 start.
        var local = DateTime.UtcNow.AddMinutes(AppDay.OffsetMinutes);
        if (local.TimeOfDay < new TimeSpan(10, 45, 0)) return;
        var (owner, tid) = await Setup("Rohan Floor");
        SetZones(owner.UserId, "UTC", tid, null);   // the profile only holds a reported UTC
        var project = await owner.CreateProjectAsync("Settlement Revamp");
        var a = Guid.Parse(S((await owner.CreateTaskAsync(project, "Reconcile payouts", new { title = "Reconcile payouts", assigneeId = owner.UserId }))["id"]));
        var b = Guid.Parse(S((await owner.CreateTaskAsync(project, "Review refunds", new { title = "Review refunds", assigneeId = owner.UserId }))["id"]));
        var now = DateTime.UtcNow;
        var today = AppDay.Today;
        // Busy from 10:10 India time until a minute ago, no check-in; the work start is 09:30 India time.
        var dayStartUtc = DateTime.SpecifyKind(today.ToDateTime(TimeOnly.MinValue).AddMinutes(-AppDay.OffsetMinutes), DateTimeKind.Utc);
        var busyStart = dayStartUtc.AddHours(10).AddMinutes(10);
        factory.WithDb(db =>
        {
            db.TimeEntries.Add(new TimeEntry { TenantId = tid, TaskId = a, ProjectId = project, UserId = owner.UserId, WorkDate = today,
                Minutes = (int)(now.AddMinutes(-1) - busyStart).TotalMinutes, StartedAt = busyStart, EndedAt = now.AddMinutes(-1), CreatedAt = now, CreatedBy = owner.UserId });
            return db.SaveChanges();
        });
        var res = await owner.Post($"/api/v1/tasks/{b}/time", new { minutes = 30 });
        Assert.True(res.Ok, res.ToString());
        var start = DateTime.Parse(S(res.Data!["startedAt"])).ToUniversalTime();
        var end = DateTime.Parse(S(res.Data["endedAt"])).ToUniversalTime();
        // The 09:30-10:10 India-time gap holds it: it ends when the other starts.
        Assert.True(Math.Abs((end - busyStart).TotalSeconds) < 61, $"ends {end:o}, the other starts {busyStart:o}");
        Assert.True(start >= dayStartUtc.AddHours(9).AddMinutes(29), $"starts {start:o}");
    }
}
