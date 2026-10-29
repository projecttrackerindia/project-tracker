using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Work;
using ProjectManagement.Application.Features.WorkItems;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Projects;

/// <summary>What the caller may do with one action item, so the screen only offers what will work.</summary>
public record ActionItemCan(bool Edit, bool Delete, bool Complete);

public record ActionItemDto(Guid Id, Guid ProjectId, string Title, string? Details, UserRefDto? Assignee, DateOnly? DueDate, Priority Priority, ActionItemStatus Status,
    bool IsOverdue, DateTime CreatedAt, UserRefDto? CreatedBy, DateTime? CompletedAt, UserRefDto? CompletedBy, ActionItemCan Can, string Key = "", int Number = 0,
    TimeOnly? DueTime = null, DateTime? DueAt = null);

public record CreateActionItemRequest(string? Title, string? Details, Guid? AssigneeId, DateOnly? DueDate, Priority? Priority, TimeOnly? DueTime = null);
/// <summary>All the editable fields at once: what is sent replaces what was there (an empty assignee or due date clears it).</summary>
/// <param name="Version">The version the caller saw; when given, a save over someone else's newer change is refused (409).</param>
/// <param name="DueTime">Left out keeps the current due time (cleared with the date, or with <paramref name="ClearDueTime"/>).</param>
public record UpdateActionItemRequest(string? Title, string? Details, Guid? AssigneeId, DateOnly? DueDate, Priority Priority, ActionItemStatus Status, int? Version = null,
    TimeOnly? DueTime = null, bool ClearDueTime = false);
public record SetActionItemStatusRequest(ActionItemStatus Status, int? Version = null);

