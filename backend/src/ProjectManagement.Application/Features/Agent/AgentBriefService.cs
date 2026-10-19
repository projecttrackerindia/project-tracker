using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Agent;

/// <summary>
/// The brief before a project meeting: what came of the last meeting (done, late, stuck), what blocks what, the commitments due, what waits for
/// a decision, and a suggested agenda in that order - or a note that the meeting may not be needed at all. Sent to the people invited a few
/// minutes before each session (their own choice of how many). Built from the tracker alone: no model, no credits.
/// </summary>
public class AgentBriefService(IAppDbContext db, ICurrentContext ctx, AppClock clock, ProjectAccess access, NotificationService notifications)
{
    public async Task<MeetingBriefDto> GetAsync(Guid meetingId, DateTime? sessionStartUtc, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var meeting = await db.ProjectMeetings.AsNoTracking().FirstOrDefaultAsync(m => m.Id == meetingId, ct) ?? throw new NotFoundException("Meeting not found.");
        await access.GetProjectAsync(meeting.ProjectId, ct);   // the person can open the project
        var invited = meeting.OrganizerUserId == me || await db.MeetingParticipants.AnyAsync(p => p.MeetingId == meetingId && p.UserId == me, ct);
        var project = await db.Projects.AsNoTracking().FirstAsync(p => p.Id == meeting.ProjectId, ct);
        if (!invited && project.OwnerId != me && ctx.Role is not (TenantRole.Owner or TenantRole.Admin)) throw new NotFoundException("Meeting not found.");
        var session = sessionStartUtc is { } at ? await AgentSessions.FindAsync(db, meetingId, at, ct) : null;
        session ??= (await AgentSessions.ListAsync(db.ProjectMeetings.Where(m => m.Id == meetingId), clock.Now.AddHours(-2), clock.Now.AddDays(60), ct, 1)).FirstOrDefault()
            ?? new MeetingSession(meeting, meeting.StartTimeUtc, meeting.EndTimeUtc);
        return await BuildAsync(session, ct);
    }

