using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Planning;

public record SprintDto(Guid Id, Guid ProjectId, string Name, string? Goal, DateOnly StartDate, DateOnly EndDate, SprintStatus Status,
    DateTime? StartedAt, DateTime? CompletedAt, int Committed, int TaskTotal, int TaskDone, int Progress, decimal EstimatedHours, int? DaysLeft, bool IsOverdue);
public record BurndownPointDto(DateOnly Date, int Remaining, double Ideal);
public record SprintDetailDto(SprintDto Sprint, IReadOnlyList<BurndownPointDto> Burndown);

public record UpsertSprintRequest(string Name, string? Goal, DateOnly StartDate, DateOnly EndDate);
/// <summary>What happens to the unfinished tasks when a sprint is completed: another planned sprint, or (null) the backlog.</summary>
public record CompleteSprintRequest(Guid? MoveUnfinishedTo);
public record SprintTasksRequest(IReadOnlyList<Guid> TaskIds);
public record AssignSprintRequest(Guid? SprintId);

/// <summary>
/// Sprints: a time-boxed batch of a project's tasks. A project has any number of planned sprints, at most one active one, and a history of
/// completed ones. Tasks not in a sprint form the backlog.
/// </summary>
public class SprintService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, PermissionService permissions, ProjectAccess access)
{
    private const int MaxSprints = 200;
    private const int MaxSprintDays = 92;
    private const int MaxTasksPerCall = 200;

    // ---------------------------------------------------------------- reading

    public async Task<IReadOnlyList<SprintDto>> ListAsync(Guid projectId, CancellationToken ct = default)
    {
        await access.GetProjectAsync(projectId, ct);
        return await LoadAsync(db.Sprints.Where(s => s.ProjectId == projectId), ct);
    }

    public async Task<SprintDetailDto> GetAsync(Guid projectId, Guid id, CancellationToken ct = default)
    {
        await access.GetProjectAsync(projectId, ct);
        var sprint = (await LoadAsync(db.Sprints.Where(s => s.Id == id && s.ProjectId == projectId), ct)).FirstOrDefault()
            ?? throw new NotFoundException("Sprint not found.");
        return new SprintDetailDto(sprint, await BurndownAsync(sprint, ct));
    }

    private async Task<List<SprintDto>> LoadAsync(IQueryable<Sprint> query, CancellationToken ct)
    {
        var today = clock.Today;
        var rows = await query.AsNoTracking().Select(s => new
        {
            Sprint = s,
            Total = db.Tasks.Count(t => t.SprintId == s.Id && t.Status!.Category != StatusCategory.Cancelled),
            Done = db.Tasks.Count(t => t.SprintId == s.Id && t.Status!.Category == StatusCategory.Done),
            Hours = db.Tasks.Where(t => t.SprintId == s.Id).Sum(t => t.EstimatedHours) ?? 0m,
        }).ToListAsync(ct);

        return rows.Select(r =>
        {
            var s = r.Sprint;
            var progress = r.Total == 0 ? 0 : (int)Math.Round(r.Done * 100.0 / r.Total);
            int? daysLeft = s.Status == SprintStatus.Active ? Math.Max(0, s.EndDate.DayNumber - today.DayNumber) : null;
            return new SprintDto(s.Id, s.ProjectId, s.Name, s.Goal, s.StartDate, s.EndDate, s.Status, s.StartedAt, s.CompletedAt,
                s.CommittedTasks, r.Total, r.Done, progress, r.Hours, daysLeft, s.Status == SprintStatus.Active && s.EndDate < today);
        })
        .OrderBy(s => s.Status switch { SprintStatus.Active => 0, SprintStatus.Planned => 1, _ => 2 })
        .ThenBy(s => s.Status == SprintStatus.Completed ? -s.EndDate.DayNumber : s.StartDate.DayNumber)
        .ToList();
    }

