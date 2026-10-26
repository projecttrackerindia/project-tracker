using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Chat;
using ProjectManagement.Application.Features.Mailbox;
using ProjectManagement.Application.Features.ProjectMeetings;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Talk;

/// <summary>How a row in Talk is drawn: initials (or the person's photo), round for people, a rounded square for meetings.</summary>
public record TalkAvatarDto(string Initials, Guid? UserId, bool HasAvatar, bool Square);

/// <summary>
/// One conversation in Talk: a chat (direct, group or project), a mail thread, or a meeting. <see cref="Id"/> is unique across kinds:
/// a chat is its conversation id (so old /chat/{id} links keep working), a mail thread is "mail:{message id}" and a meeting is
/// "meet:{ref}" (p:{id} or w:{id}). The kind-specific fields say how to open it.
/// </summary>
public record TalkConversationDto(string Id, string Kind, string Title, string? Sub, string? Last, DateTimeOffset? At, int Unread, TalkAvatarDto Avatar,
    bool Group = false, string? Account = null, string? MessageId = null, string? MeetingRef = null, DateTimeOffset? SessionStart = null, bool Live = false,
    bool Upcoming = false, string? JoinUrl = null);

/// <summary>Whether this person's mail can show in Talk: connected (with the account), not connected yet, or unavailable right now.</summary>
public record TalkMailStateDto(string State, string? Account, string? Email, string? Provider);

public record TalkListDto(IReadOnlyList<TalkConversationDto> Items, TalkMailStateDto Mail, bool ChatAvailable);

/// <summary>
/// Talk: chat, mail and meetings in one list. Each source keeps its own endpoints for the thread itself; this only merges the lists so a
/// person sees one place to talk. Mail is read live from the person's own mailbox (never stored here) and may be slow or down: it has a
/// short time limit and Talk still answers without it.
/// </summary>
public class TalkService(ChatService chat, MailboxService mailbox, MeetFeedService meet, ICurrentContext ctx, AppClock clock, ILogger<TalkService> log)
{
    public static readonly TimeSpan MailTimeLimit = TimeSpan.FromSeconds(6);
    private const int MailRows = 25;

    public async Task<TalkListDto> ListAsync(string? filter, CancellationToken ct = default)
    {
        ctx.RequireTenantId();
        var f = (filter ?? "all").Trim().ToLowerInvariant();
        if (f is not ("all" or "chat" or "mail" or "meetings")) f = "all";
        var now = clock.Now;
        var rows = new List<(TalkConversationDto Row, DateTime Sort)>();

        var chatAvailable = true;
        if (f is "all" or "chat")
        {
            try
            {
                foreach (var c in await chat.ListAsync(ct)) rows.Add((Chat(c), c.LastActivityAt));
            }
            catch (ForbiddenException) { chatAvailable = false; }   // a personal space or a guest: no chat, the rest still shows
        }

        if (f is "all" or "meetings")
        {
            var feed = await meet.FeedAsync(new DateTimeOffset(now.AddDays(-2), TimeSpan.Zero), new DateTimeOffset(now.AddDays(14), TimeSpan.Zero), null, ct);
            // One row per meeting: a repeating meeting shows its next session (or, when all are past, the latest one).
            foreach (var g in feed.Items.Where(i => i.Status != "Cancelled").GroupBy(i => i.Ref))
            {
                var next = g.Where(i => i.End.UtcDateTime >= now).OrderBy(i => i.Start).FirstOrDefault() ?? g.OrderByDescending(i => i.Start).First();
                rows.Add((Meeting(next, now), MeetingSort(next, now)));
            }
        }

        var mail = new TalkMailStateDto("not-connected", null, null, null);
        if (f is "all" or "mail")
        {
            var (state, items) = await MailAsync(ct);
            mail = state;
            rows.AddRange(items.Select(i => (i, i.At?.UtcDateTime ?? DateTime.MinValue)));
        }

        var list = rows.OrderByDescending(r => r.Sort).Select(r => r.Row).ToList();
        return new TalkListDto(list, mail, chatAvailable);
    }

    private static TalkConversationDto Chat(ConversationDto c)
    {
        var group = c.Type != ConversationType.Direct;
        var other = group ? null : c.Members.FirstOrDefault(m => m.UserId == c.OtherUserId);
        var last = c.LastMessage is null ? null
            : c.LastMessage.IsMine ? $"You: {c.LastMessage.Snippet}"
            : group && !c.LastMessage.IsSystem && c.LastMessage.SenderName is { Length: > 0 } who ? $"{who.Split(' ')[0]}: {c.LastMessage.Snippet}"
            : c.LastMessage.Snippet;
        var sub = c.Type switch { ConversationType.Project => "Project chat", ConversationType.Group => "Group", _ => null };
        return new TalkConversationDto(c.Id.ToString(), "chat", c.Name, sub, last, new DateTimeOffset(c.LastActivityAt, TimeSpan.Zero), c.Unread,
            new TalkAvatarDto(Initials(c.Name), other?.UserId, other?.HasAvatar ?? false, false), Group: group);
    }

