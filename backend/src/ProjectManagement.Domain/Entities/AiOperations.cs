using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Entities;

/// <summary>Private durable work. The worker re-resolves the requester's current permissions before each run.</summary>
public class AiJob : TenantEntity, ITenantScoped
{
    public Guid UserId { get; set; }
    public Guid? ScheduleId { get; set; }
    public Guid? TeamId { get; set; }
    public string Kind { get; set; } = "portfolio";
    public string Title { get; set; } = "Portfolio review";
    public string IdempotencyKey { get; set; } = "";
    public string Status { get; set; } = "queued";
    public int Priority { get; set; }
    public int Attempts { get; set; }
    public int Progress { get; set; }
    public DateTime AvailableAt { get; set; }
    public Guid? LeaseOwner { get; set; }
    public DateTime? LeaseExpiresAt { get; set; }
    public DateTime? StartedAt { get; set; }
    public DateTime? CompletedAt { get; set; }
    public string? ErrorCode { get; set; }
    public string? ResultJson { get; set; }
    public string? AccessFingerprint { get; set; }
}

/// <summary>Opt-in recurring, read-only reviews. No external messages or unapproved business writes.</summary>
public class AiSchedule : TenantEntity, ITenantScoped
{
    public Guid UserId { get; set; }
    public Guid? TeamId { get; set; }
    public string Kind { get; set; } = "portfolio";
    public string Title { get; set; } = "Portfolio review";
    public int IntervalMinutes { get; set; } = 1440;
    public bool Enabled { get; set; } = true;
    public DateTime NextRunAt { get; set; }
    public DateTime? LastQueuedAt { get; set; }
}

/// <summary>Server-calculated forecast evidence. Completion comes from actual audited project status transitions.</summary>
public class AiForecastSnapshot : TenantEntity, ITenantScoped
{
    public Guid UserId { get; set; }
    public Guid JobId { get; set; }
    public Guid ProjectId { get; set; }
    public DateTime EvidenceAt { get; set; }
    public DateOnly AsOf { get; set; }
    public DateOnly? DueDate { get; set; }
    public DateOnly? ProjectedFinish { get; set; }
    public int ProjectVersion { get; set; }
    public int TotalTasks { get; set; }
    public int OpenTasks { get; set; }
    public int FinishedLast28Days { get; set; }
    public bool InputComplete { get; set; }
    public string Confidence { get; set; } = "none";
    public string MethodologyVersion { get; set; } = "portfolio-pace-v1";
}
