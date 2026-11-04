using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Entities;

/// <summary>
/// A named group projects are organized into (Salesforce Projects, Employee Portal, HRMS ...). The list is the workspace's own master list:
/// every project belongs to exactly one group, and a group can be renamed, reordered, deactivated (no new projects) or deleted (once empty).
/// </summary>
public class ProjectGroup : TenantEntity, ITenantScoped
{
    public string Name { get; set; } = "";
    public string? Description { get; set; }
    /// <summary>Position in the list (0 first). The status page and the pickers show groups in this order.</summary>
    public int Order { get; set; }
    /// <summary>An inactive group keeps its projects but is no longer offered when a project is created or moved.</summary>
    public bool IsActive { get; set; } = true;
}

/// <summary>
/// One change of a delivery (due) date, kept as history: what it was, what it became, who changed it and when (CreatedBy / CreatedAt),
/// why, and what it was waiting on. <see cref="TaskId"/> is null when it is the project's own due date that moved.
/// </summary>
public class DueDateChange : TenantEntity, ITenantScoped
{
    public Guid ProjectId { get; set; }
    public Guid? TaskId { get; set; }
    public DateOnly? Previous { get; set; }
    public DateOnly? Revised { get; set; }
    public string? Reason { get; set; }
    /// <summary>What the delivery was waiting on (another task, a client answer, a vendor ...), in the person's own words.</summary>
    public string? Dependency { get; set; }
    /// <summary>
    /// What moved, when it is not a project's or a task's due date (the rows written before these columns existed): actionitem, milestone or
    /// stage. Null = a project (TaskId null) or a task (TaskId set), as before.
    /// </summary>
    public string? EntityType { get; set; }
    /// <summary>The item whose date moved (also set for tasks and projects on new rows); a milestone or a phase is not a work item, so it is kept here, not in TaskId.</summary>
    public Guid? EntityId { get; set; }
    /// <summary>Which date: null = the due (end) date, as before; "start" for a start date, "end" for a phase's planned end.</summary>
    public string? Field { get; set; }
}
