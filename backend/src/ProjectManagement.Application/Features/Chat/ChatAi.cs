using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Chat;

/// <summary>A line of a catch-up that points at the message it came from.</summary>
public record ChatCatchUpItem(string Text, Guid? MessageId, Guid? ConversationId, string? ConversationName, string? Owner = null, string? Due = null);
public record ChatCatchUpDto(string Summary, IReadOnlyList<ChatCatchUpItem> Decisions, IReadOnlyList<ChatCatchUpItem> Questions, IReadOnlyList<ChatCatchUpItem> Actions,
    int Conversations, int Messages, string? Model);
public record ChatCatchUpRequest(Guid? ConversationId);
public record ChatAskRequest(string? Question, Guid? ConversationId);
public record ChatCitationDto(int N, Guid MessageId, Guid ConversationId, string ConversationName, string? SenderName, DateTime At, string Snippet, Guid? ThreadRootId);
public record ChatAskDto(string Answer, IReadOnlyList<ChatCitationDto> Citations, int Searched, bool Found, string? Model);
public record ChatRepliesDto(IReadOnlyList<string> Replies, string? Model);
public record ChatExtractRequest(string Kind);
/// <summary>The fields of a task, ticket, reminder or page filled from a message, for the person to check before it is made.</summary>
public record ChatExtractDto(string Kind, string Title, string Description, DateOnly? Due, string? Priority, Guid? AssigneeId, string? AssigneeName, Guid? ProjectId, bool ByAi);
public record ChatTransformRequest(string? Text, string? Action, string? Language);

/// <summary>
/// AI in chat, for people who would rather not read everything or write everything: "catch me up" on what they missed (decisions, questions
/// to them, actions, each linked to its message), ask the chat with answers cited to messages, three short replies to choose from, the
/// fields of a task / ticket / reminder / page filled from a message, and rewrite or translate (Telugu, Hindi, English) what they write.
/// The model only reads conversations the person is in, with personal data masked; every call spends the workspace's AI credits.
/// </summary>
public partial class ChatAiService(ChatService chat, IAppDbContext db, ICurrentContext ctx, DocumentAiService ai, DocumentMaskingService masking, Recorder recorder, AppClock clock)
{
    private const int MaxCatchUpMessages = 300, PerConversation = 60, MaxAskHits = 40;

    private static string Cut(string s, int max) => s.Length <= max ? s : s[..max];

    private sealed record Line(int N, Guid MessageId, Guid ConversationId, string ConversationName, string? Sender, DateTime At, string Text, Guid? ThreadRootId);

    private async Task<Func<string, string>> MaskAsync(CancellationToken ct)
    {
        var masker = await masking.MaskerAsync(ct);
        return text => masker is null ? text : masker.MaskText(text);
    }

    private static string? StripJson(string text)
    {
        var t = text.Trim();
        var m = Regex.Match(t, @"\{[\s\S]*\}|\[[\s\S]*\]");
        return m.Success ? m.Value : null;
    }

    // ------------------------------------------------------------------ catch me up

