using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Time;

public record TimeEntryDto(Guid Id, Guid TaskId, string TaskKey, string TaskTitle, Guid ProjectId, UserRefDto User, DateOnly WorkDate,
    int Minutes, string? Note, bool IsRunning, DateTime? StartedAt, bool CanEdit);
/// <summary>Everything about the time on one task, plus the caller's own running timer (on any task).</summary>
public record TaskTimeDto(IReadOnlyList<TimeEntryDto> Entries, int TotalMinutes, decimal? EstimatedHours, TimeEntryDto? MyTimer);
public record LogTimeRequest(int Minutes, DateOnly? WorkDate, string? Note);
public record UpdateTimeRequest(int Minutes, DateOnly WorkDate, string? Note);

public record TimeByDayDto(DateOnly Date, int Minutes);
public record TimesheetDto(DateOnly From, DateOnly To, UserRefDto User, IReadOnlyList<TimeEntryDto> Entries, int TotalMinutes, IReadOnlyList<TimeByDayDto> ByDay);
public record TimeByPersonDto(Guid UserId, string Name, int Minutes);
public record TimeByTaskDto(Guid TaskId, string Key, string Title, int Minutes, decimal? EstimatedHours);
public record ProjectTimeDto(int TotalMinutes, decimal? EstimatedHours, IReadOnlyList<TimeByPersonDto> ByPerson, IReadOnlyList<TimeByTaskDto> TopTasks);

