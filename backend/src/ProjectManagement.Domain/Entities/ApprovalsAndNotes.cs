using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Entities;

/// <summary>The kinds of request the Approvals place handles, as stored (the API speaks these names).</summary>
public static class ApprovalTypes
{
    public const string Deployment = "Deployment", ConfigChange = "ConfigChange", ChangeRequest = "ChangeRequest", Incident = "Incident",
        AttendanceCorrection = "AttendanceCorrection", Leave = "Leave", Access = "Access", Expense = "Expense";
    public static readonly string[] All = [Deployment, ConfigChange, ChangeRequest, Incident, AttendanceCorrection, Leave, Access, Expense];
}

/// <summary>Where a request stands. Pending: waiting on its current step. The others are final.</summary>
public static class ApprovalStatuses
{
    public const string Pending = "Pending", Approved = "Approved", Rejected = "Rejected", Withdrawn = "Withdrawn", Expired = "Expired";
}

/// <summary>
/// One request for a decision (a production deploy, a config change, leave, an attendance correction ...): who asked, what (a type-specific
/// payload, kept as JSON so each type keeps its own fields), how risky, what it links to, and its chain of approvers
/// (<see cref="ApprovalRequestStep"/>). Every action on it is an <see cref="ApprovalRequestEvent"/>, which is the timeline.
/// </summary>
public class ApprovalRequest : TenantEntity, ITenantScoped
{
    public string Type { get; set; } = ApprovalTypes.ChangeRequest;
    public string Title { get; set; } = "";
    public string? Summary { get; set; }
    /// <summary>The type's own fields ({"service":"payments-api","environment":"Production"} ...).</summary>
    public string PayloadJson { get; set; } = "{}";
    /// <summary>Low, Medium or High.</summary>
    public string Risk { get; set; } = "Low";
    public string? Impact { get; set; }
    /// <summary>Linked items: [{"kind":"task","id":"..","label":"ATL-482","href":"/..."}].</summary>
    public string LinksJson { get; set; } = "[]";
    public Guid RequesterId { get; set; }
    public string Status { get; set; } = ApprovalStatuses.Pending;
    /// <summary>The order of the step that is waiting (1-based); the step count once decided.</summary>
    public int CurrentStep { get; set; } = 1;
    public DateTime? ExpiresAt { get; set; }
    public DateTime? DecidedAt { get; set; }
    /// <summary>What a final approval created elsewhere ("PlannedLeave:{id}"), so the two stay linked.</summary>
    public string? Outcome { get; set; }
}

/// <summary>One approver in a request's chain: a role label ("Lead", "Ops", "Owner") resolved to a person when the request was made.</summary>
public class ApprovalRequestStep : TenantEntity, ITenantScoped
{
    public Guid RequestId { get; set; }
    public int Order { get; set; }
    public string Role { get; set; } = "";
    public Guid ApproverId { get; set; }
    /// <summary>Waiting (a later step), Pending (its turn), Approved, Rejected or Skipped.</summary>
    public string Status { get; set; } = "Waiting";
    public DateTime? DecidedAt { get; set; }
    public string? Comment { get; set; }
}

/// <summary>The timeline of a request: requested, approved, rejected, commented, withdrawn, expired - with who, when and why.</summary>
public class ApprovalRequestEvent : TenantEntity, ITenantScoped
{
    public Guid RequestId { get; set; }
    public Guid? UserId { get; set; }
    /// <summary>Requested, Approved, Rejected, Commented, Withdrawn, Expired.</summary>
    public string Action { get; set; } = "";
    public int? StepOrder { get; set; }
    public string? Comment { get; set; }
}

/// <summary>A workspace's default chain for one request type (Settings › Approvals). No row = the built-in default.</summary>
public class ApprovalPolicy : TenantEntity, ITenantScoped
{
    public string Type { get; set; } = "";
    /// <summary>[{"role":"Lead"},{"role":"Owner"},{"role":"Person","userId":".."}].</summary>
    public string StepsJson { get; set; } = "[]";
    /// <summary>How long approvers have before the request expires; null = never.</summary>
    public int? ExpiryHours { get; set; }
}

/// <summary>
/// A note: a title and rich content (blocks as JSON: paragraphs, headings, checklists, mentions, work links, images, attachments), in a
/// folder with tags, pinned or not, private to its owner or shared. <see cref="PlainText"/> is the searchable text of the content.
/// </summary>
public class Note : TenantEntity, ITenantScoped, ISoftDelete
{
    public Guid OwnerId { get; set; }
    public string Title { get; set; } = "";
    public string ContentJson { get; set; } = "[]";
    public string PlainText { get; set; } = "";
    public string? Folder { get; set; }
    /// <summary>Comma separated, lower case, without '#'.</summary>
    public string Tags { get; set; } = "";
    public bool Pinned { get; set; }
    /// <summary>private, people (only <see cref="SharedWithJson"/>) or workspace.</summary>
    public string Sharing { get; set; } = "private";
    public string SharedWithJson { get; set; } = "[]";
    /// <summary>Linked work: [{"kind":"task|project|meeting","id":"..","label":"ATL-482"}].</summary>
    public string LinksJson { get; set; } = "[]";
    /// <summary>The project the note belongs to (its folder colour, and where its attachments are stored).</summary>
    public Guid? ProjectId { get; set; }
    public Guid? MeetingId { get; set; }
    public bool IsDeleted { get; set; }
    public DateTime? DeletedAt { get; set; }
    public Guid? DeletedBy { get; set; }
}
