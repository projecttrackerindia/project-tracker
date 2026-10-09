using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Common;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Files;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Chat;

public partial class ChatService
{
    // ------------------------------------------------------------------ people

    public async Task<IReadOnlyList<ChatPersonDto>> PeopleAsync(CancellationToken ct = default)
    {
        var (tenant, me) = Require();
        var rows = await Eligible(tenant).Where(m => m.UserId != me).OrderBy(m => m.User!.DisplayName)
            .Select(m => new { m.UserId, m.User!.DisplayName, m.User.Email, HasAvatar = m.User.AvatarKey != null }).ToListAsync(ct);
        return rows.Select(r => new ChatPersonDto(r.UserId, r.DisplayName, r.Email, presence.IsOnline(tenant, r.UserId), r.HasAvatar)).ToList();
    }

    // ------------------------------------------------------------------ conversations

    public async Task<IReadOnlyList<ConversationDto>> ListAsync(CancellationToken ct = default)
    {
        var (_, me) = Require();
        // A chat someone else opened with me stays out of sight until they actually write; a group is always visible.
        var ids = await (from m in db.ConversationMembers.AsNoTracking()
                         join c in db.Conversations.AsNoTracking() on m.ConversationId equals c.Id
                         where m.UserId == me && c.Type != ConversationType.Project && (c.Type == ConversationType.Group || c.LastMessageId != null || c.CreatedBy == me)
                         orderby c.LastMessageAt descending
                         select c.Id).Take(300).ToListAsync(ct);
        var built = await BuildAsync(me, ids, ct);
        return ids.Select(id => built[id]).ToList();
    }

    public async Task<ConversationDto> GetAsync(Guid id, CancellationToken ct = default)
    {
        var (_, me) = Require();
        await MembershipAsync(id, me, ct);
        return (await BuildAsync(me, [id], ct))[id];
    }

    private async Task<Dictionary<Guid, ConversationDto>> BuildAsync(Guid me, IReadOnlyList<Guid> ids, CancellationToken ct)
    {
        var tenant = ctx.RequireTenantId();
        var conversations = await db.Conversations.AsNoTracking().Where(c => ids.Contains(c.Id)).ToListAsync(ct);
        var members = await db.ConversationMembers.AsNoTracking().Where(m => ids.Contains(m.ConversationId))
            .Select(m => new { m.ConversationId, m.UserId, Name = m.User!.DisplayName, m.Role, m.LastReadAt, m.IsMuted, m.CreatedAt, HasAvatar = m.User.AvatarKey != null }).ToListAsync(ct);

        // How many messages from other people I have not read, per conversation, in one query.
        var unread = await (from msg in db.ChatMessages.AsNoTracking()
                            join m in db.ConversationMembers.AsNoTracking() on msg.ConversationId equals m.ConversationId
                            where ids.Contains(msg.ConversationId) && m.UserId == me && msg.CreatedAt > m.LastReadAt && msg.CreatedAt >= m.CreatedAt
                                  && msg.Kind == ChatMessageKind.User && msg.SenderId != me && msg.DeletedAt == null
                            group msg by msg.ConversationId into g
                            select new { g.Key, Count = g.Count() }).ToDictionaryAsync(x => x.Key, x => x.Count, ct);

        // Unread messages that mention me (project chats only).
        var mine0 = members.Where(m => m.UserId == me).ToDictionary(m => m.ConversationId, m => m.LastReadAt);
        var mentionUnread = new Dictionary<Guid, int>();
        if (mine0.Count > 0)
        {
            var since = mine0.Values.Min();
            var hits = await (from mn in db.ChatMentions.AsNoTracking()
                              join msg in db.ChatMessages.AsNoTracking() on mn.MessageId equals msg.Id
                              where mn.UserId == me && ids.Contains(mn.ConversationId) && msg.DeletedAt == null && msg.CreatedAt > since && msg.SenderId != me
                              select new { mn.ConversationId, msg.CreatedAt }).ToListAsync(ct);
            foreach (var h in hits.Where(h => mine0.TryGetValue(h.ConversationId, out var read) && h.CreatedAt > read))
                mentionUnread[h.ConversationId] = mentionUnread.GetValueOrDefault(h.ConversationId) + 1;
        }

        var senderIds = conversations.Where(c => c.LastMessageSenderId != null).Select(c => c.LastMessageSenderId!.Value).Distinct().ToList();
        var senderNames = await db.Users.AsNoTracking().Where(u => senderIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);

        var result = new Dictionary<Guid, ConversationDto>();
        foreach (var c in conversations)
        {
            var mine = members.First(m => m.ConversationId == c.Id && m.UserId == me);
            var others = members.Where(m => m.ConversationId == c.Id).ToList();
            var other = c.Type == ConversationType.Direct ? others.FirstOrDefault(m => m.UserId != me) : null;
            var name = c.Type == ConversationType.Group ? c.Name ?? "Group" : c.Type == ConversationType.Project ? c.Name ?? "Project chat" : other?.Name ?? "Former member";
            ChatLastMessageDto? last = c.LastMessageId is { } lastId
                ? new ChatLastMessageDto(lastId, c.LastMessageSenderId is { } s ? senderNames.GetValueOrDefault(s) : null, c.LastMessageSnippet ?? "", c.LastMessageAt,
                    c.LastMessageSenderId == me, c.LastMessageSenderId is null)
                : null;
            result[c.Id] = new ConversationDto(c.Id, c.Type, name,
                others.OrderBy(m => m.Name).Select(m => new ChatMemberDto(m.UserId, m.Name, m.Role, m.LastReadAt, presence.IsOnline(tenant, m.UserId), m.HasAvatar)).ToList(),
                last, unread.GetValueOrDefault(c.Id), mine.IsMuted,
                CanModerate(c.Type, mine.Role), other?.UserId, c.LastMessageAt, c.ProjectId, mentionUnread.GetValueOrDefault(c.Id));
        }
        return result;
    }

