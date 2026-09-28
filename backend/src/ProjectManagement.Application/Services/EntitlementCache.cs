using System.Text.Json;
using Microsoft.Extensions.Caching.Distributed;
using Microsoft.Extensions.Options;

namespace ProjectManagement.Application.Services;

public class CacheOptions
{
    public const string Section = "Cache";
    /// <summary>How long a workspace's plan and entitlements are remembered between requests (0 switches the cache off).</summary>
    public int EntitlementSeconds { get; set; } = 30;
}

/// <summary>
/// Remembers each workspace's plan and entitlements between requests, so most requests skip those database queries. It sits on
/// <see cref="IDistributedCache"/>: Redis when configured (shared by every API instance), otherwise memory inside this process.
/// Anything that changes a subscription or a plan exception invalidates the entry at once (see AppDbContext); changing a plan's own
/// definition takes effect immediately on the instance that made the change and within the cache lifetime on others.
/// A cache that is down or slow is treated as empty: it can only make things slower, never wrong or unavailable.
/// </summary>
public class EntitlementCache(IDistributedCache cache, IOptions<CacheOptions> options, TimeProvider time)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<Guid, long> Epochs = new();
    private static int _generation;   // bumped when a plan definition changes: this instance forgets every cached plan at once

    /// <summary>
    /// Changes whenever a workspace's entry is invalidated on this instance. A request that has already read a plan keeps its own copy, so
    /// it compares this number to know that copy went stale (for example right after it changed the subscription itself).
    /// </summary>
    public long Epoch(Guid tenant) => _generation * 1_000_000L + Epochs.GetValueOrDefault(tenant);

    public bool Enabled => options.Value.EntitlementSeconds > 0;

    private static string PlanKey(Guid tenant) => $"plan:{_generation}:{tenant:N}";
    private static string EntKey(Guid tenant) => $"ent:{_generation}:{tenant:N}";

    private DistributedCacheEntryOptions Lifetime(DateTime? notAfter)
    {
        var ttl = TimeSpan.FromSeconds(options.Value.EntitlementSeconds);
        // A trial or exception that ends soon must not outlive its end date in the cache.
        if (notAfter is { } end)
        {
            var left = end - time.GetUtcNow().UtcDateTime;
            if (left < ttl) ttl = left > TimeSpan.Zero ? left : TimeSpan.FromSeconds(1);
        }
        return new DistributedCacheEntryOptions { AbsoluteExpirationRelativeToNow = ttl };
    }

    private async Task<T?> GetAsync<T>(string key, CancellationToken ct) where T : class
    {
        if (!Enabled) return null;
        try { var bytes = await cache.GetAsync(key, ct); return bytes is null ? null : JsonSerializer.Deserialize<T>(bytes, Json); }
        catch (Exception ex) when (ex is not OperationCanceledException) { return null; }
    }

    private async Task SetAsync<T>(string key, T value, DateTime? notAfter, CancellationToken ct)
    {
        if (!Enabled) return;
        try { await cache.SetAsync(key, JsonSerializer.SerializeToUtf8Bytes(value, Json), Lifetime(notAfter), ct); }
        catch (Exception ex) when (ex is not OperationCanceledException) { /* a missing cache entry only costs a query */ }
    }

    public Task<EffectivePlan?> GetPlanAsync(Guid tenant, CancellationToken ct) => GetAsync<EffectivePlan>(PlanKey(tenant), ct);
    public Task SetPlanAsync(Guid tenant, EffectivePlan plan, CancellationToken ct) =>
        SetAsync(PlanKey(tenant), plan, plan.TrialEnd is { } te && te > time.GetUtcNow().UtcDateTime ? te : plan.PeriodEnd, ct);

    public Task<Dictionary<string, long>?> GetEntitlementsAsync(Guid tenant, CancellationToken ct) => GetAsync<Dictionary<string, long>>(EntKey(tenant), ct);
    public Task SetEntitlementsAsync(Guid tenant, Dictionary<string, long> values, DateTime? earliestEnd, CancellationToken ct) => SetAsync(EntKey(tenant), values, earliestEnd, ct);

    /// <summary>Forget one workspace (its subscription or plan exceptions changed).</summary>
    public async Task InvalidateTenantAsync(Guid tenant, CancellationToken ct = default)
    {
        if (!Enabled) return;
        Epochs.AddOrUpdate(tenant, 1, (_, v) => v + 1);
        try { await cache.RemoveAsync(PlanKey(tenant), ct); await cache.RemoveAsync(EntKey(tenant), ct); }
        catch (Exception ex) when (ex is not OperationCanceledException) { /* it expires by itself within the cache lifetime */ }
    }

    /// <summary>A plan's own definition (features, limits, price) changed: forget every cached plan on this instance.</summary>
    public void InvalidateAllPlans() => Interlocked.Increment(ref _generation);
}
