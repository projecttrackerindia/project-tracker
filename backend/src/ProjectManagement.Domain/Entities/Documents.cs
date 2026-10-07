using ProjectManagement.Domain.Common;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Domain.Entities;

/// <summary>Where a document is in its life. Release D1 uses Draft and Archived; the review and publishing states are added by the workflow release.</summary>
public enum DocumentStatus { Draft = 0, InReview = 1, ChangesRequested = 2, Approved = 3, Published = 4, Archived = 5 }

/// <summary>
/// Who may open a document. Project: everyone who reaches the document's project. Team: members of the document's team (documents without a project).
/// Organization: every member except guests (documents without a project). Private: its owner and the organization's owners and admins.
/// Owners and admins of the organization are never locked out; nobody outside the workspace ever sees any of them.
/// </summary>
public enum DocumentVisibility { Project = 0, Team = 1, Organization = 2, Private = 3 }

/// <summary>How a section's content is stored and edited: ProseMirror JSON for rich text, or a small JSON grid for a table.</summary>
public enum SectionKind { RichText = 0, Table = 1 }

/// <summary>Who a grant is for: one person, every member of a team, or everyone who holds a job role on the organization chart.</summary>
public enum GrantPrincipal { User = 0, Team = 1, JobRole = 2 }

/// <summary>What a grant allows on one document. Manager can also share it with others.</summary>
public enum DocAccessLevel { Viewer = 1, Editor = 2, Manager = 3 }

/// <summary>Who an approval step is waiting for: a person, every member of a team (or any one of them), a job role, or the owner of the document's project.</summary>
public enum ApproverKind { User = 0, Team = 1, JobRole = 2, ProjectOwner = 3 }

/// <summary>Whether one approver is enough for a step, or all of the step's approvers must agree.</summary>
public enum ApprovalRule { Any = 0, All = 1 }

public enum ApprovalState { Pending = 0, Approved = 1, ChangesRequested = 2, Cancelled = 3, Published = 4 }

public enum DecisionKind { Approved = 1, ChangesRequested = 2 }

public enum AccessRequestStatus { Pending = 0, Approved = 1, Rejected = 2, Cancelled = 3 }

public enum LinkTarget { Project = 0, Task = 1, Issue = 2, WorkItem = 3, Sprint = 4 }

/// <summary>What a document is to the thing it is linked to.</summary>
public enum LinkRelation { Describes = 0, Implements = 1, Verifies = 2, References = 3, DependsOn = 4 }

/// <summary>A kind of document (BRD, API documentation ...). A row of data per workspace, so new kinds need no deployment; the section template says what a new document starts with.</summary>
public class DocumentType : TenantEntity, ITenantScoped
{
    /// <summary>Stable short code used by the built-in kinds (BRD, API, TECH ...). Custom kinds get their own.</summary>
    public string Code { get; set; } = "";
    public string Name { get; set; } = "";
    public string? Description { get; set; }
    /// <summary>An icon name from the app's icon set.</summary>
    public string Icon { get; set; } = "file";
    public string Color { get; set; } = "#8b5cf6";
    /// <summary>The ordered sections a new document of this kind starts with, as JSON (<see cref="SectionTemplate"/> list).</summary>
    public string TemplateJson { get; set; } = "[]";
    public int SortOrder { get; set; }
    public bool IsActive { get; set; } = true;
    /// <summary>Built in (seeded for every workspace). Built-in kinds cannot be deleted, only switched off.</summary>
    public bool IsSystem { get; set; }
}

/// <summary>The stable identity of a document. The words live in <see cref="DocumentVersion"/> and <see cref="DocumentSection"/>.</summary>
public class Document : TenantEntity, ITenantScoped, ISoftDelete
{
    /// <summary>Running number within the workspace, shown as DOC-12.</summary>
    public int Number { get; set; }
    public string Title { get; set; } = "";
    public Guid TypeId { get; set; }
    /// <summary>The project the document belongs to. Null for general documents (policies, process descriptions) that belong to a team or the whole organization.</summary>
    public Guid? ProjectId { get; set; }
    public Guid? TeamId { get; set; }
    public Guid OwnerId { get; set; }
    public DocumentStatus Status { get; set; } = DocumentStatus.Draft;
    public DocumentVisibility Visibility { get; set; } = DocumentVisibility.Project;
    /// <summary>The version people are editing now (the draft).</summary>
    public Guid? DraftVersionId { get; set; }
    /// <summary>The newest published (frozen) version. People who may read but not edit the document see this one. Null until the first publish.</summary>
    public Guid? PublishedVersionId { get; set; }
    /// <summary>Optimistic concurrency: a save that was made from an older copy is refused instead of overwriting.</summary>
    public int Revision { get; set; } = 1;
    /// <summary>A fingerprint of the document's API definitions and endpoints (empty when it has none); part of the draft's content hash, so a changed API counts as an unpublished change.</summary>
    public string ApiHash { get; set; } = "";
    /// <summary>Lower-case plain text of what readers see (the published version, or the draft until there is one): the section titles and words, for search. Never holds secret values.</summary>
    public string? SearchText { get; set; }
    public DateTime? SearchIndexedAt { get; set; }

