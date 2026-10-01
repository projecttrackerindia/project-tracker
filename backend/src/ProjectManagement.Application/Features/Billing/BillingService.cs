using Microsoft.EntityFrameworkCore;
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

public record PlanDto(Guid Id, string Code, string Name, string? Description, decimal? PriceMonthly, string Currency,
    IReadOnlyDictionary<string, long> Features, bool IsCurrent, int SortOrder);
public record UsageDto(string Key, string Label, long Used, long Limit);
public record InvoiceDto(Guid Id, string Number, string PlanCode, decimal Amount, string Currency, InvoiceStatus Status, string Description, DateTime IssuedAt);
public record BillingOverviewDto(PlanSummaryDto Plan, IReadOnlyList<UsageDto> Usage, IReadOnlyList<InvoiceDto> Invoices, bool TrialAvailable,
    IReadOnlyList<PlanDto> Plans, bool CanManage);
public record CheckoutRequest(string PlanCode, bool StartTrial);

public class BillingService(
    IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, PermissionService permissions,
    EntitlementService entitlements, IPaymentProvider payments, IOptions<AppOptions> options)
{
    private readonly AppOptions _opt = options.Value;

    public async Task<BillingOverviewDto> GetOverviewAsync(CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        var plan = await entitlements.GetEffectivePlanAsync(tid, ct);
        var tenant = await db.Tenants.AsNoTracking().FirstAsync(t => t.Id == tid, ct);
        var canManage = await permissions.HasAsync(Permissions.BillingManage, ct);

        var invoices = canManage
            ? (await db.Invoices.AsNoTracking().OrderByDescending(i => i.IssuedAt).Take(24).ToListAsync(ct))
                .Select(i => new InvoiceDto(i.Id, i.Number, i.PlanCode, i.Amount, i.Currency, i.Status, i.Description, i.IssuedAt)).ToList()
            : [];
        var usage = (await entitlements.GetUsageAsync(ct)).Select(u => new UsageDto(u.Key, u.Label, u.Used, u.Limit)).ToList();

        return new BillingOverviewDto(
            new PlanSummaryDto(plan.Plan.Code, plan.Plan.Name, plan.Status, plan.TrialEnd, plan.PeriodEnd, plan.CancelAtPeriodEnd, plan.Downgraded),
            usage, invoices, !tenant.TrialUsed, await GetPlansAsync(plan.Plan.Code, ct), canManage);
    }

    public async Task<IReadOnlyList<PlanDto>> GetPlansAsync(string? currentCode, CancellationToken ct = default)
    {
        var plans = await db.Plans.AsNoTracking().Include(p => p.Features).Where(p => p.IsActive).OrderBy(p => p.SortOrder).ToListAsync(ct);
        return plans.Select(p => new PlanDto(p.Id, p.Code, p.Name, p.Description, p.PriceMonthly, p.Currency,
            FeatureKeys.All.ToDictionary(k => k, k => p.Features.FirstOrDefault(f => f.FeatureKey == k)?.Value ?? 0),
            p.Code == currentCode, p.SortOrder)).ToList();
    }

    public async Task<BillingOverviewDto> CheckoutAsync(CheckoutRequest req, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.BillingManage, ct);
        var tid = ctx.RequireTenantId();
        var plan = await db.Plans.FirstOrDefaultAsync(p => p.Code == req.PlanCode.ToUpper() && p.IsActive, ct)
            ?? throw new NotFoundException("Plan not found.");
        var sub = await db.Subscriptions.FirstAsync(s => s.TenantId == tid, ct);
        var tenant = await db.Tenants.FirstAsync(t => t.Id == tid, ct);
        var now = clock.Now;
        var old = await entitlements.GetEffectivePlanAsync(tid, ct);

        if (plan.Code == EntitlementService.FreePlan)
        {
            sub.PlanId = plan.Id; sub.Status = SubscriptionStatus.Active; sub.CurrentPeriodStart = now; sub.CurrentPeriodEnd = null;
            sub.TrialEnd = null; sub.CancelAtPeriodEnd = false; sub.CancelledAt = null;
        }
        else if (plan.PriceMonthly is not { } price)
        {
            throw new ValidationException("planCode", "This plan has custom pricing. Contact sales to get started.");
        }
        else if (req.StartTrial && !tenant.TrialUsed)
        {
            sub.PlanId = plan.Id; sub.Status = SubscriptionStatus.Trial; sub.CurrentPeriodStart = now;
            sub.TrialEnd = now.AddDays(_opt.TrialDays); sub.CurrentPeriodEnd = sub.TrialEnd; sub.CancelAtPeriodEnd = false; sub.CancelledAt = null;
            tenant.TrialUsed = true;
        }
        else
        {
            var charge = await payments.ChargeAsync(tid, plan.Code, price, plan.Currency, ct);
            db.Invoices.Add(new Invoice
            {
                TenantId = tid, Number = NewInvoiceNumber(now), PlanCode = plan.Code, Amount = price, Currency = plan.Currency,
                Status = charge.Success ? InvoiceStatus.Paid : InvoiceStatus.Failed, ProviderReference = charge.Reference,
                Description = $"{plan.Name} plan — monthly subscription", IssuedAt = now, CreatedAt = now,
            });
            if (!charge.Success)
            {
                recorder.Audit("billing.payment_failed", "Subscription", sub.Id, newValue: new { plan.Code, charge.Error });
                await db.SaveChangesAsync(ct);
                throw new AppException(402, "PAYMENT_FAILED", charge.Error ?? "The payment could not be processed.");
            }
            sub.PlanId = plan.Id; sub.Status = SubscriptionStatus.Active; sub.CurrentPeriodStart = now;
            sub.CurrentPeriodEnd = now.AddMonths(1); sub.TrialEnd = null; sub.CancelAtPeriodEnd = false; sub.CancelledAt = null;
        }

        recorder.Audit("subscription.changed", "Subscription", sub.Id, old.Plan.Code, plan.Code);
        recorder.Activity("subscription.changed", "Subscription", sub.Id, $"Plan changed: {old.Plan.Name} → {plan.Name}");
        await db.SaveChangesAsync(ct);
        return await GetOverviewAsync(ct);
    }

    public async Task<BillingOverviewDto> CancelAsync(CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.BillingManage, ct);
        var tid = ctx.RequireTenantId();
        var sub = await db.Subscriptions.Include(s => s.Plan).FirstAsync(s => s.TenantId == tid, ct);
        if (sub.Plan?.Code == EntitlementService.FreePlan || sub.Status is SubscriptionStatus.Cancelled or SubscriptionStatus.Expired)
            throw new ConflictException("There is no active paid subscription to cancel.", "NOTHING_TO_CANCEL");

        // Access continues until the paid period ends, then the workspace falls back to the Free plan.
        sub.Status = SubscriptionStatus.Cancelled;
        sub.CancelAtPeriodEnd = true;
        sub.CancelledAt = clock.Now;
        sub.CurrentPeriodEnd ??= clock.Now.AddMonths(1);
        recorder.Audit("subscription.cancelled", "Subscription", sub.Id, newValue: new { sub.CurrentPeriodEnd });
        recorder.Activity("subscription.cancelled", "Subscription", sub.Id, $"Subscription cancelled — access continues until {sub.CurrentPeriodEnd:dd MMM yyyy}");
        await db.SaveChangesAsync(ct);
        return await GetOverviewAsync(ct);
    }

    public async Task<BillingOverviewDto> ResumeAsync(CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.BillingManage, ct);
        var tid = ctx.RequireTenantId();
        var sub = await db.Subscriptions.FirstAsync(s => s.TenantId == tid, ct);
        if (sub.Status != SubscriptionStatus.Cancelled || EntitlementService.IsLapsed(sub, clock.Now))
            throw new ConflictException("This subscription cannot be resumed. Choose a plan to subscribe again.", "CANNOT_RESUME");
        sub.Status = sub.TrialEnd is { } te && te > clock.Now ? SubscriptionStatus.Trial : SubscriptionStatus.Active;
        sub.CancelAtPeriodEnd = false;
        sub.CancelledAt = null;
        recorder.Audit("subscription.resumed", "Subscription", sub.Id);
        await db.SaveChangesAsync(ct);
        return await GetOverviewAsync(ct);
    }

    internal static string NewInvoiceNumber(DateTime now) => $"INV-{now:yyyyMMdd}-{Guid.NewGuid().ToString("N")[..5].ToUpperInvariant()}";
}

