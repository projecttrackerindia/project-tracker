using System.Text;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Files;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Work;

public record WorkTaskCan(bool Edit, bool Delete);
public record WorkProjectRefDto(Guid Id, string Key, string Name, ProjectStatus Status);
public record WorkTaskDto(Guid Id, string Key, int Number, string Title, string? Description, Guid WorkTypeId, string WorkType, WorkProjectRefDto? RelatedProject,
    UserRefDto? Assignee, UserRefDto? Reporter, Priority Priority, WorkTaskStatus Status, DateOnly? StartDate, DateOnly? DueDate, bool IsOverdue,
    DateTime? CompletedAt, DateTime CreatedAt, int Version, int CommentCount, int AttachmentCount, WorkTaskCan Can);

public record CreateWorkTaskRequest(string? Title, string? Description, Guid? WorkTypeId, Guid? RelatedProjectId, Guid? AssigneeId, Priority? Priority,
    WorkTaskStatus? Status, DateOnly? StartDate, DateOnly? DueDate);
/// <summary>All the editable fields at once: what is sent replaces what was there (an empty related project, assignee or date clears it).</summary>
public record UpdateWorkTaskRequest(string? Title, string? Description, Guid? WorkTypeId, Guid? RelatedProjectId, Guid? AssigneeId, Priority Priority,
    WorkTaskStatus Status, DateOnly? StartDate, DateOnly? DueDate, int Version);
public record SetWorkTaskStatusRequest(WorkTaskStatus Status);

public record WorkTaskQuery(string? Q = null, Guid? WorkTypeId = null, Guid? RelatedProjectId = null, bool? NoProject = null, Guid? AssigneeId = null, bool Mine = false,
    Priority? Priority = null, WorkTaskStatus? Status = null, bool? Open = null, DateOnly? DueFrom = null, DateOnly? DueTo = null, bool? Overdue = null,
    string? Sort = null, int Page = 1, int PageSize = 25);

public record WorkCommentDto(Guid Id, Guid WorkTaskId, UserRefDto? Author, string Body, DateTime CreatedAt, DateTime? EditedAt, bool CanEdit, bool CanDelete);
public record WorkCommentRequest(string? Body);
public record WorkAttachmentDto(Guid Id, Guid WorkTaskId, string FileName, string ContentType, long SizeBytes, UserRefDto? UploadedBy, DateTime CreatedAt, bool CanDelete, bool IsImage);
public record WorkActivityDto(Guid Id, string Action, string Summary, UserRefDto? Actor, DateTime CreatedAt);

public record WorkCountDto(string Name, int Open, int Overdue, int Completed);
public record WorkPersonCountDto(Guid? UserId, string Name, int Open, int Overdue, int Completed);
public record WorkStatusCountDto(WorkTaskStatus Status, int Count);
public record WorkDayDto(DateOnly Date, int Completed, int Created);
public record WorkSummaryDto(DateOnly From, DateOnly To, int Open, int Overdue, int DueThisWeek, int Unassigned, int CompletedInPeriod, int CreatedInPeriod, int MineOpen, int MineOverdue,
    IReadOnlyList<WorkCountDto> ByType, IReadOnlyList<WorkStatusCountDto> ByStatus, IReadOnlyList<WorkPersonCountDto> ByPerson, IReadOnlyList<WorkCountDto> ByProject,
    IReadOnlyList<WorkDayDto> PerDay);

