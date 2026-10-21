using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Files;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Workspaces;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Billing;

/// <param name="PerSeat">The price, storage and AI credits are per person (<paramref name="Features"/> holds the per-person values).</param>
public record PlanDto(Guid Id, string Code, string Name, string? Description, decimal? PriceMonthly, string Currency,
    IReadOnlyDictionary<string, long> Features, bool IsCurrent, int SortOrder, bool PerSeat = false);
/// <summary>What the public pricing page shows: the plan, what it costs and what a person gets, nothing about any organization.</summary>
public record PublicPlanDto(string Code, string Name, decimal? PriceMonthly, string Currency, bool PerSeat = false, long AiCreditsPerSeat = 0, long StorageMbPerSeat = 0, int AiModelTier = 0);
public record PricingPolicyDto(int AnnualDiscountPercent, IReadOnlyList<VolumeTier> VolumeTiers, int MaxTotalDiscountPercent, int TrialSeats, int TrialAiCredits, int MaxSeats);
public record PublicPricingDto(IReadOnlyList<PublicPlanDto> Plans, PricingPolicyDto Policy);
/// <summary>The people a workspace pays for, how many are in it (members and invitations), and what the next renewal costs.</summary>
public record SeatsDto(bool PerSeat, int Purchased, int InUse, string Period, PriceQuote? Renewal);
/// <summary>What a choice would cost and give, for the plan chooser: the price, the smallest number of seats that fits the people already here, and the pooled credits and storage.</summary>
public record QuoteDto(PriceQuote Quote, int MinSeats, int MaxSeats, long AiCredits, long StorageMb);
public record UsageDto(string Key, string Label, long Used, long Limit);
public record InvoiceDto(Guid Id, string Number, string PlanCode, decimal Amount, string Currency, InvoiceStatus Status, string Description, DateTime IssuedAt);
/// <param name="PaymentProvider">"mock" (simulated) or "razorpay"; the screen words its buttons accordingly.</param>
/// <param name="Payment">Set when the owner must now pay in the provider's window to finish choosing a plan.</param>
public record BillingOverviewDto(PlanSummaryDto Plan, IReadOnlyList<UsageDto> Usage, IReadOnlyList<InvoiceDto> Invoices, bool TrialAvailable,
    IReadOnlyList<PlanDto> Plans, bool CanManage, string PaymentProvider = "mock", HostedCheckout? Payment = null, SeatsDto? Seats = null, PricingPolicyDto? Policy = null,
    UpiPaymentDto? Upi = null);
/// <param name="Seats">The people to pay for on a per-person plan (default: the people already in the workspace).</param>
/// <param name="Period">"monthly" or "yearly".</param>
public record CheckoutRequest(string PlanCode, bool StartTrial, int? Seats = null, string? Period = null);
public record ConfirmPaymentRequest(string PaymentId, string SubscriptionId, string Signature);

