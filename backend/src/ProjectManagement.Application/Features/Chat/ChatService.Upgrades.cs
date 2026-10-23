using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Chat;

public record ChatThreadDto(ChatMessageDto Root, IReadOnlyList<ChatMessageDto> Replies);
public record ChatSavedDto(ChatMessageDto Message, string ConversationName, DateTime SavedAt);
public record ChatSeenDto(Guid UserId, string Name, DateTime At);
public record ChatSeenByDto(IReadOnlyList<ChatSeenDto> Seen, IReadOnlyList<string> NotYet);
public record ChatQuestionDto(Guid MessageId, Guid ConversationId, string ConversationName, string? SenderName, string Snippet, DateTime At, Guid? ThreadRootId);
public record ChatStatusDto(string? Emoji, string? Text, DateTime? ClearAt, DateTime? DndUntil, bool Dnd);
public record SetChatStatusRequest(string? Emoji, string? Text, DateTime? ClearAt, DateTime? DndUntil);
public record CreatePollRequest(string? Question, IReadOnlyList<string>? Options, bool Multiple = false, DateTime? ClosesAt = null);
public record VotePollRequest(IReadOnlyList<int>? Options);
public record ClosePollRequest(string? Decision);
public record ScheduleMessageRequest(string? Body, DateTime SendAt, Guid? ReplyToId = null, Guid? ThreadRootId = null);
public record ChatScheduledDto(Guid Id, Guid ConversationId, string ConversationName, string Body, DateTime SendAt, string Status, Guid? ThreadRootId, string? Error);
public record LinkMessageRequest(string Kind, Guid Id, string? Key, string? Title);
/// <summary>A task or page key written in a message, shown as a live card: what it is now, not what it was when it was written.</summary>
public record ChatUnfurlDto(string Key, string Kind, Guid Id, string Title, string? Status, string? StatusColor, string? Assignee, DateOnly? Due, bool Done, string Link);

/// <summary>
/// The chat upgrades: real threads, pins, saved messages, quick polls that record a decision, seen-by in groups, questions waiting for me,
/// status and do-not-disturb, scheduled send, voice notes with a transcript, what was made from a message, and task / page keys as live cards.
/// </summary>
public partial class ChatService
{
    public const int MaxPollOptions = 10;
    private static readonly string[] LinkKinds = ["task", "ticket", "reminder", "page"];

    // ------------------------------------------------------------------ for chat's AI (ChatAiService)

    /// <summary>Who is asking (chat must be open to them).</summary>
    internal (Guid Tenant, Guid Me) Who() => Require();

    /// <summary>The caller's place in a conversation (NotFound when they are not in it) and its name as they see it.</summary>
    internal async Task<(ConversationMember Member, string Name, ConversationType Type)> AccessAsync(Guid conversationId, CancellationToken ct)
    {
        var (_, me) = Require();
        var member = await MembershipAsync(conversationId, me, ct);
        var type = await db.Conversations.AsNoTracking().Where(c => c.Id == conversationId).Select(c => c.Type).FirstAsync(ct);
        return (member, await ConversationNameAsync(conversationId, me, ct), type);
    }

    /// <summary>A message as plain words: mentions as @Name, no formatting marks.</summary>
    internal static string Plain(string body) =>
        Italic.Replace(Underline.Replace(Bold.Replace(MentionToken.Replace(body, "@$1"), "$1"), "$1"), "$1").Trim();

    // ------------------------------------------------------------------ threads

    /// <summary>A thread: its first message and every reply, oldest first.</summary>
    public async Task<ChatThreadDto> ThreadAsync(Guid rootId, CancellationToken ct = default)
    {
        var (_, me) = Require();
        var root = await db.ChatMessages.AsNoTracking().FirstOrDefaultAsync(m => m.Id == rootId, ct) ?? throw new NotFoundException("This message was not found.", "MESSAGE_NOT_FOUND");
        var mine = await MembershipAsync(root.ConversationId, me, ct);
        if (root.ThreadRootId is not null || root.CreatedAt < mine.CreatedAt) throw new NotFoundException("This message was not found.", "MESSAGE_NOT_FOUND");
        var replies = await db.ChatMessages.AsNoTracking().Where(m => m.ThreadRootId == rootId).OrderBy(m => m.CreatedAt).ThenBy(m => m.Id).Take(500).ToListAsync(ct);
        var dtos = await ToDtosAsync([root, .. replies], ct, await AsksMeAsync(root.ConversationId, [root, .. replies], me, ct));
        return new ChatThreadDto(dtos[0], dtos.Skip(1).ToList());
    }

    /// <summary>Tells the people in a thread (who started it and who replied) that there is a new reply. Returns who was told.</summary>
    private async Task<List<Guid>> NotifyThreadAsync(Conversation conv, ChatMessage root, string preview, IReadOnlyCollection<Guid> audience, IReadOnlyCollection<Guid> alreadyMentioned, CancellationToken ct)
    {
        var me = ctx.RequireUserId();
        var people = await db.ChatMessages.AsNoTracking().Where(m => m.ThreadRootId == root.Id && m.SenderId != null).Select(m => m.SenderId!.Value).Distinct().ToListAsync(ct);
        if (root.SenderId is { } starter) people.Add(starter);
        var sender = await NameOfAsync(me, ct);
        var told = new List<Guid>();
        var muted = await db.ConversationMembers.AsNoTracking().Where(m => m.ConversationId == conv.Id && m.IsMuted).Select(m => m.UserId).ToListAsync(ct);
        foreach (var u in people.Distinct().Where(x => x != me && audience.Contains(x) && !alreadyMentioned.Contains(x) && !muted.Contains(x)))
        {
            await notifications.AddAsync(u, NotificationType.Message, $"{sender} replied in a thread", Snippet(preview), $"/chat/{conv.Id}?thread={root.Id}", ct: ct);
            told.Add(u);
        }
        return told;
    }

