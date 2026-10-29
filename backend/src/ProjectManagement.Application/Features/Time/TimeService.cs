using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.Reminders;
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
    int Minutes, string? Note, bool IsRunning, DateTime? StartedAt, bool CanEdit, Guid? WorkTaskId = null, string Kind = "task", bool Billable = false, bool Locked = false,
    DateTime? EndedAt = null, string? Stamp = null, IReadOnlyList<TimeOverlapDto>? Overlaps = null, string? Warning = null,
    /// <summary>Time in a project meeting (<see cref="Kind"/> "meeting"): the meeting ("p:{id}"); neither a task nor a work task.</summary>
    string? MeetingRef = null);
/// <summary>
/// Another of the same person's entries this one shares wall-clock time with. A warning, never an error: the entry is saved, both still count
/// in full on the timesheet, and the screens offer to move or trim it. <see cref="Span"/>: "09:31–11:31" in the person's zone.
/// </summary>
public record TimeOverlapDto(Guid Id, string TaskKey, string TaskTitle, DateTime StartedAt, DateTime EndedAt, string Span);
/// <summary>Everything about the time on one task (or work task), plus the caller's own running timer (on anything).</summary>
/// <summary><see cref="BillableByDefault"/>: whether time logged here starts out billable (the project is billable).</summary>
public record TaskTimeDto(IReadOnlyList<TimeEntryDto> Entries, int TotalMinutes, decimal? EstimatedHours, TimeEntryDto? MyTimer, bool BillableByDefault = false);
/// <summary><see cref="Billable"/> empty = the project's setting (time on work without a project is not billable).</summary>
/// <para><see cref="StartedAt"/>/<see cref="EndedAt"/> (both or neither): the entry has a real time of day (the calendar's drag-to-log); its minutes
/// and day then come from them.</para>
public record LogTimeRequest(int Minutes, DateOnly? WorkDate, string? Note, bool? Billable = null, DateTime? StartedAt = null, DateTime? EndedAt = null);
/// <summary><see cref="Billable"/> empty = leave it as it is.</summary>
/// <para><see cref="StartedAt"/>/<see cref="EndedAt"/> (both or neither): place the entry at that time (drag to move, drag an edge to resize); the minutes
/// and day then follow them. Without them a placed entry keeps its start and its end follows the minutes.</para>
/// <para><see cref="TaskId"/> or <see cref="WorkTaskId"/>: move the time to another task or work item (you must be able to log time there).</para>
/// <para><see cref="Stamp"/>: the entry's stamp as you last saw it; when it changed since (edited in another tab, the timesheet grid, the phone) the
/// change is refused with 409 TIME_ENTRY_CHANGED instead of overwriting it.</para>
public record UpdateTimeRequest(int Minutes, DateOnly WorkDate, string? Note, bool? Billable = null, DateTime? StartedAt = null, DateTime? EndedAt = null,
    Guid? TaskId = null, Guid? WorkTaskId = null, string? Stamp = null);

public record TimeByDayDto(DateOnly Date, int Minutes);
public record TimesheetDto(DateOnly From, DateOnly To, UserRefDto User, IReadOnlyList<TimeEntryDto> Entries, int TotalMinutes, IReadOnlyList<TimeByDayDto> ByDay, int BillableMinutes = 0);
public record TimeByPersonDto(Guid UserId, string Name, int Minutes);
public record TimeByTaskDto(Guid TaskId, string Key, string Title, int Minutes, decimal? EstimatedHours);
public record ProjectTimeDto(int TotalMinutes, decimal? EstimatedHours, IReadOnlyList<TimeByPersonDto> ByPerson, IReadOnlyList<TimeByTaskDto> TopTasks);

