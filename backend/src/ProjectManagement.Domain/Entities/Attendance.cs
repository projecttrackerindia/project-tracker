using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Entities;

/// <summary>
/// One person's working day: when they checked in and out, and where they worked (the office, from home or at a client's). One row per
/// person per day, the day being the organization's local date (Tenant.TimeZone), never the browser's.
/// </summary>
public class AttendanceDay : TenantEntity, ITenantScoped
{
    public Guid UserId { get; set; }
    /// <summary>The organization's local date of the check-in.</summary>
    public DateOnly Date { get; set; }
    public DateTime CheckInAt { get; set; }
    public DateTime? CheckOutAt { get; set; }
    /// <summary>Office, Home or ClientSite.</summary>
    public string Mode { get; set; } = "Office";
    /// <summary>The client or place, for a client office (at most 120 characters).</summary>
    public string? Place { get; set; }
    /// <summary>The person's own note for the day (at most 300 characters).</summary>
    public string? Note { get; set; }
    /// <summary>Where the check-in came from: web, phone, desktop or auto.</summary>
    public string Source { get; set; } = "web";
    /// <summary>Nobody checked out: the day was closed at the organization's end time by the reminder worker.</summary>
    public bool AutoClosed { get; set; }
}

/// <summary>
/// A workspace's attendance rules (Settings › General › Attendance): whether people check in, its working hours (or each person's own),
/// when reminders go out, which ways of working are allowed and whether a forgotten check-out closes itself. One row per workspace; no row
/// means the defaults below.
/// </summary>
public class AttendancePolicy : TenantEntity, ITenantScoped
{
    public bool Enabled { get; set; } = true;
    /// <summary>workspace (the hours below) or personal (each person's working hours from their reminder schedule).</summary>
    public string HoursSource { get; set; } = "workspace";
    /// <summary>ISO weekdays that are working days ("1,2,3,4,5" = Monday to Friday).</summary>
    public string WorkDays { get; set; } = "1,2,3,4,5";
    public TimeOnly WorkStart { get; set; } = new(9, 30);
    public TimeOnly WorkEnd { get; set; } = new(18, 30);
    /// <summary>Minutes after the start of the day before "check in?" is sent to someone signed in but not checked in.</summary>
    public int CheckInGraceMinutes { get; set; } = 30;
    /// <summary>Minutes after the end of the day before "still checked in?" is sent.</summary>
    public int CheckOutGraceMinutes { get; set; } = 30;
    public bool AutoClose { get; set; } = true;
    /// <summary>Hours after the end of the day when a day still open is closed at the end time.</summary>
    public int AutoCloseAfterHours { get; set; } = 4;
    /// <summary>The allowed ways of working, comma separated: Office, Home, ClientSite.</summary>
    public string AllowedModes { get; set; } = "Office,Home,ClientSite";
    public bool RequireClientPlace { get; set; } = true;
    /// <summary>Ask at the first sign-in of the day.</summary>
    public bool PromptAtSignIn { get; set; } = true;
}
