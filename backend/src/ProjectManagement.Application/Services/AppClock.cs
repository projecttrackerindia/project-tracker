using Microsoft.Extensions.Options;
using NodaTime;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Features.Reminders;

namespace ProjectManagement.Application.Services;

/// <summary>
/// The time zone of the person this request is for (their profile's zone), set once per request by the context middleware. Empty for
/// background work and anonymous requests, which then use the workspace's or the platform's default zone.
/// </summary>
public class RequestZone
{
    /// <summary>The person's IANA zone ("Asia/Kolkata", "America/New_York").</summary>
    public string? UserZoneId { get; set; }
    /// <summary>The active workspace's default zone, used when the person has none.</summary>
    public string? WorkspaceZoneId { get; set; }
}

/// <summary>
/// UTC "now" plus the local "today" of whoever the request is for. Instants are always stored in UTC; date-only fields (due dates,
/// timesheet days, sprint days) are calendar days in the person's own time zone, so "overdue", "today" and "this week" mean the same
/// thing on every screen, report and reminder for that person, wherever the server runs.
/// </summary>
public class AppClock(TimeProvider time, IOptions<AppOptions> options, RequestZone? zone = null)
{
    public const string FallbackZoneId = "Asia/Kolkata";

    public DateTime Now => time.GetUtcNow().UtcDateTime;

    /// <summary>The platform's default zone (App:DefaultTimeZone). Older installs that only set App:TimeZoneOffsetMinutes keep a fixed offset.</summary>
    public DateTimeZone DefaultZone
    {
        get
        {
            var configured = options.Value.DefaultTimeZone;
            if (ZoneTime.IsKnown(configured)) return ZoneTime.Find(configured);
            var offset = options.Value.TimeZoneOffsetMinutes;
            return offset == 330 ? ZoneTime.Find(FallbackZoneId) : DateTimeZone.ForOffset(Offset.FromSeconds(offset * 60));
        }
    }

    /// <summary>The zone of this request's person, else their workspace's default, else the platform's.</summary>
    public DateTimeZone Zone =>
        ZoneTime.IsKnown(zone?.UserZoneId) ? ZoneTime.Find(zone!.UserZoneId)
        : ZoneTime.IsKnown(zone?.WorkspaceZoneId) ? ZoneTime.Find(zone!.WorkspaceZoneId)
        : DefaultZone;

    public string ZoneId => Zone.Id;

    /// <summary>The zone's current offset from UTC, in minutes (it can change with daylight saving: prefer <see cref="LocalDate"/>).</summary>
    public int OffsetMinutes => OffsetFor(Zone, Now);

    /// <summary>Today, in this request's person's zone.</summary>
    public DateOnly Today => TodayIn(Zone);

    /// <summary>Today in a given zone (background work that acts for a specific person or workspace).</summary>
    public DateOnly TodayIn(string? zoneId) => TodayIn(ZoneTime.IsKnown(zoneId) ? ZoneTime.Find(zoneId) : DefaultZone);

    public DateOnly TodayIn(DateTimeZone tz) => DateOnly.FromDateTime(ZoneTime.ToLocal(Now, tz));

    /// <summary>The calendar day an instant falls on, in this request's person's zone.</summary>
    public DateOnly LocalDate(DateTime utc) => DateOnly.FromDateTime(ZoneTime.ToLocal(utc, Zone));

    /// <summary>The instant a calendar day starts, in this request's person's zone.</summary>
    public DateTime StartOfDayUtc(DateOnly day) => ZoneTime.ToUtc(day.ToDateTime(TimeOnly.MinValue), Zone);

    public static int OffsetFor(DateTimeZone tz, DateTime utc) =>
        (int)(tz.GetUtcOffset(Instant.FromDateTimeUtc(DateTime.SpecifyKind(utc, DateTimeKind.Utc))).Seconds / 60);
}
