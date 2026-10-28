using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Insights;
using ProjectManagement.Application.Features.WorkItems;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Time;

/// <summary>A day that does not count towards the week's target: <c>Kind</c> is weekend, leave or holiday.</summary>
public record TargetDayOffDto(DateOnly Date, string Kind, string? Name);
/// <summary>
/// Where the week's expected hours come from: the person's weekly capacity (set in People, by <c>SetBy</c> on <c>SetAt</c>; <c>IsDefault</c> when
/// nobody set one and the standard 40 hours apply), shared over five working days, less planned leave and the workspace's holidays.
/// </summary>
public record TimesheetTargetDto(int WeeklyCapacityMinutes, bool IsDefault, string? SetBy, DateTime? SetAt, int DailyMinutes, int WorkingDays,
    IReadOnlyList<TargetDayOffDto> DaysOff, int TargetMinutes, string Explanation);
/// <summary>
/// One thing to check before submitting. <c>Severity</c>: error (submitting is refused) or warning (submit after acknowledging). <c>Fix</c>: log
/// (log time on <c>Date</c>), link (put the entry on a work item), billable (mark the entry billable), note (add a comment), stop (stop the timer)
/// or open (go to <c>Href</c>).
/// </summary>
public record TimesheetIssueDto(string Code, string Severity, string Message, DateOnly? Date, Guid? EntryId, string Fix, string FixLabel, string? Href = null,
    int? Minutes = null, string? Note = null);
public record TimesheetReviewDto(DateOnly WeekStart, DateOnly WeekEnd, int TotalMinutes, TimesheetTargetDto Target, IReadOnlyList<TimesheetIssueDto> Issues,
    int Errors, int Warnings, bool CanSubmit);

/// <summary>
/// The check before "Submit week": days with nothing logged, entries not on a work item, time on a billable project not marked billable,
/// billable time without a comment (it is what the client reads on the invoice), timer time overlapping a meeting or call on the person's
/// timeline, days over 12 hours, and the hard stops (a timer still running, nothing logged, the week already locked). Only the caller's own week.
/// </summary>
public class TimesheetReviewService(IAppDbContext db, ICurrentContext ctx, AppClock clock, TimesheetApprovalService approvals, TimelineService timeline)
{
    public const int LongDayMinutes = 12 * 60;
    public const int OverlapMinutes = 5;