/// <summary>Background housekeeping: subscription lifecycle, due-date reminders and stale-token cleanup.</summary>
public class MaintenanceService(IAppDbContext db, IPaymentProvider payments, AppClock clock, ILogger<MaintenanceService> log, NotificationRouter router, AttachmentJanitor files, ProjectManagement.Application.Features.Reports.ReportExportService exports, ProjectManagement.Application.Features.Integrations.WebhookProcessor webhooks)
{
    private const int PastDueGraceDays = 7;

    public async Task RunAllAsync(CancellationToken ct = default)
    {
        await RunSubscriptionLifecycleAsync(ct);
        await RunDueDateRemindersAsync(ct);
        await CleanupAsync(ct);
        await exports.PurgeExpiredAsync(ct: ct);
        await webhooks.PurgeAsync(ct);
        await files.PurgeOrphansAsync(TimeSpan.FromDays(7), ct: ct); // files of projects / tasks deleted more than a week ago
        await ProjectManagement.Application.Features.Compliance.DataPolicyService.PurgeAllAsync(db, clock.Now, log, ct); // each workspace's own retention
    }

    public async Task RunSubscriptionLifecycleAsync(CancellationToken ct = default)
    {
        var now = clock.Now;
        var subs = await db.Subscriptions.Include(s => s.Plan).Where(s => s.Status != SubscriptionStatus.Expired
            && s.CurrentPeriodEnd != null && s.CurrentPeriodEnd <= now
            && db.Tenants.Any(t => t.Id == s.TenantId)) // soft-deleted tenants are filtered out: no renewals or charges
            .ToListAsync(ct);

        foreach (var sub in subs)
        {
            var before = sub.Status;
            if (sub.Status is SubscriptionStatus.Trial or SubscriptionStatus.Cancelled)
                sub.Status = SubscriptionStatus.Expired;
            else if (sub.Status == SubscriptionStatus.Active && sub.Plan?.PriceMonthly is { } price && !sub.CancelAtPeriodEnd)
            {
                var charge = await payments.ChargeAsync(sub.TenantId, sub.Plan.Code, price, sub.Plan.Currency, ct);
                db.Invoices.Add(new Invoice
                {
                    TenantId = sub.TenantId, Number = BillingService.NewInvoiceNumber(now), PlanCode = sub.Plan.Code, Amount = price,
                    Currency = sub.Plan.Currency, Status = charge.Success ? InvoiceStatus.Paid : InvoiceStatus.Failed,
                    Description = $"{sub.Plan.Name} plan — renewal", ProviderReference = charge.Reference, IssuedAt = now, CreatedAt = now,
                });
                if (charge.Success) { sub.CurrentPeriodStart = now; sub.CurrentPeriodEnd = now.AddMonths(1); }
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
                    Title = sub.Status == SubscriptionStatus.PastDue ? "Payment failed — please update billing" : "Your subscription has ended",
                    Body = sub.Status == SubscriptionStatus.PastDue ? "We could not renew your plan." : "The workspace is now on the Free plan.",
                };
                if (await router.ApplyAsync(note, ct)) db.Notifications.Add(note);
            }
        }
        await db.SaveChangesAsync(ct);
    }

    public async Task RunDueDateRemindersAsync(CancellationToken ct = default)
    {
        var today = clock.Today;
        var tomorrow = today.AddDays(1);
        var now = clock.Now;

        var due = await db.Tasks.IgnoreQueryFilters().AsNoTracking()
            .Where(t => !t.IsDeleted && t.AssigneeId != null && t.DueDate != null && t.DueDate <= tomorrow
                        && db.Tenants.IgnoreQueryFilters().Any(x => x.Id == t.TenantId && !x.IsDeleted)
                        && t.Status!.Category != StatusCategory.Done && t.Status.Category != StatusCategory.Cancelled)
            .OrderBy(t => t.DueDate).Take(2000)
            .Select(t => new { t.Id, t.TenantId, t.ProjectId, Assignee = t.AssigneeId!.Value, t.Title, Due = t.DueDate!.Value, Key = t.Project!.Key, t.Number })
            .ToListAsync(ct);
        if (due.Count == 0) return;

        string KeyFor(Guid id, DateOnly d) => d < today ? $"overdue:{id}" : $"due:{id}:{d:yyyyMMdd}";
        var keys = due.Select(t => KeyFor(t.Id, t.Due)).ToList();
        var existing = (await db.Notifications.IgnoreQueryFilters().Where(n => n.DedupeKey != null && keys.Contains(n.DedupeKey))
            .Select(n => n.DedupeKey!).ToListAsync(ct)).ToHashSet();

        await router.PreloadAsync(due.Select(t => t.Assignee), ct);
        foreach (var t in due)
        {
            var key = KeyFor(t.Id, t.Due);
            if (!existing.Add(key)) continue;
            var overdue = t.Due < today;
            var note = new Notification
            {
                TenantId = t.TenantId, UserId = t.Assignee, DedupeKey = key, CreatedAt = now, Body = t.Title,
                Type = overdue ? NotificationType.Overdue : NotificationType.DueSoon, Link = $"/projects/{t.ProjectId}?task={t.Id}",
                Title = overdue ? $"{t.Key}-{t.Number} is overdue" : t.Due == today ? $"{t.Key}-{t.Number} is due today" : $"{t.Key}-{t.Number} is due tomorrow",
            };
            if (await router.ApplyAsync(note, ct)) db.Notifications.Add(note);
        }
        await db.SaveChangesAsync(ct);
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
