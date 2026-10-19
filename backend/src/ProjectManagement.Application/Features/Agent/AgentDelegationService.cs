using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Integrations;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Agent;

/// <summary>
/// Sending the agent to a meeting in someone's place. The person picks a session (or their rule does it when they are double-booked); the
/// agent's bot joins it as their assistant - named so, never posing as them - says they could not make it and raises what they asked it to,
/// listens, answers factual questions from the tracker, and afterwards the person gets a report: the summary, what came out of it and what
/// waits for a decision. Nothing in the project changes without the usual approval.
/// </summary>
public class AgentDelegationService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, ProjectAccess access, AgentSettingsService settings,
    MeetingBotClient bots, GoogleMeetingClient google, NotificationService notifications, ILogger<AgentDelegationService> log)
{
    // ---------------------------------------------------------------- my meetings and double-booking

    /// <summary>
    /// My meeting sessions from <paramref name="fromUtc"/> for <paramref name="hours"/>: project meetings I organize or am invited to (not
    /// declined), plus my other Google Calendar calls when Google is connected, each with the ones it overlaps.
    /// </summary>
    public async Task<IReadOnlyList<MyMeetingDto>> MyMeetingsAsync(DateTime fromUtc, int hours, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var toUtc = fromUtc.AddHours(Math.Clamp(hours, 1, 24 * 14));
        var mine = db.ProjectMeetings.Where(m => m.OrganizerUserId == me
            || db.MeetingParticipants.Any(p => p.MeetingId == m.Id && p.UserId == me && p.RsvpStatus != AttendeeRsvpStatus.Declined));
        var sessions = await AgentSessions.ListAsync(mine, fromUtc, toUtc, ct, 200);
        var projectIds = sessions.Select(x => x.Meeting.ProjectId).Distinct().ToList();
        var projects = await db.Projects.AsNoTracking().Where(p => projectIds.Contains(p.Id)).ToDictionaryAsync(p => p.Id, p => new { p.Key, p.Name }, ct);
        var agents = await db.ProjectAgentSettings.AsNoTracking().Where(s => projectIds.Contains(s.ProjectId) && s.Enabled && s.ReadMeetings)
            .ToDictionaryAsync(s => s.ProjectId, s => s.LiveBot, ct);
        var meetingIds = sessions.Select(x => x.Meeting.Id).Distinct().ToList();
        var delegations = await db.AgentDelegations.AsNoTracking().Where(d => d.UserId == me && meetingIds.Contains(d.MeetingId) && d.SessionStartUtc >= fromUtc.AddDays(-1))
            .ToListAsync(ct);
        var list = new List<MyMeetingDto>();
        foreach (var x in sessions)
        {
            if (!projects.TryGetValue(x.Meeting.ProjectId, out var p)) continue;   // a project I cannot open
            var d = delegations.FirstOrDefault(y => y.MeetingId == x.Meeting.Id && y.SessionStartUtc == x.Start);
            var agentOn = agents.TryGetValue(x.Meeting.ProjectId, out var liveBot);
            list.Add(new MyMeetingDto($"{x.Meeting.Id:N}:{x.Start:yyyyMMddHHmm}", x.Meeting.Id, x.Meeting.ProjectId, p.Key, p.Name, x.Meeting.Title, x.Start, x.End,
                x.Meeting.GoogleMeetUri, x.Meeting.OrganizerUserId == me, true, agentOn, agentOn && (liveBot || d is { Status: not "cancelled" }), d?.Id, d?.Status, []));
        }
        // My other calls, when my Google Calendar is connected (best effort: no calendar, no extra calls).
        try
        {
            foreach (var e in await google.ListUpcomingMeetsAsync(me, fromUtc, toUtc, ct))
            {
                if (e.End <= e.Start || list.Any(m => m.MeetUrl is { } u && SameMeet(u, e.MeetUrl))) continue;
                list.Add(new MyMeetingDto($"cal:{e.EventId}", null, null, null, null, e.Title, e.Start, e.End, e.MeetUrl, false, false, false, false, null, null, []));
            }
        }
        catch (Exception ex) when (ex is AppException or GoogleApiException) { log.LogDebug("No calendar calls for {User}: {Reason}", me, ex.Message); }

        list = list.OrderBy(m => m.StartUtc).ThenBy(m => m.Title).ToList();
        return list.Select(m => m with
        {
            OverlapsWith = list.Where(o => o.Id != m.Id && o.StartUtc < m.EndUtc && m.StartUtc < o.EndUtc).Select(o => o.Title).Take(3).ToList(),
        }).ToList();
    }

    private static bool SameMeet(string a, string b) =>
        string.Equals(a.TrimEnd('/').Split('?')[0], b.TrimEnd('/').Split('?')[0], StringComparison.OrdinalIgnoreCase);

    // ---------------------------------------------------------------- sending the agent

    public async Task<AgentDelegationDto> DelegateAsync(DelegateRequest req, CancellationToken ct = default) => await DelegateAsync(req, false, ct);

    private async Task<AgentDelegationDto> DelegateAsync(DelegateRequest req, bool automatic, CancellationToken ct)
    {
        var me = ctx.RequireUserId();
        var meeting = await db.ProjectMeetings.AsNoTracking().FirstOrDefaultAsync(m => m.Id == req.MeetingId, ct) ?? throw new NotFoundException("Meeting not found.");
        var project = await access.GetProjectAsync(meeting.ProjectId, ct);
        var invited = meeting.OrganizerUserId == me || await db.MeetingParticipants.AnyAsync(p => p.MeetingId == meeting.Id && p.UserId == me, ct);
        if (!invited) throw new ForbiddenException("You can send the agent only to meetings you are invited to.", "PERMISSION_DENIED");
        var session = await AgentSessions.FindAsync(db, meeting.Id, DateTime.SpecifyKind(req.SessionStartUtc, DateTimeKind.Utc), ct)
            ?? throw new ValidationException("sessionStartUtc", "That meeting has no session at that time.");
        if (session.End <= clock.Now.AddMinutes(5)) throw new ValidationException("sessionStartUtc", "That session is already over.");
        var s = await db.ProjectAgentSettings.AsNoTracking().FirstOrDefaultAsync(x => x.ProjectId == meeting.ProjectId, ct);
        if (s is not { Enabled: true }) throw new ConflictException($"Switch the project agent on in {project.Name} first (project › Agent).", "AGENT_DISABLED");
        if (!s.ReadMeetings) throw new ConflictException($"Meetings are switched off for {project.Name}'s agent.", "AGENT_MEETINGS_OFF");
        if (!bots.Configured) throw new ConflictException("The meeting bot is not set up on this installation.", "MEETBOT_UNAVAILABLE");
        var instructions = req.Instructions?.Replace("\r\n", "\n").Trim();
        if (instructions is { Length: > 1000 }) throw new ValidationException("instructions", "Keep what to raise to 1000 characters.");

        var d = await db.AgentDelegations.FirstOrDefaultAsync(x => x.MeetingId == meeting.Id && x.SessionStartUtc == session.Start && x.UserId == me, ct);
        if (d is not null && automatic) return await DtoAsync(d, ct);   // the person's own choice (even "cancelled") stands
        if (d is null)
        {
            d = new AgentDelegation { TenantId = project.TenantId, ProjectId = project.Id, MeetingId = meeting.Id, SessionStartUtc = session.Start, SessionEndUtc = session.End,
                UserId = me, CreatedAt = clock.Now, CreatedBy = me };
            db.AgentDelegations.Add(d);
        }
        else if (d.Status is "reported") throw new ConflictException("The agent already attended that session.", "AGENT_DELEGATION_DONE");
        d.Status = d.Status == "attending" ? "attending" : "requested";
        d.Instructions = string.IsNullOrEmpty(instructions) ? null : instructions;
        d.Automatic = automatic; d.UpdatedAt = clock.Now; d.UpdatedBy = me;
        recorder.Audit("agent.delegated", "ProjectMeeting", meeting.Id, null, new { session.Start, automatic, Instructions = d.Instructions?.Length ?? 0 });
        recorder.Activity("agent.delegated", "Project", project.Id, $"The project agent will attend \"{meeting.Title}\" ({session.Start:d MMM HH:mm} UTC) for a member", project.Id);
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateException) { throw new ConflictException("The agent is already going to that session for you.", "AGENT_ALREADY_DELEGATED"); }
        return await DtoAsync(d, ct);
    }

    public async Task<AgentDelegationDto> CancelAsync(Guid id, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var d = await db.AgentDelegations.FirstOrDefaultAsync(x => x.Id == id && x.UserId == me, ct) ?? throw new NotFoundException("Not found.");
        if (d.Status is "reported") throw new ConflictException("The agent already attended that session.", "AGENT_DELEGATION_DONE");
        d.Status = "cancelled"; d.UpdatedAt = clock.Now;
        // The bot was going only for this person and has not joined yet: it does not go.
        var liveBot = await db.ProjectAgentSettings.AsNoTracking().Where(s => s.ProjectId == d.ProjectId).Select(s => s.LiveBot).FirstOrDefaultAsync(ct);
        var others = await db.AgentDelegations.AnyAsync(x => x.Id != d.Id && x.MeetingId == d.MeetingId && x.SessionStartUtc == d.SessionStartUtc && x.Status != "cancelled", ct);
        if (!liveBot && !others)
            await db.AgentMeetingBots.Where(b => b.MeetingId == d.MeetingId && b.SessionStartUtc == d.SessionStartUtc && b.Kind == "bot" && b.Status == "scheduled" && b.WorkerId == null)
                .ExecuteUpdateAsync(u => u.SetProperty(b => b.Status, "failed").SetProperty(b => b.Error, "No longer needed: the person who sent it cancelled.")
                    .SetProperty(b => b.EndedAt, clock.Now), ct);
        recorder.Audit("agent.delegation_cancelled", "ProjectMeeting", d.MeetingId, null, new { d.SessionStartUtc });
        await db.SaveChangesAsync(ct);
        return await DtoAsync(d, ct);
    }

    /// <summary>Where I sent the agent: coming up and the last two weeks, each with its report once there is one.</summary>
    public async Task<IReadOnlyList<AgentDelegationDto>> MineAsync(CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var rows = await db.AgentDelegations.AsNoTracking().Where(d => d.UserId == me && d.SessionEndUtc > clock.Now.AddDays(-14) && d.Status != "cancelled")
            .OrderByDescending(d => d.SessionStartUtc).Take(30).ToListAsync(ct);
        var list = new List<AgentDelegationDto>();
        foreach (var d in rows) list.Add(await DtoAsync(d, ct));
        return list;
    }

    /// <summary>
    /// The person's own rule: when two of their sessions overlap in the next couple of hours, the agent goes to the project meeting(s) they do
    /// not organize (they attend the one they run, else the one that starts first). Runs in the background as that person.
    /// </summary>
    public async Task<int> AutoDelegateAsync(CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var pref = await db.AgentPersonalSettings.AsNoTracking().FirstOrDefaultAsync(p => p.UserId == me, ct);
        if (pref is not { AutoDelegate: true }) return 0;
        var meetings = await MyMeetingsAsync(clock.Now, 2, ct);
        var sent = 0;
        foreach (var m in meetings.Where(m => m.Project && m.MeetingId is not null && m.OverlapsWith.Count > 0 && m.DelegationId is null && m.AgentEnabled
                     && m.StartUtc > clock.Now.AddMinutes(-2) && m.StartUtc < clock.Now.AddHours(2)))
        {
            var rivals = meetings.Where(o => o.Id != m.Id && o.StartUtc < m.EndUtc && m.StartUtc < o.EndUtc).ToList();
            // I keep the one I organize; otherwise the one that started first (or, at the same time, the one that is not a project meeting).
            var keep = m.Organizer || rivals.All(r => !r.Organizer && (r.StartUtc > m.StartUtc || r.StartUtc == m.StartUtc && r.Project && string.CompareOrdinal(r.Id, m.Id) > 0));
            if (keep) continue;
            try
            {
                await DelegateAsync(new DelegateRequest(m.MeetingId!.Value, m.StartUtc, null), true, ct);
                var rival = rivals.FirstOrDefault(r => r.Organizer) ?? rivals.OrderBy(r => r.StartUtc).First();
                await notifications.AddAsync(me, NotificationType.Meeting, Text.Truncate($"The agent will attend {m.Title} for you", 200)!,
                    $"You are double-booked with {rival.Title}. Cancel it in the Command Center if you would rather go yourself.", "/command-center",
                    $"agent-auto-delegate:{m.Id}", toSelf: true, ct: ct);
                await db.SaveChangesAsync(ct);
                sent++;
            }
            catch (AppException ex) { log.LogInformation("Automatic delegation skipped for {Meeting}: {Reason}", m.Id, ex.Message); }
        }
        return sent;
    }

    // ---------------------------------------------------------------- the report afterwards

    /// <summary>
    /// One tick for one project: sessions the agent attended for someone that are over - once their transcript has been read, the person gets
    /// the report (or, if the agent could not attend, why not).
    /// </summary>
    public async Task<int> ReportAsync(ProjectAgentSettings s, CancellationToken ct)
    {
        var now = clock.Now;
        var due = await db.AgentDelegations.Where(d => d.ProjectId == s.ProjectId && (d.Status == "requested" || d.Status == "attending") && d.SessionEndUtc < now.AddMinutes(-3))
            .OrderBy(d => d.SessionEndUtc).Take(20).ToListAsync(ct);
        var reported = 0;
        foreach (var d in due)
        {
            var bot = await db.AgentMeetingBots.AsNoTracking().FirstOrDefaultAsync(b => b.MeetingId == d.MeetingId && b.SessionStartUtc == d.SessionStartUtc && b.Kind == "bot", ct);
            var run = bot is null ? null : await RunOfAsync(bot.Id, ct);
            string title, body;
            var meeting = await db.ProjectMeetings.AsNoTracking().Where(m => m.Id == d.MeetingId).Select(m => m.Title).FirstOrDefaultAsync(ct) ?? "the meeting";
            if (run is { Status: "done" })
            {
                var open = await db.AgentFindings.CountAsync(f => f.RunId == run.Id && f.Status == AgentFindingStatus.Proposed, ct);
                title = $"Your agent attended {meeting}";
                body = $"{AgentAnalysisService.Cut(run.Summary, 300) ?? "The minutes are ready."} {run.FindingCount} item{(run.FindingCount == 1 ? "" : "s")} came out of it{(open > 0 ? $", {open} waiting for a decision" : "")}.";
            }
            else if (bot is { Status: "failed" } || bot is null && now > d.SessionEndUtc.AddMinutes(30) || bot is { Status: "done", TranscriptLength: 0 }
                     || run is { Status: "failed" } || now > d.SessionEndUtc.AddHours(3))
            {
                title = $"Your agent could not report on {meeting}";
                body = bot?.Error ?? run?.Error ?? "It heard nothing in that session.";
            }
            else continue;   // the transcript is still being read
            if (await db.AgentDelegations.Where(x => x.Id == d.Id && x.ReportSentAt == null).ExecuteUpdateAsync(u => u.SetProperty(x => x.ReportSentAt, now)
                    .SetProperty(x => x.Status, "reported").SetProperty(x => x.BotRowId, bot != null ? bot.Id : (Guid?)null), ct) != 1) continue;
            await notifications.AddAsync(d.UserId, NotificationType.Meeting, Text.Truncate(title, 200)!, Text.Truncate(body, 500), $"/command-center?delegation={d.Id}",
                $"agent-report:{d.Id:N}", toSelf: true, ct: ct);
            await db.SaveChangesAsync(ct);
            reported++;
        }
        return reported;
    }

    private async Task<AgentRun?> RunOfAsync(Guid botRowId, CancellationToken ct)
    {
        var sourceRef = $"bot:{botRowId}";
        var runId = await db.AgentSignals.AsNoTracking().Where(x => x.SourceRef == sourceRef && x.RunId != null).Select(x => x.RunId).FirstOrDefaultAsync(ct);
        return runId is { } id ? await db.AgentRuns.AsNoTracking().FirstOrDefaultAsync(r => r.Id == id, ct) : null;
    }

    public async Task<AgentDelegationDto> GetAsync(Guid id, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var d = await db.AgentDelegations.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id && x.UserId == me, ct) ?? throw new NotFoundException("Not found.");
        return await DtoAsync(d, ct);
    }

    private async Task<AgentDelegationDto> DtoAsync(AgentDelegation d, CancellationToken ct)
    {
        var project = await db.Projects.AsNoTracking().FirstAsync(p => p.Id == d.ProjectId, ct);
        var title = await db.ProjectMeetings.AsNoTracking().Where(m => m.Id == d.MeetingId).Select(m => m.Title).FirstOrDefaultAsync(ct) ?? "Meeting";
        var bot = await db.AgentMeetingBots.AsNoTracking().FirstOrDefaultAsync(b => b.MeetingId == d.MeetingId && b.SessionStartUtc == d.SessionStartUtc && b.Kind == "bot", ct);
        var run = bot is null ? null : await RunOfAsync(bot.Id, ct);
        var outcomes = new List<string>(); var toDecide = 0;
        if (run is { Status: "done" })
        {
            // Titles of what came out of it - the quotes stay with the people who decide on them.
            var found = await db.AgentFindings.AsNoTracking().Where(f => f.RunId == run.Id).OrderByDescending(f => f.Confidence).Take(12)
                .Select(f => new { f.Kind, f.Title, f.Status }).ToListAsync(ct);
            outcomes = found.Select(f => $"{Label(f.Kind)}: {f.Title}{(f.Status == AgentFindingStatus.Proposed ? " (waiting)" : "")}").ToList();
            toDecide = found.Count(f => f.Status == AgentFindingStatus.Proposed);
        }
        var canDecide = await settings.CanManageAsync(project, ct);
        var botStatus = bot is null ? (d.Status == "requested" ? "queued" : null) : bot.WorkerStatus ?? bot.Status;
        return new AgentDelegationDto(d.Id, d.ProjectId, project.Key, project.Name, d.MeetingId, title, d.SessionStartUtc, d.SessionEndUtc, d.Status, d.Instructions, d.Automatic,
            botStatus, bot?.Error, d.ReportSentAt, run?.Summary, outcomes, toDecide, canDecide, d.Note);
    }

    public static string Label(AgentFindingKind k) => k switch
    {
        AgentFindingKind.CreateTask => "New task", AgentFindingKind.CreateActionItem => "Action item", AgentFindingKind.CreateIssue => "Ticket",
        AgentFindingKind.UpdateTask => "Update", AgentFindingKind.UpdateIssue => "Ticket update", AgentFindingKind.Delay => "Delay",
        AgentFindingKind.Missed => "Not picked up", AgentFindingKind.Suggestion => "Suggestion", _ => "Decision",
    };
}
