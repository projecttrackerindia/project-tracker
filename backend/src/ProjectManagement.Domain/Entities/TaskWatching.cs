using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Entities;

/// <summary>Someone who chose to watch a task (the eye in the Plan sheet inspector): they are told when its dates, owner, status or project change.</summary>
public class TaskWatcher : TenantEntity, ITenantScoped
{
    public Guid TaskId { get; set; }
    public Guid UserId { get; set; }
}

/// <summary>
/// One change made to a task on the Plan sheet, kept so its notice can say what it was (before → after, by whom, its effect) and so it can be undone
/// from the notice or its e-mail. Only the fields the sheet tells people about are kept.
/// </summary>
public class TaskChange : TenantEntity, ITenantScoped
{
    public Guid TaskId { get; set; }
    public Guid ProjectId { get; set; }
    /// <summary>The project it was in before, when the change moved it to another project.</summary>
    public Guid? FromProjectId { get; set; }
    public Guid ActorId { get; set; }
    public DateOnly? BeforeDue { get; set; }
    public DateOnly? AfterDue { get; set; }
    public DateOnly? BeforeStart { get; set; }
    public DateOnly? AfterStart { get; set; }
    public Guid? BeforeAssigneeId { get; set; }
    public Guid? AfterAssigneeId { get; set; }
    public Guid BeforeStatusId { get; set; }
    public Guid AfterStatusId { get; set; }
    /// <summary>What it does to other work, in words ("CB-03 starts later").</summary>
    public string? Effect { get; set; }
    public DateTime? UndoneAt { get; set; }
}
