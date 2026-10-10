using System.Linq.Expressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Common;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Infrastructure.Persistence;

public partial class AppDbContext
{
    private readonly HashSet<Guid> pendingTenantInvalidations = [];
    private readonly List<ChangeEvent> pendingChanges = [];
    private bool pendingPlanInvalidation;

    // ------------------------------------------------------------------ audit stamping & write guard

    public override int SaveChanges(bool acceptAllChangesOnSuccess)
    {
        Stamp();
        return base.SaveChanges(acceptAllChangesOnSuccess);
    }

    public override async Task<int> SaveChangesAsync(bool acceptAllChangesOnSuccess, CancellationToken cancellationToken = default)
    {
        Stamp();
        // Remember what changes a workspace's plan or entitlements *before* saving (the tracker is cleared afterwards).
        var tenants = new HashSet<Guid>(); var plansChanged = false;
        if (entitlementCache is { Enabled: true })
        {
            foreach (var e in ChangeTracker.Entries().Where(e => e.State is EntityState.Added or EntityState.Modified or EntityState.Deleted))
            {
                if (e.Entity is Subscription sub) tenants.Add(sub.TenantId);
                else if (e.Entity is TenantFeatureOverride o) tenants.Add(o.TenantId);
                else if (e.Entity is Plan or PlanFeature) plansChanged = true;
            }
        }
        // Activity written in this save is what other people's open screens need to hear about (sent only once it is committed).
        var changes = changeFeed is null ? null : ChangeTracker.Entries<Activity>().Where(e => e.State == EntityState.Added)
            .Select(e => new ChangeEvent(e.Entity.TenantId, e.Entity.EntityType, e.Entity.EntityId, e.Entity.ProjectId, e.Entity.Action, e.Entity.ActorId)).ToList();
        var saved = await SaveChainedAsync(acceptAllChangesOnSuccess, cancellationToken);
        if (Database.CurrentTransaction is not null)
        {
            pendingPlanInvalidation |= plansChanged;
            pendingTenantInvalidations.UnionWith(tenants);
            if (changes is not null) pendingChanges.AddRange(changes);
            return saved;
        }
        if (entitlementCache is not null)
        {
            if (plansChanged) entitlementCache.InvalidateAllPlans();
            foreach (var t in tenants) await entitlementCache.InvalidateTenantAsync(t, cancellationToken);
        }
        if (changes is { Count: > 0 }) changeFeed!.Publish(changes);
        return saved;
    }

    internal async Task PublishCommittedEffectsAsync(CancellationToken ct)
    {
        var tenants = pendingTenantInvalidations.ToArray();
        var plansChanged = pendingPlanInvalidation;
        var changes = pendingChanges.ToArray();
        DiscardTransactionEffects();
        if (entitlementCache is not null)
        {
            if (plansChanged) entitlementCache.InvalidateAllPlans();
            foreach (var tenant in tenants) await entitlementCache.InvalidateTenantAsync(tenant, ct);
        }
        if (changes.Length > 0) changeFeed?.Publish(changes);
    }

    internal void DiscardTransactionEffects()
    {
        pendingTenantInvalidations.Clear();
        pendingChanges.Clear();
        pendingPlanInvalidation = false;
    }

    /// <summary>
    /// Saves each new audit row with its chain position and hashes. PostgreSQL holds a workspace transaction lock through commit;
    /// other providers retain optimistic conflict retries.
    /// </summary>
    private async Task<int> SaveChainedAsync(bool acceptAllChangesOnSuccess, CancellationToken ct)
    {
        var tenants = ChangeTracker.Entries<AuditLog>()
            .Where(e => e.State == EntityState.Added && e.Entity.TenantId != null)
            .Select(e => e.Entity.TenantId!.Value).Distinct().Order().ToArray();
        if (tenants.Length > 0 && Database.ProviderName?.Contains("Npgsql", StringComparison.OrdinalIgnoreCase) == true)
        {
            // Hold each workspace's chain lock until the rows commit, including when a caller owns the transaction.
            // PostgreSQL coordinates these locks across API replicas; sorting avoids opposite lock order for multi-workspace saves.
            await using var transaction = Database.CurrentTransaction is null ? await Database.BeginTransactionAsync(ct) : null;
            foreach (var tenant in tenants)
            {
                var key = "project-tracker:audit:" + tenant;
                await Database.ExecuteSqlInterpolatedAsync($"SELECT pg_advisory_xact_lock(hashtextextended({key}, 0))", ct);
            }
            await ChainAuditAsync(ct);
            var saved = await base.SaveChangesAsync(acceptAllChangesOnSuccess, ct);
            if (transaction is not null) await transaction.CommitAsync(ct);
            return saved;
        }
        for (var attempt = 1; ; attempt++)
        {
            var chained = await ChainAuditAsync(ct);
            try { return await base.SaveChangesAsync(acceptAllChangesOnSuccess, ct); }
            catch (DbUpdateException e) when (chained && attempt < 6 && IsChainConflict(e))
            {
                await Task.Delay(Random.Shared.Next(5, 40) * attempt, ct);
            }
        }
    }