public class BillingService(
    IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, PermissionService permissions,
    EntitlementService entitlements, IPaymentProvider payments, SubscriptionActivator activator, IOptions<AppOptions> options, IOptions<PricingOptions> pricing,
    ILogger<BillingService> log, UpiBillingService upi, BillingMailer? mailer = null)
{
    private readonly AppOptions _opt = options.Value;
    private readonly PricingOptions _pricing = pricing.Value;

    private PriceQuote QuoteOf(Plan plan, int seats, string? period) => Pricing.Quote(_pricing, plan.Code, plan.PriceMonthly ?? 0, plan.Currency, plan.PerSeat, seats, period);
    private PricingPolicyDto Policy() => new(_pricing.AnnualDiscountPercent, _pricing.VolumeTiers, _pricing.MaxTotalDiscountPercent, Pricing.TrialSeats, Pricing.TrialAiCredits, _pricing.MaxSeats);

    /// <summary>The people who must keep a seat: members and invitations that are still open.</summary>
    private async Task<int> PeopleAsync(Guid tenantId, CancellationToken ct) =>
        await db.TenantMembers.CountAsync(m => m.TenantId == tenantId, ct)
        + await db.TenantInvitations.CountAsync(i => i.TenantId == tenantId && i.Status == InvitationStatus.Pending && i.ExpiresAt > clock.Now, ct);

    private static long FeatureOf(Plan plan, string key) => plan.Features.FirstOrDefault(f => f.FeatureKey == key)?.Value ?? 0;

    private static bool CanStartTrial(bool trialUsed, EffectivePlan plan, bool providerLinked) =>
        !trialUsed && plan.Plan.Code == EntitlementService.FreePlan && !providerLinked;

    public async Task<BillingOverviewDto> GetOverviewAsync(CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        entitlements.Forget(tid);   // a change made earlier in this same request must show in the answer
        var plan = await entitlements.GetEffectivePlanAsync(tid, ct);
        var tenant = await db.Tenants.AsNoTracking().FirstAsync(t => t.Id == tid, ct);
        var canManage = await permissions.HasAsync(Permissions.BillingManage, ct);

        var invoices = canManage
            ? (await db.Invoices.AsNoTracking().OrderByDescending(i => i.IssuedAt).Take(24).ToListAsync(ct))
                .Select(i => new InvoiceDto(i.Id, i.Number, i.PlanCode, i.Amount, i.Currency, i.Status, i.Description, i.IssuedAt)).ToList()
            : [];
        var usage = (await entitlements.GetUsageAsync(ct)).Select(u => new UsageDto(u.Key, u.Label, u.Used, u.Limit)).ToList();

        var seats = usage.FirstOrDefault(u => u.Key == FeatureKeys.MaxMembers)?.Used ?? 0;
        var paying = plan.Plan.PerSeat && plan.Status != SubscriptionStatus.Trial && plan.Plan.PriceMonthly is > 0;
        var providerLinked = await db.Subscriptions.AnyAsync(s => s.TenantId == tid
            && (s.ProviderSubscriptionId != null || s.PendingProviderSubscriptionId != null), ct);
        var seatInfo = new SeatsDto(plan.Plan.PerSeat, plan.Plan.PerSeat ? (plan.Status == SubscriptionStatus.Trial ? Pricing.TrialSeats : plan.Seats) : 1, (int)seats, plan.BillingPeriod,
            paying ? QuoteOf(plan.Plan, plan.Seats, plan.BillingPeriod) : null);
        return new BillingOverviewDto(
            new PlanSummaryDto(plan.Plan.Code, plan.Plan.Name, plan.Status, plan.TrialEnd, plan.PeriodEnd, plan.CancelAtPeriodEnd, plan.Downgraded),
            usage, invoices, CanStartTrial(tenant.TrialUsed, plan, providerLinked), await GetPlansAsync(plan.Plan.Code, ct), canManage, upi.Enabled ? UpiBillingService.ProviderName : payments.Name,
            null, seatInfo, Policy(), canManage ? await upi.CurrentAsync(ct) : null);
    }

    /// <summary>The price and the pooled credits and storage of a choice, for the screen that lets the owner pick people and a billing period.</summary>
    public async Task<QuoteDto> QuoteAsync(string? planCode, int? seats, string? period, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(planCode)) throw new ValidationException("planCode", "Say which plan to price.");
        var tid = ctx.RequireTenantId();
        var plan = await db.Plans.AsNoTracking().Include(p => p.Features).FirstOrDefaultAsync(p => p.Code == planCode.ToUpper() && p.IsActive, ct) ?? throw new NotFoundException("Plan not found.");
        var min = Math.Max(1, await PeopleAsync(tid, ct));
        var q = QuoteOf(plan, Math.Max(seats ?? min, 1), period);
        long Pooled(string key) { var v = FeatureOf(plan, key); return plan.PerSeat && v > 0 ? v * q.Seats : v; }
        return new QuoteDto(q, plan.PerSeat ? min : 1, _pricing.MaxSeats, Pooled(FeatureKeys.AiMonthlyCredits), Pooled(FeatureKeys.StorageLimitMb));
    }

    public async Task<IReadOnlyList<PlanDto>> GetPlansAsync(string? currentCode, CancellationToken ct = default)
    {
        var plans = await db.Plans.AsNoTracking().Include(p => p.Features).Where(p => p.IsActive).OrderBy(p => p.SortOrder).ToListAsync(ct);
        return plans.Select(p => new PlanDto(p.Id, p.Code, p.Name, p.Description, p.PriceMonthly, p.Currency,
            FeatureKeys.All.ToDictionary(k => k, k => p.Features.FirstOrDefault(f => f.FeatureKey == k)?.Value ?? 0),
            p.Code == currentCode, p.SortOrder, p.PerSeat)).ToList();
    }

    /// <summary>The active plans and their monthly price, for the public pricing page (no sign-in, no organization).</summary>
    public async Task<IReadOnlyList<PublicPlanDto>> GetPublicPlansAsync(CancellationToken ct = default)
        => await db.Plans.AsNoTracking().Where(p => p.IsActive).OrderBy(p => p.SortOrder)
            .Select(p => new PublicPlanDto(p.Code, p.Name, p.PriceMonthly, p.Currency, p.PerSeat,
                p.Features.Where(f => f.FeatureKey == FeatureKeys.AiMonthlyCredits).Select(f => f.Value).FirstOrDefault(),
                p.Features.Where(f => f.FeatureKey == FeatureKeys.StorageLimitMb).Select(f => f.Value).FirstOrDefault(),
                (int)p.Features.Where(f => f.FeatureKey == FeatureKeys.AiModelTier).Select(f => f.Value).FirstOrDefault())).ToListAsync(ct);

    /// <summary>The price list with the discount rules, for the website's price calculator (nothing about any organization).</summary>
    public async Task<PublicPricingDto> GetPublicPricingAsync(CancellationToken ct = default) => new(await GetPublicPlansAsync(ct), Policy());

    public async Task<BillingOverviewDto> CheckoutAsync(CheckoutRequest req, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.BillingManage, ct);
        var tid = ctx.RequireTenantId();
        var plan = await db.Plans.Include(p => p.Features).FirstOrDefaultAsync(p => p.Code == req.PlanCode.ToUpper() && p.IsActive, ct)
            ?? throw new NotFoundException("Plan not found.");
        var sub = await db.Subscriptions.FirstAsync(s => s.TenantId == tid, ct);
        var tenant = await db.Tenants.FirstAsync(t => t.Id == tid, ct);
        var now = clock.Now;
        var old = await entitlements.GetEffectivePlanAsync(tid, ct);

        if (req.StartTrial && (plan.Code == EntitlementService.FreePlan || !CanStartTrial(tenant.TrialUsed, old,
            sub.ProviderSubscriptionId is not null || sub.PendingProviderSubscriptionId is not null)))
            throw new ConflictException("A free trial is not available for this workspace. Refresh billing to see your current plan.", "TRIAL_NOT_AVAILABLE");

        if (plan.Code == EntitlementService.FreePlan)
        {
            // Going back to Free ends any recurring payment at the provider at once.
            if (sub.ProviderSubscriptionId is { } paying) await activator.CancelAtProviderAsync(paying, atCycleEnd: false, ct);
            // A payment window that was opened and never finished must not turn into a recurring payment later either.
            if (sub.PendingProviderSubscriptionId is { } unfinished && unfinished != sub.ProviderSubscriptionId) await activator.CancelAtProviderAsync(unfinished, atCycleEnd: false, ct);
            sub.Provider = null; sub.ProviderSubscriptionId = null; sub.PendingPlanId = null; sub.PendingProviderSubscriptionId = null; sub.PendingSeats = null; sub.PendingBillingPeriod = null;
            sub.PlanId = plan.Id; sub.Status = SubscriptionStatus.Active; sub.CurrentPeriodStart = now; sub.CurrentPeriodEnd = null;
            sub.Seats = 1; sub.BillingPeriod = Pricing.Monthly;
            sub.TrialEnd = null; sub.CancelAtPeriodEnd = false; sub.CancelledAt = null;
        }
        else if (plan.PriceMonthly is null)
        {
            throw new ValidationException("planCode", $"This plan has custom pricing. Write to {ProjectManagement.Application.Features.Auth.EmailTemplates.SupportEmail} to get started.");
        }
        else if (req.StartTrial)
        {
            sub.PlanId = plan.Id; sub.Status = SubscriptionStatus.Trial; sub.CurrentPeriodStart = now;
            sub.Seats = plan.PerSeat ? Pricing.TrialSeats : 1; sub.BillingPeriod = Pricing.Monthly;
            sub.TrialEnd = now.AddDays(_opt.TrialDays); sub.CurrentPeriodEnd = sub.TrialEnd; sub.CancelAtPeriodEnd = false; sub.CancelledAt = null;
            tenant.TrialUsed = true;
        }
        else
        {
            // A paid plan: how many people, and monthly or yearly. Nobody can pay for fewer seats than the people already here.
            var people = Math.Max(1, await PeopleAsync(tid, ct));
            var seats = plan.PerSeat ? req.Seats ?? people : 1;
            if (plan.PerSeat && seats < people)
                throw new ValidationException("seats", $"There are {people} people in this workspace (including open invitations), so you need at least {people} seats. Remove people or invitations first to choose fewer.");
            if (seats < 1 || seats > _pricing.MaxSeats) throw new ValidationException("seats", $"Choose between 1 and {_pricing.MaxSeats} seats. For more, contact sales.");
            var quote = QuoteOf(plan, seats, req.Period);
            var description = DescribePurchase(plan, quote);

            if (upi.Enabled)
            {
                // Paying by UPI QR: the plan changes when a platform administrator has confirmed the money arrived.
                var started = await upi.StartAsync(plan, seats, quote, description, ct);
                return (await GetOverviewAsync(ct)) with { Upi = started };
            }

            if (payments.RequiresCheckout)
            {
                // A real provider: nothing changes until the owner has paid in the provider's window and the provider confirms. Adding or removing people on the
                // plan and period already paid for starts the new amount at the next renewal, so the current one is not paid twice.
                var scheduled = !old.Status.Equals(SubscriptionStatus.Trial) && old.Plan.Code == plan.Code && sub.ProviderSubscriptionId is not null && old.BillingPeriod == quote.Period
                    && sub.Status == SubscriptionStatus.Active && sub.CurrentPeriodEnd is { } end && end > now.AddHours(12);
                HostedCheckout checkout;
                try
                {
                    var providerPlan = await payments.EnsurePlanAsync(plan.Code, plan.Name, quote.ChargePerCycle, plan.Currency, null, null, ct, quote.Period);
                    checkout = await payments.StartSubscriptionAsync(tid, plan.Code, plan.Name, providerPlan, quote.ChargePerCycle, plan.Currency, ct, quote.Period, scheduled ? sub.CurrentPeriodEnd : null, description);
                }
                catch (Exception ex) when (ex is InvalidOperationException or HttpRequestException or TaskCanceledException)
                {
                    log.LogWarning(ex, "Could not start a provider checkout for tenant {TenantId}", tid);
                    throw new AppException(502, "PAYMENT_PROVIDER_ERROR", "The payment service could not start the payment. Try again in a moment.");
                }
                // An earlier payment window that was never finished is replaced: end it at the provider so it cannot be approved and charged later.
                if (sub.PendingProviderSubscriptionId is { } previous && previous != checkout.SubscriptionId && previous != sub.ProviderSubscriptionId)
                    await activator.CancelAtProviderAsync(previous, atCycleEnd: false, ct);
                sub.PendingPlanId = plan.Id; sub.PendingProviderSubscriptionId = checkout.SubscriptionId; sub.PendingSeats = seats; sub.PendingBillingPeriod = quote.Period;
                recorder.Audit("billing.checkout_started", "Subscription", sub.Id, newValue: new { plan.Code, seats, quote.Period, quote.ChargePerCycle, checkout.SubscriptionId });
                await db.SaveChangesAsync(ct);
                return (await GetOverviewAsync(ct)) with { Payment = checkout };
            }

            var charge = await payments.ChargeAsync(tid, plan.Code, quote.ChargePerCycle, plan.Currency, ct);
            await SaveInvoiceAsync(db, new Invoice
            {
                TenantId = tid, PlanCode = plan.Code, Amount = quote.ChargePerCycle, Currency = plan.Currency,
                Status = charge.Success ? InvoiceStatus.Paid : InvoiceStatus.Failed, ProviderReference = charge.Reference,
                Description = description, IssuedAt = now, CreatedAt = now,
            }, charge.Success, null, ct);
            if (!charge.Success)
            {
                recorder.Audit("billing.payment_failed", "Subscription", sub.Id, newValue: new { plan.Code, charge.Error });
                await db.SaveChangesAsync(ct);
                throw new AppException(402, "PAYMENT_FAILED", charge.Error ?? "The payment could not be processed.");
            }
            sub.PlanId = plan.Id; sub.Status = SubscriptionStatus.Active; sub.CurrentPeriodStart = now; sub.Seats = seats; sub.BillingPeriod = quote.Period;
            sub.CurrentPeriodEnd = now.AddMonths(quote.CycleMonths); sub.TrialEnd = null; sub.CancelAtPeriodEnd = false; sub.CancelledAt = null;
        }

        recorder.Audit("subscription.changed", "Subscription", sub.Id, old.Plan.Code, plan.Code);
        recorder.Activity("subscription.changed", "Subscription", sub.Id, $"Plan changed: {old.Plan.Name} → {plan.Name}");
        await db.SaveChangesAsync(ct);
        return await GetOverviewAsync(ct);
    }

    /// <summary>"Pro plan — 12 seats, billed yearly (30% off)": what an invoice and the payment window say was bought.</summary>
    internal static string DescribePurchase(Plan plan, PriceQuote q)
    {
        var people = plan.PerSeat ? $"{q.Seats} seat{(q.Seats == 1 ? "" : "s")}, " : "";
        var off = q.TotalPercent > 0 ? $" ({q.TotalPercent}% off)" : "";
        return $"{plan.Name} plan — {people}billed {q.Period}{off}";
    }

    /// <summary>The browser reports the payment window's result. The signature proves it came from the provider; the webhook confirms the same thing later and changes nothing twice.</summary>
    public async Task<BillingOverviewDto> ConfirmPaymentAsync(ConfirmPaymentRequest req, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.BillingManage, ct);
        var tid = ctx.RequireTenantId();
        if (!payments.VerifyCheckout(req.PaymentId ?? "", req.SubscriptionId ?? "", req.Signature ?? ""))
            throw new AppException(400, "PAYMENT_SIGNATURE_INVALID", "The payment could not be verified. If money was taken, it will be matched to your account automatically.");
        var sub = await db.Subscriptions.FirstAsync(s => s.TenantId == tid, ct);
        if (sub.PendingProviderSubscriptionId != req.SubscriptionId || sub.PendingPlanId is not { } planId)
            throw new ConflictException("This payment does not match a plan you were choosing.", "PAYMENT_NOT_PENDING");
        var plan = await db.Plans.Include(p => p.Features).FirstAsync(p => p.Id == planId, ct);
        var old = await entitlements.GetEffectivePlanAsync(tid, ct);
        var quote = QuoteOf(plan, sub.PendingSeats ?? 1, sub.PendingBillingPeriod);
        var scheduled = activator.IsScheduledChange(sub, plan, clock.Now);
        await activator.ActivateAsync(sub, plan, req.SubscriptionId!, clock.Now, null, ct);
        // A change that starts at the next renewal has not charged anything yet (only the approval of the new amount): its invoice comes with its first charge.
        var invoice = scheduled ? null : await activator.RecordPaymentAsync(tid, plan, quote.ChargePerCycle, plan.Currency, req.PaymentId!, true, null, DescribePurchase(plan, quote), ct);
        recorder.Audit("subscription.changed", "Subscription", sub.Id, old.Plan.Code, plan.Code);
        recorder.Activity("subscription.changed", "Subscription", sub.Id, scheduled ? $"Seats changed to {quote.Seats}: the new amount starts at the next renewal" : $"Plan changed: {old.Plan.Name} → {plan.Name}");
        await db.SaveChangesAsync(ct);
        // The webhook may report the same payment first; whichever records it sends the one receipt.
        if (invoice is not null && mailer is not null) await mailer.PaymentReceivedAsync(invoice, plan.Name, sub.CurrentPeriodEnd, sub.ProviderSubscriptionId is not null, null, ct);
        return await GetOverviewAsync(ct);
    }

    public async Task<BillingOverviewDto> CancelAsync(CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.BillingManage, ct);
        var tid = ctx.RequireTenantId();
        var sub = await db.Subscriptions.Include(s => s.Plan).FirstAsync(s => s.TenantId == tid, ct);
        if (sub.Plan?.Code == EntitlementService.FreePlan || sub.Status is SubscriptionStatus.Cancelled or SubscriptionStatus.Expired)
            throw new ConflictException("There is no active paid subscription to cancel.", "NOTHING_TO_CANCEL");

        // A recurring payment at the provider stops at the end of the paid period; no further charge is made.
        if (sub.ProviderSubscriptionId is { } paying) await activator.CancelAtProviderAsync(paying, atCycleEnd: true, ct);
        // A change that was started (a payment window, or seats that start at the renewal) is dropped too, at the provider and here.
        if (sub.PendingProviderSubscriptionId is { } unfinished && unfinished != sub.ProviderSubscriptionId) await activator.CancelAtProviderAsync(unfinished, atCycleEnd: false, ct);
        sub.PendingPlanId = null; sub.PendingProviderSubscriptionId = null; sub.PendingSeats = null; sub.PendingBillingPeriod = null;
        // Access continues until the paid period ends, then the workspace falls back to the Free plan.
        sub.Status = SubscriptionStatus.Cancelled;
        sub.CancelAtPeriodEnd = true;
        sub.CancelledAt = clock.Now;
        sub.CurrentPeriodEnd ??= clock.Now.AddMonths(1);
        recorder.Audit("subscription.cancelled", "Subscription", sub.Id, newValue: new { sub.CurrentPeriodEnd });
        recorder.Activity("subscription.cancelled", "Subscription", sub.Id, $"Subscription cancelled — access continues until {sub.CurrentPeriodEnd:dd MMM yyyy}");
        await db.SaveChangesAsync(ct);
        if (mailer is not null) await mailer.CancelledAsync(tid, sub.Plan?.Name ?? "paid", sub.CurrentPeriodEnd!.Value, ct);
        return await GetOverviewAsync(ct);
    }

    public async Task<BillingOverviewDto> ResumeAsync(CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.BillingManage, ct);
        var tid = ctx.RequireTenantId();
        var sub = await db.Subscriptions.FirstAsync(s => s.TenantId == tid, ct);
        // A cancelled recurring payment cannot be switched back on at the provider: the owner subscribes again (it keeps the paid period meanwhile).
        if (sub.ProviderSubscriptionId is not null && sub.Status == SubscriptionStatus.Cancelled)
            throw new ConflictException("Choose a plan to subscribe again: the payment mandate was cancelled and needs your approval once more.", "CANNOT_RESUME");
        if (sub.Status != SubscriptionStatus.Cancelled || EntitlementService.IsLapsed(sub, clock.Now))
            throw new ConflictException("This subscription cannot be resumed. Choose a plan to subscribe again.", "CANNOT_RESUME");
        sub.Status = sub.TrialEnd is { } te && te > clock.Now ? SubscriptionStatus.Trial : SubscriptionStatus.Active;
        sub.CancelAtPeriodEnd = false;
        sub.CancelledAt = null;
        recorder.Audit("subscription.resumed", "Subscription", sub.Id);
        await db.SaveChangesAsync(ct);
        return await GetOverviewAsync(ct);
    }

    /// <summary>"INV-20261018-1A2B3C4D". Unique (an index enforces it); not a gap-free sequence.</summary>
    /// <summary>A reference for a payment attempt that failed: not a tax invoice, so it takes no number from the sequence.</summary>
    internal static string NewAttemptReference(DateTime now) => $"ATT-{now:yyyyMMdd}-{Guid.NewGuid().ToString("N")[..8].ToUpperInvariant()}";

    /// <summary>The Indian financial year (April to March, India time) a moment falls in, as "26-27".</summary>
    public static string FinancialYear(DateTime utc)
    {
        var local = ProjectManagement.Application.Features.Reminders.ZoneTime.ToLocal(utc, ProjectManagement.Application.Features.Reminders.ZoneTime.Find("Asia/Kolkata"));
        var start = local.Month >= 4 ? local.Year : local.Year - 1;
        return $"{start % 100:00}-{(start + 1) % 100:00}";
    }

    /// <summary>"INV/26-27/000042": unique within the financial year, sequential, and within GST's 16-character limit.</summary>
    public static string FormatInvoiceNumber(string financialYear, int n) => $"INV/{financialYear}/{n:000000}";

    /// <summary>
    /// Adds an invoice and saves (with whatever else is pending). A paid invoice is a tax invoice: it takes the next number of its financial
    /// year inside the same transaction as the insert - the sequence row stays locked until then - so a failed save, or a payment found to be
    /// recorded already (<paramref name="alreadyRecorded"/>), gives the number back and the sequence never has a gap. A failed charge is not a
    /// tax invoice and gets an attempt reference instead. Returns false when nothing was added because it was already recorded.
    /// </summary>
    internal static async Task<bool> SaveInvoiceAsync(IAppDbContext db, Invoice invoice, bool paid, Func<Task<bool>>? alreadyRecorded, CancellationToken ct)
    {
        if (!paid)
        {
            if (alreadyRecorded is not null && await alreadyRecorded()) return false;
            invoice.Number = NewAttemptReference(invoice.IssuedAt);
            db.Invoices.Add(invoice);
            await db.SaveChangesAsync(ct);
            return true;
        }
        const string Savepoint = "invoice_number";
        var outer = db.Database.CurrentTransaction;
        var own = outer is null ? await db.Database.BeginTransactionAsync(ct) : null;
        if (outer is not null) await outer.CreateSavepointAsync(Savepoint, ct);
        try
        {
            var year = FinancialYear(invoice.IssuedAt);
            invoice.Number = FormatInvoiceNumber(year, await db.NextInvoiceNumberAsync(year, ct));
            if (alreadyRecorded is not null && await alreadyRecorded())
            {
                if (own is not null) await own.RollbackAsync(ct); else await outer!.RollbackToSavepointAsync(Savepoint, ct);
                return false;
            }
            db.Invoices.Add(invoice);
            await db.SaveChangesAsync(ct);
            if (own is not null) await own.CommitAsync(ct); else await outer!.ReleaseSavepointAsync(Savepoint, ct);
            return true;
        }
        catch
        {
            db.Invoices.Entry(invoice).State = EntityState.Detached;
            if (own is not null) await own.RollbackAsync(CancellationToken.None); else await outer!.RollbackToSavepointAsync(Savepoint, CancellationToken.None);
            throw;
        }
        finally { if (own is not null) await own.DisposeAsync(); }
    }}