    public bool IsDeleted { get; set; }
    public DateTime? DeletedAt { get; set; }
    public Guid? DeletedBy { get; set; }

    public DocumentType? Type { get; set; }
    public User? Owner { get; set; }
    public Project? Project { get; set; }
}

/// <summary>One state of a document's content. A draft is the one editable version; later releases freeze versions when they are published.</summary>
public class DocumentVersion : TenantEntity, ITenantScoped
{
    public Guid DocumentId { get; set; }
    public int Major { get; set; }
    public int Minor { get; set; } = 1;
    public bool IsDraft { get; set; } = true;
    public string? ChangeSummary { get; set; }
    public string? ChangeReason { get; set; }
    public DateTime? PublishedAt { get; set; }
    public Guid? PublishedBy { get; set; }
    /// <summary>Set when this version was made by restoring an older one.</summary>
    public Guid? RestoredFromId { get; set; }
    /// <summary>SHA-256 of the section contents, so a frozen version can be shown to be unchanged.</summary>
    public string ContentHash { get; set; } = "";
    public ICollection<DocumentSection> Sections { get; set; } = new List<DocumentSection>();
}

public class DocumentSection : TenantEntity, ITenantScoped
{
    public Guid VersionId { get; set; }
    /// <summary>Stable key from the type's template (businessRequirements ...), so versions can be compared section by section.</summary>
    public string Key { get; set; } = "";
    public string Title { get; set; } = "";
    public SectionKind Kind { get; set; } = SectionKind.RichText;
    public int SortOrder { get; set; }
    /// <summary>ProseMirror JSON for rich text, or {"columns":[...],"rows":[...]} for a table. Never HTML.</summary>
    public string ContentJson { get; set; } = "";
}

public class DocumentTag : TenantEntity, ITenantScoped
{
    public Guid DocumentId { get; set; }
    /// <summary>Lower-case, trimmed.</summary>
    public string Tag { get; set; } = "";
}

/// <summary>A two-way link between a document and a project, task, issue, work item or sprint. One row; both sides read it. A link never grants access.</summary>
public class DocumentLink : TenantEntity, ITenantScoped
{
    public Guid DocumentId { get; set; }
    public LinkTarget TargetType { get; set; }
    public Guid TargetId { get; set; }
    public LinkRelation Relation { get; set; } = LinkRelation.Describes;
    /// <summary>When the link is about one requirement of the document (Implements / Verifies), which one. Null = the document as a whole.</summary>
    public Guid? RequirementId { get; set; }
}

/// <summary>
/// An extra door into one document: a person, a team or a job role gets Viewer, Editor or Manager access on top of the document's visibility. A deny
/// grant shuts a person, team or role out even where visibility would let them in (organization owners and admins are never shut out).
/// </summary>
public class DocumentGrant : TenantEntity, ITenantScoped
{
    public Guid DocumentId { get; set; }
    public GrantPrincipal PrincipalType { get; set; }
    public Guid PrincipalId { get; set; }
    public DocAccessLevel Level { get; set; } = DocAccessLevel.Viewer;
    public bool Deny { get; set; }
    public DateTime? ExpiresAt { get; set; }
    public string? Note { get; set; }
}

/// <summary>A file attached to a document (an image in its text, a specification, a spreadsheet). The bytes are in file storage; the plan's file size and storage limits apply.</summary>
public class DocumentFile : TenantEntity, ITenantScoped
{
    public Guid DocumentId { get; set; }
    public string FileName { get; set; } = "";
    public string ContentType { get; set; } = "";
    public long SizeBytes { get; set; }
    public string StorageKey { get; set; } = "";
    public string Sha256 { get; set; } = "";
}

/// <summary>One entry of a document type's template (what a new document starts with).</summary>
public sealed record SectionTemplate(string Key, string Title, SectionKind Kind, string? Hint = null, string[]? Columns = null);


