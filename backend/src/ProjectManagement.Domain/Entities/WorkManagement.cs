using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Enums
{
    /// <summary>What a project is for. Chosen when the project is created and shown wherever the project is presented.</summary>
    public enum ProjectType { NewProject, ChangeRequest, Enhancement, Migration, Integration, Upgrade, Maintenance, Compliance, Other }

    /// <summary>
    /// How a project is delivered, which decides the planning tools it shows. Phased: a stage timeline with milestones as checkpoints on its
    /// stages. Agile: sprints and a backlog. Hybrid: both (the default, and what every project created before this setting existed uses).
    /// </summary>
    public enum DeliveryMethod { Hybrid, Phased, Agile }

    /// <summary>Where a work task stands. Work tasks have their own simple flow: they never go through a project's workflow.</summary>
    public enum WorkTaskStatus { ToDo, InProgress, OnHold, Completed, Cancelled }

    /// <summary>
    /// How the action-items API names an action item's status (Open, In progress, Completed). Stored as the work task's status:
    /// Open is To Do, In progress is In Progress and Completed is Completed.
    /// </summary>
    public enum ActionItemStatus { Open, InProgress, Completed }

    /// <summary>
    /// What a work task is. Operational work (WT-12) is a bug fix, support, analysis and so on, optionally linked to a project for reference.
    /// An action item (AI-13) is a follow-up agreed for a project ("get the client's sign-off") and always belongs to one. Both are the same
    /// record with the same comments, files, time and history; only their rules for who may see and change them differ.
    /// </summary>
    public enum WorkTaskKind { Operational, ActionItem }

    /// <summary>
    /// Every kind of assignable work in the product, for the views that show them together (My work, workload, search, calendar, dashboard):
    /// project tasks, test issues found in a project's stages, project action items and operational work.
    /// </summary>
    public enum WorkItemKind { Task, Issue, ActionItem, Operational }
}

namespace ProjectManagement.Domain.Entities
{
    using ProjectManagement.Domain.Enums;

    /// <summary>
    /// A kind of operational work (Bug Fix, Data Preparation, Production Support ...). The workspace's own master list: types can be added,
    /// renamed, reordered and deactivated without touching the application. A type that work tasks use cannot be deleted, only deactivated.
    /// </summary>
    public class WorkType : TenantEntity, ITenantScoped
    {
        public string Name { get; set; } = "";
        public string? Description { get; set; }
        public int Order { get; set; }
        /// <summary>An inactive type keeps the work tasks that use it but is no longer offered for new ones.</summary>
        public bool IsActive { get; set; } = true;
    }

    /// <summary>
    /// Work that is not a task on a project's delivery timeline. <see cref="WorkTaskKind.Operational"/>: a bug fix, an analysis, some data
    /// preparation, support ... It may point at a project for reference (<see cref="RelatedProjectId"/>) but never changes that project - a
    /// completed project stays completed. <see cref="WorkTaskKind.ActionItem"/>: a project's follow-up, which always has a project.
    /// </summary>
    public class WorkTask : TenantEntity, ITenantScoped, ISoftDelete
    {
        public WorkTaskKind Kind { get; set; } = WorkTaskKind.Operational;
        /// <summary>Running number within the workspace, shared by both kinds: shown as WT-12 or AI-13.</summary>
        public int Number { get; set; }
        public string Title { get; set; } = "";
        public string? Description { get; set; }
        /// <summary>The kind of operational work. Always set for operational work; action items have none.</summary>
        public Guid? WorkTypeId { get; set; }
        /// <summary>Operational work: optional, for reference, reporting and traceability only. Action items: the project they belong to.</summary>
        public Guid? RelatedProjectId { get; set; }
        public Guid? AssigneeId { get; set; }
        public Guid ReporterId { get; set; }
        public Priority Priority { get; set; } = Priority.Medium;
        public WorkTaskStatus Status { get; set; } = WorkTaskStatus.ToDo;
        public DateOnly? StartDate { get; set; }
        public DateOnly? DueDate { get; set; }
        public DateTime? CompletedAt { get; set; }
        /// <summary>Who marked it completed (cleared when it is reopened).</summary>
        public Guid? CompletedBy { get; set; }
        public int Version { get; set; } = 1;

        public bool IsDeleted { get; set; }
        public DateTime? DeletedAt { get; set; }
        public Guid? DeletedBy { get; set; }

        public WorkType? WorkType { get; set; }
    }

    public class WorkTaskComment : TenantEntity, ITenantScoped, ISoftDelete
    {
        public Guid WorkTaskId { get; set; }
        public Guid AuthorId { get; set; }
        public string Body { get; set; } = "";
        public DateTime? EditedAt { get; set; }
        public bool IsDeleted { get; set; }
        public DateTime? DeletedAt { get; set; }
        public Guid? DeletedBy { get; set; }
    }

    /// <summary>A file on a work task. The bytes live in file storage like every other attachment; only the metadata is kept here.</summary>
    public class WorkTaskAttachment : TenantEntity, ITenantScoped
    {
        public Guid WorkTaskId { get; set; }
        public string FileName { get; set; } = "";
        public string ContentType { get; set; } = "";
        public long SizeBytes { get; set; }
        public string StorageKey { get; set; } = "";
        public string Sha256 { get; set; } = "";
    }
}
