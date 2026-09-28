using System.Collections.Concurrent;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
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
/// Who has the app open, counted per connection (a person can have several tabs). "Online" flips at once, "offline" only after a short
/// pause, so reloading a page does not make someone flicker offline. Held in memory: with several API servers this would need a shared
/// store, which is why the deployment guide runs one.
/// </summary>
public class ChatPresence(IHubContext<ChatHub> hub) : IChatPresence
{
    private static readonly TimeSpan OfflineDelay = TimeSpan.FromSeconds(4);
    private readonly ConcurrentDictionary<string, (Guid Tenant, Guid User)> _connections = new();
    private readonly ConcurrentDictionary<(Guid Tenant, Guid User), int> _counts = new();
    private readonly object _gate = new();

    public bool IsOnline(Guid tenantId, Guid userId) => _counts.TryGetValue((tenantId, userId), out var n) && n > 0;

    public async Task ConnectedAsync(string connectionId, Guid tenant, Guid user)
    {
        bool first;
        lock (_gate)
        {
            _connections[connectionId] = (tenant, user);
            first = _counts.AddOrUpdate((tenant, user), 1, (_, v) => v + 1) == 1;
        }
        if (first) await hub.Clients.Group(ChatGroups.Workspace(tenant)).SendAsync("presence", new { userId = user, online = true });
    }

    public void Disconnected(string connectionId)
    {
        (Guid Tenant, Guid User) who;
        lock (_gate)
        {
            if (!_connections.TryRemove(connectionId, out who)) return;
            _counts.AddOrUpdate(who, 0, (_, v) => Math.Max(0, v - 1));
        }
        _ = Task.Run(async () =>
        {
            await Task.Delay(OfflineDelay);
            if (IsOnline(who.Tenant, who.User)) return;
            _counts.TryRemove(who, out _);
            await hub.Clients.Group(ChatGroups.Workspace(who.Tenant)).SendAsync("presence", new { userId = who.User, online = false });
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
    private const string TenantKey = "tenant", UserKey = "user", NameKey = "name";

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

    public override Task OnDisconnectedAsync(Exception? exception)
    {
        presence.Disconnected(Context.ConnectionId);
        return base.OnDisconnectedAsync(exception);
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