/// <summary>
/// The path a document of a kind takes before it is published: ordered steps, each naming who approves. One definition without a kind is the
/// workspace's default; a definition for a kind overrides it (Business plan). No active definition = whoever may edit the document publishes it.
/// </summary>
public class WorkflowDefinition : TenantEntity, ITenantScoped
{
    public Guid? TypeId { get; set; }
    public string Name { get; set; } = "";
    public bool IsActive { get; set; } = true;
    /// <summary>The steps as JSON (<see cref="WorkflowStepSpec"/> list).</summary>
    public string StepsJson { get; set; } = "[]";
    /// <summary>Remind approvers once when a step is overdue (Business plan).</summary>
    public bool Remind { get; set; }
}

/// <summary>One step of a workflow definition. <see cref="PrincipalId"/> is the user, team or job role; empty for the project owner.</summary>
public sealed record WorkflowStepSpec(string Name, ApproverKind Kind, Guid? PrincipalId, ApprovalRule Rule = ApprovalRule.Any, int? DueDays = null);

/// <summary>One step as it was when the document was submitted, with the people who could decide it then. Later edits to the workflow never change a running approval.</summary>
public sealed record ApprovalStepSnapshot(string Name, ApproverKind Kind, Guid? PrincipalId, string Who, ApprovalRule Rule, int? DueDays, List<Guid> Approvers);

/// <summary>A workflow running on one draft: submitted by someone, waiting on a step, and finally approved, sent back, withdrawn or published.</summary>
public class DocumentApproval : TenantEntity, ITenantScoped
{
    public Guid DocumentId { get; set; }
    public Guid VersionId { get; set; }
    /// <summary>The draft's content hash at submission; an approval is only valid for exactly this content.</summary>
    public string ContentHash { get; set; } = "";
    public ApprovalState State { get; set; } = ApprovalState.Pending;
    public Guid SubmittedBy { get; set; }
    public DateTime SubmittedAt { get; set; }
    public int CurrentStep { get; set; }
    public DateTime StepStartedAt { get; set; }
    public bool ReminderSent { get; set; }
    public string WorkflowName { get; set; } = "";
    public bool Remind { get; set; }
    public string StepsJson { get; set; } = "[]";
    public string Summary { get; set; } = "";
    public string? Reason { get; set; }
    public bool Major { get; set; }
    public DateTime? ClosedAt { get; set; }
    public Guid? ClosedBy { get; set; }
    public string? ClosedNote { get; set; }
}

public class ApprovalDecision : TenantEntity, ITenantScoped
{
    public Guid ApprovalId { get; set; }
    public Guid DocumentId { get; set; }
    public int StepIndex { get; set; }
    public Guid UserId { get; set; }
    public DecisionKind Decision { get; set; }
    public string? Comment { get; set; }
}

/// <summary>Someone who cannot open a document asks the people who manage it for access, with a reason and how long they need it.</summary>
public class AccessRequest : TenantEntity, ITenantScoped
{
    public Guid DocumentId { get; set; }
    public Guid RequesterId { get; set; }
    public DocAccessLevel Level { get; set; } = DocAccessLevel.Viewer;
    public string Reason { get; set; } = "";
    /// <summary>How long they need it, in days. Null = no end date.</summary>
    public int? DurationDays { get; set; }
    public AccessRequestStatus Status { get; set; } = AccessRequestStatus.Pending;
    public Guid? DecidedBy { get; set; }
    public DateTime? DecidedAt { get; set; }
    public string? DecisionNote { get; set; }
    public DocAccessLevel? GrantedLevel { get; set; }
    public DateTime? GrantedUntil { get; set; }
    public Guid? GrantId { get; set; }
}

/// <summary>A numbered requirement of a document (REQ-1 ...). Tasks, work items and tests are linked to it, which is what the coverage report counts.</summary>
public class DocumentRequirement : TenantEntity, ITenantScoped
{
    public Guid DocumentId { get; set; }
    public int Number { get; set; }
    public string Title { get; set; } = "";
    public string? Detail { get; set; }
    public Priority Priority { get; set; } = Priority.Medium;
    public int SortOrder { get; set; }
}


public enum ApiMethod { Get = 0, Post = 1, Put = 2, Patch = 3, Delete = 4, Head = 5, Options = 6, Trace = 7 }

/// <summary>How callers prove who they are to an API. The details of a scheme go in the description; the product never stores credentials here.</summary>
public enum ApiAuthScheme { None = 0, ApiKey = 1, Bearer = 2, Basic = 3, OAuth2 = 4 }

