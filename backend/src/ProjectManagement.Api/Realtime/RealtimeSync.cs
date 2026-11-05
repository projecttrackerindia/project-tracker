using System.Collections.Concurrent;
using System.Text.Json;
using System.Threading.Channels;
using Microsoft.AspNetCore.SignalR;
using ProjectManagement.Application.Abstractions;
using StackExchange.Redis;

namespace ProjectManagement.Api.Realtime;

/// <summary>One change as open screens receive it ("sync" event) and as the catch-up endpoint returns it.</summary>
public sealed record SyncEvent(string Type, Guid? Id, Guid? ProjectId, Guid TenantId, string Op, long Version, IReadOnlyList<string>? ChangedFields,
    Guid? ActorId, string Action, Guid? ParentId, DateTime At)
{
    /// <summary>Who may hear of it: these people only (personal things); else the project's readers; else the workspace's members (not guests).</summary>
    public IReadOnlyList<Guid>? Audience { get; init; }
}

/// <summary>The groups a live connection joins for realtime sync, besides the chat ones (<see cref="ChatGroups"/>).</summary>
public static class SyncGroups
{
    /// <summary>The members of a workspace (not guests): workspace-wide things without a project.</summary>
    public static string Members(Guid tenant) => $"m:{tenant:N}";
    /// <summary>Everyone who can read every project of the workspace (no team or membership limit).</summary>
    public static string AllProjects(Guid tenant) => $"pa:{tenant:N}";
    /// <summary>The people who can read one project (joined per project by people whose access is limited, guests included).</summary>
    public static string Project(Guid tenant, Guid project) => $"p:{tenant:N}:{project:N}";

    /// <summary>Exactly where an event goes. Every group name carries the event's own workspace, so nothing crosses workspaces.</summary>
    public static IReadOnlyList<string> For(SyncEvent e)
    {
        if (e.Audience is { } people) return people.Distinct().Select(u => ChatGroups.User(e.TenantId, u)).ToList();
        if (e.ProjectId is { } p) return [Project(e.TenantId, p), AllProjects(e.TenantId)];
        return [Members(e.TenantId)];
    }

    /// <summary>Whether a reader may see an event in the catch-up list (the same rule as the groups).</summary>
    public static bool MaySee(SyncEvent e, Guid user, bool guest, bool allProjects, IReadOnlySet<Guid> projects)
    {
        if (e.Audience is { } people) return people.Contains(user);
        if (e.ProjectId is { } p) return allProjects || projects.Contains(p);
        return !guest;
    }
}

/// <summary>
/// The recent changes of each workspace, numbered (the version), so a client that was asleep or offline asks for "everything after N"
/// instead of reloading every screen. Redis when several API servers share the load (one counter per workspace); memory otherwise.
/// </summary>
public interface IRealtimeLog
{
    /// <summary>Numbers the changes (in order) and keeps them; returns them with their versions.</summary>
    Task<IReadOnlyList<SyncEvent>> AppendAsync(Guid tenant, IReadOnlyList<SyncEvent> changes, CancellationToken ct = default);
    /// <summary>The changes after <paramref name="since"/>, oldest first; complete = false when some were already dropped (the client then reloads its screens).</summary>
    Task<(IReadOnlyList<SyncEvent> Changes, long Version, bool Complete)> SinceAsync(Guid tenant, long since, int max, CancellationToken ct = default);
}

public sealed class InMemoryRealtimeLog(TimeProvider clock) : IRealtimeLog
{
    public const int Keep = 5000;
    private sealed class Book { public long Version; public long Dropped; public readonly LinkedList<SyncEvent> Items = new(); }
    private readonly ConcurrentDictionary<Guid, Book> books = new();
    // Starts from the clock, so a restarted server never hands out a version an open client already has (it then simply catches up).
    private readonly long origin = clock.GetUtcNow().ToUnixTimeMilliseconds() * 1000;

