using ProjectManagement.Domain.Common;
namespace ProjectManagement.Domain.Entities;

public class SupportWorkflow : TenantEntity, ITenantScoped
{
    public string Name { get; set; } = "";
    public Guid CreatorId { get; set; }
    public string DraftJson { get; set; } = "{}";
    public Guid? PublishedRevisionId { get; set; }
    public string PublishedTrigger { get; set; } = "manual";
    public bool Enabled { get; set; }
    public int Version { get; set; } = 1;
}
public class SupportWorkflowRevision : TenantEntity, ITenantScoped
{
    public Guid WorkflowId { get; set; }
    public int Number { get; set; }
    public Guid PublishedBy { get; set; }
    public string GraphJson { get; set; } = "{}";
}
public class SupportWorkflowEvent : TenantEntity, ITenantScoped
{
    public Guid TicketId { get; set; }
    public string Kind { get; set; } = "";
    public string RequestKey { get; set; } = "";
    public DateTime? ProcessedAt { get; set; }
    public string RevisionIdsJson { get; set; } = "[]";
}
public class SupportWorkflowRun : TenantEntity, ITenantScoped
{
    public Guid WorkflowId { get; set; }
    public Guid RevisionId { get; set; }
    public Guid TicketId { get; set; }
    public Guid? EventId { get; set; }
    public Guid? ScheduleId { get; set; }
    public Guid ExecutorId { get; set; }
    public string RequestKey { get; set; } = "";
    public string NodeId { get; set; } = "";
    public string Status { get; set; } = "queued";
    public DateTime AvailableAt { get; set; }
    public DateTime? CompletedAt { get; set; }
    public Guid? LeaseOwner { get; set; }
    public DateTime? LeaseExpiresAt { get; set; }
    public int Attempts { get; set; }
    public int? ApprovedWorkVersion { get; set; }
    public int? ApprovedTicketVersion { get; set; }
    public string? ErrorCode { get; set; }
    public int Version { get; set; } = 1;
}
public class SupportWorkflowStep : TenantEntity, ITenantScoped
{
    public Guid RunId { get; set; }
    public string NodeId { get; set; } = "";
    public string Outcome { get; set; } = "";
    public Guid? ApprovedBy { get; set; }
}
public class SupportWorkflowSchedule : TenantEntity, ITenantScoped
{
    public Guid WorkflowId { get; set; }
    public Guid TicketId { get; set; }
    public Guid UserId { get; set; }
    public int IntervalMinutes { get; set; } = 60;
    public DateTime NextRunAt { get; set; }
    public bool Enabled { get; set; } = true;
    public int Version { get; set; } = 1;
}