    /// <summary>
    /// Tasks still open at the end of each day of the sprint. Uses the number committed to the sprint and when each task was finished;
    /// tasks that left the sprint (moved to the backlog) no longer count, which is what "remaining scope" means.
    /// </summary>
    private async Task<IReadOnlyList<BurndownPointDto>> BurndownAsync(SprintDto s, CancellationToken ct)
    {
        if (s.Status == SprintStatus.Planned) return [];
        var finished = await db.Tasks.Where(t => t.SprintId == s.Id && t.CompletedAt != null && t.Status!.Category == StatusCategory.Done)
            .Select(t => t.CompletedAt!.Value).ToListAsync(ct);
        var last = s.Status == SprintStatus.Completed ? DateOnly.FromDateTime(s.CompletedAt ?? DateTime.UtcNow) : (clock.Today < s.EndDate ? clock.Today : s.EndDate);
        if (last < s.StartDate) last = s.StartDate;

        var committed = Math.Max(s.Committed, s.TaskTotal);
        var span = Math.Max(1, s.EndDate.DayNumber - s.StartDate.DayNumber);
        var points = new List<BurndownPointDto>();
        for (var d = s.StartDate; d <= last; d = d.AddDays(1))
        {
            var doneByThen = finished.Count(f => DateOnly.FromDateTime(f) <= d);
            var ideal = Math.Max(0, committed * (1 - (double)(d.DayNumber - s.StartDate.DayNumber) / span));
            points.Add(new BurndownPointDto(d, Math.Max(0, committed - doneByThen), Math.Round(ideal, 1)));
        }
        return points;
    }

    // ---------------------------------------------------------------- managing sprints

    private async Task<Project> RequireEditableAsync(Guid projectId, CancellationToken ct)
    {
        var project = await access.GetProjectAsync(projectId, ct);
        await access.RequireProjectEditAsync(project, ct);
        if (project.Status == ProjectStatus.Archived)
            throw new ConflictException("Archived projects are read-only. Restore the project to plan sprints.", "PROJECT_ARCHIVED");
        return project;
    }

    private async Task<Sprint> FindAsync(Guid projectId, Guid id, CancellationToken ct) =>
        await db.Sprints.FirstOrDefaultAsync(s => s.Id == id && s.ProjectId == projectId, ct) ?? throw new NotFoundException("Sprint not found.");

    private static void Validate(UpsertSprintRequest req)
    {
        var name = req.Name?.Trim() ?? "";
        if (name.Length is < 1 or > 100) throw new ValidationException("name", "Give the sprint a name (up to 100 characters).");
        if (req.Goal is { Length: > 500 }) throw new ValidationException("goal", "Keep the goal under 500 characters.");
        if (req.EndDate < req.StartDate) throw new ValidationException("endDate", "The sprint must not end before it starts.");
        if (req.EndDate.DayNumber - req.StartDate.DayNumber >= MaxSprintDays) throw new ValidationException("endDate", $"A sprint can be at most {MaxSprintDays} days long.");
    }

    public async Task<SprintDto> CreateAsync(Guid projectId, UpsertSprintRequest req, CancellationToken ct = default)
    {
        var project = await RequireEditableAsync(projectId, ct);
        Validate(req);
        if (await db.Sprints.CountAsync(s => s.ProjectId == projectId, ct) >= MaxSprints)
            throw new ConflictException($"A project can have at most {MaxSprints} sprints.", "LIMIT_REACHED");

        var sprint = new Sprint
        {
            TenantId = ctx.RequireTenantId(), ProjectId = projectId, Name = req.Name.Trim(), Goal = string.IsNullOrWhiteSpace(req.Goal) ? null : req.Goal.Trim(),
            StartDate = req.StartDate, EndDate = req.EndDate, Status = SprintStatus.Planned, CreatedAt = clock.Now, CreatedBy = ctx.RequireUserId(),
        };
        db.Sprints.Add(sprint);
        recorder.Activity("sprint.created", "Sprint", sprint.Id, $"Planned sprint \"{sprint.Name}\" in {project.Key}", projectId);
        await db.SaveChangesAsync(ct);
        return (await ListAsync(projectId, ct)).First(s => s.Id == sprint.Id);
    }

