using System.Linq.Expressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Integrations;

/// <summary>Trusted metadata housekeeping, including disconnected installations. Never reads message content or calls providers.</summary>
public class WhatsAppMetadataMaintenance(IServiceScopeFactory scopes, TimeProvider time)
{
    private static readonly string[] TerminalStates = ["accepted", "sent", "delivered", "read", "failed", "unknown", "rejected", "suppressed"];
    private const int BatchSize = 100;

    private static Expression<Func<WhatsAppDelivery,bool>> Expired(DateTime cutoff) => x =>
        TerminalStates.Contains(x.State) && x.CreatedAt < cutoff
        && (x.UpdatedAt == null || x.UpdatedAt < cutoff)
        && (x.AttemptedAt == null || x.AttemptedAt < cutoff)
        && (x.AcceptedAt == null || x.AcceptedAt < cutoff)
        && (x.ProviderStatusAt == null || x.ProviderStatusAt < cutoff);

    public async Task<int> RunAsync(CancellationToken ct = default)
    {
        var now = time.GetUtcNow().UtcDateTime; var cutoff = now.AddDays(-30); List<Guid> tenants;
        using (var scan = scopes.CreateScope())
        {
            var db = scan.ServiceProvider.GetRequiredService<IAppDbContext>();
            // Global reads select tenant IDs only, using operational timestamps/states. Tokens and recipient/content data are not retrieved.
            tenants = await db.WhatsAppConnections.IgnoreQueryFilters().AsNoTracking().Where(c =>
                db.WhatsAppInboundReceipts.IgnoreQueryFilters().Any(r => r.TenantId == c.TenantId && r.ReceivedAt < cutoff)
                || db.WhatsAppDeliveries.IgnoreQueryFilters().Where(Expired(cutoff)).Any(d => d.TenantId == c.TenantId)
                || db.WhatsAppDeliveries.IgnoreQueryFilters().Any(d => d.TenantId == c.TenantId &&
                    (d.State == "queued" && d.ExpiresAt <= now
                    || d.State == "preparing" && d.LeaseUntil <= now && d.AttemptedAt == null
                    || d.State == "sending" && d.LeaseUntil <= now)))
                .OrderBy(c => c.RetentionPolledAt != null).ThenBy(c => c.RetentionPolledAt).ThenBy(c => c.TenantId)
                .Select(c => c.TenantId).Take(10).ToListAsync(ct);
        }
        var affected = 0;
        foreach (var tenant in tenants)
        {
            ct.ThrowIfCancellationRequested();
            using var scope = scopes.CreateScope(); var sp = scope.ServiceProvider;
            sp.GetRequiredService<CurrentContext>().TenantId = tenant;
            var db = sp.GetRequiredService<IAppDbContext>();
            await using var tx = await db.Database.BeginTransactionAsync(ct);
            await db.LockTenantLedgerAsync(tenant, ct);
            await db.WhatsAppConnections.Where(c => c.TenantId == tenant)
                .ExecuteUpdateAsync(s => s.SetProperty(c => c.RetentionPolledAt, now), ct);
            affected += await MaintainTenantAsync(db, tenant, now, ct);
            await tx.CommitAsync(ct);
        }
        return affected;
    }

    /// <summary>Caller must establish tenant scope and hold its ledger lock in the current transaction. At most 100 rows per operation.</summary>
    public static async Task<int> MaintainTenantAsync(IAppDbContext db, Guid tenant, DateTime now, CancellationToken ct = default)
    {
        if (tenant == Guid.Empty || db.Database.CurrentTransaction == null)
            throw new InvalidOperationException("Tenant metadata maintenance requires a tenant transaction.");
        var deliveries = db.WhatsAppDeliveries.Where(x => x.TenantId == tenant);
        var affected = await deliveries.Where(x => x.State == "preparing" && x.LeaseUntil <= now && x.AttemptedAt == null)
            .OrderBy(x => x.LeaseUntil).ThenBy(x => x.Id).Take(BatchSize)
            .ExecuteUpdateAsync(s => s.SetProperty(x => x.State, "queued").SetProperty(x => x.AvailableAt, now)
                .SetProperty(x => x.UpdatedAt, now).SetProperty(x => x.LeaseId, (Guid?)null).SetProperty(x => x.LeaseUntil, (DateTime?)null), ct);
        // A persisted outbound attempt remains non-replayable, even if the delivery deployment gate is off.
        affected += await deliveries.Where(x => x.State == "sending" && x.LeaseUntil <= now)
            .OrderBy(x => x.LeaseUntil).ThenBy(x => x.Id).Take(BatchSize)
            .ExecuteUpdateAsync(s => s.SetProperty(x => x.State, "unknown").SetProperty(x => x.Reason, "PROVIDER_OUTCOME_UNKNOWN")
                .SetProperty(x => x.UpdatedAt, now).SetProperty(x => x.LeaseUntil, (DateTime?)null), ct);
        affected += await deliveries.Where(x => x.State == "queued" && x.ExpiresAt <= now)
            .OrderBy(x => x.ExpiresAt).ThenBy(x => x.Id).Take(BatchSize)
            .ExecuteUpdateAsync(s => s.SetProperty(x => x.State, "suppressed").SetProperty(x => x.Reason, "NOTIFICATION_EXPIRED")
                .SetProperty(x => x.UpdatedAt, now).SetProperty(x => x.LeaseId, (Guid?)null).SetProperty(x => x.LeaseUntil, (DateTime?)null), ct);
        // Keep recent attempts, acknowledgements, status callbacks and state decisions for a full reconciliation window.
        affected += await deliveries.Where(Expired(now.AddDays(-30))).OrderBy(x => x.CreatedAt).ThenBy(x => x.Id)
            .Take(BatchSize).ExecuteDeleteAsync(ct);
        affected += await db.WhatsAppInboundReceipts.Where(x => x.TenantId == tenant && x.ReceivedAt < now.AddDays(-30))
            .OrderBy(x => x.ReceivedAt).ThenBy(x => x.Id).Take(BatchSize).ExecuteDeleteAsync(ct);
        return affected;
    }
}
