using System.Collections.Concurrent;
using StackExchange.Redis;

namespace ProjectManagement.Api.Realtime;

/// <summary>
/// Which live connections each person has open. With one API server this can live in memory; with several it must be shared, or a person
/// connected to server A looks offline to everyone on server B.
/// </summary>
public interface IPresenceStore
{
    /// <summary>Records a connection; true when it is the person's first one (they have just come online).</summary>
    Task<bool> AddAsync(string connectionId, Guid tenant, Guid user);
    /// <summary>Forgets a connection and says whose it was (null if unknown).</summary>
    Task<(Guid Tenant, Guid User)?> RemoveAsync(string connectionId);
    bool IsOnline(Guid tenant, Guid user);
}

/// <summary>Presence for a single API server.</summary>
public sealed class InMemoryPresenceStore : IPresenceStore
{
    private readonly ConcurrentDictionary<string, (Guid Tenant, Guid User)> _connections = new();
    private readonly ConcurrentDictionary<(Guid Tenant, Guid User), int> _counts = new();
    private readonly object _gate = new();

    public Task<bool> AddAsync(string connectionId, Guid tenant, Guid user)
    {
        lock (_gate)
        {
            _connections[connectionId] = (tenant, user);
            return Task.FromResult(_counts.AddOrUpdate((tenant, user), 1, (_, v) => v + 1) == 1);
        }
    }

    public Task<(Guid Tenant, Guid User)?> RemoveAsync(string connectionId)
    {
        lock (_gate)
        {
            if (!_connections.TryRemove(connectionId, out var who)) return Task.FromResult<(Guid, Guid)?>(null);
            if (_counts.AddOrUpdate(who, 0, (_, v) => Math.Max(0, v - 1)) == 0) _counts.TryRemove(who, out _);
            return Task.FromResult<(Guid, Guid)?>(who);
        }
    }

    public bool IsOnline(Guid tenant, Guid user) => _counts.TryGetValue((tenant, user), out var n) && n > 0;
}

/// <summary>
/// Presence shared by every API server through Redis. Each person has a sorted set of their open connections, scored with the last time
/// the server holding the connection confirmed it; a server refreshes its own connections every 30 seconds. A connection not confirmed
/// for 90 seconds (its server crashed or was replaced) no longer counts, so nobody stays "online" forever.
/// </summary>
public sealed class RedisPresenceStore : IPresenceStore, IHostedService, IDisposable
{
    private static readonly TimeSpan Heartbeat = TimeSpan.FromSeconds(30), Stale = TimeSpan.FromSeconds(90), KeyLife = TimeSpan.FromMinutes(3);
    private readonly IConnectionMultiplexer _redis;
    private readonly ILogger<RedisPresenceStore> _log;
    private readonly ConcurrentDictionary<string, (Guid Tenant, Guid User)> _mine = new();   // connections held by this server
    private Timer? _timer;

    public RedisPresenceStore(IConnectionMultiplexer redis, ILogger<RedisPresenceStore> log) { _redis = redis; _log = log; }

    private static RedisKey Key(Guid tenant, Guid user) => $"pm:presence:{tenant:N}:{user:N}";
    private static double Now => DateTimeOffset.UtcNow.ToUnixTimeSeconds();

    public async Task<bool> AddAsync(string connectionId, Guid tenant, Guid user)
    {
        _mine[connectionId] = (tenant, user);
        try
        {
            var db = _redis.GetDatabase();
            var key = Key(tenant, user);
            await db.SortedSetRemoveRangeByScoreAsync(key, double.NegativeInfinity, Now - Stale.TotalSeconds);
            await db.SortedSetAddAsync(key, connectionId, Now);
            await db.KeyExpireAsync(key, KeyLife);
            return await db.SortedSetLengthAsync(key) == 1;
        }
        catch (Exception ex) when (ex is RedisException or TimeoutException) { _log.LogWarning(ex, "Presence: Redis unavailable"); return false; }
    }

    public async Task<(Guid Tenant, Guid User)?> RemoveAsync(string connectionId)
    {
        if (!_mine.TryRemove(connectionId, out var who)) return null;
        try { await _redis.GetDatabase().SortedSetRemoveAsync(Key(who.Tenant, who.User), connectionId); }
        catch (Exception ex) when (ex is RedisException or TimeoutException) { _log.LogWarning(ex, "Presence: Redis unavailable"); }
        return who;
    }

    public bool IsOnline(Guid tenant, Guid user)
    {
        try { return _redis.GetDatabase().SortedSetLength(Key(tenant, user), Now - Stale.TotalSeconds, double.PositiveInfinity) > 0; }
        catch (Exception ex) when (ex is RedisException or TimeoutException) { _log.LogWarning(ex, "Presence: Redis unavailable"); return false; }
    }

    private async Task RefreshAsync()
    {
        if (_mine.IsEmpty) return;
        try
        {
            var db = _redis.GetDatabase();
            var now = Now;
            var batch = db.CreateBatch();
            var work = new List<Task>();
            foreach (var (connection, who) in _mine)
            {
                var key = Key(who.Tenant, who.User);
                work.Add(batch.SortedSetAddAsync(key, connection, now));
                work.Add(batch.KeyExpireAsync(key, KeyLife));
            }
            batch.Execute();
            await Task.WhenAll(work);
        }
        catch (Exception ex) when (ex is RedisException or TimeoutException) { _log.LogWarning(ex, "Presence heartbeat: Redis unavailable"); }
    }

    public Task StartAsync(CancellationToken ct) { _timer = new Timer(_ => _ = RefreshAsync(), null, Heartbeat, Heartbeat); return Task.CompletedTask; }

    /// <summary>On a clean shutdown this server's connections are removed at once instead of waiting to go stale.</summary>
    public async Task StopAsync(CancellationToken ct)
    {
        _timer?.Change(Timeout.Infinite, Timeout.Infinite);
        foreach (var connection in _mine.Keys.ToList()) await RemoveAsync(connection);
    }

    public void Dispose() => _timer?.Dispose();
}
