using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Tasks;

/// <summary>What is still open under a task: subtasks that are not finished and checklist items that are not ticked.</summary>
public record PendingWork(int Subtasks, int ChecklistItems)
{
    public bool Any => Subtasks + ChecklistItems > 0;
}

/// <summary>
/// The rules that tie work together: a task is only done once its subtasks and checklist are, a timeline stage is only complete
/// once every task under it is, and stages are worked through in order (see <see cref="StageSequence"/>). Task changes call
/// <see cref="SyncStagesAsync"/> after they save, so a stage follows its tasks.
/// </summary>
public class TaskCompletionService(IAppDbContext db, AppClock clock, Recorder recorder)
{
    public const string PendingChildrenMessage =
        "Unable to change the status. Please complete all pending subtasks and checklist items before marking this task as completed.";
    public const string PendingChildrenCode = "TASK_INCOMPLETE_CHILDREN";
    public const string StageOpenTasksCode = "STAGE_HAS_OPEN_TASKS";
    public const string StageOpenIssuesCode = "STAGE_HAS_OPEN_ISSUES";

    /// <summary>A subtask counts as resolved when it is done or cancelled.</summary>
    public async Task<PendingWork> PendingAsync(Guid taskId, CancellationToken ct)
    {
        var subtasks = await db.Tasks.CountAsync(t => t.ParentTaskId == taskId
            && t.Status!.Category != StatusCategory.Done && t.Status.Category != StatusCategory.Cancelled, ct);
        var checklist = await db.ChecklistItems.CountAsync(c => c.TaskId == taskId && !c.IsDone, ct);
        return new PendingWork(subtasks, checklist);
    }

    /// <summary>Moving from any other status into a Done one (going between two Done statuses is not a completion).</summary>
    private async Task<bool> IsCompletingAsync(TaskItem task, WorkflowStatus target, CancellationToken ct)
    {
        if (target.Category != StatusCategory.Done || task.StatusId == target.Id) return false;
        var current = await db.WorkflowStatuses.Where(s => s.Id == task.StatusId).Select(s => s.Category).FirstOrDefaultAsync(ct);
        return current != StatusCategory.Done;
    }

    /// <summary>The refusal to give when <paramref name="stageId"/> is still locked behind an unfinished stage, or null when work under it may be completed.</summary>
    private async Task<ConflictException?> StageLockAsync(Guid? stageId, CancellationToken ct)
    {
        if (stageId is not { } id) return null;
        var stage = await db.ProjectStages.FirstOrDefaultAsync(s => s.Id == id, ct);
        if (stage is null) return null;
        var previous = await PreviousOfAsync(stage, ct);
        return StageSequence.IsLocked(previous, stage.Status) ? StageSequence.Refusal(previous!.Name, stage.Name, completing: true) : null;
    }

    private Task<ProjectStage?> PreviousOfAsync(ProjectStage stage, CancellationToken ct) =>
        db.ProjectStages.Where(s => s.ProjectId == stage.ProjectId && s.Order < stage.Order).OrderByDescending(s => s.Order).FirstOrDefaultAsync(ct);

    private Task<ProjectStage?> NextOfAsync(ProjectStage stage, CancellationToken ct) =>
        db.ProjectStages.Where(s => s.ProjectId == stage.ProjectId && s.Order > stage.Order).OrderBy(s => s.Order).FirstOrDefaultAsync(ct);

    /// <summary>
    /// Whether moving <paramref name="task"/> into <paramref name="target"/> would complete it too early: while its subtasks or checklist
    /// are still open, or while the stage it belongs to is locked. Used by automation, which stands down instead of failing.
    /// </summary>
    public async Task<bool> IsBlockedFromCompletingAsync(TaskItem task, WorkflowStatus target, CancellationToken ct)
    {
        if (!await IsCompletingAsync(task, target, ct)) return false;
        return await StageLockAsync(task.StageId, ct) is not null || (await PendingAsync(task.Id, ct)).Any;
    }

    /// <summary>
    /// Throws when completing <paramref name="task"/> is not allowed yet: first the stage order (Please complete Development before completing
    /// Code Review), then the "finish the subtasks and checklist first" rule. <paramref name="stageId"/> is the stage the task will be in.
    /// </summary>
    public async Task EnsureCanCompleteAsync(TaskItem task, WorkflowStatus target, Guid? stageId, CancellationToken ct)
    {
        if (!await IsCompletingAsync(task, target, ct)) return;
        if (await StageLockAsync(stageId, ct) is { } locked) throw locked;
        if ((await PendingAsync(task.Id, ct)).Any) throw new ConflictException(PendingChildrenMessage, PendingChildrenCode);
    }

