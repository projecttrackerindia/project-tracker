using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Agent;

/// <summary>
/// Minutes of a meeting the agent read, sent once everything it proposed from that meeting has been decided: what was decided, the work that
/// came out of it (with owners), delays and points nobody picked up. They go to the people in the meeting (its invitees, or the project's
/// members when the meeting is not one of the project's), in the bell and - by their notification settings - by e-mail.
/// </summary>
public class AgentMinutesService(IAppDbContext db, AppClock clock, NotificationService notifications)
{
    private static readonly AgentSourceKind[] MeetingSources = [AgentSourceKind.MeetingTranscript, AgentSourceKind.LiveMeeting, AgentSourceKind.Manual];

    /// <summary>Sends the minutes of these readings whose meetings are now fully decided. Returns how many were sent.</summary>
    public async Task<int> SendIfDecidedAsync(IEnumerable<Guid> runIds, CancellationToken ct)
    {
        var sent = 0;
        foreach (var runId in runIds.Distinct().ToList())
        {
            var run = await db.AgentRuns.AsNoTracking().FirstOrDefaultAsync(r => r.Id == runId, ct);
            if (run is null || run.Status != "done" || run.MinutesSentAt is not null || run.FindingCount == 0) continue;
            var s = await db.ProjectAgentSettings.AsNoTracking().FirstOrDefaultAsync(x => x.ProjectId == run.ProjectId, ct);
            if (s is null || !s.SendMinutes) continue;
            if (!await db.AgentSignals.AnyAsync(x => x.RunId == run.Id && MeetingSources.Contains(x.Source), ct)) continue;
            if (await db.AgentFindings.AnyAsync(f => f.RunId == run.Id && f.Status == AgentFindingStatus.Proposed, ct)) continue;
            // Claim it: two people deciding the last two items at once send one set of minutes.
            if (await db.AgentRuns.Where(r => r.Id == run.Id && r.MinutesSentAt == null).ExecuteUpdateAsync(u => u.SetProperty(r => r.MinutesSentAt, clock.Now), ct) != 1) continue;
            sent += await SendAsync(run, ct);
        }
        return sent;
    }

    private async Task<int> SendAsync(AgentRun run, CancellationToken ct)
    {
        var project = await db.Projects.AsNoTracking().FirstAsync(p => p.Id == run.ProjectId, ct);
        var title = run.MeetingId is { } mid
            ? await db.ProjectMeetings.AsNoTracking().Where(m => m.Id == mid).Select(m => m.Title).FirstOrDefaultAsync(ct)
              ?? await db.AgentMeetingBots.AsNoTracking().Where(b => b.MeetingId == mid && b.Title != null).Select(b => b.Title).FirstOrDefaultAsync(ct)
            : null;
        title ??= await db.AgentSignals.AsNoTracking().Where(x => x.RunId == run.Id).OrderBy(x => x.OccurredAt).Select(x => x.Title).FirstOrDefaultAsync(ct) ?? "Meeting";
        title = System.Text.RegularExpressions.Regex.Replace(title, @" \(part \d+ of \d+\)$", "");

        var findings = await db.AgentFindings.AsNoTracking().Where(f => f.RunId == run.Id && f.Status == AgentFindingStatus.Applied).ToListAsync(ct);
        var owners = findings.Where(f => f.AssigneeId != null).Select(f => f.AssigneeId!.Value).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => owners.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName.Split(' ', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? u.DisplayName, ct);
        string Owner(AgentFinding f) => f.AssigneeId is { } a && names.TryGetValue(a, out var n) ? $" ({n})" : "";
        string Item(AgentFinding f) => $"{(f.AppliedKey is { } k ? k + " " : "")}{f.Title}{Owner(f)}";
        var parts = new List<string>();
        if (run.Summary is { } sum) parts.Add(sum);
        void Add(string label, IEnumerable<AgentFinding> rows)
        {
            var list = rows.ToList();
            if (list.Count > 0) parts.Add($"{label}: {string.Join("; ", list.Take(4).Select(Item))}{(list.Count > 4 ? $" and {list.Count - 4} more" : "")}");
        }
        Add("Decided", findings.Where(f => f.Kind == AgentFindingKind.Decision));
        Add("Actions", findings.Where(f => f.Kind is AgentFindingKind.CreateTask or AgentFindingKind.CreateActionItem or AgentFindingKind.CreateIssue));
        Add("Updated", findings.Where(f => f.Kind is AgentFindingKind.UpdateTask or AgentFindingKind.UpdateIssue));
        Add("Delays", findings.Where(f => f.Kind == AgentFindingKind.Delay));
        Add("Not picked up", findings.Where(f => f.Kind == AgentFindingKind.Missed));
        Add("Ideas", findings.Where(f => f.Kind == AgentFindingKind.Suggestion));
        if (parts.Count == 0) return 0;

        // The people in it: the meeting's invitees with an account, else the project's people.
        var to = run.MeetingId is { } meeting
            ? await db.MeetingParticipants.AsNoTracking().Where(p => p.MeetingId == meeting && p.UserId != null).Select(p => p.UserId!.Value).ToListAsync(ct)
            : new List<Guid>();
        if (to.Count == 0) to = await db.ProjectMembers.AsNoTracking().Where(m => m.ProjectId == project.Id).Select(m => m.UserId).ToListAsync(ct);
        to.Add(project.OwnerId);
        to.AddRange(owners);
        var active = await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == project.TenantId && to.Contains(m.UserId) && m.User!.IsActive)
            .Select(m => m.UserId).Distinct().Take(200).ToListAsync(ct);
        foreach (var uid in active)
            await notifications.AddAsync(uid, NotificationType.Meeting, Text.Truncate($"Minutes: {title}", 200)!, string.Join(". ", parts),
                $"/projects/{project.Id}?tab=agent", $"agent-minutes:{run.Id}:{uid}", toSelf: true, ct: ct);
        await db.SaveChangesAsync(ct);
        return active.Count;
    }
}