    public async Task<ConversationDto> OpenDirectAsync(OpenDirectRequest req, CancellationToken ct = default)
    {
        var (tenant, me) = Require();
        if (req.UserId == me) throw new ValidationException("userId", "You cannot start a chat with yourself.");
        if (!await Eligible(tenant).AnyAsync(m => m.UserId == req.UserId, ct))
            throw new ValidationException("userId", "This person cannot be messaged.");

        var key = me.CompareTo(req.UserId) < 0 ? $"{me:N}:{req.UserId:N}" : $"{req.UserId:N}:{me:N}";
        var existing = await db.Conversations.AsNoTracking().Where(c => c.DirectKey == key).Select(c => (Guid?)c.Id).FirstOrDefaultAsync(ct);
        if (existing is null)
        {
            var now = clock.Now;
            var conv = new Conversation { Type = ConversationType.Direct, DirectKey = key, LastMessageAt = now };
            db.Conversations.Add(conv);
            db.ConversationMembers.Add(new ConversationMember { ConversationId = conv.Id, UserId = me, LastReadAt = now });
            db.ConversationMembers.Add(new ConversationMember { ConversationId = conv.Id, UserId = req.UserId, LastReadAt = now });
            try { await db.SaveChangesAsync(ct); existing = conv.Id; }
            catch (DbUpdateException)   // both people opened the chat at the same moment: the other one won, use theirs
            {
                existing = await db.Conversations.AsNoTracking().Where(c => c.DirectKey == key).Select(c => (Guid?)c.Id).FirstOrDefaultAsync(ct)
                    ?? throw new ConflictException("The chat could not be created. Try again.");
            }
        }
        return (await BuildAsync(me, [existing.Value], ct))[existing.Value];
    }

    // ------------------------------------------------------------------ project chats (opened from a project)

    /// <summary>
    /// The team chat of a project, created the first time anyone opens it. Open to the project's team, its owner and the organization's Owners,
    /// Admins and Managers; anyone else gets the same "not found" as for a project they cannot see.
    /// </summary>
    public async Task<ConversationDto> OpenProjectAsync(Guid projectId, CancellationToken ct = default)
    {
        var (tenant, me) = Require();
        var (name, _) = await RequireProjectChatAccessAsync(tenant, me, projectId, ct);
        var conv = await db.Conversations.FirstOrDefaultAsync(c => c.ProjectId == projectId, ct);
        if (conv is null)
        {
            var now = clock.Now;
            conv = new Conversation { Type = ConversationType.Project, ProjectId = projectId, Name = name, LastMessageAt = now, CreatedAt = now };
            db.Conversations.Add(conv);
            try { await db.SaveChangesAsync(ct); }
            catch (DbUpdateException)   // two people opened it for the first time together: use the one that won
            {
                db.Conversations.Remove(conv);   // forget the one that did not get saved
                conv = await db.Conversations.FirstOrDefaultAsync(c => c.ProjectId == projectId, ct) ?? throw new ConflictException("The chat could not be opened. Try again.");
            }
        }
        else if (conv.Name != name) { conv.Name = name; await db.SaveChangesAsync(ct); }   // the project was renamed
        await SyncProjectMembersAsync(tenant, conv, ct);
        return (await BuildAsync(me, [conv.Id], ct))[conv.Id];
    }

