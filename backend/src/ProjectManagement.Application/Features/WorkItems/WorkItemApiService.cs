using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Issues;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.Tasks;
using ProjectManagement.Application.Features.Time;
using ProjectManagement.Application.Features.Work;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.WorkItems;

/// <summary>A row of the one Work list. <see cref="Kind"/> is task, issue, action or ticket.</summary>
public record WorkItemRowDto(string Kind, Guid Id, string Key, string Title, Guid? ProjectId, string? ProjectKey, string? ProjectName, string Status,
    StatusCategory Category, Priority Priority, DateOnly? DueDate, bool IsOverdue, UserRefDto? Assignee, string? TypeName, DateTime UpdatedAt);

public record WorkItemPageDto(IReadOnlyList<WorkItemRowDto> Items, int Offset, int Limit, bool HasMore);

/// <summary>
/// One entry of an item's activity stream. <see cref="Type"/>: comment, time (time logged), file, change (a field changed, from the
/// activity log) or ai (a change the project agent made or proposed and a person approved).
/// </summary>
public record WorkActivityItemDto(string Type, Guid Id, DateTime At, UserRefDto? Actor, string Summary, string? Body = null, int? Minutes = null,
    DateOnly? WorkDate = null, Guid? FileId = null, string? FileName = null, string? Action = null, bool? Auto = null);

/// <summary>
/// One work item of any kind with the fields every kind shares, the kind's own full record in <see cref="Detail"/> (the same shape its
/// own endpoint returns: TaskDto, IssueDto, ActionItemDto or WorkTaskDto), and one merged activity stream, newest first.
/// </summary>
public record WorkItemDetailDto(string Kind, Guid Id, string Key, string Title, string? Description, Guid? ProjectId, string? ProjectKey, string? ProjectName,
    string Status, StatusCategory Category, Priority Priority, DateOnly? StartDate, DateOnly? DueDate, bool IsOverdue, UserRefDto? Assignee, UserRefDto? Reporter,
    int Version, DateTime CreatedAt, DateTime? UpdatedAt, DateTime? CompletedAt, int LoggedMinutes, object Detail, IReadOnlyList<WorkActivityItemDto> Activity);

/// <summary>
/// + New: one request for every kind. Task: project and title (status, stage, estimate, parent, milestone, labels optional). Issue:
/// project (stage optional). Action: project. Ticket: work type (project optional, for reference).
/// </summary>
public record CreateWorkItemRequest(string? Kind, string? Title, string? Description = null, Guid? ProjectId = null, Guid? AssigneeId = null,
    Priority? Priority = null, DateOnly? StartDate = null, DateOnly? DueDate = null, Guid? StatusId = null, Guid? StageId = null, Guid? WorkTypeId = null,
    decimal? EstimatedHours = null, Guid? ParentTaskId = null, Guid? MilestoneId = null, IReadOnlyList<Guid>? LabelIds = null);

public record WorkItemCommentRequest(string? Body, IReadOnlyList<Guid>? MentionUserIds = null, Guid? ParentCommentId = null);

/// <summary>The comment, and - when it was "log 2h …" - the time it logged, or why no time was logged.</summary>
public record WorkItemCommentResultDto(WorkActivityItemDto Comment, WorkActivityItemDto? Time, string? TimeProblem);