/// <summary>
/// Time tracking: hand-entered time and a start/stop timer. The task's "actual hours" is kept equal to the sum of its entries, so
/// there is one honest number instead of a typed guess next to a tracked one.
/// </summary>
public class TimeService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, PermissionService permissions, ProjectAccess access,
    ProjectManagement.Application.Features.Organization.ReportingLineService reporting)
{
    private const int MaxMinutesPerEntry = 24 * 60;
    private const int MaxRangeDays = 92;
    private const int MaxRows = 2000;

    // A class with member initialisers (not a positional record): EF can then order by its properties.
    private class Row
    {
        public Guid Id { get; init; }
        public Guid TaskId { get; init; }
        public string ProjectKey { get; init; } = "";
        public int Number { get; init; }
        public string Title { get; init; } = "";
        public Guid ProjectId { get; init; }
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
        join t in db.Tasks on e.TaskId equals t.Id
        join p in db.Projects on t.ProjectId equals p.Id
        join u in db.Users on e.UserId equals u.Id
        select new Row
        {
            Id = e.Id, TaskId = e.TaskId, ProjectKey = p.Key, Number = t.Number, Title = t.Title, ProjectId = t.ProjectId, UserId = e.UserId,
            UserName = u.DisplayName, WorkDate = e.WorkDate, Minutes = e.Minutes, Note = e.Note, StartedAt = e.StartedAt, EndedAt = e.EndedAt,
        };

    private bool IsAdmin => ctx.Role is TenantRole.Owner or TenantRole.Admin;

    private TimeEntryDto ToDto(Row r) => new(r.Id, r.TaskId, $"{r.ProjectKey}-{r.Number}", r.Title, r.ProjectId, new UserRefDto(r.UserId, r.UserName),
        r.WorkDate, r.Minutes, r.Note, r.StartedAt is not null && r.EndedAt is null, r.StartedAt, r.UserId == ctx.UserId || IsAdmin);

    private async Task<TimeEntryDto> DtoAsync(Guid id, CancellationToken ct) => ToDto(await Rows(db.TimeEntries.Where(e => e.Id == id)).FirstAsync(ct));

    private async Task<TaskItem> VisibleTaskAsync(Guid taskId, CancellationToken ct) =>
        await access.VisibleTasks().FirstOrDefaultAsync(t => t.Id == taskId, ct) ?? throw new NotFoundException("Task not found.");

    private async Task RequireWritableAsync(TaskItem task, CancellationToken ct)
    {
        await permissions.RequireTaskEditAsync(task, ct);
        var status = await db.Projects.Where(p => p.Id == task.ProjectId).Select(p => p.Status).FirstAsync(ct);
        if (status == ProjectStatus.Archived)
            throw new ConflictException("Archived projects are read-only. Restore the project to log time.", "PROJECT_ARCHIVED");
    }

    /// <summary>Keeps the task's actual hours equal to its tracked time (only once there is tracked time).</summary>
    private async Task SyncActualHoursAsync(Guid taskId, CancellationToken ct)
    {
        var minutes = await db.TimeEntries.Where(e => e.TaskId == taskId && !(e.StartedAt != null && e.EndedAt == null)).SumAsync(e => (int?)e.Minutes, ct) ?? 0;
        var task = await db.Tasks.FirstOrDefaultAsync(t => t.Id == taskId, ct);
        if (task is null) return;
        if (minutes > 0 || await db.TimeEntries.AnyAsync(e => e.TaskId == taskId, ct)) task.ActualHours = Math.Round(minutes / 60m, 2);
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
        var userId = ctx.RequireUserId();
        var date = req.WorkDate ?? clock.Today;
        Validate(req.Minutes, date);
        await EnsureDayHasRoomAsync(userId, date, req.Minutes, null, ct);

        var entry = new TimeEntry
        {
            TenantId = task.TenantId, TaskId = taskId, ProjectId = task.ProjectId, UserId = userId, WorkDate = date,
            Minutes = req.Minutes, Note = Clean(req.Note), CreatedAt = clock.Now, CreatedBy = userId,
        };
        db.TimeEntries.Add(entry);
        recorder.Activity("task.time_logged", "Task", taskId, $"Logged {Format(req.Minutes)} on \"{task.Title}\"", task.ProjectId);
        await db.SaveChangesAsync(ct);
        await SyncActualHoursAsync(taskId, ct);
        await db.SaveChangesAsync(ct);
        return await DtoAsync(entry.Id, ct);
    }

    // ---------------------------------------------------------------- timer

    public async Task<TimeEntryDto?> GetRunningAsync(CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var id = await db.TimeEntries.Where(e => e.UserId == uid && e.StartedAt != null && e.EndedAt == null).Select(e => (Guid?)e.Id).FirstOrDefaultAsync(ct);
        return id is { } found ? await DtoAsync(found, ct) : null;
    }

    /// <summary>Starts the timer on a task. A timer that is already running (on any task) is stopped first and its time is kept.</summary>
    public async Task<TimeEntryDto> StartTimerAsync(Guid taskId, CancellationToken ct = default)
    {
        var task = await VisibleTaskAsync(taskId, ct);
        await RequireWritableAsync(task, ct);
        var userId = ctx.RequireUserId();

        var running = await db.TimeEntries.FirstOrDefaultAsync(e => e.UserId == userId && e.StartedAt != null && e.EndedAt == null, ct);
        if (running is not null)
        {
            if (running.TaskId == taskId) return await DtoAsync(running.Id, ct);
            Finish(running);
            await db.SaveChangesAsync(ct);
            await SyncActualHoursAsync(running.TaskId, ct);
        }

        var now = clock.Now;
        var entry = new TimeEntry { TenantId = task.TenantId, TaskId = taskId, ProjectId = task.ProjectId, UserId = userId, WorkDate = clock.Today, StartedAt = now, CreatedAt = now, CreatedBy = userId };
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
        var task = await db.Tasks.Where(t => t.Id == running.TaskId).Select(t => t.Title).FirstOrDefaultAsync(ct) ?? "task";
        recorder.Activity("task.time_logged", "Task", running.TaskId, $"Logged {Format(running.Minutes)} on \"{task}\"", running.ProjectId);
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
        // Editing your own logged time doesn't need a fresh task-edit check: RequireWritableAsync already gated
        // logging it in the first place, and it stays yours to fix up regardless of who the task is assigned to now.
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
        if (who != me && !inMyLine) query = query.Where(e => access.VisibleTasks().Any(t => t.Id == e.TaskId));
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
        query = query.Where(e => access.VisibleTasks().Any(t => t.Id == e.TaskId));
        return (await Rows(query).OrderBy(r => r.UserName).ThenByDescending(r => r.WorkDate).Take(MaxRows).ToListAsync(ct)).Select(ToDto).ToList();
    }

    public async Task<ProjectTimeDto> ProjectSummaryAsync(Guid projectId, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.ReportsView, ct);
        var project = await access.GetProjectAsync(projectId, ct);
        var q = db.TimeEntries.Where(e => e.ProjectId == projectId && !(e.StartedAt != null && e.EndedAt == null));

        // Group first, then look names up: keeps each query simple enough for every database provider.
        var people = await q.GroupBy(e => e.UserId).Select(g => new { Id = g.Key, Minutes = g.Sum(x => x.Minutes) }).OrderByDescending(x => x.Minutes).Take(50).ToListAsync(ct);
        var personIds = people.Select(p => p.Id).ToList();
        var userNames = await db.Users.Where(u => personIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        var tasks = await q.GroupBy(e => e.TaskId).Select(g => new { Id = g.Key, Minutes = g.Sum(x => x.Minutes) }).OrderByDescending(x => x.Minutes).Take(10).ToListAsync(ct);
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