    /// <summary>What the person has not read yet - in one conversation or in all of them (muted ones left out) - summed up with links.</summary>
    public async Task<ChatCatchUpDto> CatchUpAsync(ChatCatchUpRequest req, CancellationToken ct = default)
    {
        var (_, me) = chat.Who();
        var conversations = new List<(Guid Id, string Name, DateTime Since)>();
        if (req.ConversationId is { } one)
        {
            var (member, name, _) = await chat.AccessAsync(one, ct);
            conversations.Add((one, name, member.LastReadAt));
        }
        else
        {
            var rows = await db.ConversationMembers.AsNoTracking().Where(m => m.UserId == me && !m.IsMuted)
                .Join(db.Conversations.AsNoTracking(), m => m.ConversationId, c => c.Id, (m, c) => new { c.Id, c.LastMessageAt, m.LastReadAt, c.LastMessageSenderId })
                .Where(x => x.LastMessageAt > x.LastReadAt && x.LastMessageSenderId != me).OrderByDescending(x => x.LastMessageAt).Take(25).ToListAsync(ct);
            foreach (var r in rows)
            {
                try { var (member, name, _) = await chat.AccessAsync(r.Id, ct); conversations.Add((r.Id, name, member.LastReadAt)); }
                catch (NotFoundException) { /* no longer in it */ }
            }
        }
        var mask = await MaskAsync(ct);
        var lines = new List<Line>();
        foreach (var (id, name, since) in conversations)
        {
            var msgs = await db.ChatMessages.AsNoTracking().Where(m => m.ConversationId == id && m.CreatedAt > since && m.DeletedAt == null && m.SenderId != me
                    && (m.Kind == ChatMessageKind.User || m.Kind == ChatMessageKind.Poll || (m.Kind == ChatMessageKind.System && m.Body.StartsWith("Decision"))))
                .OrderByDescending(m => m.CreatedAt).Take(PerConversation).ToListAsync(ct);
            var senders = await db.Users.AsNoTracking().Where(u => msgs.Select(m => m.SenderId).Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
            var voice = await db.ChatAttachments.AsNoTracking().Where(a => a.IsVoice && a.Transcript != null && a.MessageId != null && msgs.Select(m => m.Id).Contains(a.MessageId.Value))
                .Select(a => new { MessageId = a.MessageId!.Value, a.Transcript }).ToListAsync(ct);
            foreach (var m in msgs.OrderBy(x => x.CreatedAt))
            {
                var words = ChatService.Plain(m.Body);
                var heard = string.Join(" ", voice.Where(v => v.MessageId == m.Id).Select(v => v.Transcript));
                if (heard.Length > 0) words = (words + " (voice note: " + heard + ")").Trim();
                if (words.Length == 0) continue;
                lines.Add(new Line(lines.Count + 1, m.Id, id, name, m.SenderId is { } s ? senders.GetValueOrDefault(s) : null, m.CreatedAt, mask(Cut(words, 600)), m.ThreadRootId));
            }
            if (lines.Count >= MaxCatchUpMessages) break;
        }
        if (lines.Count == 0)
            return new ChatCatchUpDto("You are all caught up: nothing new from anyone.", [], [], [], conversations.Count, 0, null);
        await ai.EnsureAiAsync(ct);
        var myName = await db.Users.AsNoTracking().Where(u => u.Id == me).Select(u => u.DisplayName).FirstAsync(ct);
        var sb = new StringBuilder();
        foreach (var l in lines.Take(MaxCatchUpMessages))
            sb.AppendLine($"[{l.N}] {l.ConversationName} · {l.Sender ?? "System"} · {l.At:dd MMM HH:mm}{(l.ThreadRootId is null ? "" : " (in a thread)")}: {l.Text}");
        var system = "You catch a busy person up on the team chat messages they have not read. The person is " + myName + ". " +
                     "Reply with JSON only, no prose before or after, in this shape: " +
                     "{\"summary\":\"two to four plain sentences\",\"decisions\":[{\"text\":\"\",\"ref\":1}],\"questions\":[{\"text\":\"a question put to " + myName + "\",\"ref\":2}]," +
                     "\"actions\":[{\"text\":\"\",\"owner\":\"name or null\",\"due\":\"date or null\",\"ref\":3}]}. " +
                     "ref is the number of the message it comes from. Questions are only those asked of " + myName + " (by name, @mention or in their private chat). " +
                     "Use only what the messages say; leave a list empty when there is nothing for it. Write in the language most of the messages use.";
        var answer = await ai.AskModelAsync("chat_catchup", system, Cut(sb.ToString(), DocumentAiService.MaxContext), 1200, 2, ct);
        var result = Parse(answer.Text, lines, conversations.Count, answer.Model);
        recorder.Audit("ai.used", "Chat", req.ConversationId, null, new { feature = "chat_catchup", conversations = conversations.Count, messages = lines.Count });
        await db.SaveChangesAsync(ct);
        return result;
    }

    private static ChatCatchUpDto Parse(string text, List<Line> lines, int conversations, string model)
    {
        string summary = "";
        var decisions = new List<ChatCatchUpItem>(); var questions = new List<ChatCatchUpItem>(); var actions = new List<ChatCatchUpItem>();
        try
        {
            using var doc = JsonDocument.Parse(StripJson(text) ?? "{}");
            var root = doc.RootElement;
            summary = root.TryGetProperty("summary", out var s) && s.ValueKind == JsonValueKind.String ? s.GetString() ?? "" : "";
            ChatCatchUpItem? Item(JsonElement e)
            {
                var t = e.TryGetProperty("text", out var tt) && tt.ValueKind == JsonValueKind.String ? tt.GetString() : null;
                if (string.IsNullOrWhiteSpace(t)) return null;
                Line? l = e.TryGetProperty("ref", out var r) && r.TryGetInt32(out var n) ? lines.FirstOrDefault(x => x.N == n) : null;
                string? Str(string name) => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String && !string.Equals(v.GetString(), "null", StringComparison.OrdinalIgnoreCase) ? v.GetString() : null;
                return new ChatCatchUpItem(Cut(t.Trim(), 400), l?.MessageId, l?.ConversationId, l?.ConversationName, Str("owner"), Str("due"));
            }
            void Fill(string name, List<ChatCatchUpItem> into)
            {
                if (!root.TryGetProperty(name, out var arr) || arr.ValueKind != JsonValueKind.Array) return;
                foreach (var e in arr.EnumerateArray().Take(12)) if (e.ValueKind == JsonValueKind.Object && Item(e) is { } i) into.Add(i);
            }
            Fill("decisions", decisions); Fill("questions", questions); Fill("actions", actions);
        }
        catch (JsonException) { summary = Cut(text.Trim(), 1200); }
        if (summary.Length == 0) summary = $"{lines.Count} new message{(lines.Count == 1 ? "" : "s")} in {conversations} conversation{(conversations == 1 ? "" : "s")}.";
        return new ChatCatchUpDto(summary, decisions, questions, actions, conversations, lines.Count, model);
    }

    // ------------------------------------------------------------------ ask the chat

    /// <summary>An answer from the messages of conversations the person is in (one, or all), cited to the messages it came from.</summary>
    public async Task<ChatAskDto> AskAsync(ChatAskRequest req, CancellationToken ct = default)
    {
        var (_, me) = chat.Who();
        var question = (req.Question ?? "").Trim();
        if (question.Length < 3) throw new ValidationException("question", "Ask a question.");
        if (question.Length > DocumentAiService.MaxQuestion) throw new ValidationException("question", $"Keep the question under {DocumentAiService.MaxQuestion} characters.");
        await ai.EnsureAiAsync(ct);
        var terms = DocumentRankedSearch.Terms(question);
        var convIds = new List<Guid>();
        if (req.ConversationId is { } one) { await chat.AccessAsync(one, ct); convIds.Add(one); }
        else convIds = await db.ConversationMembers.AsNoTracking().Where(m => m.UserId == me).Select(m => m.ConversationId).Take(400).ToListAsync(ct);
        var allowed = new Dictionary<Guid, (DateTime Since, string Name)>();
        foreach (var id in convIds)
        {
            try { var (member, name, _) = await chat.AccessAsync(id, ct); allowed[id] = (member.CreatedAt, name); }
            catch (NotFoundException) { /* not in it any more */ }
        }
        if (terms.Count == 0 || allowed.Count == 0) return new ChatAskDto("Ask with a few more specific words (a name, a topic, a number).", [], 0, false, null);
        var ids = allowed.Keys.ToList();
        var from = clock.Now.AddDays(-365);
        var q = db.ChatMessages.AsNoTracking().Where(m => ids.Contains(m.ConversationId) && m.DeletedAt == null && m.CreatedAt > from && m.Kind != ChatMessageKind.Meeting);
        var lowered = terms.Select(t => t.ToLowerInvariant()).ToList();
        var hits = new List<ChatMessage>();
        foreach (var t in lowered)
            hits.AddRange(await q.Where(m => m.Body.ToLower().Contains(t)).OrderByDescending(m => m.CreatedAt).Take(60).ToListAsync(ct));
        var ranked = hits.DistinctBy(m => m.Id).Where(m => m.CreatedAt >= allowed[m.ConversationId].Since)
            .Select(m => (m, score: lowered.Count(t => m.Body.Contains(t, StringComparison.OrdinalIgnoreCase)) * 10 + (m.CreatedAt - from).TotalDays / 365))
            .OrderByDescending(x => x.score).Take(MaxAskHits).Select(x => x.m).OrderBy(m => m.CreatedAt).ToList();
        if (ranked.Count == 0) return new ChatAskDto("Nothing in your conversations mentions that. Try other words.", [], 0, false, null);
        var senders = await db.Users.AsNoTracking().Where(u => ranked.Select(m => m.SenderId).Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        var mask = await MaskAsync(ct);
        var sb = new StringBuilder();
        for (var i = 0; i < ranked.Count; i++)
        {
            var m = ranked[i];
            sb.AppendLine($"[{i + 1}] {allowed[m.ConversationId].Name} · {(m.SenderId is { } s ? senders.GetValueOrDefault(s) : "System")} · {m.CreatedAt:dd MMM yyyy}: {mask(Cut(ChatService.Plain(m.Body), 700))}");
        }
        var system = "You answer a question from a company's chat messages, using only the numbered messages given. Answer in one to four sentences, in the language of " +
                     "the question. After every statement put the number of the message it comes from, like [3]. If the messages do not answer it, say so plainly.";
        var answer = await ai.AskModelAsync("chat_ask", system, $"Question: {question}\n\nMessages:\n{sb}", 700, 2, ct);
        var used = Regex.Matches(answer.Text, @"\[(\d{1,2})\]").Select(x => int.Parse(x.Groups[1].Value, CultureInfo.InvariantCulture)).Where(n => n >= 1 && n <= ranked.Count).Distinct().OrderBy(n => n).ToList();
        var citations = used.Select(n =>
        {
            var m = ranked[n - 1];
            return new ChatCitationDto(n, m.Id, m.ConversationId, allowed[m.ConversationId].Name, m.SenderId is { } s ? senders.GetValueOrDefault(s) : null, m.CreatedAt,
                mask(Cut(ChatService.Plain(m.Body), 200)), m.ThreadRootId);
        }).ToList();
        recorder.Audit("ai.used", "Chat", req.ConversationId, null, new { feature = "chat_ask", searched = ranked.Count, cited = citations.Count });
        await db.SaveChangesAsync(ct);
        return new ChatAskDto(answer.Text.Trim(), citations, ranked.Count, citations.Count > 0, answer.Model);
    }

    // ------------------------------------------------------------------ smart replies

    /// <summary>Three short replies to a message, in its language, from what was said just before it.</summary>
    public async Task<ChatRepliesDto> RepliesAsync(Guid messageId, CancellationToken ct = default)
    {
        var (_, me) = chat.Who();
        var msg = await db.ChatMessages.AsNoTracking().FirstOrDefaultAsync(m => m.Id == messageId, ct) ?? throw new NotFoundException("This message was not found.", "MESSAGE_NOT_FOUND");
        var (member, _, _) = await chat.AccessAsync(msg.ConversationId, ct);
        if (msg.DeletedAt is not null || msg.Kind != ChatMessageKind.User) throw new ValidationException("messageId", "Choose a message to reply to.");
        await ai.EnsureAiAsync(ct);
        var before = await db.ChatMessages.AsNoTracking().Where(m => m.ConversationId == msg.ConversationId && m.ThreadRootId == msg.ThreadRootId && m.CreatedAt <= msg.CreatedAt
                && m.CreatedAt >= member.CreatedAt && m.DeletedAt == null && m.Kind == ChatMessageKind.User).OrderByDescending(m => m.CreatedAt).Take(8).ToListAsync(ct);
        var names = await db.Users.AsNoTracking().Where(u => before.Select(m => m.SenderId).Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        var mask = await MaskAsync(ct);
        var sb = new StringBuilder();
        foreach (var m in before.OrderBy(x => x.CreatedAt))
            sb.AppendLine($"{(m.SenderId == me ? "Me" : m.SenderId is { } s ? names.GetValueOrDefault(s) ?? "Someone" : "Someone")}: {mask(Cut(ChatService.Plain(m.Body), 500))}");
        var system = "Suggest three different short replies (each under 12 words) that the person called Me could send to the last message. Make them natural, polite and " +
                     "useful at work: for example agree, ask a follow-up, or give a time. Use the language of the last message. Reply with a JSON array of three strings only.";
        var answer = await ai.AskModelAsync("chat_reply", system, sb.ToString(), 200, 1, ct);
        var replies = new List<string>();
        try
        {
            using var doc = JsonDocument.Parse(StripJson(answer.Text) ?? "[]");
            if (doc.RootElement.ValueKind == JsonValueKind.Array)
                replies = doc.RootElement.EnumerateArray().Where(e => e.ValueKind == JsonValueKind.String).Select(e => Cut(e.GetString()!.Trim(), 160)).Where(r => r.Length > 0).Take(3).ToList();
        }
        catch (JsonException) { replies = answer.Text.Split('\n').Select(l => l.Trim().TrimStart('-', '*', '1', '2', '3', '.', ' ').Trim('"')).Where(l => l.Length > 0).Take(3).ToList(); }
        return new ChatRepliesDto(replies, answer.Model);
    }

    // ------------------------------------------------------------------ message → task / ticket / reminder / page

    private static readonly string[] Kinds = ["task", "ticket", "reminder", "page"];
    private static readonly string[] Priorities = ["Low", "Medium", "High", "Urgent"];

    /// <summary>
    /// The fields of a task, ticket, reminder or page filled from a message: a short title, the message as the description, a due date and a
    /// priority if it says so, and the person it names (one of the conversation's people). With AI on, the model reads the message; without
    /// it, the first line becomes the title. Nothing is created here: the person checks the fields first.
    /// </summary>
    public async Task<ChatExtractDto> ExtractAsync(Guid messageId, ChatExtractRequest req, CancellationToken ct = default)
    {
        var (_, me) = chat.Who();
        var kind = (req.Kind ?? "").Trim().ToLowerInvariant();
        if (!Kinds.Contains(kind)) throw new ValidationException("kind", "Make a task, ticket, reminder or page.");
        var msg = await db.ChatMessages.AsNoTracking().FirstOrDefaultAsync(m => m.Id == messageId, ct) ?? throw new NotFoundException("This message was not found.", "MESSAGE_NOT_FOUND");
        await chat.AccessAsync(msg.ConversationId, ct);
        if (msg.DeletedAt is not null) throw new ValidationException("messageId", "This message was deleted.");
        var projectId = await db.Conversations.AsNoTracking().Where(c => c.Id == msg.ConversationId).Select(c => c.ProjectId).FirstAsync(ct);
        var plain = ChatService.Plain(msg.Body);
        var transcript = string.Join(" ", await db.ChatAttachments.AsNoTracking().Where(a => a.MessageId == msg.Id && a.Transcript != null).Select(a => a.Transcript!).ToListAsync(ct));
        if (transcript.Length > 0) plain = (plain + "\n" + transcript).Trim();
        var description = Cut(plain, 4000);
        var firstLine = plain.Split('\n').Select(l => l.Trim()).FirstOrDefault(l => l.Length > 0) ?? "From chat";
        var fallback = new ChatExtractDto(kind, Cut(firstLine, 120), description, null, null, null, null, projectId, false);

        // People who could own it: the conversation's people (a project chat: its team).
        var people = await db.ConversationMembers.AsNoTracking().Where(m => m.ConversationId == msg.ConversationId).Select(m => new { m.UserId, m.User!.DisplayName }).ToListAsync(ct);
        try { await ai.EnsureAiAsync(ct); }
        catch (AppException) { return fallback; }   // no AI here: the first line is the title, the person fills the rest
        var mask = await MaskAsync(ct);
        var today = clock.Today;
        var system = $"Read a chat message and fill the fields of a {kind} made from it. Today is {today:yyyy-MM-dd} ({today.DayOfWeek}). Reply with JSON only: " +
                     "{\"title\":\"a short action title, under 10 words, in the message's language\",\"due\":\"yyyy-mm-dd or null\",\"priority\":\"Low|Medium|High|Urgent or null\"," +
                     "\"assignee\":\"the name of the person who should do it, from the list, or null\"}. Use only what the message says; a due date only when it gives one " +
                     "(\"by Friday\" is the coming Friday). People: " + string.Join(", ", people.Select(p => p.DisplayName));
        var answer = await ai.AskModelAsync("chat_extract", system, mask(Cut(plain, 3000)), 250, 1, ct);
        try
        {
            using var doc = JsonDocument.Parse(StripJson(answer.Text) ?? "{}");
            var r = doc.RootElement;
            string? Str(string name) => r.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String && !string.Equals(v.GetString(), "null", StringComparison.OrdinalIgnoreCase) ? v.GetString()?.Trim() : null;
            var title = Str("title") is { Length: > 0 } t ? Cut(t, 120) : fallback.Title;
            DateOnly? due = DateOnly.TryParseExact(Str("due") ?? "", "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d) && d >= today.AddDays(-1) && d <= today.AddYears(2) ? d : null;
            var priority = Priorities.FirstOrDefault(p => string.Equals(p, Str("priority"), StringComparison.OrdinalIgnoreCase));
            var who = Str("assignee");
            var owner = who is null ? null : people.FirstOrDefault(p => string.Equals(p.DisplayName, who, StringComparison.OrdinalIgnoreCase))
                ?? people.FirstOrDefault(p => p.DisplayName.Split(' ')[0].Equals(who.Split(' ')[0], StringComparison.OrdinalIgnoreCase));
            recorder.Audit("ai.used", "Chat", msg.ConversationId, null, new { feature = "chat_extract", kind });
            await db.SaveChangesAsync(ct);
            return new ChatExtractDto(kind, title, description, due, priority, owner?.UserId, owner?.DisplayName, projectId, true);
        }
        catch (JsonException) { return fallback; }
    }

    // ------------------------------------------------------------------ rewrite and translate what I write, or a message I read

    /// <summary>Rewrite, shorten, fix, a tone, or translate (Telugu, Hindi, English) - for the message being written or one being read.</summary>
    public async Task<DocTransformDto> TransformAsync(ChatTransformRequest req, CancellationToken ct = default)
    {
        chat.Who();
        return await ai.TransformAsync(new DocTransformRequest(req.Text ?? "", req.Action ?? "", req.Language), ct);
    }
}