/// <summary>
/// Action items of a project: follow-ups with an owner, a due date and a priority. They are work tasks of the kind
/// <see cref="WorkTaskKind.ActionItem"/> (numbered AI-n in the workspace's shared work sequence), so they appear in My work, workload
/// and search with everything else - but they follow their project's rules: anyone who can see the project can read them; people who
/// may create tasks can add them; the person who added an item, the person it is assigned to and managers can change it.
/// </summary>
public class ActionItemService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, PermissionService permissions, ProjectAccess access, NotificationService notifications,
    ProjectManagement.Application.Features.Reminders.ReminderSync reminderSync)
{
    private const int MaxListed = 500;

    private static ActionItemStatus ToApi(WorkTaskStatus s) => s switch
    {
        WorkTaskStatus.ToDo => ActionItemStatus.Open,
        WorkTaskStatus.Completed => ActionItemStatus.Completed,
        _ => ActionItemStatus.InProgress,
    };

    private static WorkTaskStatus FromApi(ActionItemStatus s) => s switch
    {
        ActionItemStatus.Open => WorkTaskStatus.ToDo,
        ActionItemStatus.Completed => WorkTaskStatus.Completed,
        _ => WorkTaskStatus.InProgress,
    };

    /// <summary>Where a notification about this action item takes the person: the project's Actions tab with the item open.</summary>
    public static string LinkOf(Guid projectId, Guid itemId) => $"/projects/{projectId}?tab=actions&action={itemId}";

    private IQueryable<WorkTask> Items(Guid projectId) => db.WorkTasks.Where(w => w.Kind == WorkTaskKind.ActionItem && w.RelatedProjectId == projectId);

    // ------------------------------------------------------------------ rules

    private async Task<Project> ViewableProjectAsync(Guid projectId, CancellationToken ct)
    {
        var project = await access.GetProjectAsync(projectId, ct);
        await permissions.RequireModuleAsync(Modules.Projects, AccessLevel.View, ct);
        return project;
    }

    private static void RequireOpen(Project project)
    {
        if (project.Status == ProjectStatus.Archived)
            throw new ConflictException("This project is archived and read-only. Restore it to work on its action items.", "PROJECT_ARCHIVED");
    }

    /// <summary>Whoever oversees the project's work: task editors (managers and up) and the project's owner.</summary>
    private async Task<bool> IsManagerAsync(Project project, CancellationToken ct) =>
        await permissions.HasAsync(Permissions.TasksEdit, ct) || (project.OwnerId == ctx.UserId && !access.IsRestricted);

    private static string CleanTitle(string? title)
    {
        var t = (title ?? "").Trim();
        if (t.Length == 0) throw new ValidationException("title", "Give the action item a short title.");
        if (t.Length > 200) throw new ValidationException("title", ProjectManagement.Application.Common.TextLimits.TooLong(200, t.Length));
        return t;
    }

    private static string? CleanDetails(string? details)
    {
        var d = details?.Replace("\r\n", "\n").Trim();
        if (string.IsNullOrEmpty(d)) return null;
        if (d.Length > 2000) throw new ValidationException("details", "The details can be at most 2000 characters.");
        return d;
    }

    private async Task<WorkTask> FindAsync(Guid projectId, Guid id, CancellationToken ct) =>
        await Items(projectId).FirstOrDefaultAsync(a => a.Id == id, ct) ?? throw new NotFoundException("Action item not found.", "ACTION_ITEM_NOT_FOUND");

    /// <summary>The assignee must be someone in the workspace who can be given work (not a guest).</summary>
    private async Task CheckAssigneeAsync(Guid projectId, Guid? assigneeId, CancellationToken ct)
    {
        if (assigneeId is not { } a) return;
        await access.EnsureTenantMemberAsync(a, "assigneeId", ct);
        await access.ShareWithAssigneeAsync(projectId, a, ct);
        var tid = ctx.RequireTenantId();
        if (await db.TenantMembers.AnyAsync(m => m.TenantId == tid && m.UserId == a && m.Role == TenantRole.Guest, ct))
            throw new ValidationException("assigneeId", "Guests cannot be given action items.");
    }

    // ------------------------------------------------------------------ read

    public async Task<IReadOnlyList<ActionItemDto>> ListAsync(Guid projectId, CancellationToken ct = default)
    {
        var project = await ViewableProjectAsync(projectId, ct);
        var all = await Items(projectId).AsNoTracking().OrderByDescending(a => a.CreatedAt).Take(MaxListed).ToListAsync(ct);
        // Open ones first, the soonest due first (undated last), then the more urgent; finished ones after them, the latest finished first.
        var rows = all.OrderBy(a => a.Status == WorkTaskStatus.Completed)
            .ThenBy(a => a.Status == WorkTaskStatus.Completed ? 0 : a.DueDate is null ? 1 : 0)
            .ThenBy(a => a.Status == WorkTaskStatus.Completed ? DateOnly.MinValue : a.DueDate ?? DateOnly.MaxValue)
            .ThenByDescending(a => (int)a.Priority)
            .ThenByDescending(a => a.Status == WorkTaskStatus.Completed ? a.CompletedAt : a.CreatedAt).ToList();
        return await ToDtosAsync(project, rows, ct);
    }

    private async Task<IReadOnlyList<ActionItemDto>> ToDtosAsync(Project project, IReadOnlyList<WorkTask> rows, CancellationToken ct)
    {
        if (rows.Count == 0) return [];
        var me = ctx.UserId;
        var manager = await IsManagerAsync(project, ct);
        var canCreate = await permissions.HasAsync(Permissions.TasksCreate, ct);
        var archived = project.Status == ProjectStatus.Archived;
        var today = clock.Today;
        var people = rows.SelectMany(r => new[] { r.AssigneeId, r.CreatedBy, r.CompletedBy }).Where(x => x != null).Select(x => x!.Value).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => people.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        UserRefDto? Ref(Guid? id) => id is { } u && names.TryGetValue(u, out var n) ? new UserRefDto(u, n) : null;

        return rows.Select(r =>
        {
            var mine = r.CreatedBy == me; var assigned = r.AssigneeId == me;
            var done = r.Status == WorkTaskStatus.Completed;
            var can = new ActionItemCan(Edit: !archived && (manager || mine || assigned), Delete: !archived && (manager || (mine && canCreate)), Complete: (!archived || !done) && (manager || mine || assigned));   // archived: open ones can still be completed (not reopened)
            return new ActionItemDto(r.Id, project.Id, r.Title, r.Description, Ref(r.AssigneeId), r.DueDate, r.Priority, ToApi(r.Status),
                !done && clock.IsPastDue(r.DueDate, r.DueTime), r.CreatedAt, Ref(r.CreatedBy), r.CompletedAt, Ref(r.CompletedBy), can,
                WorkItemService.KeyOf(WorkTaskKind.ActionItem, r.Number), r.Number, r.DueTime, clock.DueAt(r.DueDate, r.DueTime));
        }).ToList();
    }

    private async Task<ActionItemDto> OneAsync(Project project, WorkTask item, CancellationToken ct) => (await ToDtosAsync(project, [item], ct))[0];

    // ------------------------------------------------------------------ write

    private async Task NotifyAssignedAsync(Project project, WorkTask item, CancellationToken ct)
    {
        if (item.AssigneeId is not { } who) return;
        await notifications.AddAsync(who, NotificationType.TaskAssigned, $"Action item assigned to you: {item.Title}", $"{project.Name}{(item.DueDate is { } d ? $" · due {d:dd MMM yyyy}" : "")}",
            LinkOf(project.Id, item.Id), ct: ct);
    }

    public async Task<ActionItemDto> CreateAsync(Guid projectId, CreateActionItemRequest req, CancellationToken ct = default)
    {
        var project = await ViewableProjectAsync(projectId, ct);
        await permissions.RequireAsync(Permissions.TasksCreate, ct);
        RequireOpen(project);
        var title = CleanTitle(req.Title);
        var details = CleanDetails(req.Details);
        await CheckAssigneeAsync(projectId, req.AssigneeId, ct);

        var item = new WorkTask
        {
            TenantId = project.TenantId, Kind = WorkTaskKind.ActionItem, Number = await WorkTaskService.NextNumberAsync(db, project.TenantId, ct),
            RelatedProjectId = projectId, Title = title, Description = details, AssigneeId = req.AssigneeId, DueDate = req.DueDate,
            DueTime = req.DueDate is null ? null : req.DueTime,
            ReporterId = ctx.RequireUserId(), Priority = req.Priority ?? Priority.Medium, Status = WorkTaskStatus.ToDo, CreatedAt = clock.Now, CreatedBy = ctx.UserId,
        };
        db.WorkTasks.Add(item);
        recorder.Activity("actionitem.created", "ActionItem", item.Id, $"Added action item “{title}” to \"{project.Name}\"", projectId);
        await NotifyAssignedAsync(project, item, ct);
        await WorkTaskService.SaveNewAsync(db, item, ct);   // retries on a number taken at the same moment
        return await OneAsync(project, item, ct);
    }

    /// <summary>The version the caller saw: refused when stale, and pinned so a save in between fails rather than being overwritten.</summary>
    private void CheckVersion(WorkTask item, int? seen)
    {
        if (seen is not { } v) return;
        if (item.Version != v) throw new ConflictException("This action item was changed by someone else. Reload and try again.", "VERSION_CONFLICT");
        db.WorkTasks.Entry(item).Property(x => x.Version).OriginalValue = v;
    }

    public async Task<ActionItemDto> UpdateAsync(Guid projectId, Guid id, UpdateActionItemRequest req, CancellationToken ct = default)
    {
        var project = await ViewableProjectAsync(projectId, ct);
        RequireOpen(project);
        var item = await FindAsync(projectId, id, ct);
        var manager = await IsManagerAsync(project, ct);
        if (!(manager || item.CreatedBy == ctx.UserId || item.AssigneeId == ctx.UserId))
            throw new ForbiddenException("Only the person who added an action item, the person it is assigned to, or a manager can change it.", "PERMISSION_DENIED");
        CheckVersion(item, req.Version);

        var title = CleanTitle(req.Title);
        var details = CleanDetails(req.Details);
        await CheckAssigneeAsync(projectId, req.AssigneeId, ct);

        var was = ToApi(item.Status);
        var reassigned = req.AssigneeId != item.AssigneeId;
        var oldTitle = item.Title; var oldDetails = item.Description; var oldAssignee = item.AssigneeId; var oldDue = item.DueDate; var oldPriority = item.Priority; var oldDueTime = item.DueTime;
        item.Title = title; item.Description = details; item.AssigneeId = req.AssigneeId; item.Priority = req.Priority;
        item.DueTime = DueDateHistory.NextTime(req.DueDate, req.DueTime, req.ClearDueTime, item.DueTime); item.DueDate = req.DueDate;
        ApplyStatus(item, req.Status);
        item.Version++; item.UpdatedAt = clock.Now; item.UpdatedBy = ctx.UserId;
        var now = ToApi(item.Status);
        var people = await ProjectManagement.Application.Features.Platform.FieldDiff.NamesAsync(db, [oldAssignee, item.AssigneeId], ct);
        new ProjectManagement.Application.Features.Platform.FieldDiff()
            .Add("Title", oldTitle, item.Title).Add("Status", was.ToString(), now.ToString())
            .Add("Assignee", ProjectManagement.Application.Features.Platform.FieldDiff.Name(people, oldAssignee), ProjectManagement.Application.Features.Platform.FieldDiff.Name(people, item.AssigneeId))
            .Add("Priority", oldPriority.ToString(), item.Priority.ToString()).Add("Due date", oldDue, item.DueDate).Add("Due time", oldDueTime?.ToString("HH:mm"), item.DueTime?.ToString("HH:mm"))
            .Add("Description", oldDetails, item.Description, 60)
            .Record(recorder, "actionitem", "ActionItem", id);
        recorder.Activity("actionitem.updated", "ActionItem", id, was != now ? $"Action item “{title}”: {was} → {now}" : $"Updated action item “{title}”", projectId,
            was.ToString(), now.ToString());
        if (reassigned) await NotifyAssignedAsync(project, item, ct);
        await db.SaveChangesAsync(ct);
        await reminderSync.OnWorkChangedAsync(ReminderTarget.ActionItem, id, ct);
        return await OneAsync(project, item, ct);
    }

    public async Task<ActionItemDto> SetStatusAsync(Guid projectId, Guid id, SetActionItemStatusRequest req, CancellationToken ct = default)
    {
        var project = await ViewableProjectAsync(projectId, ct);
        // A closed (archived) project's follow-ups can still be ticked off - only completing is allowed there, nothing else.
        if (!(project.Status == ProjectStatus.Archived && req.Status == ActionItemStatus.Completed)) RequireOpen(project);
        var item = await FindAsync(projectId, id, ct);
        var manager = await IsManagerAsync(project, ct);
        if (!(manager || item.CreatedBy == ctx.UserId || item.AssigneeId == ctx.UserId))
            throw new ForbiddenException("Only the person who added an action item, the person it is assigned to, or a manager can change it.", "PERMISSION_DENIED");
        CheckVersion(item, req.Version);
        var was = ToApi(item.Status);
        if (was == req.Status) return await OneAsync(project, item, ct);
        ApplyStatus(item, req.Status);
        item.Version++; item.UpdatedAt = clock.Now; item.UpdatedBy = ctx.UserId;
        recorder.Activity("actionitem.status", "ActionItem", id, $"Action item “{item.Title}”: {was} → {req.Status}", projectId, was.ToString(), req.Status.ToString());
        new ProjectManagement.Application.Features.Platform.FieldDiff().Add("Status", was.ToString(), req.Status.ToString()).Record(recorder, "actionitem", "ActionItem", id);
        await db.SaveChangesAsync(ct);
        await reminderSync.OnWorkChangedAsync(ReminderTarget.ActionItem, id, ct);
        return await OneAsync(project, item, ct);
    }

    public async Task DeleteAsync(Guid projectId, Guid id, CancellationToken ct = default)
    {
        var project = await ViewableProjectAsync(projectId, ct);
        RequireOpen(project);
        var item = await FindAsync(projectId, id, ct);
        var manager = await IsManagerAsync(project, ct);
        if (!(manager || (item.CreatedBy == ctx.UserId && await permissions.HasAsync(Permissions.TasksCreate, ct))))
            throw new ForbiddenException("Only the person who added an action item, or a manager, can delete it.", "PERMISSION_DENIED");
        item.IsDeleted = true; item.DeletedAt = clock.Now; item.DeletedBy = ctx.UserId;
        recorder.Activity("actionitem.deleted", "ActionItem", id, $"Deleted action item “{item.Title}”", projectId);
        await db.SaveChangesAsync(ct);
        await reminderSync.OnWorkChangedAsync(ReminderTarget.ActionItem, id, ct);
    }

    /// <summary>Brings a deleted action item back, for the person who deleted it or a manager of an open project. Used by Undo.</summary>
    public async Task RestoreAsync(Guid projectId, Guid id, CancellationToken ct = default)
    {
        var project = await ViewableProjectAsync(projectId, ct);
        RequireOpen(project);
        var tid = ctx.RequireTenantId();
        var item = await db.WorkTasks.IgnoreQueryFilters().FirstOrDefaultAsync(w => w.Id == id && w.TenantId == tid && w.RelatedProjectId == projectId && w.Kind == WorkTaskKind.ActionItem && w.IsDeleted, ct)
            ?? throw new NotFoundException("Action item not found.", "ACTION_ITEM_NOT_FOUND");
        if (item.DeletedBy != ctx.UserId && !await IsManagerAsync(project, ct)) throw new NotFoundException("Action item not found.", "ACTION_ITEM_NOT_FOUND");
        item.IsDeleted = false; item.DeletedAt = null; item.DeletedBy = null;
        recorder.Activity("actionitem.restored", "ActionItem", id, $"Restored action item “{item.Title}”", projectId);
        await db.SaveChangesAsync(ct);
        await reminderSync.OnWorkChangedAsync(ReminderTarget.ActionItem, id, ct);
    }

    // ------------------------------------------------------------------ meetings: capture, review decisions, owner updates

    /// <summary>Who may change this item: the person who added it, the person it is assigned to, or a manager (the same rule as every edit).</summary>
    private async Task<(Project Project, WorkTask Item)> EditableAsync(Guid projectId, Guid id, CancellationToken ct, bool allowArchivedComplete = false)
    {
        var project = await ViewableProjectAsync(projectId, ct);
        if (!allowArchivedComplete || project.Status != ProjectStatus.Archived) RequireOpen(project);
        var item = await FindAsync(projectId, id, ct);
        var manager = await IsManagerAsync(project, ct);
        if (!(manager || item.CreatedBy == ctx.UserId || item.AssigneeId == ctx.UserId))
            throw new ForbiddenException("Only the person who added an action item, the person it is assigned to, or a manager can change it.", "PERMISSION_DENIED");
        return (project, item);
    }

    /// <summary>Marks a just-created item as agreed in a meeting (its source), for the "◆ From:" tag and the series' review.</summary>
    public async Task<ActionItemDto> SetSourceAsync(Guid projectId, Guid id, string meetingRef, string seriesRef, string meetingTitle, DateTime? occurrenceStartUtc, CancellationToken ct = default)
    {
        var (project, item) = await EditableAsync(projectId, id, ct);
        item.SourceMeetingRef = meetingRef; item.SourceSeriesRef = seriesRef;
        item.SourceMeetingTitle = meetingTitle.Length > 200 ? meetingTitle[..200] : meetingTitle;
        item.SourceOccurrenceStartUtc = occurrenceStartUtc;
        item.UpdatedAt = clock.Now; item.UpdatedBy = ctx.UserId;
        recorder.Activity("actionitem.from_meeting", "ActionItem", id, $"Created from {item.SourceMeetingTitle}", projectId);
        await db.SaveChangesAsync(ct);
        return await OneAsync(project, item, ct);
    }

    /// <summary>
    /// A review's owner and/or due change ("carried" to the next session, or re-planned). Moving the due later needs a reason, as any delivery
    /// date does (<see cref="DueDateHistory"/>); the new owner is told.
    /// </summary>
    public async Task<ActionItemDto> ReplanAsync(Guid projectId, Guid id, Guid? assigneeId, bool changeAssignee, DateOnly? due, bool changeDue, string? reason, string action, CancellationToken ct = default)
    {
        var (project, item) = await EditableAsync(projectId, id, ct);
        if (changeAssignee) await CheckAssigneeAsync(projectId, assigneeId, ct);
        var oldAssignee = item.AssigneeId; var oldDue = item.DueDate; var oldTime = item.DueTime;
        var newDue = changeDue ? due : item.DueDate;
        var note = changeDue ? DueDateHistory.Prepare(oldDue, newDue, reason, null) : null;
        if (changeAssignee) item.AssigneeId = assigneeId;
        if (changeDue) { item.DueDate = newDue; item.DueTime = newDue is null ? null : item.DueTime; }
        item.Version++; item.UpdatedAt = clock.Now; item.UpdatedBy = ctx.UserId;
        var people = await ProjectManagement.Application.Features.Platform.FieldDiff.NamesAsync(db, [oldAssignee, item.AssigneeId], ct);
        new ProjectManagement.Application.Features.Platform.FieldDiff()
            .Add("Assignee", ProjectManagement.Application.Features.Platform.FieldDiff.Name(people, oldAssignee), ProjectManagement.Application.Features.Platform.FieldDiff.Name(people, item.AssigneeId))
            .Add("Due date", oldDue, item.DueDate).Add("Due time", oldTime?.ToString("HH:mm"), item.DueTime?.ToString("HH:mm"))
            .Record(recorder, "actionitem", "ActionItem", id);
        var what = action == "carried" ? "Carried over" : "Re-planned";
        var bits = new List<string>();
        if (oldDue != item.DueDate) bits.Add(DueDateHistory.Describe(oldDue, item.DueDate, null));
        if (oldAssignee != item.AssigneeId) bits.Add($"owner {ProjectManagement.Application.Features.Platform.FieldDiff.Name(people, oldAssignee)} → {ProjectManagement.Application.Features.Platform.FieldDiff.Name(people, item.AssigneeId)}");
        var why = note?.Reason ?? reason?.Trim();
        recorder.Activity($"actionitem.{action}", "ActionItem", id, $"{what} “{item.Title}”{(bits.Count > 0 ? ": " + string.Join(", ", bits) : "")}{(string.IsNullOrEmpty(why) ? "" : $" ({why})")}", projectId);
        if (oldAssignee != item.AssigneeId) await NotifyAssignedAsync(project, item, ct);
        await db.SaveChangesAsync(ct);
        await reminderSync.OnWorkChangedAsync(ReminderTarget.ActionItem, id, ct);
        return await OneAsync(project, item, ct);
    }

    /// <summary>Drops an item: cancelled (not deleted, so the minutes and history still show it), with the reason kept.</summary>
    public async Task<ActionItemDto> CancelAsync(Guid projectId, Guid id, string reason, CancellationToken ct = default)
    {
        var why = (reason ?? "").Trim();
        if (why.Length == 0) throw new ValidationException("reason", "Say why it is dropped.");
        if (why.Length > 500) throw new ValidationException("reason", "The reason can be at most 500 characters.");
        var (project, item) = await EditableAsync(projectId, id, ct);
        var was = item.Status;
        item.Status = WorkTaskStatus.Cancelled; item.CompletedAt = null; item.CompletedBy = null;
        item.Version++; item.UpdatedAt = clock.Now; item.UpdatedBy = ctx.UserId;
        recorder.Activity("actionitem.dropped", "ActionItem", id, $"Dropped action item “{item.Title}”: {why}", projectId, was.ToString(), "Cancelled");
        new ProjectManagement.Application.Features.Platform.FieldDiff().Add("Status", was.ToString(), "Cancelled").Record(recorder, "actionitem", "ActionItem", id);
        await db.SaveChangesAsync(ct);
        await reminderSync.OnWorkChangedAsync(ReminderTarget.ActionItem, id, ct);
        return await OneAsync(project, item, ct);
    }

    /// <summary>Undo of a review decision: puts back the status, owner and due it had (only fields the decision changed are passed).</summary>
    public async Task<ActionItemDto> RestoreFieldsAsync(Guid projectId, Guid id, WorkTaskStatus? status, Guid? assigneeId, bool restoreAssignee, DateOnly? due, bool restoreDue, CancellationToken ct = default)
    {
        var (project, item) = await EditableAsync(projectId, id, ct, allowArchivedComplete: true);
        if (status is { } st && st != item.Status)
        {
            if (st == WorkTaskStatus.Completed) { item.CompletedAt = clock.Now; item.CompletedBy = ctx.UserId; } else { item.CompletedAt = null; item.CompletedBy = null; }
            item.Status = st;
        }
        if (restoreAssignee) item.AssigneeId = assigneeId;
        if (restoreDue) { item.DueDate = due; if (due is null) item.DueTime = null; }
        item.Version++; item.UpdatedAt = clock.Now; item.UpdatedBy = ctx.UserId;
        recorder.Activity("actionitem.review_undone", "ActionItem", id, $"Undid a review decision on “{item.Title}”", projectId);
        await db.SaveChangesAsync(ct);
        await reminderSync.OnWorkChangedAsync(ReminderTarget.ActionItem, id, ct);
        return await OneAsync(project, item, ct);
    }

    /// <summary>
    /// The owner's one-line update ("On track", "Need help", "Ask to move date" or "Done"), kept on the item for everyone's review and added to
    /// its comments. Need help and Ask to move date tell the person who added it; Done completes it.
    /// </summary>
    public async Task<ActionItemDto> OwnerUpdateAsync(Guid projectId, Guid id, string? note, string signal, CancellationToken ct = default)
    {
        var text = (note ?? "").Replace("\r\n", " ").Replace('\n', ' ').Trim();
        if (text.Length > 500) throw new ValidationException("note", "Keep the update to 500 characters.");
        var label = signal switch { "on_track" => "On track", "need_help" => "Need help", "move_date" => "Asks to move the date", "done" => "Done", "note" => null, _ => throw new ValidationException("signal", "Choose On track, Need help, Ask to move date or Done.") };
        if (text.Length == 0 && label is null) throw new ValidationException("note", "Write the update.");
        var (project, item) = await EditableAsync(projectId, id, ct, allowArchivedComplete: signal == "done");
        var me = ctx.RequireUserId();
        var line = string.Join(" · ", new[] { text.Length > 0 ? text : null, label }.Where(x => x is not null));
        item.LatestNote = line.Length > 500 ? line[..500] : line; item.LastUpdateAt = clock.Now;
        if (signal == "done" && item.Status != WorkTaskStatus.Completed) ApplyStatus(item, ActionItemStatus.Completed);
        else if (signal is "on_track" && item.Status == WorkTaskStatus.ToDo) item.Status = WorkTaskStatus.InProgress;
        else if (signal is "need_help" && item.Status is WorkTaskStatus.ToDo or WorkTaskStatus.InProgress) item.Status = WorkTaskStatus.OnHold;
        item.Version++; item.UpdatedAt = clock.Now; item.UpdatedBy = me;
        db.WorkTaskComments.Add(new WorkTaskComment { TenantId = item.TenantId, WorkTaskId = item.Id, AuthorId = me, Body = $"Update: {line}", CreatedAt = clock.Now, CreatedBy = me });
        recorder.Activity("actionitem.owner_update", "ActionItem", id, $"Update on “{item.Title}”: {line}", projectId);
        if (signal is "need_help" or "move_date" && item.CreatedBy is { } creator && creator != me)
        {
            var who = await db.Users.AsNoTracking().Where(u => u.Id == me).Select(u => u.DisplayName).FirstOrDefaultAsync(ct) ?? "Someone";
            await notifications.AddAsync(creator, NotificationType.Nudge, signal == "need_help" ? $"{who} needs help: {item.Title}" : $"{who} asks to move the date: {item.Title}", line, LinkOf(projectId, id), ct: ct);
        }
        await db.SaveChangesAsync(ct);
        await reminderSync.OnWorkChangedAsync(ReminderTarget.ActionItem, id, ct);
        return await OneAsync(project, item, ct);
    }

    /// <summary>Completing stamps who and when; reopening clears it.</summary>
    private void ApplyStatus(WorkTask item, ActionItemStatus next)
    {
        var status = FromApi(next);
        if (status == WorkTaskStatus.Completed && item.Status != WorkTaskStatus.Completed) { item.CompletedAt = clock.Now; item.CompletedBy = ctx.UserId; }
        else if (status != WorkTaskStatus.Completed) { item.CompletedAt = null; item.CompletedBy = null; }
        item.Status = status;
    }
}
