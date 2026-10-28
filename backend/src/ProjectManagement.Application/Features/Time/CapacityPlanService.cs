using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Admin;
using ProjectManagement.Application.Features.Billing;
using ProjectManagement.Application.Features.Organization;
using ProjectManagement.Application.Features.WorkItems;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Time;

/// <summary>One person in one week: capacity after leave, booked (estimated open work), leave days, and whether the week is over-booked.</summary>
public record CapacityPlanCellDto(DateOnly WeekStart, int CapacityMinutes, int BookedMinutes, int LeaveDays, int WorkingDays, bool OnLeave, bool Over, int HolidayDays = 0);
public record CapacityPlanPersonDto(Guid UserId, string Name, int WeeklyCapacityMinutes, IReadOnlyList<CapacityPlanCellDto> Weeks);
public record CapacityPlanTaskDto(Guid Id, string Title, int Minutes, DateOnly? DueDate);
/// <summary>A suggested move: tasks of an over-booked person that fit into someone else's free time in the same weeks.</summary>
public record CapacityPlanSuggestionDto(Guid FromUserId, string FromName, Guid ToUserId, string ToName, DateOnly FirstWeek, DateOnly LastWeek,
    int OverMinutes, int FreeMinutes, IReadOnlyList<CapacityPlanTaskDto> Tasks);
public record CapacityPlanTotalsDto(int CapacityMinutes, int BookedMinutes, decimal? Booked, int OverWeeks, int LeaveWeeks, int PublicHolidays);
public record CapacityPlanDto(DateOnly From, int Weeks, WorkloadScope Scope, IReadOnlyList<WorkloadScope> Available, bool Entitled,
    IReadOnlyList<DateOnly> WeekStarts, IReadOnlyList<CapacityPlanPersonDto> People, CapacityPlanTotalsDto Totals, CapacityPlanSuggestionDto? Suggestion);

