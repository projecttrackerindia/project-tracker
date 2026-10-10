using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Entities;

public class AiCreditAccount : TenantEntity, ITenantScoped
{
    public DateTime PeriodStart { get; set; }
    public long Spent { get; set; }
    public long Reserved { get; set; }
}

public class AiCreditReservation : TenantEntity, ITenantScoped
{
    public Guid AccountId { get; set; }
    public Guid UserId { get; set; }
    public Guid OperationId { get; set; }
    public int Amount { get; set; }
    public int Charged { get; set; }
    public string Feature { get; set; } = "workspace";
    public string Status { get; set; } = "reserved";
    public DateTime ExpiresAt { get; set; }
    public DateTime? SettledAt { get; set; }
}

/// <summary>Append-only customer credit movements. These are not provider invoices or currency.</summary>
public class AiCreditEntry : TenantEntity, ITenantScoped
{
    public Guid AccountId { get; set; }
    public Guid? ReservationId { get; set; }
    public Guid? UserId { get; set; }
    public string Kind { get; set; } = "settlement";
    public long SpentDelta { get; set; }
    public long ReservedDelta { get; set; }
    public string PolicyVersion { get; set; } = "plan-tier-v1";
}

public class AiCreditBudget : TenantEntity, ITenantScoped
{
    public string Scope { get; set; } = "user";
    public Guid SubjectId { get; set; }
    public long MonthlyLimit { get; set; }
    public bool Enabled { get; set; } = true;
    public int Version { get; set; } = 1;
}

public class AiCreditBudgetUsage : TenantEntity, ITenantScoped
{
    public Guid BudgetId { get; set; }
    public Guid AccountId { get; set; }
    public long Spent { get; set; }
    public long Reserved { get; set; }
}

/// <summary>Retains budget attribution at admission, even after membership or budget settings change.</summary>
public class AiCreditBudgetHold : TenantEntity, ITenantScoped
{
    public Guid ReservationId { get; set; }
    public Guid BudgetUsageId { get; set; }
    public int PolicyVersion { get; set; }
}
