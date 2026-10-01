using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.Work;
using ProjectManagement.Application.Features.WorkItems;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Time;

/// <summary>
/// One time entry. It was spent either on a project task (<see cref="TaskId"/>, <see cref="Kind"/> "task") or on a work task
/// (<see cref="WorkTaskId"/>, <see cref="Kind"/> "work"); <see cref="TaskKey"/> and <see cref="TaskTitle"/> name whichever it was.
/// </summary>
public record TimeEntryDto(Guid Id, Guid? TaskId, string TaskKey, string TaskTitle, Guid? ProjectId, UserRefDto User, DateOnly WorkDate,
    int Minutes, string? Note, bool IsRunning, DateTime? StartedAt, bool CanEdit, Guid? WorkTaskId = null, string Kind = "task");
/// <summary>Everything about the time on one task (or work task), plus the caller's own running timer (on anything).</summary>
public record TaskTimeDto(IReadOnlyList<TimeEntryDto> Entries, int TotalMinutes, decimal? EstimatedHours, TimeEntryDto? MyTimer);
public record LogTimeRequest(int Minutes, DateOnly? WorkDate, string? Note);
public record UpdateTimeRequest(int Minutes, DateOnly WorkDate, string? Note);

public record TimeByDayDto(DateOnly Date, int Minutes);
public record TimesheetDto(DateOnly From, DateOnly To, UserRefDto User, IReadOnlyList<TimeEntryDto> Entries, int TotalMinutes, IReadOnlyList<TimeByDayDto> ByDay);
public record TimeByPersonDto(Guid UserId, string Name, int Minutes);
public record TimeByTaskDto(Guid TaskId, string Key, string Title, int Minutes, decimal? EstimatedHours);
public record ProjectTimeDto(int TotalMinutes, decimal? EstimatedHours, IReadOnlyList<TimeByPersonDto> ByPerson, IReadOnlyList<TimeByTaskDto> TopTasks);

