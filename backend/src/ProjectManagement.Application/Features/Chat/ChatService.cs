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

/// <summary>Pushes an event to the open browser tabs of some people in one workspace. It never throws: chat still works (by refreshing) when a push fails.</summary>
public interface IChatNotifier
{
    Task ToUsersAsync(Guid tenantId, IEnumerable<Guid> userIds, string eventName, object payload, CancellationToken ct = default);
}

/// <summary>Who currently has the app open.</summary>
public interface IChatPresence
{
    bool IsOnline(Guid tenantId, Guid userId);
}

public static class ChatEvents
{
    public const string Message = "message";
    public const string MessageUpdated = "message.updated";
    public const string Conversation = "conversation";
    public const string Read = "read";
    /// <summary>A notification (for the bell) was just created for this person, so they can look at it straight away.</summary>
    public const string Notification = "notification";
}

public record ChatPersonDto(Guid UserId, string Name, string Email, bool Online, bool HasAvatar = false);
public record ChatMemberDto(Guid UserId, string Name, ConversationRole Role, DateTime LastReadAt, bool Online, bool HasAvatar = false);
public record ChatLastMessageDto(Guid Id, string? SenderName, string Snippet, DateTime At, bool IsMine, bool IsSystem);
public record ConversationDto(Guid Id, ConversationType Type, string Name, IReadOnlyList<ChatMemberDto> Members, ChatLastMessageDto? LastMessage,
    int Unread, bool IsMuted, bool CanManage, Guid? OtherUserId, DateTime LastActivityAt, Guid? ProjectId = null, int UnreadMentions = 0);
/// <summary>How much of a project's team chat the caller has not read, and how many of those messages @mention them.</summary>
public record ProjectChatUnreadDto(Guid ProjectId, Guid ConversationId, int Unread, int Mentions);
public record ReplyPreviewDto(Guid Id, string? SenderName, string Snippet, bool IsDeleted);
public record ChatAttachmentDto(Guid Id, string FileName, string ContentType, long SizeBytes, bool IsImage);
public record ChatReactionDto(string Emoji, int Count, bool Mine, IReadOnlyList<string> Names);
public record ChatMessageDto(Guid Id, Guid ConversationId, Guid? SenderId, string? SenderName, ChatMessageKind Kind, string Body,
    ReplyPreviewDto? ReplyTo, DateTime CreatedAt, DateTime? EditedAt, bool IsDeleted,
    IReadOnlyList<ChatAttachmentDto>? Attachments = null, IReadOnlyList<ChatReactionDto>? Reactions = null);
public record MessagePageDto(IReadOnlyList<ChatMessageDto> Items, bool HasMore);
public record ChatFileDto(Guid Id, string FileName, string ContentType, long SizeBytes, bool IsImage, Guid MessageId, Guid? SenderId, string SenderName, DateTime CreatedAt);
public record ChatFilePageDto(IReadOnlyList<ChatFileDto> Items, bool HasMore);
public record ChatSearchHitDto(Guid MessageId, Guid ConversationId, string ConversationName, string? SenderName, string Snippet, DateTime At);
public record UnreadDto(int Count);

public record OpenDirectRequest(Guid UserId);
public record CreateGroupRequest(string Name, IReadOnlyList<Guid>? MemberIds);
public record RenameGroupRequest(string Name);
public record AddMembersRequest(IReadOnlyList<Guid>? UserIds);
public record SendMessageRequest(string? Body, Guid? ReplyToId, IReadOnlyList<Guid>? AttachmentIds = null);
public record ReactRequest(string? Emoji);
public record EditMessageRequest(string? Body);
public record MuteRequest(bool Muted);

