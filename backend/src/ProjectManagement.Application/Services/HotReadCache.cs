using System.Collections.Concurrent;
using Microsoft.Extensions.Caching.Distributed;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;

namespace ProjectManagement.Application.Services;

/// <summary>
/// Cached answers of the screens opened most (the shell summary, the portfolio board, project health, the dashboard and reports), on
/// <see cref="IDistributedCache"/>: Redis when configured (shared by every API server), memory otherwise.
///
/// Invalidation is by tag: every key carries its workspace's current generation, and anything that changes the workspace - a committed save
/// (the same point where the realtime change events are published), or any successful write request - moves the generation on, so every
/// cached answer of that workspace is unreachable at once. Nothing is ever served stale after a change; the lifetime only bounds what
/// changes outside a save (bulk statements in background jobs). A cache that is down is skipped: slower, never wrong.
/// </summary>
public class HotReadCache(IDistributedCache cache, IOptions<CacheOptions> options) : IHotReadInvalidator
{
    private readonly ConcurrentDictionary<Guid, long> local = new();
    private int? seconds;

    /// <summary>How long an answer is kept (Cache:HotReadSeconds; 0 switches the cache off). Settable for tests.</summary>
    public int Seconds { get => seconds ?? options.Value.HotReadSeconds; set => seconds = value; }
    public bool Enabled => Seconds > 0;

    /// <summary>Counts for the tests and the operations page.</summary>
    public long Hits => hits; public long Misses => misses;
    private long hits, misses;

    private static string GenKey(Guid tenant) => $"hot:gen:{tenant:N}";

    /// <summary>The workspace's tag: the shared generation (moved on by any server) plus this server's own counter (survives a cache hiccup).</summary>
    public async Task<string?> TagAsync(Guid tenant, CancellationToken ct)
    {
        if (!Enabled) return null;
        try
        {
            var remote = await cache.GetStringAsync(GenKey(tenant), ct) ?? "0";
            return $"{remote}.{local.GetValueOrDefault(tenant)}";
        }
        catch (Exception ex) when (ex is not OperationCanceledException) { return null; }
    }

    public async Task<byte[]?> GetAsync(string key, CancellationToken ct)
    {
        try
        {
            var bytes = await cache.GetAsync(key, ct);
            if (bytes is null) Interlocked.Increment(ref misses); else Interlocked.Increment(ref hits);
            return bytes;
        }
        catch (Exception ex) when (ex is not OperationCanceledException) { return null; }
    }

    public async Task SetAsync(string key, byte[] value, CancellationToken ct)
    {
        try { await cache.SetAsync(key, value, new DistributedCacheEntryOptions { AbsoluteExpirationRelativeToNow = TimeSpan.FromSeconds(Seconds) }, ct); }
        catch (Exception ex) when (ex is not OperationCanceledException) { /* only costs a query next time */ }
    }

    /// <summary>Forget every cached answer of these workspaces (they changed).</summary>
    public async Task InvalidateAsync(IReadOnlyCollection<Guid> tenants, CancellationToken ct = default)
    {
        foreach (var tenant in tenants.Distinct())
        {
            if (tenant == Guid.Empty) continue;
            local.AddOrUpdate(tenant, 1, (_, v) => v + 1);
            if (!Enabled) continue;
            try { await cache.SetStringAsync(GenKey(tenant), Guid.NewGuid().ToString("N"), new DistributedCacheEntryOptions { AbsoluteExpirationRelativeToNow = TimeSpan.FromDays(2) }, ct); }
            catch (Exception ex) when (ex is not OperationCanceledException) { /* this server already moved on; others within the lifetime */ }
        }
    }
}