    public async Task<SprintDto> UpdateAsync(Guid projectId, Guid id, UpsertSprintRequest req, CancellationToken ct = default)
    {
        await RequireEditableAsync(projectId, ct);
        Validate(req);
        var sprint = await FindAsync(projectId, id, ct);
        if (sprint.Status == SprintStatus.Completed) throw new ConflictException("A completed sprint cannot be changed.", "SPRINT_COMPLETED");
        // Once it has started, the start date is history; only the end date and the text can still move.
        if (sprint.Status == SprintStatus.Active && req.StartDate != sprint.StartDate) throw new ValidationException("startDate", "The start date of a running sprint cannot change.");

        sprint.Name = req.Name.Trim(); sprint.Goal = string.IsNullOrWhiteSpace(req.Goal) ? null : req.Goal.Trim();
        sprint.StartDate = req.StartDate; sprint.EndDate = req.EndDate; sprint.UpdatedAt = clock.Now;
        await db.SaveChangesAsync(ct);
        return (await ListAsync(projectId, ct)).First(s => s.Id == id);
    }

    public async Task DeleteAsync(Guid projectId, Guid id, CancellationToken ct = default)
    {
        await RequireEditableAsync(projectId, ct);
        var sprint = await FindAsync(projectId, id, ct);
        if (sprint.Status != SprintStatus.Planned) throw new ConflictException("Only a sprint that has not started can be deleted. Complete a running sprint instead.", "SPRINT_STARTED");
        foreach (var t in await db.Tasks.Where(t => t.SprintId == id).ToListAsync(ct)) t.SprintId = null; // back to the backlog
        db.Sprints.Remove(sprint);
        recorder.Activity("sprint.deleted", "Sprint", id, $"Deleted sprint \"{sprint.Name}\"", projectId);
        await db.SaveChangesAsync(ct);
    }

    public async Task<SprintDto> StartAsync(Guid projectId, Guid id, CancellationToken ct = default)
    {
        await RequireEditableAsync(projectId, ct);
        var sprint = await FindAsync(projectId, id, ct);
        if (sprint.Status != SprintStatus.Planned) throw new ConflictException("This sprint has already started.", "SPRINT_STARTED");
        if (await db.Sprints.AnyAsync(s => s.ProjectId == projectId && s.Status == SprintStatus.Active, ct))
            throw new ConflictException("Another sprint is already running. Complete it before starting this one.", "SPRINT_ACTIVE");

        sprint.Status = SprintStatus.Active;
        sprint.StartedAt = clock.Now;
        sprint.CommittedTasks = await db.Tasks.CountAsync(t => t.SprintId == id && t.Status!.Category != StatusCategory.Cancelled, ct);
        recorder.Activity("sprint.started", "Sprint", id, $"Started sprint \"{sprint.Name}\" with {sprint.CommittedTasks} tasks", projectId);
        await db.SaveChangesAsync(ct);
        return (await ListAsync(projectId, ct)).First(s => s.Id == id);
    }

    public async Task<SprintDto> CompleteAsync(Guid projectId, Guid id, CompleteSprintRequest req, CancellationToken ct = default)
    {
        await RequireEditableAsync(projectId, ct);
        var sprint = await FindAsync(projectId, id, ct);
        if (sprint.Status != SprintStatus.Active) throw new ConflictException("Only a running sprint can be completed.", "SPRINT_NOT_ACTIVE");

        Guid? target = null;
        if (req.MoveUnfinishedTo is { } to)
        {
            var next = await db.Sprints.FirstOrDefaultAsync(s => s.Id == to && s.ProjectId == projectId, ct) ?? throw new ValidationException("moveUnfinishedTo", "That sprint does not exist.");
            if (next.Status != SprintStatus.Planned) throw new ValidationException("moveUnfinishedTo", "Unfinished tasks can only move to a sprint that has not started.");
            target = next.Id;
        }

        var unfinished = await db.Tasks.Where(t => t.SprintId == id && t.Status!.Category != StatusCategory.Done && t.Status.Category != StatusCategory.Cancelled).ToListAsync(ct);
        foreach (var t in unfinished) t.SprintId = target;

        sprint.Status = SprintStatus.Completed;
        sprint.CompletedAt = clock.Now;
        recorder.Activity("sprint.completed", "Sprint", id,
            $"Completed sprint \"{sprint.Name}\"; {unfinished.Count} unfinished task{(unfinished.Count == 1 ? "" : "s")} moved to {(target is null ? "the backlog" : "the next sprint")}", projectId);
        await db.SaveChangesAsync(ct);
        return (await ListAsync(projectId, ct)).First(s => s.Id == id);
    }

