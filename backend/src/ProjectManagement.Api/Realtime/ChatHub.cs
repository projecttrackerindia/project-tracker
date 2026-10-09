using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Chat;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Infrastructure.Services;

namespace ProjectManagement.Api.Realtime;

/// <summary>Names of the groups a connection belongs to. A person is addressed inside one workspace, never across workspaces.</summary>
public static class ChatGroups
{
    public static string User(Guid tenant, Guid user) => $"u:{tenant:N}:{user:N}";
    public static string Workspace(Guid tenant) => $"t:{tenant:N}";
}

/// <summary>Sends chat events to the open tabs of the people they are for.</summary>
public class SignalRChatNotifier(IHubContext<ChatHub> hub) : IChatNotifier
{
    public Task ToUsersAsync(Guid tenantId, IEnumerable<Guid> userIds, string eventName, object payload, CancellationToken ct = default)
    {
        var groups = userIds.Distinct().Select(u => ChatGroups.User(tenantId, u)).ToList();
        return groups.Count == 0 ? Task.CompletedTask : hub.Clients.Groups(groups).SendAsync(eventName, payload, ct);
    }
}

/// <summary>
/// Live updates: what changed in a workspace goes to everyone there who has the app open, so boards, lists and dashboards refresh by
/// themselves. Only the kind of thing, its id and its project are sent - each screen reloads through the API with its own permissions.
/// </summary>
public class SignalRChangeFeed(IHubContext<ChatHub> hub, ILogger<SignalRChangeFeed> log) : IChangeFeed
{
    public void Publish(IReadOnlyList<ChangeEvent> changes)
    {
        foreach (var group in changes.GroupBy(c => c.TenantId))
        {
            var payload = group.Select(c => new { entityType = c.EntityType, entityId = c.EntityId, projectId = c.ProjectId, action = c.Action, actorId = c.ActorId }).ToList();
            _ = hub.Clients.Group(ChatGroups.Workspace(group.Key)).SendAsync("changed", payload).ContinueWith(
                t => log.LogDebug(t.Exception, "Could not send live changes"), TaskContinuationOptions.OnlyOnFaulted);
        }
    }
}

/// <summary>
/// Who has the app open, counted per connection (a person can have several tabs). "Online" flips at once, "offline" only after a short
/// pause, so reloading a page does not make someone flicker offline. The counts live in <see cref="IPresenceStore"/>: in memory for one
/// server, in Redis when several share the load (with the Redis backplane, the presence events also reach every server's clients).
/// </summary>
public class ChatPresence(IHubContext<ChatHub> hub, IPresenceStore store) : IChatPresence
{
    private static readonly TimeSpan OfflineDelay = TimeSpan.FromSeconds(4);

    /// <summary>True only while the person is actually active (an open but idle tab does not count).</summary>
    public bool IsOnline(Guid tenantId, Guid userId) => store.GetStatus(tenantId, userId) == PresenceStatus.Active;

    /// <summary>"active", "away" or "offline".</summary>
    public string Status(Guid tenantId, Guid userId) => Name(store.GetStatus(tenantId, userId));

    public static string Name(PresenceStatus s) => s switch { PresenceStatus.Active => "active", PresenceStatus.Away => "away", _ => "offline" };

    private Task Broadcast(Guid tenant, Guid user, PresenceStatus status) =>
        hub.Clients.Group(ChatGroups.Workspace(tenant)).SendAsync("presence", new { userId = user, online = status == PresenceStatus.Active, status = Name(status) });

    public async Task ConnectedAsync(string connectionId, Guid tenant, Guid user)
    {
        var before = store.GetStatus(tenant, user);
        var first = await store.AddAsync(connectionId, tenant, user);
        // A new connection starts active: announce it when that changes how the person looks (offline or away before).
        if (first || before != PresenceStatus.Active) await Broadcast(tenant, user, PresenceStatus.Active);
    }

