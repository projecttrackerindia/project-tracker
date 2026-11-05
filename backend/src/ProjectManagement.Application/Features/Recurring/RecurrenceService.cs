using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Recurring;

/// <summary>How a task repeats, as the task sheet's "Repeat" field shows it.</summary>
public record RecurrenceDto(bool Repeats, Guid? SeriesId, RecurrenceRuleDto? Rule, string? Summary, int? Index, DateOnly? Date,
    IReadOnlyList<DateOnly> Next, int Occurrences);

public record SetRecurrenceRequest(RecurrenceRuleDto Rule);

/// <summary>An edit of a repeating task: <c>this</c> changes only this occurrence; <c>following</c> changes it and every occurrence after it.</summary>
public record EditOccurrenceRequest(string Scope, string? Title = null, string? Description = null, Priority? Priority = null, Guid? AssigneeId = null,
    bool ClearAssignee = false, RecurrenceRuleDto? Rule = null);

/// <summary>
/// Repeating tasks: setting a rule on a task (it becomes the first occurrence), editing "this one" or "this and all following", skipping one,
/// stopping the series, and making the next occurrence (when the current one is completed, or a few days before it is due).
/// </summary>
public class RecurrenceService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, PermissionService permissions, ProjectAccess access,
    NotificationService notifications)
{
    /// <summary>The next occurrence is made this many days before it is due, even while the current one is still open.</summary>
    public const int AheadDays = 3;

    private async Task<TaskItem> TaskAsync(Guid taskId, CancellationToken ct) =>
        await access.VisibleTasks().FirstOrDefaultAsync(t => t.Id == taskId, ct) ?? throw new NotFoundException("Task not found.");

    private async Task<TaskItem> EditableAsync(Guid taskId, CancellationToken ct)
    {
        var task = await TaskAsync(taskId, ct);
        await permissions.RequireTaskEditAsync(task, ct);
        await access.EnsureWritableAsync(task.ProjectId, "change its tasks", ct);
        if (task.ParentTaskId is not null) throw new ValidationException("taskId", "Sub-tasks repeat with their parent task.");
        return task;
    }

    private async Task<(TaskOccurrence Occ, TaskRecurrence Series)?> SeriesOfAsync(Guid taskId, CancellationToken ct)
    {
        var occ = await db.TaskOccurrences.FirstOrDefaultAsync(o => o.TaskId == taskId, ct);
        if (occ is null) return null;
        var series = await db.TaskRecurrences.FirstOrDefaultAsync(r => r.Id == occ.RecurrenceId, ct);
        return series is null ? null : (occ, series);
    }

    private static DateOnly DateOf(TaskItem t, DateOnly today) => t.DueDate ?? t.StartDate ?? today;

    public async Task<RecurrenceDto> GetAsync(Guid taskId, CancellationToken ct = default)
    {
        await TaskAsync(taskId, ct);
        return await DtoAsync(taskId, ct);
    }

    private async Task<RecurrenceDto> DtoAsync(Guid taskId, CancellationToken ct)
    {
        if (await SeriesOfAsync(taskId, ct) is not { } found) return new RecurrenceDto(false, null, null, null, null, null, [], 0);
        var (occ, s) = found;
        var count = await db.TaskOccurrences.CountAsync(o => o.RecurrenceId == s.Id, ct);
        var last = await db.TaskOccurrences.Where(o => o.RecurrenceId == s.Id).OrderByDescending(o => o.Index).FirstAsync(ct);
        IReadOnlyList<DateOnly> next = s.IsActive ? RecurrenceRules.Preview(s, last.Date, last.Index) : [];
        return new RecurrenceDto(s.IsActive, s.Id, RecurrenceRules.ToDto(s), RecurrenceRules.Describe(s), occ.Index, occ.Date, next, count);
    }

    /// <summary>Makes a task repeat (it becomes the first occurrence), or changes the rule of its series from this occurrence on.</summary>
    public async Task<RecurrenceDto> SetAsync(Guid taskId, SetRecurrenceRequest req, CancellationToken ct = default)
    {
        var task = await EditableAsync(taskId, ct);
        if (req.Rule is null) throw new ValidationException("rule", "Choose how it repeats.");
        if (await SeriesOfAsync(taskId, ct) is { } found)
        {
            await ChangeRuleFromAsync(task, found.Occ, found.Series, req.Rule, ct);
            await db.SaveChangesAsync(ct);
            return await DtoAsync(taskId, ct);
        }
        var anchor = DateOf(task, clock.Today);
        task.DueDate ??= anchor;
        var series = new TaskRecurrence
        {
            TenantId = task.TenantId, ProjectId = task.ProjectId, Title = task.Title, Description = task.Description, Priority = task.Priority,
            AssigneeId = task.AssigneeId, LeadDays = task.StartDate is { } st ? Math.Max(0, anchor.DayNumber - st.DayNumber) : null,
            CreatedAt = clock.Now, CreatedBy = ctx.UserId,
        };
        RecurrenceRules.Apply(series, req.Rule, anchor);
        db.TaskRecurrences.Add(series);
        db.TaskOccurrences.Add(new TaskOccurrence { TenantId = task.TenantId, RecurrenceId = series.Id, TaskId = task.Id, Index = 1, Date = anchor, CreatedAt = clock.Now });
        recorder.Activity("task.recurrence_set", "Task", task.Id, $"\"{task.Title}\" now repeats: {RecurrenceRules.Describe(series)}", task.ProjectId);
        await db.SaveChangesAsync(ct);
        return await DtoAsync(taskId, ct);
    }

    /// <summary>
    /// A new rule from this occurrence on. The first occurrence changes the series in place; a later one ends the series before it and starts a
    /// new series from it (earlier occurrences keep the rule they were made under). Occurrences made ahead under the old rule are removed.
    /// </summary>
    private async Task<TaskRecurrence> ChangeRuleFromAsync(TaskItem task, TaskOccurrence occ, TaskRecurrence s, RecurrenceRuleDto rule, CancellationToken ct)
    {
        var later = await db.TaskOccurrences.Where(o => o.RecurrenceId == s.Id && o.Index > occ.Index).ToListAsync(ct);
        var laterIds = later.Select(o => o.TaskId).ToList();
        foreach (var t in await db.Tasks.Where(t => laterIds.Contains(t.Id) && t.CompletedAt == null).ToListAsync(ct))
        {
            t.IsDeleted = true; t.DeletedAt = clock.Now; t.DeletedBy = ctx.UserId;
            db.TaskOccurrences.Remove(later.First(o => o.TaskId == t.Id));
        }
        var target = s;
        var first = await db.TaskOccurrences.Where(o => o.RecurrenceId == s.Id).MinAsync(o => o.Index, ct);
        if (occ.Index > first)
        {
            target = new TaskRecurrence
            {
                TenantId = s.TenantId, ProjectId = s.ProjectId, Title = s.Title, Description = s.Description, Priority = s.Priority, AssigneeId = s.AssigneeId,
                LeadDays = s.LeadDays, CreatedAt = clock.Now, CreatedBy = ctx.UserId,
            };
            db.TaskRecurrences.Add(target);
            s.IsActive = false; s.UpdatedAt = clock.Now; s.UpdatedBy = ctx.UserId;
            var offset = occ.Index - 1;
            foreach (var o in await db.TaskOccurrences.Where(o => o.RecurrenceId == s.Id && o.Index >= occ.Index).OrderBy(o => o.Index).ToListAsync(ct))
            {
                if (later.Contains(o) && db.TaskOccurrences.Entry(o).State == EntityState.Deleted) continue;
                o.RecurrenceId = target.Id; o.Index -= offset;
            }
        }
        RecurrenceRules.Apply(target, rule, occ.Date);
        target.IsActive = true; target.UpdatedAt = clock.Now; target.UpdatedBy = ctx.UserId;
        recorder.Activity("task.recurrence_changed", "Task", task.Id, $"\"{task.Title}\" and following now repeat: {RecurrenceRules.Describe(target)}", task.ProjectId);
        return target;
    }

    /// <summary>Edits one occurrence, or it and every one after it (and the series, so new occurrences follow).</summary>
    public async Task<RecurrenceDto> EditAsync(Guid taskId, EditOccurrenceRequest req, CancellationToken ct = default)
    {
        var task = await EditableAsync(taskId, ct);
        var scope = (req.Scope ?? "").Trim().ToLowerInvariant();
        if (scope is not ("this" or "following")) throw new ValidationException("scope", "Choose this occurrence or this and all following.");
        if (req.Title is not null) { TextLimits.EnsureTitle(req.Title); if (string.IsNullOrWhiteSpace(req.Title)) throw new ValidationException("title", "Give it a title."); }
        if (req.AssigneeId is { } who) await access.EnsureTenantMemberAsync(who, "assigneeId", ct);
        var found = await SeriesOfAsync(taskId, ct) ?? throw new ValidationException("taskId", "This task does not repeat.");
        var (occ, series) = found;

        var targets = new List<TaskItem> { task };
        if (scope == "following")
        {
            if (req.Rule is not null) series = await ChangeRuleFromAsync(task, occ, series, req.Rule, ct);
            var laterIds = await db.TaskOccurrences.Where(o => o.RecurrenceId == occ.RecurrenceId && o.Index > occ.Index).Select(o => o.TaskId).ToListAsync(ct);
            targets.AddRange(await db.Tasks.Where(t => laterIds.Contains(t.Id) && t.CompletedAt == null && t.Id != task.Id).ToListAsync(ct));
            if (req.Title is not null) series.Title = req.Title.Trim();
            if (req.Description is not null) series.Description = req.Description.Trim();
            if (req.Priority is { } p) series.Priority = p;
            if (req.ClearAssignee) series.AssigneeId = null; else if (req.AssigneeId is { } a) series.AssigneeId = a;
            series.UpdatedAt = clock.Now; series.UpdatedBy = ctx.UserId;
        }
        foreach (var t in targets)
        {
            if (req.Title is not null) t.Title = req.Title.Trim();
            if (req.Description is not null) t.Description = req.Description.Trim();
            if (req.Priority is { } p) t.Priority = p;
            if (req.ClearAssignee) t.AssigneeId = null; else if (req.AssigneeId is { } a) t.AssigneeId = a;
            t.Version++; t.UpdatedAt = clock.Now; t.UpdatedBy = ctx.UserId;
        }
        recorder.Activity("task.occurrence_edited", "Task", task.Id, scope == "this" ? $"Changed this occurrence of \"{task.Title}\"" : $"Changed \"{task.Title}\" and all following", task.ProjectId);
        await db.SaveChangesAsync(ct);
        return await DtoAsync(taskId, ct);
    }

    /// <summary>
    /// Skips an occurrence: its date is never made again. The latest open occurrence moves on to the next date of the rule; one made ahead is removed.
    /// </summary>
    public async Task<RecurrenceDto> SkipAsync(Guid taskId, CancellationToken ct = default)
    {
        var task = await EditableAsync(taskId, ct);
        var (occ, series) = await SeriesOfAsync(taskId, ct) ?? throw new ValidationException("taskId", "This task does not repeat.");
        if (task.CompletedAt is not null) throw new ValidationException("taskId", "This one is already done.");
        var last = await db.TaskOccurrences.Where(o => o.RecurrenceId == series.Id).MaxAsync(o => o.Index, ct);
        RecurrenceRules.AddSkipped(series, occ.Date);
        if (occ.Index < last)
        {
            task.IsDeleted = true; task.DeletedAt = clock.Now; task.DeletedBy = ctx.UserId;
            db.TaskOccurrences.Remove(occ);
            recorder.Activity("task.occurrence_skipped", "Task", task.Id, $"Skipped \"{task.Title}\" on {occ.Date:d MMM}", task.ProjectId);
            await db.SaveChangesAsync(ct);
            return new RecurrenceDto(series.IsActive, series.Id, RecurrenceRules.ToDto(series), RecurrenceRules.Describe(series), null, null, [], last - 1);
        }
        var next = (series.IsActive ? RecurrenceRules.Next(series, occ.Date, occ.Index) : null)
            ?? throw new ValidationException("taskId", "This is the last one in the series. Delete it instead.");
        var shift = next.Date.DayNumber - occ.Date.DayNumber;
        var skipped = occ.Date;
        task.DueDate = (task.DueDate ?? occ.Date).AddDays(shift);
        if (task.StartDate is { } st) task.StartDate = st.AddDays(shift);
        task.Version++; task.UpdatedAt = clock.Now; task.UpdatedBy = ctx.UserId;
        occ.Date = next.Date; occ.Index = next.Index;
        recorder.Activity("task.occurrence_skipped", "Task", task.Id, $"Skipped \"{task.Title}\" on {skipped:d MMM}; next on {next.Date:d MMM}", task.ProjectId);
        await db.SaveChangesAsync(ct);
        return await DtoAsync(taskId, ct);
    }

    /// <summary>Stops the series: no more occurrences are made. The tasks already made stay.</summary>
    public async Task<RecurrenceDto> StopAsync(Guid taskId, CancellationToken ct = default)
    {
        var task = await EditableAsync(taskId, ct);
        if (await SeriesOfAsync(taskId, ct) is { } found)
        {
            found.Series.IsActive = false; found.Series.UpdatedAt = clock.Now; found.Series.UpdatedBy = ctx.UserId;
            recorder.Activity("task.recurrence_stopped", "Task", task.Id, $"\"{task.Title}\" no longer repeats", task.ProjectId);
            await db.SaveChangesAsync(ct);
        }
        return await DtoAsync(taskId, ct);
    }

    /// <summary>
    /// Makes the next occurrence of every active series of this request's workspace that needs one: the latest occurrence is done (or gone), or the
    /// next date is at most <see cref="AheadDays"/> away and the latest one is already due. Returns how many tasks were made.
    /// </summary>
    public async Task<int> AdvanceAsync(DateOnly today, CancellationToken ct = default)
    {
        var made = 0;
        var active = await db.TaskRecurrences.Where(r => r.IsActive).ToListAsync(ct);
        foreach (var s in active)
        {
            for (var guard = 0; guard < 3; guard++)   // catches up a little at a time; never floods a project
            {
                var last = await db.TaskOccurrences.Where(o => o.RecurrenceId == s.Id).OrderByDescending(o => o.Index).FirstOrDefaultAsync(ct);
                if (last is null) { s.IsActive = false; break; }
                var latest = await db.Tasks.IgnoreQueryFilters().FirstOrDefaultAsync(t => t.Id == last.TaskId && t.TenantId == s.TenantId, ct);
                var next = RecurrenceRules.Next(s, last.Date, last.Index);
                if (next is null) { s.IsActive = false; break; }
                var finished = latest is null || latest.IsDeleted || latest.CompletedAt is not null;
                var ahead = last.Date <= today && next.Value.Date.DayNumber - today.DayNumber <= AheadDays;
                if (!finished && !ahead) break;
                if (await MakeAsync(s, latest, next.Value.Date, next.Value.Index, ct)) made++;
                else break;
            }
        }
        await db.SaveChangesAsync(ct);
        return made;
    }

    private async Task<bool> MakeAsync(TaskRecurrence s, TaskItem? latest, DateOnly date, int index, CancellationToken ct)
    {
        var project = await db.Projects.FirstOrDefaultAsync(p => p.Id == s.ProjectId, ct);
        if (project is null || project.ArchivedAt is not null) { s.IsActive = false; return false; }
        var status = await db.WorkflowStatuses.Where(x => x.ProjectId == s.ProjectId).OrderBy(x => x.Order).ToListAsync(ct);
        var todo = status.FirstOrDefault(x => x.Category == StatusCategory.Todo) ?? status.FirstOrDefault();
        if (todo is null) return false;
        var assignee = s.AssigneeId is { } a && await db.TenantMembers.AnyAsync(m => m.UserId == a, ct) ? s.AssigneeId : null;
        var now = clock.Now;
        var number = (await db.Tasks.IgnoreQueryFilters().Where(t => t.ProjectId == s.ProjectId).MaxAsync(t => (int?)t.Number, ct) ?? 0) + 1;
        var position = (await db.Tasks.Where(t => t.ProjectId == s.ProjectId && t.StatusId == todo.Id).MaxAsync(t => (double?)t.Position, ct) ?? 0) + 1024;
        var task = new TaskItem
        {
            TenantId = s.TenantId, ProjectId = s.ProjectId, StageId = latest?.StageId, Number = number, Title = s.Title, Description = s.Description,
            StatusId = todo.Id, Priority = s.Priority, AssigneeId = assignee, ReporterId = latest?.ReporterId ?? s.CreatedBy ?? project.OwnerId,
            StartDate = s.LeadDays is { } lead ? date.AddDays(-lead) : null, DueDate = date, DueTime = latest?.DueTime,
            EstimatedHours = latest?.EstimatedHours, Position = position, CreatedAt = now, CreatedBy = s.CreatedBy,
        };
        db.Tasks.Add(task);
        db.TaskOccurrences.Add(new TaskOccurrence { TenantId = s.TenantId, RecurrenceId = s.Id, TaskId = task.Id, Index = index, Date = date, CreatedAt = now });
        if (latest is not null)
        {
            foreach (var l in await db.TaskLabels.Where(l => l.TaskId == latest.Id).Select(l => l.LabelId).ToListAsync(ct))
                db.TaskLabels.Add(new TaskLabel { TenantId = s.TenantId, TaskId = task.Id, LabelId = l, CreatedAt = now });
            foreach (var c in await db.ChecklistItems.Where(c => c.TaskId == latest.Id).OrderBy(c => c.Position).ToListAsync(ct))
                db.ChecklistItems.Add(new ChecklistItem { TenantId = s.TenantId, TaskId = task.Id, Title = c.Title, Position = c.Position, CreatedAt = now });
        }
        var key = $"{project.Key}-{task.Number}";
        recorder.Activity("task.created", "Task", task.Id, $"Created task {key} \"{task.Title}\" (repeats: occurrence {index})", s.ProjectId);
        if (assignee is { } who)
            await notifications.AddAsync(who, NotificationType.TaskAssigned, $"You were assigned {key}", $"{task.Title} · due {date:d MMM}", $"/projects/{s.ProjectId}?task={task.Id}", ct: ct);
        try
        {
            await db.SaveChangesAsync(ct);
            return true;
        }
        catch (DbUpdateException)
        {
            // Another run made it at the same moment (the occurrence number is unique per series), or took the task number: leave it for the next run.
            db.Tasks.Entry(task).State = EntityState.Detached;
            foreach (var occ in db.TaskOccurrences.Local.Where(x => db.TaskOccurrences.Entry(x).State == EntityState.Added).ToList()) db.TaskOccurrences.Entry(occ).State = EntityState.Detached;
            foreach (var tl in db.TaskLabels.Local.Where(x => db.TaskLabels.Entry(x).State == EntityState.Added).ToList()) db.TaskLabels.Entry(tl).State = EntityState.Detached;
            foreach (var ci in db.ChecklistItems.Local.Where(x => db.ChecklistItems.Entry(x).State == EntityState.Added).ToList()) db.ChecklistItems.Entry(ci).State = EntityState.Detached;
            foreach (var act in db.Activities.Local.Where(x => db.Activities.Entry(x).State == EntityState.Added).ToList()) db.Activities.Entry(act).State = EntityState.Detached;
            foreach (var note in db.Notifications.Local.Where(x => db.Notifications.Entry(x).State == EntityState.Added).ToList()) db.Notifications.Entry(note).State = EntityState.Detached;
            return false;
        }
    }
}