    public async Task<MeetingBriefDto> BuildAsync(MeetingSession session, CancellationToken ct)
    {
        var meeting = session.Meeting;
        var project = await db.Projects.AsNoTracking().FirstAsync(p => p.Id == meeting.ProjectId, ct);
        var zone = await db.Tenants.AsNoTracking().Where(t => t.Id == project.TenantId).Select(t => t.TimeZone).FirstOrDefaultAsync(ct);
        var today = clock.TodayIn(zone);
        static string First(string? n) => AgentSessions.FirstName(n);
        string K(int n) => $"{project.Key}-{n}";

        // What came out of the last meeting the agent read, and where it stands now.
        var lastRun = await db.AgentRuns.AsNoTracking().Where(r => r.ProjectId == project.Id && r.Status == "done" && r.StartedAt < session.Start
                && db.AgentSignals.Any(x => x.RunId == r.Id && (x.Source == AgentSourceKind.MeetingTranscript || x.Source == AgentSourceKind.LiveMeeting || x.Source == AgentSourceKind.Manual)))
            .OrderByDescending(r => r.StartedAt).Select(r => new { r.Id, r.StartedAt }).FirstOrDefaultAsync(ct);
        var items = new List<BriefItemDto>();
        if (lastRun is not null)
        {
            var made = await db.AgentFindings.AsNoTracking().Where(f => f.RunId == lastRun.Id && f.Status == AgentFindingStatus.Applied && f.AppliedEntityId != null
                    && (f.Kind == AgentFindingKind.CreateTask || f.Kind == AgentFindingKind.CreateActionItem))
                .Select(f => f.AppliedEntityId!.Value).ToListAsync(ct);
            var made1 = await db.Tasks.AsNoTracking().Where(t => made.Contains(t.Id))
                .Select(t => new { t.Id, t.Number, t.DueDate, Cat = t.Status!.Category, Owner = t.Assignee != null ? t.Assignee.DisplayName : null }).ToListAsync(ct);
            var made2 = await db.WorkTasks.AsNoTracking().Where(t => made.Contains(t.Id))
                .Select(t => new { t.Id, t.Number, t.DueDate, t.Status, Owner = db.Users.Where(u => u.Id == t.AssigneeId).Select(u => u.DisplayName).FirstOrDefault() }).ToListAsync(ct);
            foreach (var t in made1)
                items.Add(new BriefItemDto(K(t.Number), First(t.Owner), t.DueDate,
                    t.Cat == StatusCategory.Done ? "done" : t.Cat == StatusCategory.Cancelled ? "done" : t.DueDate < today ? "overdue" : t.DueDate == today ? "due_today" : "open"));
            foreach (var t in made2)
                items.Add(new BriefItemDto($"AI-{t.Number}", First(t.Owner), t.DueDate,
                    t.Status is WorkTaskStatus.Completed or WorkTaskStatus.Cancelled ? "done" : t.DueDate < today ? "overdue" : t.DueDate == today ? "due_today" : "open"));
        }

        // What is stuck: open work waiting on open work that is already late.
        var open = await db.Tasks.AsNoTracking().Where(t => t.ProjectId == project.Id && t.ParentTaskId == null
                && t.Status!.Category != StatusCategory.Done && t.Status.Category != StatusCategory.Cancelled)
            .Select(t => new { t.Id, t.Number, t.DueDate, Owner = t.Assignee != null ? t.Assignee.DisplayName : null }).Take(5000).ToListAsync(ct);
        var openById = open.ToDictionary(t => t.Id);
        var openIds = open.Select(t => t.Id).ToList();
        var links = await db.TaskDependencies.AsNoTracking().Where(d => openIds.Contains(d.TaskId) && openIds.Contains(d.DependsOnTaskId))
            .Select(d => new { d.TaskId, d.DependsOnTaskId }).ToListAsync(ct);
        var blockers = new List<string>();
        var blockedIds = new HashSet<Guid>();
        foreach (var g in links.Where(l => openById[l.DependsOnTaskId].DueDate is { } d && d < today).GroupBy(l => l.DependsOnTaskId)
                     .OrderBy(g => openById[g.Key].DueDate).Take(5))
        {
            var p = openById[g.Key];
            foreach (var l in g) blockedIds.Add(l.TaskId);
            var waiting = g.Select(l => openById[l.TaskId].Number).Distinct().ToList();
            blockers.Add($"{K(p.Number)} ({First(p.Owner)}, {today.DayNumber - p.DueDate!.Value.DayNumber}d late) holds up {string.Join(", ", waiting.Take(3).Select(K))}{(waiting.Count > 3 ? $" +{waiting.Count - 3}" : "")}");
        }
        var blockedKeys = open.Where(o => blockedIds.Contains(o.Id)).Select(o => K(o.Number)).ToHashSet();
        for (var i = 0; i < items.Count; i++)
            if (items[i].State != "done" && blockedKeys.Contains(items[i].Key)) items[i] = items[i] with { State = "blocked" };

        var overdueAll = open.Where(t => t.DueDate is { } d && d < today).OrderBy(t => t.DueDate).ToList();
        var dueToday = open.Where(t => t.DueDate == today).ToList();
        var commitments = await db.AgentCommitments.AsNoTracking().Where(c => c.ProjectId == project.Id && c.Status == "open" && c.DueDate <= today.AddDays(3))
            .OrderBy(c => c.DueDate).Take(6).Select(c => new { c.EntityKey, c.Title, c.DueDate, c.OwnerUserId }).ToListAsync(ct);
        var ownerIds = commitments.Select(c => c.OwnerUserId).Distinct().ToList();
        var owners = await db.Users.AsNoTracking().Where(u => ownerIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        var commitmentLines = commitments.Select(c => $"{c.EntityKey ?? "Item"} ({First(owners.GetValueOrDefault(c.OwnerUserId))}) {(c.DueDate == today ? "today" : c.DueDate < today ? "late" : $"by {c.DueDate:ddd d MMM}")}").ToList();
        var pending = await db.AgentFindings.CountAsync(f => f.ProjectId == project.Id && f.Status == AgentFindingStatus.Proposed, ct);
        var openPoints = await db.AgentFindings.CountAsync(f => f.ProjectId == project.Id && f.Status == AgentFindingStatus.Proposed && f.Kind == AgentFindingKind.Missed, ct);

        // The agenda, most urgent first; by key and first name (people from outside the company may be invited).
        var agenda = new List<string>();
        if (blockers.Count > 0) agenda.Add($"Unblock {string.Join(", ", blockers.Take(2).Select(b => b.Split(' ')[0]))}");
        if (overdueAll.Count > 0) agenda.Add($"Late work: {string.Join(", ", overdueAll.Take(4).Select(t => $"{K(t.Number)} ({First(t.Owner)})"))}{(overdueAll.Count > 4 ? $" +{overdueAll.Count - 4}" : "")}");
        if (dueToday.Count > 0) agenda.Add($"Due today: {string.Join(", ", dueToday.Take(4).Select(t => $"{K(t.Number)} ({First(t.Owner)})"))}");
        if (items.Any(i => i.State is "open" or "due_today")) agenda.Add($"Follow up {items.Count(i => i.State is "open" or "due_today")} open action{(items.Count(i => i.State is "open" or "due_today") == 1 ? "" : "s")} from last time");
        if (openPoints > 0) agenda.Add($"{openPoints} point{(openPoints == 1 ? "" : "s")} nobody has picked up");
        if (pending - openPoints > 0) agenda.Add($"{pending - openPoints} proposal{(pending - openPoints == 1 ? "" : "s")} waiting for a decision");
        if (!string.IsNullOrWhiteSpace(meeting.Description)) agenda.Add("The organizer's agenda (in the invitation)");

        var done = items.Count(i => i.State == "done");
        var late = items.Count(i => i.State == "overdue");
        var blocked = items.Count(i => i.State == "blocked");
        var stillOpen = items.Count(i => i.State is "open" or "due_today");
        var unnecessary = overdueAll.Count == 0 && dueToday.Count == 0 && blockers.Count == 0 && pending == 0 && stillOpen + late + blocked == 0 && commitments.Count == 0
            && string.IsNullOrWhiteSpace(meeting.Description);
        var headline = items.Count > 0
            ? $"Since the last meeting: {items.Count} action{(items.Count == 1 ? "" : "s")} - {done} done, {late} late, {blocked} blocked, {stillOpen} open."
            : overdueAll.Count > 0 ? $"{overdueAll.Count} task{(overdueAll.Count == 1 ? " is" : "s are")} late in {project.Name}."
            : $"Nothing is late in {project.Name}.";
        if (unnecessary) headline += " Nothing needs discussing - this meeting may not be necessary.";
        var attending = await db.AgentMeetingBots.AsNoTracking().AnyAsync(b => b.MeetingId == meeting.Id && b.SessionStartUtc == session.Start && b.Kind == "bot" && b.Status != "failed", ct)
            || await db.AgentDelegations.AsNoTracking().AnyAsync(d => d.MeetingId == meeting.Id && d.SessionStartUtc == session.Start && d.Status != "cancelled", ct);
        return new MeetingBriefDto(meeting.Id, project.Id, project.Key, project.Name, meeting.Title, session.Start, session.End, meeting.GoogleMeetUri,
            headline, items.Count, done, late, blocked, stillOpen, items.OrderBy(i => i.State switch { "blocked" => 0, "overdue" => 1, "due_today" => 2, "open" => 3, _ => 4 }).ToList(),
            blockers, commitmentLines, agenda.Take(6).ToList(), pending, unnecessary, lastRun?.StartedAt, attending);
    }

    /// <summary>
    /// One tick for one project: the brief goes to each invited person (organizer included) once per session, the number of minutes before it
    /// starts that they chose (10 by default). Returns how many were sent.
    /// </summary>
    public async Task<int> SendDueAsync(ProjectAgentSettings s, CancellationToken ct)
    {
        if (!s.Enabled || !s.MeetingBriefs) return 0;
        var now = clock.Now;
        var sessions = await AgentSessions.ListAsync(db.ProjectMeetings.Where(m => m.ProjectId == s.ProjectId), now, now.AddMinutes(61), ct);
        var sent = 0;
        foreach (var session in sessions.Where(x => x.Start > now.AddMinutes(1)))
        {
            var invited = await db.MeetingParticipants.AsNoTracking().Where(p => p.MeetingId == session.Meeting.Id && p.UserId != null
                    && p.RsvpStatus != AttendeeRsvpStatus.Declined).Select(p => p.UserId!.Value).ToListAsync(ct);
            invited.Add(session.Meeting.OrganizerUserId);
            invited = invited.Distinct().ToList();
            var prefs = await db.AgentPersonalSettings.AsNoTracking().Where(p => invited.Contains(p.UserId)).ToDictionaryAsync(p => p.UserId, ct);
            MeetingBriefDto? brief = null;
            foreach (var uid in invited)
            {
                var pref = prefs.GetValueOrDefault(uid);
                if (pref is { MeetingBriefs: false }) continue;
                var minutes = Math.Clamp(pref?.BriefMinutes ?? 10, 5, 60);
                if (now < session.Start.AddMinutes(-minutes)) continue;
                var key = $"agent-brief:{session.Meeting.Id:N}:{session.Start:yyyyMMddHHmm}";
                if (await db.Notifications.AnyAsync(n => n.UserId == uid && n.DedupeKey == key, ct)) continue;
                brief ??= await BuildAsync(session, ct);
                var inMinutes = Math.Max(1, (int)Math.Round((session.Start - now).TotalMinutes));
                await notifications.AddAsync(uid, NotificationType.Meeting, Text.Truncate($"Brief: {session.Meeting.Title} in {inMinutes} min", 200)!,
                    Text.Truncate(brief.Headline + (brief.Agenda.Count > 0 ? $" Agenda: {string.Join("; ", brief.Agenda.Take(3))}." : ""), 500),
                    $"/command-center?brief={session.Meeting.Id}&at={session.Start:yyyy-MM-ddTHH:mm:ssZ}", key, toSelf: true, ct: ct);
                sent++;
            }
        }
        if (sent > 0) await db.SaveChangesAsync(ct);
        return sent;
    }
}
