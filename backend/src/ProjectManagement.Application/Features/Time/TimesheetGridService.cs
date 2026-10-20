using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.WorkItems;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Time;

/// <summary>One day of one row: the minutes logged there, how many entries make them up, and whether a timer is running in it.</summary>
public record GridCellDto(DateOnly Date, int Minutes, int Entries, bool Running, string? Note);
/// <summary>One thing time goes to in the week (a project task, "task", or a piece of operational work / an action item, "work").</summary>
public record GridRowDto(string Kind, Guid TargetId, string Key, string Title, Guid? ProjectId, string? ProjectName, bool Billable, IReadOnlyList<GridCellDto> Cells, int TotalMinutes);
/// <summary>A day of the week: what was logged, what the person normally works that day (0 at weekends and on planned leave) and their meetings.</summary>
public record GridDayDto(DateOnly Date, int Minutes, int TargetMinutes, bool Weekend, bool Leave, string? LeaveNote, bool Future, int Meetings, int MeetingMinutes);
/// <summary>Something the person probably worked on and can add as a row: <see cref="Reason"/> is lastWeek, assigned, touched or timer.</summary>
public record GridSuggestionDto(string Kind, Guid TargetId, string Key, string Title, Guid? ProjectId, string? ProjectName, string Reason);
public record TimesheetGridDto(DateOnly WeekStart, DateOnly WeekEnd, UserRefDto User, bool Mine, bool Editable, bool Locked, string Status, IReadOnlyList<GridDayDto> Days,
    IReadOnlyList<GridRowDto> Rows, IReadOnlyList<GridSuggestionDto> Suggestions, int TotalMinutes, int BillableMinutes, int TargetMinutes, int OvertimeMinutes, int MissingDays,
    TimeEntryDto? Running);
/// <summary>The total a cell should hold. 0 removes the time in it; <see cref="Note"/> null leaves the notes as they are.</summary>
public record GridCellChange(string Kind, Guid TargetId, DateOnly Date, int Minutes, string? Note = null);
public record SaveGridRequest(DateOnly WeekStart, IReadOnlyList<GridCellChange> Cells);
public record GridCellError(string Kind, Guid TargetId, DateOnly Date, string Message);
public record SaveGridResult(TimesheetGridDto Grid, int Saved, IReadOnlyList<GridCellError> Errors);
public record CopyWeekRequest(DateOnly WeekStart);

