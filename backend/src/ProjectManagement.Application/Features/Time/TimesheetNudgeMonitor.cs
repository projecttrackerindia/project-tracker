using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Time;

/// <summary>
/// Gentle timesheet reminders, in each person's own working hours (10:00 to 19:00 on a weekday, their time zone): a working day that went
/// by with nothing logged, and - on Monday and Tuesday - last week still not submitted where the organization approves timesheets. Only
/// people who track time (anything logged in the last three weeks) are reminded, never on planned leave, and each reminder goes out once.
/// Everyone can switch them off under Notifications → "Timesheet reminders".
/// </summary>
public class TimesheetNudgeMonitor(IAppDbContext db, AppClock clock, NotificationRouter router, ILogger<TimesheetNudgeMonitor> log)
{
    private const int Batch = 5000;

    public async Task<int> RunAsync(CancellationToken ct = default)
    {
        var now = clock.Now;
        var since = DateOnly.FromDateTime(now).AddDays(-21);
        var people = await (
            from m in db.TenantMembers.IgnoreQueryFilters()
            join u in db.Users on m.UserId equals u.Id
            join t in db.Tenants.IgnoreQueryFilters() on m.TenantId equals t.Id
            where u.IsActive && m.Role != TenantRole.Guest && t.Status == TenantStatus.Active && !t.IsDeleted && t.Type == WorkspaceType.Organization
                  && db.TimeEntries.IgnoreQueryFilters().Any(e => e.TenantId == m.TenantId && e.UserId == m.UserId && e.WorkDate >= since)
            select new { m.TenantId, m.UserId, u.TimeZone }).Take(Batch).ToListAsync(ct);
        if (people.Count == 0) return 0;

        var tenants = people.Select(p => p.TenantId).Distinct().ToList();
        var approving = (await db.TimesheetApprovals.IgnoreQueryFilters().Where(a => tenants.Contains(a.TenantId) && a.CreatedAt >= now.AddDays(-90))
            .Select(a => a.TenantId).Distinct().ToListAsync(ct)).ToHashSet();

        // What the reminders need, loaded once: who logged which recent day, planned leave, and recent weeks' approval state.
        var recent = DateOnly.FromDateTime(now).AddDays(-10);
        var userIds = people.Select(p => p.UserId).Distinct().ToList();
        var days = (await db.TimeEntries.IgnoreQueryFilters().Where(e => tenants.Contains(e.TenantId) && userIds.Contains(e.UserId) && e.WorkDate >= recent)
            .Select(e => new { e.TenantId, e.UserId, e.WorkDate }).Distinct().ToListAsync(ct)).Select(x => (x.TenantId, x.UserId, x.WorkDate)).ToHashSet();
        var leave = (await db.PlannedLeaves.IgnoreQueryFilters().Where(l => tenants.Contains(l.TenantId) && userIds.Contains(l.UserId) && l.WorkDate >= recent && !l.IsDeleted)
            .Select(l => new { l.TenantId, l.UserId, l.WorkDate }).ToListAsync(ct)).Select(x => (x.TenantId, x.UserId, x.WorkDate)).ToHashSet();
        var weeks = (await db.TimesheetApprovals.IgnoreQueryFilters().Where(a => tenants.Contains(a.TenantId) && userIds.Contains(a.UserId) && a.WeekStart >= recent.AddDays(-7))
            .Select(a => new { a.TenantId, a.UserId, a.WeekStart, a.Status }).ToListAsync(ct)).ToDictionary(x => (x.TenantId, x.UserId, x.WeekStart), x => x.Status);

        var notes = new List<Notification>();
        foreach (var p in people)
        {
            var local = ZoneTime.ToLocal(now, ZoneTime.Find(p.TimeZone));
            if (local.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday || local.Hour < 10 || local.Hour >= 19) continue;
            var today = DateOnly.FromDateTime(local);
            var previous = today.AddDays(today.DayOfWeek == DayOfWeek.Monday ? -3 : -1);
            var week = TimesheetApprovalService.WeekOf(today);

            if (!days.Contains((p.TenantId, p.UserId, previous)) && !leave.Contains((p.TenantId, p.UserId, previous)))
                notes.Add(new Notification
                {
                    TenantId = p.TenantId, UserId = p.UserId, Type = NotificationType.TimesheetReminder, CreatedAt = now,
                    DedupeKey = $"ts-day:{p.TenantId:N}:{p.UserId:N}:{previous:yyyyMMdd}",
                    Title = $"No time logged for {previous:ddd d MMM}", Body = "Add it to your week while you still remember: the timesheet suggests what you worked on.",
                    Link = $"/timesheet?week={TimesheetApprovalService.WeekOf(previous):yyyy-MM-dd}",
                });

            if (approving.Contains(p.TenantId) && today.DayOfWeek is DayOfWeek.Monday or DayOfWeek.Tuesday)
            {
                var last = week.AddDays(-7);
                TimesheetStatus? status = weeks.TryGetValue((p.TenantId, p.UserId, last), out var st) ? st : null;
                var hadTime = Enumerable.Range(0, 7).Any(i => days.Contains((p.TenantId, p.UserId, last.AddDays(i))));
                if (hadTime && status is null or TimesheetStatus.Rejected)
                    notes.Add(new Notification
                    {
                        TenantId = p.TenantId, UserId = p.UserId, Type = NotificationType.TimesheetReminder, CreatedAt = now,
                        DedupeKey = $"ts-submit:{p.TenantId:N}:{p.UserId:N}:{last:yyyyMMdd}",
                        Title = status is null ? "Submit last week's timesheet" : "Your returned timesheet is waiting",
                        Body = $"The week of {last:d MMM} {(status is null ? "has not been sent for approval yet" : "was returned; fix it and submit it again")}.",
                        Link = $"/timesheet?week={last:yyyy-MM-dd}",
                    });
            }
        }
        if (notes.Count == 0) return 0;

        var keys = notes.Select(n => n.DedupeKey!).ToList();
        var sent = (await db.Notifications.IgnoreQueryFilters().Where(n => n.DedupeKey != null && keys.Contains(n.DedupeKey)).Select(n => n.DedupeKey!).ToListAsync(ct)).ToHashSet();
        await router.PreloadAsync(notes.Select(n => n.UserId), ct);
        var added = 0;
        foreach (var n in notes)
        {
            if (!sent.Add(n.DedupeKey!)) continue;
            if (await router.ApplyAsync(n, ct)) { db.Notifications.Add(n); added++; }
        }
        await db.SaveChangesAsync(ct);
        if (added > 0) log.LogInformation("Timesheet reminders: sent {Count}", added);
        return added;
    }
}