    public async Task AllowAuditPurgeAsync(CancellationToken ct)
    {
        if (Database.ProviderName?.Contains("Npgsql", StringComparison.OrdinalIgnoreCase) == true)
            await Database.ExecuteSqlRawAsync("SELECT set_config('app.audit_purge', 'on', true)", ct);
    }

    private static bool IsChainConflict(DbUpdateException e)
    {
        for (Exception? x = e; x is not null; x = x.InnerException)
            if (x.Message.Contains("AuditLogs", StringComparison.OrdinalIgnoreCase) && (x.Message.Contains("Seq", StringComparison.OrdinalIgnoreCase) || x.Message.Contains("23505"))) return true;
        return false;
    }

    private async Task<bool> ChainAuditAsync(CancellationToken ct)
    {
        var added = ChangeTracker.Entries<AuditLog>().Where(e => e.State == EntityState.Added && e.Entity.TenantId != null).Select(e => e.Entity).ToList();
        if (added.Count == 0) return false;
        foreach (var group in added.GroupBy(a => a.TenantId!.Value))
        {
            var last = await AuditLogs.IgnoreQueryFilters().Where(a => a.TenantId == group.Key && a.Seq != null).OrderByDescending(a => a.Seq).Select(a => new { a.Seq, a.Hash }).FirstOrDefaultAsync(ct);
            var seq = last?.Seq ?? 0; var prev = last?.Hash ?? AuditChain.Genesis;
            if (last is null)
            {
                // After old rows were purged the chain continues from the recorded anchor.
                var anchor = await TenantSecuritySettings.IgnoreQueryFilters().Where(t => t.TenantId == group.Key).Select(t => new { t.ChainAnchorSeq, t.ChainAnchorHash }).FirstOrDefaultAsync(ct);
                if (anchor?.ChainAnchorSeq is { } aseq) { seq = aseq; prev = anchor.ChainAnchorHash ?? AuditChain.Genesis; }
            }
            foreach (var a in group.OrderBy(a => a.CreatedAt == default ? DateTime.MaxValue : a.CreatedAt))
            {
                if (a.CreatedAt == default) a.CreatedAt = clock.GetUtcNow().UtcDateTime;
                a.CreatedAt = AuditChain.Normalize(a.CreatedAt);
                a.Seq = ++seq; a.PrevHash = prev; a.Hash = prev = AuditChain.Compute(a, prev);
            }
        }
        return true;
    }

    private void Stamp()
    {
        var now = clock.GetUtcNow().UtcDateTime;
        var userId = current.UserId;
        var tenantId = current.TenantId;

        foreach (var entry in ChangeTracker.Entries())
        {
            if (entry.Entity is AuditableEntity audit)
            {
                if (entry.State == EntityState.Added)
                {
                    if (audit.CreatedAt == default) audit.CreatedAt = now;
                    audit.CreatedBy ??= userId;
                }
                else if (entry.State == EntityState.Modified)
                {
                    audit.UpdatedAt = now;
                    audit.UpdatedBy = userId;
                }
            }

            if (entry.Entity is ITenantScoped scoped && entry.State is EntityState.Added or EntityState.Modified or EntityState.Deleted)
            {
                if (scoped.TenantId == Guid.Empty)
                    scoped.TenantId = tenantId ?? throw new InvalidOperationException(
                        $"{entry.Entity.GetType().Name} is tenant-owned but no tenant is in context.");
                // Requests can never write into a tenant other than the one resolved for them.
                if (tenantId is not null && scoped.TenantId != tenantId)
                    throw new InvalidOperationException($"Blocked cross-tenant write to {entry.Entity.GetType().Name}.");
            }
        }
    }
}
