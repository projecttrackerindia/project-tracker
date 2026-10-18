using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Integrations;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Agent;

/// <summary>
/// What the project agent reads, kept until it has read it: mail to the project's address, a stretch of project chat, a meeting transcript,
/// mail from a person's own inbox (only theirs, only when they opted in). The text is stored encrypted and never logged.
/// </summary>
public class AgentSignalService(IAppDbContext db, ICurrentContext ctx, AppClock clock, ISecretProtector secrets, ProjectAccess access,
    AgentSettingsService settings, Recorder recorder, IOptions<AgentOptions> options)
{
    public const int MaxContent = 60_000;
    /// <summary>A long transcript is kept as up to this many consecutive parts, each read on its own.</summary>
    public const int MaxParts = 4;
    private const int MailPerDay = 300;

    private static readonly Regex Space = new(@"[ \t]+", RegexOptions.CultureInvariant);
    private static readonly Regex Lines = new(@"\n{3,}", RegexOptions.CultureInvariant);

    public static string Clean(string? text)
    {
        var t = (text ?? "").Replace("\r\n", "\n").Replace('\r', '\n');
        t = new string(t.Where(c => c == '\n' || c == '\t' || !char.IsControl(c)).ToArray());
        t = Lines.Replace(Space.Replace(t, " "), "\n\n").Trim();
        return t.Length > MaxContent * MaxParts ? t[..(MaxContent * MaxParts)] + "\n[… cut here: the rest was too long]" : t;
    }

    public static string Hash(string text) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text)))[..32].ToLowerInvariant();

    /// <summary>Adds a signal to the current unit of work (the caller saves), unless the same one is already there. Null when nothing was added.</summary>
    public async Task<AgentSignal?> AddAsync(Guid tenantId, Guid projectId, AgentSourceKind source, string sourceRef, string title, string? from, string content,
        DateTime occurredAt, Guid? ownerUserId, Guid? meetingId, CancellationToken ct)
    {
        var text = Clean(content);
        if (text.Length < 10) return null;
        sourceRef = sourceRef.Length > 300 ? sourceRef[..300] : sourceRef;
        if (await db.AgentSignals.IgnoreQueryFilters().AnyAsync(s => s.ProjectId == projectId && s.Source == source && s.SourceRef == sourceRef, ct)) return null;
        if (db.AgentSignals.Local.Any(s => s.ProjectId == projectId && s.Source == source && s.SourceRef == sourceRef)) return null;
        // A long meeting is split at line breaks into consecutive parts, so nothing at its end is dropped.
        var parts = new List<string>();
        for (var rest = text; rest.Length > 0;)
        {
            if (rest.Length <= MaxContent) { parts.Add(rest); break; }
            var cut = rest.LastIndexOf('\n', MaxContent - 1);
            if (cut < MaxContent / 2) cut = MaxContent;
            parts.Add(rest[..cut]); rest = rest[cut..].TrimStart();
        }
        AgentSignal? first = null;
        for (var i = 0; i < parts.Count; i++)
        {
            var signal = new AgentSignal
            {
                TenantId = tenantId, ProjectId = projectId, Source = source, SourceRef = i == 0 ? sourceRef : $"{sourceRef[..Math.Min(sourceRef.Length, 290)]}#{i + 1}",
                Title = Text.Truncate(parts.Count == 1 ? title.Trim() : $"{title.Trim()} (part {i + 1} of {parts.Count})", 300) ?? "",
                FromName = Text.Truncate(from?.Trim(), 200), ContentProtected = secrets.Protect(parts[i]), Length = parts[i].Length,
                OccurredAt = occurredAt.AddTicks(i), OwnerUserId = ownerUserId, MeetingId = meetingId, CreatedAt = clock.Now,
            };
            db.AgentSignals.Add(signal);
            first ??= signal;
        }
        return first;
    }

    public string Read(AgentSignal s) => secrets.Unprotect(s.ContentProtected);

    // ---------------------------------------------------------------- a transcript or notes pasted by a person

    public async Task<AgentSignal> AddTranscriptAsync(Guid projectId, AgentTranscriptRequest req, CancellationToken ct = default)
    {
        var project = await access.GetProjectAsync(projectId, ct);
        if (!await settings.CanManageAsync(project, ct)) throw new ForbiddenException("Only people who may edit this project can give the agent a transcript.", "PERMISSION_DENIED");
        var text = (req.Text ?? "").Trim();
        if (text.Length < 40) throw new ValidationException("text", "Paste the transcript or notes (at least a few sentences).");
        if (text.Length > 200_000) throw new ValidationException("text", "Keep the transcript under 200,000 characters.");
        var title = string.IsNullOrWhiteSpace(req.Title) ? $"Meeting notes · {clock.Now:dd MMM}" : req.Title.Trim();
        if (title.Length > 200) throw new ValidationException("title", "Keep the title to 200 characters.");
        Guid? meetingId = null;
        if (req.MeetingId is { } mid)
        {
            if (!await db.ProjectMeetings.AnyAsync(m => m.Id == mid && m.ProjectId == projectId, ct)) throw new ValidationException("meetingId", "That meeting is not in this project.");
            meetingId = mid;
        }
        var source = meetingId is null ? AgentSourceKind.Manual : AgentSourceKind.MeetingTranscript;
        var signal = await AddAsync(project.TenantId, projectId, source, $"manual:{Hash(text)}", title, null, Transcripts.Normalize(text), clock.Now, null, meetingId, ct)
            ?? throw new ConflictException("The agent already has this transcript.", "AGENT_DUPLICATE_SIGNAL");
        recorder.Audit("agent.transcript_added", "Project", projectId, null, new { signal.Length, meetingId });
        await db.SaveChangesAsync(ct);
        return signal;
    }

    // ---------------------------------------------------------------- the project chat

    /// <summary>
    /// New project chat becomes one signal once the conversation has been quiet for a while (so a discussion is read as a whole). Runs in the
    /// project's workspace context; returns whether a signal was added.
    /// </summary>
    public async Task<bool> CollectChatAsync(ProjectAgentSettings s, CancellationToken ct)
    {
        var conversation = await db.Conversations.AsNoTracking().Where(c => c.Type == ConversationType.Project && c.ProjectId == s.ProjectId)
            .Select(c => new { c.Id, c.LastMessageAt }).FirstOrDefaultAsync(ct);
        if (conversation is null) return false;
        var since = s.ChatReadUntil ?? s.CreatedAt;
        if (conversation.LastMessageAt <= since) return false;
        var quiet = clock.Now.AddMinutes(-Math.Max(1, options.Value.ChatQuietMinutes));
        var messages = await db.ChatMessages.AsNoTracking()
            .Where(m => m.ConversationId == conversation.Id && m.CreatedAt > since && m.Kind == ChatMessageKind.User && m.DeletedAt == null)
            .OrderBy(m => m.CreatedAt).Take(301)
            .Select(m => new { m.Id, m.CreatedAt, m.Body, Who = m.SenderId == null ? "Someone" : db.Users.Where(u => u.Id == m.SenderId).Select(u => u.DisplayName).FirstOrDefault() })
            .ToListAsync(ct);
        if (messages.Count == 0) { s.ChatReadUntil = conversation.LastMessageAt; return false; }
        // Wait for a pause, unless a lot has been said already.
        if (messages.Count < 300 && messages[^1].CreatedAt > quiet) return false;
        var batch = messages.Take(300).ToList();
        var text = string.Join("\n", batch.Select(m => $"[{m.CreatedAt:dd MMM HH:mm}] {m.Who}: {m.Body}"));
        var added = await AddAsync(s.TenantId, s.ProjectId, AgentSourceKind.Chat, $"chat:{batch[0].Id}", $"Project chat · {batch[0].CreatedAt:dd MMM}", null, text,
            batch[^1].CreatedAt, null, null, ct);
        s.ChatReadUntil = batch[^1].CreatedAt;
        return added is not null;
    }

    // ---------------------------------------------------------------- the project's mailbox

    private static readonly Regex AgentToken = new(@"agent\+([0-9a-f]{24})@", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    /// <summary>The project mailbox token from a recipient list such as "Ravi &lt;r@x.in&gt;, agent+0123abcd...@inbound.example.com".</summary>
    public static string? TokenFromRecipients(string? to) => to is null ? null : AgentToken.Match(to) is { Success: true } m ? m.Groups[1].Value.ToLowerInvariant() : null;

    /// <summary>
    /// One e-mail sent or copied to a project's agent address (anonymous webhook; the token picks the project). Anyone may write to it - a
    /// client copying the address is the point - so what it says is only ever read as data, and nothing changes until a person approves it.
    /// </summary>
    public static async Task<Guid> ReceiveMailAsync(IServiceProvider sp, string token, string? key, InboundEmail email, CancellationToken ct)
    {
        var opts = sp.GetRequiredService<IOptions<InboundEmailOptions>>().Value;
        if (!string.IsNullOrEmpty(opts.Key) && !CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(key ?? ""), Encoding.UTF8.GetBytes(opts.Key)))
            throw new UnauthorizedException("The inbound key is missing or wrong.", "INBOUND_KEY");
        var db = sp.GetRequiredService<IAppDbContext>();
        var clock = sp.GetRequiredService<AppClock>();
        var log = sp.GetRequiredService<ILogger<AgentSignalService>>();
        token = token.ToLowerInvariant();
        var s = await db.ProjectAgentSettings.IgnoreQueryFilters().FirstOrDefaultAsync(x => x.MailboxToken == token, ct)
            ?? throw new NotFoundException("Unknown mailbox.", "MAILBOX_NOT_FOUND");
        if (!s.Enabled || !s.ReadMailbox) throw new ForbiddenException("The project agent's mailbox is switched off.", "MAILBOX_DISABLED");
        var tenant = await db.Tenants.IgnoreQueryFilters().AsNoTracking().FirstOrDefaultAsync(t => t.Id == s.TenantId && t.Status == TenantStatus.Active && !t.IsDeleted, ct)
            ?? throw new ForbiddenException("The workspace is not active.", "WORKSPACE_INACTIVE");
        var project = await db.Projects.IgnoreQueryFilters().AsNoTracking().FirstOrDefaultAsync(p => p.Id == s.ProjectId && !p.IsDeleted, ct)
            ?? throw new NotFoundException("Unknown mailbox.", "MAILBOX_NOT_FOUND");
        var dayStart = clock.Now.AddHours(-24);
        if (await db.AgentSignals.IgnoreQueryFilters().CountAsync(x => x.ProjectId == s.ProjectId && x.Source == AgentSourceKind.ProjectMailbox && x.CreatedAt >= dayStart, ct) >= MailPerDay)
            throw new ConflictException($"The project's agent mailbox already received {MailPerDay} emails today.", "MAILBOX_LIMIT");

        var sender0 = InboundEmailService.EmailOf(email.From) ?? email.From ?? "unknown sender";
        // One sender cannot fill a project's day (or its AI budget): at most 30 mails a day each.
        if (await db.AgentSignals.IgnoreQueryFilters().CountAsync(x => x.ProjectId == s.ProjectId && x.Source == AgentSourceKind.ProjectMailbox && x.CreatedAt >= dayStart
                && x.FromName == sender0, ct) >= 30)
            throw new ConflictException("This sender already wrote 30 emails to the project today.", "MAILBOX_SENDER_LIMIT");
        var cc = sp.GetRequiredService<CurrentContext>();
        cc.TenantId = s.TenantId; cc.UserId = s.ActingUserId; cc.WorkspaceType = tenant.Type; cc.IsPlatformAdmin = false;
        var signals = sp.GetRequiredService<AgentSignalService>();
        var sender = InboundEmailService.EmailOf(email.From) ?? email.From ?? "unknown sender";
        var normalized = Text.NormalizeEmail(sender);
        var member = await db.Users.IgnoreQueryFilters().AsNoTracking()
            .Where(u => u.NormalizedEmail == normalized && db.TenantMembers.IgnoreQueryFilters().Any(m => m.TenantId == s.TenantId && m.UserId == u.Id))
            .Select(u => u.DisplayName).FirstOrDefaultAsync(ct);
        // The From address is not proof of who wrote (it can be forged), so the model is told so; a member's name is only a match on the address.
        var from = member is null ? $"{sender} (outside the workspace; address not verified)" : $"{member} <{sender}> (address not verified)";
        var subject = string.IsNullOrWhiteSpace(email.Subject) ? "(no subject)" : email.Subject.Trim();
        var body = $"From: {from}\nSubject: {subject}\n\n{email.Text}";
        var signal = await signals.AddAsync(s.TenantId, s.ProjectId, AgentSourceKind.ProjectMailbox, $"mail:{Hash(sender + "\n" + subject + "\n" + (email.Text ?? ""))}",
            subject, sender, body, clock.Now, null, null, ct);
        if (signal is null) return Guid.Empty;
        await db.ProjectAgentSettings.IgnoreQueryFilters().Where(x => x.Id == s.Id).ExecuteUpdateAsync(u => u.SetProperty(x => x.MailReceived, x => x.MailReceived + 1), ct);
        await db.SaveChangesAsync(ct);
        log.LogInformation("Project agent mail received for project {Project}", project.Id);
        return signal.Id;
    }
}

