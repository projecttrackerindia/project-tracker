using System.Threading.RateLimiting;
using StackExchange.Redis;

namespace ProjectManagement.Api.Extensions;

/// <summary>
/// A fixed-window rate limiter whose counter lives in Redis, so the limit is shared by every API instance instead of multiplying with the
/// number of servers. If Redis cannot be reached the request is allowed (and logged by the caller's health check): rate limiting must not
/// become a reason for the whole site to go down.
/// </summary>
public sealed class RedisFixedWindowRateLimiter(IConnectionMultiplexer redis, string partition, int limit, TimeSpan window, TimeProvider time) : RateLimiter
{
    private readonly long _windowSeconds = (long)window.TotalSeconds;

    public override TimeSpan? IdleDuration => null;
    public override RateLimiterStatistics? GetStatistics() => null;

    private (string Key, TimeSpan RetryAfter) Slot()
    {
        var now = time.GetUtcNow();
        var start = now.ToUnixTimeSeconds() / _windowSeconds;
        return ($"rl:{partition}:{start}", TimeSpan.FromSeconds((start + 1) * _windowSeconds - now.ToUnixTimeSeconds()));
    }

    private RateLimitLease Decide(long count, TimeSpan retryAfter) => count <= limit ? new Lease(true, null) : new Lease(false, retryAfter);

    protected override RateLimitLease AttemptAcquireCore(int permitCount)
    {
        try
        {
            var (key, retry) = Slot();
            var db = redis.GetDatabase();
            var count = db.StringIncrement(key);
            if (count == 1) db.KeyExpire(key, window + TimeSpan.FromSeconds(5));
            return Decide(count, retry);
        }
        catch (Exception ex) when (ex is RedisException or TimeoutException) { return new Lease(true, null); }
    }

    protected override async ValueTask<RateLimitLease> AcquireAsyncCore(int permitCount, CancellationToken cancellationToken)
    {
        try
        {
            var (key, retry) = Slot();
            var db = redis.GetDatabase();
            var count = await db.StringIncrementAsync(key);
            if (count == 1) await db.KeyExpireAsync(key, window + TimeSpan.FromSeconds(5));
            return Decide(count, retry);
        }
        catch (Exception ex) when (ex is RedisException or TimeoutException) { return new Lease(true, null); }
    }

    private sealed class Lease(bool acquired, TimeSpan? retryAfter) : RateLimitLease
    {
        public override bool IsAcquired => acquired;
        public override IEnumerable<string> MetadataNames => retryAfter is null ? [] : [MetadataName.RetryAfter.Name];
        public override bool TryGetMetadata(string metadataName, out object? metadata)
        {
            if (retryAfter is { } r && metadataName == MetadataName.RetryAfter.Name) { metadata = r; return true; }
            metadata = null; return false;
        }
    }
}