    /// <summary>For a task created straight into a Done status: it may not be done in a stage that is still locked.</summary>
    public async Task EnsureStageUnlockedAsync(Guid? stageId, CancellationToken ct)
    {
        if (await StageLockAsync(stageId, ct) is { } locked) throw locked;
    }

    /// <summary>The tasks that decide whether a stage is complete: its top-level tasks, leaving out cancelled ones.</summary>
    private IQueryable<TaskItem> CountedTasks(Guid stageId) =>
        db.Tasks.Where(t => t.StageId == stageId && t.ParentTaskId == null && t.Status!.Category != StatusCategory.Cancelled);

    /// <summary>How many tasks sit under a stage and how many of them are still open.</summary>
    public async Task<int> OpenTaskCountAsync(Guid stageId, CancellationToken ct) =>
        await CountedTasks(stageId).CountAsync(t => t.Status!.Category != StatusCategory.Done, ct);

    /// <summary>Test issues of a stage that are not resolved yet. While there are any, the stage cannot be completed.</summary>
    public async Task<int> OpenIssueCountAsync(Guid stageId, CancellationToken ct) =>
        await db.StageIssues.CountAsync(i => i.StageId == stageId && i.Status != IssueStatus.Resolved, ct);

    /// <summary>
    /// Brings each stage in line with its tasks and saves. All tasks done marks the stage Completed; an open task under a Completed
    /// stage reopens it (so does an unresolved test issue, and one keeps the stage from completing); the first started task moves a Pending
    /// stage to In progress. A stage with no tasks (and no open issues) is left as it is.
    /// A stage whose predecessor is unfinished is locked, so it can be reopened but never started or completed here. When a stage becomes
    /// Completed the next one is looked at too, since it may just have been unlocked. Call this after the task changes were saved.
    /// </summary>
    public async Task SyncStagesAsync(IEnumerable<Guid?> stageIds, CancellationToken ct)
    {
        var queue = new Queue<Guid>(stageIds.Where(i => i is not null).Select(i => i!.Value).Distinct());
        if (queue.Count == 0) return;
        var seen = new HashSet<Guid>();
        var today = clock.Today;
        var changed = false;

        while (queue.Count > 0)
        {
            var id = queue.Dequeue();
            if (!seen.Add(id)) continue;
            var stage = await db.ProjectStages.FirstOrDefaultAsync(s => s.Id == id, ct);
            if (stage is null) continue;
            var previous = await PreviousOfAsync(stage, ct);
            var locked = previous is not null && previous.Status != StageStatus.Completed;

            var total = await CountedTasks(stage.Id).CountAsync(ct);
            var openIssues = await OpenIssueCountAsync(stage.Id, ct);
            if (total == 0 && openIssues == 0) continue;
            var open = await CountedTasks(stage.Id).CountAsync(t => t.Status!.Category != StatusCategory.Done, ct);
            var started = await CountedTasks(stage.Id).CountAsync(t => t.Status!.Category != StatusCategory.Todo, ct);

            var old = stage.Status;
            if (total > 0 && open == 0 && openIssues == 0)
            {
                if (!locked)
                {
                    stage.Status = StageStatus.Completed;
                    stage.ActualStart ??= today;
                    stage.ActualEnd ??= today;
                }
            }
            else if (old == StageStatus.Completed)
            {
                stage.Status = StageStatus.InProgress;
                stage.ActualEnd = null;
            }
            else if (old == StageStatus.Pending && started > 0 && !locked)
            {
                stage.Status = StageStatus.InProgress;
                stage.ActualStart ??= today;
            }

            if (old == stage.Status) continue;
            changed = true;
            var project = await db.Projects.Where(p => p.Id == stage.ProjectId).Select(p => p.Name).FirstAsync(ct);
            recorder.Activity("project.stage_status", "Project", stage.ProjectId,
                $"Stage \"{stage.Name}\" of \"{project}\": {old} → {stage.Status} (follows its tasks)", stage.ProjectId, old.ToString(), stage.Status.ToString());
            if (stage.Status == StageStatus.Completed && await NextOfAsync(stage, ct) is { } next) queue.Enqueue(next.Id);
        }
        if (changed) await db.SaveChangesAsync(ct);
    }
}