    /// <summary>
    /// Posts a Google Meet card into a project's chat (spec section 7), only when that chat has actually been opened before - nothing is
    /// created just to hold a card nobody would ever see. Called by MeetingService after scheduling or cancelling a meeting; the card's
    /// Body is JSON, not text (see ChatMessageKind.Meeting and the frontend's Thread.tsx rendering of it), so it is never shown as a
    /// Google OAuth token or anything else from the connection - only the meeting's own public details.
    /// </summary>
    public async Task PostMeetingCardAsync(Guid projectId, object card, string snippetText, CancellationToken ct = default)
    {
        var tenant = ctx.RequireTenantId();
        var conv = await db.Conversations.FirstOrDefaultAsync(c => c.ProjectId == projectId && c.Type == ConversationType.Project, ct);
        if (conv is null) return;
        var now = clock.Now;
        // camelCase to match every other JSON this API ever sends - the default (PascalCase) would silently break the frontend's
        // JSON.parse(body) of this card, since nothing else about a "Meeting" message distinguishes it as different from the rest of the API.
        var line = new ChatMessage { ConversationId = conv.Id, Kind = ChatMessageKind.Meeting, Body = JsonSerializer.Serialize(card, new JsonSerializerOptions(JsonSerializerDefaults.Web)) };
        db.ChatMessages.Add(line);
        conv.LastMessageAt = now; conv.LastMessageId = line.Id; conv.LastMessageSenderId = null; conv.LastMessageSnippet = Snippet(snippetText);
        await db.SaveChangesAsync(ct);
        await AnnounceAsync(tenant, conv, line, [], ct);
    }

    /// <summary>For each project whose chat has news for the caller: how many messages they have not read, and how many of them mention them.</summary>
    public async Task<IReadOnlyList<ProjectChatUnreadDto>> ProjectUnreadAsync(CancellationToken ct = default)
    {
        var (_, me) = Require();
        if (await permissions.LevelAsync(Modules.Projects, ct) < AccessLevel.View) return [];
        // Only projects the caller may still chat in (a person taken off a project keeps an old read-state row until the next visit).
        var oversee = ctx.Role is TenantRole.Owner or TenantRole.Admin or TenantRole.Manager;
        var projects = oversee ? db.Projects.Select(p => p.Id) : db.Projects.Where(p => p.OwnerId == me || db.ProjectMembers.Any(pm => pm.ProjectId == p.Id && pm.UserId == me)).Select(p => p.Id);
        var rows = await (from m in db.ConversationMembers.AsNoTracking()
                          join c in db.Conversations.AsNoTracking() on m.ConversationId equals c.Id
                          where m.UserId == me && c.Type == ConversationType.Project && c.ProjectId != null && projects.Contains(c.ProjectId.Value)
                          select new { ConversationId = c.Id, ProjectId = c.ProjectId!.Value }).ToListAsync(ct);
        if (rows.Count == 0) return [];
        var ids = rows.Select(r => r.ConversationId).ToList();

        var unread = await (from msg in db.ChatMessages.AsNoTracking()
                            join m in db.ConversationMembers.AsNoTracking() on msg.ConversationId equals m.ConversationId
                            where m.UserId == me && ids.Contains(msg.ConversationId) && msg.CreatedAt > m.LastReadAt
                                  && msg.Kind == ChatMessageKind.User && msg.SenderId != me && msg.DeletedAt == null
                            group msg by msg.ConversationId into g
                            select new { g.Key, Count = g.Count() }).ToDictionaryAsync(x => x.Key, x => x.Count, ct);
        var mentions = await (from mn in db.ChatMentions.AsNoTracking()
                              join msg in db.ChatMessages.AsNoTracking() on mn.MessageId equals msg.Id
                              join m in db.ConversationMembers.AsNoTracking() on mn.ConversationId equals m.ConversationId
                              where mn.UserId == me && m.UserId == me && ids.Contains(mn.ConversationId) && msg.CreatedAt > m.LastReadAt
                                    && msg.DeletedAt == null && msg.SenderId != me
                              group mn by mn.ConversationId into g
                              select new { g.Key, Count = g.Count() }).ToDictionaryAsync(x => x.Key, x => x.Count, ct);
        return rows.Where(r => unread.GetValueOrDefault(r.ConversationId) > 0)
            .Select(r => new ProjectChatUnreadDto(r.ProjectId, r.ConversationId, unread[r.ConversationId], mentions.GetValueOrDefault(r.ConversationId))).ToList();
    }
}