    public Task<IReadOnlyList<SyncEvent>> AppendAsync(Guid tenant, IReadOnlyList<SyncEvent> changes, CancellationToken ct = default)
    {
        var book = books.GetOrAdd(tenant, _ => new Book { Version = origin, Dropped = origin });
        var numbered = new List<SyncEvent>(changes.Count);
        lock (book)
        {
            foreach (var c in changes)
            {
                var e = c with { Version = ++book.Version };
                book.Items.AddLast(e);
                numbered.Add(e);
            }
            while (book.Items.Count > Keep) { book.Dropped = book.Items.First!.Value.Version; book.Items.RemoveFirst(); }
        }
        return Task.FromResult<IReadOnlyList<SyncEvent>>(numbered);
    }

    public Task<(IReadOnlyList<SyncEvent> Changes, long Version, bool Complete)> SinceAsync(Guid tenant, long since, int max, CancellationToken ct = default)
    {
        if (!books.TryGetValue(tenant, out var book)) return Task.FromResult<(IReadOnlyList<SyncEvent>, long, bool)>((Array.Empty<SyncEvent>(), origin, since == origin));
        lock (book)
        {
            var list = book.Items.Where(e => e.Version > since).Take(max + 1).ToList();
            var complete = since >= book.Dropped && since <= book.Version && list.Count <= max;
            return Task.FromResult<(IReadOnlyList<SyncEvent>, long, bool)>((list.Take(max).ToList(), book.Version, complete));
        }
    }
}

/// <summary>Redis: INCR per workspace for the version, a sorted set (score = version) of the last few thousand changes, kept two days.</summary>
public sealed class RedisRealtimeLog(IConnectionMultiplexer redis) : IRealtimeLog
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static RedisKey Counter(Guid t) => $"pm:rt:ver:{t:N}";
    private static RedisKey Log(Guid t) => $"pm:rt:log:{t:N}";
    private static RedisKey Floor(Guid t) => $"pm:rt:floor:{t:N}";
    private static readonly TimeSpan Ttl = TimeSpan.FromDays(2);

    private sealed record Stored(SyncEvent E, IReadOnlyList<Guid>? Audience);

    public async Task<IReadOnlyList<SyncEvent>> AppendAsync(Guid tenant, IReadOnlyList<SyncEvent> changes, CancellationToken ct = default)
    {
        var db = redis.GetDatabase();
        var last = await db.StringIncrementAsync(Counter(tenant), changes.Count);
        var first = last - changes.Count + 1;
        var numbered = changes.Select((c, i) => c with { Version = first + i }).ToList();
        var entries = numbered.Select(e => new SortedSetEntry(JsonSerializer.Serialize(new Stored(e, e.Audience), Json), e.Version)).ToArray();
        await db.SortedSetAddAsync(Log(tenant), entries);
        var length = await db.SortedSetLengthAsync(Log(tenant));
        if (length > InMemoryRealtimeLog.Keep)
        {
            var cut = await db.SortedSetRangeByRankWithScoresAsync(Log(tenant), 0, length - InMemoryRealtimeLog.Keep - 1);
            if (cut.Length > 0) await db.StringSetAsync(Floor(tenant), (long)cut[^1].Score, Ttl);
            await db.SortedSetRemoveRangeByRankAsync(Log(tenant), 0, length - InMemoryRealtimeLog.Keep - 1);
        }
        await db.KeyExpireAsync(Log(tenant), Ttl);
        await db.KeyExpireAsync(Counter(tenant), TimeSpan.FromDays(30));
        return numbered;
    }

    public async Task<(IReadOnlyList<SyncEvent> Changes, long Version, bool Complete)> SinceAsync(Guid tenant, long since, int max, CancellationToken ct = default)
    {
        var db = redis.GetDatabase();
        var version = (long?)await db.StringGetAsync(Counter(tenant)) ?? 0;
        var floor = (long?)await db.StringGetAsync(Floor(tenant)) ?? 0;
        var raw = await db.SortedSetRangeByScoreAsync(Log(tenant), since, double.PositiveInfinity, Exclude.Start, take: max + 1);
        var list = raw.Select(r => JsonSerializer.Deserialize<Stored>((string)r!, Json)).Where(s => s is not null)
            .Select(s => s!.E with { Audience = s.Audience }).ToList();
        // Older than what is kept (or the log expired while the client slept): it reloads its screens instead.
        var complete = since >= floor && since <= version && list.Count <= max && (list.Count == 0 ? since >= version : list[0].Version == since + 1);
        return (list.Take(max).ToList(), version, complete);
    }
}