/// <summary>
/// One API described inside an API document: its name, base path, own version label, how callers authenticate and a plain list of server addresses
/// (there are no per-environment copies). A document can describe several APIs.
/// </summary>
public class ApiDefinition : TenantEntity, ITenantScoped
{
    public Guid DocumentId { get; set; }
    public string Name { get; set; } = "";
    public string? Description { get; set; }
    public string? BasePath { get; set; }
    /// <summary>The API's own version label (v1, 2024-05 ...), free text; not the document's version.</summary>
    public string? Version { get; set; }
    public ApiAuthScheme Auth { get; set; } = ApiAuthScheme.None;
    public string? AuthNote { get; set; }
    /// <summary>The addresses the API is served from, as a JSON list of text.</summary>
    public string ServersJson { get; set; } = "[]";
    public int SortOrder { get; set; }
}

/// <summary>One method and path of an API. The details (parameters, body, responses, errors, samples, dependencies) are JSON; the columns are what lists, search and compare need.</summary>
public class ApiEndpoint : TenantEntity, ITenantScoped
{
    public Guid DocumentId { get; set; }
    public Guid DefinitionId { get; set; }
    public ApiMethod Method { get; set; }
    public string Path { get; set; } = "";
    public string Summary { get; set; } = "";
    /// <summary>The group it is listed under in the tree.</summary>
    public string? Tag { get; set; }
    public bool Deprecated { get; set; }
    public Guid? OwnerId { get; set; }
    public string DetailsJson { get; set; } = "{}";
    /// <summary>Fingerprint of everything above (not the id), so the document's API hash can be worked out without reading the details.</summary>
    public string Hash { get; set; } = "";
}

/// <summary>The API data of a document as it was when a version was published: its definitions, once, as JSON.</summary>
public class ApiSnapshot : TenantEntity, ITenantScoped
{
    public Guid DocumentId { get; set; }
    public Guid VersionId { get; set; }
    public string DefinitionsJson { get; set; } = "[]";
    public int EndpointCount { get; set; }
}

/// <summary>One endpoint as it was in a published version. Never changed afterwards; the compare and the breaking-change check read these.</summary>
public class EndpointRevision : TenantEntity, ITenantScoped
{
    public Guid DocumentId { get; set; }
    public Guid VersionId { get; set; }
    public Guid DefinitionId { get; set; }
    public string DefinitionName { get; set; } = "";
    public Guid EndpointId { get; set; }
    public ApiMethod Method { get; set; }
    public string Path { get; set; } = "";
    public string Summary { get; set; } = "";
    public string? Tag { get; set; }
    public bool Deprecated { get; set; }
    public Guid? OwnerId { get; set; }
    public string DetailsJson { get; set; } = "{}";
}


/// <summary>How a protected value is treated: a Secret is masked and revealed with the permission (audited); Confidential also needs a fresh two-step check (Business plan).</summary>
public enum SensitivityClass { Secret = 0, Confidential = 1 }

/// <summary>
/// A secret kept with a document (an API key, a password, a connection string). The text of the document holds only a reference to it, never the value;
/// the value is encrypted with the workspace's current data key and bound to this row, so copied ciphertext opens nowhere else.
/// </summary>
public class SensitiveValue : TenantEntity, ITenantScoped
{
    public Guid DocumentId { get; set; }
    public string Label { get; set; } = "";
    public string? Note { get; set; }
    public SensitivityClass Class { get; set; } = SensitivityClass.Secret;
    /// <summary>The value, encrypted (AES-256-GCM): nonce, tag and cipher text, base64. Never sent to a client except by a successful reveal.</summary>
    public string Cipher { get; set; } = "";
    /// <summary>Which of the workspace's data keys encrypted it.</summary>
    public int KeyVersion { get; set; }
    public DateTime? ValueChangedAt { get; set; }
    public DateTime? ReencryptedAt { get; set; }
}

/// <summary>A workspace's data key, itself encrypted with the platform's master key (envelope encryption). A new version is made when an administrator rotates; old versions decrypt until every value has moved.</summary>
public class DocumentKey : TenantEntity, ITenantScoped
{
    public int Version { get; set; }
    public string WrappedKey { get; set; } = "";
    public bool Active { get; set; }
    public DateTime? RetiredAt { get; set; }
}

/// <summary>Proof that a person passed a fresh two-step check, valid for a few minutes; confidential values are revealed only with one.</summary>
public class StepUpGrant : Entity
{
    public Guid UserId { get; set; }
    public string TokenHash { get; set; } = "";
    public DateTime ExpiresAt { get; set; }
}
