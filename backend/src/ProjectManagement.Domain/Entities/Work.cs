using ProjectManagement.Domain.Common;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Domain.Entities;

public class Project : TenantEntity, ITenantScoped, ISoftDelete
{
    public string Name { get; set; } = "";
    public string Key { get; set; } = "";
    public string? Description { get; set; }
    public ProjectStatus Status { get; set; } = ProjectStatus.Planning;
    public Priority Priority { get; set; } = Priority.Medium;
    /// <summary>What the project is for (new project, change request, enhancement ...). Chosen when it is created.</summary>
    public ProjectType ProjectType { get; set; } = ProjectType.Other;
    /// <summary>Which planning tools the project uses: a stage timeline, sprints, or both.</summary>
    public DeliveryMethod DeliveryMethod { get; set; } = DeliveryMethod.Hybrid;
    public Guid OwnerId { get; set; }
    public Guid? TeamId { get; set; }
    /// <summary>The project group this project belongs to. Required for every new project; empty only on projects that predate groups until the next start-up assigns them one.</summary>
    public Guid? ProjectGroupId { get; set; }
    public DateOnly? StartDate { get; set; }
    public DateOnly? DueDate { get; set; }
    /// <summary>Manual order on the projects board.</summary>
    public double Position { get; set; }
    /// <summary>When on, a task cannot start or finish before the tasks it depends on (spec section 18).</summary>
    public bool EnforceDependencies { get; set; } = true;
    public DateTime? ArchivedAt { get; set; }
    public Guid? ArchivedBy { get; set; }
    /// <summary>Optimistic concurrency version (spec section 80).</summary>
    public int Version { get; set; } = 1;

    public bool IsDeleted { get; set; }
    public DateTime? DeletedAt { get; set; }
    public Guid? DeletedBy { get; set; }

    public User? Owner { get; set; }
    public Team? Team { get; set; }
    public ProjectGroup? Group { get; set; }
    public ICollection<ProjectMember> Members { get; set; } = new List<ProjectMember>();
    public ICollection<WorkflowStatus> Statuses { get; set; } = new List<WorkflowStatus>();
    public ICollection<ProjectStage> Stages { get; set; } = new List<ProjectStage>();
}

public class ProjectMember : TenantEntity, ITenantScoped
{
    public Guid ProjectId { get; set; }
    public Guid UserId { get; set; }
    public User? User { get; set; }
}

/// <summary>Configurable task status per project (spec section 15).</summary>
public class WorkflowStatus : TenantEntity, ITenantScoped
{
    public Guid ProjectId { get; set; }
    public string Name { get; set; } = "";
    public int Order { get; set; }
    public StatusCategory Category { get; set; }
    public string Color { get; set; } = "#8b5cf6";
}

/// <summary>Data-driven project lifecycle stage (spec section 13.3).</summary>
public class ProjectStage : TenantEntity, ITenantScoped
{
    public Guid ProjectId { get; set; }
    public string Name { get; set; } = "";
    public int Order { get; set; }
    public DateOnly? PlannedStart { get; set; }
    public DateOnly? PlannedEnd { get; set; }
    public DateOnly? ActualStart { get; set; }
    public DateOnly? ActualEnd { get; set; }
    public StageStatus Status { get; set; } = StageStatus.Pending;
    public Guid? OwnerId { get; set; }
    public Guid? AssigneeId { get; set; }
    public string? Description { get; set; }
}

/// <summary>A workspace's own project timeline: a named list of stages a new project can start from. Projects copy it, so it can change freely.</summary>
public class CustomTimelineTemplate : TenantEntity, ITenantScoped
{
    public string Name { get; set; } = "";
    public string? Description { get; set; }
    /// <summary>The stages in order, as JSON: [{"name":"Design","weight":2}, ...]. The weight is the stage's share of the project's duration.</summary>
    public string StagesJson { get; set; } = "[]";
}

