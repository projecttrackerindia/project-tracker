using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Billing;

/// <summary>The steps shared by "the browser says the payment succeeded" and "the provider's webhook says so": both end in the same state, and doing both changes nothing twice.</summary>
public class SubscriptionActivator(IAppDbContext db, IPaymentProvider payments, ILogger<SubscriptionActivator> log)
{
    /// <summary>Makes <paramref name="plan"/> the workspace's plan, paid through the provider subscription <paramref name="providerSubscriptionId"/>.</summary>
    public async Task ActivateAsync(Subscription sub, Plan plan, string providerSubscriptionId, DateTime start, DateTime? end, CancellationToken ct)
    {
        // Switching plans: the older recurring payment ends now, so nobody pays for two plans.
        if (sub.ProviderSubscriptionId is { } older && older != providerSubscriptionId) await CancelAtProviderAsync(older, atCycleEnd: false, ct);
        var changedPlan = sub.PlanId != plan.Id || sub.ProviderSubscriptionId != providerSubscriptionId;
        sub.PlanId = plan.Id; sub.Plan = plan; sub.Status = SubscriptionStatus.Active;
        sub.Provider = payments.Name; sub.ProviderSubscriptionId = providerSubscriptionId;
        sub.PendingPlanId = null; sub.PendingProviderSubscriptionId = null;
        sub.TrialEnd = null; sub.CancelAtPeriodEnd = false; sub.CancelledAt = null;
        // The browser's confirmation does not know the period yet (the provider's message does): until then, one month.
        if (changedPlan || end is not null) { sub.CurrentPeriodStart = start; sub.CurrentPeriodEnd = end ?? start.AddMonths(1); }
        else if (end is null && sub.CurrentPeriodEnd is null) sub.CurrentPeriodEnd = start.AddMonths(1);
    }

    /// <summary>Stops a recurring payment at the provider. A failure is logged and not thrown when the aim is only to tidy up; ending the payment the owner asked to cancel is checked by the caller.</summary>
    public async Task CancelAtProviderAsync(string providerSubscriptionId, bool atCycleEnd, CancellationToken ct)
    {
        try { await payments.CancelSubscriptionAsync(providerSubscriptionId, atCycleEnd, ct); }
        catch (Exception ex) when (ex is InvalidOperationException or HttpRequestException or TaskCanceledException)
        {
            log.LogWarning(ex, "Could not cancel provider subscription {Id}", providerSubscriptionId);
            if (atCycleEnd) throw new Exceptions.AppException(502, "PAYMENT_PROVIDER_ERROR", "The payment service could not cancel the subscription. Try again in a moment.");
        }
    }

    /// <summary>One invoice per provider payment id, however many times it is reported (the browser, the webhook, a webhook retry).</summary>
    public async Task RecordPaymentAsync(Guid tenantId, Plan plan, decimal amount, string currency, string paymentId, bool success, string? error, string description, CancellationToken ct)
    {
        if (await db.Invoices.IgnoreQueryFilters().AnyAsync(i => i.TenantId == tenantId && i.ProviderReference == paymentId, ct)) return;
        var now = DateTime.UtcNow;
        db.Invoices.Add(new Invoice
        {
            TenantId = tenantId, Number = BillingService.NewInvoiceNumber(now), PlanCode = plan.Code, Amount = amount, Currency = currency,
            Status = success ? InvoiceStatus.Paid : InvoiceStatus.Failed, ProviderReference = paymentId, Description = error is null ? description : $"{description} ({error})", IssuedAt = now, CreatedAt = now,
        });
    }
}
