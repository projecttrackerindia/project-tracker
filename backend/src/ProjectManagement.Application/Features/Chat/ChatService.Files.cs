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
        foreach (var n in notices) { n.ReadAt = now; n.EmailPending = false; }   // read: no e-mail about it either
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