    /// <summary>One of the person's connections went idle or came back; announces the person's overall status if it changed.</summary>
    public async Task IdleChangedAsync(string connectionId, bool idle)
    {
        var who = await store.SetIdleAsync(connectionId, idle);
        if (who is not { } w) return;
        await Broadcast(w.Tenant, w.User, store.GetStatus(w.Tenant, w.User));
    }

    public void Disconnected(string connectionId)
    {
        _ = Task.Run(async () =>
        {
            if (await store.RemoveAsync(connectionId) is not { } who) return;
            await Task.Delay(OfflineDelay);
            // Offline only if nothing is left; if another tab is open it may now be the active (or the only, idle) one.
            await Broadcast(who.Tenant, who.User, store.GetStatus(who.Tenant, who.User));
        });
    }
}

/// <summary>
/// The live connection for chat. It only carries news out and "is typing" in: messages are sent through the normal API, where the
/// permission and validation rules live. The workspace and person come from the validated token (checked against the database when
/// the connection is made), never from anything the browser says afterwards.
/// </summary>
[Authorize]
public class ChatHub(ChatPresence presence, IAppDbContext db, TimeProvider clock) : Hub
{
    private const string TenantKey = "tenant", UserKey = "user", NameKey = "name", WatchingKey = "watching";

    public override async Task OnConnectedAsync()
    {
        // The token was validated by the authentication handler; what it says is checked against the database the way an API request is
        // (session still open, person still active and still a member of an organization workspace that is active).
        var claims = Context.User;
        if (!Guid.TryParse(claims?.FindFirst("sub")?.Value, out var user) || !Guid.TryParse(claims.FindFirst(JwtClaims.SessionId)?.Value, out var session)
            || !Guid.TryParse(claims.FindFirst(JwtClaims.WorkspaceId)?.Value, out var tenant))
        {
            Context.Abort();
            return;
        }
        var now = clock.GetUtcNow().UtcDateTime;
        var name = await (from s in db.UserSessions
                          join u in db.Users on s.UserId equals u.Id
                          join m in db.TenantMembers on u.Id equals m.UserId
                          join t in db.Tenants on m.TenantId equals t.Id
                          where s.Id == session && s.UserId == user && s.RevokedAt == null && s.ExpiresAt > now && u.IsActive
                                && m.TenantId == tenant && m.Role != TenantRole.Guest && t.Status == TenantStatus.Active && t.Type == WorkspaceType.Organization
                          select u.DisplayName).AsNoTracking().FirstOrDefaultAsync();
        if (name is null)
        {
            Context.Abort();
            return;
        }
        Context.Items[TenantKey] = tenant;
        Context.Items[UserKey] = user;
        Context.Items[NameKey] = name;

        await Groups.AddToGroupAsync(Context.ConnectionId, ChatGroups.User(tenant, user));
        await Groups.AddToGroupAsync(Context.ConnectionId, ChatGroups.Workspace(tenant));
        await presence.ConnectedAsync(Context.ConnectionId, tenant, user);

        // The access token is only checked when the connection is made, so close the connection when the token runs out: the browser
        // reconnects with a fresh one, and a session that was ended stops receiving within one token lifetime.
        if (long.TryParse(Context.User?.FindFirst("exp")?.Value, out var exp))
        {
            var left = DateTimeOffset.FromUnixTimeSeconds(exp) - DateTimeOffset.UtcNow;
            var connection = Context;
            _ = Task.Delay(left > TimeSpan.Zero ? left : TimeSpan.Zero, connection.ConnectionAborted)
                .ContinueWith(t => { if (!t.IsCanceled) connection.Abort(); }, TaskScheduler.Default);
        }
        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        presence.Disconnected(Context.ConnectionId);
        // Leaving the app closes whatever the person was looking at.
        if (Context.Items[WatchingKey] is HashSet<string> watching && Context.Items[TenantKey] is Guid tenant && Context.Items[UserKey] is Guid user)
            foreach (var key in watching) await Clients.Group(ViewGroup(tenant, key)).SendAsync("viewing", new { key, userId = user, on = false });
        await base.OnDisconnectedAsync(exception);
    }

