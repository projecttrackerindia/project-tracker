using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Ai;
using StackExchange.Redis;

namespace ProjectManagement.Infrastructure.Services;

internal static class AiLimitRejections
{
    public static AiRequestLimitException Create(int dimension, int retry) => new(
        dimension switch { 1 => "AI_MINUTE_LIMIT", 2 => "AI_HOUR_LIMIT", 3 => "AI_DAY_LIMIT", _ => "AI_USER_CONCURRENCY_LIMIT" }, retry,
        dimension == 4 ? $"Your current AI requests are still running. Try again in {retry} seconds."
        : $"You have reached your plan's AI request limit for this {(dimension == 1 ? "minute" : dimension == 2 ? "hour" : "day")}. Try again in {retry} seconds.");
}

/// <summary>Single-instance development fallback. Entries expire after a day; acquisition and release are atomic within a process.</summary>
public sealed class MemoryAiRequestLimiter(TimeProvider time) : IAiRequestLimiter, IDisposable
{
    private readonly MemoryCache cache = new(new MemoryCacheOptions());
    private readonly object sync = new();
    public bool Distributed => false;
    private sealed class State
    {
        public long[] Windows { get; } = [-1, -1, -1];
        public int[] Counts { get; } = new int[3];
        public Dictionary<Guid, long> Active { get; } = [];
    }

    public Task<IAsyncDisposable> EnterAsync(Guid tenantId, Guid userId, AiRequestLimits limits, TimeSpan leaseLifetime, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (sync)
        {
            var key = (tenantId, userId);
            var state = cache.GetOrCreate(key, entry => { entry.SlidingExpiration = TimeSpan.FromHours(25); return new State(); })!;
            var now = time.GetUtcNow().ToUnixTimeSeconds();
            int[] periods = [60, 3600, 86400], caps = [limits.PerMinute, limits.PerHour, limits.PerDay];
            foreach (var id in state.Active.Where(p => p.Value <= now).Select(p => p.Key).ToArray()) state.Active.Remove(id);
            for (var i = 0; i < 3; i++)
            {
                var window = now / periods[i];
                if (state.Windows[i] != window) { state.Windows[i] = window; state.Counts[i] = 0; }
                if (state.Counts[i] >= caps[i]) throw AiLimitRejections.Create(i + 1, (int)((window + 1) * periods[i] - now));
            }
            if (state.Active.Count >= limits.Concurrent)
                throw AiLimitRejections.Create(4, 2);
            for (var i = 0; i < 3; i++) state.Counts[i]++;
            var token = Guid.NewGuid(); state.Active.Add(token, now + (long)leaseLifetime.TotalSeconds);
            return Task.FromResult<IAsyncDisposable>(new Lease(this, state, token));
        }
    }

    public void Dispose() => cache.Dispose();
    private sealed class Lease(MemoryAiRequestLimiter owner, State state, Guid token) : IAsyncDisposable
    {
        public ValueTask DisposeAsync() { lock (owner.sync) state.Active.Remove(token); return ValueTask.CompletedTask; }
    }
}

/// <summary>One atomic Redis script checks every window and concurrent lease before charging any counter. Fail closed on store outages.</summary>
public sealed class RedisAiRequestLimiter(IConnectionMultiplexer redis, ILogger<RedisAiRequestLimiter> log) : IAiRequestLimiter
{
    public bool Distributed => true;
    // The two keys share a hash tag, so admission also works on Redis Cluster. Server TIME avoids clock skew between API replicas.
    private const string Acquire = """
        local now = tonumber(redis.call('TIME')[1])
        local periods = {60, 3600, 86400}
        redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
        for i = 1, 3 do
            local slot = math.floor(now / periods[i])
            if tonumber(redis.call('HGET', KEYS[1], 'w' .. i)) == slot then
                if tonumber(redis.call('HGET', KEYS[1], 'c' .. i) or '0') >= tonumber(ARGV[i]) then
                    return {i, (slot + 1) * periods[i] - now}
                end
            end
        end
        if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[4]) then return {4, 2} end
        for i = 1, 3 do
            local slot = math.floor(now / periods[i])
            if tonumber(redis.call('HGET', KEYS[1], 'w' .. i)) ~= slot then
                redis.call('HSET', KEYS[1], 'w' .. i, slot, 'c' .. i, 0)
            end
            redis.call('HINCRBY', KEYS[1], 'c' .. i, 1)
        end
        redis.call('EXPIRE', KEYS[1], 90000)
        redis.call('ZADD', KEYS[2], now + tonumber(ARGV[5]), ARGV[6])
        local ttl = tonumber(ARGV[5]) + 60
        if redis.call('TTL', KEYS[2]) < ttl then redis.call('EXPIRE', KEYS[2], ttl) end
        return {0, 0}
        """;

    public async Task<IAsyncDisposable> EnterAsync(Guid tenantId, Guid userId, AiRequestLimits limits, TimeSpan leaseLifetime, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var prefix = $"pm:ai-limits:{{{tenantId:N}:{userId:N}}}";
        RedisKey counts = prefix + ":counts", active = prefix + ":active";
        var token = Guid.NewGuid().ToString("N");
        try
        {
            // Do not abandon an in-flight script on cancellation: it may have admitted a lease that we must release.
            var result = (RedisResult[])(await redis.GetDatabase().ScriptEvaluateAsync(Acquire, [counts, active],
                [limits.PerMinute, limits.PerHour, limits.PerDay, limits.Concurrent, (long)leaseLifetime.TotalSeconds, token]))!;
            var dimension = (int)result[0];
            if (dimension != 0) throw AiLimitRejections.Create(dimension, (int)result[1]);
            var lease = new Lease(redis, log, active, token);
            if (ct.IsCancellationRequested) { await lease.DisposeAsync(); ct.ThrowIfCancellationRequested(); }
            return lease;
        }
        catch (Exception ex) when (ex is RedisException or TimeoutException)
        {
            log.LogWarning(ex, "AI request admission unavailable");
            throw new AppException(503, "AI_LIMIT_STORE_UNAVAILABLE", "The assistant's shared capacity controls are unavailable. Please try again later.");
        }
    }

    private sealed class Lease(IConnectionMultiplexer redis, ILogger log, RedisKey key, string token) : IAsyncDisposable
    {
        public async ValueTask DisposeAsync()
        {
            try { await redis.GetDatabase().SortedSetRemoveAsync(key, token); }
            catch (Exception ex) when (ex is RedisException or TimeoutException) { log.LogWarning(ex, "AI request lease release failed; it will expire automatically"); }
        }
    }
}
