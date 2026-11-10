using System.Globalization;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Agent;
using ProjectManagement.Application.Features.Chat;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Ai;

/// <summary>One thing found by meaning that the reader may open right now: what it is, where it lives and its words (cut to an excerpt by the caller).</summary>
public sealed record AiOpenedSource(string Kind, Guid Id, string Key, string Title, string Link, string Version, DateTime At, Guid? ProjectId, string Text);

/// <summary>
/// Opens a meaning-search hit for the signed-in reader, from the live source and by the same rule that decides who may open it anywhere else
/// in the app: a chat message needs a place in its (not private) conversation, project mail needs the project, and a meeting's minutes or
/// transcript need the project and a part in the meeting. The index only suggests candidates; nothing it holds is ever shown without passing
/// through here. Returns null for anything the reader may not open (or that is gone), never an error, so a hit they may not see is simply left out.
/// </summary>
public class AiSemanticSources(IAppDbContext db, ICurrentContext ctx, ProjectAccess access, PermissionService permissions, ChatService chat,
    ISecretProtector secrets, DocumentMaskingService masking)
{
    public const int MaxText = 16000;
    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);

    public static bool Handles(string kind) => kind is "chat" or "minutes" or "transcript" or "mail";

    public async Task<AiOpenedSource?> OpenAsync(string kind, Guid id, CancellationToken ct)
    {
        try
        {
            if (ctx.UserId is null || ctx.Role is null or TenantRole.Guest) return null;
            return kind switch
            {
                "chat" => await ChatAsync(id, ct),
                "mail" => await MailAsync(id, ct),
                "minutes" or "transcript" => await SessionAsync(kind, id, ct),
                _ => null,
            };
        }
        catch (AppException) { return null; }   // not theirs to see, or no longer there
    }

    private async Task<Func<string, string>> MaskAsync(CancellationToken ct)
    {
        var masker = await masking.MaskerAsync(ct);
        return text => masker is null ? text : masker.MaskText(text);
    }

    private async Task<AiOpenedSource?> ChatAsync(Guid id, CancellationToken ct)
    {
        var m = await db.ChatMessages.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id && x.DeletedAt == null && x.Kind == ChatMessageKind.User && x.Cipher == null, ct);
        if (m is null) return null;
        // The conversation decides: a direct chat or group needs a member row, a project chat the project's audience, a private (end-to-end encrypted) chat nobody.
        var (member, name, _) = await chat.AccessAsync(m.ConversationId, ct);
        if (m.CreatedAt < member.CreatedAt) return null;   // said before they joined
        var sender = m.SenderId is { } s ? await db.Users.AsNoTracking().Where(u => u.Id == s).Select(u => u.DisplayName).FirstOrDefaultAsync(ct) : null;
        var mask = await MaskAsync(ct);
        var link = m.ThreadRootId is { } root ? $"/messages/{m.ConversationId}?thread={root}&m={m.Id}" : $"/messages/{m.ConversationId}?m={m.Id}";
        return new("chat", m.Id, "CHAT", $"{sender ?? "Someone"} in {name}", link, (m.EditedAt ?? m.CreatedAt).Ticks.ToString(CultureInfo.InvariantCulture), m.CreatedAt,
            await db.Conversations.AsNoTracking().Where(c => c.Id == m.ConversationId).Select(c => c.ProjectId).FirstOrDefaultAsync(ct), mask(ChatService.Plain(m.Body)));
    }

    /// <summary>The project, when the reader may open it and works on it (its owner, a member, or an Owner or Admin of the workspace).</summary>
    private async Task<Project?> ProjectOfAsync(Guid projectId, CancellationToken ct)
    {
        if (await permissions.LevelAsync(Modules.Projects, ct) < AccessLevel.View) return null;
        var project = await access.VisibleProjects().AsNoTracking().FirstOrDefaultAsync(p => p.Id == projectId, ct);
        if (project is null) return null;
        var me = ctx.RequireUserId();
        var works = project.OwnerId == me || ctx.Role is TenantRole.Owner or TenantRole.Admin
            || await db.ProjectMembers.AsNoTracking().AnyAsync(x => x.ProjectId == projectId && x.UserId == me, ct);
        return works ? project : null;
    }

    private async Task<AiOpenedSource?> MailAsync(Guid id, CancellationToken ct)
    {
        var s = await db.AgentSignals.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id && x.Source == AgentSourceKind.ProjectMailbox && x.OwnerUserId == null && x.ContentProtected != "", ct);
        if (s is null || await ProjectOfAsync(s.ProjectId, ct) is not { } project) return null;
        var text = Unprotect(s.ContentProtected);
        if (text is null) return null;
        var mask = await MaskAsync(ct);
        return new("mail", s.Id, project.Key, s.Title, $"/work/projects/{project.Id}", s.CreatedAt.Ticks.ToString(CultureInfo.InvariantCulture), s.OccurredAt, project.Id,
            Clip(mask(string.IsNullOrWhiteSpace(s.FromName) ? text : $"From {s.FromName}\n{text}")));
    }

    private async Task<AiOpenedSource?> SessionAsync(string kind, Guid sessionId, CancellationToken ct)
    {
        var bot = await db.AgentMeetingBots.AsNoTracking().FirstOrDefaultAsync(b => b.Id == sessionId, ct);
        if (bot is null || await ProjectOfAsync(bot.ProjectId, ct) is not { } project) return null;
        var me = ctx.RequireUserId();
        // The person who sent the notetaker, or anyone who may see the call it attended: the same rule as the call's notes page.
        var delegated = await db.AgentDelegations.AsNoTracking().AnyAsync(d => d.BotRowId == sessionId && d.UserId == me, ct);
        Guid? callId = null;
        foreach (var call in await db.CallRooms.AsNoTracking().Where(c => c.AgentSessionId == sessionId && !c.IsPrivate).ToListAsync(ct))
        {
            var seen = call.StartedBy == me || await db.CallParticipants.AsNoTracking().AnyAsync(p => p.CallId == call.Id && p.UserId == me, ct)
                || (call.ConversationId is { } cid && await db.ConversationMembers.AsNoTracking().AnyAsync(m => m.ConversationId == cid && m.UserId == me, ct))
                || call.ProjectId == bot.ProjectId;   // a project call: the project was just opened above, by the reader's own access
            if (!seen) continue;
            callId = call.Id; break;
        }
        if (!delegated && callId is null) return null;
        var link = callId is { } c ? $"/calls/{c}" : "/meetings";
        var mask = await MaskAsync(ct);
        if (kind == "minutes")
        {
            var row = await db.MeetingMinutes.AsNoTracking().FirstOrDefaultAsync(m => m.BotRowId == sessionId && m.ContentProtected != "", ct);
            var json = row is null ? null : Unprotect(row.ContentProtected);
            if (row is null || json is null) return null;
            MinutesContent? content;
            try { content = JsonSerializer.Deserialize<MinutesContent>(json, Web); } catch (JsonException) { return null; }
            if (content is null) return null;
            return new("minutes", sessionId, project.Key, string.IsNullOrWhiteSpace(row.Title) ? "Meeting minutes" : row.Title, link,
                (row.UpdatedAt ?? row.CreatedAt).Ticks.ToString(CultureInfo.InvariantCulture), bot.EndedAt ?? bot.SessionEndUtc, project.Id, Clip(mask(AiSemanticIndex.MinutesToText(content))));
        }
        var words = bot.TranscriptProtected is { Length: > 0 } t ? Unprotect(t) : null;
        if (words is null) return null;
        return new("transcript", sessionId, project.Key, bot.Title ?? "Meeting transcript", link, bot.TranscriptLength.ToString(CultureInfo.InvariantCulture),
            bot.EndedAt ?? bot.SessionEndUtc, project.Id, Clip(mask(words)));
    }

    private string? Unprotect(string value)
    {
        try { return secrets.Unprotect(value); }
        catch (System.Security.Cryptography.CryptographicException) { return null; }
    }

    private static string Clip(string text) => text.Length <= MaxText ? text : text[..MaxText];

    /// <summary>
    /// A short stretch of <paramref name="text"/> around the words the question used (the window with the most of them), or its start when none
    /// appear (a match by meaning need not share a word). Cut at a space, with "…" where text was left out.
    /// </summary>
    public static string Excerpt(string text, string query, int max = 280)
    {
        var flat = System.Text.RegularExpressions.Regex.Replace(text ?? "", @"\s+", " ").Trim();
        if (flat.Length <= max) return flat;
        var terms = DocumentRankedSearch.Terms(query ?? "").Select(t => t.ToLowerInvariant()).Distinct().ToList();
        var lower = flat.ToLowerInvariant();
        var start = 0; var best = 0;
        foreach (var term in terms)
            for (var at = lower.IndexOf(term, StringComparison.Ordinal); at >= 0; at = lower.IndexOf(term, at + term.Length, StringComparison.Ordinal))
            {
                var from = Math.Max(0, at - max / 4);
                var window = lower.Substring(from, Math.Min(max, lower.Length - from));
                var score = terms.Count(x => window.Contains(x, StringComparison.Ordinal));
                if (score > best) { best = score; start = from; }
            }
        if (start > 0) { var space = flat.IndexOf(' ', start); if (space >= 0 && space - start < 20) start = space + 1; }
        var end = Math.Min(flat.Length, start + max);
        if (end < flat.Length) { var space = flat.LastIndexOf(' ', end - 1, Math.Min(30, end - start)); if (space > start) end = space; }
        var sb = new StringBuilder();
        if (start > 0) sb.Append('…');
        sb.Append(flat.AsSpan(start, end - start).Trim());
        if (end < flat.Length) sb.Append('…');
        return sb.ToString();
    }
}
