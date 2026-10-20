using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Services;

namespace ProjectManagement.Application.Features.Time;

/// <summary>One week of a person's time against their normal week (capacity less planned leave), and where its approval stands.</summary>
public record InsightWeekDto(DateOnly WeekStart, int LoggedMinutes, int BillableMinutes, int TargetMinutes, int OvertimeMinutes, int LeaveDays, int MissingDays, string Status);
public record InsightShareDto(string Label, Guid? ProjectId, int Minutes);
public record InsightWeekdayDto(int Day, int AverageMinutes);
/// <summary>
/// A person's time over the last weeks: logged against their normal week, overtime (time above the normal day), planned leave, billable
/// share, where the time went, the shape of an average week, how often time is logged on the day it was spent, and the working days with
/// nothing logged.
/// </summary>
public record TimesheetInsightsDto(UserRefDto User, DateOnly From, DateOnly To, IReadOnlyList<InsightWeekDto> Weeks, IReadOnlyList<InsightShareDto> ByProject,
    IReadOnlyList<InsightWeekdayDto> ByWeekday, int LoggedMinutes, int BillableMinutes, int TargetMinutes, int OvertimeMinutes, decimal? Utilisation, decimal? BillableShare,
    decimal? SameDayShare, int Streak, IReadOnlyList<DateOnly> MissingDays);

public class TimesheetInsightsService(IAppDbContext db, ICurrentContext ctx, AppClock clock, TimeService time)
{
    public async Task<TimesheetInsightsDto> GetAsync(Guid? userId, int weeks, CancellationToken ct = default)
    {
        weeks = Math.Clamp(weeks, 4, 12);
        var tid = ctx.RequireTenantId();
        var today = clock.Today;
        var thisWeek = TimesheetApprovalService.WeekOf(today);
        var from = thisWeek.AddDays(-7 * (weeks - 1));
        var to = thisWeek.AddDays(6);
        // The timesheet's own access rule decides whose time this caller may see.
        var sheet = await time.TimesheetAsync(from, to, userId, ct);
        var who = sheet.User.Id;
        var entries = sheet.Entries.Where(e => !e.IsRunning).ToList();

        var capacity = await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid && m.UserId == who).Select(m => m.WeeklyCapacityMinutes).FirstOrDefaultAsync(ct)
                       ?? CapacityService.StandardWeekMinutes;
        var daily = (int)Math.Round(capacity / 5m);
        var leave = (await db.PlannedLeaves.AsNoTracking().Where(l => l.UserId == who && l.WorkDate >= from && l.WorkDate <= to).Select(l => l.WorkDate).ToListAsync(ct)).ToHashSet();
        var statuses = await db.TimesheetApprovals.AsNoTracking().Where(a => a.UserId == who && a.WeekStart >= from && a.WeekStart <= thisWeek)
            .ToDictionaryAsync(a => a.WeekStart, a => a.Status.ToString(), ct);
        var byDay = entries.GroupBy(e => e.WorkDate).ToDictionary(g => g.Key, g => g.Sum(e => e.Minutes));
        bool Working(DateOnly d) => d.DayOfWeek is not (DayOfWeek.Saturday or DayOfWeek.Sunday) && !leave.Contains(d);
        // The current week counts only up to today, so a Tuesday is not measured against a whole week.
        int Target(DateOnly d) => Working(d) && d <= today ? daily : 0;

        var weekRows = new List<InsightWeekDto>();
        for (var w = from; w <= thisWeek; w = w.AddDays(7))
        {
            var days = Enumerable.Range(0, 7).Select(i => w.AddDays(i)).ToList();
            var logged = days.Sum(d => byDay.GetValueOrDefault(d));
            weekRows.Add(new InsightWeekDto(w, logged, entries.Where(e => e.Billable && e.WorkDate >= w && e.WorkDate <= w.AddDays(6)).Sum(e => e.Minutes),
                days.Sum(Target), days.Sum(d => Math.Max(0, byDay.GetValueOrDefault(d) - (Working(d) ? daily : 0))), days.Count(leave.Contains),
                days.Count(d => Working(d) && d < today && byDay.GetValueOrDefault(d) == 0), statuses.GetValueOrDefault(w) ?? TimesheetApprovalService.NotSubmitted));
        }

        var projectIds = entries.Where(e => e.ProjectId != null && e.Kind == "task").Select(e => e.ProjectId!.Value).Distinct().ToList();
        var names = projectIds.Count == 0 ? [] : await db.Projects.AsNoTracking().Where(p => projectIds.Contains(p.Id)).ToDictionaryAsync(p => p.Id, p => p.Name, ct);
        var shares = entries.GroupBy(e => e.Kind == "work" ? (Guid?)null : e.ProjectId)
            .Select(g => new InsightShareDto(g.Key is { } p ? names.GetValueOrDefault(p) ?? "Project" : "Operational work", g.Key, g.Sum(e => e.Minutes)))
            .OrderByDescending(s => s.Minutes).ToList();
        if (shares.Count > 7) shares = [.. shares.Take(6), new InsightShareDto("Everything else", null, shares.Skip(6).Sum(s => s.Minutes))];

        var weekdays = Enumerable.Range(0, 7).Select(i =>
        {
            var dates = weekRows.Select(w => w.WeekStart.AddDays(i)).Where(d => d <= today).ToList();
            return new InsightWeekdayDto(i, dates.Count == 0 ? 0 : (int)Math.Round(dates.Average(d => (double)byDay.GetValueOrDefault(d))));
        }).ToList();

        // How often time was written down on the day it was spent (timers always are).
        var ids = entries.Select(e => e.Id).ToList();
        var stamps = ids.Count == 0 ? [] : await db.TimeEntries.AsNoTracking().Where(e => ids.Contains(e.Id)).Select(e => new { e.WorkDate, e.CreatedAt, e.StartedAt }).ToListAsync(ct);
        decimal? sameDay = stamps.Count == 0 ? null : Math.Round((decimal)stamps.Count(s => s.StartedAt != null || clock.LocalDate(s.CreatedAt) <= s.WorkDate) / stamps.Count, 4);

        // Consecutive working days logged, counting back from yesterday (today still has time to be logged).
        var streak = 0;
        for (var d = today.AddDays(-1); d >= from; d = d.AddDays(-1))
        {
            if (!Working(d)) continue;
            if (byDay.GetValueOrDefault(d) == 0) break;
            streak++;
        }
        if (byDay.GetValueOrDefault(today) > 0 && Working(today)) streak++;
        var missing = Enumerable.Range(1, 14).Select(i => today.AddDays(-i)).Where(d => d >= from && Working(d) && byDay.GetValueOrDefault(d) == 0).OrderBy(d => d).ToList();

        var total = entries.Sum(e => e.Minutes);
        var billable = entries.Where(e => e.Billable).Sum(e => e.Minutes);
        var target = weekRows.Sum(w => w.TargetMinutes);
        return new TimesheetInsightsDto(sheet.User, from, to, weekRows, shares, weekdays, total, billable, target, weekRows.Sum(w => w.OvertimeMinutes),
            target > 0 ? Math.Round((decimal)total / target, 4) : null, total > 0 ? Math.Round((decimal)billable / total, 4) : null, sameDay, streak, missing);
    }
}
