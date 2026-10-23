using System.Collections.Concurrent;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Features.Documents;

namespace ProjectManagement.Api.Realtime;

/// <summary>
/// One page being edited together: the editing history since the first editor opened it (Yjs updates, opaque to the server), and who is in
/// it. The history lets a newcomer catch up without asking anyone; when everyone has left it is dropped and the page's saved text is the
/// starting point again. Kept in memory on this server.
/// </summary>
public sealed class DocRoom
{
    public readonly object Gate = new();
    public List<string> Updates { get; } = [];
    public long Bytes { get; set; }
    public bool Initialized { get; set; }
    public bool CompactRequested { get; set; }
    public Dictionary<string, DocPeer> Peers { get; } = [];
}

public sealed record DocPeer(string ConnectionId, Guid UserId, string Name, string Color, DateTime JoinedAt);

public static class DocRooms
{
    public const int MaxUpdateChars = 700_000, CompactAfterChars = 6_000_000, CompactAfterCount = 4000, MaxPagesPerConnection = 5;
    public static readonly ConcurrentDictionary<string, DocRoom> Rooms = new();
    public static string Key(Guid tenant, Guid doc) => $"{tenant:N}:{doc:N}";
    public static string Group(Guid tenant, Guid doc) => $"d:{tenant:N}:{doc:N}";
    private static readonly string[] Colors = ["#e11d48", "#2563eb", "#16a34a", "#d97706", "#7c3aed", "#0891b2", "#db2777", "#4d7c0f"];
    public static string ColorOf(Guid user) => Colors[(int)((uint)user.GetHashCode() % Colors.Length)];
}

/// <summary>
/// Live co-editing of pages (the document's editors only): everyone in a page sees the others' changes as they type and where their cursor
/// is. The server only relays and remembers the editing history; whether someone may edit is checked like an API request when they join.
/// One editor (the first in the room) saves the text for everyone, so autosave never fights itself.
/// </summary>
public partial class ChatHub
{
    private const string DocsKey = "docs";

    private HashSet<Guid> MyDocs() => Context.Items[DocsKey] as HashSet<Guid> ?? (HashSet<Guid>)(Context.Items[DocsKey] = new HashSet<Guid>());

    private static object PeersOf(DocRoom room)
    {
        lock (room.Gate)
        {
            var leader = room.Peers.Values.OrderBy(p => p.JoinedAt).FirstOrDefault();
            return new
            {
                peers = room.Peers.Values.OrderBy(p => p.JoinedAt).Select(p => new { connectionId = p.ConnectionId, userId = p.UserId, name = p.Name, color = p.Color }).ToList(),
                leader = leader?.ConnectionId,
            };
        }
    }

    /// <summary>Joins a page's editing room. Answers whether this editor starts the history (from the saved text) and the history so far.</summary>
    public async Task<object?> DocJoin(Guid documentId)
    {
        if (Context.Items[TenantKey] is not Guid tenant || Context.Items[UserKey] is not Guid user) return null;
        var mine = MyDocs();
        if (!mine.Contains(documentId) && mine.Count >= DocRooms.MaxPagesPerConnection) return null;
        // The same reach and rights an API request of this person has: only the page's editors edit together.
        try { await ProjectManagement.Application.Services.WorkspaceExecutionPrincipal.ConfigureAsync(services, user, tenant, null, Context.ConnectionAborted); }
        catch (ProjectManagement.Application.Exceptions.AppException) { return null; }
        var doc = await db.Documents.AsNoTracking().FirstOrDefaultAsync(d => d.Id == documentId);
        if (doc is null) return null;
        if (!(await services.GetRequiredService<DocumentAccessService>().RightsAsync(doc)).Edit) return new { canEdit = false };

        var room = DocRooms.Rooms.GetOrAdd(DocRooms.Key(tenant, documentId), _ => new DocRoom());
        bool init;
        List<string> history;
        lock (room.Gate)
        {
            init = !room.Initialized;
            room.Initialized = true;
            history = [.. room.Updates];
            room.Peers[Context.ConnectionId] = new DocPeer(Context.ConnectionId, user, Context.Items[NameKey] as string ?? "Someone", DocRooms.ColorOf(user), DateTime.UtcNow);
        }
        mine.Add(documentId);
        await Groups.AddToGroupAsync(Context.ConnectionId, DocRooms.Group(tenant, documentId));
        var peers = PeersOf(room);
        await Clients.OthersInGroup(DocRooms.Group(tenant, documentId)).SendAsync("docPeers", new { documentId, room = peers });
        return new { canEdit = true, init, updates = history, room = peers, color = DocRooms.ColorOf(user), revision = doc.Revision };
    }

