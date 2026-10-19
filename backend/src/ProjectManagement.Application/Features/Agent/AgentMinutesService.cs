using System.Net;
using System.Net.Mail;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Auth;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Application.Features.Sso;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Agent;

/// <summary>
/// The minutes of meeting (MOM) of a meeting the agent read, e-mailed to the people in it: summary, decisions, action items with owners and
/// dates, updates, delays, points nobody picked up, ideas - and the full transcript. They go out on their own once everything proposed from
/// the meeting has been decided, or when someone who may edit the project sends them. Nobody has to set up a mailbox for the bot: the
/// message is sent by the installation in the name of the meeting's organizer ("Asha via Project Tracker"), and replies go to the organizer's
/// own address.
/// </summary>
public class AgentMinutesService(IAppDbContext db, ICurrentContext ctx, AppClock clock, IEmailSender email, AgentSignalService signals,
    AgentSettingsService settings, ProjectAccess access, Recorder recorder, IOptions<AppOptions> app, ILogger<AgentMinutesService> log)
{
    private static readonly AgentSourceKind[] MeetingSources = [AgentSourceKind.MeetingTranscript, AgentSourceKind.LiveMeeting, AgentSourceKind.Manual];
    private const int MaxRecipients = 100;
    private const int MaxTranscript = 150_000;

    /// <summary>Sends the minutes of these readings whose meetings are now fully decided. Returns how many sets went out.</summary>
    public async Task<int> SendIfDecidedAsync(IEnumerable<Guid> runIds, CancellationToken ct)
    {
        var sent = 0;
        foreach (var runId in runIds.Distinct().ToList())
        {
            var run = await db.AgentRuns.AsNoTracking().FirstOrDefaultAsync(r => r.Id == runId, ct);
            if (run is null || run.Status != "done" || run.MinutesSentAt is not null || run.FindingCount == 0) continue;
            var s = await db.ProjectAgentSettings.AsNoTracking().FirstOrDefaultAsync(x => x.ProjectId == run.ProjectId, ct);
            if (s is null || !s.SendMinutes) continue;
            if (!await IsMeetingAsync(run.Id, ct)) continue;
            if (await db.AgentFindings.AnyAsync(f => f.RunId == run.Id && f.Status == AgentFindingStatus.Proposed, ct)) continue;
            // Claim it: two people deciding the last two items at once send one set of minutes.
            if (await db.AgentRuns.Where(r => r.Id == run.Id && r.MinutesSentAt == null).ExecuteUpdateAsync(u => u.SetProperty(r => r.MinutesSentAt, clock.Now), ct) != 1) continue;
            if (await SendAsync(run, s, null, ct) > 0) sent++;
        }
        return sent;
    }

    /// <summary>Sends the minutes now, in the name of the person asking (they may edit the project). Items still waiting are listed as such.</summary>
    public async Task<int> SendNowAsync(Guid projectId, Guid runId, CancellationToken ct = default)
    {
        var project = await access.GetProjectAsync(projectId, ct);
        if (!await settings.CanManageAsync(project, ct)) throw new ForbiddenException("Only people who may edit this project can send its minutes.", "PERMISSION_DENIED");
        var run = await db.AgentRuns.AsNoTracking().FirstOrDefaultAsync(r => r.Id == runId && r.ProjectId == projectId, ct) ?? throw new NotFoundException("That reading was not found.");
        if (run.Status != "done" || !await IsMeetingAsync(run.Id, ct)) throw new ConflictException("Minutes are sent for meetings the agent has read.", "AGENT_NOT_A_MEETING");
        if (run.MinutesSentAt is { } last && clock.Now - last < TimeSpan.FromMinutes(10))
            throw new ConflictException("These minutes were just sent. Wait a few minutes before sending them again.", "AGENT_MINUTES_RECENT");
        var s = await db.ProjectAgentSettings.AsNoTracking().FirstAsync(x => x.ProjectId == projectId, ct);
        await db.AgentRuns.Where(r => r.Id == run.Id).ExecuteUpdateAsync(u => u.SetProperty(r => r.MinutesSentAt, clock.Now), ct);
        return await SendAsync(run, s, ctx.RequireUserId(), ct);
    }

    public Task<bool> IsMeetingAsync(Guid runId, CancellationToken ct) => db.AgentSignals.AnyAsync(x => x.RunId == runId && MeetingSources.Contains(x.Source), ct);

    private record Person(string Name, string Email);

    /// <summary>Builds and sends one set of minutes. Returns how many people it went to.</summary>
    private async Task<int> SendAsync(AgentRun run, ProjectAgentSettings s, Guid? requestedBy, CancellationToken ct)
    {
        var project = await db.Projects.AsNoTracking().FirstAsync(p => p.Id == run.ProjectId, ct);
        var meeting = run.MeetingId is { } mid ? await db.ProjectMeetings.AsNoTracking().FirstOrDefaultAsync(m => m.Id == mid, ct) : null;
        var meetingSignals = await db.AgentSignals.AsNoTracking().Where(x => x.RunId == run.Id && MeetingSources.Contains(x.Source)).OrderBy(x => x.OccurredAt).ToListAsync(ct);
        var title = meeting?.Title
            ?? (run.MeetingId is { } bm ? await db.AgentMeetingBots.AsNoTracking().Where(b => b.MeetingId == bm && b.Title != null).Select(b => b.Title).FirstOrDefaultAsync(ct) : null)
            ?? meetingSignals.Select(x => x.Title).FirstOrDefault() ?? "Meeting";
        title = Regex.Replace(title, @" \(part \d+ of \d+\)$", "");
        var zone = await db.Tenants.AsNoTracking().Where(t => t.Id == project.TenantId).Select(t => t.TimeZone).FirstOrDefaultAsync(ct);
        var tz = ZoneTime.Find(ZoneTime.IsKnown(zone) ? zone : "Asia/Kolkata");
        var held = ZoneTime.ToLocal(meetingSignals.FirstOrDefault()?.OccurredAt ?? run.StartedAt, tz);

        // Whose name it goes out in: who asked for it, else the meeting's organizer, else the person the agent acts as.
        var senderId = requestedBy ?? meeting?.OrganizerUserId ?? s.ActingUserId;
        var sender = await db.Users.AsNoTracking().Where(u => u.Id == senderId).Select(u => new Person(u.DisplayName, u.Email)).FirstOrDefaultAsync(ct);

        var findings = await db.AgentFindings.AsNoTracking().Where(f => f.RunId == run.Id && f.Status != AgentFindingStatus.Dismissed).ToListAsync(ct);
        var ownerIds = findings.Where(f => f.AssigneeId != null).Select(f => f.AssigneeId!.Value).Distinct().ToList();
        var owners = await db.Users.AsNoTracking().Where(u => ownerIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);

        // The people in it: the meeting's invitees (members and outside guests), else the project's people; and everyone given work.
        var to = new List<Person>();
        if (meeting is not null)
            to.AddRange(await db.MeetingParticipants.AsNoTracking().Where(p => p.MeetingId == meeting.Id)
                .Select(p => new Person(p.User != null ? p.User.DisplayName : p.Email, p.User != null ? p.User.Email : p.Email)).ToListAsync(ct));
        if (to.Count == 0)
            to.AddRange(await db.ProjectMembers.AsNoTracking().Where(m => m.ProjectId == project.Id && m.User!.IsActive)
                .OrderBy(m => m.UserId).Select(m => new Person(m.User!.DisplayName, m.User.Email)).ToListAsync(ct));
        var extra = ownerIds.Append(project.OwnerId).Append(senderId).Distinct().ToList();
        to.AddRange(await db.Users.AsNoTracking().Where(u => extra.Contains(u.Id) && u.IsActive).Select(u => new Person(u.DisplayName, u.Email)).ToListAsync(ct));
        var recipients = to.Where(p => MailAddress.TryCreate(p.Email, out _)).DistinctBy(p => p.Email.Trim().ToLowerInvariant()).Take(MaxRecipients).ToList();
        if (recipients.Count == 0) return 0;

        var transcript = new StringBuilder();
        foreach (var sig in meetingSignals)
        {
            if (transcript.Length >= MaxTranscript) break;
            var part = signals.Read(sig);
            if (part.Length == 0) continue;
            if (transcript.Length > 0) transcript.AppendLine();
            transcript.Append(part.Length + transcript.Length > MaxTranscript ? part[..(MaxTranscript - transcript.Length)] + "\n[… the rest is in Project Tracker]" : part);
        }

        var (html, text) = Render(project, title, held, run, findings, owners, recipients, transcript.ToString(), sender);
        var subject = $"MOM: {title} · {held:dd MMM yyyy}";
        var fromName = sender is null ? null : $"{sender.Name} via Project Tracker";
        var sent = 0;
        foreach (var r in recipients)
        {
            try { await email.SendAsync(new EmailMessage(r.Email, subject, html, text, null, null, sender?.Email, fromName), ct); sent++; }
            catch (Exception ex) when (ex is not OperationCanceledException) { log.LogWarning("Minutes could not be e-mailed to one recipient: {Reason}", ex.Message); }
        }
        recorder.Activity("agent.minutes", "Project", project.Id, $"Minutes of \"{title}\" e-mailed to {sent} {(sent == 1 ? "person" : "people")}", project.Id);
        recorder.Audit("agent.minutes_sent", "AgentRun", run.Id, null, new { sent, transcript = transcript.Length > 0 });
        await db.SaveChangesAsync(ct);
        return sent;
    }

    private (string Html, string Text) Render(Project project, string title, DateTime held, AgentRun run, List<AgentFinding> findings, Dictionary<Guid, string> owners,
        List<Person> attendees, string transcript, Person? sender)
    {
        static string E(string? s) => WebUtility.HtmlEncode(s ?? "");
        string Owner(AgentFinding f) => f.AssigneeId is { } a && owners.TryGetValue(a, out var n) ? n : "";
        var html = new StringBuilder();
        var text = new StringBuilder();
        const string h = "margin:22px 0 8px;font-size:15px;color:#221a3a";
        const string td = "padding:6px 8px;border-bottom:1px solid #efeaf9;font-size:13px;color:#221a3a;vertical-align:top";

        html.Append($"<p style=\"margin:0 0 6px;font-size:13px;color:#6a6288\">{E(project.Key)} · {E(project.Name)} · {held:dd MMM yyyy, HH:mm}</p>");
        text.AppendLine($"{title}\n{project.Key} · {project.Name} · {held:dd MMM yyyy, HH:mm}\n");
        if (attendees.Count > 0)
        {
            html.Append($"<p style=\"margin:0 0 14px;font-size:13px;color:#6a6288\"><b>Attendees:</b> {E(string.Join(", ", attendees.Select(a => a.Name)))}</p>");
            text.AppendLine($"Attendees: {string.Join(", ", attendees.Select(a => a.Name))}\n");
        }
        if (run.Summary is { } sum)
        {
            html.Append($"<h3 style=\"{h}\">Summary</h3><p style=\"margin:0;font-size:14px;line-height:22px;color:#4a4268\">{E(sum)}</p>");
            text.AppendLine($"SUMMARY\n{sum}\n");
        }

        var actions = findings.Where(f => f.Kind is AgentFindingKind.CreateTask or AgentFindingKind.CreateActionItem or AgentFindingKind.CreateIssue).ToList();
        if (actions.Count > 0)
        {
            html.Append("<h3 style=\"" + h + "\">Action items</h3><table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"border-collapse:collapse\">");
            html.Append($"<tr><td style=\"{td};color:#6a6288\">Item</td><td style=\"{td};color:#6a6288\">Owner</td><td style=\"{td};color:#6a6288\">Due</td></tr>");
            text.AppendLine("ACTION ITEMS");
            foreach (var f in actions)
            {
                var item = (f.AppliedKey is { } k ? k + " " : "") + f.Title + (f.Status == AgentFindingStatus.Proposed ? " (awaiting approval)" : "");
                html.Append($"<tr><td style=\"{td}\">{E(item)}</td><td style=\"{td}\">{E(Owner(f))}</td><td style=\"{td}\">{E(f.DueDate?.ToString("dd MMM"))}</td></tr>");
                text.AppendLine($"- {item}{(Owner(f) is { Length: > 0 } o ? $" - {o}" : "")}{(f.DueDate is { } d ? $" - due {d:dd MMM}" : "")}");
            }
            html.Append("</table>");
            text.AppendLine();
        }
        void Section(string label, IEnumerable<AgentFinding> rows)
        {
            var list = rows.ToList();
            if (list.Count == 0) return;
            html.Append($"<h3 style=\"{h}\">{E(label)}</h3><ul style=\"margin:0;padding-left:18px;font-size:14px;line-height:22px;color:#4a4268\">");
            text.AppendLine(label.ToUpperInvariant());
            foreach (var f in list)
            {
                var keyed = f.AppliedKey is not null && f.Kind is AgentFindingKind.UpdateTask or AgentFindingKind.UpdateIssue or AgentFindingKind.Delay ? f.AppliedKey + ": " : "";
                var line = keyed + f.Title + (Owner(f) is { Length: > 0 } o ? $" ({o})" : "") + (f.Status == AgentFindingStatus.Proposed ? " - awaiting approval" : "");
                html.Append($"<li>{E(line)}</li>");
                text.AppendLine($"- {line}");
            }
            html.Append("</ul>");
            text.AppendLine();
        }
        Section("Decisions", findings.Where(f => f.Kind == AgentFindingKind.Decision));
        Section("Updates", findings.Where(f => f.Kind is AgentFindingKind.UpdateTask or AgentFindingKind.UpdateIssue));
        Section("Delays", findings.Where(f => f.Kind == AgentFindingKind.Delay));
        Section("Not picked up yet", findings.Where(f => f.Kind == AgentFindingKind.Missed));
        Section("Suggestions", findings.Where(f => f.Kind == AgentFindingKind.Suggestion));

        if (transcript.Length > 0)
        {
            html.Append($"<h3 style=\"{h}\">Transcript</h3><div style=\"margin:0;padding:12px;border-radius:8px;background:#f7f5fc;font-family:Menlo,Consolas,monospace;font-size:12px;line-height:19px;color:#221a3a;white-space:pre-wrap\">{E(transcript)}</div>");
            text.AppendLine($"TRANSCRIPT\n{transcript}");
        }
        var link = $"{PublicUrls.Web(app.Value)}/projects/{project.Id}?tab=agent";
        var footer = sender is null ? "Taken by the project agent." : $"Taken by the project agent in {sender.Name}'s meetings. Reply to this e-mail to reach {sender.Name}.";
        return (EmailTemplates.Rich($"Minutes: {title}", "Hello,", html.ToString(), "Open the project", link, footer, run.Summary), text.ToString());
    }
}