public class Label : TenantEntity, ITenantScoped
{
    public string Name { get; set; } = "";
    public string Color { get; set; } = "#8b5cf6";
}

public class TaskItem : TenantEntity, ITenantScoped, ISoftDelete
{
    public Guid ProjectId { get; set; }
    public Guid? ParentTaskId { get; set; }
    /// <summary>
    /// The project timeline stage (phase) this task belongs to. A stage completes once every task under it is done. Subtasks
    /// share their parent's stage. Null for tasks that predate stages or were imported without one.
    /// </summary>
    public Guid? StageId { get; set; }
    /// <summary>Optional milestone this task counts towards.</summary>
    public Guid? MilestoneId { get; set; }
    /// <summary>The sprint this task is planned into; null means it is in the backlog.</summary>
    public Guid? SprintId { get; set; }
    public int Number { get; set; }
    public string Title { get; set; } = "";
    public string? Description { get; set; }
    public Guid StatusId { get; set; }
    public Priority Priority { get; set; } = Priority.Medium;
    public Guid? AssigneeId { get; set; }
    public Guid ReporterId { get; set; }
    public DateOnly? StartDate { get; set; }
    public DateOnly? DueDate { get; set; }
    public decimal? EstimatedHours { get; set; }
    public decimal? ActualHours { get; set; }
    public double Position { get; set; }
    public DateTime? CompletedAt { get; set; }
    public int Version { get; set; } = 1;

    public bool IsDeleted { get; set; }
    public DateTime? DeletedAt { get; set; }
    public Guid? DeletedBy { get; set; }

    public Project? Project { get; set; }
    public WorkflowStatus? Status { get; set; }
    public User? Assignee { get; set; }
    public User? Reporter { get; set; }
    public TaskItem? ParentTask { get; set; }
    public ICollection<TaskItem> Subtasks { get; set; } = new List<TaskItem>();
    public ICollection<TaskLabel> Labels { get; set; } = new List<TaskLabel>();
    public ICollection<TaskComment> Comments { get; set; } = new List<TaskComment>();
}

/// <summary>
/// "This task depends on that one" (spec section 18). Both tasks belong to the same project; loops are rejected when the link is created.
/// </summary>
public class TaskDependency : TenantEntity, ITenantScoped
{
    /// <summary>The task that waits (the successor).</summary>
    public Guid TaskId { get; set; }
    /// <summary>The task that must happen first (the predecessor).</summary>
    public Guid DependsOnTaskId { get; set; }
    public DependencyType Type { get; set; } = DependencyType.FinishToStart;

    public TaskItem? Task { get; set; }
    public TaskItem? DependsOnTask { get; set; }
}

/// <summary>
/// A dated checkpoint in a project (spec section 19). Tasks can be counted towards it. A milestone usually marks the end of one stage
/// of the timeline (<see cref="StageId"/>), so it is shown on that stage instead of as a second, parallel plan.
/// </summary>
public class Milestone : TenantEntity, ITenantScoped, ISoftDelete
{
    public Guid ProjectId { get; set; }
    /// <summary>The timeline stage this milestone is the checkpoint of, or null for a project-level milestone.</summary>
    public Guid? StageId { get; set; }
    public string Name { get; set; } = "";
    public string? Description { get; set; }
    public DateOnly? StartDate { get; set; }
    public DateOnly? DueDate { get; set; }
    public StageStatus Status { get; set; } = StageStatus.Pending;
    public Guid? OwnerId { get; set; }
    public int SortOrder { get; set; }
    public DateTime? CompletedAt { get; set; }

    public bool IsDeleted { get; set; }
    public DateTime? DeletedAt { get; set; }
    public Guid? DeletedBy { get; set; }

    public User? Owner { get; set; }
}

public class TaskLabel : TenantEntity, ITenantScoped
{
    public Guid TaskId { get; set; }
    public Guid LabelId { get; set; }
    public Label? Label { get; set; }
}