/// <summary>
/// The one Work API (/api/v1/work-items) over every kind of work in the WorkItems table. Every write goes through the kind's own service,
/// so each kind keeps its rules (who may see, change, delete; workflow; notifications; automation); this class only translates.
/// </summary>
public class WorkItemApiService(IAppDbContext db, ICurrentContext ctx, AppClock clock, WorkItemService items, TaskService tasks, IssueService issues,
    ActionItemService actions, WorkTaskService tickets, TimeService time, PermissionService permissions)
{
    public const int MaxPage = 200;
    public const int MaxWindow = WorkItemService.MaxLimit;
    private const int MaxActivity = 300;

    public static readonly IReadOnlyDictionary<string, WorkItemKind> Kinds = new Dictionary<string, WorkItemKind>(StringComparer.OrdinalIgnoreCase)
    {
        ["task"] = WorkItemKind.Task, ["issue"] = WorkItemKind.Issue, ["action"] = WorkItemKind.ActionItem, ["ticket"] = WorkItemKind.Operational,
    };

    public static string NameOf(WorkItemKind k) => k switch
    {
        WorkItemKind.Task => "task", WorkItemKind.Issue => "issue", WorkItemKind.ActionItem => "action", _ => "ticket",
    };

    public static WorkItemKind KindOf(WorkItem w) => w switch
    {
        TaskItem => WorkItemKind.Task,
        StageIssue => WorkItemKind.Issue,
        WorkTask { Kind: WorkTaskKind.ActionItem } => WorkItemKind.ActionItem,
        _ => WorkItemKind.Operational,
    };

    public static IReadOnlyList<WorkItemKind>? ParseKinds(string? kinds)
    {
        if (string.IsNullOrWhiteSpace(kinds)) return null;
        var list = new List<WorkItemKind>();
        foreach (var part in kinds.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (Kinds.TryGetValue(part, out var k) || Enum.TryParse(part, true, out k)) list.Add(k);
            else throw new ValidationException("kind", $"Unknown kind “{part}”. Use task, issue, action or ticket.");
        }
        return list;
    }

    // ------------------------------------------------------------------ list

    /// <summary>
    /// The Work list. <paramref name="status"/>: open (default), closed (done or cancelled), all, or one of todo, active, done, cancelled.
    /// <paramref name="team"/>: a team id, or "mine" for everyone in the caller's teams. Paging is over the merged, ordered list, up to
    /// <see cref="MaxWindow"/> rows deep (narrow by kind, project or person to go further).
    /// </summary>
    public async Task<WorkItemPageDto> ListAsync(string? kind, bool mine, string? team, Guid? assigneeId, Guid? projectId, string? status, bool overdue,
        string? q, int offset, int limit, CancellationToken ct = default)
    {
        ctx.RequireTenantId();
        limit = Math.Clamp(limit <= 0 ? 50 : limit, 1, MaxPage);
        if (offset < 0) throw new ValidationException("offset", "The offset cannot be negative.");
        if (offset + limit > MaxWindow) throw new AppException(400, "INVALID_PAGE", $"Only the first {MaxWindow} items can be paged through; narrow the list by kind, project or person.");
        var category = ParseStatus(status);
        IReadOnlyCollection<Guid>? people = null;
        if (!string.IsNullOrWhiteSpace(team))
        {
            var me = ctx.RequireUserId();
            IQueryable<TeamMember> members = db.TeamMembers.AsNoTracking();
            if (string.Equals(team, "mine", StringComparison.OrdinalIgnoreCase)) members = members.Where(m => db.TeamMembers.Any(x => x.TeamId == m.TeamId && x.UserId == me));
            else if (Guid.TryParse(team, out var teamId)) members = members.Where(m => m.TeamId == teamId);
            else throw new ValidationException("team", "Give a team id, or \"mine\".");
            people = await members.Select(m => m.UserId).Distinct().ToListAsync(ct);
            if (people.Count == 0) return new WorkItemPageDto([], offset, limit, false);
        }
        var rows = await items.ListAsync(new WorkItemQuery(ParseKinds(kind), AssigneeId: assigneeId, Mine: mine, OpenOnly: category is null, ProjectId: projectId,
            Overdue: overdue, Q: q, Limit: offset + limit + 1, AssigneeIds: people), ct: ct);
        IEnumerable<WorkItemDto> filtered = rows;
        if (category is { Length: > 0 } cats) filtered = filtered.Where(r => cats.Contains(r.Category));
        var list = filtered.ToList();
        var page = list.Skip(offset).Take(limit).Select(ToRow).ToList();
        return new WorkItemPageDto(page, offset, limit, list.Count > offset + limit);
    }

    /// <summary>Null = open only; otherwise the categories to keep (empty = all).</summary>
    private static StatusCategory[]? ParseStatus(string? status) => (status ?? "open").Trim().ToLowerInvariant() switch
    {
        "" or "open" => null,
        "all" => [],
        "closed" => [StatusCategory.Done, StatusCategory.Cancelled],
        "todo" => [StatusCategory.Todo],
        "active" or "in_progress" or "inprogress" => [StatusCategory.Active],
        "done" => [StatusCategory.Done],
        "cancelled" => [StatusCategory.Cancelled],
        var s => throw new ValidationException("status", $"Unknown status “{s}”. Use open, closed, all, todo, active, done or cancelled."),
    };

    private static WorkItemRowDto ToRow(WorkItemDto r) => new(NameOf(r.Kind), r.Id, r.Key, r.Title, r.ProjectId, r.ProjectKey, r.ProjectName, r.Status, r.Category,
        r.Priority, r.DueDate, r.IsOverdue, r.Assignee, r.TypeName, r.UpdatedAt);

    // ------------------------------------------------------------------ one item

    /// <summary>
    /// The module gates each kind's own endpoints have (their controllers' RequireModule): tasks need Tasks; issues Projects and Tasks;
    /// action items Projects; tickets Work, at Edit for any change. The kind's service then applies its own finer rules.
    /// </summary>
    private async Task RequireModulesAsync(WorkItemKind kind, bool write, CancellationToken ct)
    {
        switch (kind)
        {
            case WorkItemKind.Task:
                await permissions.RequireModuleAsync(Modules.Tasks, AccessLevel.View, ct);
                break;
            case WorkItemKind.Issue:
                await permissions.RequireModuleAsync(Modules.Projects, AccessLevel.View, ct);
                await permissions.RequireModuleAsync(Modules.Tasks, AccessLevel.View, ct);
                break;
            case WorkItemKind.ActionItem:
                await permissions.RequireModuleAsync(Modules.Projects, AccessLevel.View, ct);
                break;
            default:
                await permissions.RequireModuleAsync(Modules.Work, write ? AccessLevel.Edit : AccessLevel.View, ct);
                break;
        }
    }

    /// <summary>The item, when the caller may see it at all (tenant, not deleted, a reachable project); the kind's own service then decides.</summary>
    private async Task<WorkItem> FindAsync(Guid id, bool write, CancellationToken ct)
    {
        ctx.RequireTenantId();
        var item = await db.WorkItems.AsNoTracking().FirstOrDefaultAsync(w => w.Id == id, ct)
            ?? throw new NotFoundException("Work item not found.", "WORK_ITEM_NOT_FOUND");
        await RequireModulesAsync(KindOf(item), write, ct);
        return item;
    }

    public async Task<WorkItemDetailDto> GetAsync(Guid id, CancellationToken ct = default)
    {
        var item = await FindAsync(id, false, ct);
        var today = clock.Today;
        WorkItemDetailDto dto;
        switch (item)
        {
            case TaskItem:
            {
                var t = (await tasks.GetAsync(id, ct)).Task;
                dto = new WorkItemDetailDto("task", t.Id, t.Key, t.Title, t.Description, t.ProjectId, t.ProjectKey, t.ProjectName, t.StatusName, t.StatusCategory,
                    t.Priority, t.StartDate, t.DueDate, t.IsOverdue, t.Assignee, t.Reporter, t.Version, t.CreatedAt, t.UpdatedAt, t.CompletedAt, 0, t, []);
                break;
            }
            case StageIssue si:
            {
                var i = (await issues.GetAsync(si.ProjectId, id, ct)).Issue;
                var p = await ProjectRefAsync(si.ProjectId, ct);
                dto = new WorkItemDetailDto("issue", i.Id, i.Key, i.Title, i.Details, i.ProjectId, p?.Key, p?.Name, WorkItemService.LabelOf(i.Status),
                    WorkItemService.CategoryOf(i.Status), i.Severity, si.StartDate, si.DueDate, false, i.Assignee, i.Reporter, si.Version, i.CreatedAt, si.UpdatedAt,
                    i.ResolvedAt, 0, i, []);
                break;
            }
            case WorkTask { Kind: WorkTaskKind.ActionItem } wa:
            {
                var a = await ActionAsync(wa, ct);
                var p = await ProjectRefAsync(a.ProjectId, ct);
                var cat = WorkItemService.CategoryOf(wa.Status);
                dto = new WorkItemDetailDto("action", a.Id, a.Key, a.Title, a.Details, a.ProjectId, p?.Key, p?.Name, WorkItemService.ActionLabel(wa.Status), cat,
                    a.Priority, wa.StartDate, a.DueDate, a.IsOverdue, a.Assignee, a.CreatedBy, wa.Version, a.CreatedAt, wa.UpdatedAt, a.CompletedAt, 0, a, []);
                break;
            }
            default:
            {
                var w = await tickets.GetAsync(id, ct);
                var cat = WorkItemService.CategoryOf(w.Status);
                dto = new WorkItemDetailDto("ticket", w.Id, w.Key, w.Title, w.Description, w.RelatedProject?.Id, w.RelatedProject?.Key, w.RelatedProject?.Name,
                    WorkItemService.WorkLabel(w.Status), cat, w.Priority, w.StartDate, w.DueDate, w.IsOverdue, w.Assignee, w.Reporter, w.Version, w.CreatedAt,
                    item.UpdatedAt, w.CompletedAt, w.LoggedMinutes, w, []);
                break;
            }
        }
        var activity = await ActivityAsync(item, ct);
        var logged = activity.Where(a => a.Type == "time").Sum(a => a.Minutes ?? 0);
        return dto with { Activity = activity, LoggedMinutes = logged, IsOverdue = dto.IsOverdue || (dto.DueDate is { } d && d < today && dto.Category is StatusCategory.Todo or StatusCategory.Active) };
    }

    private async Task<(string Key, string Name)?> ProjectRefAsync(Guid? projectId, CancellationToken ct)
    {
        if (projectId is not { } pid) return null;
        var p = await db.Projects.AsNoTracking().Where(x => x.Id == pid).Select(x => new { x.Key, x.Name }).FirstOrDefaultAsync(ct);
        return p is null ? null : (p.Key, p.Name);
    }

    /// <summary>The action item through its own service (which checks the caller may see its project).</summary>
    private async Task<ActionItemDto> ActionAsync(WorkTask w, CancellationToken ct)
    {
        if (w.RelatedProjectId is not { } pid) throw new NotFoundException("Work item not found.", "WORK_ITEM_NOT_FOUND");
        return (await actions.ListAsync(pid, ct)).FirstOrDefault(a => a.Id == w.Id) ?? throw new NotFoundException("Work item not found.", "WORK_ITEM_NOT_FOUND");
    }

    /// <summary>Comments, time, files, field changes and the agent's applied changes, newest first. The caller has already been allowed to see the item.</summary>
    private async Task<IReadOnlyList<WorkActivityItemDto>> ActivityAsync(WorkItem item, CancellationToken ct)
    {
        var id = item.Id;
        var rows = new List<WorkActivityItemDto>();

        // comments
        var comments = item switch
        {
            TaskItem => await db.TaskComments.AsNoTracking().Where(c => c.TaskId == id).Select(c => new { c.Id, c.AuthorId, c.Body, c.CreatedAt }).ToListAsync(ct),
            StageIssue => await db.IssueComments.AsNoTracking().Where(c => c.IssueId == id).Select(c => new { c.Id, c.AuthorId, c.Body, c.CreatedAt }).ToListAsync(ct),
            _ => await db.WorkTaskComments.AsNoTracking().Where(c => c.WorkTaskId == id).Select(c => new { c.Id, c.AuthorId, c.Body, c.CreatedAt }).ToListAsync(ct),
        };
        rows.AddRange(comments.Select(c => new WorkActivityItemDto("comment", c.Id, c.CreatedAt, Ref(c.AuthorId), "commented", c.Body)));

        // time
        var isTask = item is TaskItem;
        if (item is TaskItem or WorkTask)
        {
            var entries = await db.TimeEntries.AsNoTracking().Where(e => isTask ? e.TaskId == id : e.WorkTaskId == id)
                .Select(e => new { e.Id, e.UserId, e.Minutes, e.Note, e.WorkDate, e.CreatedAt, e.EndedAt, e.StartedAt }).ToListAsync(ct);
            rows.AddRange(entries.Where(e => e.StartedAt is null || e.EndedAt is not null)
                .Select(e => new WorkActivityItemDto("time", e.Id, e.CreatedAt, Ref(e.UserId), $"logged {TimeText(e.Minutes)}", e.Note, e.Minutes, e.WorkDate)));
        }

        // files
        if (item is WorkTask)
        {
            var files = await db.WorkTaskAttachments.AsNoTracking().Where(f => f.WorkTaskId == id).Select(f => new { f.Id, f.FileName, f.CreatedAt, f.CreatedBy }).ToListAsync(ct);
            rows.AddRange(files.Select(f => new WorkActivityItemDto("file", f.Id, f.CreatedAt, f.CreatedBy is { } u ? Ref(u) : null, $"added {f.FileName}", FileId: f.Id, FileName: f.FileName)));
        }
        else
        {
            var files = await db.Attachments.AsNoTracking().Where(f => isTask ? f.TaskId == id : f.IssueId == id)
                .Select(f => new { f.Id, f.FileName, f.CreatedAt, f.CreatedBy }).ToListAsync(ct);
            rows.AddRange(files.Select(f => new WorkActivityItemDto("file", f.Id, f.CreatedAt, f.CreatedBy is { } u ? Ref(u) : null, $"added {f.FileName}", FileId: f.Id, FileName: f.FileName)));
        }
        if (item is StageIssue)
        {
            // An issue's history is its event list (raised, assigned, moved, with the note given).
            var events = await db.StageIssueEvents.AsNoTracking().Where(e => e.IssueId == id).OrderByDescending(e => e.CreatedAt).Take(MaxActivity)
                .Select(e => new { e.Id, e.Kind, e.FromStatus, e.ToStatus, e.Note, e.ActorId, e.CreatedAt }).ToListAsync(ct);
            rows.AddRange(events.Select(e => new WorkActivityItemDto("change", e.Id, e.CreatedAt, e.ActorId is { } u ? Ref(u) : null,
                e.ToStatus is { } to ? $"{e.Kind}: {(e.FromStatus is { } f ? WorkItemService.LabelOf(f) + " → " : "")}{WorkItemService.LabelOf(to)}" : e.Kind, e.Note, Action: "issue." + e.Kind)));
        }

        // field changes from the activity log (comments, time and files are already listed above)
        var changes = await db.Activities.AsNoTracking().Where(a => a.EntityId == id).OrderByDescending(a => a.CreatedAt).Take(MaxActivity)
            .Select(a => new { a.Id, a.Action, a.Summary, a.ActorId, a.CreatedAt }).ToListAsync(ct);
        rows.AddRange(changes.Where(a => !Regex.IsMatch(a.Action, "comment|time_logged|timer|attach|file", RegexOptions.IgnoreCase) && !(item is StageIssue && a.Action.StartsWith("issue.")))
            .Select(a => new WorkActivityItemDto("change", a.Id, a.CreatedAt, a.ActorId is { } u ? Ref(u) : null, a.Summary, Action: a.Action)));

        // the project agent's changes, approved by a person or carried out by the agent itself
        var ai = await db.AgentFindings.AsNoTracking()
            .Where(f => f.Status == AgentFindingStatus.Applied && (f.AppliedEntityId == id || f.TaskId == id || f.IssueId == id))
            .Select(f => new { f.Id, f.Kind, f.Title, f.DecidedBy, f.DecidedAt, f.CreatedAt, f.AutoApplied, f.Before }).ToListAsync(ct);
        rows.AddRange(ai.Select(f => new WorkActivityItemDto("ai", f.Id, f.DecidedAt ?? f.CreatedAt, f.DecidedBy is { } u ? Ref(u) : null, f.Title,
            f.Before is null ? null : "Before: " + f.Before, Action: f.Kind.ToString(), Auto: f.AutoApplied)));

        var ordered = rows.OrderByDescending(r => r.At).ThenBy(r => r.Id).Take(MaxActivity).ToList();
        return await NameAsync(ordered, ct);

        static UserRefDto Ref(Guid u) => new(u, "");
    }

    private async Task<IReadOnlyList<WorkActivityItemDto>> NameAsync(List<WorkActivityItemDto> rows, CancellationToken ct)
    {
        var ids = rows.Where(r => r.Actor is not null).Select(r => r.Actor!.Id).Distinct().ToList();
        if (ids.Count == 0) return rows;
        var names = await db.Users.AsNoTracking().Where(u => ids.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        return rows.Select(r => r.Actor is { } a ? r with { Actor = new UserRefDto(a.Id, names.GetValueOrDefault(a.Id, "")) } : r).ToList();
    }

    private static string TimeText(int minutes) => minutes % 60 == 0 ? $"{minutes / 60}h" : minutes < 60 ? $"{minutes}m" : $"{minutes / 60}h {minutes % 60}m";

    // ------------------------------------------------------------------ create

    public async Task<WorkItemDetailDto> CreateAsync(CreateWorkItemRequest req, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(req.Kind) || !Kinds.TryGetValue(req.Kind.Trim(), out var kind))
            throw new ValidationException("kind", "Say what to create: task, issue, action or ticket.");
        await RequireModulesAsync(kind, true, ct);
        if (kind == WorkItemKind.Task) await permissions.RequireModuleAsync(Modules.Projects, AccessLevel.View, ct);   // tasks are added on a project
        Guid id;
        switch (kind)
        {
            case WorkItemKind.Task:
                id = (await tasks.CreateAsync(RequireProject(req.ProjectId), new CreateTaskRequest(req.Title ?? "", req.Description, req.StatusId, req.Priority ?? Priority.Medium,
                    req.AssigneeId, req.StartDate, req.DueDate, req.EstimatedHours, req.LabelIds, req.ParentTaskId, req.MilestoneId, req.StageId), ct)).Id;
                break;
            case WorkItemKind.Issue:
                id = (await issues.CreateAsync(RequireProject(req.ProjectId), new CreateIssueRequest(req.StageId, req.Title, req.Description, req.Priority, req.AssigneeId), ct)).Issue.Id;
                break;
            case WorkItemKind.ActionItem:
                id = (await actions.CreateAsync(RequireProject(req.ProjectId), new CreateActionItemRequest(req.Title, req.Description, req.AssigneeId, req.DueDate, req.Priority), ct)).Id;
                break;
            default:
                id = (await tickets.CreateAsync(new CreateWorkTaskRequest(req.Title, req.Description, req.WorkTypeId, req.ProjectId, req.AssigneeId, req.Priority, null,
                    req.StartDate, req.DueDate), ct)).Id;
                break;
        }
        return await GetAsync(id, ct);
    }

    private static Guid RequireProject(Guid? projectId) =>
        projectId ?? throw new ValidationException("projectId", "Choose the project it belongs to.");

    // ------------------------------------------------------------------ update

    /// <summary>
    /// Changes any of the fields sent (a field sent as null clears it); fields not sent stay as they are. <c>version</c> is required: the
    /// version the caller last read; if someone saved in between, nothing is changed and 409 VERSION_CONFLICT comes back.
    /// Fields: title, description, assigneeId, priority, status (the kind's own status name; for a task the name of a column of its
    /// project, or statusId), startDate, dueDate, stageId, workTypeId, projectId (tickets: the related project), estimatedHours,
    /// actualHours, milestoneId.
    /// </summary>
    public async Task<WorkItemDetailDto> PatchAsync(Guid id, JsonElement body, CancellationToken ct = default)
    {
        if (body.ValueKind != JsonValueKind.Object) throw new ValidationException("body", "Send the fields to change as a JSON object.");
        var p = new Patch(body);
        var version = p.Int("version") ?? throw new ValidationException("version", "Send the version you last read.");
        var item = await FindAsync(id, true, ct);
        switch (item)
        {
            case TaskItem:
            {
                var d = await tasks.GetAsync(id, ct);
                var t = d.Task;
                var statusId = p.Uuid("statusId") ?? t.StatusId;
                if (p.Has("status") && p.Text("status") is { Length: > 0 } statusName)
                {
                    var lower = statusName.Trim().ToLowerInvariant();
                    statusId = await db.WorkflowStatuses.AsNoTracking().Where(s => s.ProjectId == t.ProjectId && s.Name.ToLower() == lower).Select(s => (Guid?)s.Id).FirstOrDefaultAsync(ct)
                        ?? throw new ValidationException("status", $"The project has no column “{statusName}”.");
                }
                await tasks.UpdateAsync(id, new UpdateTaskRequest(
                    p.Has("title") ? p.Text("title") ?? "" : t.Title,
                    p.Has("description") ? p.Text("description") : t.Description,
                    statusId,
                    p.Has("priority") ? p.Choice<Priority>("priority") ?? t.Priority : t.Priority,
                    p.Has("assigneeId") ? p.Uuid("assigneeId") : t.Assignee?.Id,
                    p.Has("startDate") ? p.Day("startDate") : t.StartDate,
                    p.Has("dueDate") ? p.Day("dueDate") : t.DueDate,
                    p.Has("estimatedHours") ? p.Number("estimatedHours") : t.EstimatedHours,
                    p.Has("actualHours") ? p.Number("actualHours") : t.ActualHours,
                    t.Labels.Select(l => l.Id).ToList(),
                    version,
                    p.Has("milestoneId") ? p.Uuid("milestoneId") : t.MilestoneId,
                    p.Has("stageId") ? p.Uuid("stageId") : t.StageId,
                    p.Text("dueDateReason"), p.Text("dueDateDependency")), ct);
                break;
            }
            case StageIssue si:
            {
                if (si.Version != version) throw Conflict();
                var changed = false;
                if (p.Has("title") || p.Has("description") || p.Has("details") || p.Has("priority") || p.Has("severity") || p.Has("stageId"))
                {
                    var current = (await issues.GetAsync(si.ProjectId, id, ct)).Issue;
                    var details = p.Has("description") ? p.Text("description") : p.Has("details") ? p.Text("details") : current.Details;
                    var severity = p.Has("priority") ? p.Choice<Priority>("priority") : p.Has("severity") ? p.Choice<Priority>("severity") : current.Severity;
                    await issues.UpdateAsync(si.ProjectId, id, new UpdateIssueRequest(p.Has("title") ? p.Text("title") : current.Title, details,
                        severity ?? current.Severity, p.Has("stageId") ? p.Uuid("stageId") : current.StageId), ct);
                    changed = true;
                }
                if (p.Has("assigneeId")) { await issues.AssignAsync(si.ProjectId, id, new AssignIssueRequest(p.Uuid("assigneeId")), ct); changed = true; }
                if (p.Has("status"))
                {
                    var to = p.Choice<IssueStatus>("status") ?? throw new ValidationException("status", "Give a status: Observed, InProgress, Fixed or Resolved.");
                    var current = (await issues.GetAsync(si.ProjectId, id, ct)).Issue;
                    if (current.Status != to) { await issues.ChangeStatusAsync(si.ProjectId, id, new ChangeIssueStatusRequest(to, p.Text("note")), ct); changed = true; }
                }
                if (p.Has("startDate") || p.Has("dueDate"))
                {
                    // Issues had no dates before WorkItems; the shared columns hold them. Only people who may edit the issue may set them.
                    var current = (await issues.GetAsync(si.ProjectId, id, ct)).Issue;
                    if (!current.Can.Edit) throw new ForbiddenException("You cannot change this issue.", "PERMISSION_DENIED");
                    var row = await db.StageIssues.FirstAsync(x => x.Id == id, ct);
                    if (p.Has("startDate")) row.StartDate = p.Day("startDate");
                    if (p.Has("dueDate")) row.DueDate = p.Day("dueDate");
                    row.UpdatedAt = clock.Now; row.UpdatedBy = ctx.UserId;
                    await db.SaveChangesAsync(ct);
                    changed = true;
                }
                if (changed)
                {
                    var n = await db.StageIssues.Where(x => x.Id == id && x.Version == version).ExecuteUpdateAsync(s => s.SetProperty(x => x.Version, x => x.Version + 1), ct);
                    if (n == 0) throw Conflict();
                }
                break;
            }
            case WorkTask { Kind: WorkTaskKind.ActionItem } wa:
            {
                if (wa.Version != version) throw Conflict();
                var a = await ActionAsync(wa, ct);
                var status = a.Status;
                if (p.Has("status")) status = p.Choice<ActionItemStatus>("status") ?? throw new ValidationException("status", "Give a status: Open, InProgress or Completed.");
                await actions.UpdateAsync(a.ProjectId, id, new UpdateActionItemRequest(
                    p.Has("title") ? p.Text("title") : a.Title,
                    p.Has("description") ? p.Text("description") : p.Has("details") ? p.Text("details") : a.Details,
                    p.Has("assigneeId") ? p.Uuid("assigneeId") : a.Assignee?.Id,
                    p.Has("dueDate") ? p.Day("dueDate") : a.DueDate,
                    p.Has("priority") ? p.Choice<Priority>("priority") ?? a.Priority : a.Priority,
                    status), ct);
                break;
            }
            default:
            {
                var w = await tickets.GetAsync(id, ct);
                await tickets.UpdateAsync(id, new UpdateWorkTaskRequest(
                    p.Has("title") ? p.Text("title") : w.Title,
                    p.Has("description") ? p.Text("description") : w.Description,
                    p.Has("workTypeId") ? p.Uuid("workTypeId") : w.WorkTypeId,
                    p.Has("projectId") ? p.Uuid("projectId") : p.Has("relatedProjectId") ? p.Uuid("relatedProjectId") : w.RelatedProject?.Id,
                    p.Has("assigneeId") ? p.Uuid("assigneeId") : w.Assignee?.Id,
                    p.Has("priority") ? p.Choice<Priority>("priority") ?? w.Priority : w.Priority,
                    p.Has("status") ? p.Choice<WorkTaskStatus>("status") ?? w.Status : w.Status,
                    p.Has("startDate") ? p.Day("startDate") : w.StartDate,
                    p.Has("dueDate") ? p.Day("dueDate") : w.DueDate,
                    version), ct);
                break;
            }
        }
        return await GetAsync(id, ct);
    }

    private static ConflictException Conflict() =>
        new("Someone else changed this item since you opened it. Reload it to see their change.", "VERSION_CONFLICT");

    /// <summary>The fields present in a PATCH body (a field sent as null is present, and clears the value).</summary>
    private sealed class Patch(JsonElement body)
    {
        private readonly Dictionary<string, JsonElement> _fields = body.EnumerateObject().ToDictionary(x => x.Name, x => x.Value, StringComparer.OrdinalIgnoreCase);

        public bool Has(string name) => _fields.ContainsKey(name);

        private JsonElement? Get(string name) => _fields.TryGetValue(name, out var v) && v.ValueKind is not (JsonValueKind.Null or JsonValueKind.Undefined) ? v : null;

        public string? Text(string name) => Get(name) is { } v ? v.ValueKind == JsonValueKind.String ? v.GetString() : v.GetRawText() : null;

        public int? Int(string name) => Get(name) is { } v
            ? v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var n) ? n : int.TryParse(v.ValueKind == JsonValueKind.String ? v.GetString() : null, out var s) ? s : throw Bad(name)
            : null;

        public decimal? Number(string name) => Get(name) is { } v
            ? v.ValueKind == JsonValueKind.Number && v.TryGetDecimal(out var n) ? n : throw Bad(name)
            : null;

        public System.Guid? Uuid(string name) => Get(name) is { } v
            ? v.ValueKind == JsonValueKind.String && System.Guid.TryParse(v.GetString(), out var g) ? g : throw Bad(name)
            : null;

        public DateOnly? Day(string name) => Get(name) is { } v
            ? v.ValueKind == JsonValueKind.String && DateOnly.TryParse(v.GetString(), System.Globalization.CultureInfo.InvariantCulture, out var d) ? d : throw Bad(name)
            : null;

        public T? Choice<T>(string name) where T : struct, System.Enum => Get(name) is { } v
            ? v.ValueKind == JsonValueKind.String && System.Enum.TryParse<T>(v.GetString()!.Replace(" ", "").Replace("_", ""), true, out var e) && System.Enum.IsDefined(e) ? e
              : v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var i) && System.Enum.IsDefined(typeof(T), i) ? (T)(object)i : throw Bad(name)
            : null;

        private static ValidationException Bad(string name) => new(name, $"“{name}” has a value that cannot be used here.");
    }

    // ------------------------------------------------------------------ comments

    private static readonly Regex LogCommand = new(@"^\s*/?log\s+(?<what>.+)$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    /// <summary>
    /// Adds a comment. A comment that starts with "log" ("log 2h", "log 1h 30m yesterday fixing the export") also logs that time on the
    /// item, as the caller, through the time service (so timesheet locks and limits apply); if the time cannot be logged the comment is
    /// still added and <see cref="WorkItemCommentResultDto.TimeProblem"/> says why.
    /// </summary>
    public async Task<WorkItemCommentResultDto> CommentAsync(Guid id, WorkItemCommentRequest req, CancellationToken ct = default)
    {
        var body = req.Body?.Replace("\r\n", "\n").Trim();
        if (string.IsNullOrEmpty(body)) throw new ValidationException("body", "Write something first.");
        if (body.Length > 4000) throw new ValidationException("body", "A comment can be at most 4,000 characters.");
        var item = await FindAsync(id, true, ct);
        var me = ctx.RequireUserId();
        WorkActivityItemDto comment;
        switch (item)
        {
            case TaskItem:
            {
                var c = await tasks.AddCommentAsync(id, new CreateCommentRequest(body, req.ParentCommentId, req.MentionUserIds), ct);
                comment = new WorkActivityItemDto("comment", c.Id, c.CreatedAt, c.Author, "commented", c.Body);
                break;
            }
            case StageIssue si:
            {
                await issues.RequireVisibleAsync(si.ProjectId, id, ct);
                var c = new IssueComment { TenantId = si.TenantId, IssueId = id, AuthorId = me, Body = body, CreatedAt = clock.Now, CreatedBy = me };
                db.IssueComments.Add(c);
                await db.SaveChangesAsync(ct);
                comment = new WorkActivityItemDto("comment", c.Id, c.CreatedAt, new UserRefDto(me, ""), "commented", c.Body);
                break;
            }
            case WorkTask { Kind: WorkTaskKind.ActionItem } wa:
            {
                await ActionAsync(wa, ct);
                var c = new WorkTaskComment { TenantId = wa.TenantId, WorkTaskId = id, AuthorId = me, Body = body, CreatedAt = clock.Now, CreatedBy = me };
                db.WorkTaskComments.Add(c);
                await db.SaveChangesAsync(ct);
                comment = new WorkActivityItemDto("comment", c.Id, c.CreatedAt, new UserRefDto(me, ""), "commented", c.Body);
                break;
            }
            default:
            {
                var c = await tickets.AddCommentAsync(id, new WorkCommentRequest(body, req.MentionUserIds), ct);
                comment = new WorkActivityItemDto("comment", c.Id, c.CreatedAt, c.Author, "commented", c.Body);
                break;
            }
        }

        WorkActivityItemDto? logged = null;
        string? problem = null;
        if (LogCommand.Match(body.Split('\n')[0]) is { Success: true } m)
        {
            var piece = TimeWords.Parse(m.Groups["what"].Value, clock.Today, 8 * 60).FirstOrDefault();
            if (piece is null || piece.Minutes <= 0) problem = "How long? Write it like “log 2h” or “log 1h 30m”.";
            else if (piece.Problem is not null) problem = piece.Problem;
            else if (item is not TaskItem && item is not WorkTask { Kind: WorkTaskKind.Operational }) problem = item is StageIssue
                ? "Time is logged on tasks and tickets, not on issues."
                : "Time is logged on tasks and tickets, not on action items.";
            else
            {
                var request = new LogTimeRequest(piece.Minutes, piece.Date, string.IsNullOrWhiteSpace(piece.Rest) ? null : piece.Rest);
                try
                {
                    // The same gate as the time endpoints: Tasks or Work at Edit.
                    await permissions.RequireModuleAsync(item is TaskItem ? Modules.Tasks : Modules.Work, AccessLevel.Edit, ct);
                    var e = item is TaskItem ? await time.LogAsync(id, request, ct) : await time.LogOnWorkTaskAsync(id, request, ct);
                    logged = new WorkActivityItemDto("time", e.Id, clock.Now, e.User, $"logged {TimeText(e.Minutes)}", e.Note, e.Minutes, e.WorkDate);
                }
                catch (AppException ex) { problem = ex.Message; }
            }
        }
        var named = await NameAsync([comment], ct);
        return new WorkItemCommentResultDto(named[0], logged, problem);
    }

    // ------------------------------------------------------------------ delete

    public async Task DeleteAsync(Guid id, CancellationToken ct = default)
    {
        var item = await FindAsync(id, true, ct);
        switch (item)
        {
            case TaskItem: await tasks.DeleteAsync(id, ct); break;
            case StageIssue si: await issues.DeleteAsync(si.ProjectId, id, ct); break;
            case WorkTask { Kind: WorkTaskKind.ActionItem } wa: await actions.DeleteAsync(wa.RelatedProjectId!.Value, id, ct); break;
            default: await tickets.DeleteAsync(id, ct); break;
        }
    }
}
