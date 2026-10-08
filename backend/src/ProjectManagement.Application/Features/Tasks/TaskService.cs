using System.Linq.Expressions;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Automation;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Planning;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Tasks;

public record TaskDto(Guid Id, Guid ProjectId, string ProjectKey, string ProjectName, int Number, string Key, string Title, string? Description,
    Guid StatusId, string StatusName, StatusCategory StatusCategory, string StatusColor, Priority Priority,
    UserRefDto? Assignee, UserRefDto? Reporter, DateOnly? StartDate, DateOnly? DueDate, decimal? EstimatedHours, decimal? ActualHours,
    double Position, Guid? ParentTaskId, int SubtaskTotal, int SubtaskDone, int CommentCount, IReadOnlyList<LabelDto> Labels,
    DateTime? CompletedAt, DateTime CreatedAt, DateTime? UpdatedAt, int Version, bool IsOverdue,
    Guid? MilestoneId, string? MilestoneName, int DependsOnCount, int BlocksCount, bool IsBlocked, Guid? SprintId = null, string? SprintName = null,
    int ChecklistTotal = 0, int ChecklistDone = 0, bool CanEdit = true, Guid? StageId = null, string? StageName = null);
public record TaskDetailDto(TaskDto Task, IReadOnlyList<TaskDto> Subtasks);

public record TaskQuery(Guid? ProjectId, bool Mine = false, Guid? AssigneeId = null, Guid? StatusId = null, StatusCategory? Category = null,
    Priority? Priority = null, Guid? LabelId = null, string? Q = null, bool OpenOnly = false, DateOnly? DueFrom = null, DateOnly? DueTo = null,
    bool Overdue = false, bool IncludeSubtasks = false, string? Sort = null, int Page = 1, int PageSize = 50,
    Guid? SprintId = null, bool Backlog = false, Guid? StageId = null);
public record CreateTaskRequest(string Title, string? Description, Guid? StatusId, Priority Priority, Guid? AssigneeId, DateOnly? StartDate,
    DateOnly? DueDate, decimal? EstimatedHours, IReadOnlyList<Guid>? LabelIds, Guid? ParentTaskId, Guid? MilestoneId = null, Guid? StageId = null);
public record UpdateTaskRequest(string Title, string? Description, Guid StatusId, Priority Priority, Guid? AssigneeId, DateOnly? StartDate,
    DateOnly? DueDate, decimal? EstimatedHours, decimal? ActualHours, IReadOnlyList<Guid>? LabelIds, int Version, Guid? MilestoneId = null, Guid? StageId = null,
    string? DueDateReason = null, string? DueDateDependency = null);
public record MoveTaskRequest(Guid StatusId, double? Position);

public record CommentDto(Guid Id, Guid TaskId, UserRefDto Author, string Body, Guid? ParentCommentId, DateTime CreatedAt, DateTime? EditedAt, bool CanEdit, bool CanDelete);
public record CreateCommentRequest(string Body, Guid? ParentCommentId, IReadOnlyList<Guid>? MentionUserIds);
public record UpdateCommentRequest(string Body);