/// <summary>
/// Capacity plan (Portfolio › Capacity): a read-only person × week view of the weeks ahead. Capacity is each person's weekly hours, less
/// planned leave; booked is the remaining estimate (estimate less actual hours) of their open tasks, spread evenly over the working days
/// from the task's start (or today) to its due date. Overdue or undated-start work lands from today. Tasks without an estimate or due
/// date are not booked. Public holidays (Settings › Holidays) are days off for everyone: they lower capacity and no work is spread onto them.
/// Same groups and entitlement as utilisation.
/// </summary>
public class CapacityPlanService(IAppDbContext db, ICurrentContext ctx, AppClock clock, EntitlementService entitlements, ReportingLineService reporting, WorkloadService workload)
{
    public async Task<CapacityPlanDto> GetAsync(DateOnly? from, int? weeks, WorkloadScope? requested, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId(); var tid = ctx.RequireTenantId();
        var n = weeks ?? 6;
        if (n is < 1 or > 12) throw new ValidationException("weeks", "Choose between 1 and 12 weeks.");
        var start = TimesheetApprovalService.WeekOf(from ?? clock.Today);
        var end = start.AddDays(n * 7 - 1);
        var weekStarts = Enumerable.Range(0, n).Select(i => start.AddDays(i * 7)).ToList();

        var available = await workload.AvailableAsync(ct);
        var scope = requested ?? available[0];
        if (!available.Contains(scope)) throw new ForbiddenException("You cannot see that group's capacity.", "PERMISSION_DENIED");
        var emptyTotals = new CapacityPlanTotalsDto(0, 0, null, 0, 0, 0);
        if (await entitlements.GetValueAsync(FeatureKeys.ResourceManagement, ct) <= 0)
            return new CapacityPlanDto(start, n, scope, available, false, weekStarts, [], emptyTotals, null);

        var people = scope switch
        {
            WorkloadScope.Reports => (await reporting.ReportsOfAsync(me, tid, ct)).Keys.ToList(),
            WorkloadScope.Everyone => await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid && m.Role != TenantRole.Guest).Select(m => m.UserId).Take(1000).ToListAsync(ct),
            _ => [me],
        };
        var members = await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid && people.Contains(m.UserId))
            .Select(m => new { m.UserId, m.User!.DisplayName, m.WeeklyCapacityMinutes }).ToListAsync(ct);
        var leave = await db.PlannedLeaves.AsNoTracking().Where(l => people.Contains(l.UserId) && l.WorkDate >= start && l.WorkDate <= end)
            .Select(l => new { l.UserId, l.WorkDate }).ToListAsync(ct);
        var leaveSet = leave.Select(l => (l.UserId, l.WorkDate)).ToHashSet();
        var holidays = await ProjectManagement.Application.Features.Platform.HolidayService.DatesAsync(db, start.AddDays(-7), end.AddDays(400), ct);
        bool Weekday(DateOnly d) => d.DayOfWeek is not DayOfWeek.Saturday and not DayOfWeek.Sunday;
        bool Workday(DateOnly d) => Weekday(d) && !holidays.Contains(d);
        var tasks = await db.Tasks.AsNoTracking()
            .Where(t => t.AssigneeId != null && people.Contains(t.AssigneeId.Value) && t.CompletedAt == null && t.EstimatedHours != null && t.EstimatedHours > 0
                        && t.DueDate != null && t.DueDate >= start.AddDays(-365) && (t.StartDate == null || t.StartDate <= end))
            .Select(t => new { t.Id, t.Title, AssigneeId = t.AssigneeId!.Value, t.StartDate, t.DueDate, t.EstimatedHours, t.ActualHours })
            .Take(5000).ToListAsync(ct);

        var today = clock.Today;
        // minutes per (person, week index, task)
        var booked = new Dictionary<(Guid User, int Week, Guid Task), double>();
        foreach (var t in tasks)
        {
            var remaining = (double)Math.Max(0m, t.EstimatedHours!.Value - (t.ActualHours ?? 0m)) * 60;
            if (remaining <= 0) continue;
            var due = t.DueDate!.Value;
            var first = t.StartDate is { } s && s > today ? s : today;
            if (due < first) due = first;   // overdue: everything lands today
            var days = new List<DateOnly>();
            for (var d = first; d <= due; d = d.AddDays(1))
                if (Workday(d) && !leaveSet.Contains((t.AssigneeId, d))) days.Add(d);
            if (days.Count == 0) days.Add(first);
            var perDay = remaining / days.Count;
            foreach (var d in days)
            {
                if (d < start || d > end) continue;
                var key = (t.AssigneeId, (d.DayNumber - start.DayNumber) / 7, t.Id);
                booked[key] = booked.GetValueOrDefault(key) + perDay;
            }
        }

        var rows = members.Select(m =>
        {
            var weekly = m.WeeklyCapacityMinutes ?? CapacityService.StandardWeekMinutes;
            var cells = weekStarts.Select((w, i) =>
            {
                var holidayDays = Enumerable.Range(0, 7).Count(k => { var d = w.AddDays(k); return Weekday(d) && holidays.Contains(d); });
                var working = CapacityService.WorkingDays(w, w.AddDays(6)) - holidayDays;
                var off = Enumerable.Range(0, 7).Count(k => { var d = w.AddDays(k); return Workday(d) && leaveSet.Contains((m.UserId, d)); });
                var cap = (int)Math.Round(weekly * (working - off) / 5m);
                var b = (int)Math.Round(booked.Where(kv => kv.Key.User == m.UserId && kv.Key.Week == i).Sum(kv => kv.Value));
                var onLeave = off >= working && working > 0;
                return new CapacityPlanCellDto(w, cap, b, off, working, onLeave, !onLeave && b > cap, holidayDays);
            }).ToList();
            return new CapacityPlanPersonDto(m.UserId, m.DisplayName, weekly, cells);
        }).OrderBy(r => r.Name).ToList();

        var capTotal = rows.Sum(r => r.Weeks.Sum(w => w.CapacityMinutes));
        var bookTotal = rows.Sum(r => r.Weeks.Sum(w => w.BookedMinutes));
        var totals = new CapacityPlanTotalsDto(capTotal, bookTotal, capTotal > 0 ? Math.Round((decimal)bookTotal / capTotal, 4) : null,
            rows.Sum(r => r.Weeks.Count(w => w.Over)), rows.Sum(r => r.Weeks.Count(w => w.OnLeave)), holidays.Count(d => d >= start && d <= end && Weekday(d)));

        return new CapacityPlanDto(start, n, scope, available, true, weekStarts, rows, totals, Suggest(rows, booked, tasks.ToDictionary(t => t.Id, t => (t.Title, t.DueDate))));
    }

    /// <summary>The most over-booked person, the over-booked weeks, and whoever has the most free time across those weeks: their biggest tasks there that fit.</summary>
    private static CapacityPlanSuggestionDto? Suggest(List<CapacityPlanPersonDto> rows, Dictionary<(Guid User, int Week, Guid Task), double> booked,
        Dictionary<Guid, (string Title, DateOnly? Due)> info)
    {
        var from = rows.Select(r => new { r, Over = r.Weeks.Where(w => w.Over).Sum(w => w.BookedMinutes - w.CapacityMinutes) }).Where(x => x.Over > 0)
            .OrderByDescending(x => x.Over).FirstOrDefault();
        if (from is null) return null;
        var overIdx = from.r.Weeks.Select((w, i) => (w, i)).Where(x => x.w.Over).Select(x => x.i).ToList();
        var to = rows.Where(r => r.UserId != from.r.UserId)
            .Select(r => new { r, Free = overIdx.Sum(i => r.Weeks[i].OnLeave ? 0 : Math.Max(0, r.Weeks[i].CapacityMinutes - r.Weeks[i].BookedMinutes)) })
            .Where(x => x.Free > 0).OrderByDescending(x => x.Free).FirstOrDefault();
        if (to is null) return null;
        var candidates = booked.Where(kv => kv.Key.User == from.r.UserId && overIdx.Contains(kv.Key.Week))
            .GroupBy(kv => kv.Key.Task).Select(g => new { Task = g.Key, Minutes = (int)Math.Round(g.Sum(kv => kv.Value)) })
            .Where(x => x.Minutes > 0).OrderByDescending(x => x.Minutes).ToList();
        var picked = new List<CapacityPlanTaskDto>();
        var moved = 0;
        foreach (var c in candidates)
        {
            if (moved >= from.Over || picked.Count >= 3) break;
            if (moved + c.Minutes > to.Free) continue;
            var (title, due) = info[c.Task];
            picked.Add(new CapacityPlanTaskDto(c.Task, title, c.Minutes, due));
            moved += c.Minutes;
        }
        if (picked.Count == 0) return null;
        return new CapacityPlanSuggestionDto(from.r.UserId, from.r.Name, to.r.UserId, to.r.Name, from.r.Weeks[overIdx[0]].WeekStart, from.r.Weeks[overIdx[^1]].WeekStart,
            from.Over, to.Free, picked);
    }
}