/// <summary>The background part: every active series in every workspace, each in its own workspace's scope (so every query stays inside it).</summary>
public class RecurrenceJob(IAppDbContext db, IServiceScopeFactory scopes, AppClock clock)
{
    public async Task<int> RunAsync(DateTime nowUtc, CancellationToken ct = default)
    {
        var tenants = await (from r in db.TaskRecurrences.IgnoreQueryFilters().AsNoTracking()
                             join t in db.Tenants.IgnoreQueryFilters().AsNoTracking() on r.TenantId equals t.Id
                             where r.IsActive && !t.IsDeleted && t.Status == TenantStatus.Active
                             select new { t.Id, t.Type, t.TimeZone }).Distinct().ToListAsync(ct);
        var made = 0;
        foreach (var t in tenants)
        {
            using var scope = scopes.CreateScope();
            var c = scope.ServiceProvider.GetRequiredService<CurrentContext>();
            c.TenantId = t.Id; c.Role = TenantRole.Owner; c.WorkspaceType = t.Type;   // the workspace's own background work: its whole project list
            var today = DateOnly.FromDateTime(ZoneTime.ToLocal(nowUtc, clock.ZoneFor(null, false, t.TimeZone)));
            made += await scope.ServiceProvider.GetRequiredService<RecurrenceService>().AdvanceAsync(today, ct);
        }
        return made;
    }
}