/// <summary>Turns the common transcript formats (WebVTT, SRT, "Name: words" lines) into plain "Name: words" lines.</summary>
public static class Transcripts
{
    private static readonly Regex Cue = new(@"^\d{1,2}:\d{2}(:\d{2})?([.,]\d{1,3})?\s*-->\s*\d{1,2}:\d{2}(:\d{2})?([.,]\d{1,3})?.*$", RegexOptions.CultureInvariant);
    private static readonly Regex VoiceTag = new(@"^<v\s+([^>]+)>(.*?)(</v>)?$", RegexOptions.CultureInvariant);

    public static string Normalize(string text)
    {
        var lines = text.Replace("\r\n", "\n").Split('\n');
        if (!lines.Any(l => Cue.IsMatch(l.Trim()))) return text;
        var output = new List<string>();
        foreach (var raw in lines)
        {
            var l = raw.Trim();
            if (l.Length == 0 || l == "WEBVTT" || l.StartsWith("NOTE", StringComparison.Ordinal) || Cue.IsMatch(l) || l.All(char.IsDigit)) continue;
            var v = VoiceTag.Match(l);
            var line = v.Success ? $"{v.Groups[1].Value.Trim()}: {v.Groups[2].Value.Trim()}" : l;
            if (output.Count > 0 && output[^1] == line) continue;
            output.Add(line);
        }
        return string.Join("\n", output);
    }
}
