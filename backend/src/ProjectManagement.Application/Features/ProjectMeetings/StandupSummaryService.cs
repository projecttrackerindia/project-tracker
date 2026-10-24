using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Chat;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.ProjectMeetings;

public record StandupItem(string Key, Guid TaskId, string Title, string? Who, DateOnly? Due);
/// <summary>The card posted to a project's chat after a stand-up: what got done since the previous session, what is in progress, what is overdue.</summary>
public record StandupCard(string Kind, Guid MeetingId, string Title, string ProjectName, DateOnly Day, int DoneCount, int DoingCount, int OverdueCount,
    IReadOnlyList<StandupItem> Done, IReadOnlyList<StandupItem> Doing, IReadOnlyList<StandupItem> Overdue);

/// <summary>
/// After each session of a stand-up (a stand-up scheduled in Meet for a project), posts a summary of the project's work to its chat, so the team
/// has the same picture written down. Runs with the Google Meet worker (every 15 minutes): a session that ended within the last few hours,
/// and has no summary yet for that day, gets one. The organizer (or anyone who may edit projects) can also post it on demand.
/// </summary>
public class StandupSummaryService(IAppDbContext db, ICurrentContext ctx, AppClock clock, ChatService chat, PermissionService permissions, ProjectAccess access,
    IServiceScopeFactory scopes, ILogger<StandupSummaryService> log)
{
    private const int ListCap = 8;
    /// <summary>A session that ended longer ago than this is not summarised late (the next one will be).</summary>
    private static readonly TimeSpan LateLimit = TimeSpan.FromHours(4);

    // ---------------------------------------------------------------- on demand

    public async Task<StandupCard> PostNowAsync(Guid meetingId, CancellationToken ct = default)
    {
        var meeting = await db.ProjectMeetings.FirstOrDefaultAsync(m => m.Id == meetingId, ct) ?? throw new NotFoundException("Meeting not found.");
        await access.GetProjectAsync(meeting.ProjectId, ct);   // 404 when the project is not visible
        if (meeting.OrganizerUserId != ctx.UserId && !await permissions.HasAsync(Permissions.ProjectsEdit, ct))
            throw new ForbiddenException("Only the organizer can post the stand-up summary.", "PERMISSION_DENIED");
        var card = await BuildAsync(meeting, clock.Now, ct);
        await chat.PostProjectCardAsync(meeting.ProjectId, card, Snippet(card), ct);
        return card;
    }

    // ---------------------------------------------------------------- after each session

    public async Task<int> RunAsync(CancellationToken ct = default)
    {
        var now = clock.Now;
        // A series runs at most 120 weekly sessions (about 2 years 4 months), so nothing older can still have a session today.
        var floor = now - MeetingRecurrence.LongestSeries;
        var recent = now - LateLimit - TimeSpan.FromHours(24);
        var candidates = await db.ProjectMeetings.IgnoreQueryFilters()
            .Where(m => m.IsScrum && m.Status == MeetingStatus.Scheduled && m.StartTimeUtc <= now && m.StartTimeUtc >= floor
                        && (m.RecurrenceRule != null || m.EndTimeUtc >= recent)
                        && db.Tenants.IgnoreQueryFilters().Any(t => t.Id == m.TenantId && t.Status == TenantStatus.Active && !t.IsDeleted))
            .OrderByDescending(m => m.StartTimeUtc)
            .Select(m => new { m.Id, m.TenantId, m.OrganizerUserId, m.StartTimeUtc, m.EndTimeUtc, m.TimeZone, m.RecurrenceRule, m.LastSummaryDay })
            .Take(500).ToListAsync(ct);
        var posted = 0;
        foreach (var m in candidates)
        {
            var length = m.EndTimeUtc - m.StartTimeUtc;
            // The latest session that has ended, if it ended recently enough to be worth a summary.
            var session = MeetingRecurrence.Occurrences(m.RecurrenceRule, m.StartTimeUtc, m.TimeZone, now - LateLimit - length, now)
                .Where(at => at + length <= now).DefaultIfEmpty(DateTime.MinValue).Max();
            if (session == DateTime.MinValue) continue;
            var day = DateOnly.FromDateTime(ZoneTime.ToLocal(session, ZoneTime.Find(m.TimeZone))).ToString("yyyyMMdd");
            if (m.LastSummaryDay == day) continue;
            // Claim the day first: with several servers running this, only the one whose update took it posts the summary.
            var claimed = await db.ProjectMeetings.IgnoreQueryFilters().Where(x => x.Id == m.Id && (x.LastSummaryDay == null || x.LastSummaryDay != day))
                .ExecuteUpdateAsync(u => u.SetProperty(x => x.LastSummaryDay, day), ct) == 1;
            if (!claimed) continue;
            try
            {
                using var scope = scopes.CreateScope();
                var c = scope.ServiceProvider.GetRequiredService<CurrentContext>();
                c.TenantId = m.TenantId; c.UserId = m.OrganizerUserId; c.Role = TenantRole.Admin; c.WorkspaceType = WorkspaceType.Organization;
                var self = scope.ServiceProvider.GetRequiredService<StandupSummaryService>();
                await self.PostForSessionAsync(m.Id, session + length, ct);
                posted++;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                log.LogWarning(ex, "Stand-up summary failed for meeting {MeetingId}", m.Id);
            }
        }
        return posted;
    }

    /// <summary>Inside the workspace's own context (set by <see cref="RunAsync"/>).</summary>
    private async Task PostForSessionAsync(Guid meetingId, DateTime sessionEndUtc, CancellationToken ct)
    {
        var meeting = await db.ProjectMeetings.FirstOrDefaultAsync(m => m.Id == meetingId, ct);
        if (meeting is null) return;
        var card = await BuildAsync(meeting, sessionEndUtc, ct);
        await chat.PostProjectCardAsync(meeting.ProjectId, card, Snippet(card), ct);
    }

    // ---------------------------------------------------------------- the summary

    private async Task<StandupCard> BuildAsync(ProjectMeeting meeting, DateTime atUtc, CancellationToken ct)
    {
        var tz = ZoneTime.Find(meeting.TimeZone);
        var today = DateOnly.FromDateTime(ZoneTime.ToLocal(atUtc, tz));
        var project = await db.Projects.AsNoTracking().Where(p => p.Id == meeting.ProjectId).Select(p => new { p.Key, p.Name }).FirstOrDefaultAsync(ct)
            ?? throw new NotFoundException("Project not found.");
        // "Since the last stand-up": the session before this one (so Monday covers Friday), or the last day for a one-off call.
        var length = meeting.EndTimeUtc - meeting.StartTimeUtc;
        var previous = MeetingRecurrence.Occurrences(meeting.RecurrenceRule, meeting.StartTimeUtc, meeting.TimeZone, atUtc.AddDays(-10), atUtc - length - TimeSpan.FromMinutes(1))
            .DefaultIfEmpty(DateTime.MinValue).Max();
        var since = previous == DateTime.MinValue ? atUtc.AddDays(-1) : previous;

        var tasks = db.Tasks.AsNoTracking().Where(t => t.ProjectId == meeting.ProjectId);
        var done = tasks.Where(t => t.CompletedAt != null && t.CompletedAt >= since && t.Status!.Category == StatusCategory.Done);
        var doing = tasks.Where(t => t.Status!.Category == StatusCategory.Active);
        var overdue = tasks.Where(t => t.DueDate != null && t.DueDate < today && t.Status!.Category != StatusCategory.Done && t.Status.Category != StatusCategory.Cancelled);

        async Task<List<StandupItem>> Items(IQueryable<TaskItem> q) =>
            (await q.Take(ListCap).Select(t => new { t.Id, t.Number, t.Title, Who = t.Assignee != null ? t.Assignee.DisplayName : null, t.DueDate }).ToListAsync(ct))
                .Select(t => new StandupItem($"{project.Key}-{t.Number}", t.Id, t.Title, t.Who, t.DueDate)).ToList();

        return new StandupCard("standup", meeting.Id, meeting.Title, project.Name, today,
            await done.CountAsync(ct), await doing.CountAsync(ct), await overdue.CountAsync(ct),
            await Items(done.OrderByDescending(t => t.CompletedAt)), await Items(doing.OrderBy(t => t.DueDate == null).ThenBy(t => t.DueDate)), await Items(overdue.OrderBy(t => t.DueDate)));
    }

    private static string Snippet(StandupCard c) => $"Stand-up summary: {c.DoneCount} done, {c.DoingCount} in progress, {c.OverdueCount} overdue";
}
