using ProjectManagement.Domain.Common;

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
    /// <summary>Optimistic concurrency: a save that was made from an older copy is refused instead of overwriting.</summary>
    public int Revision { get; set; } = 1;

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
}

/// <summary>One entry of a document type's template (what a new document starts with).</summary>
public sealed record SectionTemplate(string Key, string Title, SectionKind Kind, string? Hint = null, string[]? Columns = null);