    // ---------------------------------------------------------------- planning: which tasks are in which sprint

    /// <summary>Puts tasks of the project into a sprint (or, with a null sprint, back into the backlog).</summary>
    public async Task AssignAsync(Guid projectId, Guid? sprintId, IReadOnlyList<Guid> taskIds, CancellationToken ct = default)
    {
        var project = await access.GetProjectAsync(projectId, ct);
        if (project.Status == ProjectStatus.Archived) throw new ConflictException("Archived projects are read-only.", "PROJECT_ARCHIVED");
        var ids = taskIds.Distinct().ToList();
        if (ids.Count == 0) return;
        if (ids.Count > MaxTasksPerCall) throw new ValidationException("taskIds", $"Move at most {MaxTasksPerCall} tasks at a time.");

        Sprint? sprint = null;
        if (sprintId is { } sid)
        {
            sprint = await FindAsync(projectId, sid, ct);
            if (sprint.Status == SprintStatus.Completed) throw new ConflictException("A completed sprint cannot take more tasks.", "SPRINT_COMPLETED");
        }

        var tasks = await access.VisibleTasks().Where(t => t.ProjectId == projectId && ids.Contains(t.Id)).ToListAsync(ct);
        if (tasks.Count != ids.Count) throw new ValidationException("taskIds", "Some of those tasks were not found in this project.");
        await permissions.RequireTaskEditAsync(tasks, ct);
        // Sprints hold whole tasks; subtasks are planned through their parent.
        if (tasks.Any(t => t.ParentTaskId is not null)) throw new ValidationException("taskIds", "Subtasks are not planned on their own. Plan the parent task.");

        var changed = tasks.Where(t => t.SprintId != sprintId).ToList();
        var leaving = changed.Where(t => t.SprintId is not null).GroupBy(t => t.SprintId!.Value).ToList();
        foreach (var t in changed) t.SprintId = sprintId;
        foreach (var t in changed) t.Version++;

        // While a sprint runs, tasks added to or dropped from it change what was committed (visible as scope change on the burndown).
        if (sprint is { Status: SprintStatus.Active }) sprint.CommittedTasks += changed.Count;
        foreach (var g in leaving)
        {
            var left = await db.Sprints.FirstOrDefaultAsync(s => s.Id == g.Key, ct);
            if (left is { Status: SprintStatus.Active }) left.CommittedTasks = Math.Max(0, left.CommittedTasks - g.Count());
        }

        if (changed.Count > 0)
            recorder.Activity("sprint.tasks_moved", "Sprint", sprintId, $"{changed.Count} task{(changed.Count == 1 ? "" : "s")} moved to {(sprint is null ? "the backlog" : $"sprint \"{sprint.Name}\"")}", projectId);
        await db.SaveChangesAsync(ct);
    }

    /// <summary>Single-task version used by the task dialog.</summary>
    public async Task AssignTaskAsync(Guid taskId, Guid? sprintId, CancellationToken ct = default)
    {
        var task = await access.VisibleTasks().FirstOrDefaultAsync(t => t.Id == taskId, ct) ?? throw new NotFoundException("Task not found.");
        await AssignAsync(task.ProjectId, sprintId, [task.Id], ct);
    }
}
