using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Planning;

/// <summary>A milestone, and the timeline stage it is the checkpoint of (if any), so it can be shown on that stage.</summary>
public record MilestoneDto(Guid Id, Guid ProjectId, string Name, string? Description, DateOnly? StartDate, DateOnly? DueDate,
    StageStatus Status, UserRefDto? Owner, int SortOrder, DateTime? CompletedAt, int TaskTotal, int TaskDone, int Progress, bool IsOverdue,
    Guid? StageId = null, string? StageName = null);
public record UpsertMilestoneRequest(string Name, string? Description, DateOnly? StartDate, DateOnly? DueDate, StageStatus Status, Guid? OwnerId, int? SortOrder,
    Guid? StageId = null);

public record DependencyTaskDto(Guid Id, string Key, string Title, StatusCategory Category, string StatusName, DateOnly? DueDate);
public record DependencyDto(Guid Id, DependencyType Type, DependencyTaskDto Task, bool Satisfied);
/// <summary>Both directions of a task's links: what it waits for, and what waits for it.</summary>
public record TaskDependenciesDto(IReadOnlyList<DependencyDto> BlockedBy, IReadOnlyList<DependencyDto> Blocks, bool Enforced, string? BlockedReason);
public record AddDependencyRequest(Guid DependsOnTaskId, DependencyType Type);

/// <summary>
/// The rules that decide whether a task may start or finish, given the tasks it depends on (spec section 18).
/// A cancelled predecessor counts as settled: it is never going to happen, so it must not block the rest of the plan for ever.
/// </summary>
public static class DependencyRules
{
    public static bool HasStarted(StatusCategory c) => c is not StatusCategory.Todo;
    public static bool HasFinished(StatusCategory c) => c is StatusCategory.Done or StatusCategory.Cancelled;

    /// <summary>True when this link is satisfied for the successor to reach <paramref name="target"/>.</summary>
    public static bool Allows(DependencyType type, StatusCategory predecessor, StatusCategory target) => (type, target) switch
    {
        // Nothing holds a task back from going back to "to do" or being cancelled.
        (_, StatusCategory.Todo or StatusCategory.Cancelled) => true,
        (DependencyType.FinishToStart, _) => HasFinished(predecessor),
        (DependencyType.StartToStart, _) => HasStarted(predecessor),
        (DependencyType.FinishToFinish, StatusCategory.Done) => HasFinished(predecessor),
        (DependencyType.StartToFinish, StatusCategory.Done) => HasStarted(predecessor),
        _ => true,   // finish-to-* links say nothing about starting
    };

    public static string Describe(DependencyType type) => type switch
    {
        DependencyType.FinishToStart => "must finish first",
        DependencyType.StartToStart => "must start first",
        DependencyType.FinishToFinish => "must finish before this one can",
        _ => "must start before this one can finish",
    };
}