/// <summary>
/// The timesheet as a week grid: one row per task or piece of work, one column per day, each cell the total logged there. Typing a new
/// total into a cell logs, changes or removes entries through <see cref="TimeService"/>, so every rule of time tracking still applies (the
/// week lock, 24 hours a day, nothing in the future, who may log on what). Alongside: the person's normal day (their weekly capacity over
/// five days, nothing on planned leave), their meetings, and what they probably worked on but have not logged yet.
/// </summary>
public class TimesheetGridService(IAppDbContext db, ICurrentContext ctx, AppClock clock, TimeService time, TimesheetApprovalService approvals, ProjectAccess access,
    PermissionService permissions)
{
    public const int MaxCells = 120;
    private const int MaxSuggestions = 12;

    // ------------------------------------------------------------------ read

    public async Task<TimesheetGridDto> GridAsync(DateOnly? weekStart, Guid? userId, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId(); var tid = ctx.RequireTenantId();
        var week = TimesheetApprovalService.WeekOf(weekStart ?? clock.Today);
        var end = week.AddDays(6);
        // The same rule as the timesheet: your own, your reporting line, or broad reports access.
        var sheet = await time.TimesheetAsync(week, end, userId, ct);
        var who = sheet.User.Id;
        var mine = who == me;
        var status = await approvals.WeekAsync(week, who, ct);
        var today = clock.Today;

        var capacity = await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid && m.UserId == who).Select(m => m.WeeklyCapacityMinutes).FirstOrDefaultAsync(ct)
                       ?? CapacityService.StandardWeekMinutes;
        var daily = (int)Math.Round(capacity / 5m);
        var leave = await db.PlannedLeaves.AsNoTracking().Where(l => l.UserId == who && l.WorkDate >= week && l.WorkDate <= end)
            .Select(l => new { l.WorkDate, l.Note }).ToListAsync(ct);
        var meetings = await MeetingsAsync(who, week, end, ct);

        var done = sheet.Entries.Where(e => !e.IsRunning).ToList();
        var days = new List<GridDayDto>();
        for (var d = week; d <= end; d = d.AddDays(1))
        {
            var weekend = d.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday;
            var off = leave.FirstOrDefault(l => l.WorkDate == d);
            var m = meetings.GetValueOrDefault(d);
            days.Add(new GridDayDto(d, done.Where(e => e.WorkDate == d).Sum(e => e.Minutes), weekend || off is not null ? 0 : daily, weekend, off is not null, off?.Note,
                d > today, m.Count, m.Minutes));
        }

        var projectIds = sheet.Entries.Where(e => e.ProjectId != null).Select(e => e.ProjectId!.Value).Distinct().ToList();
        var projectNames = projectIds.Count == 0 ? [] : await db.Projects.AsNoTracking().Where(p => projectIds.Contains(p.Id)).ToDictionaryAsync(p => p.Id, p => p.Name, ct);
        var rows = sheet.Entries
            .GroupBy(e => (Kind: e.Kind, Target: e.Kind == "work" ? e.WorkTaskId!.Value : e.TaskId!.Value))
            .Select(g =>
            {
                var first = g.First();
                var cells = Enumerable.Range(0, 7).Select(i =>
                {
                    var d = week.AddDays(i);
                    var here = g.Where(e => e.WorkDate == d).ToList();
                    var notes = string.Join(" · ", here.Where(e => !string.IsNullOrWhiteSpace(e.Note)).Select(e => e.Note));
                    return new GridCellDto(d, here.Where(e => !e.IsRunning).Sum(e => e.Minutes), here.Count(e => !e.IsRunning), here.Any(e => e.IsRunning), notes.Length == 0 ? null : notes);
                }).ToList();
                return new GridRowDto(g.Key.Kind, g.Key.Target, first.TaskKey, first.TaskTitle, first.ProjectId,
                    first.ProjectId is { } p ? projectNames.GetValueOrDefault(p) : null, g.Any(e => e.Billable), cells, cells.Sum(c => c.Minutes));
            })
            .OrderBy(r => r.ProjectName ?? "￿").ThenBy(r => r.Key).ToList();

        var total = done.Sum(e => e.Minutes);
        var target = days.Sum(d => d.TargetMinutes);
        var overtime = days.Sum(d => Math.Max(0, d.Minutes - (d.TargetMinutes > 0 ? d.TargetMinutes : 0)));
        var missing = days.Count(d => d.TargetMinutes > 0 && d.Date < today && d.Minutes == 0);
        var editable = mine && !status.Locked;
        var running = mine ? await time.GetRunningAsync(ct) : null;
        var suggestions = mine ? await SuggestAsync(week, end, rows, running, ct) : [];
        return new TimesheetGridDto(week, end, sheet.User, mine, editable, status.Locked, status.Status, days, rows, suggestions, total,
            done.Where(e => e.Billable).Sum(e => e.Minutes), target, overtime, missing, running);
    }

    /// <summary>Meetings the person organised or was invited to, per day of their own calendar (cancelled ones left out).</summary>
    private async Task<Dictionary<DateOnly, (int Count, int Minutes)>> MeetingsAsync(Guid who, DateOnly from, DateOnly to, CancellationToken ct)
    {
        var start = clock.StartOfDayUtc(from); var stop = clock.StartOfDayUtc(to.AddDays(1));
        var rows = await db.ProjectMeetings.AsNoTracking()
            .Where(m => m.Status != MeetingStatus.Cancelled && m.StartTimeUtc >= start && m.StartTimeUtc < stop
                        && (m.OrganizerUserId == who || db.MeetingParticipants.Any(p => p.MeetingId == m.Id && p.UserId == who && p.RsvpStatus != AttendeeRsvpStatus.Declined)))
            .Select(m => new { m.StartTimeUtc, m.EndTimeUtc }).Take(300).ToListAsync(ct);
        return rows.GroupBy(r => clock.LocalDate(r.StartTimeUtc))
            .ToDictionary(g => g.Key, g => (g.Count(), g.Sum(r => (int)Math.Clamp((r.EndTimeUtc - r.StartTimeUtc).TotalMinutes, 0, 24 * 60))));
    }

    /// <summary>What the person probably worked on and has no row for yet: last week's rows, their running timer, what they changed this
    /// week, and open work assigned to them.</summary>
    private async Task<List<GridSuggestionDto>> SuggestAsync(DateOnly week, DateOnly end, IReadOnlyList<GridRowDto> rows, TimeEntryDto? running, CancellationToken ct)
    {
        var me = ctx.RequireUserId();
        var have = rows.Select(r => (r.Kind, r.TargetId)).ToHashSet();
        var list = new List<GridSuggestionDto>();
        void Add(GridSuggestionDto s) { if (list.Count < MaxSuggestions && have.Add((s.Kind, s.TargetId))) list.Add(s); }

        if (running is not null)
            Add(new GridSuggestionDto(running.Kind, running.Kind == "work" ? running.WorkTaskId!.Value : running.TaskId!.Value, running.TaskKey, running.TaskTitle, running.ProjectId, null, "timer"));

        var last = await time.TimesheetAsync(week.AddDays(-7), week.AddDays(-1), null, ct);
        foreach (var g in last.Entries.GroupBy(e => (e.Kind, Target: e.Kind == "work" ? e.WorkTaskId!.Value : e.TaskId!.Value)).OrderByDescending(g => g.Sum(e => e.Minutes)))
            Add(new GridSuggestionDto(g.Key.Kind, g.Key.Target, g.First().TaskKey, g.First().TaskTitle, g.First().ProjectId, null, "lastWeek"));

        // Tasks the person changed or commented on this week (from the activity log), then open tasks assigned to them.
        var from = clock.StartOfDayUtc(week); var to = clock.StartOfDayUtc(end.AddDays(1));
        var visible = access.VisibleTasks().Where(t => t.CompletedAt == null && t.Project!.Status != ProjectStatus.Archived);
        var touched = await db.Activities.AsNoTracking()
            .Where(a => a.ActorId == me && a.EntityType == "Task" && a.EntityId != null && a.CreatedAt >= from && a.CreatedAt < to)
            .GroupBy(a => a.EntityId!.Value).Select(g => new { Id = g.Key, Count = g.Count() }).OrderByDescending(x => x.Count).Take(20).ToListAsync(ct);
        var touchedIds = touched.Select(t => t.Id).ToList();
        var touchedTasks = touchedIds.Count == 0 ? [] : await visible.Where(t => touchedIds.Contains(t.Id))
            .Select(t => new { t.Id, t.Number, t.Title, t.ProjectId, Key = t.Project!.Key, Name = t.Project.Name }).ToListAsync(ct);
        foreach (var t in touched.Select(x => touchedTasks.FirstOrDefault(y => y.Id == x.Id)).Where(x => x is not null))
            Add(new GridSuggestionDto("task", t!.Id, $"{t.Key}-{t.Number}", t.Title, t.ProjectId, t.Name, "touched"));

        var assigned = await visible.Where(t => t.AssigneeId == me).OrderByDescending(t => t.UpdatedAt ?? t.CreatedAt).Take(10)
            .Select(t => new { t.Id, t.Number, t.Title, t.ProjectId, Key = t.Project!.Key, Name = t.Project.Name }).ToListAsync(ct);
        foreach (var t in assigned) Add(new GridSuggestionDto("task", t.Id, $"{t.Key}-{t.Number}", t.Title, t.ProjectId, t.Name, "assigned"));

        var open = new[] { WorkTaskStatus.ToDo, WorkTaskStatus.InProgress, WorkTaskStatus.OnHold };
        var seesWork = await permissions.LevelAsync(Modules.Work, ct) > 0;
        var work = await db.WorkTasks.AsNoTracking().Where(w => w.AssigneeId == me && open.Contains(w.Status) && (w.Kind == WorkTaskKind.ActionItem || seesWork))
            .OrderByDescending(w => w.UpdatedAt ?? w.CreatedAt).Take(8).Select(w => new { w.Id, w.Kind, w.Number, w.Title, w.RelatedProjectId }).ToListAsync(ct);
        foreach (var w in work) Add(new GridSuggestionDto("work", w.Id, WorkItemService.KeyOf(w.Kind, w.Number), w.Title, w.RelatedProjectId, null, "assigned"));

        // Project names for the ones that do not carry them yet.
        var ids = list.Where(s => s.ProjectId != null && s.ProjectName == null).Select(s => s.ProjectId!.Value).Distinct().ToList();
        if (ids.Count == 0) return list;
        var names = await db.Projects.AsNoTracking().Where(p => ids.Contains(p.Id)).ToDictionaryAsync(p => p.Id, p => p.Name, ct);
        return list.Select(s => s.ProjectName is null && s.ProjectId is { } p ? s with { ProjectName = names.GetValueOrDefault(p) } : s).ToList();
    }

    // ------------------------------------------------------------------ write

    /// <summary>Sets cells of the caller's own week. Each cell is saved on its own: one that cannot be (a locked week, a closed task) is
    /// reported back and the rest still go through.</summary>
    public async Task<SaveGridResult> SaveAsync(SaveGridRequest req, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var week = TimesheetApprovalService.WeekOf(req.WeekStart);
        if (req.Cells is null || req.Cells.Count == 0) throw new ValidationException("cells", "Nothing to save.");
        if (req.Cells.Count > MaxCells) throw new ValidationException("cells", $"Save at most {MaxCells} cells at once.");
        var errors = new List<GridCellError>();
        var saved = 0;
        foreach (var c in req.Cells.GroupBy(c => (c.Kind, c.TargetId, c.Date)).Select(g => g.Last()))
        {
            if (c.Kind is not ("task" or "work")) { errors.Add(new(c.Kind, c.TargetId, c.Date, "Unknown kind of row.")); continue; }
            if (TimesheetApprovalService.WeekOf(c.Date) != week) { errors.Add(new(c.Kind, c.TargetId, c.Date, "That day is not in this week.")); continue; }
            if (c.Minutes is < 0 or > 24 * 60) { errors.Add(new(c.Kind, c.TargetId, c.Date, "Enter between 0 and 24 hours.")); continue; }
            try { if (await SetCellAsync(me, c, ct)) saved++; }
            catch (AppException ex) { errors.Add(new(c.Kind, c.TargetId, c.Date, ex.Message)); }
        }
        return new SaveGridResult(await GridAsync(week, null, ct), saved, errors);
    }

    /// <summary>Makes one cell hold <see cref="GridCellChange.Minutes"/>: a new entry when it is empty, the one entry changed, or - when
    /// several entries make it up - the newest ones grown or shrunk (and removed when they reach nothing), so older notes survive.</summary>
    private async Task<bool> SetCellAsync(Guid me, GridCellChange c, CancellationToken ct)
    {
        var onWork = c.Kind == "work"; var target = c.TargetId; var date = c.Date;
        var entries = await db.TimeEntries.AsNoTracking()
            .Where(e => e.UserId == me && e.WorkDate == date && ((onWork && e.WorkTaskId == target) || (!onWork && e.TaskId == target)))
            .OrderBy(e => e.CreatedAt).Select(e => new { e.Id, e.Minutes, e.Note, e.Billable, Running = e.StartedAt != null && e.EndedAt == null }).ToListAsync(ct);
        if (entries.Any(e => e.Running)) throw new ConflictException("A timer is running here. Stop it first.", "TIMER_RUNNING");
        var current = entries.Sum(e => e.Minutes);
        var note = c.Note is null ? null : c.Note.Trim();
        var newest = entries.LastOrDefault();
        var noteChanged = note is not null && newest is not null && (newest.Note ?? "") != note;
        if (c.Minutes == current && !noteChanged) return false;

        if (c.Minutes == 0)
        {
            foreach (var e in entries) await time.DeleteAsync(e.Id, ct);
            return entries.Count > 0;
        }
        if (newest is null)
        {
            var log = new LogTimeRequest(c.Minutes, c.Date, string.IsNullOrEmpty(note) ? null : note);
            if (c.Kind == "work") await time.LogOnWorkTaskAsync(c.TargetId, log, ct); else await time.LogAsync(c.TargetId, log, ct);
            return true;
        }
        var delta = c.Minutes - current;
        if (delta >= 0)
        {
            await time.UpdateAsync(newest.Id, new UpdateTimeRequest(newest.Minutes + delta, c.Date, note ?? newest.Note), ct);
            return true;
        }
        // Less than before: take it off the newest entries first.
        var cut = -delta;
        for (var i = entries.Count - 1; i >= 0 && cut > 0; i--)
        {
            var e = entries[i];
            if (e.Minutes <= cut) { await time.DeleteAsync(e.Id, ct); cut -= e.Minutes; }
            else { await time.UpdateAsync(e.Id, new UpdateTimeRequest(e.Minutes - cut, c.Date, i == entries.Count - 1 ? note ?? e.Note : e.Note), ct); cut = 0; }
        }
        return true;
    }

    /// <summary>Fills the caller's empty cells of this week with what they logged on the same weekday last week. Days in the future, at the
    /// weekend or on planned leave are left alone, and nothing already logged is overwritten.</summary>
    public async Task<SaveGridResult> CopyPreviousAsync(CopyWeekRequest req, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var week = TimesheetApprovalService.WeekOf(req.WeekStart);
        await approvals.EnsureOpenAsync(me, week, ct);
        var today = clock.Today;
        var previous = await time.TimesheetAsync(week.AddDays(-7), week.AddDays(-1), null, ct);
        var current = await time.TimesheetAsync(week, week.AddDays(6), null, ct);
        var leave = (await db.PlannedLeaves.AsNoTracking().Where(l => l.UserId == me && l.WorkDate >= week && l.WorkDate <= week.AddDays(6)).Select(l => l.WorkDate).ToListAsync(ct)).ToHashSet();
        var filled = current.Entries.Select(e => (e.Kind, Target: e.Kind == "work" ? e.WorkTaskId!.Value : e.TaskId!.Value, e.WorkDate)).ToHashSet();
        var changes = previous.Entries.Where(e => !e.IsRunning)
            .GroupBy(e => (e.Kind, Target: e.Kind == "work" ? e.WorkTaskId!.Value : e.TaskId!.Value, Date: e.WorkDate.AddDays(7)))
            .Where(g => g.Key.Date <= today && g.Key.Date.DayOfWeek is not (DayOfWeek.Saturday or DayOfWeek.Sunday) && !leave.Contains(g.Key.Date) && !filled.Contains(g.Key))
            .Select(g => new GridCellChange(g.Key.Kind, g.Key.Target, g.Key.Date, Math.Min(24 * 60, g.Sum(e => e.Minutes))))
            .Take(MaxCells).ToList();
        if (changes.Count == 0) return new SaveGridResult(await GridAsync(week, null, ct), 0, []);
        return await SaveAsync(new SaveGridRequest(week, changes), ct);
    }
}
