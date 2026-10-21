using System.Text.Json;
using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
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
public class BillingWebhookService(IAppDbContext db, IPaymentProvider payments, SubscriptionActivator activator, NotificationRouter router, TimeProvider clock, ILogger<BillingWebhookService> log, BillingMailer? mailer = null)
{
    public async Task HandleAsync(string body, string? signature, string? eventId, CancellationToken ct = default)
    {
        if (!payments.VerifyWebhook(body, signature)) throw new UnauthorizedException("The signature of this message is not valid.");
        using var doc = JsonDocument.Parse(body);
        var root = doc.RootElement;
        var type = root.TryGetProperty("event", out var ev) ? ev.GetString() ?? "" : "";
        var bodyHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(body)));
        eventId = string.IsNullOrWhiteSpace(eventId) ? bodyHash : eventId;
        if (eventId.Length > 100) throw new ValidationException("eventId", "The payment event ID is too long.");
        // The same signed message replayed under another event id is the same event: the body itself is a receipt too.
        var bodyKey = "body:" + bodyHash;
        await using var transaction = await db.Database.BeginOwnedTransactionAsync(ct);
        await db.LockBillingEventsAsync(payments.Name, ct);
        if (await db.BillingEvents.AnyAsync(e => e.Provider == payments.Name && (e.ProviderEventId == eventId || e.ProviderEventId == bodyKey), ct))
        { await transaction.CommitIfOwnedAsync(ct); return; }

        var receivedAt = clock.GetUtcNow().UtcDateTime;
        db.BillingEvents.Add(new BillingEvent { Provider = payments.Name, ProviderEventId = eventId, Type = type, ReceivedAt = receivedAt });
        if (bodyKey != eventId) db.BillingEvents.Add(new BillingEvent { Provider = payments.Name, ProviderEventId = bodyKey, Type = type, ReceivedAt = receivedAt });

        if (type.StartsWith("refund.", StringComparison.Ordinal) && root.TryGetProperty("payload", out var refundPayload))
        {
            var refundMail = await RecordRefundAsync(type, refundPayload, ct);
            await db.SaveChangesAsync(ct);
            await transaction.CommitIfOwnedAsync(ct);
            if (refundMail is { } r && mailer is not null) await mailer.RefundAsync(r.Invoice, r.Amount, r.Currency, r.RefundId, r.Succeeded, r.Full, ct);
            return;
        }
        if (!root.TryGetProperty("payload", out var payload) || !payload.TryGetProperty("subscription", out var subWrap) || !subWrap.TryGetProperty("entity", out var subEntity))
        { await db.SaveChangesAsync(ct); await transaction.CommitIfOwnedAsync(ct); return; }
        var providerSubId = subEntity.GetProperty("id").GetString() ?? "";
        var sub = await db.Subscriptions.Include(s => s.Plan).FirstOrDefaultAsync(s => s.ProviderSubscriptionId == providerSubId || s.PendingProviderSubscriptionId == providerSubId, ct);
        if (sub is null)
        {
            var noted = subEntity.TryGetProperty("notes", out var notes) && notes.ValueKind == JsonValueKind.Object && notes.TryGetProperty("tenantId", out var nt) && nt.ValueKind == JsonValueKind.String ? nt.GetString() : null;
            log.LogWarning("Billing event {Type} for an unknown subscription {Id} (tenant in its notes: {NotedTenant})", type, providerSubId, noted ?? "none");
            await db.SaveChangesAsync(ct); await transaction.CommitIfOwnedAsync(ct); return;
        }
        var pending = sub.PendingProviderSubscriptionId == providerSubId;
        var now = clock.GetUtcNow().UtcDateTime;
        var owner = await db.Tenants.IgnoreQueryFilters().Where(t => t.Id == sub.TenantId).Select(t => t.OwnerUserId).FirstOrDefaultAsync(ct);
        // E-mails go out only after the change is committed, so a message never describes something that was rolled back.
        var after = new List<Func<Task>>();

        switch (type)
        {
            case "subscription.authenticated":
                // A change of people that starts at the next renewal is approved now: apply it even if the browser never reported back.
                if (pending && sub.PendingPlanId is { } scheduledPlan && await db.Plans.FirstOrDefaultAsync(p => p.Id == scheduledPlan, ct) is { } sp && activator.IsScheduledChange(sub, sp, now))
                    await activator.ActivateAsync(sub, sp, providerSubId, now, null, ct);
                break;
            case "subscription.activated":
            case "subscription.charged":
            {
                var plan = pending && sub.PendingPlanId is { } pid ? await db.Plans.FirstAsync(p => p.Id == pid, ct) : sub.Plan ?? await db.Plans.FirstAsync(p => p.Id == sub.PlanId, ct);
                // A cancelled subscription is not switched back on by an event from before the cancellation (a late or replayed message);
                // only an event created after it (the provider really charged again) brings it back.
                var created = At(root, "created_at");
                if (!pending && sub.CancelledAt is { } cancelledAt && (created is null || created <= cancelledAt))
                    log.LogWarning("Ignored {Type} for cancelled subscription {Id}: the event is not newer than the cancellation", type, providerSubId);
                else
                    await activator.ActivateAsync(sub, plan, providerSubId, At(subEntity, "current_start") ?? now, At(subEntity, "current_end"), ct);
                if (payload.TryGetProperty("payment", out var pay) && pay.TryGetProperty("entity", out var pe) && pe.TryGetProperty("id", out var payId))
                {
                    var minor = pe.TryGetProperty("amount", out var a) ? a.GetInt64() : 0;
                    var currency = pe.TryGetProperty("currency", out var c) ? c.GetString() ?? plan.Currency : plan.Currency;
                    var invoice = await activator.RecordPaymentAsync(sub.TenantId, plan, minor / (currency == "JPY" ? 1m : 100m), currency, payId.GetString()!, true, null, $"{plan.Name} plan — {(plan.PerSeat ? $"{sub.Seats} seat{(sub.Seats == 1 ? "" : "s")}, " : "")}{(type == "subscription.charged" ? sub.BillingPeriod + " charge" : "subscription")}", ct);
                    if (invoice is not null)
                    {
                        var method = PaymentMethod(pe);
                        var until = sub.CurrentPeriodEnd; var renews = sub.Status == SubscriptionStatus.Active && !sub.CancelAtPeriodEnd;
                        after.Add(() => mailer?.PaymentReceivedAsync(invoice, plan.Name, until, renews, method, ct) ?? Task.CompletedTask);
                    }
                }
                break;
            }
            case "subscription.pending":      // a charge failed; the provider will try again
            case "subscription.halted":       // it ran out of retries
                if (pending) break;
                {
                    var halted = type == "subscription.halted";
                    // One e-mail when a renewal first fails, and one more when the provider gives up; not one per retry.
                    if (sub.Status == SubscriptionStatus.Active || (halted && !await AlreadyToldHaltedAsync(HaltedKey(sub, providerSubId), ct)))
                    {
                        await TellOwnerAsync(sub, owner, halted ? "Payment failed — plan will lapse" : "Payment failed — we will retry", halted ? "We could not renew your plan after several tries." : "We could not renew your plan. We will try again; you can also update your payment method.", ct);
                        var planName = (sub.Plan ?? await db.Plans.FirstAsync(p => p.Id == sub.PlanId, ct)).Name;
                        var (failedAmount, failedCurrency, reason) = FailedPayment(payload, sub.Plan?.Currency ?? "INR");
                        var worksUntil = (sub.CurrentPeriodEnd ?? now).AddDays(7);
                        after.Add(() => mailer?.PaymentFailedAsync(sub.TenantId, planName, failedAmount, failedCurrency, reason, !halted, worksUntil, ct) ?? Task.CompletedTask);
                        if (halted) db.BillingEvents.Add(new BillingEvent { Provider = payments.Name, ProviderEventId = HaltedKey(sub, providerSubId), Type = "subscription.halted", ReceivedAt = now });
                    }
                    sub.Status = SubscriptionStatus.PastDue;
                }
                break;
            case "subscription.cancelled":
            case "subscription.completed":
                if (pending) { sub.PendingPlanId = null; sub.PendingProviderSubscriptionId = null; break; }   // a payment window that was never completed
                if (sub.Status != SubscriptionStatus.Expired) { sub.Status = SubscriptionStatus.Cancelled; sub.CancelAtPeriodEnd = true; sub.CancelledAt ??= now; sub.CurrentPeriodEnd ??= now; }
                break;
        }
        await db.SaveChangesAsync(ct);
        await transaction.CommitIfOwnedAsync(ct);
        foreach (var send in after) await send();
    }

    /// <summary>"UPI", "Card ending 4242", "Netbanking (HDFC)": how the customer paid, for the receipt.</summary>
    internal static string? PaymentMethod(JsonElement payment)
    {
        var method = payment.TryGetProperty("method", out var m) ? m.GetString() : null;
        string? Str(string name) => payment.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        return method switch
        {
            "upi" => "UPI",
            "card" => payment.TryGetProperty("card", out var card) && card.ValueKind == JsonValueKind.Object && card.TryGetProperty("last4", out var l4) && l4.ValueKind == JsonValueKind.String ? $"Card ending {l4.GetString()}" : "Card",
            "netbanking" => Str("bank") is { } bank ? $"Netbanking ({bank})" : "Netbanking",
            "wallet" => Str("wallet") is { } w ? $"Wallet ({w})" : "Wallet",
            "emandate" or "nach" => "Bank mandate",
            null => null,
            _ => method,
        };
    }

    private static (decimal? Amount, string Currency, string? Reason) FailedPayment(JsonElement payload, string fallbackCurrency)
    {
        if (!payload.TryGetProperty("payment", out var wrap) || !wrap.TryGetProperty("entity", out var p)) return (null, fallbackCurrency, null);
        var currency = p.TryGetProperty("currency", out var c) && c.ValueKind == JsonValueKind.String ? c.GetString()! : fallbackCurrency;
        decimal? amount = p.TryGetProperty("amount", out var a) && a.ValueKind == JsonValueKind.Number ? a.GetInt64() / 100m : null;
        var reason = p.TryGetProperty("error_description", out var e) && e.ValueKind == JsonValueKind.String ? e.GetString() : null;
        return (amount, currency, reason);
    }

    /// <summary>One "we gave up" e-mail per subscription and paid period, however many halted events arrive.</summary>
    private static string HaltedKey(Subscription sub, string providerSubId) => $"halted:{providerSubId}:{sub.CurrentPeriodEnd:yyyyMMdd}";
    private Task<bool> AlreadyToldHaltedAsync(string key, CancellationToken ct) => db.BillingEvents.AnyAsync(e => e.Provider == payments.Name && e.ProviderEventId == key, ct);

    private sealed record RefundMail(Invoice Invoice, decimal Amount, string Currency, string RefundId, bool Succeeded, bool Full);

    /// <summary>
    /// A refund made in the provider's dashboard (or by its API): the invoice it belongs to is marked refunded when the whole amount has gone back, and the
    /// owner is told either way. A refund for a payment we never invoiced (a resume purchase, someone else's payment) is ignored.
    /// </summary>
    private async Task<RefundMail?> RecordRefundAsync(string type, JsonElement payload, CancellationToken ct)
    {
        if (type is not ("refund.processed" or "refund.failed") || !payload.TryGetProperty("refund", out var wrap) || !wrap.TryGetProperty("entity", out var refund)) return null;
        var refundId = refund.TryGetProperty("id", out var rid) ? rid.GetString() ?? "" : "";
        var paymentId = refund.TryGetProperty("payment_id", out var pid) ? pid.GetString() ?? "" : "";
        if (paymentId.Length == 0) return null;
        var invoice = await db.Invoices.IgnoreQueryFilters().FirstOrDefaultAsync(i => i.ProviderReference == paymentId, ct);
        if (invoice is null) { log.LogInformation("Refund {Refund} is for payment {Payment}, which has no invoice here", refundId, paymentId); return null; }
        var amount = refund.TryGetProperty("amount", out var a) && a.ValueKind == JsonValueKind.Number ? a.GetInt64() / 100m : invoice.Amount;
        var currency = refund.TryGetProperty("currency", out var c) && c.ValueKind == JsonValueKind.String ? c.GetString()! : invoice.Currency;
        var succeeded = type == "refund.processed";
        // Several part-refunds add up: the payment's own running total says whether all of it has gone back.
        var refundedSoFar = payload.TryGetProperty("payment", out var pw) && pw.TryGetProperty("entity", out var pe) && pe.TryGetProperty("amount_refunded", out var ar) && ar.ValueKind == JsonValueKind.Number
            ? ar.GetInt64() / 100m : amount;
        var full = refundedSoFar >= invoice.Amount;
        if (succeeded)
        {
            if (full) invoice.Status = InvoiceStatus.Refunded;
            var note = $" (refunded {BillingMailer.Money(amount, currency)} on {BillingMailer.Day(clock.GetUtcNow().UtcDateTime)}, {refundId})";
            if (invoice.Description.Length + note.Length <= 500) invoice.Description += note;
        }
        log.LogInformation("Refund {Refund} of {Amount} {Currency} for invoice {Invoice}: {Type}", refundId, amount, currency, invoice.Number, type);
        return new RefundMail(invoice, amount, currency, refundId, succeeded, full);
    }

    private static DateTime? At(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var s) ? DateTimeOffset.FromUnixTimeSeconds(s).UtcDateTime : null;

    private async Task TellOwnerAsync(Subscription sub, Guid owner, string title, string body, CancellationToken ct)
    {
        var note = new Notification { TenantId = sub.TenantId, UserId = owner, Type = NotificationType.Subscription, CreatedAt = clock.GetUtcNow().UtcDateTime, Link = "/settings/billing", Title = title, Body = body };
        // The full e-mail comes from BillingMailer; the in-app notice must not send a second, plainer one.
        if (await router.ApplyAsync(note, ct)) { note.EmailPending = false; db.Notifications.Add(note); }
    }
}