    private static TalkConversationDto Meeting(MeetItemDto m, DateTime now)
    {
        var upcoming = m.End.UtcDateTime >= now;
        var parts = new List<string> { "Meeting" };
        if (m.ProjectName is { Length: > 0 } project) parts.Add(project);
        var notes = m.Notes is { Length: > 0 } ? "Notes ready" : m.Notetaker is "transcript" or "voice" ? "Notes and actions by AI" : null;
        if (notes is not null) parts.Add(notes);
        return new TalkConversationDto($"meet:{m.Ref}", "meeting", m.Title, string.Join(" · ", parts), m.ProviderName, m.Start, 0,
            new TalkAvatarDto(Initials(m.Title), null, false, true), MeetingRef: m.Ref, SessionStart: m.Start, Live: m.Live, Upcoming: upcoming, JoinUrl: m.JoinUrl);
    }

    /// <summary>
    /// Where a meeting sits among conversations: one happening now or in the next day sits with the most recent chats; one further ahead
    /// sinks the further away it is; a past one sits at its start time.
    /// </summary>
    private static DateTime MeetingSort(MeetItemDto m, DateTime now)
    {
        var start = m.Start.UtcDateTime;
        if (m.Live || (start >= now && start - now <= TimeSpan.FromDays(1))) return now;
        return start > now ? now - (start - now) : start;
    }

    /// <summary>The newest threads of the person's first mailbox (company mail, then Gmail, then Outlook), within the time limit.</summary>
    private async Task<(TalkMailStateDto State, IReadOnlyList<TalkConversationDto> Items)> MailAsync(CancellationToken ct)
    {
        string? account = null, email = null, provider = null;
        try
        {
            var accounts = await mailbox.AccountsAsync(ct);
            if (accounts.Imap.FirstOrDefault() is { } imap) { account = $"imap:{imap.Id}"; email = imap.Email; provider = imap.Provider; }
        }
        catch (AppException) { /* no mailbox for this person here */ }

        var candidates = account is null ? new[] { "google", "microsoft" } : new[] { account };
        foreach (var candidate in candidates)
        {
            using var limit = CancellationTokenSource.CreateLinkedTokenSource(ct);
            limit.CancelAfter(MailTimeLimit);
            try
            {
                var page = await mailbox.ListAsync(candidate, "inbox", null, null, limit.Token);
                var rows = page.Messages.GroupBy(m => string.IsNullOrEmpty(m.ThreadId) ? m.Id : m.ThreadId)
                    .Select(g => g.OrderByDescending(m => m.Date).First())
                    .OrderByDescending(m => m.Date).Take(MailRows)
                    .Select(m => Mail(page.Account, m)).ToList();
                return (new TalkMailStateDto("connected", page.Account, page.Email, provider ?? candidate), rows);
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                return (new TalkMailStateDto("unavailable", candidate, email, provider ?? candidate), []);
            }
            catch (AppException) when (account is null) { /* this provider is not connected: try the next */ }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                log.LogInformation("Talk could not read the mailbox: {Error}", ex.GetType().Name);
                return (new TalkMailStateDto("unavailable", candidate, email, provider ?? candidate), []);
            }
        }
        return (new TalkMailStateDto("not-connected", null, null, null), []);
    }

    private static TalkConversationDto Mail(string account, MailMessageDto m)
    {
        var from = SenderName(m.From);
        return new TalkConversationDto($"mail:{m.Id}", "mail", from, "Mail", string.IsNullOrWhiteSpace(m.Subject) ? "(no subject)" : m.Subject, m.Date,
            m.Unread ? 1 : 0, new TalkAvatarDto(Initials(from), null, false, false), Account: account, MessageId: m.Id);
    }

    /// <summary>"Asha Rao &lt;asha@x.com&gt;" → "Asha Rao"; a bare address stays as it is.</summary>
    public static string SenderName(string from)
    {
        var text = (from ?? "").Trim();
        var lt = text.IndexOf('<');
        if (lt > 0) { var name = text[..lt].Trim().Trim('"').Trim(); if (name.Length > 0) return name; }
        return text.Trim('<', '>', ' ');
    }

    public static string Initials(string name)
    {
        var words = (name ?? "").Split([' ', '.', '_', '-', '@'], StringSplitOptions.RemoveEmptyEntries).Where(w => char.IsLetterOrDigit(w[0])).ToArray();
        if (words.Length == 0) return "?";
        return words.Length == 1 ? words[0][..Math.Min(2, words[0].Length)].ToUpperInvariant() : $"{char.ToUpperInvariant(words[0][0])}{char.ToUpperInvariant(words[1][0])}";
    }
}