/// <summary>
/// Work tasks: operational activities (bug fixes, support, analysis, data preparation ...) kept apart from a project's delivery tasks. A work task may point at a
/// project for reference, but nothing here ever changes that project - a completed project stays completed. Anyone with access to Work management can see every
/// work task; people who may create them can add; the assignee, the person who raised it and those allowed to edit any work task can change it.
/// </summary>
public class WorkTaskService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, PermissionService permissions, ProjectAccess access,
    NotificationService notifications, WorkTypeService types, AttachmentService files, IFileStorage storage, ILogger<WorkTaskService> log)
{
    private const int MaxPageSize = 100;
    private const int MaxFilesPerTask = 50;
    private const int MaxExport = 5000;

    private static bool IsOpen(WorkTaskStatus s) => s is WorkTaskStatus.ToDo or WorkTaskStatus.InProgress or WorkTaskStatus.OnHold;
    public static string KeyOf(int number) => $"WT-{number}";

    // ------------------------------------------------------------------ rules

    private static string CleanTitle(string? title)
    {
        var t = (title ?? "").Trim();
        if (t.Length == 0) throw new ValidationException("title", "Give the work task a short title.");
        if (t.Length > 200) throw new ValidationException("title", "The title can be at most 200 characters.");
        return t;
    }

    private static string? CleanDescription(string? d)
    {
        var t = d?.Replace("\r\n", "\n").Trim();
        if (string.IsNullOrEmpty(t)) return null;
        if (t.Length > 8000) throw new ValidationException("description", "The description can be at most 8,000 characters.");
        return t;
    }

    private static void CheckDates(DateOnly? start, DateOnly? due)
    {
        if (start is { } s && due is { } d && d < s) throw new ValidationException("dueDate", "The due date must not be before the start date.");
    }

    private async Task<WorkType> RequireTypeAsync(Guid? id, Guid? current, CancellationToken ct)
    {
        if (id is not { } tid) throw new ValidationException("workTypeId", "Choose a work type.");
        var type = await db.WorkTypes.AsNoTracking().FirstOrDefaultAsync(t => t.Id == tid, ct) ?? throw new ValidationException("workTypeId", "That work type was not found.");
        if (!type.IsActive && tid != current) throw new ValidationException("workTypeId", $"The work type “{type.Name}” is inactive. Choose an active one.");
        return type;
    }

    /// <summary>The related project is for reference only, so any project the person can see will do - including completed and archived ones.</summary>
    private async Task CheckRelatedProjectAsync(Guid? projectId, CancellationToken ct)
    {
        if (projectId is not { } pid) return;
        if (!await access.VisibleProjects().AnyAsync(p => p.Id == pid, ct)) throw new ValidationException("relatedProjectId", "That project was not found.");
    }

    private async Task CheckAssigneeAsync(Guid? assigneeId, CancellationToken ct)
    {
        if (assigneeId is not { } a) return;
        await access.EnsureTenantMemberAsync(a, "assigneeId", ct);
        var tid = ctx.RequireTenantId();
        if (await db.TenantMembers.AnyAsync(m => m.TenantId == tid && m.UserId == a && m.Role == TenantRole.Guest, ct))
            throw new ValidationException("assigneeId", "Guests cannot be given work tasks.");
    }

    private async Task<bool> CanEditAsync(WorkTask t, CancellationToken ct) =>
        await permissions.LevelAsync(Modules.Work, ct) >= AccessLevel.Edit
        && (await permissions.HasAsync(Permissions.WorkEdit, ct) || t.AssigneeId == ctx.UserId || t.ReporterId == ctx.UserId);

    private async Task<bool> CanDeleteAsync(WorkTask t, CancellationToken ct) =>
        await permissions.LevelAsync(Modules.Work, ct) >= AccessLevel.Edit
        && (await permissions.HasAsync(Permissions.WorkDelete, ct) || (t.ReporterId == ctx.UserId && await permissions.HasAsync(Permissions.WorkCreate, ct)));

    private async Task RequireEditAsync(WorkTask t, CancellationToken ct)
    {
        if (!await CanEditAsync(t, ct)) throw new ForbiddenException("You can only change work tasks that are assigned to you or that you raised.", "PERMISSION_DENIED");
    }

    private async Task<WorkTask> FindAsync(Guid id, CancellationToken ct) =>
        await db.WorkTasks.FirstOrDefaultAsync(t => t.Id == id, ct) ?? throw new NotFoundException("Work task not found.", "WORK_TASK_NOT_FOUND");

    // ------------------------------------------------------------------ read

    private IQueryable<WorkTask> Filtered(WorkTaskQuery f)
    {
        var q = db.WorkTasks.AsNoTracking().AsQueryable();
        var today = clock.Today;
        if (f.Mine) { var me = ctx.UserId; q = q.Where(t => t.AssigneeId == me); }
        else if (f.AssigneeId is { } a) q = q.Where(t => t.AssigneeId == a);
        if (f.WorkTypeId is { } wt) q = q.Where(t => t.WorkTypeId == wt);
        if (f.NoProject == true) q = q.Where(t => t.RelatedProjectId == null);
        else if (f.RelatedProjectId is { } p) q = q.Where(t => t.RelatedProjectId == p);
        if (f.Priority is { } pr) q = q.Where(t => t.Priority == pr);
        if (f.Status is { } st) q = q.Where(t => t.Status == st);
        if (f.Open == true) q = q.Where(t => t.Status == WorkTaskStatus.ToDo || t.Status == WorkTaskStatus.InProgress || t.Status == WorkTaskStatus.OnHold);
        else if (f.Open == false) q = q.Where(t => t.Status == WorkTaskStatus.Completed || t.Status == WorkTaskStatus.Cancelled);
        if (f.DueFrom is { } from) q = q.Where(t => t.DueDate != null && t.DueDate >= from);
        if (f.DueTo is { } to) q = q.Where(t => t.DueDate != null && t.DueDate <= to);
        if (f.Overdue == true)
            q = q.Where(t => t.DueDate != null && t.DueDate < today && (t.Status == WorkTaskStatus.ToDo || t.Status == WorkTaskStatus.InProgress || t.Status == WorkTaskStatus.OnHold));
        if (!string.IsNullOrWhiteSpace(f.Q))
        {
            var s = f.Q.Trim().ToLowerInvariant();
            var number = s.StartsWith("wt-") && int.TryParse(s[3..], out var n) ? n : -1;
            q = q.Where(t => t.Title.ToLower().Contains(s) || (t.Description != null && t.Description.ToLower().Contains(s)) || t.Number == number);
        }
        return q;
    }

    private IQueryable<WorkTask> Sorted(IQueryable<WorkTask> q, string? sort)
    {
        var desc = sort?.StartsWith('-') == true;
        var key = (sort ?? "").TrimStart('-').ToLowerInvariant();
        IOrderedQueryable<WorkTask> o = key switch
        {
            "title" => desc ? q.OrderByDescending(t => t.Title.ToLower()) : q.OrderBy(t => t.Title.ToLower()),
            "type" => desc ? q.OrderByDescending(t => t.WorkType!.Name) : q.OrderBy(t => t.WorkType!.Name),
            "project" => desc ? q.OrderByDescending(t => db.Projects.Where(p => p.Id == t.RelatedProjectId).Select(p => p.Name).FirstOrDefault())
                              : q.OrderBy(t => db.Projects.Where(p => p.Id == t.RelatedProjectId).Select(p => p.Name).FirstOrDefault()),
            "assignee" => desc ? q.OrderByDescending(t => db.Users.Where(u => u.Id == t.AssigneeId).Select(u => u.DisplayName).FirstOrDefault())
                               : q.OrderBy(t => db.Users.Where(u => u.Id == t.AssigneeId).Select(u => u.DisplayName).FirstOrDefault()),
            "priority" => desc ? q.OrderBy(t => t.Priority == Priority.Critical ? 3 : t.Priority == Priority.High ? 2 : t.Priority == Priority.Medium ? 1 : 0)
                               : q.OrderByDescending(t => t.Priority == Priority.Critical ? 3 : t.Priority == Priority.High ? 2 : t.Priority == Priority.Medium ? 1 : 0),
            "status" => desc ? q.OrderByDescending(t => t.Status) : q.OrderBy(t => t.Status),
            "due" => desc ? q.OrderBy(t => t.DueDate == null).ThenByDescending(t => t.DueDate) : q.OrderBy(t => t.DueDate == null).ThenBy(t => t.DueDate),
            "created" => desc ? q.OrderBy(t => t.CreatedAt) : q.OrderByDescending(t => t.CreatedAt),
            // default: what still needs doing first, the soonest due first, then the more urgent
            _ => q.OrderBy(t => t.Status == WorkTaskStatus.Completed || t.Status == WorkTaskStatus.Cancelled).ThenBy(t => t.DueDate == null).ThenBy(t => t.DueDate)
                  .ThenByDescending(t => t.Priority == Priority.Critical ? 3 : t.Priority == Priority.High ? 2 : t.Priority == Priority.Medium ? 1 : 0),
        };
        return o.ThenByDescending(t => t.Number);
    }

    public async Task<PagedResult<WorkTaskDto>> ListAsync(WorkTaskQuery query, CancellationToken ct = default)
    {
        ctx.RequireTenantId();
        var page = Math.Max(1, query.Page); var size = Math.Clamp(query.PageSize, 1, MaxPageSize);
        var q = Filtered(query);
        var total = await q.CountAsync(ct);
        var rows = await Sorted(q, query.Sort).Include(t => t.WorkType).Skip((page - 1) * size).Take(size).ToListAsync(ct);
        return new PagedResult<WorkTaskDto>(await ToDtosAsync(rows, ct), page, size, total);
    }

    public async Task<WorkTaskDto> GetAsync(Guid id, CancellationToken ct = default)
    {
        var t = await db.WorkTasks.AsNoTracking().Include(x => x.WorkType).FirstOrDefaultAsync(x => x.Id == id, ct) ?? throw new NotFoundException("Work task not found.", "WORK_TASK_NOT_FOUND");
        return (await ToDtosAsync([t], ct))[0];
    }

    private async Task<IReadOnlyList<WorkTaskDto>> ToDtosAsync(IReadOnlyList<WorkTask> rows, CancellationToken ct)
    {
        if (rows.Count == 0) return [];
        var today = clock.Today;
        var ids = rows.Select(r => r.Id).ToList();
        var people = rows.SelectMany(r => new[] { r.AssigneeId, (Guid?)r.ReporterId }).Where(x => x != null).Select(x => x!.Value).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => people.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        var projectIds = rows.Where(r => r.RelatedProjectId != null).Select(r => r.RelatedProjectId!.Value).Distinct().ToList();
        var projects = await db.Projects.AsNoTracking().Where(p => projectIds.Contains(p.Id)).ToDictionaryAsync(p => p.Id, p => new WorkProjectRefDto(p.Id, p.Key, p.Name, p.Status), ct);
        var comments = await db.WorkTaskComments.AsNoTracking().Where(c => ids.Contains(c.WorkTaskId)).GroupBy(c => c.WorkTaskId).Select(g => new { g.Key, N = g.Count() }).ToDictionaryAsync(x => x.Key, x => x.N, ct);
        var attachments = await db.WorkTaskAttachments.AsNoTracking().Where(a => ids.Contains(a.WorkTaskId)).GroupBy(a => a.WorkTaskId).Select(g => new { g.Key, N = g.Count() }).ToDictionaryAsync(x => x.Key, x => x.N, ct);
        UserRefDto? Ref(Guid? id) => id is { } u && names.TryGetValue(u, out var n) ? new UserRefDto(u, n) : null;

        var result = new List<WorkTaskDto>(rows.Count);
        foreach (var r in rows)
        {
            var can = new WorkTaskCan(await CanEditAsync(r, ct), await CanDeleteAsync(r, ct));
            result.Add(new WorkTaskDto(r.Id, KeyOf(r.Number), r.Number, r.Title, r.Description, r.WorkTypeId, r.WorkType?.Name ?? "", r.RelatedProjectId is { } p && projects.TryGetValue(p, out var pr) ? pr : null,
                Ref(r.AssigneeId), Ref(r.ReporterId), r.Priority, r.Status, r.StartDate, r.DueDate, IsOpen(r.Status) && r.DueDate is { } d && d < today, r.CompletedAt, r.CreatedAt, r.Version,
                comments.GetValueOrDefault(r.Id), attachments.GetValueOrDefault(r.Id), can));
        }
        return result;
    }

    // ------------------------------------------------------------------ write

    private async Task NotifyAssignedAsync(WorkTask t, CancellationToken ct)
    {
        if (t.AssigneeId is not { } who || who == ctx.UserId) return;
        await notifications.AddAsync(who, NotificationType.TaskAssigned, $"Work task assigned to you: {t.Title}", $"{KeyOf(t.Number)}{(t.DueDate is { } d ? $" · due {d:dd MMM yyyy}" : "")}", $"/work?task={t.Id}", ct: ct);
    }

    public async Task<WorkTaskDto> CreateAsync(CreateWorkTaskRequest req, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.WorkCreate, ct);
        var tid = ctx.RequireTenantId();
        await types.EnsureDefaultsAsync(ct);
        var title = CleanTitle(req.Title);
        var type = await RequireTypeAsync(req.WorkTypeId, null, ct);
        await CheckRelatedProjectAsync(req.RelatedProjectId, ct);
        await CheckAssigneeAsync(req.AssigneeId, ct);
        CheckDates(req.StartDate, req.DueDate);
        var status = req.Status ?? WorkTaskStatus.ToDo;
        var now = clock.Now;

        var task = new WorkTask
        {
            TenantId = tid, Number = (await db.WorkTasks.IgnoreQueryFilters().Where(t => t.TenantId == tid).MaxAsync(t => (int?)t.Number, ct) ?? 0) + 1,
            Title = title, Description = CleanDescription(req.Description), WorkTypeId = type.Id, RelatedProjectId = req.RelatedProjectId, AssigneeId = req.AssigneeId,
            ReporterId = ctx.RequireUserId(), Priority = req.Priority ?? Priority.Medium, Status = status, StartDate = req.StartDate, DueDate = req.DueDate,
            CompletedAt = status == WorkTaskStatus.Completed ? now : null, CreatedAt = now, CreatedBy = ctx.UserId,
        };
        db.WorkTasks.Add(task);
        // Work activity belongs to the workspace, not to the related project: the project's own history stays about the project.
        recorder.Activity("worktask.created", "WorkTask", task.Id, $"Created work task {KeyOf(task.Number)} “{title}” ({type.Name})", null);
        await NotifyAssignedAsync(task, ct);
        await db.SaveChangesAsync(ct);
        return await GetAsync(task.Id, ct);
    }

    public async Task<WorkTaskDto> UpdateAsync(Guid id, UpdateWorkTaskRequest req, CancellationToken ct = default)
    {
        var task = await FindAsync(id, ct);
        await RequireEditAsync(task, ct);
        if (task.Version != req.Version) throw new ConflictException("This work task was changed by someone else. Reload and try again.", "VERSION_CONFLICT");
        var title = CleanTitle(req.Title);
        var type = await RequireTypeAsync(req.WorkTypeId, task.WorkTypeId, ct);
        if (req.RelatedProjectId != task.RelatedProjectId) await CheckRelatedProjectAsync(req.RelatedProjectId, ct);
        var reassigned = req.AssigneeId != task.AssigneeId;
        if (reassigned) await CheckAssigneeAsync(req.AssigneeId, ct);
        CheckDates(req.StartDate, req.DueDate);
        var description = CleanDescription(req.Description);

        var key = KeyOf(task.Number);
        var was = task.Status;
        var changes = new List<string>();
        if (task.Title != title) changes.Add("title");
        if (task.WorkTypeId != type.Id) changes.Add("work type");
        if (task.RelatedProjectId != req.RelatedProjectId) changes.Add("related project");
        if (reassigned) changes.Add("assignee");
        if (task.Priority != req.Priority) changes.Add($"priority {task.Priority} → {req.Priority}");
        if (task.DueDate != req.DueDate) changes.Add($"due date {task.DueDate?.ToString("dd MMM yyyy") ?? "none"} → {req.DueDate?.ToString("dd MMM yyyy") ?? "none"}");
        if (task.StartDate != req.StartDate) changes.Add("start date");
        if (task.Description != description) changes.Add("description");

        task.Title = title; task.Description = description; task.WorkTypeId = type.Id; task.RelatedProjectId = req.RelatedProjectId;
        task.AssigneeId = req.AssigneeId; task.Priority = req.Priority; task.StartDate = req.StartDate; task.DueDate = req.DueDate;
        ApplyStatus(task, req.Status);
        task.Version++;
        task.UpdatedAt = clock.Now; task.UpdatedBy = ctx.UserId;

        if (was != task.Status) recorder.Activity("worktask.status", "WorkTask", id, $"{key}: {Label(was)} → {Label(task.Status)}", null, was.ToString(), task.Status.ToString());
        if (changes.Count > 0) recorder.Activity("worktask.updated", "WorkTask", id, $"{key}: changed {string.Join(", ", changes)}", null);
        if (reassigned) await NotifyAssignedAsync(task, ct);
        await db.SaveChangesAsync(ct);
        return await GetAsync(id, ct);
    }

    public async Task<WorkTaskDto> SetStatusAsync(Guid id, SetWorkTaskStatusRequest req, CancellationToken ct = default)
    {
        var task = await FindAsync(id, ct);
        await RequireEditAsync(task, ct);
        var was = task.Status;
        if (was != req.Status)
        {
            ApplyStatus(task, req.Status);
            task.Version++; task.UpdatedAt = clock.Now; task.UpdatedBy = ctx.UserId;
            recorder.Activity("worktask.status", "WorkTask", id, $"{KeyOf(task.Number)}: {Label(was)} → {Label(task.Status)}", null, was.ToString(), task.Status.ToString());
            await db.SaveChangesAsync(ct);
        }
        return await GetAsync(id, ct);
    }

    private void ApplyStatus(WorkTask task, WorkTaskStatus status)
    {
        if (task.Status == status) return;
        task.CompletedAt = status == WorkTaskStatus.Completed ? clock.Now : null;
        task.Status = status;
    }

    public static string Label(WorkTaskStatus s) => s switch
    {
        WorkTaskStatus.ToDo => "To Do", WorkTaskStatus.InProgress => "In Progress", WorkTaskStatus.OnHold => "On Hold",
        WorkTaskStatus.Completed => "Completed", _ => "Cancelled",
    };

    public async Task DeleteAsync(Guid id, CancellationToken ct = default)
    {
        var task = await FindAsync(id, ct);
        if (!await CanDeleteAsync(task, ct)) throw new ForbiddenException("You cannot delete this work task.", "PERMISSION_DENIED");
        task.IsDeleted = true; task.DeletedAt = clock.Now; task.DeletedBy = ctx.UserId;
        recorder.Activity("worktask.deleted", "WorkTask", id, $"Deleted work task {KeyOf(task.Number)} “{task.Title}”", null);
        await db.SaveChangesAsync(ct);
    }

    // ------------------------------------------------------------------ comments

    private async Task<Dictionary<Guid, string>> NamesAsync(IEnumerable<Guid?> ids, CancellationToken ct)
    {
        var list = ids.Where(x => x != null).Select(x => x!.Value).Distinct().ToList();
        return await db.Users.AsNoTracking().Where(u => list.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
    }

    public async Task<IReadOnlyList<WorkCommentDto>> CommentsAsync(Guid taskId, CancellationToken ct = default)
    {
        await FindAsync(taskId, ct);
        var rows = await db.WorkTaskComments.AsNoTracking().Where(c => c.WorkTaskId == taskId).OrderBy(c => c.CreatedAt).Take(500).ToListAsync(ct);
        var names = await NamesAsync(rows.Select(r => (Guid?)r.AuthorId), ct);
        var canModerate = await permissions.HasAsync(Permissions.WorkDelete, ct);
        return rows.Select(c => ToComment(c, names, canModerate)).ToList();
    }

    private WorkCommentDto ToComment(WorkTaskComment c, Dictionary<Guid, string> names, bool canModerate) =>
        new(c.Id, c.WorkTaskId, names.TryGetValue(c.AuthorId, out var n) ? new UserRefDto(c.AuthorId, n) : null, c.Body, c.CreatedAt, c.EditedAt, c.AuthorId == ctx.UserId, c.AuthorId == ctx.UserId || canModerate);

    private static string CleanBody(string? body)
    {
        var b = (body ?? "").Replace("\r\n", "\n").Trim();
        if (b.Length == 0) throw new ValidationException("body", "Write something first.");
        if (b.Length > 4000) throw new ValidationException("body", "A comment can be at most 4,000 characters.");
        return b;
    }

    public async Task<WorkCommentDto> AddCommentAsync(Guid taskId, WorkCommentRequest req, CancellationToken ct = default)
    {
        var task = await FindAsync(taskId, ct);
        if (await permissions.LevelAsync(Modules.Work, ct) < AccessLevel.Edit) throw new ForbiddenException("You cannot comment on work tasks.", "PERMISSION_DENIED");
        var c = new WorkTaskComment { TenantId = task.TenantId, WorkTaskId = taskId, AuthorId = ctx.RequireUserId(), Body = CleanBody(req.Body), CreatedAt = clock.Now, CreatedBy = ctx.UserId };
        db.WorkTaskComments.Add(c);
        recorder.Activity("worktask.comment", "WorkTask", taskId, $"Commented on {KeyOf(task.Number)}", null);
        foreach (var who in new[] { task.AssigneeId, (Guid?)task.ReporterId }.Where(x => x != null && x != ctx.UserId).Select(x => x!.Value).Distinct())
            await notifications.AddAsync(who, NotificationType.Comment, $"New comment on {KeyOf(task.Number)}: {task.Title}", c.Body.Length > 140 ? c.Body[..140] + "…" : c.Body, $"/work?task={taskId}", ct: ct);
        await db.SaveChangesAsync(ct);
        return ToComment(c, await NamesAsync([c.AuthorId], ct), await permissions.HasAsync(Permissions.WorkDelete, ct));
    }

    private async Task<WorkTaskComment> OwnCommentAsync(Guid taskId, Guid id, bool allowModerator, CancellationToken ct)
    {
        var c = await db.WorkTaskComments.FirstOrDefaultAsync(x => x.Id == id && x.WorkTaskId == taskId, ct) ?? throw new NotFoundException("Comment not found.", "COMMENT_NOT_FOUND");
        if (c.AuthorId != ctx.UserId && !(allowModerator && await permissions.HasAsync(Permissions.WorkDelete, ct)))
            throw new ForbiddenException("You can only change your own comments.", "PERMISSION_DENIED");
        return c;
    }

    public async Task<WorkCommentDto> EditCommentAsync(Guid taskId, Guid id, WorkCommentRequest req, CancellationToken ct = default)
    {
        await FindAsync(taskId, ct);
        var c = await OwnCommentAsync(taskId, id, false, ct);
        c.Body = CleanBody(req.Body); c.EditedAt = clock.Now;
        await db.SaveChangesAsync(ct);
        return ToComment(c, await NamesAsync([c.AuthorId], ct), await permissions.HasAsync(Permissions.WorkDelete, ct));
    }

    public async Task DeleteCommentAsync(Guid taskId, Guid id, CancellationToken ct = default)
    {
        await FindAsync(taskId, ct);
        var c = await OwnCommentAsync(taskId, id, true, ct);
        c.IsDeleted = true; c.DeletedAt = clock.Now; c.DeletedBy = ctx.UserId;
        await db.SaveChangesAsync(ct);
    }

    // ------------------------------------------------------------------ history

    public async Task<IReadOnlyList<WorkActivityDto>> HistoryAsync(Guid taskId, CancellationToken ct = default)
    {
        await FindAsync(taskId, ct);
        var rows = await db.Activities.AsNoTracking().Where(a => a.EntityType == "WorkTask" && a.EntityId == taskId).OrderByDescending(a => a.CreatedAt).Take(200).ToListAsync(ct);
        var names = await NamesAsync(rows.Select(r => r.ActorId), ct);
        return rows.Select(a => new WorkActivityDto(a.Id, a.Action, a.Summary, a.ActorId is { } u && names.TryGetValue(u, out var n) ? new UserRefDto(u, n) : null, a.CreatedAt)).ToList();
    }

    // ------------------------------------------------------------------ files

    public async Task<IReadOnlyList<WorkAttachmentDto>> AttachmentsAsync(Guid taskId, CancellationToken ct = default)
    {
        var task = await FindAsync(taskId, ct);
        var rows = await db.WorkTaskAttachments.AsNoTracking().Where(a => a.WorkTaskId == taskId).OrderByDescending(a => a.CreatedAt).Take(200).ToListAsync(ct);
        var names = await NamesAsync(rows.Select(r => r.CreatedBy), ct);
        var editor = await CanEditAsync(task, ct);
        return rows.Select(a => ToAttachment(a, names, editor)).ToList();
    }

    private WorkAttachmentDto ToAttachment(WorkTaskAttachment a, Dictionary<Guid, string> names, bool editor) =>
        new(a.Id, a.WorkTaskId, a.FileName, a.ContentType, a.SizeBytes, a.CreatedBy is { } u && names.TryGetValue(u, out var n) ? new UserRefDto(u, n) : null, a.CreatedAt,
            a.CreatedBy == ctx.UserId || editor, FileRules.IsImage(a.ContentType));

    public async Task<WorkAttachmentDto> UploadAsync(Guid taskId, string? fileName, Stream content, long length, CancellationToken ct = default)
    {
        var task = await FindAsync(taskId, ct);
        await RequireEditAsync(task, ct);
        if (await db.WorkTaskAttachments.CountAsync(a => a.WorkTaskId == taskId, ct) >= MaxFilesPerTask)
            throw new ValidationException("file", $"A work task can have up to {MaxFilesPerTask} files.");
        var stored = await files.StoreAsync(fileName, content, length, ct);
        var a = new WorkTaskAttachment
        {
            TenantId = task.TenantId, WorkTaskId = taskId, FileName = stored.Name, ContentType = stored.ContentType, SizeBytes = length, StorageKey = stored.Key,
            Sha256 = stored.Sha256, CreatedAt = clock.Now, CreatedBy = ctx.UserId,
        };
        db.WorkTaskAttachments.Add(a);
        recorder.Activity("worktask.attachment", "WorkTask", taskId, $"Attached “{stored.Name}” to {KeyOf(task.Number)}", null);
        try { await db.SaveChangesAsync(ct); }
        catch { await storage.DeleteAsync(stored.Key, CancellationToken.None); throw; }
        return ToAttachment(a, await NamesAsync([a.CreatedBy], ct), true);
    }

    public async Task<(WorkTaskAttachment File, Stream Content)> OpenAsync(Guid fileId, CancellationToken ct = default)
    {
        var a = await db.WorkTaskAttachments.FirstOrDefaultAsync(x => x.Id == fileId, ct) ?? throw new NotFoundException("File not found.");
        await FindAsync(a.WorkTaskId, ct);   // a deleted work task hides its files
        var stream = await storage.OpenReadAsync(a.StorageKey, ct);
        if (stream is null)
        {
            log.LogError("Work task file {Id} is missing from storage ({Key})", fileId, a.StorageKey);
            throw new NotFoundException("This file is no longer available.");
        }
        return (a, stream);
    }

    public async Task DeleteFileAsync(Guid fileId, CancellationToken ct = default)
    {
        var a = await db.WorkTaskAttachments.FirstOrDefaultAsync(x => x.Id == fileId, ct) ?? throw new NotFoundException("File not found.");
        var task = await FindAsync(a.WorkTaskId, ct);
        if (a.CreatedBy != ctx.UserId && !await CanEditAsync(task, ct)) throw new ForbiddenException("You can only remove files you uploaded.", "PERMISSION_DENIED");
        db.WorkTaskAttachments.Remove(a);
        recorder.Activity("worktask.attachment", "WorkTask", a.WorkTaskId, $"Removed “{a.FileName}” from {KeyOf(task.Number)}", null);
        await db.SaveChangesAsync(ct);
        try { await storage.DeleteAsync(a.StorageKey, ct); }
        catch (Exception ex) { log.LogWarning(ex, "Could not delete stored file {Key}", a.StorageKey); }
    }

    // ------------------------------------------------------------------ report and export

    public async Task<WorkSummaryDto> SummaryAsync(DateOnly? from, DateOnly? to, CancellationToken ct = default)
    {
        var today = clock.Today;
        var end = to ?? today; var start = from ?? end.AddDays(-29);
        if (start > end) (start, end) = (end, start);
        if (end.DayNumber - start.DayNumber > 366) start = end.AddDays(-366);
        var startAt = start.ToDateTime(TimeOnly.MinValue, DateTimeKind.Utc); var endAt = end.AddDays(1).ToDateTime(TimeOnly.MinValue, DateTimeKind.Utc);

        var rows = await db.WorkTasks.AsNoTracking()
            .Where(t => t.Status == WorkTaskStatus.ToDo || t.Status == WorkTaskStatus.InProgress || t.Status == WorkTaskStatus.OnHold
                        || (t.CreatedAt >= startAt && t.CreatedAt < endAt) || (t.CompletedAt != null && t.CompletedAt >= startAt && t.CompletedAt < endAt))
            .Select(t => new { TypeName = t.WorkType!.Name, t.RelatedProjectId, t.AssigneeId, t.Status, t.DueDate, t.CreatedAt, t.CompletedAt })
            .Take(50000).ToListAsync(ct);
        var me = ctx.UserId;
        bool Late(DateOnly? d, WorkTaskStatus s) => IsOpen(s) && d is { } x && x < today;
        bool Done(DateTime? at) => at is { } a && a >= startAt && a < endAt;
        bool Made(DateTime at) => at >= startAt && at < endAt;

        var open = rows.Where(r => IsOpen(r.Status)).ToList();
        var week = today.AddDays(7);
        var people = await NamesAsync(rows.Select(r => r.AssigneeId), ct);
        var projectIds = rows.Where(r => r.RelatedProjectId != null).Select(r => r.RelatedProjectId!.Value).Distinct().ToList();
        var projectNames = await db.Projects.AsNoTracking().Where(p => projectIds.Contains(p.Id)).ToDictionaryAsync(p => p.Id, p => p.Name, ct);

        var byType = rows.GroupBy(r => r.TypeName).Select(g => new WorkCountDto(g.Key, g.Count(r => IsOpen(r.Status)), g.Count(r => Late(r.DueDate, r.Status)), g.Count(r => Done(r.CompletedAt))))
            .Where(c => c.Open + c.Completed > 0).OrderByDescending(c => c.Open + c.Completed).ThenBy(c => c.Name).ToList();
        var byStatus = Enum.GetValues<WorkTaskStatus>().Select(s => new WorkStatusCountDto(s, rows.Count(r => r.Status == s && (IsOpen(s) || Done(r.CompletedAt) || Made(r.CreatedAt))))).ToList();
        var byPerson = rows.GroupBy(r => r.AssigneeId).Select(g => new WorkPersonCountDto(g.Key, g.Key is { } u && people.TryGetValue(u, out var n) ? n : "Unassigned",
                g.Count(r => IsOpen(r.Status)), g.Count(r => Late(r.DueDate, r.Status)), g.Count(r => Done(r.CompletedAt))))
            .Where(c => c.Open + c.Completed > 0).OrderByDescending(c => c.Open).ThenBy(c => c.Name).ToList();
        var byProject = rows.GroupBy(r => r.RelatedProjectId).Select(g => new WorkCountDto(g.Key is { } p && projectNames.TryGetValue(p, out var n) ? n : "No related project",
                g.Count(r => IsOpen(r.Status)), g.Count(r => Late(r.DueDate, r.Status)), g.Count(r => Done(r.CompletedAt))))
            .Where(c => c.Open + c.Completed > 0).OrderByDescending(c => c.Open + c.Completed).ThenBy(c => c.Name).Take(15).ToList();
        var perDay = Enumerable.Range(0, end.DayNumber - start.DayNumber + 1).Select(i => start.AddDays(i)).Select(d =>
            new WorkDayDto(d, rows.Count(r => r.CompletedAt is { } c && DateOnly.FromDateTime(c) == d), rows.Count(r => DateOnly.FromDateTime(r.CreatedAt) == d))).ToList();

        return new WorkSummaryDto(start, end, open.Count, open.Count(r => Late(r.DueDate, r.Status)), open.Count(r => r.DueDate is { } d && d >= today && d <= week), open.Count(r => r.AssigneeId == null),
            rows.Count(r => Done(r.CompletedAt)), rows.Count(r => Made(r.CreatedAt)), open.Count(r => r.AssigneeId == me), open.Count(r => r.AssigneeId == me && Late(r.DueDate, r.Status)),
            byType, byStatus, byPerson, byProject, perDay);
    }

    private static string Csv(string? v)
    {
        var s = v ?? "";
        if (s.Length > 0 && "=+-@\t\r".Contains(s[0])) s = "'" + s;   // never let a cell run as a formula in a spreadsheet
        return s.Contains(',') || s.Contains('"') || s.Contains('\n') ? "\"" + s.Replace("\"", "\"\"") + "\"" : s;
    }

    /// <summary>The filtered work tasks as CSV (UTF-8 with a byte-order mark so Excel reads it), at most 5,000 rows.</summary>
    public async Task<byte[]> ExportAsync(WorkTaskQuery query, CancellationToken ct = default)
    {
        var rows = await Sorted(Filtered(query), query.Sort).Include(t => t.WorkType).Take(MaxExport).ToListAsync(ct);
        var dtos = await ToDtosAsync(rows, ct);
        var sb = new StringBuilder("Key,Title,Work type,Related project,Assigned to,Priority,Status,Start date,Due date,Created,Completed\n");
        foreach (var t in dtos)
            sb.Append(string.Join(',', new[]
            {
                t.Key, Csv(t.Title), Csv(t.WorkType), Csv(t.RelatedProject is { } p ? $"{p.Key} {p.Name}" : ""), Csv(t.Assignee?.Name), t.Priority.ToString(), Label(t.Status),
                t.StartDate?.ToString("yyyy-MM-dd") ?? "", t.DueDate?.ToString("yyyy-MM-dd") ?? "", t.CreatedAt.ToString("yyyy-MM-dd"), t.CompletedAt?.ToString("yyyy-MM-dd") ?? "",
            })).Append('\n');
        return [.. Encoding.UTF8.GetPreamble(), .. Encoding.UTF8.GetBytes(sb.ToString())];
    }
}