public class TaskComment : TenantEntity, ITenantScoped, ISoftDelete
{
    public Guid TaskId { get; set; }
    public Guid AuthorId { get; set; }
    public string Body { get; set; } = "";
    public Guid? ParentCommentId { get; set; }
    public DateTime? EditedAt { get; set; }
    public bool IsDeleted { get; set; }
    public DateTime? DeletedAt { get; set; }
    public Guid? DeletedBy { get; set; }
    public User? Author { get; set; }
}

public class Activity : TenantEntity, ITenantScoped
{
    public Guid? ProjectId { get; set; }
    public Guid? ActorId { get; set; }
    public string Action { get; set; } = "";
    public string EntityType { get; set; } = "";
    public Guid? EntityId { get; set; }
    public string Summary { get; set; } = "";
    public string? OldValue { get; set; }
    public string? NewValue { get; set; }
    public string? IpAddress { get; set; }
    public User? Actor { get; set; }
}

/// <summary>
/// A file attached to a project (TaskId null) or to one of its tasks. The bytes live in file storage (never in the database);
/// only the metadata is kept here. Deleting the row deletes the file.
/// </summary>
public class Attachment : TenantEntity, ITenantScoped
{
    public Guid ProjectId { get; set; }
    public Guid? TaskId { get; set; }
    /// <summary>Set for a supporting document of a test issue (then TaskId is null and it is not listed with the project's own files).</summary>
    public Guid? IssueId { get; set; }
    /// <summary>Original name, cleaned of path parts and control characters. Never used to build a storage path.</summary>
    public string FileName { get; set; } = "";
    /// <summary>Decided by the server from the extension after the content was checked, never taken from the client.</summary>
    public string ContentType { get; set; } = "";
    public long SizeBytes { get; set; }
    /// <summary>Opaque location in file storage (tenant/month/random id).</summary>
    public string StorageKey { get; set; } = "";
    public string Sha256 { get; set; } = "";
}

public class Notification : TenantEntity, ITenantScoped
{
    public Guid UserId { get; set; }
    public NotificationType Type { get; set; }
    public string Title { get; set; } = "";
    public string? Body { get; set; }
    public string? Link { get; set; }
    public DateTime? ReadAt { get; set; }
    public string? DedupeKey { get; set; }

    // Delivery, decided by the recipient's preferences when the notification is created.
    /// <summary>Shown in the bell / notifications page. False = e-mail (or browser) only.</summary>
    public bool InApp { get; set; } = true;
    /// <summary>Show a desktop (browser) notification while the app is open.</summary>
    public bool Browser { get; set; }
    /// <summary>Waiting for the background worker to e-mail it.</summary>
    public bool EmailPending { get; set; }
    public DateTime? EmailedAt { get; set; }
    public int EmailAttempts { get; set; }
}

public class AuditLog : Entity
{
    public Guid? TenantId { get; set; }
    public Guid? UserId { get; set; }
    public string Action { get; set; } = "";
    public string EntityType { get; set; } = "";
    public Guid? EntityId { get; set; }
    public string? OldValue { get; set; }
    public string? NewValue { get; set; }
    public string? IpAddress { get; set; }
    public string? UserAgent { get; set; }
    public DateTime CreatedAt { get; set; }
    public User? User { get; set; }
}

/// <summary>A time-boxed batch of a project's tasks. Planned, then Active (at most one per project), then Completed.</summary>
public class Sprint : TenantEntity, ITenantScoped
{
    public Guid ProjectId { get; set; }
    public string Name { get; set; } = "";
    public string? Goal { get; set; }
    public DateOnly StartDate { get; set; }
    public DateOnly EndDate { get; set; }
    public SprintStatus Status { get; set; } = SprintStatus.Planned;
    public DateTime? StartedAt { get; set; }
    public DateTime? CompletedAt { get; set; }
    /// <summary>How many tasks the sprint holds: fixed when it starts, then follows tasks added or dropped while it runs.</summary>
    public int CommittedTasks { get; set; }
}