/// <summary>
/// Time tracking: hand-entered time and a start/stop timer, on project tasks and on work tasks alike, so a timesheet shows the whole
/// week and not only project delivery. A project task's "actual hours" is kept equal to the sum of its entries, so there is one honest
/// number instead of a typed guess next to a tracked one.
/// </summary>
public class TimeService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, PermissionService permissions, ProjectAccess access,
    ProjectManagement.Application.Features.Organization.ReportingLineService reporting, WorkTaskService workTasks)
{
    private const int MaxMinutesPerEntry = 24 * 60;
    private const int MaxRangeDays = 92;
    private const int MaxRows = 2000;

    // A class with member initialisers (not a positional record): EF can then order by its properties.
    private class Row
    {
        public Guid Id { get; init; }
        public Guid? TaskId { get; init; }
        public Guid? WorkTaskId { get; init; }
        public string? ProjectKey { get; init; }
        public int TaskNumber { get; init; }
        public string? TaskTitle { get; init; }
        public int WorkNumber { get; init; }
        public string? WorkTitle { get; init; }
        public WorkTaskKind WorkKind { get; init; }
        public Guid? ProjectId { get; init; }
        public Guid UserId { get; init; }
        public string UserName { get; init; } = "";
        public DateOnly WorkDate { get; init; }
        public int Minutes { get; init; }
        public string? Note { get; init; }
        public DateTime? StartedAt { get; init; }
        public DateTime? EndedAt { get; init; }
    }

    private IQueryable<Row> Rows(IQueryable<TimeEntry> entries) =>
        from e in entries
        join u in db.Users on e.UserId equals u.Id
        join t in db.Tasks on e.TaskId equals (Guid?)t.Id into tj
        from t in tj.DefaultIfEmpty()
        join p in db.Projects on e.ProjectId equals (Guid?)p.Id into pj
        from p in pj.DefaultIfEmpty()
        join w in db.WorkTasks on e.WorkTaskId equals (Guid?)w.Id into wj
        from w in wj.DefaultIfEmpty()
        // Time on a deleted task or work task leaves the lists with it, as it always has.
        where (e.TaskId == null || t != null) && (e.WorkTaskId == null || w != null)
        select new Row
        {
            Id = e.Id, TaskId = e.TaskId, WorkTaskId = e.WorkTaskId, ProjectKey = p != null ? p.Key : null, TaskNumber = t != null ? t.Number : 0, TaskTitle = t != null ? t.Title : null,
            WorkNumber = w != null ? w.Number : 0, WorkTitle = w != null ? w.Title : null, WorkKind = w != null ? w.Kind : WorkTaskKind.Operational,
            ProjectId = e.ProjectId, UserId = e.UserId, UserName = u.DisplayName, WorkDate = e.WorkDate, Minutes = e.Minutes, Note = e.Note, StartedAt = e.StartedAt, EndedAt = e.EndedAt,
        };

    private bool IsAdmin => ctx.Role is TenantRole.Owner or TenantRole.Admin;

    private TimeEntryDto ToDto(Row r)
    {
        var onWork = r.WorkTaskId is not null;
        var key = onWork ? WorkItemService.KeyOf(r.WorkKind, r.WorkNumber) : $"{r.ProjectKey}-{r.TaskNumber}";
        var title = (onWork ? r.WorkTitle : r.TaskTitle) ?? "(deleted)";
        return new TimeEntryDto(r.Id, r.TaskId, key, title, r.ProjectId, new UserRefDto(r.UserId, r.UserName), r.WorkDate, r.Minutes, r.Note,
            r.StartedAt is not null && r.EndedAt is null, r.StartedAt, r.UserId == ctx.UserId || IsAdmin, r.WorkTaskId, onWork ? "work" : "task");
    }

    private async Task<TimeEntryDto> DtoAsync(Guid id, CancellationToken ct) => ToDto(await Rows(db.TimeEntries.Where(e => e.Id == id)).OrderBy(r => r.Id).FirstAsync(ct));

    private async Task<TaskItem> VisibleTaskAsync(Guid taskId, CancellationToken ct) =>
        await access.VisibleTasks().FirstOrDefaultAsync(t => t.Id == taskId, ct) ?? throw new NotFoundException("Task not found.");

    private async Task RequireWritableAsync(TaskItem task, CancellationToken ct)
    {
        await permissions.RequireTaskEditAsync(task, ct);
        var status = await db.Projects.Where(p => p.Id == task.ProjectId).Select(p => p.Status).FirstAsync(ct);
        if (status == ProjectStatus.Archived)
            throw new ConflictException("Archived projects are read-only. Restore the project to log time.", "PROJECT_ARCHIVED");
    }

    /// <summary>Keeps a project task's actual hours equal to its tracked time (only once there is tracked time). Work tasks just sum their entries.</summary>
    private async Task SyncActualHoursAsync(Guid? taskId, CancellationToken ct)
    {
        if (taskId is not { } id) return;
        var minutes = await db.TimeEntries.Where(e => e.TaskId == id && !(e.StartedAt != null && e.EndedAt == null)).SumAsync(e => (int?)e.Minutes, ct) ?? 0;
        var task = await db.Tasks.FirstOrDefaultAsync(t => t.Id == id, ct);
        if (task is null) return;
        if (minutes > 0 || await db.TimeEntries.AnyAsync(e => e.TaskId == id, ct)) task.ActualHours = Math.Round(minutes / 60m, 2);
    }

    // ---------------------------------------------------------------- per task

    public async Task<TaskTimeDto> GetForTaskAsync(Guid taskId, CancellationToken ct = default)
    {
        var task = await VisibleTaskAsync(taskId, ct);
        var rows = await Rows(db.TimeEntries.Where(e => e.TaskId == taskId)).OrderByDescending(r => r.WorkDate).ThenByDescending(r => r.Id).Take(MaxRows).ToListAsync(ct);
        var entries = rows.Select(ToDto).ToList();
        return new TaskTimeDto(entries, entries.Where(e => !e.IsRunning).Sum(e => e.Minutes), task.EstimatedHours, await GetRunningAsync(ct));
    }

    public async Task<TimeEntryDto> LogAsync(Guid taskId, LogTimeRequest req, CancellationToken ct = default)
    {
        var task = await VisibleTaskAsync(taskId, ct);
        await RequireWritableAsync(task, ct);
        var entry = await AddEntryAsync(task.TenantId, taskId, null, task.ProjectId, req, ct);
        recorder.Activity("task.time_logged", "Task", taskId, $"Logged {Format(req.Minutes)} on \"{task.Title}\"", task.ProjectId);
        await db.SaveChangesAsync(ct);
        await SyncActualHoursAsync(taskId, ct);
        await db.SaveChangesAsync(ct);
        return await DtoAsync(entry.Id, ct);
    }

    // ---------------------------------------------------------------- per work task

    public async Task<TaskTimeDto> GetForWorkTaskAsync(Guid workTaskId, CancellationToken ct = default)
    {
        await workTasks.RequireVisibleAsync(workTaskId, ct);
        var rows = await Rows(db.TimeEntries.Where(e => e.WorkTaskId == workTaskId)).OrderByDescending(r => r.WorkDate).ThenByDescending(r => r.Id).Take(MaxRows).ToListAsync(ct);
        var entries = rows.Select(ToDto).ToList();
        return new TaskTimeDto(entries, entries.Where(e => !e.IsRunning).Sum(e => e.Minutes), null, await GetRunningAsync(ct));
    }

    public async Task<TimeEntryDto> LogOnWorkTaskAsync(Guid workTaskId, LogTimeRequest req, CancellationToken ct = default)
    {
        var work = await workTasks.RequireTimeLoggableAsync(workTaskId, ct);
        var entry = await AddEntryAsync(work.TenantId, null, workTaskId, work.RelatedProjectId, req, ct);
        recorder.Activity("worktask.time_logged", "WorkTask", workTaskId, $"Logged {Format(req.Minutes)} on {WorkTaskService.KeyOf(work.Number)} “{work.Title}”", null);
        await db.SaveChangesAsync(ct);
        return await DtoAsync(entry.Id, ct);
    }

    private async Task<TimeEntry> AddEntryAsync(Guid tenantId, Guid? taskId, Guid? workTaskId, Guid? projectId, LogTimeRequest req, CancellationToken ct)
    {
        var userId = ctx.RequireUserId();
        var date = req.WorkDate ?? clock.Today;
        Validate(req.Minutes, date);
        await EnsureDayHasRoomAsync(userId, date, req.Minutes, null, ct);
        var entry = new TimeEntry
        {
            TenantId = tenantId, TaskId = taskId, WorkTaskId = workTaskId, ProjectId = projectId, UserId = userId, WorkDate = date,
            Minutes = req.Minutes, Note = Clean(req.Note), CreatedAt = clock.Now, CreatedBy = userId,
        };
        db.TimeEntries.Add(entry);
        return entry;
    }

    // ---------------------------------------------------------------- timer

    public async Task<TimeEntryDto?> GetRunningAsync(CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var id = await db.TimeEntries.Where(e => e.UserId == uid && e.StartedAt != null && e.EndedAt == null).Select(e => (Guid?)e.Id).FirstOrDefaultAsync(ct);
        return id is { } found ? await DtoAsync(found, ct) : null;
    }

    /// <summary>Starts the timer on a task. A timer that is already running (on anything) is stopped first and its time is kept.</summary>
    public async Task<TimeEntryDto> StartTimerAsync(Guid taskId, CancellationToken ct = default)
    {
        var task = await VisibleTaskAsync(taskId, ct);
        await RequireWritableAsync(task, ct);
        return await StartAsync(task.TenantId, taskId, null, task.ProjectId, ct);
    }

    /// <summary>Starts the timer on a work task, the same way.</summary>
    public async Task<TimeEntryDto> StartWorkTimerAsync(Guid workTaskId, CancellationToken ct = default)
    {
        var work = await workTasks.RequireTimeLoggableAsync(workTaskId, ct);
        return await StartAsync(work.TenantId, null, workTaskId, work.RelatedProjectId, ct);
    }

    private async Task<TimeEntryDto> StartAsync(Guid tenantId, Guid? taskId, Guid? workTaskId, Guid? projectId, CancellationToken ct)
    {
        var userId = ctx.RequireUserId();
        var running = await db.TimeEntries.FirstOrDefaultAsync(e => e.UserId == userId && e.StartedAt != null && e.EndedAt == null, ct);
        if (running is not null)
        {
            if (running.TaskId == taskId && running.WorkTaskId == workTaskId) return await DtoAsync(running.Id, ct);
            Finish(running);
            await db.SaveChangesAsync(ct);
            await SyncActualHoursAsync(running.TaskId, ct);
        }

        var now = clock.Now;
        var entry = new TimeEntry { TenantId = tenantId, TaskId = taskId, WorkTaskId = workTaskId, ProjectId = projectId, UserId = userId, WorkDate = clock.Today, StartedAt = now, CreatedAt = now, CreatedBy = userId };
        db.TimeEntries.Add(entry);
        await db.SaveChangesAsync(ct);
        return await DtoAsync(entry.Id, ct);
    }

    public async Task<TimeEntryDto> StopTimerAsync(CancellationToken ct = default)
    {
        var userId = ctx.RequireUserId();
        var running = await db.TimeEntries.FirstOrDefaultAsync(e => e.UserId == userId && e.StartedAt != null && e.EndedAt == null, ct)
            ?? throw new ConflictException("No timer is running.", "NO_TIMER");
        Finish(running);
        if (running.TaskId is { } taskId)
        {
            var task = await db.Tasks.Where(t => t.Id == taskId).Select(t => t.Title).FirstOrDefaultAsync(ct) ?? "task";
            recorder.Activity("task.time_logged", "Task", taskId, $"Logged {Format(running.Minutes)} on \"{task}\"", running.ProjectId);
        }
        else if (running.WorkTaskId is { } workId)
        {
            var work = await db.WorkTasks.Where(w => w.Id == workId).Select(w => new { w.Number, w.Title, w.Kind }).FirstOrDefaultAsync(ct);
            if (work is not null)
                recorder.Activity("worktask.time_logged", "WorkTask", workId, $"Logged {Format(running.Minutes)} on {WorkItemService.KeyOf(work.Kind, work.Number)} “{work.Title}”", null);
        }
        await db.SaveChangesAsync(ct);
        await SyncActualHoursAsync(running.TaskId, ct);
        await db.SaveChangesAsync(ct);
        return await DtoAsync(running.Id, ct);
    }

    private void Finish(TimeEntry e)
    {
        var now = clock.Now;
        var elapsed = (now - e.StartedAt!.Value).TotalMinutes;
        e.EndedAt = now;
        e.Minutes = (int)Math.Clamp(Math.Round(elapsed), 1, MaxMinutesPerEntry);
        if (elapsed > MaxMinutesPerEntry) e.Note = string.IsNullOrWhiteSpace(e.Note) ? "Timer was left running; capped at 24 h." : e.Note;
    }

    // ---------------------------------------------------------------- edit / delete

    private async Task<TimeEntry> OwnedAsync(Guid id, CancellationToken ct)
    {
        var entry = await db.TimeEntries.FirstOrDefaultAsync(e => e.Id == id, ct) ?? throw new NotFoundException("Time entry not found.");
        // Editing your own logged time doesn't need a fresh task-edit check: logging it in the first place was gated, and it stays
        // yours to fix up regardless of who the task is assigned to now.
        if (entry.UserId != ctx.UserId && !IsAdmin) throw new ForbiddenException("You can only change your own time entries.", "PERMISSION_DENIED");
        return entry;
    }

    public async Task<TimeEntryDto> UpdateAsync(Guid id, UpdateTimeRequest req, CancellationToken ct = default)
    {
        var entry = await OwnedAsync(id, ct);
        if (entry.EndedAt is null && entry.StartedAt is not null) throw new ConflictException("Stop the timer before editing this entry.", "TIMER_RUNNING");
        Validate(req.Minutes, req.WorkDate);
        await EnsureDayHasRoomAsync(entry.UserId, req.WorkDate, req.Minutes, entry.Id, ct);
        entry.Minutes = req.Minutes; entry.WorkDate = req.WorkDate; entry.Note = Clean(req.Note);
        entry.UpdatedAt = clock.Now;
        await db.SaveChangesAsync(ct);
        await SyncActualHoursAsync(entry.TaskId, ct);
        await db.SaveChangesAsync(ct);
        return await DtoAsync(id, ct);
    }

    public async Task DeleteAsync(Guid id, CancellationToken ct = default)
    {
        var entry = await OwnedAsync(id, ct);
        db.TimeEntries.Remove(entry);
        await db.SaveChangesAsync(ct);
        await SyncActualHoursAsync(entry.TaskId, ct);
        await db.SaveChangesAsync(ct);
    }

    // ---------------------------------------------------------------- reports

    /// <summary>Time on project tasks the caller can see, plus time on work tasks the caller can see (operational work with Work
    /// management access; action items of projects they can see).</summary>
    private async Task<IQueryable<TimeEntry>> VisibleAsync(IQueryable<TimeEntry> q, CancellationToken ct)
    {
        var seesWork = await permissions.LevelAsync(Modules.Work, ct) > 0;
        var seesProjects = await permissions.LevelAsync(Modules.Projects, ct) > 0;
        var visibleTasks = access.VisibleTasks().Select(t => t.Id);
        var visibleProjects = access.VisibleProjects().Select(p => p.Id);
        return q.Where(e => (e.TaskId != null && visibleTasks.Contains(e.TaskId.Value))
                            || (e.WorkTaskId != null && db.WorkTasks.Any(w => w.Id == e.WorkTaskId
                                && ((w.Kind == WorkTaskKind.Operational && seesWork)
                                    || (w.Kind == WorkTaskKind.ActionItem && seesProjects && w.RelatedProjectId != null && visibleProjects.Contains(w.RelatedProjectId.Value))))));
    }

    /// <summary>A person's time over a date range. Anyone can see their own; seeing someone else's needs to manage them
    /// (reporting line) or hold broad reports access (Owner/Admin, or a job-role profile that explicitly grants it -
    /// see PermissionService.HasBroadReportsAccessAsync; a plain Manager's default reports.view does not reach this
    /// far on its own, only their own reporting line).</summary>
    public async Task<TimesheetDto> TimesheetAsync(DateOnly? from, DateOnly? to, Guid? userId, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var who = userId ?? me;
        var inMyLine = who != me && await reporting.IsInMyLineAsync(who, ct);
        if (who != me && !inMyLine && !await permissions.HasBroadReportsAccessAsync(ct))
            throw new ForbiddenException("You can only view the timesheets of people in your reporting line.", "PERMISSION_DENIED");

        var end = to ?? clock.Today;
        var start = from ?? end.AddDays(-6);
        if (end < start) throw new ValidationException("to", "The end date must not be before the start date.");
        if (end.DayNumber - start.DayNumber > MaxRangeDays) throw new ValidationException("to", $"Choose a range of at most {MaxRangeDays} days.");

        var query = db.TimeEntries.Where(e => e.UserId == who && e.WorkDate >= start && e.WorkDate <= end);
        if (who != me && !inMyLine) query = await VisibleAsync(query, ct);
        var entries = (await Rows(query).OrderByDescending(r => r.WorkDate).ThenByDescending(r => r.Id).Take(MaxRows).ToListAsync(ct)).Select(ToDto).ToList();
        var name = await db.Users.Where(u => u.Id == who).Select(u => u.DisplayName).FirstOrDefaultAsync(ct) ?? "Unknown";

        var days = new List<TimeByDayDto>();
        for (var d = start; d <= end; d = d.AddDays(1)) days.Add(new TimeByDayDto(d, entries.Where(e => e.WorkDate == d && !e.IsRunning).Sum(e => e.Minutes)));
        return new TimesheetDto(start, end, new UserRefDto(who, name), entries, entries.Where(e => !e.IsRunning).Sum(e => e.Minutes), days);
    }

    /// <summary>Time entries across several people at once, for the team-wide Timesheet report - unlike
    /// <see cref="TimesheetAsync"/> this is not scoped to one person. <paramref name="restrictTo"/> is the caller's
    /// resolved audience (their own reporting line, or null for everyone visible with broad reports access) -
    /// computed by the caller, not here, since that policy is shared with the Workload report.</summary>
    public async Task<IReadOnlyList<TimeEntryDto>> TeamEntriesAsync(DateOnly from, DateOnly to, Guid? projectId, IReadOnlySet<Guid>? restrictTo, CancellationToken ct = default)
    {
        if (to < from) throw new ValidationException("to", "The end date must not be before the start date.");
        if (to.DayNumber - from.DayNumber > MaxRangeDays) throw new ValidationException("to", $"Choose a range of at most {MaxRangeDays} days.");

        var query = db.TimeEntries.Where(e => e.WorkDate >= from && e.WorkDate <= to && (restrictTo == null || restrictTo.Contains(e.UserId)));
        if (projectId is { } pid) { await access.GetProjectAsync(pid, ct); query = query.Where(e => e.ProjectId == pid); }
        query = await VisibleAsync(query, ct);
        return (await Rows(query).OrderBy(r => r.UserName).ThenByDescending(r => r.WorkDate).Take(MaxRows).ToListAsync(ct)).Select(ToDto).ToList();
    }

    /// <summary>Time spent delivering a project: entries on its tasks (work tasks only refer to a project, so their time is not counted here).</summary>
    public async Task<ProjectTimeDto> ProjectSummaryAsync(Guid projectId, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.ReportsView, ct);
        var project = await access.GetProjectAsync(projectId, ct);
        var q = db.TimeEntries.Where(e => e.ProjectId == projectId && e.TaskId != null && !(e.StartedAt != null && e.EndedAt == null));

        // Group first, then look names up: keeps each query simple enough for every database provider.
        var people = await q.GroupBy(e => e.UserId).Select(g => new { Id = g.Key, Minutes = g.Sum(x => x.Minutes) }).OrderByDescending(x => x.Minutes).Take(50).ToListAsync(ct);
        var personIds = people.Select(p => p.Id).ToList();
        var userNames = await db.Users.Where(u => personIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        var tasks = await q.GroupBy(e => e.TaskId!.Value).Select(g => new { Id = g.Key, Minutes = g.Sum(x => x.Minutes) }).OrderByDescending(x => x.Minutes).Take(10).ToListAsync(ct);
        var taskIds = tasks.Select(t => t.Id).ToList();
        var taskInfo = await db.Tasks.Where(t => taskIds.Contains(t.Id)).Select(t => new { t.Id, t.Number, t.Title, t.EstimatedHours }).ToDictionaryAsync(t => t.Id, ct);
        var total = await q.SumAsync(e => (int?)e.Minutes, ct) ?? 0;
        var estimate = await db.Tasks.Where(t => t.ProjectId == projectId).SumAsync(t => t.EstimatedHours, ct);

        return new ProjectTimeDto(total, estimate,
            people.Select(p => new TimeByPersonDto(p.Id, userNames.GetValueOrDefault(p.Id) ?? "Unknown", p.Minutes)).ToList(),
            tasks.Where(t => taskInfo.ContainsKey(t.Id)).Select(t => new TimeByTaskDto(t.Id, $"{project.Key}-{taskInfo[t.Id].Number}", taskInfo[t.Id].Title, t.Minutes, taskInfo[t.Id].EstimatedHours)).ToList());
    }

    // ---------------------------------------------------------------- rules

    private void Validate(int minutes, DateOnly date)
    {
        if (minutes < 1 || minutes > MaxMinutesPerEntry) throw new ValidationException("minutes", "Enter between 1 minute and 24 hours.");
        if (date > clock.Today) throw new ValidationException("workDate", "You cannot log time in the future.");
        if (date < clock.Today.AddYears(-1)) throw new ValidationException("workDate", "That date is too long ago.");
    }

    private async Task EnsureDayHasRoomAsync(Guid userId, DateOnly date, int minutes, Guid? excluding, CancellationToken ct)
    {
        var already = await db.TimeEntries.Where(e => e.UserId == userId && e.WorkDate == date && e.Id != excluding && !(e.StartedAt != null && e.EndedAt == null))
            .SumAsync(e => (int?)e.Minutes, ct) ?? 0;
        if (already + minutes > MaxMinutesPerEntry)
            throw new ValidationException("minutes", $"That would be more than 24 hours on {date:dd MMM}. You already logged {Format(already)}.");
    }

    private static string? Clean(string? note) => string.IsNullOrWhiteSpace(note) ? null : (note.Trim().Length > 500 ? note.Trim()[..500] : note.Trim());

    public static string Format(int minutes) => minutes < 60 ? $"{minutes}m" : minutes % 60 == 0 ? $"{minutes / 60}h" : $"{minutes / 60}h {minutes % 60}m";
}