    // ------------------------------------------------------------------ pins and saved messages

    public async Task<ChatMessageDto> PinAsync(Guid messageId, bool on, CancellationToken ct = default)
    {
        var (tenant, me) = Require();
        var msg = await db.ChatMessages.FirstOrDefaultAsync(m => m.Id == messageId, ct) ?? throw new NotFoundException("This message was not found.", "MESSAGE_NOT_FOUND");
        await MembershipAsync(msg.ConversationId, me, ct);
        if (msg.DeletedAt is not null) throw new ConflictException("This message was deleted.", "MESSAGE_DELETED");
        if (on && msg.PinnedAt is null && await db.ChatMessages.CountAsync(m => m.ConversationId == msg.ConversationId && m.PinnedAt != null && m.DeletedAt == null, ct) >= 50)
            throw new ConflictException("A conversation can have up to 50 pinned messages. Unpin one first.", "TOO_MANY_PINS");
        if (on == (msg.PinnedAt is not null)) return (await ToDtosAsync([msg], ct))[0];
        msg.PinnedAt = on ? clock.Now : null;
        msg.PinnedBy = on ? me : null;
        await db.SaveChangesAsync(ct);
        var dto = (await ToDtosAsync([msg], ct))[0];
        await PushAsync(tenant, await RecipientsAsync(tenant, msg.ConversationId, ct), ChatEvents.MessageUpdated, new { conversationId = msg.ConversationId, message = dto }, ct);
        return dto;
    }

    /// <summary>The pinned messages of a conversation, newest pin first.</summary>
    public async Task<IReadOnlyList<ChatMessageDto>> PinsAsync(Guid conversationId, CancellationToken ct = default)
    {
        var (_, me) = Require();
        var mine = await MembershipAsync(conversationId, me, ct);
        var rows = await db.ChatMessages.AsNoTracking().Where(m => m.ConversationId == conversationId && m.PinnedAt != null && m.DeletedAt == null && m.CreatedAt >= mine.CreatedAt)
            .OrderByDescending(m => m.PinnedAt).Take(50).ToListAsync(ct);
        return await ToDtosAsync(rows, ct);
    }

    public async Task<ChatMessageDto> SaveMessageAsync(Guid messageId, bool on, CancellationToken ct = default)
    {
        var (tenant, me) = Require();
        var msg = await db.ChatMessages.AsNoTracking().FirstOrDefaultAsync(m => m.Id == messageId, ct) ?? throw new NotFoundException("This message was not found.", "MESSAGE_NOT_FOUND");
        await MembershipAsync(msg.ConversationId, me, ct);
        var row = await db.ChatSavedMessages.FirstOrDefaultAsync(x => x.UserId == me && x.MessageId == messageId, ct);
        if (on && row is null) db.ChatSavedMessages.Add(new ChatSavedMessage { TenantId = tenant, UserId = me, MessageId = messageId, ConversationId = msg.ConversationId, CreatedAt = clock.Now, CreatedBy = me });
        else if (!on && row is not null) db.ChatSavedMessages.Remove(row);
        await db.SaveChangesAsync(ct);
        return (await ToDtosAsync([msg], ct))[0];
    }

    /// <summary>The messages the person saved, newest first, from conversations they can still read.</summary>
    public async Task<IReadOnlyList<ChatSavedDto>> SavedAsync(CancellationToken ct = default)
    {
        var (_, me) = Require();
        var rows = await db.ChatSavedMessages.AsNoTracking().Where(x => x.UserId == me).OrderByDescending(x => x.CreatedAt).Take(200).ToListAsync(ct);
        var result = new List<ChatSavedDto>();
        var convNames = new Dictionary<Guid, string?>();
        foreach (var r in rows)
        {
            if (!convNames.TryGetValue(r.ConversationId, out var name))
            {
                try { await MembershipAsync(r.ConversationId, me, ct); name = await ConversationNameAsync(r.ConversationId, me, ct); }
                catch (NotFoundException) { name = null; }
                convNames[r.ConversationId] = name;
            }
            if (name is null) continue;   // no longer in that conversation
            var msg = await db.ChatMessages.AsNoTracking().FirstOrDefaultAsync(m => m.Id == r.MessageId, ct);
            if (msg is null || msg.DeletedAt is not null) continue;
            result.Add(new ChatSavedDto((await ToDtosAsync([msg], ct))[0], name, r.CreatedAt));
        }
        return result;
    }

    private async Task<string> ConversationNameAsync(Guid conversationId, Guid me, CancellationToken ct)
    {
        var c = await db.Conversations.AsNoTracking().Where(x => x.Id == conversationId).Select(x => new { x.Type, x.Name }).FirstAsync(ct);
        if (c.Type != ConversationType.Direct) return c.Name ?? (c.Type == ConversationType.Project ? "Project chat" : "Group");
        var other = await db.ConversationMembers.AsNoTracking().Where(m => m.ConversationId == conversationId && m.UserId != me).Select(m => m.User!.DisplayName).FirstOrDefaultAsync(ct);
        return other ?? "Former member";
    }

    // ------------------------------------------------------------------ seen by, and questions waiting for me