/// <summary>
/// The live part of realtime sync: what a save changed is numbered (the log), then sent to exactly the groups allowed to hear of it. Runs
/// off the request: SaveChanges only queues (it must never wait for Redis or the sockets), one worker numbers and sends in order.
/// </summary>
public sealed class RealtimeDispatcher(IHubContext<ChatHub> hub, IRealtimeLog log, TimeProvider clock, ILogger<RealtimeDispatcher> logger) : BackgroundService
{
    private readonly Channel<IReadOnlyList<ChangeEvent>> queue = Channel.CreateBounded<IReadOnlyList<ChangeEvent>>(
        new BoundedChannelOptions(10_000) { FullMode = BoundedChannelFullMode.DropOldest, SingleReader = true });

    public void Enqueue(IReadOnlyList<ChangeEvent> changes) => queue.Writer.TryWrite(changes);

    public static SyncEvent ToSync(ChangeEvent c, DateTime at) =>
        new(c.Type ?? ProjectManagement.Infrastructure.Persistence.RealtimeEntityChanges.WireType(c.EntityType), c.EntityId, c.ProjectId, c.TenantId,
            c.Op ?? "updated", 0, c.Fields, c.ActorId, c.Action, c.ParentId, at) { Audience = c.Audience };

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var batch in queue.Reader.ReadAllAsync(stoppingToken))
        {
            try { await SendAsync(batch, stoppingToken); }
            catch (Exception ex) when (ex is not OperationCanceledException) { logger.LogWarning(ex, "Could not send live changes"); }
        }
    }

    public async Task SendAsync(IReadOnlyList<ChangeEvent> batch, CancellationToken ct)
    {
        var at = clock.GetUtcNow().UtcDateTime;
        foreach (var tenant in batch.GroupBy(c => c.TenantId))
        {
            var events = tenant.Select(c => ToSync(c, at)).ToList();
            IReadOnlyList<SyncEvent> numbered;
            // Redis briefly away: still sent live, unnumbered (version 0); the page applies it and keeps its own version for the catch-up.
            try { numbered = await log.AppendAsync(tenant.Key, events, ct); }
            catch (Exception ex) when (ex is not OperationCanceledException) { logger.LogWarning(ex, "Could not number live changes"); numbered = events; }
            // Grouped by destination, so a burst of changes is one message per group, not one per change.
            foreach (var dest in numbered.SelectMany(e => SyncGroups.For(e).Select(g => (g, e))).GroupBy(x => x.g))
            {
                await hub.Clients.Group(dest.Key).SendAsync("sync", dest.Select(x => Wire(x.e)).ToList(), ct);
                // The earlier, coarser event for apps that have not updated yet (same groups, never personal things).
                var legacy = dest.Where(x => x.e.Audience is null)
                    .Select(x => new { entityType = x.e.Type, entityId = x.e.Id, projectId = x.e.ProjectId, action = x.e.Action, actorId = x.e.ActorId }).ToList();
                if (legacy.Count > 0) await hub.Clients.Group(dest.Key).SendAsync("changed", legacy, ct);
            }
        }
    }

    /// <summary>What leaves the server: ids, the kind, the operation, the version, the names of the changed fields, who did it. No values.</summary>
    public static object Wire(SyncEvent e) => new
    {
        type = e.Type, id = e.Id, projectId = e.ProjectId, tenantId = e.TenantId, op = e.Op, version = e.Version,
        changedFields = e.ChangedFields, actorId = e.ActorId, action = e.Action, parentId = e.ParentId, at = e.At,
    };
}

/// <summary>Hands committed changes to the dispatcher (replaces the earlier workspace-wide broadcast).</summary>
public class SignalRChangeFeed(RealtimeDispatcher dispatcher) : IChangeFeed
{
    public void Publish(IReadOnlyList<ChangeEvent> changes) { if (changes.Count > 0) dispatcher.Enqueue(changes); }
}
