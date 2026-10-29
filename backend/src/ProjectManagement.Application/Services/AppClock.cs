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
    /// <summary>
    /// The person chose <see cref="UserZoneId"/> by hand (they turned "Follow this device" off). Only then does a UTC profile zone count:
    /// otherwise UTC is a device report or a column default, and the workspace's zone applies instead.
    /// </summary>
    public bool UserZoneChosen { get; set; }
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
    public DateTimeZone Zone => ZoneFor(zone?.UserZoneId, zone?.UserZoneChosen == true, zone?.WorkspaceZoneId);

    /// <summary>
    /// The one zone a person's day is worked out in: their own zone when it says where they are (or they chose it, UTC included), else the
    /// organization's zone, else the platform's default (Asia/Kolkata). The same order runs in the browser (lib/zone.ts).
    /// </summary>
    public DateTimeZone ZoneFor(string? userZoneId, bool userChoseIt, string? workspaceZoneId) =>
        PersonZoneId(userZoneId, userChoseIt, workspaceZoneId) is { } id ? ZoneTime.Find(id) : DefaultZone;

    /// <summary>The same as an IANA name.</summary>
    public string ZoneIdFor(string? userZoneId, bool userChoseIt, string? workspaceZoneId) => ZoneFor(userZoneId, userChoseIt, workspaceZoneId).Id;

    /// <summary>The same for background work that has the person's reminder settings at hand ("Follow this device" off = they chose the zone).</summary>
    public string ZoneIdFor(string? userZoneId, ProjectManagement.Domain.Entities.ReminderSettings? settings, string? workspaceZoneId) =>
        ZoneIdFor(userZoneId, Chose(settings), workspaceZoneId);

    /// <summary>A person picked their zone by hand: their reminder settings exist with "Follow this device" off.</summary>
    public static bool Chose(ProjectManagement.Domain.Entities.ReminderSettings? settings) => settings is { FollowDeviceTimeZone: false };

    /// <summary>The person's or the workspace's zone that applies (null = neither, the platform default applies). See <see cref="ZoneFor"/>.</summary>
    public static string? PersonZoneId(string? userZoneId, bool userChoseIt, string? workspaceZoneId)
    {
        if (ZoneTime.IsKnown(userZoneId) && (userChoseIt || !ZoneTime.IsPlaceholder(userZoneId))) return userZoneId!.Trim();
        // An organization's zone is only ever set by an administrator on purpose, so UTC there is a choice.
        if (ZoneTime.IsKnown(workspaceZoneId)) return workspaceZoneId!.Trim();
        return null;
    }

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

    /// <summary>The time of day now, in this request's person's zone.</summary>
    public TimeOnly TimeOfDay => TimeOnly.FromDateTime(ZoneTime.ToLocal(Now, Zone));

    /// <summary>
    /// The instant a due date and time of day fall on (read in this request's person's zone, like every date-only field). Null without a
    /// date or without a time: a date-only due means "by the end of that day".
    /// </summary>
    public DateTime? DueAt(DateOnly? day, TimeOnly? at) => day is { } d && at is { } t ? ZoneTime.ToUtc(ZoneTime.At(d, t), Zone) : null;

    /// <summary>A due date (and optional time) that has passed: before today, or today at a time already gone.</summary>
    public bool IsPastDue(DateOnly? day, TimeOnly? at) => day is { } d && (d < Today || (d == Today && at is { } t && t < TimeOfDay));

    public static int OffsetFor(DateTimeZone tz, DateTime utc) =>
        (int)(tz.GetUtcOffset(Instant.FromDateTimeUtc(DateTime.SpecifyKind(utc, DateTimeKind.Utc))).Seconds / 60);
}