/// <summary>
/// Chat inside a workspace: private chats between two people and named groups. Sending, editing and every other change go through
/// here (so the rules are checked in one place); the live hub only carries the news to open browser tabs.
/// </summary>
public class ChatService(IAppDbContext db, ICurrentContext ctx, AppClock clock, IChatNotifier notifier, IChatPresence presence, PermissionService permissions,
    NotificationService notifications, AttachmentService files, IFileStorage storage, EntitlementService entitlements, ILogger<ChatService> log)
{
    public const int MaxBody = 4000;
    public const int MaxGroupMembers = 50;
    public const int MaxFilesPerMessage = 5;
    /// <summary>The reactions on offer: a small, workplace-friendly set (a free-form emoji field is a spam and layout risk).</summary>
    public static readonly string[] Reactions = ["👍", "❤️", "😂", "🎉", "🙏", "👀", "✅", "🚀"];
    private const int PageSize = 40;

    // ------------------------------------------------------------------ who may chat

    private (Guid Tenant, Guid Me) Require()
    {
        var tenant = ctx.RequireTenantId();
        var me = ctx.RequireUserId();
        if (ctx.WorkspaceType == WorkspaceType.Personal)
            throw new ForbiddenException("Chat is available in organization workspaces, where there are other people to talk to.", "CHAT_NOT_AVAILABLE");
        if (ctx.Role == TenantRole.Guest)
            throw new ForbiddenException("Guests cannot use chat.", "CHAT_NOT_AVAILABLE");
        return (tenant, me);
    }

    /// <summary>Active members of this workspace who may use chat (everyone except guests).</summary>
    private IQueryable<TenantMember> Eligible(Guid tenant) =>
        db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tenant && m.Role != TenantRole.Guest && m.User!.IsActive);

    private static NotFoundException NoConversation() => new("This conversation was not found.", "CONVERSATION_NOT_FOUND");   // the same answer whether it exists or not

    private async Task<ConversationMember> MembershipAsync(Guid conversationId, Guid me, CancellationToken ct)
    {
        var conv = await db.Conversations.AsNoTracking().Where(c => c.Id == conversationId).Select(c => new { c.Type, c.ProjectId, c.CreatedAt }).FirstOrDefaultAsync(ct);
        if (conv is null) throw NoConversation();
        if (conv.Type == ConversationType.Project) return await ProjectMembershipAsync(conversationId, conv.ProjectId, conv.CreatedAt, me, ct);
        return await db.ConversationMembers.FirstOrDefaultAsync(m => m.ConversationId == conversationId && m.UserId == me, ct) ?? throw NoConversation();
    }

    // ------------------------------------------------------------------ project chats
    // A project's chat is for the people working on it: its team members, the project owner and the organization's Owners, Admins and Managers.
    // That is worked out from the project every time (nobody is "added" to it), so a person who leaves the project or is demoted loses access at once.
    // Guests are never in it, like in every other chat. The member rows only remember who has read what.

    private const string ProjectChatMissing = "This project chat was not found.";

    /// <summary>Everyone who may use the chat of this project.</summary>
    private async Task<HashSet<Guid>> ProjectAudienceAsync(Guid tenant, Guid projectId, CancellationToken ct)
    {
        var teamIds = await db.ProjectMembers.AsNoTracking().Where(m => m.ProjectId == projectId).Select(m => m.UserId).ToListAsync(ct);
        var ownerId = await db.Projects.AsNoTracking().Where(p => p.Id == projectId).Select(p => (Guid?)p.OwnerId).FirstOrDefaultAsync(ct);
        var ids = await Eligible(tenant)
            .Where(m => m.Role == TenantRole.Owner || m.Role == TenantRole.Admin || m.Role == TenantRole.Manager || teamIds.Contains(m.UserId) || m.UserId == ownerId)
            .Select(m => m.UserId).ToListAsync(ct);
        return ids.ToHashSet();
    }

    /// <summary>The project and whether the caller may use its chat; NotFound (the same answer as for a project that does not exist) when not.</summary>
    private async Task<(string Name, ProjectStatus Status)> RequireProjectChatAccessAsync(Guid tenant, Guid me, Guid projectId, CancellationToken ct)
    {
        await permissions.RequireModuleAsync(Modules.Projects, AccessLevel.View, ct);
        var project = await db.Projects.AsNoTracking().Where(p => p.Id == projectId).Select(p => new { p.Name, p.Status }).FirstOrDefaultAsync(ct)
            ?? throw new NotFoundException(ProjectChatMissing, "CONVERSATION_NOT_FOUND");
        if (!(await ProjectAudienceAsync(tenant, projectId, ct)).Contains(me)) throw new NotFoundException(ProjectChatMissing, "CONVERSATION_NOT_FOUND");
        return (project.Name, project.Status);
    }

    private async Task<ConversationMember> ProjectMembershipAsync(Guid conversationId, Guid? projectId, DateTime chatCreatedAt, Guid me, CancellationToken ct)
    {
        if (projectId is not { } pid) throw NoConversation();
        var tenant = ctx.RequireTenantId();
        try { await RequireProjectChatAccessAsync(tenant, me, pid, ct); }
        catch (NotFoundException) { throw NoConversation(); }
        var row = await db.ConversationMembers.FirstOrDefaultAsync(m => m.ConversationId == conversationId && m.UserId == me, ct);
        if (row is not null) return row;
        // First visit: everything said so far counts as read, and the whole history is visible (it is the project's, not the person's).
        row = new ConversationMember { ConversationId = conversationId, UserId = me, LastReadAt = clock.Now, CreatedAt = chatCreatedAt };
        db.ConversationMembers.Add(row);
        await db.SaveChangesAsync(ct);
        return row;
    }

    /// <summary>Brings the read-state rows in line with the project's people: everyone who may use the chat has one, nobody else does. Returns those people.</summary>
    private async Task<HashSet<Guid>> SyncProjectMembersAsync(Guid tenant, Conversation conv, CancellationToken ct)
    {
        var audience = await ProjectAudienceAsync(tenant, conv.ProjectId!.Value, ct);
        var rows = await db.ConversationMembers.Where(m => m.ConversationId == conv.Id).ToListAsync(ct);
        var now = clock.Now;
        var changed = false;
        var added = new List<ConversationMember>();
        foreach (var id in audience.Where(a => rows.All(r => r.UserId != a)))
        {
            var row = new ConversationMember { ConversationId = conv.Id, UserId = id, LastReadAt = now, CreatedAt = conv.CreatedAt };
            db.ConversationMembers.Add(row);
            added.Add(row);
            changed = true;
        }
        foreach (var stale in rows.Where(r => !audience.Contains(r.UserId))) { db.ConversationMembers.Remove(stale); changed = true; }
        if (!changed) return audience;
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateException ex)   // two requests added the same row at the same moment: the other one won, which is fine
        {
            log.LogInformation(ex, "Project chat members were synced concurrently");
            foreach (var a in added) db.ConversationMembers.Remove(a);   // forget the rows that did not get saved
        }
        return audience;
    }

    private bool CanModerate(ConversationType type, ConversationRole role) =>
        type == ConversationType.Group ? role == ConversationRole.Admin : type == ConversationType.Project && ctx.Role is TenantRole.Owner or TenantRole.Admin;

    // Formatting is written as light markup in the text: **bold**, *italic*, __underline__. Previews show the words, not the symbols.
    // (Same rules as the web app's renderer: the marks must hug the text and not sit inside a word.)
    private static readonly Regex Bold = new(@"(?<![\w*])\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*(?![\w*])", RegexOptions.Compiled);
    private static readonly Regex Underline = new(@"(?<![\w_])__(?=\S)([\s\S]+?)(?<=\S)__(?![\w_])", RegexOptions.Compiled);
    private static readonly Regex Italic = new(@"(?<![\w*])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?![\w*])", RegexOptions.Compiled);

    // A mention is written into the text as @[Name](user id). Previews and the server's own checks read it as @Name.
    private static readonly Regex MentionToken = new(@"@\[([^\]\n]{1,100})\]\(([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)", RegexOptions.Compiled);

    private static string Snippet(string body)
    {
        var plain = Italic.Replace(Underline.Replace(Bold.Replace(MentionToken.Replace(body, "@$1"), "$1"), "$1"), "$1");
        var flat = string.Join(' ', plain.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        if (flat.Length <= 140) return flat;
        var cut = 139;
        if (char.IsHighSurrogate(flat[cut - 1])) cut--;   // never cut an emoji in half
        return flat[..cut] + "…";
    }

    private static string CleanBody(string? body)
    {
        var text = (body ?? "").Replace("\r\n", "\n").Trim();
        if (text.Length == 0) throw new ValidationException("body", "Write a message first.");
        if (text.Length > MaxBody) throw new ValidationException("body", $"A message can be at most {MaxBody} characters.");
        return text;
    }

    private static string CleanGroupName(string? name)
    {
        var n = (name ?? "").Trim();
        if (n.Length < 2 || n.Length > 60) throw new ValidationException("name", "A group name needs 2 to 60 characters.");
        return n;
    }

    // ------------------------------------------------------------------ pushing the news

    /// <summary>Everyone in the conversation who can still use chat here. A person removed from the workspace stops receiving at once.</summary>
    private async Task<List<Guid>> RecipientsAsync(Guid tenant, Guid conversationId, CancellationToken ct)
    {
        var project = await db.Conversations.AsNoTracking().Where(c => c.Id == conversationId && c.Type == ConversationType.Project).Select(c => c.ProjectId).FirstOrDefaultAsync(ct);
        if (project is { } pid) return (await ProjectAudienceAsync(tenant, pid, ct)).ToList();
        var ids = await db.ConversationMembers.AsNoTracking().Where(m => m.ConversationId == conversationId).Select(m => m.UserId).ToListAsync(ct);
        return await Eligible(tenant).Where(m => ids.Contains(m.UserId)).Select(m => m.UserId).ToListAsync(ct);
    }

    private async Task PushAsync(Guid tenant, IEnumerable<Guid> to, string name, object payload, CancellationToken ct)
    {
        try { await notifier.ToUsersAsync(tenant, to, name, payload, ct); }
        catch (Exception ex) when (ex is not OperationCanceledException) { log.LogWarning(ex, "Chat push {Event} failed", name); }
    }

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

    // ------------------------------------------------------------------ groups

    private async Task<string> NameOfAsync(Guid userId, CancellationToken ct) =>
        await db.Users.AsNoTracking().Where(u => u.Id == userId).Select(u => u.DisplayName).FirstOrDefaultAsync(ct) ?? "Someone";

    private async Task<Conversation> GroupAsync(Guid id, CancellationToken ct)
    {
        var conv = await db.Conversations.FirstOrDefaultAsync(c => c.Id == id, ct) ?? throw new NotFoundException("This conversation was not found.", "CONVERSATION_NOT_FOUND");
        if (conv.Type != ConversationType.Group) throw new ValidationException("id", "Only a named group can be changed like this.");
        return conv;
    }

    private static void RequireGroupAdmin(ConversationMember mine)
    {
        if (mine.Role != ConversationRole.Admin) throw new ForbiddenException("Only a group admin can do this.", "GROUP_ADMIN_REQUIRED");
    }

    /// <summary>Adds a "Priya joined" style line to the thread.</summary>
    private ChatMessage AddSystemLine(Conversation conv, string text, DateTime now)
    {
        var line = new ChatMessage { ConversationId = conv.Id, Kind = ChatMessageKind.System, Body = text };
        db.ChatMessages.Add(line);
        conv.LastMessageAt = now; conv.LastMessageId = line.Id; conv.LastMessageSenderId = null; conv.LastMessageSnippet = Snippet(text);
        return line;
    }

    private async Task AnnounceAsync(Guid tenant, Conversation conv, ChatMessage line, IEnumerable<Guid> extraRecipients, CancellationToken ct)
    {
        var to = (await RecipientsAsync(tenant, conv.Id, ct)).Concat(extraRecipients).Distinct().ToList();
        var dto = (await ToDtosAsync([line], ct))[0];
        await PushAsync(tenant, to, ChatEvents.Message, new { conversationId = conv.Id, message = dto }, ct);
        await PushAsync(tenant, to, ChatEvents.Conversation, new { conversationId = conv.Id }, ct);
    }

    public async Task<ConversationDto> CreateGroupAsync(CreateGroupRequest req, CancellationToken ct = default)
    {
        var (tenant, me) = Require();
        var name = CleanGroupName(req.Name);
        var others = (req.MemberIds ?? []).Where(id => id != me).Distinct().ToList();
        if (others.Count == 0) throw new ValidationException("memberIds", "Add at least one other person.");
        if (others.Count + 1 > MaxGroupMembers) throw new ValidationException("memberIds", $"A group can have at most {MaxGroupMembers} people.");
        if (await Eligible(tenant).CountAsync(m => others.Contains(m.UserId), ct) != others.Count)
            throw new ValidationException("memberIds", "Some of these people cannot be added to a group.");

        var now = clock.Now;
        var conv = new Conversation { Type = ConversationType.Group, Name = name, LastMessageAt = now };
        db.Conversations.Add(conv);
        db.ConversationMembers.Add(new ConversationMember { ConversationId = conv.Id, UserId = me, Role = ConversationRole.Admin, LastReadAt = now });
        foreach (var id in others) db.ConversationMembers.Add(new ConversationMember { ConversationId = conv.Id, UserId = id, LastReadAt = now });
        var line = AddSystemLine(conv, $"{await NameOfAsync(me, ct)} created the group “{name}”", now);
        await db.SaveChangesAsync(ct);

        await AnnounceAsync(tenant, conv, line, [], ct);
        return (await BuildAsync(me, [conv.Id], ct))[conv.Id];
    }

    public async Task<ConversationDto> RenameAsync(Guid id, RenameGroupRequest req, CancellationToken ct = default)
    {
        var (tenant, me) = Require();
        var mine = await MembershipAsync(id, me, ct);
        var conv = await GroupAsync(id, ct);
        RequireGroupAdmin(mine);
        var name = CleanGroupName(req.Name);
        if (name == conv.Name) return (await BuildAsync(me, [id], ct))[id];

        conv.Name = name;
        var line = AddSystemLine(conv, $"{await NameOfAsync(me, ct)} renamed the group to “{name}”", clock.Now);
        await db.SaveChangesAsync(ct);
        await AnnounceAsync(tenant, conv, line, [], ct);
        return (await BuildAsync(me, [id], ct))[id];
    }

    public async Task<ConversationDto> AddMembersAsync(Guid id, AddMembersRequest req, CancellationToken ct = default)
    {
        var (tenant, me) = Require();
        var mine = await MembershipAsync(id, me, ct);
        var conv = await GroupAsync(id, ct);
        RequireGroupAdmin(mine);

        var wanted = (req.UserIds ?? []).Distinct().ToList();
        var current = await db.ConversationMembers.Where(m => m.ConversationId == id).Select(m => m.UserId).ToListAsync(ct);
        var adding = wanted.Where(u => !current.Contains(u)).ToList();
        if (adding.Count == 0) throw new ValidationException("userIds", "Choose at least one person who is not in the group yet.");
        if (current.Count + adding.Count > MaxGroupMembers) throw new ValidationException("userIds", $"A group can have at most {MaxGroupMembers} people.");
        if (await Eligible(tenant).CountAsync(m => adding.Contains(m.UserId), ct) != adding.Count)
            throw new ValidationException("userIds", "Some of these people cannot be added to a group.");

        var now = clock.Now;
        foreach (var u in adding) db.ConversationMembers.Add(new ConversationMember { ConversationId = id, UserId = u, LastReadAt = now });
        var names = await db.Users.AsNoTracking().Where(u => adding.Contains(u.Id)).OrderBy(u => u.DisplayName).Select(u => u.DisplayName).ToListAsync(ct);
        var line = AddSystemLine(conv, $"{await NameOfAsync(me, ct)} added {string.Join(", ", names)}", now);
        await db.SaveChangesAsync(ct);
        await AnnounceAsync(tenant, conv, line, [], ct);
        return (await BuildAsync(me, [id], ct))[id];
    }

    /// <summary>Removes someone from a group, or lets a person leave it (removing yourself). Returns nothing: the caller may no longer see the group.</summary>
    public async Task RemoveMemberAsync(Guid id, Guid userId, CancellationToken ct = default)
    {
        var (tenant, me) = Require();
        var mine = await MembershipAsync(id, me, ct);
        var conv = await GroupAsync(id, ct);
        if (userId != me) RequireGroupAdmin(mine);

        var target = await db.ConversationMembers.FirstOrDefaultAsync(m => m.ConversationId == id && m.UserId == userId, ct)
            ?? throw new NotFoundException("That person is not in this group.", "MEMBER_NOT_FOUND");
        var targetName = await NameOfAsync(userId, ct);
        db.ConversationMembers.Remove(target);
        await db.SaveChangesAsync(ct);

        var remaining = await db.ConversationMembers.Where(m => m.ConversationId == id).OrderBy(m => m.CreatedAt).ToListAsync(ct);
        if (remaining.Count == 0)
        {
            db.Conversations.Remove(conv);   // the last person left: nothing to keep
            await db.SaveChangesAsync(ct);
            await PushAsync(tenant, [userId], ChatEvents.Conversation, new { conversationId = id }, ct);
            return;
        }
        // A group is never left without someone who can manage it.
        if (!remaining.Any(m => m.Role == ConversationRole.Admin)) remaining[0].Role = ConversationRole.Admin;

        var line = AddSystemLine(conv, userId == me ? $"{targetName} left the group" : $"{await NameOfAsync(me, ct)} removed {targetName}", clock.Now);
        await db.SaveChangesAsync(ct);
        await AnnounceAsync(tenant, conv, line, [userId], ct);   // the removed person's list refreshes too
    }

    // ------------------------------------------------------------------ messages

    private async Task<List<ChatMessageDto>> ToDtosAsync(IReadOnlyList<ChatMessage> messages, CancellationToken ct)
    {
        var replyIds = messages.Where(m => m.ReplyToId != null).Select(m => m.ReplyToId!.Value).Distinct().ToList();
        var replies = replyIds.Count == 0 ? [] : await db.ChatMessages.AsNoTracking().Where(m => replyIds.Contains(m.Id))
            .Select(m => new { m.Id, m.SenderId, m.Body, m.DeletedAt }).ToListAsync(ct);
        var userIds = messages.Where(m => m.SenderId != null).Select(m => m.SenderId!.Value).Concat(replies.Where(r => r.SenderId != null).Select(r => r.SenderId!.Value)).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => userIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);

        var ids = messages.Select(m => m.Id).ToList();
        var me = ctx.UserId;
        var fileRows = await db.ChatAttachments.AsNoTracking().Where(a => a.MessageId != null && ids.Contains(a.MessageId.Value)).OrderBy(a => a.CreatedAt)
            .Select(a => new { a.Id, MessageId = a.MessageId!.Value, a.FileName, a.ContentType, a.SizeBytes }).ToListAsync(ct);
        var reactionRows = await db.ChatReactions.AsNoTracking().Where(r => ids.Contains(r.MessageId)).OrderBy(r => r.CreatedAt).Select(r => new { r.MessageId, r.UserId, r.Emoji }).ToListAsync(ct);
        var reactorNames = reactionRows.Count == 0 ? [] : await db.Users.AsNoTracking().Where(u => reactionRows.Select(r => r.UserId).Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);

        return messages.Select(m =>
        {
            var attachments = m.DeletedAt != null ? null : fileRows.Where(f => f.MessageId == m.Id).Select(f => new ChatAttachmentDto(f.Id, f.FileName, f.ContentType, f.SizeBytes, FileRules.IsImage(f.ContentType))).ToList();
            var reactions = m.DeletedAt != null ? null : reactionRows.Where(r => r.MessageId == m.Id).GroupBy(r => r.Emoji)
                .Select(g => new ChatReactionDto(g.Key, g.Count(), g.Any(r => r.UserId == me), g.Take(10).Select(r => reactorNames.GetValueOrDefault(r.UserId) ?? "Someone").ToList())).ToList();
            ReplyPreviewDto? reply = null;
            if (m.ReplyToId is { } rid)
            {
                var r = replies.FirstOrDefault(x => x.Id == rid);
                reply = r is null ? new ReplyPreviewDto(rid, null, "", true)
                    : new ReplyPreviewDto(r.Id, r.SenderId is { } s ? names.GetValueOrDefault(s) : null, r.DeletedAt is null ? Snippet(r.Body) : "", r.DeletedAt != null);
            }
            return new ChatMessageDto(m.Id, m.ConversationId, m.SenderId, m.SenderId is { } sid ? names.GetValueOrDefault(sid) : null, m.Kind,
                m.DeletedAt is null ? m.Body : "", reply, m.CreatedAt, m.EditedAt, m.DeletedAt != null,
                attachments is { Count: > 0 } ? attachments : null, reactions is { Count: > 0 } ? reactions : null);
        }).ToList();
    }

    public async Task<MessagePageDto> MessagesAsync(Guid conversationId, DateTime? before, int? limit, CancellationToken ct = default)
    {
        var (_, me) = Require();
        var mine = await MembershipAsync(conversationId, me, ct);
        var take = Math.Clamp(limit ?? PageSize, 1, 100);

        // A person sees what was said since they joined, not what was said before.
        var query = db.ChatMessages.AsNoTracking().Where(m => m.ConversationId == conversationId && m.CreatedAt >= mine.CreatedAt);
        if (before is { } b) query = query.Where(m => m.CreatedAt < b);
        var rows = await query.OrderByDescending(m => m.CreatedAt).ThenByDescending(m => m.Id).Take(take + 1).ToListAsync(ct);
        var hasMore = rows.Count > take;
        var page = rows.Take(take).Reverse().ToList();
        return new MessagePageDto(await ToDtosAsync(page, ct), hasMore);
    }

    /// <summary>Every file ever sent in a conversation, newest first - the "Files" view next to the thread, same membership rule as messages.</summary>
    public async Task<ChatFilePageDto> FilesAsync(Guid conversationId, DateTime? before, int? limit, CancellationToken ct = default)
    {
        var (_, me) = Require();
        var mine = await MembershipAsync(conversationId, me, ct);
        var take = Math.Clamp(limit ?? PageSize, 1, 100);

        var query = from a in db.ChatAttachments.AsNoTracking()
                    join m in db.ChatMessages.AsNoTracking() on a.MessageId equals m.Id
                    where a.ConversationId == conversationId && m.CreatedAt >= mine.CreatedAt && m.DeletedAt == null
                    select new { a.Id, a.FileName, a.ContentType, a.SizeBytes, a.CreatedAt, MessageId = m.Id, m.SenderId };
        if (before is { } b) query = query.Where(x => x.CreatedAt < b);
        var rows = await query.OrderByDescending(x => x.CreatedAt).ThenByDescending(x => x.Id).Take(take + 1).ToListAsync(ct);
        var hasMore = rows.Count > take;
        var page = rows.Take(take).ToList();
        var names = await db.Users.AsNoTracking().Where(u => page.Select(r => r.SenderId).Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        var items = page.Select(r => new ChatFileDto(r.Id, r.FileName, r.ContentType, r.SizeBytes, FileRules.IsImage(r.ContentType), r.MessageId, r.SenderId,
            r.SenderId is { } sid ? names.GetValueOrDefault(sid) ?? "Someone" : "Someone", r.CreatedAt)).ToList();
        return new ChatFilePageDto(items, hasMore);
    }

    /// <summary>Removes the characters that would break a mention's markup from a person's name.</summary>
    private static string MentionName(string name) => new(name.Where(c => c is not ('[' or ']' or '(' or ')') && !char.IsControl(c)).ToArray());

    /// <summary>
    /// Reads the @mentions of a message. A mention is written as @[Name](user id); only people in <paramref name="audience"/> count, and their name is
    /// taken from the database rather than from the browser. Anything else (a stranger's id, a mention in a private chat) is turned into plain "@Name".
    /// </summary>
    private async Task<(string Text, List<Guid> Mentioned)> ResolveMentionsAsync(string? body, HashSet<Guid>? audience, CancellationToken ct)
    {
        var text = body ?? "";
        if (!MentionToken.IsMatch(text)) return (text, []);
        var wanted = MentionToken.Matches(text).Select(m => Guid.Parse(m.Groups[2].Value)).Distinct().Where(id => audience?.Contains(id) == true).ToList();
        var names = wanted.Count == 0 ? [] : await db.Users.AsNoTracking().Where(u => wanted.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        var found = new List<Guid>();
        var normalized = MentionToken.Replace(text, m =>
        {
            var id = Guid.Parse(m.Groups[2].Value);
            if (!names.TryGetValue(id, out var name)) return "@" + m.Groups[1].Value;
            if (!found.Contains(id)) found.Add(id);
            return $"@[{MentionName(name)}]({id})";
        });
        return (normalized, found);
    }

    /// <summary>Tells the people who were @mentioned: a notification for the bell (and e-mail, if they chose that), and a live nudge to their open tabs.</summary>
    private async Task NotifyMentionsAsync(Guid tenant, Conversation conv, string projectName, string text, IEnumerable<Guid> people, CancellationToken ct)
    {
        var sender = await NameOfAsync(ctx.RequireUserId(), ct);
        var link = $"/projects/{conv.ProjectId}?chat=1";
        foreach (var u in people.Where(u => u != ctx.UserId))
            await notifications.AddAsync(u, NotificationType.Mention, $"{sender} mentioned you in {projectName}", Snippet(text), link, ct: ct);
    }

    public async Task<ChatMessageDto> SendAsync(Guid conversationId, SendMessageRequest req, CancellationToken ct = default)
    {
        var (tenant, me) = Require();
        var mine = await MembershipAsync(conversationId, me, ct);
        var conv = await db.Conversations.FirstAsync(c => c.Id == conversationId, ct);
        HashSet<Guid>? audience = null;
        var projectName = "";
        if (conv.Type == ConversationType.Project)
        {
            var (name, status) = await RequireProjectChatAccessAsync(tenant, me, conv.ProjectId!.Value, ct);
            if (status == ProjectStatus.Archived) throw new ConflictException("This project is archived, so its chat is read-only.", "PROJECT_ARCHIVED");
            projectName = name;
            audience = await SyncProjectMembersAsync(tenant, conv, ct);
        }
        var (normalized, mentioned) = await ResolveMentionsAsync(req.Body, audience, ct);
        // Files that were uploaded for this message: they must be the sender's own, in this conversation and not yet sent.
        var attachIds = (req.AttachmentIds ?? []).Distinct().ToList();
        if (attachIds.Count > MaxFilesPerMessage) throw new ValidationException("attachmentIds", $"A message can carry up to {MaxFilesPerMessage} files.");
        var attachRows = attachIds.Count == 0 ? [] : await db.ChatAttachments.Where(a => attachIds.Contains(a.Id) && a.ConversationId == conversationId && a.UploaderId == me && a.MessageId == null).ToListAsync(ct);
        if (attachRows.Count != attachIds.Count) throw new ValidationException("attachmentIds", "One of the files is no longer available. Add it again.");
        if (attachRows.Count > 0) await entitlements.EnsureFeatureAsync(FeatureKeys.ChatAttachments, ct);
        var text = attachRows.Count > 0 && string.IsNullOrWhiteSpace(normalized) ? "" : CleanBody(normalized);

        Guid? replyTo = null;
        if (req.ReplyToId is { } r)
        {
            if (!await db.ChatMessages.AnyAsync(m => m.Id == r && m.ConversationId == conversationId, ct))
                throw new ValidationException("replyToId", "The message you are replying to was not found.");
            replyTo = r;
        }

        if (conv.Type == ConversationType.Direct)
        {
            // A chat with someone who has left the workspace (or was deactivated) is history: it can be read but not added to.
            var other = await db.ConversationMembers.AsNoTracking().Where(m => m.ConversationId == conversationId && m.UserId != me).Select(m => (Guid?)m.UserId).FirstOrDefaultAsync(ct);
            if (other is null || !await Eligible(tenant).AnyAsync(m => m.UserId == other, ct))
                throw new ConflictException("This person is no longer in the workspace, so you cannot send them messages.", "CHAT_PARTNER_UNAVAILABLE");
        }
        var now = clock.Now;
        var msg = new ChatMessage { ConversationId = conversationId, SenderId = me, Kind = ChatMessageKind.User, Body = text, ReplyToId = replyTo };
        db.ChatMessages.Add(msg);
        var preview = text.Length > 0 ? text : attachRows.Count == 1 ? $"Sent a file: {attachRows[0].FileName}" : $"Sent {attachRows.Count} files";
        conv.LastMessageAt = now; conv.LastMessageId = msg.Id; conv.LastMessageSenderId = me; conv.LastMessageSnippet = Snippet(preview);
        mine.LastReadAt = now;   // writing means the sender has caught up
        foreach (var a in attachRows) a.MessageId = msg.Id;
        foreach (var u in mentioned) db.ChatMentions.Add(new ChatMention { MessageId = msg.Id, ConversationId = conversationId, UserId = u });
        if (mentioned.Count > 0) await NotifyMentionsAsync(tenant, conv, projectName, text, mentioned, ct);
        var to = audience?.ToList() ?? await RecipientsAsync(tenant, conversationId, ct);
        // Direct and group messages leave a notice for the people who are away from the conversation (project chats only do so for @mentions, above).
        var noticed = conv.Type == ConversationType.Project ? [] : await NotifyMessageAsync(conv, preview, to, ct);
        await db.SaveChangesAsync(ct);

        var dto = (await ToDtosAsync([msg], ct))[0];
        await PushAsync(tenant, to, ChatEvents.Message,
            new { conversationId, message = dto, projectId = conv.ProjectId, conversationName = conv.Type == ConversationType.Project ? projectName : null, mentioned }, ct);
        var nudge = mentioned.Concat(noticed).Where(u => u != me).Distinct().ToList();
        if (nudge.Count > 0) await PushAsync(tenant, nudge, ChatEvents.Notification, new { }, ct);
        return dto;
    }

    /// <summary>
    /// Leaves a notice in the bell of each person who has not read the conversation: one per conversation, kept up to date ("3 new messages") instead of one per
    /// message, and gone as soon as they read it. Muted conversations and people who chose to switch these off get nothing. Returns who has a (new or updated) notice.
    /// </summary>
    private async Task<List<Guid>> NotifyMessageAsync(Conversation conv, string preview, IEnumerable<Guid> recipients, CancellationToken ct)
    {
        var me = ctx.RequireUserId();
        var sender = await NameOfAsync(me, ct);
        var link = $"/chat/{conv.Id}";
        var title = conv.Type == ConversationType.Group ? $"{sender} in {conv.Name}" : sender;
        var members = await db.ConversationMembers.AsNoTracking().Where(m => m.ConversationId == conv.Id).Select(m => new { m.UserId, m.IsMuted, m.LastReadAt }).ToListAsync(ct);
        var now = clock.Now;
        var told = new List<Guid>();
        foreach (var u in recipients.Where(u => u != me))
        {
            var mem = members.FirstOrDefault(m => m.UserId == u);
            if (mem is null || mem.IsMuted) continue;
            var unread = await db.ChatMessages.CountAsync(m => m.ConversationId == conv.Id && m.CreatedAt > mem.LastReadAt && m.SenderId != u && m.Kind == ChatMessageKind.User && m.DeletedAt == null, ct) + 1;
            var body = unread <= 1 ? Snippet(preview) : $"{unread} new messages. Latest: {Snippet(preview)}";
            var existing = await db.Notifications.FirstOrDefaultAsync(n => n.UserId == u && n.Type == NotificationType.Message && n.Link == link && n.ReadAt == null, ct);
            if (existing is not null)
            {
                if (!await notifications.WantsInAppAsync(u, NotificationType.Message, ct)) continue;   // they have since switched these off: leave it as it was
                existing.Title = Text.Truncate(title, 200)!; existing.Body = Text.Truncate(body, 500); existing.CreatedAt = now;
                told.Add(u);
            }
            else
            {
                await notifications.AddAsync(u, NotificationType.Message, title, body, link, ct: ct);
                told.Add(u);
            }
        }
        return told;
    }

    public async Task<ChatMessageDto> EditAsync(Guid messageId, EditMessageRequest req, CancellationToken ct = default)
    {
        var (tenant, me) = Require();
        var msg = await db.ChatMessages.FirstOrDefaultAsync(m => m.Id == messageId, ct) ?? throw new NotFoundException("This message was not found.", "MESSAGE_NOT_FOUND");
        await MembershipAsync(msg.ConversationId, me, ct);
        if (msg.SenderId != me || msg.Kind != ChatMessageKind.User) throw new ForbiddenException("You can only edit your own messages.", "MESSAGE_NOT_YOURS");
        if (msg.DeletedAt != null) throw new ConflictException("This message was deleted.", "MESSAGE_DELETED");

        var conv = await db.Conversations.FirstAsync(c => c.Id == msg.ConversationId, ct);
        var audience = conv.Type == ConversationType.Project ? await ProjectAudienceAsync(tenant, conv.ProjectId!.Value, ct) : null;
        var (normalized, mentioned) = await ResolveMentionsAsync(req.Body, audience, ct);
        var text = CleanBody(normalized);
        if (text == msg.Body) return (await ToDtosAsync([msg], ct))[0];
        msg.Body = text; msg.EditedAt = clock.Now;
        if (conv.LastMessageId == msg.Id) conv.LastMessageSnippet = Snippet(text);
        if (conv.Type == ConversationType.Project)
        {
            // Who is mentioned follows the new text; only people who were not mentioned before are told.
            var before = await db.ChatMentions.Where(x => x.MessageId == msg.Id).ToListAsync(ct);
            db.ChatMentions.RemoveRange(before.Where(b => !mentioned.Contains(b.UserId)));
            var added = mentioned.Where(u => before.All(b => b.UserId != u)).ToList();
            foreach (var u in added) db.ChatMentions.Add(new ChatMention { MessageId = msg.Id, ConversationId = conv.Id, UserId = u });
            if (added.Count > 0)
            {
                var projectName = await db.Projects.AsNoTracking().Where(p => p.Id == conv.ProjectId).Select(p => p.Name).FirstOrDefaultAsync(ct) ?? "a project";
                await NotifyMentionsAsync(tenant, conv, projectName, text, added, ct);
                await PushAsync(tenant, added.Where(u => u != me), ChatEvents.Notification, new { }, ct);
            }
        }
        await db.SaveChangesAsync(ct);

        var dto = (await ToDtosAsync([msg], ct))[0];
        await PushAsync(tenant, await RecipientsAsync(tenant, msg.ConversationId, ct), ChatEvents.MessageUpdated, new { conversationId = msg.ConversationId, message = dto }, ct);
        return dto;
    }

    public async Task DeleteMessageAsync(Guid messageId, CancellationToken ct = default)
    {
        var (tenant, me) = Require();
        var msg = await db.ChatMessages.FirstOrDefaultAsync(m => m.Id == messageId, ct) ?? throw new NotFoundException("This message was not found.", "MESSAGE_NOT_FOUND");
        var mine = await MembershipAsync(msg.ConversationId, me, ct);
        if (msg.Kind != ChatMessageKind.User) throw new ForbiddenException("This line cannot be deleted.", "MESSAGE_NOT_YOURS");
        var conv = await db.Conversations.FirstAsync(c => c.Id == msg.ConversationId, ct);
        var moderator = CanModerate(conv.Type, mine.Role);
        if (msg.SenderId != me && !moderator) throw new ForbiddenException("You can only delete your own messages.", "MESSAGE_NOT_YOURS");
        if (msg.DeletedAt != null) return;

        msg.DeletedAt = clock.Now; msg.Body = "";   // the text is erased, not just hidden
        if (conv.LastMessageId == msg.Id) conv.LastMessageSnippet = "Message deleted";
        // So are its files and reactions: the bytes are removed from storage, not just hidden.
        var gone = await db.ChatAttachments.Where(a => a.MessageId == msg.Id).ToListAsync(ct);
        db.ChatAttachments.RemoveRange(gone);
        db.ChatReactions.RemoveRange(await db.ChatReactions.Where(r => r.MessageId == msg.Id).ToListAsync(ct));
        await db.SaveChangesAsync(ct);
        foreach (var a in gone) { try { await storage.DeleteAsync(a.StorageKey, CancellationToken.None); } catch (Exception ex) { log.LogWarning(ex, "Could not remove chat file {Key}", a.StorageKey); } }

        var dto = (await ToDtosAsync([msg], ct))[0];
        await PushAsync(tenant, await RecipientsAsync(tenant, msg.ConversationId, ct), ChatEvents.MessageUpdated, new { conversationId = msg.ConversationId, message = dto }, ct);
    }

    // ------------------------------------------------------------------ files and reactions

    /// <summary>
    /// Stores a file for a message that is about to be sent. The plan decides whether chat files are allowed at all, how big one may be and how much storage
    /// the organization has; the type is decided by the server and checked against the content. Until the message is sent only its uploader can see the file.
    /// </summary>
    public async Task<ChatAttachmentDto> UploadAsync(Guid conversationId, string? fileName, Stream content, long length, CancellationToken ct = default)
    {
        var (tenant, me) = Require();
        await MembershipAsync(conversationId, me, ct);
        await entitlements.EnsureFeatureAsync(FeatureKeys.ChatAttachments, ct);
        var conv = await db.Conversations.AsNoTracking().Where(c => c.Id == conversationId).Select(c => new { c.Type, c.ProjectId }).FirstAsync(ct);
        if (conv.Type == ConversationType.Project && await db.Projects.AsNoTracking().AnyAsync(p => p.Id == conv.ProjectId && p.Status == ProjectStatus.Archived, ct))
            throw new ConflictException("This project is archived, so its chat is read-only.", "PROJECT_ARCHIVED");
        if (await db.ChatAttachments.CountAsync(a => a.ConversationId == conversationId && a.UploaderId == me && a.MessageId == null, ct) >= MaxFilesPerMessage * 2)
            throw new ValidationException("file", "Send or remove the files you already added first.");
        var stored = await files.StoreAsync(fileName, content, length, ct);
        var row = new ChatAttachment { TenantId = tenant, ConversationId = conversationId, UploaderId = me, FileName = stored.Name, ContentType = stored.ContentType, SizeBytes = length, StorageKey = stored.Key, Sha256 = stored.Sha256, CreatedAt = clock.Now, CreatedBy = me };
        db.ChatAttachments.Add(row);
        try { await db.SaveChangesAsync(ct); }
        catch { await storage.DeleteAsync(stored.Key, CancellationToken.None); throw; }
        return new ChatAttachmentDto(row.Id, row.FileName, row.ContentType, row.SizeBytes, FileRules.IsImage(row.ContentType));
    }

    /// <summary>Takes back a file that was uploaded but not sent.</summary>
    public async Task RemovePendingFileAsync(Guid id, CancellationToken ct = default)
    {
        var (_, me) = Require();
        var a = await db.ChatAttachments.FirstOrDefaultAsync(x => x.Id == id && x.UploaderId == me && x.MessageId == null, ct) ?? throw new NotFoundException("File not found.");
        db.ChatAttachments.Remove(a);
        await db.SaveChangesAsync(ct);
        await storage.DeleteAsync(a.StorageKey, CancellationToken.None);
    }

    /// <summary>A file for download: only for people in the conversation (the uploader sees it before it is sent). The caller disposes the stream.</summary>
    public async Task<(ChatAttachment File, Stream Content)> OpenFileAsync(Guid id, CancellationToken ct = default)
    {
        var (_, me) = Require();
        var a = await db.ChatAttachments.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id, ct) ?? throw new NotFoundException("File not found.");
        if (a.MessageId is null) { if (a.UploaderId != me) throw new NotFoundException("File not found."); }
        else
        {
            try { await MembershipAsync(a.ConversationId, me, ct); } catch (NotFoundException) { throw new NotFoundException("File not found."); }
            if (await db.ChatMessages.AsNoTracking().AnyAsync(m => m.Id == a.MessageId && m.DeletedAt != null, ct)) throw new NotFoundException("File not found.");
        }
        var stream = await storage.OpenReadAsync(a.StorageKey, ct);
        if (stream is null) { log.LogError("Chat file {Id} is missing from storage ({Key})", id, a.StorageKey); throw new NotFoundException("This file is no longer available."); }
        return (a, stream);
    }

    /// <summary>Adds (or, with <paramref name="on"/> false, takes back) the caller's reaction to a message.</summary>
    public async Task<ChatMessageDto> ReactAsync(Guid messageId, string? emoji, bool on, CancellationToken ct = default)
    {
        var (tenant, me) = Require();
        if (emoji is null || !Reactions.Contains(emoji)) throw new ValidationException("emoji", "Choose one of the reactions on offer.");
        var msg = await db.ChatMessages.FirstOrDefaultAsync(m => m.Id == messageId, ct) ?? throw new NotFoundException("This message was not found.", "MESSAGE_NOT_FOUND");
        await MembershipAsync(msg.ConversationId, me, ct);
        if (msg.DeletedAt != null || msg.Kind != ChatMessageKind.User) throw new ConflictException("You cannot react to this message.", "MESSAGE_DELETED");
        var existing = await db.ChatReactions.FirstOrDefaultAsync(r => r.MessageId == messageId && r.UserId == me && r.Emoji == emoji, ct);
        if (on && existing is null) db.ChatReactions.Add(new ChatReaction { TenantId = tenant, MessageId = messageId, ConversationId = msg.ConversationId, UserId = me, Emoji = emoji, CreatedAt = clock.Now, CreatedBy = me });
        else if (!on && existing is not null) db.ChatReactions.Remove(existing);
        else return (await ToDtosAsync([msg], ct))[0];
        await db.SaveChangesAsync(ct);
        var dto = (await ToDtosAsync([msg], ct))[0];
        await PushAsync(tenant, await RecipientsAsync(tenant, msg.ConversationId, ct), ChatEvents.MessageUpdated, new { conversationId = msg.ConversationId, message = dto }, ct);
        return dto;
    }

    // ------------------------------------------------------------------ read state, mute, search

    public async Task MarkReadAsync(Guid conversationId, CancellationToken ct = default)
    {
        var (tenant, me) = Require();
        var mine = await MembershipAsync(conversationId, me, ct);
        var now = clock.Now;
        // Reading the conversation clears its notice in the bell (on this person's other tabs too).
        var link = $"/chat/{conversationId}";
        var notices = await db.Notifications.Where(n => n.UserId == me && n.Type == NotificationType.Message && n.Link == link && n.ReadAt == null).ToListAsync(ct);
        foreach (var n in notices) n.ReadAt = now;
        if (mine.LastReadAt >= now && notices.Count == 0) return;
        mine.LastReadAt = now;
        await db.SaveChangesAsync(ct);
        if (notices.Count > 0) await PushAsync(tenant, [me], ChatEvents.Notification, new { }, ct);
        await PushAsync(tenant, await RecipientsAsync(tenant, conversationId, ct), ChatEvents.Read, new { conversationId, userId = me, at = now }, ct);
    }

    public async Task SetMutedAsync(Guid conversationId, bool muted, CancellationToken ct = default)
    {
        var (_, me) = Require();
        var mine = await MembershipAsync(conversationId, me, ct);
        mine.IsMuted = muted;
        await db.SaveChangesAsync(ct);
    }

    /// <summary>Unread messages across every conversation that is not muted (the badge in the menu).</summary>
    public async Task<UnreadDto> UnreadAsync(CancellationToken ct = default)
    {
        var (_, me) = Require();
        var count = await (from msg in db.ChatMessages.AsNoTracking()
                           join m in db.ConversationMembers.AsNoTracking() on msg.ConversationId equals m.ConversationId
                           join c in db.Conversations.AsNoTracking() on msg.ConversationId equals c.Id
                           where c.Type != ConversationType.Project && m.UserId == me && !m.IsMuted && msg.CreatedAt > m.LastReadAt && msg.CreatedAt >= m.CreatedAt
                                 && msg.Kind == ChatMessageKind.User && msg.SenderId != me && msg.DeletedAt == null
                           select msg.Id).CountAsync(ct);
        return new UnreadDto(count);
    }

    public async Task<IReadOnlyList<ChatSearchHitDto>> SearchAsync(string? text, CancellationToken ct = default)
    {
        var (_, me) = Require();
        var q = (text ?? "").Trim().ToLowerInvariant();
        if (q.Length < 2) return [];
        if (q.Length > 100) q = q[..100];

        var hits = await (from msg in db.ChatMessages.AsNoTracking()
                          join m in db.ConversationMembers.AsNoTracking() on msg.ConversationId equals m.ConversationId
                          join c in db.Conversations.AsNoTracking() on msg.ConversationId equals c.Id
                          where c.Type != ConversationType.Project && m.UserId == me && msg.CreatedAt >= m.CreatedAt && msg.Kind == ChatMessageKind.User && msg.DeletedAt == null && EF.Functions.Like(msg.Body.ToLower(), SearchText.Pattern(q), SearchText.Escape)
                          orderby msg.CreatedAt descending
                          select new { msg.Id, msg.ConversationId, msg.SenderId, msg.Body, msg.CreatedAt }).Take(30).ToListAsync(ct);
        if (hits.Count == 0) return [];

        var convIds = hits.Select(h => h.ConversationId).Distinct().ToList();
        var conversations = await BuildAsync(me, convIds, ct);
        var senderIds = hits.Where(h => h.SenderId != null).Select(h => h.SenderId!.Value).Distinct().ToList();
        var senders = await db.Users.AsNoTracking().Where(u => senderIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        return hits.Select(h => new ChatSearchHitDto(h.Id, h.ConversationId, conversations[h.ConversationId].Name,
            h.SenderId is { } s ? senders.GetValueOrDefault(s) : null, Snippet(h.Body), h.CreatedAt)).ToList();
    }
}