    /// <summary>Who in a group has read up to a message, and who has not yet (groups and direct chats; a project chat is too big for this).</summary>
    public async Task<ChatSeenByDto> SeenByAsync(Guid messageId, CancellationToken ct = default)
    {
        var (tenant, me) = Require();
        var msg = await db.ChatMessages.AsNoTracking().FirstOrDefaultAsync(m => m.Id == messageId, ct) ?? throw new NotFoundException("This message was not found.", "MESSAGE_NOT_FOUND");
        await MembershipAsync(msg.ConversationId, me, ct);
        var type = await db.Conversations.AsNoTracking().Where(c => c.Id == msg.ConversationId).Select(c => c.Type).FirstAsync(ct);
        if (type == ConversationType.Project) return new ChatSeenByDto([], []);
        var eligible = await Eligible(tenant).Select(m => m.UserId).ToListAsync(ct);
        var members = await db.ConversationMembers.AsNoTracking().Where(m => m.ConversationId == msg.ConversationId && m.UserId != msg.SenderId && eligible.Contains(m.UserId))
            .Select(m => new { m.UserId, m.User!.DisplayName, m.LastReadAt }).ToListAsync(ct);
        var seen = members.Where(m => m.LastReadAt >= msg.CreatedAt).OrderBy(m => m.LastReadAt).Select(m => new ChatSeenDto(m.UserId, m.DisplayName, m.LastReadAt)).ToList();
        var notYet = members.Where(m => m.LastReadAt < msg.CreatedAt).OrderBy(m => m.DisplayName).Select(m => m.DisplayName).ToList();
        return new ChatSeenByDto(seen, notYet);
    }

    private static bool AsksQuestion(string body) => body.Contains('?') && Snippet(body).Length >= 4;

    /// <summary>
    /// Which of these messages ask the person something they have not answered: from someone else, with a question mark, in a direct chat or
    /// @mentioning them, and nothing written by them in that conversation (or thread) since.
    /// </summary>
    private async Task<HashSet<Guid>> AsksMeAsync(Guid conversationId, IReadOnlyList<ChatMessage> page, Guid me, CancellationToken ct)
    {
        var candidates = page.Where(m => m.Kind == ChatMessageKind.User && m.DeletedAt == null && m.SenderId != me && AsksQuestion(m.Body)).ToList();
        if (candidates.Count == 0) return [];
        var type = await db.Conversations.AsNoTracking().Where(c => c.Id == conversationId).Select(c => c.Type).FirstAsync(ct);
        var token = $"]({me})";
        candidates = candidates.Where(m => type == ConversationType.Direct || m.Body.Contains(token, StringComparison.OrdinalIgnoreCase)).ToList();
        if (candidates.Count == 0) return [];
        var since = candidates.Min(m => m.CreatedAt);
        var mine = await db.ChatMessages.AsNoTracking().Where(m => m.ConversationId == conversationId && m.SenderId == me && m.CreatedAt > since)
            .Select(m => new { m.CreatedAt, m.ThreadRootId }).ToListAsync(ct);
        return candidates.Where(q => !mine.Any(a => a.CreatedAt > q.CreatedAt && (a.ThreadRootId == q.ThreadRootId || q.ThreadRootId is null && a.ThreadRootId == q.Id))).Select(q => q.Id).ToHashSet();
    }

