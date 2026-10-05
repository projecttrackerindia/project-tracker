using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Services;

public record EffectivePlan(
    Plan Plan, SubscriptionStatus Status, DateTime? TrialEnd, DateTime? PeriodEnd, bool CancelAtPeriodEnd, bool Downgraded);

/// <summary>Central subscription entitlement and usage-limit enforcement (spec sections 34, 35, 93).</summary>
public class EntitlementService(IAppDbContext db, ICurrentContext ctx, AppClock clock, EntitlementCache shared)
{
    public const string FreePlan = "FREE";
    private readonly Dictionary<Guid, EffectivePlan> _cache = new();
    private readonly Dictionary<Guid, Dictionary<string, long>> _overrides = new();
    private readonly Dictionary<Guid, IReadOnlyDictionary<string, long>> _entitlements = new();
    private readonly Dictionary<Guid, long> _seenEpoch = new();

    /// <summary>Drops this request's own copies when the workspace's plan was invalidated since they were read.</summary>
    private void ForgetIfStale(Guid tenantId)
    {
        var now = shared.Epoch(tenantId);
        if (_seenEpoch.TryGetValue(tenantId, out var seen) && seen != now) { _cache.Remove(tenantId); _entitlements.Remove(tenantId); _overrides.Remove(tenantId); }
        _seenEpoch[tenantId] = now;
    }

    /// <summary>Expired / lapsed subscriptions fall back to FREE entitlements so limits cannot be bypassed.</summary>
    public static bool IsLapsed(Subscription sub, DateTime now) =>
        sub.Status == SubscriptionStatus.Expired
        || (sub.Status == SubscriptionStatus.Trial && sub.TrialEnd is { } te && te <= now)
        || (sub.Status == SubscriptionStatus.Cancelled && (sub.CurrentPeriodEnd is not { } pe || pe <= now));

    public async Task<EffectivePlan> GetEffectivePlanAsync(Guid tenantId, CancellationToken ct = default)
    {
        ForgetIfStale(tenantId);
        if (_cache.TryGetValue(tenantId, out var cached)) return cached;
        if (await shared.GetPlanAsync(tenantId, ct) is { } remembered) return _cache[tenantId] = remembered;

        var sub = await db.Subscriptions.AsNoTracking()
            .Include(s => s.Plan).ThenInclude(p => p!.Features)
            .FirstOrDefaultAsync(s => s.TenantId == tenantId, ct);

        EffectivePlan result;
        if (sub?.Plan is null || IsLapsed(sub, clock.Now))
        {
            var free = await db.Plans.AsNoTracking().Include(p => p.Features).FirstAsync(p => p.Code == FreePlan, ct);
            var status = sub?.Status ?? SubscriptionStatus.Active;
            result = new EffectivePlan(free, status, sub?.TrialEnd, sub?.CurrentPeriodEnd, sub?.CancelAtPeriodEnd ?? false,
                Downgraded: sub is not null && sub.Plan?.Code != FreePlan);
        }
        else
        {
            result = new EffectivePlan(sub.Plan, sub.Status, sub.TrialEnd, sub.CurrentPeriodEnd, sub.CancelAtPeriodEnd, false);
        }
        await shared.SetPlanAsync(tenantId, result, ct);
        return _cache[tenantId] = result;
    }

