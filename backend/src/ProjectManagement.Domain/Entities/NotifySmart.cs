using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Entities;

/// <summary>
/// How one person wants their notifications shaped (Settings › Notifications › Smart): whether updates about the same project or thread
/// are grouped ("6 updates on CIBIL Integration") and over how long a window, and which kinds ring as urgent or stay a quiet badge.
/// No row = the defaults (grouping on, one hour, the built-in urgent kinds).
/// </summary>
public class NotificationTuning : TenantEntity, ITenantScoped
{
    public Guid UserId { get; set; }
    public bool Grouping { get; set; } = true;
    /// <summary>Updates this close together (minutes) about the same thing make one group, and only the first of them pings.</summary>
    public int GroupWindowMinutes { get; set; } = 60;
    /// <summary>The person's own choices, "Approval=urgent,Message=normal"; kinds not listed follow the defaults.</summary>
    public string PriorityOverrides { get; set; } = "";
}

/// <summary>
/// A project or a thread (a conversation, a task, a work item) one person muted: its notifications still land in the Notification Centre,
/// but never ring, pop up, push or e-mail. Until null = until they unmute it.
/// </summary>
public class NotificationMute : TenantEntity, ITenantScoped
{
    public Guid UserId { get; set; }
    /// <summary>"project" or "thread".</summary>
    public string Scope { get; set; } = "project";
    public Guid TargetId { get; set; }
    /// <summary>What it is called, for the list in Settings.</summary>
    public string Label { get; set; } = "";
    public DateTime? Until { get; set; }
}

/// <summary>
/// "Report a problem": what someone saw (their words), where (route, app version, device) and what the app noticed (the last console
/// errors and failed requests). The screenshot is kept in file storage under the workspace's own prefix, never in the database.
/// </summary>
public class ProblemReport : TenantEntity, ITenantScoped
{
    public Guid UserId { get; set; }
    public string Message { get; set; } = "";
    public string Route { get; set; } = "";
    public string AppVersion { get; set; } = "";
    public string? UserAgent { get; set; }
    /// <summary>The last console errors, newest last (JSON array of strings).</summary>
    public string ConsoleTail { get; set; } = "[]";
    /// <summary>The last failed requests, newest last (JSON array of strings: method, path, status).</summary>
    public string NetworkTail { get; set; } = "[]";
    public string? ScreenshotKey { get; set; }
    /// <summary>"open" or "closed".</summary>
    public string Status { get; set; } = "open";
    public DateTime? EmailedAt { get; set; }
}

/// <summary>
/// A feature switched on or off for the whole workspace, one team or one person. The most specific row wins (person, then team, then
/// workspace); with no row a feature keeps its safe default (off unless the catalog says otherwise).
/// </summary>
public class FeatureFlag : TenantEntity, ITenantScoped
{
    public string Key { get; set; } = "";
    /// <summary>"workspace", "team" or "user".</summary>
    public string Scope { get; set; } = "workspace";
    /// <summary>The team or person; Guid.Empty for the workspace.</summary>
    public Guid TargetId { get; set; }
    public bool Enabled { get; set; }
}
