using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Projects;

// ---- the sidebar: projects under their groups
public record StatusProjectRefDto(Guid Id, string Key, string Name, ProjectStatus Status, ProjectHealth Health, int Progress, int Active = 0);
public record StatusGroupDto(Guid Id, string Name, bool IsActive, int Count, IReadOnlyList<StatusProjectRefDto> Projects);

// ---- one project's status
public record StatusBlockerDto(string Key, string Title, string StatusName);
public record StatusTaskDto(Guid Id, string Key, string Title, Guid? ParentTaskId, DateOnly? StartDate, DateOnly? DueDate, DateOnly? OriginalDueDate, int DelayedDays,
    string StatusName, StatusCategory StatusCategory, string StatusColor, UserRefDto? Assignee, int OverdueDays, int Revisions, IReadOnlyList<StatusBlockerDto> BlockedBy);
/// <summary>A change of a delivery date: the project's own (Scope "Project") or a task's (Scope "Task"), with everything management asks about it.</summary>
public record TimelineChangeDto(Guid Id, string Scope, Guid? TaskId, string? TaskKey, string Title, DateOnly? Previous, DateOnly? Revised, int? DaysShifted,
    string? Reason, string? Dependency, UserRefDto? ChangedBy, DateTime ChangedAt, string CurrentStatus, StatusCategory? CurrentCategory);
public record StatusProjectDto(Guid Id, string Key, string Name, string? Description, string? GroupName, DateOnly? StartDate, DateOnly? DueDate, DateOnly? OriginalDueDate,
    int DelayedDays, ProjectStatus Status, ProjectHealth Health, int Progress, UserRefDto? Owner, ProjectStatsDto Stats, ProjectType ProjectType = ProjectType.Other);
public record ProjectStatusReportDto(StatusProjectDto Project, IReadOnlyList<StatusTaskDto> Tasks, IReadOnlyList<TimelineChangeDto> Changes, int DelayedTasks, int BlockedTasks);

/// <summary>
/// Feeds the Project Status presentation page: the projects organized by group, and for one project its tasks, its delivery-date history
/// (who moved a date, when, from what to what, why and what it depended on) and what is currently blocking work.
/// </summary>
public class ProjectStatusService(IAppDbContext db, ICurrentContext ctx, AppClock clock, ProjectAccess access, ProjectService projects, PermissionService permissions, ProjectGroupService groupService)
{
    private const int MaxTasks = 500, MaxChanges = 200;
    private sealed record Row(Guid Id, int Number, string Title, Guid? ParentTaskId, DateOnly? StartDate, DateOnly? DueDate, string StatusName, StatusCategory Category, string Color, Guid? AssigneeId, string? AssigneeName);

    // ------------------------------------------------------------------ the sidebar

    public async Task<IReadOnlyList<StatusGroupDto>> GroupsAsync(CancellationToken ct = default)
    {
        ctx.RequireTenantId();
        await permissions.RequireModuleAsync(Modules.Projects, AccessLevel.View, ct);
        await groupService.EnsureDefaultAsync(ct);
        var groups = await db.ProjectGroups.AsNoTracking().OrderBy(g => g.Order).ThenBy(g => g.Name).ToListAsync(ct);
        var rows = await access.VisibleProjects().AsNoTracking().Where(p => p.Status != ProjectStatus.Archived).OrderBy(p => p.Name).ToListAsync(ct);
        var stats = await projects.GetStatsAsync(rows.Select(r => r.Id).ToList(), ct);

        StatusProjectRefDto Ref(Project p) => new(p.Id, p.Key, p.Name, p.Status, ProjectMetrics.Health(p, stats[p.Id], clock.Today), ProjectMetrics.Progress(stats[p.Id]), ProjectMetrics.ActiveShare(stats[p.Id]));
        var result = new List<StatusGroupDto>();
        foreach (var g in groups)
        {
            var mine = rows.Where(p => p.ProjectGroupId == g.Id).Select(Ref).ToList();
            if (mine.Count > 0) result.Add(new StatusGroupDto(g.Id, g.Name, g.IsActive, mine.Count, mine));   // a group with nothing to show stays out of the way
        }
        return result;
    }