public class TaskService(
    IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, PermissionService permissions,
    EntitlementService entitlements, ProjectAccess access, NotificationService notifications, PlanningService planning, AutomationEngine automation, TaskCompletionService completion,
    DueDateHistory dueHistory)
{
    private const double PositionStep = 1024;

    // ---------------------------------------------------------------- projection

    private async Task<List<TaskDto>> ProjectAsync(IQueryable<TaskItem> query, CancellationToken ct)
    {
        var today = clock.Today;
        var canEditAny = await permissions.HasAsync(Permissions.TasksEdit, ct);
        var uid = ctx.UserId;
        var rows = await query.AsNoTracking().Select(t => new
        {
            Task = t,
            ProjectKey = t.Project!.Key,
            ProjectName = t.Project.Name,
            StatusName = t.Status!.Name,
            Category = t.Status.Category,
            StatusColor = t.Status.Color,
            AssigneeName = t.Assignee!.DisplayName,
            ReporterName = t.Reporter!.DisplayName,
            SubtaskTotal = t.Subtasks.Count(s => !s.IsDeleted),
            SubtaskDone = t.Subtasks.Count(s => !s.IsDeleted && s.Status!.Category == StatusCategory.Done),
            CommentCount = t.Comments.Count(c => !c.IsDeleted),
            Labels = t.Labels.Select(l => new LabelDto(l.Label!.Id, l.Label.Name, l.Label.Color)).ToList(),
            MilestoneName = db.Milestones.Where(m => m.Id == t.MilestoneId).Select(m => m.Name).FirstOrDefault(),
            SprintName = db.Sprints.Where(x => x.Id == t.SprintId).Select(x => x.Name).FirstOrDefault(),
            StageName = db.ProjectStages.Where(x => x.Id == t.StageId).Select(x => x.Name).FirstOrDefault(),
            ChecklistTotal = db.ChecklistItems.Count(c => c.TaskId == t.Id),
            ChecklistDone = db.ChecklistItems.Count(c => c.TaskId == t.Id && c.IsDone),
            DependsOn = db.TaskDependencies.Count(d => d.TaskId == t.Id),
            Blocks = db.TaskDependencies.Count(d => d.DependsOnTaskId == t.Id),
            // Waiting on something that has not reached the point this link requires.
            Unmet = db.TaskDependencies.Count(d => d.TaskId == t.Id
                && (d.Type == DependencyType.FinishToStart
                        ? d.DependsOnTask!.Status!.Category != StatusCategory.Done && d.DependsOnTask.Status.Category != StatusCategory.Cancelled
                    : d.Type == DependencyType.StartToStart && d.DependsOnTask!.Status!.Category == StatusCategory.Todo)),
        }).ToListAsync(ct);

        return rows.Select(r =>
        {
            var t = r.Task;
            var open = r.Category is not (StatusCategory.Done or StatusCategory.Cancelled);
            return new TaskDto(t.Id, t.ProjectId, r.ProjectKey, r.ProjectName, t.Number, $"{r.ProjectKey}-{t.Number}", t.Title, t.Description,
                t.StatusId, r.StatusName, r.Category, r.StatusColor, t.Priority,
                r.AssigneeName is null ? null : new UserRefDto(t.AssigneeId!.Value, r.AssigneeName),
                new UserRefDto(t.ReporterId, r.ReporterName ?? "Unknown"), t.StartDate, t.DueDate, t.EstimatedHours, t.ActualHours,
                t.Position, t.ParentTaskId, r.SubtaskTotal, r.SubtaskDone, r.CommentCount, r.Labels, t.CompletedAt, t.CreatedAt, t.UpdatedAt,
                t.Version, open && t.DueDate is { } due && due < today,
                t.MilestoneId, r.MilestoneName, r.DependsOn, r.Blocks, open && r.Unmet > 0, t.SprintId, r.SprintName, r.ChecklistTotal, r.ChecklistDone,
                canEditAny || t.AssigneeId == uid, t.StageId, r.StageName);
        }).ToList();
    }

    private async Task<TaskDto> GetDtoAsync(Guid id, CancellationToken ct) =>
        (await ProjectAsync(access.VisibleTasks().Where(t => t.Id == id), ct)).FirstOrDefault()
        ?? throw new NotFoundException("Task not found.");

    private static Expression<Func<TaskItem, int>> PriorityRank => t =>
        t.Priority == Priority.Critical ? 0 : t.Priority == Priority.High ? 1 : t.Priority == Priority.Medium ? 2 : 3;

    // ---------------------------------------------------------------- queries

    public async Task<PagedResult<TaskDto>> ListAsync(TaskQuery query, CancellationToken ct = default)
    {
        ctx.RequireTenantId();
        var today = clock.Today;
        var q = access.VisibleTasks();

        if (query.ProjectId is { } pid)
        {
            await access.GetProjectAsync(pid, ct); // 404 (not an empty list) when the project is not visible to the caller
            q = q.Where(t => t.ProjectId == pid);
        }
        if (!query.IncludeSubtasks) q = q.Where(t => t.ParentTaskId == null);
        if (query.Mine) { var me = ctx.UserId; q = q.Where(t => t.AssigneeId == me); }
        else if (query.AssigneeId is { } aid) q = q.Where(t => t.AssigneeId == aid);
        if (query.StageId is { } stgid) q = q.Where(t => t.StageId == stgid);
        if (query.SprintId is { } spid) q = q.Where(t => t.SprintId == spid);
        else if (query.Backlog) q = q.Where(t => t.SprintId == null);
        if (query.StatusId is { } sid) q = q.Where(t => t.StatusId == sid);
        if (query.Category is { } cat) q = q.Where(t => t.Status!.Category == cat);
        if (query.Priority is { } prio) q = q.Where(t => t.Priority == prio);
        if (query.LabelId is { } lid) q = q.Where(t => t.Labels.Any(l => l.LabelId == lid));
        if (query.OpenOnly) q = q.Where(t => t.Status!.Category != StatusCategory.Done && t.Status.Category != StatusCategory.Cancelled);
        if (query.DueFrom is { } from) q = q.Where(t => t.DueDate != null && t.DueDate >= from);
        if (query.DueTo is { } to) q = q.Where(t => t.DueDate != null && t.DueDate <= to);
        if (query.Overdue)
            q = q.Where(t => t.DueDate != null && t.DueDate < today && t.Status!.Category != StatusCategory.Done && t.Status.Category != StatusCategory.Cancelled);
        if (!string.IsNullOrWhiteSpace(query.Q))
        {
            var s = query.Q.Trim().ToLowerInvariant();
            q = q.Where(t => EF.Functions.Like(t.Title.ToLower(), SearchText.Pattern(s), SearchText.Escape) || (t.Description != null && EF.Functions.Like(t.Description.ToLower(), SearchText.Pattern(s), SearchText.Escape)));
        }

        var sort = query.Sort ?? (query.ProjectId is null ? "due" : "position");
        var ordered = sort switch
        {
            "due" => q.OrderBy(t => t.DueDate == null).ThenBy(t => t.DueDate).ThenBy(PriorityRank),
            "-due" => q.OrderByDescending(t => t.DueDate),
            "priority" => q.OrderBy(PriorityRank).ThenBy(t => t.DueDate == null).ThenBy(t => t.DueDate),
            "title" => q.OrderBy(t => t.Title),
            "created" => q.OrderByDescending(t => t.CreatedAt),
            "updated" => q.OrderByDescending(t => t.UpdatedAt ?? t.CreatedAt),
            _ => q.OrderBy(t => t.Position).ThenBy(t => t.CreatedAt),
        };

        var page = new PageQuery(query.Page, query.PageSize);
        var total = await ordered.CountAsync(ct);
        var pageQuery = ordered.Skip((page.SafePage - 1) * page.SafeSize(500)).Take(page.SafeSize(500));
        return new PagedResult<TaskDto>(await ProjectAsync(pageQuery, ct), page.SafePage, page.SafeSize(500), total);
    }

    public async Task<TaskDetailDto> GetAsync(Guid id, CancellationToken ct = default)
    {
        var task = await GetDtoAsync(id, ct);
        var subs = await ProjectAsync(access.VisibleTasks().Where(t => t.ParentTaskId == id).OrderBy(t => t.Position).ThenBy(t => t.CreatedAt), ct);
        return new TaskDetailDto(task, subs);
    }

    // ---------------------------------------------------------------- create / update / move / delete

    private async Task ValidateLabelsAsync(IReadOnlyList<Guid>? labelIds, CancellationToken ct)
    {
        if (labelIds is not { Count: > 0 }) return;
        var found = await db.Labels.CountAsync(l => labelIds.Contains(l.Id), ct);
        if (found != labelIds.Distinct().Count()) throw new ValidationException("labelIds", "One or more labels do not exist.");
    }

    /// <summary>Keeps hours within the column's own precision (decimal(9,2), so up to 9,999,999.99) with a much more realistic ceiling - without
    /// this, a value like 99999999 overflows the column and the database rejects the whole save with no field to point the person at.</summary>
    private const decimal MaxHours = 100_000m;
    private static void ValidateHours(decimal? hours, string field)
    {
        if (hours is { } h && (h < 0 || h > MaxHours)) throw new ValidationException(field, $"Hours must be between 0 and {MaxHours:N0}.");
    }

    private async Task<int> NextNumberAsync(Guid projectId, CancellationToken ct) =>
        (await db.Tasks.IgnoreQueryFilters().Where(t => t.ProjectId == projectId).MaxAsync(t => (int?)t.Number, ct) ?? 0) + 1;

    private async Task<double> NextPositionAsync(Guid projectId, Guid statusId, CancellationToken ct) =>
        (await db.Tasks.Where(t => t.ProjectId == projectId && t.StatusId == statusId).MaxAsync(t => (double?)t.Position, ct) ?? 0) + PositionStep;

    public async Task<TaskDto> CreateAsync(Guid projectId, CreateTaskRequest req, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.TasksCreate, ct);
        var tid = ctx.RequireTenantId();
        var userId = ctx.RequireUserId();
        var project = await access.GetProjectAsync(projectId, ct);
        if (project.Status == ProjectStatus.Archived)
            throw new ConflictException("Archived projects are read-only. Restore the project to add tasks.", "PROJECT_ARCHIVED");

        await entitlements.EnsureWithinLimitAsync(FeatureKeys.TaskLimit, await db.Tasks.CountAsync(ct), 1, ct);

        TaskItem? parentTask = null;
        if (req.ParentTaskId is { } parentId)
        {
            parentTask = await db.Tasks.FirstOrDefaultAsync(t => t.Id == parentId && t.ProjectId == projectId, ct)
                ?? throw new ValidationException("parentTaskId", "Parent task not found in this project.");
            if (parentTask.ParentTaskId is not null) throw new ValidationException("parentTaskId", "Subtasks cannot have their own subtasks.");
        }
        if (req.StartDate is { } s && req.DueDate is { } d && d < s) throw new ValidationException("dueDate", "Due date must not be before the start date.");
        ValidateHours(req.EstimatedHours, "estimatedHours");

        var statuses = await db.WorkflowStatuses.Where(x => x.ProjectId == projectId).OrderBy(x => x.Order).ToListAsync(ct);
        var status = req.StatusId is { } stid
            ? statuses.FirstOrDefault(x => x.Id == stid) ?? throw new ValidationException("statusId", "Status does not belong to this project.")
            : statuses.FirstOrDefault(x => x.Category == StatusCategory.Todo) ?? statuses.First();
        if (req.AssigneeId is { } assignee) { await access.EnsureTenantMemberAsync(assignee, "assigneeId", ct); await access.ShareWithAssigneeAsync(projectId, assignee, ct); }
        await ValidateLabelsAsync(req.LabelIds, ct);
        var milestoneId = await ResolveMilestoneAsync(projectId, req.MilestoneId, ct);
        // A subtask always sits in its parent's stage; only top-level tasks choose one.
        var stageId = parentTask is not null ? parentTask.StageId : await ResolveStageAsync(projectId, req.StageId, ct);
        // A task cannot be born done inside a stage that is still locked behind an unfinished one.
        if (status.Category == StatusCategory.Done) await completion.EnsureStageUnlockedAsync(stageId, ct);

        var now = clock.Now;
        var task = new TaskItem
        {
            TenantId = tid, ProjectId = projectId, ParentTaskId = req.ParentTaskId, StageId = stageId, MilestoneId = milestoneId, Number = await NextNumberAsync(projectId, ct),
            Title = req.Title.Trim(), Description = req.Description?.Trim(), StatusId = status.Id, Priority = req.Priority,
            AssigneeId = req.AssigneeId, ReporterId = userId, StartDate = req.StartDate, DueDate = req.DueDate,
            EstimatedHours = req.EstimatedHours, Position = await NextPositionAsync(projectId, status.Id, ct), CreatedAt = now, CreatedBy = userId,
            CompletedAt = status.Category == StatusCategory.Done ? now : null,
        };
        db.Tasks.Add(task);
        await WorkStartedAsync(projectId, status.Category, ct);
        foreach (var lid in (req.LabelIds ?? []).Distinct())
            db.TaskLabels.Add(new TaskLabel { TenantId = tid, TaskId = task.Id, LabelId = lid, CreatedAt = now });

        var key = $"{project.Key}-{task.Number}";
        recorder.Activity("task.created", "Task", task.Id, $"Created task {key} \"{task.Title}\"", projectId);
        if (task.AssigneeId is { } who)
            await notifications.AddAsync(who, NotificationType.TaskAssigned, $"You were assigned {key}", task.Title, $"/projects/{projectId}?task={task.Id}");
        await automation.RunAsync(task, key, AutomationTrigger.TaskCreated, task.StatusId, task.Priority, (req.LabelIds ?? []).Distinct().ToList(), ct);
        project.UpdatedAt = now;
        await db.SaveChangesAsync(ct);
        if (parentTask is null) await completion.SyncStagesAsync([task.StageId], ct);
        return await GetDtoAsync(task.Id, ct);
    }

    public async Task<TaskDto> UpdateAsync(Guid id, UpdateTaskRequest req, CancellationToken ct = default)
    {
        var task = await access.VisibleTasks().FirstOrDefaultAsync(t => t.Id == id, ct) ?? throw new NotFoundException("Task not found.");
        await permissions.RequireTaskEditAsync(task, ct);
        if (task.Version != req.Version)
            throw new ConflictException("This task was changed by someone else. Reload and try again.", "VERSION_CONFLICT");
        if (req.StartDate is { } s && req.DueDate is { } d && d < s) throw new ValidationException("dueDate", "Due date must not be before the start date.");
        ValidateHours(req.EstimatedHours, "estimatedHours");
        ValidateHours(req.ActualHours, "actualHours");
        var dueNote = DueDateHistory.Prepare(task.DueDate, req.DueDate, req.DueDateReason, req.DueDateDependency);   // a delay needs a reason

        var project = await db.Projects.FirstAsync(p => p.Id == task.ProjectId, ct);
        var status = await db.WorkflowStatuses.FirstOrDefaultAsync(x => x.Id == req.StatusId && x.ProjectId == task.ProjectId, ct)
            ?? throw new ValidationException("statusId", "Status does not belong to this project.");
        if (req.AssigneeId is { } assignee) { await access.EnsureTenantMemberAsync(assignee, "assigneeId", ct); await access.ShareWithAssigneeAsync(task.ProjectId, assignee, ct); }
        await ValidateLabelsAsync(req.LabelIds, ct);
        task.MilestoneId = await ResolveMilestoneAsync(task.ProjectId, req.MilestoneId, ct);
        if (task.StatusId != status.Id) await EnsureNotBlockedAsync(task, status, ct);
        // Leaving the stage out keeps the task where it is: a phase is moved on purpose, never wiped by a client that does not know about it.
        var oldStageId = task.StageId;
        if (task.ParentTaskId is null && req.StageId is not null)
        {
            task.StageId = await ResolveStageAsync(task.ProjectId, req.StageId, ct);
            if (task.StageId != oldStageId)
                foreach (var sub in await db.Tasks.Where(t => t.ParentTaskId == id).ToListAsync(ct)) sub.StageId = task.StageId;
        }
        // Done needs the stage before its stage to be finished, and the task's own subtasks and checklist.
        if (task.StatusId != status.Id) await completion.EnsureCanCompleteAsync(task, status, task.StageId, ct);

        var oldStatus = await db.WorkflowStatuses.Where(x => x.Id == task.StatusId).Select(x => x.Name).FirstAsync(ct);
        var oldAssignee = task.AssigneeId; var oldDue = task.DueDate; var oldPriority = task.Priority; var oldStart = task.StartDate; var oldTitle = task.Title;
        var key = $"{project.Key}-{task.Number}";

        task.Title = req.Title.Trim(); task.Description = req.Description?.Trim(); task.Priority = req.Priority;
        task.AssigneeId = req.AssigneeId; task.StartDate = req.StartDate; task.DueDate = req.DueDate;
        task.EstimatedHours = req.EstimatedHours;
        // With tracked time, actual hours is the sum of the time entries and cannot be typed over.
        if (!await db.TimeEntries.AnyAsync(e => e.TaskId == id, ct)) task.ActualHours = req.ActualHours;
        if (task.StatusId != status.Id) task.Position = await NextPositionAsync(task.ProjectId, status.Id, ct);
        ApplyStatus(task, status);
        task.Version++;
        await WorkStartedAsync(task.ProjectId, status.Category, ct);

        // Replace label set.
        var current = await db.TaskLabels.Where(l => l.TaskId == id).ToListAsync(ct);
        var wanted = (req.LabelIds ?? []).Distinct().ToHashSet();
        db.TaskLabels.RemoveRange(current.Where(l => !wanted.Contains(l.LabelId)));
        foreach (var lid in wanted.Where(w => current.All(c => c.LabelId != w)))
            db.TaskLabels.Add(new TaskLabel { TenantId = task.TenantId, TaskId = id, LabelId = lid, CreatedAt = clock.Now });

        if (oldStatus != status.Name)
            recorder.Activity("task.status_changed", "Task", id, $"{key}: status {oldStatus} → {status.Name}", task.ProjectId, oldStatus, status.Name);
        if (oldAssignee != task.AssigneeId)
        {
            var name = task.AssigneeId is { } a ? await db.Users.Where(u => u.Id == a).Select(u => u.DisplayName).FirstAsync(ct) : "nobody";
            recorder.Activity("task.assigned", "Task", id, $"{key} assigned to {name}", task.ProjectId);
            if (task.AssigneeId is { } who)
                await notifications.AddAsync(who, NotificationType.TaskAssigned, $"You were assigned {key}", task.Title, $"/projects/{task.ProjectId}?task={id}");
        }
        if (dueNote is not null)
        {
            dueHistory.Record(task.TenantId, task.ProjectId, id, oldDue, task.DueDate, dueNote);
            recorder.Activity("task.due_changed", "Task", id, $"{key}: {DueDateHistory.Describe(oldDue, task.DueDate, dueNote.Reason)}", task.ProjectId,
                oldDue?.ToString("yyyy-MM-dd"), task.DueDate?.ToString("yyyy-MM-dd"));
        }
        if (oldPriority != task.Priority)
            recorder.Activity("task.priority_changed", "Task", id, $"{key}: priority {oldPriority} → {task.Priority}", task.ProjectId);
        if (oldStatus != status.Name) await automation.RunAsync(task, key, AutomationTrigger.StatusChanged, status.Id, null, null, ct);
        if (oldPriority != task.Priority) await automation.RunAsync(task, key, AutomationTrigger.PriorityChanged, null, task.Priority, null, ct);
        // The rest of a task's timeline and identity: when it starts, which phase it belongs to, what it is called.
        if (oldStart != task.StartDate)
            recorder.Activity("task.start_changed", "Task", id, $"{key}: start date {oldStart?.ToString("dd MMM yyyy") ?? "none"} → {task.StartDate?.ToString("dd MMM yyyy") ?? "none"}", task.ProjectId,
                oldStart?.ToString("yyyy-MM-dd"), task.StartDate?.ToString("yyyy-MM-dd"));
        var stageMoved = task.StageId != oldStageId;
        if (stageMoved)
        {
            var involved = new[] { oldStageId, task.StageId }.Where(s => s != null).Select(s => s!.Value).ToList();
            var stageNames = await db.ProjectStages.AsNoTracking().Where(s => involved.Contains(s.Id)).ToDictionaryAsync(s => s.Id, s => s.Name, ct);
            string Phase(Guid? s) => s is { } g && stageNames.TryGetValue(g, out var n) ? n : "none";
            recorder.Activity("task.stage_changed", "Task", id, $"{key}: phase {Phase(oldStageId)} → {Phase(task.StageId)}", task.ProjectId, Phase(oldStageId), Phase(task.StageId));
        }
        var renamed = oldTitle != task.Title;
        if (renamed) recorder.Activity("task.renamed", "Task", id, $"{key} renamed: “{oldTitle}” → “{task.Title}”", task.ProjectId, oldTitle, task.Title);
        if (oldStatus == status.Name && oldAssignee == task.AssigneeId && oldDue == task.DueDate && oldPriority == task.Priority && oldStart == task.StartDate && !stageMoved && !renamed)
            recorder.Activity("task.updated", "Task", id, $"Updated task {key} \"{task.Title}\"", task.ProjectId);

        // Reassignment already tells the new assignee (TaskAssigned, above); this is everything else that changed, to whoever is still
        // on the task (assignee and reporter), so a watcher is not left to notice a status/date/priority/title change on their own.
        var changeNotes = new List<string>();
        if (oldStatus != status.Name) changeNotes.Add($"status: {oldStatus} → {status.Name}");
        if (dueNote is not null) changeNotes.Add(DueDateHistory.Describe(oldDue, task.DueDate, dueNote.Reason));
        if (oldPriority != task.Priority) changeNotes.Add($"priority: {oldPriority} → {task.Priority}");
        if (oldStart != task.StartDate) changeNotes.Add("start date changed");
        if (renamed) changeNotes.Add($"renamed to “{task.Title}”");
        if (changeNotes.Count > 0)
        {
            var updateLink = $"/projects/{task.ProjectId}?task={id}";
            foreach (var who in new[] { task.AssigneeId, (Guid?)task.ReporterId }.Where(x => x is not null).Select(x => x!.Value).Distinct())
                await notifications.AddAsync(who, NotificationType.TaskUpdated, $"{key} updated", string.Join(" · ", changeNotes), updateLink, ct: ct);
        }

        await db.SaveChangesAsync(ct);
        if (task.ParentTaskId is null) await completion.SyncStagesAsync([oldStageId, task.StageId], ct);
        return await GetDtoAsync(id, ct);
    }

    /// <summary>The stage must belong to the same project. Null means no stage.</summary>
    private async Task<Guid?> ResolveStageAsync(Guid projectId, Guid? stageId, CancellationToken ct)
    {
        if (stageId is not { } id) return null;
        if (!await db.ProjectStages.AnyAsync(s => s.Id == id && s.ProjectId == projectId, ct))
            throw new ValidationException("stageId", "Timeline phase not found in this project.");
        return id;
    }

    /// <summary>The milestone must belong to the same project. Null clears it.</summary>
    private async Task<Guid?> ResolveMilestoneAsync(Guid projectId, Guid? milestoneId, CancellationToken ct)
    {
        if (milestoneId is not { } id) return null;
        if (!await db.Milestones.AnyAsync(m => m.Id == id && m.ProjectId == projectId, ct))
            throw new ValidationException("milestoneId", "Milestone not found in this project.");
        return id;
    }

    /// <summary>Refuses a status change that a dependency does not allow yet (spec section 18).</summary>
    private async Task EnsureNotBlockedAsync(TaskItem task, WorkflowStatus status, CancellationToken ct)
    {
        if (await planning.BlockedReasonAsync(task, status.Category, ct) is { } reason)
            throw new ConflictException($"This task cannot move to “{status.Name}” yet: {reason}", "DEPENDENCY_BLOCKED");
    }

    /// <summary>
    /// A project in Planning becomes Active the moment work on it really starts (a task is moved to an in-progress or done status), the way
    /// delivery tools work. It never completes by itself: when everything is done the project page suggests marking it completed, because
    /// closing a project is a decision (scope may still grow). On hold, cancelled, completed and archived projects are left as they are.
    /// </summary>
    private async Task WorkStartedAsync(Guid projectId, StatusCategory category, CancellationToken ct)
    {
        if (category is not (StatusCategory.Active or StatusCategory.Done)) return;
        var project = await db.Projects.FirstOrDefaultAsync(p => p.Id == projectId, ct);
        if (project is null || project.Status != ProjectStatus.Planning) return;
        project.Status = ProjectStatus.Active;
        project.Version++;
        recorder.Activity("project.started", "Project", project.Id, $"{project.Name} is now Active: work has started", project.Id, nameof(ProjectStatus.Planning), nameof(ProjectStatus.Active));
    }

    private void ApplyStatus(TaskItem task, WorkflowStatus status)
    {
        var wasDone = task.CompletedAt is not null;
        task.StatusId = status.Id;
        task.CompletedAt = status.Category == StatusCategory.Done ? (wasDone ? task.CompletedAt : clock.Now) : null;
    }

    public async Task<TaskDto> MoveAsync(Guid id, MoveTaskRequest req, CancellationToken ct = default)
    {
        var task = await access.VisibleTasks().FirstOrDefaultAsync(t => t.Id == id, ct) ?? throw new NotFoundException("Task not found.");
        await permissions.RequireTaskEditAsync(task, ct);
        var status = await db.WorkflowStatuses.FirstOrDefaultAsync(x => x.Id == req.StatusId && x.ProjectId == task.ProjectId, ct)
            ?? throw new ValidationException("statusId", "Status does not belong to this project.");
        var oldName = await db.WorkflowStatuses.Where(x => x.Id == task.StatusId).Select(x => x.Name).FirstAsync(ct);
        var changed = task.StatusId != status.Id;
        if (changed)
        {
            await EnsureNotBlockedAsync(task, status, ct);
            await completion.EnsureCanCompleteAsync(task, status, task.StageId, ct);
        }

        task.Position = req.Position ?? await NextPositionAsync(task.ProjectId, status.Id, ct);
        ApplyStatus(task, status);
        task.Version++;
        if (changed) await WorkStartedAsync(task.ProjectId, status.Category, ct);
        if (changed)
        {
            var key = $"{await db.Projects.Where(p => p.Id == task.ProjectId).Select(p => p.Key).FirstAsync(ct)}-{task.Number}";
            recorder.Activity("task.status_changed", "Task", id, $"{key}: status {oldName} → {status.Name}", task.ProjectId, oldName, status.Name);
            await automation.RunAsync(task, key, AutomationTrigger.StatusChanged, status.Id, null, null, ct);
        }
        await db.SaveChangesAsync(ct);
        if (changed && task.ParentTaskId is null) await completion.SyncStagesAsync([task.StageId], ct);
        return await GetDtoAsync(id, ct);
    }

    public async Task DeleteAsync(Guid id, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.TasksDelete, ct);
        var task = await access.VisibleTasks().FirstOrDefaultAsync(t => t.Id == id, ct) ?? throw new NotFoundException("Task not found.");
        var now = clock.Now;
        foreach (var t in await db.Tasks.Where(t => t.Id == id || t.ParentTaskId == id).ToListAsync(ct))
        { t.IsDeleted = true; t.DeletedAt = now; t.DeletedBy = ctx.UserId; }
        recorder.Audit("task.deleted", "Task", id, new { task.Title });
        recorder.Activity("task.deleted", "Task", id, $"Deleted task \"{task.Title}\"", task.ProjectId);
        await db.SaveChangesAsync(ct);
        if (task.ParentTaskId is null) await completion.SyncStagesAsync([task.StageId], ct);
    }

    // ---------------------------------------------------------------- comments

    private async Task<TaskItem> VisibleTaskAsync(Guid taskId, CancellationToken ct) =>
        await access.VisibleTasks().FirstOrDefaultAsync(t => t.Id == taskId, ct) ?? throw new NotFoundException("Task not found.");

    public async Task<IReadOnlyList<CommentDto>> GetCommentsAsync(Guid taskId, CancellationToken ct = default)
    {
        await VisibleTaskAsync(taskId, ct);
        var canModerate = await permissions.HasAsync(Permissions.TasksDelete, ct);
        var rows = await db.TaskComments.AsNoTracking().Include(c => c.Author)
            .Where(c => c.TaskId == taskId).OrderBy(c => c.CreatedAt).ToListAsync(ct);
        return rows.Select(c => ToDto(c, canModerate)).ToList();
    }

    private CommentDto ToDto(TaskComment c, bool canModerate) =>
        new(c.Id, c.TaskId, new UserRefDto(c.AuthorId, c.Author?.DisplayName ?? "Unknown"), c.Body, c.ParentCommentId,
            c.CreatedAt, c.EditedAt, c.AuthorId == ctx.UserId, c.AuthorId == ctx.UserId || canModerate);

    public async Task<CommentDto> AddCommentAsync(Guid taskId, CreateCommentRequest req, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.TasksComment, ct);
        var task = await VisibleTaskAsync(taskId, ct);
        var userId = ctx.RequireUserId();
        if (req.ParentCommentId is { } parentId && !await db.TaskComments.AnyAsync(c => c.Id == parentId && c.TaskId == taskId, ct))
            throw new ValidationException("parentCommentId", "Parent comment not found.");

        var comment = new TaskComment
        {
            TenantId = task.TenantId, TaskId = taskId, AuthorId = userId, Body = req.Body.Trim(),
            ParentCommentId = req.ParentCommentId, CreatedAt = clock.Now, CreatedBy = userId,
        };
        db.TaskComments.Add(comment);

        var project = await db.Projects.FirstAsync(p => p.Id == task.ProjectId, ct);
        var key = $"{project.Key}-{task.Number}";
        var link = $"/projects/{task.ProjectId}?task={taskId}";
        var mentioned = (req.MentionUserIds ?? []).Distinct().ToList();
        var valid = await db.TenantMembers.Where(m => m.TenantId == task.TenantId && mentioned.Contains(m.UserId)).Select(m => m.UserId).ToListAsync(ct);
        foreach (var uid in valid)
            await notifications.AddAsync(uid, NotificationType.Mention, $"You were mentioned on {key}", Text.Truncate(comment.Body, 200), link);
        foreach (var uid in new[] { task.AssigneeId, (Guid?)task.ReporterId }.Where(x => x is not null).Select(x => x!.Value).Distinct().Where(u => !valid.Contains(u)))
            await notifications.AddAsync(uid, NotificationType.Comment, $"New comment on {key}", Text.Truncate(comment.Body, 200), link);

        recorder.Activity("task.commented", "Task", taskId, $"Commented on {key} \"{task.Title}\"", task.ProjectId);
        await db.SaveChangesAsync(ct);
        return (await GetCommentsAsync(taskId, ct)).First(c => c.Id == comment.Id);
    }

    public async Task<CommentDto> UpdateCommentAsync(Guid commentId, UpdateCommentRequest req, CancellationToken ct = default)
    {
        var comment = await db.TaskComments.FirstOrDefaultAsync(c => c.Id == commentId, ct) ?? throw new NotFoundException("Comment not found.");
        await VisibleTaskAsync(comment.TaskId, ct);
        if (comment.AuthorId != ctx.UserId) throw new ForbiddenException("You can only edit your own comments.", "PERMISSION_DENIED");
        comment.Body = req.Body.Trim();
        comment.EditedAt = clock.Now;
        await db.SaveChangesAsync(ct);
        return (await GetCommentsAsync(comment.TaskId, ct)).First(c => c.Id == commentId);
    }

    public async Task DeleteCommentAsync(Guid commentId, CancellationToken ct = default)
    {
        var comment = await db.TaskComments.FirstOrDefaultAsync(c => c.Id == commentId, ct) ?? throw new NotFoundException("Comment not found.");
        await VisibleTaskAsync(comment.TaskId, ct);
        if (comment.AuthorId != ctx.UserId && !await permissions.HasAsync(Permissions.TasksDelete, ct))
            throw new ForbiddenException("You can only delete your own comments.", "PERMISSION_DENIED");
        comment.IsDeleted = true; comment.DeletedAt = clock.Now; comment.DeletedBy = ctx.UserId;
        await db.SaveChangesAsync(ct);
    }
}