/// <summary>Milestones and task dependencies. Everything is checked against the caller's project access first.</summary>
public class PlanningService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder,
    PermissionService permissions, ProjectAccess access)
{
    private const int MaxMilestones = 100;
    private const int MaxDependencies = 25;

    // ---------------------------------------------------------------- milestones

    public async Task<IReadOnlyList<MilestoneDto>> ListMilestonesAsync(Guid projectId, CancellationToken ct = default)
    {
        await access.GetProjectAsync(projectId, ct);
        var today = clock.Today;
        var rows = await db.Milestones.AsNoTracking().Where(m => m.ProjectId == projectId)
            .OrderBy(m => m.SortOrder).ThenBy(m => m.DueDate ?? DateOnly.MaxValue).ThenBy(m => m.CreatedAt)
            .Select(m => new
            {
                Milestone = m,
                OwnerName = m.Owner!.DisplayName,
                StageName = db.ProjectStages.Where(s => s.Id == m.StageId).Select(s => s.Name).FirstOrDefault(),
                Total = db.Tasks.Count(t => t.MilestoneId == m.Id),
                Done = db.Tasks.Count(t => t.MilestoneId == m.Id && t.Status!.Category == StatusCategory.Done),
                Cancelled = db.Tasks.Count(t => t.MilestoneId == m.Id && t.Status!.Category == StatusCategory.Cancelled),
            }).ToListAsync(ct);

        return rows.Select(r =>
        {
            var m = r.Milestone;
            var counted = Math.Max(0, r.Total - r.Cancelled);
            var progress = m.Status == StageStatus.Completed ? 100 : counted == 0 ? 0 : (int)Math.Round(r.Done * 100.0 / counted);
            return new MilestoneDto(m.Id, m.ProjectId, m.Name, m.Description, m.StartDate, m.DueDate, m.Status,
                r.OwnerName is null ? null : new UserRefDto(m.OwnerId!.Value, r.OwnerName), m.SortOrder, m.CompletedAt,
                r.Total, r.Done, progress, m.Status != StageStatus.Completed && m.DueDate is { } d && d < today,
                r.StageName is null ? null : m.StageId, r.StageName);
        }).ToList();
    }

    /// <summary>The stage a milestone marks must be one of the same project's stages.</summary>
    private async Task<Guid?> ResolveStageAsync(Guid projectId, Guid? stageId, CancellationToken ct)
    {
        if (stageId is not { } sid) return null;
        if (!await db.ProjectStages.AnyAsync(s => s.Id == sid && s.ProjectId == projectId, ct))
            throw new ValidationException("stageId", "That stage is not part of this project's timeline.");
        return sid;
    }

    private async Task<Milestone> FindMilestoneAsync(Guid projectId, Guid id, CancellationToken ct) =>
        await db.Milestones.FirstOrDefaultAsync(m => m.Id == id && m.ProjectId == projectId, ct)
        ?? throw new NotFoundException("Milestone not found.");

    private async Task<Project> RequireEditableProjectAsync(Guid projectId, CancellationToken ct)
    {
        var project = await access.GetProjectAsync(projectId, ct);
        await access.RequireProjectEditAsync(project, ct);
        return project;
    }

    public async Task<IReadOnlyList<MilestoneDto>> CreateMilestoneAsync(Guid projectId, UpsertMilestoneRequest req, CancellationToken ct = default)
    {
        var project = await RequireEditableProjectAsync(projectId, ct);
        if (await db.Milestones.CountAsync(m => m.ProjectId == projectId, ct) >= MaxMilestones)
            throw new ValidationException("name", $"A project can have up to {MaxMilestones} milestones.");
        EnsureDatesMakeSense(req);

        var next = await db.Milestones.Where(m => m.ProjectId == projectId).Select(m => (int?)m.SortOrder).MaxAsync(ct) ?? -1;
        var milestone = new Milestone
        {
            TenantId = ctx.RequireTenantId(), ProjectId = projectId, Name = req.Name.Trim(), Description = req.Description?.Trim(),
            StartDate = req.StartDate, DueDate = req.DueDate, Status = req.Status, SortOrder = req.SortOrder ?? next + 1,
            OwnerId = await ResolveOwnerAsync(req.OwnerId, ct), CompletedAt = req.Status == StageStatus.Completed ? clock.Now : null,
            StageId = await ResolveStageAsync(projectId, req.StageId, ct),
        };
        db.Milestones.Add(milestone);
        recorder.Activity("milestone.created", "Milestone", milestone.Id, $"Added milestone \"{milestone.Name}\" to {project.Key}", projectId);
        await db.SaveChangesAsync(ct);
        return await ListMilestonesAsync(projectId, ct);
    }

    public async Task<IReadOnlyList<MilestoneDto>> UpdateMilestoneAsync(Guid projectId, Guid id, UpsertMilestoneRequest req, CancellationToken ct = default)
    {
        await RequireEditableProjectAsync(projectId, ct);
        var milestone = await FindMilestoneAsync(projectId, id, ct);
        EnsureDatesMakeSense(req);

        var was = milestone.Status;
        milestone.Name = req.Name.Trim();
        milestone.Description = req.Description?.Trim();
        milestone.StartDate = req.StartDate;
        milestone.DueDate = req.DueDate;
        milestone.Status = req.Status;
        milestone.OwnerId = await ResolveOwnerAsync(req.OwnerId, ct);
        milestone.StageId = await ResolveStageAsync(projectId, req.StageId, ct);
        if (req.SortOrder is { } order) milestone.SortOrder = order;
        milestone.CompletedAt = req.Status == StageStatus.Completed ? milestone.CompletedAt ?? clock.Now : null;

        if (was != req.Status)
            recorder.Activity("milestone.status_changed", "Milestone", id, $"Milestone \"{milestone.Name}\": {was} → {req.Status}", projectId, was.ToString(), req.Status.ToString());
        await db.SaveChangesAsync(ct);
        return await ListMilestonesAsync(projectId, ct);
    }

    public async Task<IReadOnlyList<MilestoneDto>> DeleteMilestoneAsync(Guid projectId, Guid id, CancellationToken ct = default)
    {
        await RequireEditableProjectAsync(projectId, ct);
        var milestone = await FindMilestoneAsync(projectId, id, ct);
        foreach (var t in await db.Tasks.Where(t => t.MilestoneId == id).ToListAsync(ct)) t.MilestoneId = null;

        milestone.IsDeleted = true;
        milestone.DeletedAt = clock.Now;
        milestone.DeletedBy = ctx.UserId;
        recorder.Activity("milestone.deleted", "Milestone", id, $"Removed milestone \"{milestone.Name}\"", projectId);
        await db.SaveChangesAsync(ct);
        return await ListMilestonesAsync(projectId, ct);
    }

    private static void EnsureDatesMakeSense(UpsertMilestoneRequest req)
    {
        if (req.StartDate is { } s && req.DueDate is { } d && d < s)
            throw new ValidationException("dueDate", "Due date must not be before the start date.");
    }

    private async Task<Guid?> ResolveOwnerAsync(Guid? ownerId, CancellationToken ct)
    {
        if (ownerId is not { } id) return null;
        await access.EnsureTenantMemberAsync(id, "ownerId", ct);
        return id;
    }

    // ---------------------------------------------------------------- dependencies

    private async Task<TaskItem> FindTaskAsync(Guid id, CancellationToken ct) =>
        await access.VisibleTasks().FirstOrDefaultAsync(t => t.Id == id, ct) ?? throw new NotFoundException("Task not found.");

    public async Task<TaskDependenciesDto> GetDependenciesAsync(Guid taskId, CancellationToken ct = default)
    {
        var task = await FindTaskAsync(taskId, ct);
        var enforced = await db.Projects.Where(p => p.Id == task.ProjectId).Select(p => p.EnforceDependencies).FirstAsync(ct);
        var category = await db.WorkflowStatuses.Where(s => s.Id == task.StatusId).Select(s => s.Category).FirstAsync(ct);

        var blockedBy = await LinksAsync(d => d.TaskId == taskId, d => d.DependsOnTaskId, ct);
        var blocks = await LinksAsync(d => d.DependsOnTaskId == taskId, d => d.TaskId, ct);
        // "Satisfied" for the tasks this one waits on is judged against actually starting work.
        var withState = blockedBy.Select(d => d with { Satisfied = DependencyRules.Allows(d.Type, d.Task.Category, StatusCategory.Active) }).ToList();
        var blocking = withState.FirstOrDefault(d => !d.Satisfied);
        return new TaskDependenciesDto(withState, blocks, enforced,
            blocking is null || !enforced ? null : $"“{blocking.Task.Key} {blocking.Task.Title}” {DependencyRules.Describe(blocking.Type)}.");
    }

    private async Task<List<DependencyDto>> LinksAsync(System.Linq.Expressions.Expression<Func<TaskDependency, bool>> filter,
        Func<TaskDependency, Guid> otherId, CancellationToken ct)
    {
        var rows = await db.TaskDependencies.AsNoTracking().Where(filter).ToListAsync(ct);
        if (rows.Count == 0) return [];
        var ids = rows.Select(otherId).ToList();
        var tasks = await access.VisibleTasks().Where(t => ids.Contains(t.Id))
            .Select(t => new { t.Id, ProjectKey = t.Project!.Key, t.Number, t.Title, Category = t.Status!.Category, StatusName = t.Status.Name, t.DueDate })
            .ToDictionaryAsync(t => t.Id, ct);
        return rows.Where(r => tasks.ContainsKey(otherId(r))).Select(r =>
        {
            var t = tasks[otherId(r)];
            return new DependencyDto(r.Id, r.Type, new DependencyTaskDto(t.Id, $"{t.ProjectKey}-{t.Number}", t.Title, t.Category, t.StatusName, t.DueDate), true);
        }).ToList();
    }

    public async Task<TaskDependenciesDto> AddDependencyAsync(Guid taskId, AddDependencyRequest req, CancellationToken ct = default)
    {
        var task = await FindTaskAsync(taskId, ct);
        await permissions.RequireTaskEditAsync(task, ct);
        if (req.DependsOnTaskId == taskId) throw new ValidationException("dependsOnTaskId", "A task cannot depend on itself.");
        var other = await FindTaskAsync(req.DependsOnTaskId, ct);
        if (other.ProjectId != task.ProjectId) throw new ValidationException("dependsOnTaskId", "Tasks can only depend on tasks in the same project.");
        if (await db.TaskDependencies.AnyAsync(d => d.TaskId == taskId && d.DependsOnTaskId == req.DependsOnTaskId, ct))
            throw new ConflictException("That dependency already exists.", "DEPENDENCY_EXISTS");
        if (await db.TaskDependencies.CountAsync(d => d.TaskId == taskId, ct) >= MaxDependencies)
            throw new ValidationException("dependsOnTaskId", $"A task can depend on up to {MaxDependencies} other tasks.");
        if (await WouldLoopAsync(taskId, req.DependsOnTaskId, ct))
            throw new ConflictException("That would create a circular dependency.", "DEPENDENCY_CYCLE");

        db.TaskDependencies.Add(new TaskDependency { TenantId = ctx.RequireTenantId(), TaskId = taskId, DependsOnTaskId = req.DependsOnTaskId, Type = req.Type });
        var keys = await KeysAsync([taskId, req.DependsOnTaskId], ct);
        recorder.Activity("task.dependency_added", "Task", taskId,
            $"{keys[taskId]} now depends on {keys[req.DependsOnTaskId]} ({Label(req.Type)})", task.ProjectId);
        await db.SaveChangesAsync(ct);
        return await GetDependenciesAsync(taskId, ct);
    }

    public async Task<TaskDependenciesDto> RemoveDependencyAsync(Guid taskId, Guid dependencyId, CancellationToken ct = default)
    {
        var task = await FindTaskAsync(taskId, ct);
        await permissions.RequireTaskEditAsync(task, ct);
        var link = await db.TaskDependencies.FirstOrDefaultAsync(d => d.Id == dependencyId && d.TaskId == taskId, ct)
            ?? throw new NotFoundException("Dependency not found.");
        var keys = await KeysAsync([taskId, link.DependsOnTaskId], ct);

        db.TaskDependencies.Remove(link);
        recorder.Activity("task.dependency_removed", "Task", taskId,
            $"{keys[taskId]} no longer depends on {keys.GetValueOrDefault(link.DependsOnTaskId, "a task")}", task.ProjectId);
        await db.SaveChangesAsync(ct);
        return await GetDependenciesAsync(taskId, ct);
    }

    private static string Label(DependencyType t) => t switch
    {
        DependencyType.FinishToStart => "finish to start",
        DependencyType.StartToStart => "start to start",
        DependencyType.FinishToFinish => "finish to finish",
        _ => "start to finish",
    };

    private async Task<Dictionary<Guid, string>> KeysAsync(Guid[] ids, CancellationToken ct)
    {
        var rows = await db.Tasks.Where(t => ids.Contains(t.Id)).Select(t => new { t.Id, ProjectKey = t.Project!.Key, t.Number }).ToListAsync(ct);
        return rows.ToDictionary(t => t.Id, t => $"{t.ProjectKey}-{t.Number}");
    }

    /// <summary>True when making <paramref name="taskId"/> wait for <paramref name="dependsOn"/> would close a loop.</summary>
    private async Task<bool> WouldLoopAsync(Guid taskId, Guid dependsOn, CancellationToken ct)
    {
        var projectId = await db.Tasks.Where(t => t.Id == taskId).Select(t => t.ProjectId).FirstAsync(ct);
        var edges = await db.TaskDependencies.AsNoTracking()
            .Where(d => db.Tasks.Any(t => t.Id == d.TaskId && t.ProjectId == projectId))
            .Select(d => new { d.TaskId, d.DependsOnTaskId }).ToListAsync(ct);
        var waitsFor = edges.GroupBy(e => e.TaskId).ToDictionary(g => g.Key, g => g.Select(e => e.DependsOnTaskId).ToList());

        // Walk everything the new predecessor already waits for: reaching the successor again means a loop.
        var seen = new HashSet<Guid>();
        var stack = new Stack<Guid>([dependsOn]);
        while (stack.Count > 0)
        {
            var current = stack.Pop();
            if (current == taskId) return true;
            if (!seen.Add(current)) continue;
            foreach (var next in waitsFor.GetValueOrDefault(current, [])) stack.Push(next);
        }
        return false;
    }

    // ---------------------------------------------------------------- enforcement (used by TaskService)

    /// <summary>
    /// The reason a task may not move to <paramref name="target"/> yet, or null when it may. Only applies when the project
    /// has dependency enforcement switched on.
    /// </summary>
    public async Task<string?> BlockedReasonAsync(TaskItem task, StatusCategory target, CancellationToken ct = default)
    {
        if (target is StatusCategory.Todo or StatusCategory.Cancelled) return null;
        if (!await db.Projects.Where(p => p.Id == task.ProjectId).Select(p => p.EnforceDependencies).FirstAsync(ct)) return null;

        var links = await db.TaskDependencies.AsNoTracking().Where(d => d.TaskId == task.Id)
            .Select(d => new { d.Type, ProjectKey = d.DependsOnTask!.Project!.Key, d.DependsOnTask.Number, d.DependsOnTask.Title, Category = d.DependsOnTask.Status!.Category })
            .ToListAsync(ct);
        foreach (var link in links)
            if (!DependencyRules.Allows(link.Type, link.Category, target))
                return $"“{link.ProjectKey}-{link.Number} {link.Title}” {DependencyRules.Describe(link.Type)}.";
        return null;
    }
}
