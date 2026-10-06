using ProjectManagement.Domain.Common;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Domain.Entities;

public class Plan : AuditableEntity
{
    public string Code { get; set; } = "";
    public string Name { get; set; } = "";
    public string? Description { get; set; }
    /// <summary>Null = custom pricing (contact sales).</summary>
    public decimal? PriceMonthly { get; set; }
    /// <summary>The currency <see cref="PriceMonthly"/> is in. Follows the platform's billing currency (Admin → Platform settings).</summary>
    public string Currency { get; set; } = "INR";
    public bool IsActive { get; set; } = true;
    public int SortOrder { get; set; }
    /// <summary>The same plan at the payment provider (Razorpay plan_...), created the first time someone subscribes; recreated when the price changes.</summary>
    public string? ProviderPlanId { get; set; }
    public decimal? ProviderPlanAmount { get; set; }
    public ICollection<PlanFeature> Features { get; set; } = new List<PlanFeature>();
}

/// <summary>Numeric entitlement. -1 = unlimited, for boolean features 1 = enabled / 0 = disabled.</summary>
public class PlanFeature : Entity
{
    public Guid PlanId { get; set; }
    public string FeatureKey { get; set; } = "";
    public long Value { get; set; }
}

/// <summary>Subscriptions are looked up explicitly by TenantId (also from admin/background contexts).</summary>
public class Subscription : TenantEntity
{
    public Guid PlanId { get; set; }
    public SubscriptionStatus Status { get; set; } = SubscriptionStatus.Active;
    public DateTime CurrentPeriodStart { get; set; }
    public DateTime? CurrentPeriodEnd { get; set; }
    public DateTime? TrialEnd { get; set; }
    public bool CancelAtPeriodEnd { get; set; }
    public DateTime? CancelledAt { get; set; }
    /// <summary>Who takes the payments: null (the platform's own simulated billing) or the provider's name ("razorpay").</summary>
    public string? Provider { get; set; }
    /// <summary>The recurring subscription at the provider (sub_...) that pays for this plan.</summary>
    public string? ProviderSubscriptionId { get; set; }
    /// <summary>A plan the owner started paying for but has not completed yet (the payment window is open): it takes effect when the provider confirms.</summary>
    public Guid? PendingPlanId { get; set; }
    public string? PendingProviderSubscriptionId { get; set; }
    public Plan? Plan { get; set; }
}

/// <summary>A message from the payment provider that was already handled: the same event arriving twice (providers retry) does nothing the second time.</summary>
public class BillingEvent : Entity
{
    public string Provider { get; set; } = "";
    public string ProviderEventId { get; set; } = "";
    public string Type { get; set; } = "";
    public DateTime ReceivedAt { get; set; }
}

public class Invoice : TenantEntity, ITenantScoped
{
    public string Number { get; set; } = "";
    public string PlanCode { get; set; } = "";
    public decimal Amount { get; set; }
    public string Currency { get; set; } = "INR";
    public InvoiceStatus Status { get; set; } = InvoiceStatus.Paid;
    public string Description { get; set; } = "";
    public string? ProviderReference { get; set; }
    public DateTime IssuedAt { get; set; }
}