    // ------------------------------------------------------------------ one project

    public async Task<ProjectStatusReportDto> ReportAsync(Guid projectId, CancellationToken ct = default)
    {
        await permissions.RequireModuleAsync(Modules.Projects, AccessLevel.View, ct);
        var project = await access.GetProjectAsync(projectId, ct);
        var today = clock.Today;
        var seesTasks = await permissions.LevelAsync(Modules.Tasks, ct) > 0;

        var rows = seesTasks
            ? await access.VisibleTasks().AsNoTracking().Where(t => t.ProjectId == projectId)
                .Select(t => new Row(t.Id, t.Number, t.Title, t.ParentTaskId, t.StartDate, t.DueDate, t.Status!.Name, t.Status.Category, t.Status.Color, t.AssigneeId, t.Assignee!.DisplayName))
                .Take(MaxTasks).ToListAsync(ct)
            : [];
        var taskIds = rows.Select(r => r.Id).ToList();
        var keyOf = rows.ToDictionary(r => r.Id, r => $"{project.Key}-{r.Number}");
        var taskInfo = rows.ToDictionary(r => r.Id);

        // The history of every date in this project, oldest first.
        var history = await db.DueDateChanges.AsNoTracking().Where(c => c.ProjectId == projectId).OrderBy(c => c.CreatedAt).ThenBy(c => c.Id).ToListAsync(ct);
        history = history.Where(c => c.TaskId is null || taskInfo.ContainsKey(c.TaskId.Value)).ToList();   // a task the caller cannot see, or that was deleted, stays out
        DateOnly? Baseline(Guid? taskId) => history.Where(c => c.TaskId == taskId).Select(c => c.Previous ?? c.Revised).FirstOrDefault();
        static int Late(DateOnly? original, DateOnly? current) => original is { } o && current is { } c && c > o ? c.DayNumber - o.DayNumber : 0;

        // What each task is waiting on: its predecessors that are not finished. A predecessor the caller cannot open (another project they are not
        // in) is shown as "a task you cannot see": the task is still marked as waiting, but nothing about the other task or its project leaks.
        // Read without the "projects this person may see" narrowing on purpose: the fact that something unfinished is in the way must count even
        // when the person cannot open it. Only its existence is used for such a task (see `openable` below), never its title, status or project.
        var tenant = ctx.RequireTenantId();
        var blockers = taskIds.Count == 0 ? [] : await (from d in db.TaskDependencies.AsNoTracking()
                                                       where taskIds.Contains(d.TaskId)
                                                       join p in db.Tasks.IgnoreQueryFilters().AsNoTracking() on d.DependsOnTaskId equals p.Id
                                                       join st in db.WorkflowStatuses.IgnoreQueryFilters().AsNoTracking() on p.StatusId equals st.Id
                                                       where p.TenantId == tenant && !p.IsDeleted && st.TenantId == tenant
                                                             && st.Category != StatusCategory.Done && st.Category != StatusCategory.Cancelled
                                                       select new { d.TaskId, PredecessorId = p.Id, p.Number, p.Title, Status = st.Name, p.ProjectId }).ToListAsync(ct);
        var blockerIds = blockers.Select(b => b.PredecessorId).Distinct().ToList();
        var openable = blockerIds.Count == 0 ? [] : (await access.VisibleTasks().AsNoTracking().Where(t => blockerIds.Contains(t.Id)).Select(t => t.Id).ToListAsync(ct)).ToHashSet();
        var blockerProjects = blockers.Where(b => openable.Contains(b.PredecessorId)).Select(b => b.ProjectId).Distinct().ToList();
        var keys = await db.Projects.AsNoTracking().Where(p => blockerProjects.Contains(p.Id)).ToDictionaryAsync(p => p.Id, p => p.Key, ct);
        var blockedBy = blockers.GroupBy(b => b.TaskId).ToDictionary(g => g.Key,
            g => (IReadOnlyList<StatusBlockerDto>)g.Select(b => openable.Contains(b.PredecessorId)
                ? new StatusBlockerDto($"{keys.GetValueOrDefault(b.ProjectId, project.Key)}-{b.Number}", b.Title, b.Status)
                : new StatusBlockerDto("—", "A task you cannot see", "In progress")).ToList());

        StatusTaskDto ToTask(Row r)
        {
            var original = Baseline(r.Id);
            var open = r.Category is not (StatusCategory.Done or StatusCategory.Cancelled);
            return new StatusTaskDto(r.Id, keyOf[r.Id], r.Title, r.ParentTaskId, r.StartDate, r.DueDate, original, Late(original, r.DueDate), r.StatusName, r.Category, r.Color,
                r.AssigneeId is { } a && r.AssigneeName is { } an ? new UserRefDto(a, an) : null,
                open && r.DueDate is { } d && d < today ? today.DayNumber - d.DayNumber : 0, history.Count(c => c.TaskId == r.Id),
                blockedBy.TryGetValue(r.Id, out var b) ? b : []);
        }
        // Top-level tasks by due date, each followed by its sub-tasks.
        var ordered = new List<StatusTaskDto>();
        var top = rows.Where(r => r.ParentTaskId is null || !taskInfo.ContainsKey(r.ParentTaskId.Value)).OrderBy(r => r.DueDate == null).ThenBy(r => r.DueDate).ThenBy(r => r.Number).ToList();
        foreach (var t in top)
        {
            ordered.Add(ToTask(t));
            foreach (var s in rows.Where(r => r.ParentTaskId == t.Id).OrderBy(r => r.DueDate == null).ThenBy(r => r.DueDate).ThenBy(r => r.Number)) ordered.Add(ToTask(s));
        }

        // The changes, newest first, with who made them and what they concern now.
        var people = history.Where(c => c.CreatedBy != null).Select(c => c.CreatedBy!.Value).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => people.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        var changes = history.OrderByDescending(c => c.CreatedAt).ThenByDescending(c => c.Id).Take(MaxChanges).Select(c =>
        {
            var task = c.TaskId is { } tid ? taskInfo[tid] : null;
            return new TimelineChangeDto(c.Id, c.TaskId is null ? "Project" : "Task", c.TaskId, c.TaskId is { } k ? keyOf[k] : null, task?.Title ?? project.Name,
                c.Previous, c.Revised, DueDateHistory.DaysShifted(c.Previous, c.Revised), c.Reason, c.Dependency,
                c.CreatedBy is { } u && names.TryGetValue(u, out var n) ? new UserRefDto(u, n) : null, c.CreatedAt,
                task is null ? project.Status.ToString() : task.StatusName, task?.Category);
        }).ToList();

        var stats = (await projects.GetStatsAsync([projectId], ct))[projectId];
        var owner = await db.Users.AsNoTracking().Where(u => u.Id == project.OwnerId).Select(u => u.DisplayName).FirstOrDefaultAsync(ct);
        var group = project.ProjectGroupId is { } gid ? await db.ProjectGroups.AsNoTracking().Where(g => g.Id == gid).Select(g => g.Name).FirstOrDefaultAsync(ct) : null;
        var originalDue = Baseline(null) ?? project.DueDate;
        var dto = new StatusProjectDto(project.Id, project.Key, project.Name, project.Description, group, project.StartDate, project.DueDate, originalDue, Late(originalDue, project.DueDate),
            project.Status, ProjectMetrics.Health(project, stats, today), ProjectMetrics.Progress(stats), owner is null ? null : new UserRefDto(project.OwnerId, owner), stats, project.ProjectType);
        return new ProjectStatusReportDto(dto, ordered, changes, ordered.Count(t => t.DelayedDays > 0), ordered.Count(t => t.BlockedBy.Count > 0));
    }
}
