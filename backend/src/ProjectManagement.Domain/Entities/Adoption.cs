using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Entities;

/// <summary>
/// One import into a project (a spreadsheet, a Jira, Trello or Asana export, or a Jira/Asana API read): which tasks it created, so the whole
/// import can be undone in one click while nobody has built on it for long.
/// </summary>
public class ImportBatch : TenantEntity, ITenantScoped
{
    public Guid ProjectId { get; set; }
    /// <summary>csv, excel, jira, trello or asana.</summary>
    public string Source { get; set; } = "csv";
    public string FileName { get; set; } = "";
    /// <summary>The created task ids, comma separated.</summary>
    public string TaskIds { get; set; } = "";
    public int Created { get; set; }
    public DateTime? UndoneAt { get; set; }
}

/// <summary>
/// A read-only view of one project for people outside the workspace (a client): opened by a magic link whose token is only stored as a
/// hash. The owner picks which fields the client sees and can revoke the link at any time.
/// </summary>
public class ClientPortalLink : TenantEntity, ITenantScoped
{
    public Guid ProjectId { get; set; }
    /// <summary>Who the link is for ("Acme leadership"), shown in the list and to the client.</summary>
    public string Name { get; set; } = "";
    public string TokenHash { get; set; } = "";
    /// <summary>The first characters of the token, to recognise the link without revealing it.</summary>
    public string TokenPrefix { get; set; } = "";
    /// <summary>Comma separated: progress, milestones, tasks, dueDates, owners, statuses.</summary>
    public string Fields { get; set; } = "progress,milestones,tasks,dueDates,statuses";
    public DateTime? ExpiresAt { get; set; }
    public DateTime? RevokedAt { get; set; }
    public DateTime? LastViewedAt { get; set; }
    public int Views { get; set; }
}

/// <summary>
/// A project's own email address (task+token@domain): mail sent to it by a member becomes a task in that project, with the attachments.
/// </summary>
public class ProjectInbox : TenantEntity, ITenantScoped
{
    public Guid ProjectId { get; set; }
    public string Token { get; set; } = "";
    public bool Enabled { get; set; } = true;
    public int Received { get; set; }
    public DateTime? LastReceivedAt { get; set; }
    public string? LastError { get; set; }
    public DateOnly? Day { get; set; }
    public int DayCount { get; set; }
}

/// <summary>
/// Two-way sync of one person's meetings and time blocks with their Google Calendar or Outlook calendar (through the account they already
/// connected). Changes arrive by push (a Google watch channel or a Microsoft Graph subscription) and are read with a sync/delta token.
/// </summary>
public class CalendarSyncLink : TenantEntity, ITenantScoped
{
    public Guid UserId { get; set; }
    /// <summary>google or microsoft.</summary>
    public string Provider { get; set; } = "google";
    public bool Enabled { get; set; } = true;
    /// <summary>When both sides changed the same event since the last sync: "newest" (the later change wins), "ours" (Project Tracker wins) or "theirs" (the calendar wins).</summary>
    public string ConflictRule { get; set; } = "newest";
    public bool SyncMeetings { get; set; } = true;
    public bool SyncBlocks { get; set; } = true;
    public string? DeltaToken { get; set; }
    /// <summary>The push channel (Google) or subscription (Microsoft) id, and the secret it carries so a notification can be trusted.</summary>
    public string? ChannelId { get; set; }
    public string? ChannelSecret { get; set; }
    public DateTime? ChannelExpiresAt { get; set; }
    public DateTime? LastSyncedAt { get; set; }
    public string? LastError { get; set; }
    public int Pushed { get; set; }
    public int Pulled { get; set; }
    public int Conflicts { get; set; }
}

/// <summary>One event kept in step: a meeting or a time block here, and its event in the calendar.</summary>
public class CalendarSyncItem : TenantEntity, ITenantScoped
{
    public Guid LinkId { get; set; }
    public Guid UserId { get; set; }
    /// <summary>meeting (a project meeting) or block (a time block for a task, or a plain busy block).</summary>
    public string Kind { get; set; } = "block";
    /// <summary>The meeting, or the task a block is for (null for a plain block).</summary>
    public Guid? LocalId { get; set; }
    public string Title { get; set; } = "";
    public DateTime StartsAt { get; set; }
    public DateTime EndsAt { get; set; }
    public string? RemoteId { get; set; }
    public string? RemoteVersion { get; set; }
    /// <summary>When this side last changed (set on every local edit) and when the calendar last did (from the provider).</summary>
    public DateTime LocalChangedAt { get; set; }
    public DateTime? RemoteChangedAt { get; set; }
    public DateTime? SyncedAt { get; set; }
    public bool Deleted { get; set; }
}