/// <summary>Background housekeeping: subscription lifecycle and stale-token cleanup (due-date reminders belong to the reminder engine).</summary>
public class MaintenanceService(ProjectManagement.Application.Features.Documents.DocumentSearchIndexer searchIndex, ProjectManagement.Application.Features.Documents.AuditChainService auditChain, ProjectManagement.Application.Features.Documents.KeyRotationService keyRotation, ProjectManagement.Application.Features.Documents.DocumentRetentionService documentRetention, ProjectManagement.Application.Features.Documents.DocumentWorkflowService documentWorkflows, IAppDbContext db, IPaymentProvider payments, IOptions<PricingOptions> pricing, AppClock clock, ILogger<MaintenanceService> log, NotificationRouter router, ProjectManagement.Application.Features.Resumes.PersonalFileCleanup personalFiles, AttachmentJanitor files, ProjectManagement.Application.Features.Reports.ReportExportService exports, ProjectManagement.Application.Features.Integrations.WebhookProcessor webhooks, ProjectManagement.Application.Features.Integrations.WhatsAppMetadataMaintenance whatsAppMetadata, BillingMailer? mailer = null)
{
    private const int PastDueGraceDays = 7;

    public async Task RunAllAsync(CancellationToken ct = default)
    {
        // Each step on its own: one that fails is logged and the others still run (a broken export purge must not stop renewals or key rotation).
        await StepAsync("certification expiry", () => SendCertificationExpiryAsync(ct), ct);
        await StepAsync("subscription lifecycle", () => RunSubscriptionLifecycleAsync(ct), ct);
        await StepAsync("cleanup", () => CleanupAsync(ct), ct);
        await StepAsync("personal files", () => personalFiles.PurgeAsync(ct), ct);
        await StepAsync("inbox summaries", () => PurgeInboxSummariesAsync(ct), ct);
        await StepAsync("email rewrites", () => PurgeEmailRewritesAsync(ct), ct);
        await StepAsync("WhatsApp metadata", () => whatsAppMetadata.RunAsync(ct), ct);
        await StepAsync("report exports", () => exports.PurgeExpiredAsync(ct: ct), ct);
        await StepAsync("webhooks", () => webhooks.PurgeAsync(ct), ct);
        await StepAsync("orphan files", () => files.PurgeOrphansAsync(TimeSpan.FromDays(7), ct: ct), ct); // files of projects / tasks deleted more than a week ago
        await StepAsync("data retention", () => ProjectManagement.Application.Features.Compliance.DataPolicyService.PurgeAllAsync(db, clock.Now, log, ct, auditChain), ct); // each workspace's own retention
        await StepAsync("key rotation", () => keyRotation.ContinueAllAsync(ct), ct);   // values still on an older data key after a rotation
        await StepAsync("audit chain", () => auditChain.VerifyRecentAsync(ct), ct);   // tamper check of audit trails that changed since the last one
        await StepAsync("document retention", () => documentRetention.PurgeAsync(ct), ct);   // deleted documents after 30 days; old document versions after the plan's history period
        await StepAsync("search index", () => searchIndex.SweepAsync(ct), ct);   // documents not yet in (or changed since) the search index
        await StepAsync("document reminders", () => documentWorkflows.SendRemindersAsync(ct), ct);   // Business: approvers of overdue review steps are reminded once
    }

