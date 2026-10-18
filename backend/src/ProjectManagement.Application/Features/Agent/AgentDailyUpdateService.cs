using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Agent;

/// <summary>
/// Each morning (workspace time), everyone with work in a project the agent looks after gets their own update: what is due today, what is
/// slipping, what is new for them, how much is still open - and the delays and missed points approved since yesterday. In the bell and, by
/// their notification settings, by e-mail.
/// </summary>
public class AgentDailyUpdateService(IAppDbContext db, AppClock clock, NotificationService notifications, IOptions<AgentOptions> options)
{
    /// <summary>Whether this project's update is due now (the workspace's local hour has come and today's was not sent).</summary>
    public bool Due(ProjectAgentSettings s, string? timeZone, out string day)
    {
        var tz = ZoneTime.Find(ZoneTime.IsKnown(timeZone) ? timeZone : "Asia/Kolkata");
        var local = ZoneTime.ToLocal(clock.Now, tz);
        day = local.ToString("yyyyMMdd");
        return s.Enabled && s.DailyUpdates && local.Hour >= options.Value.DailyUpdateHour && s.DailySentDay != day;
    }

    /// <summary>Sends the updates for one project, in its workspace's context. Returns how many people got one.</summary>
    public async Task<int> SendAsync(ProjectAgentSettings s, string day, CancellationToken ct)
    {
        // Claim the day first: with several servers running this, only one sends.
        var claimed = await db.ProjectAgentSettings.Where(x => x.Id == s.Id && (x.DailySentDay == null || x.DailySentDay != day))
            .ExecuteUpdateAsync(u => u.SetProperty(x => x.DailySentDay, day), ct) == 1;
        if (!claimed) return 0;
        var project = await db.Projects.AsNoTracking().FirstOrDefaultAsync(p => p.Id == s.ProjectId, ct);
        if (project is null || project.Status == ProjectStatus.Archived) return 0;
        var tenantZone = await db.Tenants.AsNoTracking().Where(t => t.Id == s.TenantId).Select(t => t.TimeZone).FirstOrDefaultAsync(ct);
        var today = clock.TodayIn(tenantZone);
        var since = clock.Now.AddHours(-24);

        var open = await db.Tasks.AsNoTracking().Where(t => t.ProjectId == s.ProjectId && t.AssigneeId != null
                && t.Status!.Category != StatusCategory.Done && t.Status.Category != StatusCategory.Cancelled)
            .Select(t => new { t.AssigneeId, t.Number, t.Title, t.DueDate, t.CreatedAt }).ToListAsync(ct);
        var actions = await db.WorkTasks.AsNoTracking().Where(w => w.RelatedProjectId == s.ProjectId && w.Kind == WorkTaskKind.ActionItem && w.AssigneeId != null
                && w.Status != WorkTaskStatus.Completed && w.Status != WorkTaskStatus.Cancelled)
            .Select(w => new { w.AssigneeId, w.Title, w.DueDate, w.CreatedAt }).ToListAsync(ct);
        var notes = await db.AgentFindings.AsNoTracking().Where(f => f.ProjectId == s.ProjectId && f.Status == AgentFindingStatus.Applied && f.DecidedAt >= since
                && (f.Kind == AgentFindingKind.Delay || f.Kind == AgentFindingKind.Missed))
            .Select(f => new { f.Kind, f.Title }).ToListAsync(ct);
        var members = await db.ProjectMembers.AsNoTracking().Where(m => m.ProjectId == s.ProjectId).Select(m => m.UserId).ToListAsync(ct);
        var people = open.Select(t => t.AssigneeId!.Value).Concat(actions.Select(a => a.AssigneeId!.Value)).Concat(members).Append(project.OwnerId).ToHashSet();
        var active = await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == s.TenantId && people.Contains(m.UserId) && m.User!.IsActive).Select(m => m.UserId).ToListAsync(ct);

        string Key(int n) => $"{project.Key}-{n}";
        var team = notes.Count == 0 ? null
            : "Team: " + string.Join("; ", notes.GroupBy(n => n.Kind).Select(g => $"{g.Count()} {(g.Key == AgentFindingKind.Delay ? "delay" : "missed point")}{(g.Count() == 1 ? "" : "s")} ({string.Join(", ", g.Take(2).Select(x => x.Title))})"));
        var sent = 0;
        foreach (var uid in active)
        {
            var mine = open.Where(t => t.AssigneeId == uid).ToList();
            var myActions = actions.Where(a => a.AssigneeId == uid).ToList();
            var dueToday = mine.Where(t => t.DueDate == today).Select(t => $"{Key(t.Number)} {t.Title}")
                .Concat(myActions.Where(a => a.DueDate == today).Select(a => a.Title)).ToList();
            var late = mine.Where(t => t.DueDate < today).OrderBy(t => t.DueDate).Select(t => $"{Key(t.Number)} ({today.DayNumber - t.DueDate!.Value.DayNumber}d late)")
                .Concat(myActions.Where(a => a.DueDate < today).Select(a => $"{a.Title} (late)")).ToList();
            var fresh = mine.Where(t => t.CreatedAt >= since).Select(t => Key(t.Number)).Concat(myActions.Where(a => a.CreatedAt >= since).Select(a => a.Title)).ToList();
            var stillOpen = mine.Count + myActions.Count;
            if (dueToday.Count == 0 && late.Count == 0 && fresh.Count == 0 && stillOpen == 0 && (team is null || uid != project.OwnerId)) continue;
            var parts = new List<string>();
            if (dueToday.Count > 0) parts.Add($"Due today: {string.Join(", ", dueToday.Take(3))}{More(dueToday.Count, 3)}");
            if (late.Count > 0) parts.Add($"Slipping: {string.Join(", ", late.Take(3))}{More(late.Count, 3)}");
            if (fresh.Count > 0) parts.Add($"New for you: {string.Join(", ", fresh.Take(3))}{More(fresh.Count, 3)}");
            parts.Add($"Still open: {stillOpen}");
            if (team is not null) parts.Add(team);
            await notifications.AddAsync(uid, NotificationType.Briefing, $"{project.Name}: your update for {today:dd MMM}", string.Join(". ", parts),
                $"/projects/{project.Id}?tab=tasks", $"agent-daily:{project.Id}:{uid}:{day}", toSelf: true, ct: ct);
            sent++;
        }
        await db.SaveChangesAsync(ct);
        return sent;
    }

    private static string More(int count, int shown) => count > shown ? $" and {count - shown} more" : "";
}
