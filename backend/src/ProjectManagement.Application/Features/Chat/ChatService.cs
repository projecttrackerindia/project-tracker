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
    /// <summary>True only while the person is active (has an open tab that is not idle).</summary>
    bool IsOnline(Guid tenantId, Guid userId);
    /// <summary>"active", "away" (open but idle) or "offline".</summary>
    string Status(Guid tenantId, Guid userId);
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

public record ChatPersonDto(Guid UserId, string Name, string Email, bool Online, bool HasAvatar = false, string Status = "offline");
public record ChatMemberDto(Guid UserId, string Name, ConversationRole Role, DateTime LastReadAt, bool Online, bool HasAvatar = false, string Status = "offline");
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
public partial class ChatService(IAppDbContext db, ICurrentContext ctx, AppClock clock, IChatNotifier notifier, IChatPresence presence, PermissionService permissions,
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
}