    public async Task<IReadOnlyDictionary<string, long>> GetEntitlementsAsync(Guid tenantId, CancellationToken ct = default)
    {
        ForgetIfStale(tenantId);
        if (_entitlements.TryGetValue(tenantId, out var known)) return known;
        if (await shared.GetEntitlementsAsync(tenantId, ct) is { } remembered) return _entitlements[tenantId] = remembered;

        var plan = await GetEffectivePlanAsync(tenantId, ct);
        var values = FeatureKeys.All.ToDictionary(k => k, k => plan.Plan.Features.FirstOrDefault(f => f.FeatureKey == k)?.Value ?? 0);
        DateTime? endsAt = null;
        // A platform administrator can give (or take away) one feature for one organization, for a while or for good.
        if (!_overrides.TryGetValue(tenantId, out var special))
        {
            var now = clock.Now;
            var rows = await db.TenantFeatureOverrides.AsNoTracking().Where(o => o.TenantId == tenantId && (o.ExpiresAt == null || o.ExpiresAt > now)).ToListAsync(ct);
            _overrides[tenantId] = special = rows.ToDictionary(o => o.FeatureKey, o => o.Value);
            endsAt = rows.Where(o => o.ExpiresAt != null).Select(o => o.ExpiresAt).Min();
        }
        foreach (var (key, value) in special) if (values.ContainsKey(key)) values[key] = value;
        await shared.SetEntitlementsAsync(tenantId, values, endsAt, ct);
        return _entitlements[tenantId] = values;
    }

    public async Task<long> GetValueAsync(string key, CancellationToken ct = default) =>
        (await GetEntitlementsAsync(ctx.RequireTenantId(), ct)).GetValueOrDefault(key);

    public async Task EnsureFeatureAsync(string key, CancellationToken ct = default)
    {
        if (await GetValueAsync(key, ct) == 0) throw new FeatureNotAvailableException(key);
    }

    /// <summary>Throws when adding <paramref name="adding"/> more items would exceed the plan limit.</summary>
    public async Task EnsureWithinLimitAsync(string key, int currentCount, int adding = 1, CancellationToken ct = default)
    {
        var limit = await GetValueAsync(key, ct);
        if (limit != FeatureKeys.Unlimited && currentCount + adding > limit) throw new PlanLimitException(key, limit);
    }

    /// <summary>Bytes used by files of projects that still exist (files of deleted projects no longer count).</summary>
    public async Task<long> StorageUsedBytesAsync(CancellationToken ct = default) =>
        (await db.Attachments.Where(a => db.Projects.Any(p => p.Id == a.ProjectId)).SumAsync(a => (long?)a.SizeBytes, ct) ?? 0)
        + (await db.WorkTaskAttachments.Where(a => db.WorkTasks.Any(t => t.Id == a.WorkTaskId)).SumAsync(a => (long?)a.SizeBytes, ct) ?? 0)
        // Files sent in chat and shown to the AI assistant live in the same storage and count against the same plan limit.
        + (await db.ChatAttachments.SumAsync(a => (long?)a.SizeBytes, ct) ?? 0)
        + (await db.AiAttachments.SumAsync(a => (long?)a.SizeBytes, ct) ?? 0);

    public record UsageItem(string Key, string Label, long Used, long Limit);

    public async Task<IReadOnlyList<UsageItem>> GetUsageAsync(CancellationToken ct = default)
    {
        var ent = await GetEntitlementsAsync(ctx.RequireTenantId(), ct);
        var projects = await db.Projects.CountAsync(p => p.Status != ProjectStatus.Archived, ct);
        var tasks = await db.Tasks.CountAsync(ct);
        var members = await db.TenantMembers.CountAsync(m => m.TenantId == ctx.TenantId, ct)
            + await db.TenantInvitations.CountAsync(i => i.TenantId == ctx.TenantId && i.Status == InvitationStatus.Pending && i.ExpiresAt > clock.Now, ct);
        var teams = await db.Teams.CountAsync(ct);
        var storageMb = (await StorageUsedBytesAsync(ct) + 1024 * 1024 - 1) / (1024 * 1024);
        return
        [
            new(FeatureKeys.ProjectLimit, "Projects", projects, ent[FeatureKeys.ProjectLimit]),
            new(FeatureKeys.TaskLimit, "Tasks", tasks, ent[FeatureKeys.TaskLimit]),
            new(FeatureKeys.MaxMembers, "Members", members, ent[FeatureKeys.MaxMembers]),
            new(FeatureKeys.MaxTeams, "Teams", teams, ent[FeatureKeys.MaxTeams]),
            new(FeatureKeys.StorageLimitMb, "Storage (MB)", storageMb, ent[FeatureKeys.StorageLimitMb]),
        ];
    }
}