    /// <summary>The page reports that this tab has had no keyboard, mouse or touch activity for a while (true) or that the person is back (false).</summary>
    public Task SetIdle(bool idle) => presence.IdleChangedAsync(Context.ConnectionId, idle);

    // ---- who else is looking at the same task: each open task is a group; people announce themselves and answer newcomers.

    private static string ViewGroup(Guid tenant, string key) => $"v:{tenant:N}:{key}";

    /// <summary>"task:{id}" or "work:{id}" of a task or work task in the caller's workspace, else null.</summary>
    private async Task<string?> CheckKeyAsync(string key, Guid tenant)
    {
        var parts = key.Split(':');
        if (parts.Length != 2 || !Guid.TryParse(parts[1], out var id)) return null;
        var exists = parts[0] switch
        {
            "task" => await db.Tasks.IgnoreQueryFilters().AnyAsync(t => t.Id == id && t.TenantId == tenant && !t.IsDeleted),
            "work" => await db.WorkTasks.IgnoreQueryFilters().AnyAsync(t => t.Id == id && t.TenantId == tenant && !t.IsDeleted),
            _ => false,
        };
        return exists ? $"{parts[0]}:{id:N}" : null;
    }

    /// <summary>The caller opened a task: join its viewers and say so (the others answer with <see cref="Here"/>).</summary>
    public async Task Watch(string key)
    {
        if (Context.Items[TenantKey] is not Guid tenant || Context.Items[UserKey] is not Guid user) return;
        if (await CheckKeyAsync(key, tenant) is not { } k) return;
        if (Context.Items[WatchingKey] is not HashSet<string> watching) Context.Items[WatchingKey] = watching = [];
        if (watching.Count >= 10) return;
        watching.Add(k);
        await Groups.AddToGroupAsync(Context.ConnectionId, ViewGroup(tenant, k));
        await Clients.OthersInGroup(ViewGroup(tenant, k)).SendAsync("viewing", new { key = k, userId = user, name = Context.Items[NameKey] as string, on = true, hello = true });
    }

    /// <summary>"I am still here", in answer to a newcomer and every so often (a viewer who stops saying it is dropped).</summary>
    public async Task Here(string key)
    {
        if (Context.Items[TenantKey] is not Guid tenant || Context.Items[UserKey] is not Guid user) return;
        if (Context.Items[WatchingKey] is not HashSet<string> watching || !watching.Contains(key)) return;
        await Clients.OthersInGroup(ViewGroup(tenant, key)).SendAsync("viewing", new { key, userId = user, name = Context.Items[NameKey] as string, on = true });
    }

    public async Task Unwatch(string key)
    {
        if (Context.Items[TenantKey] is not Guid tenant || Context.Items[UserKey] is not Guid user) return;
        if (Context.Items[WatchingKey] is not HashSet<string> watching || !watching.Remove(key)) return;
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, ViewGroup(tenant, key));
        await Clients.Group(ViewGroup(tenant, key)).SendAsync("viewing", new { key, userId = user, on = false });
    }

    /// <summary>Tells the other people in a conversation that the caller is typing. Ignored unless the caller is in it.</summary>
    public async Task Typing(Guid conversationId)
    {
        if (Context.Items[TenantKey] is not Guid tenant || Context.Items[UserKey] is not Guid user) return;
        var members = await db.ConversationMembers.IgnoreQueryFilters().AsNoTracking()
            .Where(m => m.TenantId == tenant && m.ConversationId == conversationId).Select(m => m.UserId).ToListAsync();
        if (!members.Contains(user)) return;
        var others = members.Where(m => m != user).Select(m => ChatGroups.User(tenant, m)).ToList();
        if (others.Count == 0) return;
        await Clients.Groups(others).SendAsync("typing", new { conversationId, userId = user, name = Context.Items[NameKey] as string });
    }
}
