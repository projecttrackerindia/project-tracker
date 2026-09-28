using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Enums
{
    /// <summary>What a project is for. Chosen when the project is created and shown wherever the project is presented.</summary>
    public enum ProjectType { NewProject, ChangeRequest, Enhancement, Migration, Integration, Upgrade, Maintenance, Compliance, Other }

    /// <summary>Where a work task stands. Work tasks have their own simple flow: they never go through a project's workflow.</summary>
    public enum WorkTaskStatus { ToDo, InProgress, OnHold, Completed, Cancelled }
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
    /// An operational activity that is not a task on a project's delivery timeline: a bug fix, an analysis, some data preparation, support ...
    /// It may point at a project for reference (<see cref="RelatedProjectId"/>) but never changes that project - a completed project stays completed.
    /// </summary>
    public class WorkTask : TenantEntity, ITenantScoped, ISoftDelete
    {
        /// <summary>Running number within the workspace, shown as WT-12.</summary>
        public int Number { get; set; }
        public string Title { get; set; } = "";
        public string? Description { get; set; }
        public Guid WorkTypeId { get; set; }
        /// <summary>Optional, for reference, reporting and traceability only.</summary>
        public Guid? RelatedProjectId { get; set; }
        public Guid? AssigneeId { get; set; }
        public Guid ReporterId { get; set; }
        public Priority Priority { get; set; } = Priority.Medium;
        public WorkTaskStatus Status { get; set; } = WorkTaskStatus.ToDo;
        public DateOnly? StartDate { get; set; }
        public DateOnly? DueDate { get; set; }
        public DateTime? CompletedAt { get; set; }
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