    private async Task StepAsync(string name, Func<Task> work, CancellationToken ct)
    {
        try { await work(); }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            log.LogError(ex, "Maintenance step {Step} failed; continuing with the others", name);
            // Whatever the failed step left half-tracked must not be saved by the next one.
            db.Database.GetService<ICurrentDbContext>().Context.ChangeTracker.Clear();
        }
    }

    public async Task<int> PurgeInboxSummariesAsync(CancellationToken ct=default)
    {
        // Trusted expiry-only housekeeping: select IDs, never decrypted personal email content.
        var expiredSummaries=await db.PersonalInboxSummaries.IgnoreQueryFilters().Where(s=>s.ExpiresAt<=clock.Now)
            .OrderBy(s=>s.ExpiresAt).Select(s=>s.Id).Take(1000).ToArrayAsync(ct);
        return await db.PersonalInboxSummaries.IgnoreQueryFilters().Where(s=>expiredSummaries.Contains(s.Id)&&s.ExpiresAt<=clock.Now).ExecuteDeleteAsync(ct);
    }

    public async Task<int> PurgeEmailRewritesAsync(CancellationToken ct=default)
    {
        var ids=await db.PersonalEmailRewrites.IgnoreQueryFilters().Where(r=>r.ExpiresAt<=clock.Now)
            .OrderBy(r=>r.ExpiresAt).Select(r=>r.Id).Take(1000).ToArrayAsync(ct);
        return await db.PersonalEmailRewrites.IgnoreQueryFilters().Where(r=>ids.Contains(r.Id)&&r.ExpiresAt<=clock.Now).ExecuteDeleteAsync(ct);
    }

    public async Task<int> SendCertificationExpiryAsync(CancellationToken ct = default)
    {
        // Trusted maintenance boundary: select active owners, deliver only into their own personal workspace, never the employer's workspace.
        var today=clock.Today;
        var due=await db.EmployeeCertifications.IgnoreQueryFilters().Where(c=>!c.Archived&&c.ExpiryReminders&&c.ExpiresOn!=null&&c.ExpiresOn<=today.AddDays(30)
            && c.ExpiresOn>=today.AddDays(-7)&&(c.ReminderExpiry!=c.ExpiresOn||c.ReminderStage==null||c.ExpiresOn<=today&&c.ReminderStage>0||c.ExpiresOn<=today.AddDays(7)&&c.ReminderStage>7)&&db.Users.Any(u=>u.Id==c.UserId&&u.IsActive)).OrderBy(c=>c.ExpiresOn).Take(200).ToListAsync(ct);
        var sent=0;
        foreach(var c in due)
        {
            var days=c.ExpiresOn!.Value.DayNumber-today.DayNumber;var stage=days<=0?0:days<=7?7:30;
            if(c.ReminderExpiry==c.ExpiresOn&&c.ReminderStage is {} previous&&previous<=stage)continue;
            var tid=await db.Tenants.Where(t=>t.Type==WorkspaceType.Personal&&t.OwnerUserId==c.UserId).Select(t=>(Guid?)t.Id).FirstOrDefaultAsync(ct);if(tid==null)continue;
            var key=$"cert-expiry:{c.Id:N}:{c.ExpiresOn:yyyyMMdd}:{stage}";
            if(!await db.Notifications.IgnoreQueryFilters().AnyAsync(n=>n.TenantId==tid&&n.UserId==c.UserId&&n.DedupeKey==key,ct))
            {
                var n=new Notification{TenantId=tid.Value,UserId=c.UserId,Type=NotificationType.CertificationExpiry,Title=stage==0?"A certification has expired":"A certification expires soon",Body=$"{c.Name} expires on {c.ExpiresOn:yyyy-MM-dd}.",Link="/account/resumes",DedupeKey=key,CreatedAt=clock.Now};
                if(await router.ApplyAsync(n,ct)){db.Notifications.Add(n);sent++;}
            }
            c.ReminderExpiry=c.ExpiresOn;c.ReminderStage=stage;c.Version++;
        }
        await db.SaveChangesAsync(ct);return sent;
    }
    public async Task RunSubscriptionLifecycleAsync(CancellationToken ct = default)
    {
        var now = clock.Now;
        var ended = new List<(Guid Tenant, string Plan, bool Trial)>();
        var subs = await db.Subscriptions.Include(s => s.Plan).Where(s => s.Status != SubscriptionStatus.Expired
            && s.CurrentPeriodEnd != null && s.CurrentPeriodEnd <= now
            && db.Tenants.Any(t => t.Id == s.TenantId)) // soft-deleted tenants are filtered out: no renewals or charges
            .ToListAsync(ct);

        foreach (var sub in subs)
        {
          try
          {
            var before = sub.Status;
            if (sub.Status is SubscriptionStatus.Trial or SubscriptionStatus.Cancelled)
                sub.Status = SubscriptionStatus.Expired;
            else if (sub.Status == SubscriptionStatus.Active && sub.Provider == UpiBillingService.ProviderName && sub.ProviderSubscriptionId is null)
            {
                // Paid by UPI QR: nothing renews by itself. The owner is told to pay for the next period; it lapses after the grace period.
                sub.Status = sub.CancelAtPeriodEnd ? SubscriptionStatus.Expired : SubscriptionStatus.PastDue;
            }
            else if (sub.Status == SubscriptionStatus.Active && sub.ProviderSubscriptionId is not null)
            {
                // The provider charges each month and tells us by webhook. If the period ended and no news came for three days, treat it as a failed renewal.
                if (sub.CurrentPeriodEnd!.Value.AddDays(3) <= now) sub.Status = SubscriptionStatus.PastDue;
            }
            else if (sub.Status == SubscriptionStatus.Active && sub.Plan?.PriceMonthly is > 0 && !sub.CancelAtPeriodEnd && payments.RequiresCheckout)
            {
                // A real provider charges only through a subscription the owner approved; there is none here, so the server cannot renew it by itself.
                // It goes past due (the owner is told) and lapses after the grace period unless they choose the plan again.
                sub.Status = SubscriptionStatus.PastDue;
            }
            else if (sub.Status == SubscriptionStatus.Active && sub.Plan?.PriceMonthly is { } unit && !sub.CancelAtPeriodEnd)
            {
                var quote = Pricing.Quote(pricing.Value, sub.Plan.Code, unit, sub.Plan.Currency, sub.Plan.PerSeat, sub.Seats, sub.BillingPeriod);
                var charge = await payments.ChargeAsync(sub.TenantId, sub.Plan.Code, quote.ChargePerCycle, sub.Plan.Currency, ct);
                await BillingService.SaveInvoiceAsync(db, new Invoice
                {
                    TenantId = sub.TenantId, PlanCode = sub.Plan.Code, Amount = quote.ChargePerCycle,
                    Currency = sub.Plan.Currency, Status = charge.Success ? InvoiceStatus.Paid : InvoiceStatus.Failed,
                    Description = BillingService.DescribePurchase(sub.Plan, quote) + " — renewal", ProviderReference = charge.Reference, IssuedAt = now, CreatedAt = now,
                }, charge.Success, null, ct);
                if (charge.Success) { sub.CurrentPeriodStart = now; sub.CurrentPeriodEnd = now.AddMonths(quote.CycleMonths); }
                else sub.Status = SubscriptionStatus.PastDue;
            }
            else if (sub.Status == SubscriptionStatus.PastDue && sub.CurrentPeriodEnd!.Value.AddDays(PastDueGraceDays) <= now)
                sub.Status = SubscriptionStatus.Expired;

            if (before != sub.Status)
            {
                log.LogInformation("Subscription {Id} for tenant {Tenant}: {Before} -> {After}", sub.Id, sub.TenantId, before, sub.Status);
                var owner = await db.Tenants.Where(t => t.Id == sub.TenantId).Select(t => t.OwnerUserId).FirstOrDefaultAsync(ct);
                var note = new Notification
                {
                    TenantId = sub.TenantId, UserId = owner, Type = NotificationType.Subscription, CreatedAt = now, Link = "/settings/billing",
                    Title = sub.Status == SubscriptionStatus.PastDue ? (sub.Provider == UpiBillingService.ProviderName ? "Time to renew your plan" : "Payment failed — please update billing") : "Your subscription has ended",
                    Body = sub.Status == SubscriptionStatus.PastDue ? (sub.Provider == UpiBillingService.ProviderName ? "Your paid period has ended. Open Billing and pay by UPI to keep your plan." : "We could not renew your plan.") : "The workspace is now on the Free plan.",
                };
                var richMail = sub.Status == SubscriptionStatus.Expired && sub.Plan is { } endedPlan && endedPlan.Code != EntitlementService.FreePlan;
                if (richMail) ended.Add((sub.TenantId, sub.Plan!.Name, before == SubscriptionStatus.Trial));
                if (await router.ApplyAsync(note, ct)) { if (richMail) note.EmailPending = false; db.Notifications.Add(note); }
            }
          }
          catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
          {
              // One subscription that cannot be processed (a provider error, bad data) must not hold up every other renewal.
              log.LogError(ex, "Renewal of subscription {Id} for tenant {Tenant} failed; it is tried again on the next run", sub.Id, sub.TenantId);
          }
        }
        await db.SaveChangesAsync(ct);
        if (mailer is not null) foreach (var (tenant, plan, trial) in ended) await mailer.PlanEndedAsync(tenant, plan, trial, ct);
    }

    public async Task CleanupAsync(CancellationToken ct = default)
    {
        var now = clock.Now;
        var cutoff = now.AddDays(-30);
        db.RefreshTokens.RemoveRange(await db.RefreshTokens.Where(t => t.ExpiresAt < cutoff).Take(1000).ToListAsync(ct));
        db.UserSessions.RemoveRange(await db.UserSessions.Where(s => s.ExpiresAt < cutoff || (s.RevokedAt != null && s.RevokedAt < cutoff)).Take(1000).ToListAsync(ct));
        foreach (var i in await db.TenantInvitations.Where(i => i.Status == InvitationStatus.Pending && i.ExpiresAt < now).Take(500).ToListAsync(ct))
            i.Status = InvitationStatus.Expired;
        await db.SaveChangesAsync(ct);
    }
}
