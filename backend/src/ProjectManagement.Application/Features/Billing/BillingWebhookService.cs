using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Billing;

/// <summary>
/// What the payment provider tells us, by signed webhook: a subscription became active, was charged again, ran out of retries, or was cancelled. This is the
/// source of truth for money: the same event arriving twice (providers retry) is recognized and does nothing the second time, and an event for a
/// subscription we do not know is ignored without an error so the provider stops retrying.
/// </summary>
public class BillingWebhookService(IAppDbContext db, IPaymentProvider payments, SubscriptionActivator activator, NotificationRouter router, TimeProvider clock, ILogger<BillingWebhookService> log)
{
    public async Task HandleAsync(string body, string? signature, string? eventId, CancellationToken ct = default)
    {
        if (!payments.VerifyWebhook(body, signature)) throw new UnauthorizedException("The signature of this message is not valid.");
        using var doc = JsonDocument.Parse(body);
        var root = doc.RootElement;
        var type = root.TryGetProperty("event", out var ev) ? ev.GetString() ?? "" : "";
        eventId = string.IsNullOrWhiteSpace(eventId) ? $"{type}:{Guid.NewGuid():N}" : eventId;

        var seen = db.BillingEvents.Add(new BillingEvent { Provider = payments.Name, ProviderEventId = eventId, Type = type, ReceivedAt = clock.GetUtcNow().UtcDateTime });
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateException) { seen.State = EntityState.Detached; return; }   // the same event again: already handled

        if (!root.TryGetProperty("payload", out var payload) || !payload.TryGetProperty("subscription", out var subWrap) || !subWrap.TryGetProperty("entity", out var subEntity)) return;
        var providerSubId = subEntity.GetProperty("id").GetString() ?? "";
        var sub = await db.Subscriptions.Include(s => s.Plan).FirstOrDefaultAsync(s => s.ProviderSubscriptionId == providerSubId || s.PendingProviderSubscriptionId == providerSubId, ct);
        if (sub is null) { log.LogInformation("Billing event {Type} for an unknown subscription {Id}", type, providerSubId); return; }
        var pending = sub.PendingProviderSubscriptionId == providerSubId;
        var now = clock.GetUtcNow().UtcDateTime;
        var owner = await db.Tenants.IgnoreQueryFilters().Where(t => t.Id == sub.TenantId).Select(t => t.OwnerUserId).FirstOrDefaultAsync(ct);

        switch (type)
        {
            case "subscription.activated":
            case "subscription.charged":
            {
                var plan = pending && sub.PendingPlanId is { } pid ? await db.Plans.FirstAsync(p => p.Id == pid, ct) : sub.Plan ?? await db.Plans.FirstAsync(p => p.Id == sub.PlanId, ct);
                await activator.ActivateAsync(sub, plan, providerSubId, At(subEntity, "current_start") ?? now, At(subEntity, "current_end"), ct);
                if (payload.TryGetProperty("payment", out var pay) && pay.TryGetProperty("entity", out var pe) && pe.TryGetProperty("id", out var payId))
                {
                    var minor = pe.TryGetProperty("amount", out var a) ? a.GetInt64() : 0;
                    var currency = pe.TryGetProperty("currency", out var c) ? c.GetString() ?? plan.Currency : plan.Currency;
                    await activator.RecordPaymentAsync(sub.TenantId, plan, minor / (currency == "JPY" ? 1m : 100m), currency, payId.GetString()!, true, null, $"{plan.Name} plan — {(type == "subscription.charged" ? "monthly charge" : "subscription")}", ct);
                }
                break;
            }
            case "subscription.pending":      // a charge failed; the provider will try again
            case "subscription.halted":       // it ran out of retries
                if (pending) break;
                if (sub.Status == SubscriptionStatus.Active) await TellOwnerAsync(sub, owner, "Payment failed — please update billing", type == "subscription.halted" ? "We could not renew your plan after several tries." : "We could not renew your plan. We will try again; you can also update your payment method.", ct);
                sub.Status = SubscriptionStatus.PastDue;
                break;
            case "subscription.cancelled":
            case "subscription.completed":
                if (pending) { sub.PendingPlanId = null; sub.PendingProviderSubscriptionId = null; break; }   // a payment window that was never completed
                if (sub.Status != SubscriptionStatus.Expired) { sub.Status = SubscriptionStatus.Cancelled; sub.CancelAtPeriodEnd = true; sub.CancelledAt ??= now; sub.CurrentPeriodEnd ??= now; }
                break;
        }
        await db.SaveChangesAsync(ct);
    }

    private static DateTime? At(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var s) ? DateTimeOffset.FromUnixTimeSeconds(s).UtcDateTime : null;

    private async Task TellOwnerAsync(Subscription sub, Guid owner, string title, string body, CancellationToken ct)
    {
        var note = new Notification { TenantId = sub.TenantId, UserId = owner, Type = NotificationType.Subscription, CreatedAt = clock.GetUtcNow().UtcDateTime, Link = "/settings/billing", Title = title, Body = body };
        if (await router.ApplyAsync(note, ct)) db.Notifications.Add(note);
    }
}
