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
}