    public async Task<TimesheetTargetDto> TargetAsync(Guid who, DateOnly week, CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        var end = week.AddDays(6);
        var member = await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid && m.UserId == who).Select(m => new { m.Id, m.WeeklyCapacityMinutes }).FirstOrDefaultAsync(ct);
        var capacity = member?.WeeklyCapacityMinutes ?? CapacityService.StandardWeekMinutes;
        string? setBy = null; DateTime? setAt = null;
        if (member?.WeeklyCapacityMinutes is not null)
        {
            var change = await db.AuditLogs.AsNoTracking().Where(a => a.TenantId == tid && a.EntityType == "TenantMember" && a.EntityId == member.Id && a.Action == "member.rates_changed")
                .OrderByDescending(a => a.CreatedAt).Select(a => new { a.CreatedAt, Name = db.Users.Where(u => u.Id == a.UserId).Select(u => u.DisplayName).FirstOrDefault() }).FirstOrDefaultAsync(ct);
            setBy = change?.Name; setAt = change?.CreatedAt;
        }
        var daily = (int)Math.Round(capacity / 5m);
        var leave = await db.PlannedLeaves.AsNoTracking().Where(l => l.UserId == who && l.WorkDate >= week && l.WorkDate <= end).Select(l => new { l.WorkDate, l.Note }).ToListAsync(ct);
        var holidays = await db.Holidays.AsNoTracking().Where(h => h.TenantId == tid && h.Date >= week && h.Date <= end).Select(h => new { h.Date, h.Name }).ToListAsync(ct);
        var off = new List<TargetDayOffDto>();
        var working = 0;
        for (var d = week; d <= end; d = d.AddDays(1))
        {
            if (d.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday) { off.Add(new TargetDayOffDto(d, "weekend", null)); continue; }
            if (holidays.FirstOrDefault(h => h.Date == d) is { } h) { off.Add(new TargetDayOffDto(d, "holiday", h.Name)); continue; }
            if (leave.FirstOrDefault(l => l.WorkDate == d) is { } l) { off.Add(new TargetDayOffDto(d, "leave", l.Note)); continue; }
            working++;
        }
        var target = daily * working;
        static string H(int m) => m % 60 == 0 ? $"{m / 60}h" : $"{m / 60}h {m % 60}m";
        var source = member?.WeeklyCapacityMinutes is null ? "the standard week (no capacity set in People)" : setBy is null ? "your weekly capacity in People" : $"your weekly capacity, set by {setBy} in People";
        var less = off.Where(o => o.Kind != "weekend").ToList();
        var explanation = $"{H(target)} = {H(capacity)} ({source}) over 5 working days" + (less.Count == 0 ? "." :
            $", less {less.Count} day{(less.Count == 1 ? "" : "s")} off ({string.Join(", ", less.Select(o => $"{o.Date:ddd d MMM} {(o.Kind == "holiday" ? o.Name ?? "holiday" : "leave")}"))}).");
        return new TimesheetTargetDto(capacity, member?.WeeklyCapacityMinutes is null, setBy, setAt, daily, working, off, target, explanation);
    }

    public async Task<TimesheetReviewDto> ReviewAsync(DateOnly? weekStart, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var week = TimesheetApprovalService.WeekOf(weekStart ?? clock.Today);
        var end = week.AddDays(6);
        var today = clock.Today;
        var target = await TargetAsync(me, week, ct);
        var status = await approvals.WeekAsync(week, null, ct);
        var entries = await (from t in db.TimeEntries.AsNoTracking()
                             where t.UserId == me && t.WorkDate >= week && t.WorkDate <= end
                             select new
                             {
                                 t.Id, t.WorkDate, t.Minutes, t.Note, t.Billable, t.StartedAt, t.EndedAt, t.TaskId, t.WorkTaskId, t.ProjectId,
                                 ProjectBillable = db.Projects.Where(p => p.Id == t.ProjectId).Select(p => (bool?)p.IsBillable).FirstOrDefault() ?? false,
                                 ProjectName = db.Projects.Where(p => p.Id == t.ProjectId).Select(p => p.Name).FirstOrDefault(),
                                 Title = t.TaskId != null ? db.Tasks.Where(x => x.Id == t.TaskId).Select(x => x.Title).FirstOrDefault()
                                     : db.WorkTasks.Where(x => x.Id == t.WorkTaskId).Select(x => x.Title).FirstOrDefault(),
                             }).OrderBy(t => t.WorkDate).Take(1000).ToListAsync(ct);
        var issues = new List<TimesheetIssueDto>();
        var done = entries.Where(e => !(e.StartedAt != null && e.EndedAt == null)).ToList();
        var total = done.Sum(e => e.Minutes);
        string What(string? title, string? project) => title is null ? project ?? "an entry" : $"“{(title.Length > 48 ? title[..48] + "…" : title)}”";

        // ---- hard stops
        if (status.Locked) issues.Add(new TimesheetIssueDto("locked", "error", status.Status == "Approved" ? "This week is already approved." : "This week is already waiting for approval.", null, null, "open", "Open approvals", "/insights?tab=time&s=approvals"));
        foreach (var r in entries.Where(e => e.StartedAt != null && e.EndedAt == null))
            issues.Add(new TimesheetIssueDto("running", "error", $"A timer is still running on {What(r.Title, r.ProjectName)}.", r.WorkDate, r.Id, "stop", "Stop timer"));
        if (total == 0) issues.Add(new TimesheetIssueDto("empty", "error", "Nothing is logged this week.", null, null, "log", "Log time", null));

        // ---- days
        var offDays = target.DaysOff.Select(o => o.Date).ToHashSet();
        for (var d = week; d <= end && d <= today; d = d.AddDays(1))
        {
            var minutes = done.Where(e => e.WorkDate == d).Sum(e => e.Minutes);
            if (!offDays.Contains(d) && minutes == 0 && d < today)
                issues.Add(new TimesheetIssueDto("missing-day", "warning", $"Nothing logged on {d:dddd d MMM}, a working day.", d, null, "log", "Log time", Minutes: target.DailyMinutes));
            if (minutes > LongDayMinutes)
                issues.Add(new TimesheetIssueDto("long-day", "warning", $"{minutes / 60}h {minutes % 60:00}m logged on {d:dddd d MMM}: more than 12 hours.", d, null, "log", "Check the day", Minutes: minutes));
        }

        // ---- entries
        foreach (var e in done)
        {
            if (e.TaskId is null && e.WorkTaskId is null)
                issues.Add(new TimesheetIssueDto("no-item", "warning", $"{e.Minutes / 60}h {e.Minutes % 60:00}m on {e.WorkDate:ddd d MMM} is not on a work item.", e.WorkDate, e.Id, "link", "Pick work item", e.ProjectId is { } p ? $"/work/projects/{p}" : "/work", e.Minutes, e.Note));
            if (e.ProjectBillable && !e.Billable)
                issues.Add(new TimesheetIssueDto("not-billable", "warning", $"{What(e.Title, e.ProjectName)} on {e.WorkDate:ddd d MMM} is on billable project {e.ProjectName} but not marked billable.", e.WorkDate, e.Id, "billable", "Mark billable", Minutes: e.Minutes, Note: e.Note));
            if ((e.Billable || e.ProjectBillable) && string.IsNullOrWhiteSpace(e.Note))
                issues.Add(new TimesheetIssueDto("note-missing", "warning", $"Billable time on {What(e.Title, e.ProjectName)} ({e.WorkDate:ddd d MMM}) has no comment; billable time needs one for the invoice.", e.WorkDate, e.Id, "note", "Add comment", Minutes: e.Minutes));
        }

        // ---- overlaps of timer time with meetings and calls on the person's own timeline
        var timed = done.Where(e => e.StartedAt != null && e.EndedAt != null).ToList();
        if (timed.Count > 0)
        {
            IReadOnlyList<TimelineEventDto> busy = [];
            try { busy = (await timeline.GetAsync(week, end, "me", null, ct)).Events.Where(x => x.Type is "meeting" or "call" && x.End is not null).ToList(); }
            catch (ForbiddenException) { /* no calendar for this person: nothing to compare with */ }
            foreach (var e in timed)
            {
                var s = DateTime.SpecifyKind(e.StartedAt!.Value, DateTimeKind.Utc); var f = DateTime.SpecifyKind(e.EndedAt!.Value, DateTimeKind.Utc);
                var hit = busy.Select(b => new { b, Over = (Min(f, b.End!.Value) - Max(s, b.Start)).TotalMinutes }).Where(x => x.Over >= OverlapMinutes).OrderByDescending(x => x.Over).FirstOrDefault();
                if (hit is not null)
                    issues.Add(new TimesheetIssueDto("overlap", "warning", $"{What(e.Title, e.ProjectName)} overlaps the {(hit.b.Type == "call" ? "call" : "meeting")} “{hit.b.Title}” by {(int)hit.Over}m on {e.WorkDate:ddd d MMM}.",
                        e.WorkDate, e.Id, "open", "Open in calendar", $"/?tab=calendar&date={e.WorkDate:yyyy-MM-dd}", e.Minutes, e.Note));
            }
        }

        var errors = issues.Count(i => i.Severity == "error");
        return new TimesheetReviewDto(week, end, total, target, issues, errors, issues.Count - errors, status.CanSubmit && errors == 0);

        static DateTime Min(DateTime a, DateTime b) => a < b ? a : b;
        static DateTime Max(DateTime a, DateTime b) => a > b ? a : b;
    }
}