/// <summary>
/// Time tracking: hand-entered time and a start/stop timer, on project tasks and on work tasks alike, so a timesheet shows the whole
/// week and not only project delivery. A project task's "actual hours" is kept equal to the sum of its entries, so there is one honest
/// number instead of a typed guess next to a tracked one.
/// </summary>
public class TimeService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, PermissionService permissions, ProjectAccess access,
    ProjectManagement.Application.Features.Organization.ReportingLineService reporting, WorkTaskService workTasks, TimesheetApprovalService approvals)
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
        public string? MeetingRef { get; init; }
        public string? MeetingTitle { get; init; }
        public Guid? ProjectId { get; init; }
        public Guid UserId { get; init; }
        public string UserName { get; init; } = "";
        public DateOnly WorkDate { get; init; }
        public int Minutes { get; init; }
        public string? Note { get; init; }
        public DateTime? StartedAt { get; init; }
        public DateTime? EndedAt { get; init; }
        public bool Billable { get; init; }
        public DateTime CreatedAt { get; init; }
        public DateTime? UpdatedAt { get; init; }
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
            Billable = e.Billable, CreatedAt = e.CreatedAt, UpdatedAt = e.UpdatedAt, MeetingRef = e.MeetingRef, MeetingTitle = e.MeetingTitle,
        };

    private bool IsAdmin => ctx.Role is TenantRole.Owner or TenantRole.Admin;

    private static string KeyOf(Row r) => r.WorkTaskId is not null ? WorkItemService.KeyOf(r.WorkKind, r.WorkNumber) : r.TaskId is null && r.MeetingRef is not null ? (r.ProjectKey is { } k ? $"{k} meeting" : "Meeting") : $"{r.ProjectKey}-{r.TaskNumber}";
    private static string TitleOf(Row r) => (r.WorkTaskId is not null ? r.WorkTitle : r.TaskId is null && r.MeetingRef is not null ? r.MeetingTitle : r.TaskTitle) ?? "(deleted)";

    private TimeEntryDto ToDto(Row r, HashSet<(Guid User, DateOnly Week)> locked)
    {
        var onWork = r.WorkTaskId is not null;
        var key = KeyOf(r);
        var title = TitleOf(r);
        var isLocked = locked.Contains((r.UserId, TimesheetApprovalService.WeekOf(r.WorkDate)));
        return new TimeEntryDto(r.Id, r.TaskId, key, title, r.ProjectId, new UserRefDto(r.UserId, r.UserName), r.WorkDate, r.Minutes, r.Note,
            r.StartedAt is not null && r.EndedAt is null, r.StartedAt, (r.UserId == ctx.UserId || IsAdmin) && !isLocked, r.WorkTaskId,
            onWork ? "work" : r.TaskId is null && r.MeetingRef is not null ? "meeting" : "task", r.Billable, isLocked,
            r.EndedAt, StampOf(r.UpdatedAt, r.CreatedAt), MeetingRef: r.TaskId is null && r.WorkTaskId is null ? r.MeetingRef : null);
    }

    /// <summary>The entry's concurrency stamp: when it last changed, to the microsecond (what the database keeps).</summary>
    public static string StampOf(DateTime? updatedAt, DateTime createdAt) => ((updatedAt ?? createdAt).Ticks / 10).ToString(System.Globalization.CultureInfo.InvariantCulture);

    /// <summary>A start and end given together: both in UTC, the end after the start, at most 24 hours, and not in the future.</summary>
    private (DateTime Start, DateTime End, int Minutes, DateOnly Day)? Placed(DateTime? startedAt, DateTime? endedAt)
    {
        if (startedAt is null && endedAt is null) return null;
        if (startedAt is not { } s || endedAt is not { } e) throw new ValidationException("startedAt", "Give both a start and an end time, or neither.");
        var start = DateTime.SpecifyKind(s.Kind == DateTimeKind.Local ? s.ToUniversalTime() : s, DateTimeKind.Utc);
        var end = DateTime.SpecifyKind(e.Kind == DateTimeKind.Local ? e.ToUniversalTime() : e, DateTimeKind.Utc);
        if (end <= start) throw new ValidationException("endedAt", "The end must be after the start.");
        var minutes = (int)Math.Round((end - start).TotalMinutes);
        if (minutes < 1 || minutes > MaxMinutesPerEntry) throw new ValidationException("endedAt", "Enter between 1 minute and 24 hours.");
        if (end > clock.Now.AddMinutes(1)) throw new ValidationException("endedAt", "You cannot log time that has not happened yet.");
        var day = clock.LocalDate(start);
        if (clock.LocalDate(end.AddTicks(-1)) != day) throw new ValidationException("endedAt", "An entry stays within one day. Split it at midnight.");
        return (start, end, minutes, day);
    }

    /// <summary>
    /// A duration logged for today, placed on the clock: ending now (to the minute) and starting <paramref name="minutes"/> before. Null for
    /// another day, or when that start would fall before midnight (then the entry keeps no time of day, and the timeline places it).
    /// </summary>
    private (DateTime Start, DateTime End, int Minutes, DateOnly Day)? EndingNow(int minutes, DateOnly date)
    {
        if (date != clock.Today) return null;
        var now = clock.Now;
        var end = new DateTime(now.Ticks - now.Ticks % TimeSpan.TicksPerMinute, DateTimeKind.Utc);
        var start = end.AddMinutes(-minutes);
        return clock.LocalDate(start) == date ? (start, end, minutes, date) : null;
    }

    /// <summary>Rows to entries, marking those in a submitted or approved week (they cannot be changed).</summary>
    private async Task<List<TimeEntryDto>> ToDtosAsync(IReadOnlyList<Row> rows, CancellationToken ct)
    {
        var locked = await approvals.LockedWeeksAsync(rows.Select(r => (r.UserId, r.WorkDate)), ct);
        return rows.Select(r => ToDto(r, locked)).ToList();
    }

    private async Task<TimeEntryDto> DtoAsync(Guid id, CancellationToken ct) => (await ToDtosAsync([await Rows(db.TimeEntries.Where(e => e.Id == id)).OrderBy(r => r.Id).FirstAsync(ct)], ct))[0];

    // ---------------------------------------------------------------- overlaps (a warning, never an error)

    private string Clock24(DateTime utc) => ZoneTime.ToLocal(DateTime.SpecifyKind(utc, DateTimeKind.Utc), clock.Zone).ToString("HH:mm", System.Globalization.CultureInfo.InvariantCulture);
    private TimeOverlapDto OverlapOf(Row r) => new(r.Id, KeyOf(r), TitleOf(r), r.StartedAt!.Value, r.EndedAt!.Value, $"{Clock24(r.StartedAt!.Value)}–{Clock24(r.EndedAt!.Value)}");
    private static string WarningOf(IReadOnlyList<TimeOverlapDto> o) =>
        $"Overlaps {o[0].TaskKey} {o[0].Span}" + (o.Count > 1 ? $" and {o.Count - 1} more" : "");

    /// <summary>The entry with the person's other entries on the clock it shares time with (only entries with a real start and end count).</summary>
    private async Task<TimeEntryDto> WithOverlapsAsync(TimeEntryDto dto, CancellationToken ct)
    {
        if (dto.IsRunning || dto.StartedAt is not { } s || dto.EndedAt is not { } e) return dto;
        var others = await Rows(db.TimeEntries.Where(x => x.UserId == dto.User.Id && x.Id != dto.Id && x.WorkDate == dto.WorkDate
                && x.StartedAt != null && x.EndedAt != null && x.StartedAt < e && x.EndedAt > s))
            .OrderBy(r => r.StartedAt).Take(20).ToListAsync(ct);
        if (others.Count == 0) return dto;
        var list = others.Select(OverlapOf).ToList();
        return dto with { Overlaps = list, Warning = WarningOf(list) };
    }

    /// <summary>The same, for a list already read (a timesheet): each entry against the others of its person and day.</summary>
    private List<TimeEntryDto> WithOverlaps(List<TimeEntryDto> entries, IReadOnlyList<Row> rows)
    {
        var byId = rows.ToDictionary(r => r.Id);
        var placed = entries.Where(x => !x.IsRunning && x.StartedAt is not null && x.EndedAt is not null).ToList();
        return entries.Select(x =>
        {
            if (x.IsRunning || x.StartedAt is not { } s || x.EndedAt is not { } e) return x;
            var list = placed.Where(o => o.Id != x.Id && o.User.Id == x.User.Id && o.WorkDate == x.WorkDate && o.StartedAt < e && o.EndedAt > s)
                .OrderBy(o => o.StartedAt).Select(o => OverlapOf(byId[o.Id])).ToList();
            return list.Count == 0 ? x : x with { Overlaps = list, Warning = WarningOf(list) };
        }).ToList();
    }

    /// <summary>
    /// A duration logged for today ends now (<see cref="EndingNow"/>); when that would overlap the person's other time, it goes into the latest free gap after the day's work start (check-in, else working-hours start)
    /// before now that fits it whole (ending as late as possible). With no such gap it stays ending now and the response warns about the overlap.
    /// </summary>
    private async Task<(DateTime Start, DateTime End, int Minutes, DateOnly Day)?> FitBeforeNowAsync(Guid userId, (DateTime Start, DateTime End, int Minutes, DateOnly Day) want, CancellationToken ct)
    {
        var busy = await db.TimeEntries.Where(x => x.UserId == userId && x.WorkDate == want.Day && x.StartedAt != null)
            .Select(x => new { S = x.StartedAt!.Value, E = x.EndedAt }).ToListAsync(ct);
        var spans = busy.Select(b => (S: b.S, E: b.E ?? clock.Now)).Where(b => b.E > b.S).OrderBy(b => b.S).ToList();
        if (!spans.Any(b => b.S < want.End && b.E > want.Start)) return want;
        // Only from the person's work start that day: their first check-in, else the workspace's working-hours start (09:30 by default).
        var checkIn = await db.AttendanceDays.Where(x => x.UserId == userId && x.Date == want.Day).OrderBy(x => x.CheckInAt).Select(x => (DateTime?)x.CheckInAt).FirstOrDefaultAsync(ct);
        var workStart = await db.AttendancePolicies.Select(x => (TimeOnly?)x.WorkStart).FirstOrDefaultAsync(ct) ?? new TimeOnly(9, 30);
        var floor = checkIn is { } ci ? DateTime.SpecifyKind(ci, DateTimeKind.Utc) : clock.StartOfDayUtc(want.Day).Add(workStart.ToTimeSpan());
        if (floor >= want.End) return want;
        spans = spans.Select(b => (S: b.S < floor ? floor : b.S, b.E)).Where(b => b.E > b.S).ToList();
        // Free gaps from the start of the day to now, latest first.
        var gaps = new List<(DateTime A, DateTime B)>();
        var cur = floor;
        foreach (var b in spans)
        {
            if (b.S > cur) gaps.Add((cur, b.S < want.End ? b.S : want.End));
            if (b.E > cur) cur = b.E;
            if (cur >= want.End) break;
        }
        if (cur < want.End) gaps.Add((cur, want.End));
        var length = TimeSpan.FromMinutes(want.Minutes);
        foreach (var (a, b) in gaps.Where(g => g.B > g.A).OrderByDescending(g => g.B))
            if (b - a >= length) return (b - length, b, want.Minutes, want.Day);
        return want;
    }

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
        var entries = await ToDtosAsync(rows, ct);
        return new TaskTimeDto(entries, entries.Where(e => !e.IsRunning).Sum(e => e.Minutes), task.EstimatedHours, await GetRunningAsync(ct), await BillableByDefaultAsync(task.ProjectId, ct));
    }

    public async Task<TimeEntryDto> LogAsync(Guid taskId, LogTimeRequest req, CancellationToken ct = default)
    {
        var task = await VisibleTaskAsync(taskId, ct);
        await RequireWritableAsync(task, ct);
        var entry = await AddEntryAsync(task.TenantId, taskId, null, task.ProjectId, req, ct);
        recorder.Activity("task.time_logged", "Task", taskId, $"Logged {Format(entry.Minutes)} on \"{task.Title}\"", task.ProjectId);
        await db.SaveChangesAsync(ct);
        await SyncActualHoursAsync(taskId, ct);
        await db.SaveChangesAsync(ct);
        return await WithOverlapsAsync(await DtoAsync(entry.Id, ct), ct);
    }

    // ---------------------------------------------------------------- per work task

    public async Task<TaskTimeDto> GetForWorkTaskAsync(Guid workTaskId, CancellationToken ct = default)
    {
        var work = await workTasks.RequireVisibleAsync(workTaskId, ct);
        var rows = await Rows(db.TimeEntries.Where(e => e.WorkTaskId == workTaskId)).OrderByDescending(r => r.WorkDate).ThenByDescending(r => r.Id).Take(MaxRows).ToListAsync(ct);
        var entries = await ToDtosAsync(rows, ct);
        return new TaskTimeDto(entries, entries.Where(e => !e.IsRunning).Sum(e => e.Minutes), null, await GetRunningAsync(ct), await BillableByDefaultAsync(work.RelatedProjectId, ct));
    }

    public async Task<TimeEntryDto> LogOnWorkTaskAsync(Guid workTaskId, LogTimeRequest req, CancellationToken ct = default)
    {
        var work = await workTasks.RequireTimeLoggableAsync(workTaskId, ct);
        var entry = await AddEntryAsync(work.TenantId, null, workTaskId, work.RelatedProjectId, req, ct);
        recorder.Activity("worktask.time_logged", "WorkTask", workTaskId, $"Logged {Format(entry.Minutes)} on {WorkTaskService.KeyOf(work.Number)} “{work.Title}”", null);
        await db.SaveChangesAsync(ct);
        return await WithOverlapsAsync(await DtoAsync(entry.Id, ct), ct);
    }

    /// <summary>
    /// Time spent in a session of a project meeting, from the post-meeting prompt (the person tapped Log): placed on the clock where the
    /// session was, so the timesheet's overlap rules apply as for any placed entry. The caller has checked the person may see the project.
    /// </summary>
    public async Task<TimeEntryDto> LogOnMeetingAsync(Guid projectId, string meetingRef, string meetingTitle, LogTimeRequest req, CancellationToken ct = default)
    {
        var project = await access.GetProjectAsync(projectId, ct);
        if (project.Status == ProjectStatus.Archived)
            throw new ConflictException("Archived projects are read-only. Restore the project to log time.", "PROJECT_ARCHIVED");
        var entry = await AddEntryAsync(project.TenantId, null, null, projectId, req, ct);
        entry.MeetingRef = meetingRef;
        entry.MeetingTitle = meetingTitle.Length > 200 ? meetingTitle[..200] : meetingTitle;
        recorder.Activity("meeting.time_logged", "ProjectMeeting", Guid.TryParse(meetingRef.Length > 2 ? meetingRef[2..] : "", out var mid) ? mid : projectId,
            $"Logged {Format(entry.Minutes)} in “{entry.MeetingTitle}”", projectId);
        await db.SaveChangesAsync(ct);
        return await WithOverlapsAsync(await DtoAsync(entry.Id, ct), ct);
    }

    private async Task<TimeEntry> AddEntryAsync(Guid tenantId, Guid? taskId, Guid? workTaskId, Guid? projectId, LogTimeRequest req, CancellationToken ct)
    {
        var userId = ctx.RequireUserId();
        var placed = Placed(req.StartedAt, req.EndedAt);
        var date = placed?.Day ?? req.WorkDate ?? clock.Today;
        var minutes = placed?.Minutes ?? req.Minutes;
        Validate(minutes, date);
        // Logged as a duration for today ("log 2h"): the time ends now and started that long ago - never 9:31 to 11:31 at 10:29.
        if (placed is null && EndingNow(minutes, date) is { } endingNow) placed = await FitBeforeNowAsync(userId, endingNow, ct);
        await approvals.EnsureOpenAsync(userId, date, ct);
        await EnsureDayHasRoomAsync(userId, date, minutes, null, ct);
        var entry = new TimeEntry
        {
            TenantId = tenantId, TaskId = taskId, WorkTaskId = workTaskId, ProjectId = projectId, UserId = userId, WorkDate = date,
            Minutes = minutes, Note = Clean(req.Note), CreatedAt = clock.Now, CreatedBy = userId,
            Billable = req.Billable ?? await BillableByDefaultAsync(projectId, ct),
            StartedAt = placed?.Start, EndedAt = placed?.End,
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
        if (running is not null && running.TaskId == taskId && running.WorkTaskId == workTaskId) return await DtoAsync(running.Id, ct);
        await approvals.EnsureOpenAsync(userId, clock.Today, ct);
        if (running is not null)
        {
            Finish(running);
            await db.SaveChangesAsync(ct);
            await SyncActualHoursAsync(running.TaskId, ct);
        }

        var now = clock.Now;
        var entry = new TimeEntry
        {
            TenantId = tenantId, TaskId = taskId, WorkTaskId = workTaskId, ProjectId = projectId, UserId = userId, WorkDate = clock.Today, StartedAt = now, CreatedAt = now, CreatedBy = userId,
            Billable = await BillableByDefaultAsync(projectId, ct),
        };
        db.TimeEntries.Add(entry);
        // One running timer per person (a unique index): a timer started at the same moment elsewhere (another tab, the phone) wins.
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateException ex) when (DbErrors.IsTimerRunning(ex))
        {
            db.TimeEntries.Entry(entry).State = EntityState.Detached;
            throw new ConflictException("A timer was just started somewhere else. Stop it before starting another.", "TIMER_RUNNING");
        }
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
        return await WithOverlapsAsync(await DtoAsync(running.Id, ct), ct);
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
        if (req.Stamp is { Length: > 0 } seen && seen != StampOf(entry.UpdatedAt, entry.CreatedAt))
            throw new ConflictException("This entry was changed somewhere else (another tab, the timesheet or your phone). Reload it and try again.", "TIME_ENTRY_CHANGED");
        var placed = Placed(req.StartedAt, req.EndedAt);
        var date = placed?.Day ?? req.WorkDate;
        var minutes = placed?.Minutes ?? req.Minutes;
        Validate(minutes, date);
        await approvals.EnsureOpenAsync(entry.UserId, entry.WorkDate, ct);
        if (date != entry.WorkDate) await approvals.EnsureOpenAsync(entry.UserId, date, ct);
        await EnsureDayHasRoomAsync(entry.UserId, date, minutes, entry.Id, ct);

        // Moved to other work: the caller must be able to log time there (the same gate as logging it in the first place).
        var oldTask = entry.TaskId;
        if (req.TaskId is { } newTask && newTask != entry.TaskId)
        {
            var task = await VisibleTaskAsync(newTask, ct);
            await RequireWritableAsync(task, ct);
            entry.TaskId = newTask; entry.WorkTaskId = null; entry.ProjectId = task.ProjectId;
        }
        else if (req.WorkTaskId is { } newWork && newWork != entry.WorkTaskId)
        {
            var work = await workTasks.RequireTimeLoggableAsync(newWork, ct);
            entry.TaskId = null; entry.WorkTaskId = newWork; entry.ProjectId = work.RelatedProjectId;
        }

        var oldDate = entry.WorkDate;
        entry.Minutes = minutes; entry.WorkDate = date; entry.Note = Clean(req.Note);
        if (placed is { } p) { entry.StartedAt = p.Start; entry.EndedAt = p.End; }
        else if (entry.StartedAt is { } s0 && entry.EndedAt is not null)
        {
            // A placed entry edited as minutes (or moved to another day in the grid): keep its time of day, the end follows the minutes -
            // but never past now: an entry that would end in the future ends now and starts earlier instead.
            var start = date == oldDate ? s0 : clock.StartOfDayUtc(date).Add(s0 - clock.StartOfDayUtc(clock.LocalDate(s0)));
            if (start.AddMinutes(minutes) > clock.Now && EndingNow(minutes, date) is { } now) start = now.Start;
            entry.StartedAt = start; entry.EndedAt = start.AddMinutes(minutes);
        }
        if (req.Billable is { } billable) entry.Billable = billable;
        entry.UpdatedAt = clock.Now; entry.UpdatedBy = ctx.UserId;
        await db.SaveChangesAsync(ct);
        await SyncActualHoursAsync(entry.TaskId, ct);
        if (oldTask is { } was && was != entry.TaskId)
        {
            await SyncActualHoursAsync(was, ct);
            // Its last tracked time moved away: its actual hours were that time, so they go back to nothing.
            if (!await db.TimeEntries.AnyAsync(e => e.TaskId == was, ct) && await db.Tasks.FirstOrDefaultAsync(t => t.Id == was, ct) is { } left) left.ActualHours = 0;
        }
        await db.SaveChangesAsync(ct);
        return await WithOverlapsAsync(await DtoAsync(id, ct), ct);
    }

    public async Task DeleteAsync(Guid id, CancellationToken ct = default)
    {
        var entry = await OwnedAsync(id, ct);
        await approvals.EnsureOpenAsync(entry.UserId, entry.WorkDate, ct);
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
                            || (e.TaskId == null && e.WorkTaskId == null && e.MeetingRef != null && seesProjects && e.ProjectId != null && visibleProjects.Contains(e.ProjectId.Value))
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
        var rows = await Rows(query).OrderByDescending(r => r.WorkDate).ThenByDescending(r => r.Id).Take(MaxRows).ToListAsync(ct);
        var entries = WithOverlaps(await ToDtosAsync(rows, ct), rows);
        var name = await db.Users.Where(u => u.Id == who).Select(u => u.DisplayName).FirstOrDefaultAsync(ct) ?? "Unknown";

        var days = new List<TimeByDayDto>();
        for (var d = start; d <= end; d = d.AddDays(1)) days.Add(new TimeByDayDto(d, entries.Where(e => e.WorkDate == d && !e.IsRunning).Sum(e => e.Minutes)));
        return new TimesheetDto(start, end, new UserRefDto(who, name), entries, entries.Where(e => !e.IsRunning).Sum(e => e.Minutes), days,
            entries.Where(e => !e.IsRunning && e.Billable).Sum(e => e.Minutes));
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
        return await ToDtosAsync(await Rows(query).OrderBy(r => r.UserName).ThenByDescending(r => r.WorkDate).Take(MaxRows).ToListAsync(ct), ct);
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

    /// <summary>Time on a billable project starts out billable; everything else does not.</summary>
    private async Task<bool> BillableByDefaultAsync(Guid? projectId, CancellationToken ct) =>
        projectId is { } pid && await db.Projects.Where(p => p.Id == pid).Select(p => p.IsBillable).FirstOrDefaultAsync(ct);

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