    private DocRoom? RoomOf(Guid documentId, out Guid tenant)
    {
        tenant = Context.Items[TenantKey] is Guid t ? t : Guid.Empty;
        if (tenant == Guid.Empty || !MyDocs().Contains(documentId)) return null;
        return DocRooms.Rooms.TryGetValue(DocRooms.Key(tenant, documentId), out var r) ? r : null;
    }

    /// <summary>An edit (a Yjs update, base64): remembered and passed to the others in the page.</summary>
    public async Task DocUpdate(Guid documentId, string update)
    {
        if (string.IsNullOrEmpty(update) || update.Length > DocRooms.MaxUpdateChars) return;
        if (RoomOf(documentId, out var tenant) is not { } room) return;
        string? askCompact = null;
        lock (room.Gate)
        {
            if (!room.Peers.ContainsKey(Context.ConnectionId)) return;
            room.Updates.Add(update);
            room.Bytes += update.Length;
            if (!room.CompactRequested && (room.Bytes > DocRooms.CompactAfterChars || room.Updates.Count > DocRooms.CompactAfterCount))
            {
                room.CompactRequested = true;
                askCompact = room.Peers.Values.OrderBy(p => p.JoinedAt).First().ConnectionId;
            }
        }
        await Clients.OthersInGroup(DocRooms.Group(tenant, documentId)).SendAsync("docUpdate", new { documentId, update });
        if (askCompact is not null) await Clients.Client(askCompact).SendAsync("docCompact", new { documentId });
    }

    /// <summary>The leader's whole document as one update, replacing the long history (sent when the server asks for it).</summary>
    public Task DocCompact(Guid documentId, string state)
    {
        if (string.IsNullOrEmpty(state) || state.Length > DocRooms.CompactAfterChars * 2) return Task.CompletedTask;
        if (RoomOf(documentId, out _) is not { } room) return Task.CompletedTask;
        lock (room.Gate)
        {
            if (!room.Peers.ContainsKey(Context.ConnectionId)) return Task.CompletedTask;
            room.Updates.Clear(); room.Updates.Add(state); room.Bytes = state.Length; room.CompactRequested = false;
        }
        return Task.CompletedTask;
    }

    /// <summary>Where the caller's cursor and selection are (a Yjs awareness update): passed on, never stored.</summary>
    public async Task DocAwareness(Guid documentId, string update)
    {
        if (string.IsNullOrEmpty(update) || update.Length > 20_000) return;
        if (RoomOf(documentId, out var tenant) is null) return;
        await Clients.OthersInGroup(DocRooms.Group(tenant, documentId)).SendAsync("docAwareness", new { documentId, update });
    }

    /// <summary>The leader saved: the others learn the new revision (so a later save by one of them does not look like a conflict).</summary>
    public async Task DocSaved(Guid documentId, int revision)
    {
        if (RoomOf(documentId, out var tenant) is null) return;
        await Clients.OthersInGroup(DocRooms.Group(tenant, documentId)).SendAsync("docSaved", new { documentId, revision, by = Context.Items[NameKey] as string });
    }

    public async Task DocLeave(Guid documentId)
    {
        if (RoomOf(documentId, out var tenant) is not { } room) return;
        await LeaveAsync(room, tenant, documentId);
    }

    private async Task LeaveAsync(DocRoom room, Guid tenant, Guid documentId)
    {
        bool empty;
        lock (room.Gate)
        {
            room.Peers.Remove(Context.ConnectionId);
            empty = room.Peers.Count == 0;
        }
        MyDocs().Remove(documentId);
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, DocRooms.Group(tenant, documentId));
        if (empty) DocRooms.Rooms.TryRemove(DocRooms.Key(tenant, documentId), out _);
        else await Clients.Group(DocRooms.Group(tenant, documentId)).SendAsync("docPeers", new { documentId, room = PeersOf(room), left = Context.ConnectionId });
    }

    private async Task LeaveAllDocumentsAsync()
    {
        if (Context.Items[TenantKey] is not Guid tenant || Context.Items[DocsKey] is not HashSet<Guid> docs) return;
        foreach (var d in docs.ToList())
            if (DocRooms.Rooms.TryGetValue(DocRooms.Key(tenant, d), out var room)) await LeaveAsync(room, tenant, d);
    }
}