    /// <summary>Questions put to the person in the last two weeks that they have not answered yet, newest first.</summary>
    public async Task<IReadOnlyList<ChatQuestionDto>> QuestionsAsync(CancellationToken ct = default)
    {
        var (_, me) = Require();
        var cutoff = clock.Now.AddDays(-14);
        var convs = await (from m in db.ConversationMembers.AsNoTracking()
                           join c in db.Conversations.AsNoTracking() on m.ConversationId equals c.Id
                           where m.UserId == me && c.LastMessageAt > cutoff
                           select new { c.Id, c.Type }).ToListAsync(ct);
        var result = new List<ChatQuestionDto>();
        foreach (var c in convs)
        {
            try { await MembershipAsync(c.Id, me, ct); } catch (NotFoundException) { continue; }
            var rows = await db.ChatMessages.AsNoTracking().Where(m => m.ConversationId == c.Id && m.CreatedAt > cutoff && m.SenderId != me && m.Kind == ChatMessageKind.User
                    && m.DeletedAt == null && m.Body.Contains("?")).OrderByDescending(m => m.CreatedAt).Take(30).ToListAsync(ct);
            if (rows.Count == 0) continue;
            var open = await AsksMeAsync(c.Id, rows, me, ct);
            if (open.Count == 0) continue;
            var name = await ConversationNameAsync(c.Id, me, ct);
            var senders = await db.Users.AsNoTracking().Where(u => rows.Select(r => r.SenderId).Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
            result.AddRange(rows.Where(r => open.Contains(r.Id)).Select(r => new ChatQuestionDto(r.Id, c.Id, name, r.SenderId is { } s ? senders.GetValueOrDefault(s) : null, Snippet(r.Body), r.CreatedAt, r.ThreadRootId)));
        }
        return result.OrderByDescending(r => r.At).Take(50).ToList();
    }

    // ------------------------------------------------------------------ status and do-not-disturb

    private ChatStatusDto ToStatus(ChatUserStatus? s)
    {
        var now = clock.Now;
        if (s is null) return new ChatStatusDto(null, null, null, null, false);
        var expired = s.ClearAt is { } c && c <= now;
        var dnd = s.DndUntil is { } d && d > now;
        return new ChatStatusDto(expired ? null : s.Emoji, expired ? null : s.Text, expired ? null : s.ClearAt, dnd ? s.DndUntil : null, dnd);
    }

    public async Task<ChatStatusDto> MyStatusAsync(CancellationToken ct = default)
    {
        var (_, me) = Require();
        return ToStatus(await db.ChatUserStatuses.AsNoTracking().FirstOrDefaultAsync(s => s.UserId == me, ct));
    }

    public async Task<ChatStatusDto> SetStatusAsync(SetChatStatusRequest req, CancellationToken ct = default)
    {
        var (tenant, me) = Require();
        var emoji = string.IsNullOrWhiteSpace(req.Emoji) ? null : req.Emoji.Trim();
        if (emoji is { Length: > 16 }) throw new ValidationException("emoji", "Choose one emoji.");
        var text = string.IsNullOrWhiteSpace(req.Text) ? null : req.Text.Trim();
        if (text is { Length: > 100 }) throw new ValidationException("text", "Keep the status under 100 characters.");
        var now = clock.Now;
        if (req.ClearAt is { } c && c <= now) throw new ValidationException("clearAt", "Choose a time in the future.");
        if (req.DndUntil is { } d && (d <= now || d > now.AddDays(30))) throw new ValidationException("dndUntil", "Do not disturb can be on for up to 30 days.");
        var row = await db.ChatUserStatuses.FirstOrDefaultAsync(s => s.UserId == me, ct);
        if (row is null) { row = new ChatUserStatus { TenantId = tenant, UserId = me, CreatedAt = now, CreatedBy = me }; db.ChatUserStatuses.Add(row); }
        row.Emoji = emoji; row.Text = text; row.ClearAt = emoji is null && text is null ? null : req.ClearAt; row.DndUntil = req.DndUntil; row.UpdatedAt = now;
        await db.SaveChangesAsync(ct);
        var dto = ToStatus(row);
        // The people this person chats with see the new status at once.
        var peers = await (from mine in db.ConversationMembers.AsNoTracking()
                           join other in db.ConversationMembers.AsNoTracking() on mine.ConversationId equals other.ConversationId
                           where mine.UserId == me select other.UserId).Distinct().Take(500).ToListAsync(ct);
        await PushAsync(tenant, peers, "status", new { userId = me, emoji = dto.Emoji, text = dto.Text, dnd = dto.Dnd }, ct);
        return dto;
    }

    /// <summary>The status of these people (for member lists).</summary>
    private async Task<Dictionary<Guid, ChatStatusDto>> StatusesAsync(IEnumerable<Guid> userIds, CancellationToken ct)
    {
        var ids = userIds.Distinct().ToList();
        var rows = await db.ChatUserStatuses.AsNoTracking().Where(s => ids.Contains(s.UserId)).ToListAsync(ct);
        return rows.ToDictionary(r => r.UserId, ToStatus);
    }

    // ------------------------------------------------------------------ polls

    private async Task<Dictionary<Guid, ChatPollDto>> PollsAsync(IReadOnlyList<Guid> messageIds, CancellationToken ct)
    {
        var me = ctx.UserId;
        var polls = await db.ChatPolls.AsNoTracking().Where(p => messageIds.Contains(p.MessageId)).ToListAsync(ct);
        if (polls.Count == 0) return [];
        var pollIds = polls.Select(p => p.Id).ToList();
        var votes = await db.ChatPollVotes.AsNoTracking().Where(v => pollIds.Contains(v.PollId)).Select(v => new { v.PollId, v.UserId, v.Option }).ToListAsync(ct);
        var names = await db.Users.AsNoTracking().Where(u => votes.Select(v => v.UserId).Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        var senders = await db.ChatMessages.AsNoTracking().Where(m => messageIds.Contains(m.Id)).ToDictionaryAsync(m => m.Id, m => m.SenderId, ct);
        var now = clock.Now;
        return polls.ToDictionary(p => p.MessageId, p =>
        {
            var options = JsonSerializer.Deserialize<List<string>>(p.OptionsJson) ?? [];
            var mine = votes.Where(v => v.PollId == p.Id).ToList();
            var closed = p.ClosedAt ?? (p.ClosesAt is { } at && at <= now ? at : null);
            return new ChatPollDto(p.Id, p.Question,
                options.Select((o, i) => new ChatPollOptionDto(i, o, mine.Count(v => v.Option == i), mine.Any(v => v.Option == i && v.UserId == me),
                    mine.Where(v => v.Option == i).Take(12).Select(v => names.GetValueOrDefault(v.UserId) ?? "Someone").ToList())).ToList(),
                p.Multiple, p.ClosesAt, closed, p.Decision, mine.Select(v => v.UserId).Distinct().Count(), closed is null && senders.GetValueOrDefault(p.MessageId) == me);
        });
    }

    /// <summary>A quick poll: a question with 2 to 10 options, one choice or several, closing by itself at a time or when its author closes it.</summary>
    public async Task<ChatMessageDto> CreatePollAsync(Guid conversationId, CreatePollRequest req, CancellationToken ct = default)
    {
        var (tenant, me) = Require();
        await MembershipAsync(conversationId, me, ct);
        var conv = await db.Conversations.FirstAsync(c => c.Id == conversationId, ct);
        if (conv.Type == ConversationType.Project)
        {
            var (_, status) = await RequireProjectChatAccessAsync(tenant, me, conv.ProjectId!.Value, ct);
            if (status == ProjectStatus.Archived) throw new ConflictException("This project is archived, so its chat is read-only.", "PROJECT_ARCHIVED");
        }
        var question = (req.Question ?? "").Trim();
        if (question.Length < 3 || question.Length > 300) throw new ValidationException("question", "Write the question (3 to 300 characters).");
        var options = (req.Options ?? []).Select(o => (o ?? "").Trim()).Where(o => o.Length > 0).ToList();
        if (options.Count < 2 || options.Count > MaxPollOptions) throw new ValidationException("options", $"Give 2 to {MaxPollOptions} options.");
        if (options.Any(o => o.Length > 120)) throw new ValidationException("options", "Keep each option under 120 characters.");
        if (options.Distinct(StringComparer.OrdinalIgnoreCase).Count() != options.Count) throw new ValidationException("options", "Each option must be different.");
        var now = clock.Now;
        if (req.ClosesAt is { } closes && (closes <= now.AddMinutes(1) || closes > now.AddDays(30))) throw new ValidationException("closesAt", "A poll can close between a minute and 30 days from now.");
        var msg = new ChatMessage { ConversationId = conversationId, SenderId = me, Kind = ChatMessageKind.Poll, Body = question };
        db.ChatMessages.Add(msg);
        db.ChatPolls.Add(new ChatPoll { TenantId = tenant, MessageId = msg.Id, ConversationId = conversationId, Question = question, OptionsJson = JsonSerializer.Serialize(options),
            Multiple = req.Multiple, ClosesAt = req.ClosesAt, CreatedAt = now, CreatedBy = me });
        conv.LastMessageAt = now; conv.LastMessageId = msg.Id; conv.LastMessageSenderId = me; conv.LastMessageSnippet = Snippet("📊 " + question);
        await db.SaveChangesAsync(ct);
        var dto = (await ToDtosAsync([msg], ct))[0];
        await PushAsync(tenant, await RecipientsAsync(tenant, conversationId, ct), ChatEvents.Message, new { conversationId, message = dto, projectId = conv.ProjectId }, ct);
        return dto;
    }

    private async Task<(ChatPoll Poll, ChatMessage Message)> PollOfAsync(Guid pollId, Guid me, CancellationToken ct)
    {
        var poll = await db.ChatPolls.FirstOrDefaultAsync(p => p.Id == pollId, ct) ?? throw new NotFoundException("This poll was not found.", "POLL_NOT_FOUND");
        var msg = await db.ChatMessages.FirstAsync(m => m.Id == poll.MessageId, ct);
        try { await MembershipAsync(poll.ConversationId, me, ct); } catch (NotFoundException) { throw new NotFoundException("This poll was not found.", "POLL_NOT_FOUND"); }
        if (msg.DeletedAt is not null) throw new NotFoundException("This poll was not found.", "POLL_NOT_FOUND");
        return (poll, msg);
    }

    /// <summary>The person's vote (replaces their earlier one); an empty choice takes their vote back.</summary>
    public async Task<ChatMessageDto> VoteAsync(Guid pollId, VotePollRequest req, CancellationToken ct = default)
    {
        var (tenant, me) = Require();
        var (poll, msg) = await PollOfAsync(pollId, me, ct);
        if (poll.ClosedAt is not null || poll.ClosesAt is { } at && at <= clock.Now) throw new ConflictException("This poll is closed.", "POLL_CLOSED");
        var count = (JsonSerializer.Deserialize<List<string>>(poll.OptionsJson) ?? []).Count;
        var chosen = (req.Options ?? []).Distinct().ToList();
        if (chosen.Any(o => o < 0 || o >= count)) throw new ValidationException("options", "Choose one of the poll's options.");
        if (!poll.Multiple && chosen.Count > 1) throw new ValidationException("options", "This poll takes one choice.");
        db.ChatPollVotes.RemoveRange(await db.ChatPollVotes.Where(v => v.PollId == pollId && v.UserId == me).ToListAsync(ct));
        foreach (var o in chosen) db.ChatPollVotes.Add(new ChatPollVote { TenantId = tenant, PollId = pollId, UserId = me, Option = o, CreatedAt = clock.Now, CreatedBy = me });
        await db.SaveChangesAsync(ct);
        var dto = (await ToDtosAsync([msg], ct))[0];
        await PushAsync(tenant, await RecipientsAsync(tenant, poll.ConversationId, ct), ChatEvents.MessageUpdated, new { conversationId = poll.ConversationId, message = dto }, ct);
        return dto;
    }

    /// <summary>
    /// Closes a poll (its author, or a group admin). The decision - written, or the winning option - is posted in the conversation and pinned,
    /// so what was agreed is easy to find later.
    /// </summary>
    public async Task<ChatMessageDto> ClosePollAsync(Guid pollId, ClosePollRequest req, CancellationToken ct = default)
    {
        var (tenant, me) = Require();
        var (poll, msg) = await PollOfAsync(pollId, me, ct);
        var membership = await MembershipAsync(poll.ConversationId, me, ct);
        var type = await db.Conversations.AsNoTracking().Where(c => c.Id == poll.ConversationId).Select(c => c.Type).FirstAsync(ct);
        if (msg.SenderId != me && !CanModerate(type, membership.Role)) throw new ForbiddenException("Only the person who asked can close this poll.", "POLL_NOT_YOURS");
        if (poll.ClosedAt is not null) throw new ConflictException("This poll is already closed.", "POLL_CLOSED");
        var options = JsonSerializer.Deserialize<List<string>>(poll.OptionsJson) ?? [];
        var votes = await db.ChatPollVotes.AsNoTracking().Where(v => v.PollId == pollId).Select(v => new { v.UserId, v.Option }).ToListAsync(ct);
        var voters = votes.Select(v => v.UserId).Distinct().Count();
        var decision = (req.Decision ?? "").Trim();
        if (decision.Length > 500) throw new ValidationException("decision", "Keep the decision under 500 characters.");
        if (decision.Length == 0 && votes.Count > 0)
        {
            var top = votes.GroupBy(v => v.Option).OrderByDescending(g => g.Count()).ThenBy(g => g.Key).First();
            var tie = votes.GroupBy(v => v.Option).Count(g => g.Count() == top.Count()) > 1;
            if (!tie) decision = options[top.Key];
        }
        var now = clock.Now;
        poll.ClosedAt = now; poll.ClosedBy = me; poll.Decision = decision.Length > 0 ? decision : null;
        if (poll.Decision is not null)
        {
            var who = await NameOfAsync(me, ct);
            var line = new ChatMessage { ConversationId = poll.ConversationId, Kind = ChatMessageKind.System,
                Body = Text.Truncate($"Decision: {poll.Decision} — “{poll.Question}” ({voters} voted, closed by {who})", MaxBody)!, PinnedAt = now, PinnedBy = me };
            db.ChatMessages.Add(line);
            poll.DecisionMessageId = line.Id;
            var conv = await db.Conversations.FirstAsync(c => c.Id == poll.ConversationId, ct);
            conv.LastMessageAt = now; conv.LastMessageId = line.Id; conv.LastMessageSenderId = null; conv.LastMessageSnippet = Snippet(line.Body);
            await db.SaveChangesAsync(ct);
            await PushAsync(tenant, await RecipientsAsync(tenant, poll.ConversationId, ct), ChatEvents.Message, new { conversationId = poll.ConversationId, message = (await ToDtosAsync([line], ct))[0] }, ct);
        }
        else await db.SaveChangesAsync(ct);
        var dto = (await ToDtosAsync([msg], ct))[0];
        await PushAsync(tenant, await RecipientsAsync(tenant, poll.ConversationId, ct), ChatEvents.MessageUpdated, new { conversationId = poll.ConversationId, message = dto }, ct);
        return dto;
    }

    // ------------------------------------------------------------------ scheduled send

    private ChatScheduledDto ToScheduled(ChatScheduledMessage s, string conversationName) =>
        new(s.Id, s.ConversationId, conversationName, s.Body, s.SendAt, s.Status.ToString(), s.ThreadRootId, s.Error);

    public async Task<ChatScheduledDto> ScheduleAsync(Guid conversationId, ScheduleMessageRequest req, CancellationToken ct = default)
    {
        var (tenant, me) = Require();
        await MembershipAsync(conversationId, me, ct);
        var text = CleanBody(req.Body);
        var now = clock.Now;
        if (req.SendAt <= now.AddMinutes(1) || req.SendAt > now.AddDays(60)) throw new ValidationException("sendAt", "Choose a time between a minute and 60 days from now.");
        if (await db.ChatScheduledMessages.CountAsync(s => s.SenderId == me && s.Status == ChatScheduleStatus.Scheduled, ct) >= 100)
            throw new ConflictException("You have 100 messages waiting to be sent. Send or cancel some first.", "TOO_MANY_SCHEDULED");
        if (req.ThreadRootId is { } root && !await db.ChatMessages.AnyAsync(m => m.Id == root && m.ConversationId == conversationId && m.ThreadRootId == null, ct))
            throw new ValidationException("threadRootId", "The thread was not found.");
        var row = new ChatScheduledMessage { TenantId = tenant, ConversationId = conversationId, SenderId = me, Body = text, ReplyToId = req.ReplyToId, ThreadRootId = req.ThreadRootId,
            SendAt = req.SendAt, Status = ChatScheduleStatus.Scheduled, CreatedAt = now, CreatedBy = me };
        db.ChatScheduledMessages.Add(row);
        await db.SaveChangesAsync(ct);
        return ToScheduled(row, await ConversationNameAsync(conversationId, me, ct));
    }

    /// <summary>The person's messages waiting to be sent (in one conversation, or all), soonest first.</summary>
    public async Task<IReadOnlyList<ChatScheduledDto>> ScheduledAsync(Guid? conversationId, CancellationToken ct = default)
    {
        var (_, me) = Require();
        var q = db.ChatScheduledMessages.AsNoTracking().Where(s => s.SenderId == me && (s.Status == ChatScheduleStatus.Scheduled || s.Status == ChatScheduleStatus.Failed));
        if (conversationId is { } cid) q = q.Where(s => s.ConversationId == cid);
        var rows = await q.OrderBy(s => s.SendAt).Take(100).ToListAsync(ct);
        var result = new List<ChatScheduledDto>();
        foreach (var r in rows) result.Add(ToScheduled(r, await ConversationNameAsync(r.ConversationId, me, ct)));
        return result;
    }

    public async Task<ChatScheduledDto> UpdateScheduledAsync(Guid id, ScheduleMessageRequest req, CancellationToken ct = default)
    {
        var (_, me) = Require();
        var row = await db.ChatScheduledMessages.FirstOrDefaultAsync(s => s.Id == id && s.SenderId == me, ct) ?? throw new NotFoundException("This scheduled message was not found.");
        if (row.Status is not (ChatScheduleStatus.Scheduled or ChatScheduleStatus.Failed)) throw new ConflictException("This message was already sent or cancelled.", "SCHEDULE_DONE");
        var now = clock.Now;
        if (req.SendAt <= now.AddMinutes(1) || req.SendAt > now.AddDays(60)) throw new ValidationException("sendAt", "Choose a time between a minute and 60 days from now.");
        row.Body = CleanBody(req.Body); row.SendAt = req.SendAt; row.Status = ChatScheduleStatus.Scheduled; row.Error = null; row.UpdatedAt = now;
        await db.SaveChangesAsync(ct);
        return ToScheduled(row, await ConversationNameAsync(row.ConversationId, me, ct));
    }

    public async Task CancelScheduledAsync(Guid id, CancellationToken ct = default)
    {
        var (_, me) = Require();
        var row = await db.ChatScheduledMessages.FirstOrDefaultAsync(s => s.Id == id && s.SenderId == me, ct) ?? throw new NotFoundException("This scheduled message was not found.");
        if (row.Status == ChatScheduleStatus.Sent) throw new ConflictException("This message was already sent.", "SCHEDULE_DONE");
        row.Status = ChatScheduleStatus.Cancelled; row.UpdatedAt = clock.Now;
        await db.SaveChangesAsync(ct);
    }

    /// <summary>
    /// Sends the scheduled messages that are due, each as its writer (with the writer's rights at that moment: someone who has left the
    /// conversation or the workspace sends nothing). Run by the reminders worker.
    /// </summary>
    public static async Task<int> SendDueAsync(IServiceProvider root, AppClock clock, ILogger log, CancellationToken ct)
    {
        List<(Guid Id, Guid Tenant, Guid Sender)> due;
        using (var scope = root.CreateScope())
        {
            var db0 = scope.ServiceProvider.GetRequiredService<IAppDbContext>();
            var now = clock.Now;
            due = (await db0.ChatScheduledMessages.IgnoreQueryFilters().AsNoTracking().Where(s => s.Status == ChatScheduleStatus.Scheduled && s.SendAt <= now)
                .OrderBy(s => s.SendAt).Take(100).Select(s => new { s.Id, s.TenantId, s.SenderId }).ToListAsync(ct)).Select(s => (s.Id, s.TenantId, s.SenderId)).ToList();
        }
        var sent = 0;
        foreach (var (id, tenant, sender) in due)
        {
            using var scope = root.CreateScope();
            var sp = scope.ServiceProvider;
            var db = sp.GetRequiredService<IAppDbContext>();
            string? error = null;
            Guid? messageId = null;
            try
            {
                await WorkspaceExecutionPrincipal.ConfigureAsync(sp, sender, tenant, null, ct);
                var row = await db.ChatScheduledMessages.AsNoTracking().FirstAsync(s => s.Id == id, ct);
                if (row.Status != ChatScheduleStatus.Scheduled) continue;
                var chat = sp.GetRequiredService<ChatService>();
                messageId = (await chat.SendAsync(row.ConversationId, new SendMessageRequest(row.Body, row.ReplyToId, null, row.ThreadRootId), ct)).Id;
            }
            catch (Exception ex) when (ex is AppException or InvalidOperationException)
            {
                error = ex is AppException app ? app.Message : "The message could not be sent.";
                log.LogInformation(ex, "Scheduled chat message {Id} was not sent", id);
            }
            using var scope2 = root.CreateScope();
            var db2 = scope2.ServiceProvider.GetRequiredService<IAppDbContext>();
            var r = await db2.ChatScheduledMessages.IgnoreQueryFilters().FirstAsync(s => s.Id == id, ct);
            r.Status = messageId is null ? ChatScheduleStatus.Failed : ChatScheduleStatus.Sent;
            r.SentMessageId = messageId; r.Error = Text.Truncate(error, 300); r.UpdatedAt = clock.Now;
            await db2.SaveChangesAsync(ct);
            if (messageId is not null) sent++;
        }
        return sent;
    }

    // ------------------------------------------------------------------ voice notes

    /// <summary>
    /// A voice note for a message about to be sent: stored like any chat file (the plan's file limits apply) and transcribed (Telugu, Hindi or
    /// English) so it can be read, searched and understood without playing it. A note the speech service cannot read is still sent, untranscribed.
    /// </summary>
    public async Task<ChatAttachmentDto> UploadVoiceAsync(Guid conversationId, Stream content, long length, int? durationSeconds, CancellationToken ct = default)
    {
        if (length > 20 * 1024 * 1024) throw new ValidationException("voice", "Keep a voice note under about 10 minutes.");
        using var ms = new MemoryStream();
        await content.CopyToAsync(ms, ct);
        ms.Position = 0;
        var dto = await UploadAsync(conversationId, $"Voice note {clock.Now:yyyy-MM-dd HHmm}.wav", ms, ms.Length, ct);
        var row = await db.ChatAttachments.FirstAsync(a => a.Id == dto.Id, ct);
        row.IsVoice = true;
        row.DurationSeconds = durationSeconds is { } d ? Math.Clamp(d, 0, 3600) : null;
        try
        {
            var heard = await speech.TranscribeAsync(ms.ToArray(), "audio/wav", ct);
            if (heard is { } h && !string.IsNullOrWhiteSpace(h.Text)) { row.Transcript = Text.Truncate(h.Text.Trim(), 4000); row.TranscriptLanguage = Text.Truncate(h.Language, 12); }
        }
        catch (Exception ex) when (ex is not OperationCanceledException) { log.LogWarning(ex, "Voice note {Id} could not be transcribed", row.Id); }
        await db.SaveChangesAsync(ct);
        return new ChatAttachmentDto(row.Id, row.FileName, row.ContentType, row.SizeBytes, false, true, row.Transcript, row.TranscriptLanguage, row.DurationSeconds);
    }

    // ------------------------------------------------------------------ what was made from a message

    private static IReadOnlyList<ChatLinkDto>? ReadLinks(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try { return JsonSerializer.Deserialize<List<ChatLinkDto>>(json, JsonSerializerOptions.Web); } catch (JsonException) { return null; }
    }

    /// <summary>
    /// Records that a task, ticket, reminder or page was made from this message (it was created with its own screen), so the message shows a
    /// link to it. The item must exist and be the person's to see.
    /// </summary>
    public async Task<ChatMessageDto> LinkAsync(Guid messageId, LinkMessageRequest req, CancellationToken ct = default)
    {
        var (tenant, me) = Require();
        var msg = await db.ChatMessages.FirstOrDefaultAsync(m => m.Id == messageId, ct) ?? throw new NotFoundException("This message was not found.", "MESSAGE_NOT_FOUND");
        await MembershipAsync(msg.ConversationId, me, ct);
        var kind = (req.Kind ?? "").Trim().ToLowerInvariant();
        if (!LinkKinds.Contains(kind)) throw new ValidationException("kind", "Link a task, ticket, reminder or page.");
        (string? Key, string Title)? found = kind switch
        {
            "task" => await db.Tasks.AsNoTracking().Where(x => x.Id == req.Id).Select(x => new { Key = x.Project!.Key + "-" + x.Number, x.Title }).FirstOrDefaultAsync(ct) is { } tk ? (tk.Key, tk.Title) : null,
            "ticket" => await db.WorkTasks.AsNoTracking().Where(x => x.Id == req.Id).Select(x => new { x.Number, x.Title }).FirstOrDefaultAsync(ct) is { } wk ? ($"WT-{wk.Number}", wk.Title) : null,
            "reminder" => await db.Reminders.AsNoTracking().Where(x => x.Id == req.Id && x.UserId == me).Select(x => x.Title).FirstOrDefaultAsync(ct) is { } rt ? (null, rt) : null,
            _ => await db.Documents.AsNoTracking().Where(x => x.Id == req.Id).Select(x => new { x.Number, x.Title }).FirstOrDefaultAsync(ct) is { } dk ? ($"DOC-{dk.Number}", dk.Title) : null,
        };
        if (found is not { } f) throw new NotFoundException("That item was not found.", "LINK_TARGET_NOT_FOUND");
        var links = (ReadLinks(msg.LinkedJson) ?? []).Where(l => !(l.Kind == kind && l.Id == req.Id)).ToList();
        links.Add(new ChatLinkDto(kind, req.Id, f.Key, Text.Truncate(f.Title, 120)!));
        while (JsonSerializer.Serialize(links, JsonSerializerOptions.Web).Length > 1900 && links.Count > 1) links.RemoveAt(0);
        msg.LinkedJson = JsonSerializer.Serialize(links, JsonSerializerOptions.Web);
        await db.SaveChangesAsync(ct);
        var dto = (await ToDtosAsync([msg], ct))[0];
        await PushAsync(tenant, await RecipientsAsync(tenant, msg.ConversationId, ct), ChatEvents.MessageUpdated, new { conversationId = msg.ConversationId, message = dto }, ct);
        return dto;
    }

    // ------------------------------------------------------------------ task and page keys as live cards

    [GeneratedRegex(@"^([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,7})$")] private static partial Regex KeyPattern();

    /// <summary>
    /// What the task (PAY-12) and page (DOC-7) keys in messages are now: title, status, who has it and when it is due. Only what the person
    /// may open is answered; the rest are left out (a key alone tells nothing).
    /// </summary>
    public async Task<IReadOnlyList<ChatUnfurlDto>> UnfurlAsync(IReadOnlyList<string>? keys, CancellationToken ct = default)
    {
        Require();
        var wanted = (keys ?? []).Select(k => (k ?? "").Trim().ToUpperInvariant()).Where(k => KeyPattern().IsMatch(k)).Distinct().Take(30).ToList();
        if (wanted.Count == 0) return [];
        var result = new List<ChatUnfurlDto>();
        var docNumbers = wanted.Where(k => k.StartsWith("DOC-")).Select(k => int.Parse(k[4..])).ToList();
        if (docNumbers.Count > 0 && await permissions.LevelAsync(Modules.Documents, ct) >= AccessLevel.View)
        {
            var docs = await db.Documents.AsNoTracking().Where(d => docNumbers.Contains(d.Number)).Select(d => new { d.Id, d.Number, d.Title, d.Status }).ToListAsync(ct);
            result.AddRange(docs.Select(d => new ChatUnfurlDto($"DOC-{d.Number}", "page", d.Id, d.Title, d.Status.ToString(), null, null, null, false, $"/documents/{d.Id}")));
        }
        var taskKeys = wanted.Where(k => !k.StartsWith("DOC-") && !k.StartsWith("WT-")).Select(k => { var m = KeyPattern().Match(k); return (Project: m.Groups[1].Value, Number: int.Parse(m.Groups[2].Value)); }).ToList();
        if (taskKeys.Count > 0 && await permissions.LevelAsync(Modules.Tasks, ct) >= AccessLevel.View)
        {
            var projectKeys = taskKeys.Select(t => t.Project).Distinct().ToList();
            var numbers = taskKeys.Select(t => t.Number).Distinct().ToList();
            var tasks = await db.Tasks.AsNoTracking().Where(t => projectKeys.Contains(t.Project!.Key.ToUpper()) && numbers.Contains(t.Number))
                .Select(t => new { t.Id, t.Number, ProjectKey = t.Project!.Key, t.ProjectId, t.Title, Status = t.Status!.Name, t.Status.Color, Category = t.Status.Category, Assignee = t.Assignee != null ? t.Assignee.DisplayName : null, t.DueDate })
                .Take(60).ToListAsync(ct);
            foreach (var hit in tasks.Where(x => taskKeys.Contains((x.ProjectKey.ToUpperInvariant(), x.Number))))
                result.Add(new ChatUnfurlDto($"{hit.ProjectKey.ToUpperInvariant()}-{hit.Number}", "task", hit.Id, hit.Title, hit.Status, hit.Color, hit.Assignee, hit.DueDate, hit.Category == StatusCategory.Done,
                    $"/projects/{hit.ProjectId}?task={hit.Id}"));
        }
        return result;
    }
}
