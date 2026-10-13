using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Tasks;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Projects;

public partial class ProjectService
{
    // ---------------------------------------------------------------- timeline stages

    public async Task<IReadOnlyList<StageDto>> GetStagesAsync(Guid projectId, CancellationToken ct = default)
    {
        var today = clock.Today;
        var projectStatus = await db.Projects.AsNoTracking().Where(p => p.Id == projectId).Select(p => p.Status).FirstOrDefaultAsync(ct);
        var rows = await (from s in db.ProjectStages
                          join o in db.Users on s.OwnerId equals (Guid?)o.Id into owners
                          from owner in owners.DefaultIfEmpty()
                          join a in db.Users on s.AssigneeId equals (Guid?)a.Id into assignees
                          from assignee in assignees.DefaultIfEmpty()
                          where s.ProjectId == projectId
                          orderby s.Order
                          select new { Stage = s, OwnerName = owner.DisplayName, AssigneeName = assignee.DisplayName })
            .AsNoTracking().ToListAsync(ct);
        // Progress of a stage = its top-level tasks (cancelled ones do not count), the same rule that completes it.
        var counts = (await db.Tasks.AsNoTracking()
            .Where(t => t.ProjectId == projectId && t.StageId != null && t.ParentTaskId == null && t.Status!.Category != StatusCategory.Cancelled)
            .GroupBy(t => t.StageId)
            .Select(g => new { StageId = g.Key, Total = g.Count(), Done = g.Count(t => t.Status!.Category == StatusCategory.Done) })
            .ToListAsync(ct)).ToDictionary(x => x.StageId!.Value);
        // Test issues found in a stage: the open ones keep it from completing.
        var issues = (await db.StageIssues.AsNoTracking().Where(i => i.ProjectId == projectId && i.StageId != null)
            .GroupBy(i => i.StageId)
            .Select(g => new { StageId = g.Key, Total = g.Count(), Open = g.Count(i => i.Status != IssueStatus.Resolved) })
            .ToListAsync(ct)).ToDictionary(x => x.StageId!.Value);
        return rows.Select((r, i) =>
        {
            // Locked while the stage before it is unfinished, so the timeline can only be worked through in order.
            var previous = i > 0 ? rows[i - 1].Stage : null;
            var locked = StageSequence.IsLocked(previous, r.Stage.Status);
            return new StageDto(r.Stage.Id, r.Stage.Name, r.Stage.Order, r.Stage.PlannedStart, r.Stage.PlannedEnd,
                r.Stage.ActualStart, r.Stage.ActualEnd, r.Stage.Status, ProjectMetrics.EffectiveStage(r.Stage, today, projectStatus),
                r.OwnerName is null ? null : new UserRefDto(r.Stage.OwnerId!.Value, r.OwnerName),
                r.AssigneeName is null ? null : new UserRefDto(r.Stage.AssigneeId!.Value, r.AssigneeName),
                r.Stage.Description,
                counts.TryGetValue(r.Stage.Id, out var c) ? c.Total : 0, counts.TryGetValue(r.Stage.Id, out var d) ? d.Done : 0,
                locked, locked ? previous!.Name : null,
                issues.TryGetValue(r.Stage.Id, out var iss) ? iss.Open : 0, iss?.Total ?? 0, StageScheduler.Duration(r.Stage.DurationDays, r.Stage.PlannedStart, r.Stage.PlannedEnd));
        }).ToList();
    }

    /// <summary>Change only a confirmed stage plan; preserve actuals, assignments, status and dependency locks.</summary>
    public async Task UpdateStagePlanAsync(Guid projectId, Guid stageId, DateOnly? start, DateOnly? end,
        DateOnly? previousStart, DateOnly? previousEnd, StageStatus expectedStatus, string? reason, CancellationToken ct = default, int? expectedProjectVersion = null, int? durationDays = null)
    {
        var project = await access.GetProjectAsync(projectId, ct);
        await access.RequireProjectEditAsync(project, ct);
        RequireScheduleVersion(project, expectedProjectVersion);
        if (start is { } ps && end is { } pe && pe < ps) throw new ValidationException("plannedEnd", "Planned end must not be before planned start.");
        if (expectedStatus == StageStatus.Completed) throw new ConflictException("Completed stage history cannot be changed through this suggestion.", "STAGE_COMPLETED");
        if (end is { } ne && previousEnd is { } oe && ne > oe && string.IsNullOrWhiteSpace(reason))
            throw new ValidationException("reason", "Moving a stage's planned end later needs a reason.");
        await using var tx = await db.Database.BeginOwnedTransactionAsync(ct);
        var stage = await db.ProjectStages.AsNoTracking().SingleOrDefaultAsync(s => s.Id == stageId && s.ProjectId == projectId, ct)
            ?? throw new NotFoundException("Stage not found.");
        if (project.StageScheduleMode != StageScheduleMode.Manual)
        {
            var all = await db.ProjectStages.Where(s => s.ProjectId == projectId).OrderBy(s => s.Order).ToListAsync(ct);
            var current = all.Single(s => s.Id == stageId);
            if (current.PlannedStart != previousStart || current.PlannedEnd != previousEnd || current.Status != expectedStatus)
                throw new ConflictException("The stage changed after this suggestion. Review the timeline and prepare a new suggestion.", "VERSION_CONFLICT");
            current.DurationDays = durationDays ?? StageScheduler.Duration(null, start, end);
            if (durationDays is not null && start is { } s && end is { } e && e.DayNumber - s.DayNumber != durationDays)
                throw new ValidationException("durationDays", "The planned dates and allocated duration do not match.");
            FinishStageSchedule(project, all, all.IndexOf(current), start, reason);
            await db.SaveChangesAsync(ct); await tx.CommitIfOwnedAsync(ct); return;
        }
        // Compare and update atomically: a stale card cannot overwrite a newer schedule or completed stage.
        var allocatedDays = durationDays ?? StageScheduler.Duration(null, start, end);
        if (allocatedDays is < 0 or > 36500) throw new ValidationException("durationDays", "Use 0 to 36500 calendar days.");
        var changed = await db.ProjectStages.Where(s => s.Id == stageId && s.ProjectId == projectId && s.PlannedStart == previousStart && s.PlannedEnd == previousEnd && s.Status == expectedStatus)
            .ExecuteUpdateAsync(set => set.SetProperty(s => s.PlannedStart, start).SetProperty(s => s.PlannedEnd, end).SetProperty(s => s.DurationDays, allocatedDays).SetProperty(s => s.UpdatedAt, clock.Now), ct);
        project.Version++;
        if (changed != 1) throw new ConflictException("The stage changed after this suggestion. Review the timeline and prepare a new suggestion.", "VERSION_CONFLICT");
        recorder.Activity("project.stage_dates_changed", "Project", projectId,
            $"Stage \"{stage.Name}\" planned dates: {previousStart:yyyy-MM-dd}–{previousEnd:yyyy-MM-dd} → {start:yyyy-MM-dd}–{end:yyyy-MM-dd}. {reason}".Trim(), projectId);
        recorder.Audit("project.stage_dates_changed", "ProjectStage", stageId,
            $"{previousStart:yyyy-MM-dd}/{previousEnd:yyyy-MM-dd}", $"{start:yyyy-MM-dd}/{end:yyyy-MM-dd}");
        await db.SaveChangesAsync(ct);
        await tx.CommitIfOwnedAsync(ct);
    }

    private async Task ApplyStageAsync(ProjectStage stage, UpsertStageRequest req, CancellationToken ct)
    {
        if (req.PlannedStart is { } ps && req.PlannedEnd is { } pe && pe < ps)
            throw new ValidationException("plannedEnd", "Planned end must not be before planned start.");
        if (req.Status == StageStatus.Completed && await completion.OpenTaskCountAsync(stage.Id, ct) is var open and > 0)
            throw new ConflictException(
                $"Unable to complete this stage. {open} task{(open == 1 ? " is" : "s are")} still open. A stage is completed once all of its tasks are completed.",
                TaskCompletionService.StageOpenTasksCode);
        if (req.Status == StageStatus.Completed && await completion.OpenIssueCountAsync(stage.Id, ct) is var openIssues and > 0)
            throw new ConflictException(
                $"Unable to complete this stage. {openIssues} test issue{(openIssues == 1 ? " is" : "s are")} still unresolved. Fix and resolve {(openIssues == 1 ? "it" : "them")} first, then complete the stage.",
                TaskCompletionService.StageOpenIssuesCode);
        if (req.OwnerId is { } o) await access.EnsureTenantMemberAsync(o, "ownerId", ct);
        if (req.AssigneeId is { } a) await access.EnsureTenantMemberAsync(a, "assigneeId", ct);

        var today = clock.Today;
        stage.Name = req.Name.Trim();
        if (req.DurationDays is < 0 or > 36500) throw new ValidationException("durationDays", "Use 0 to 36500 calendar days; zero represents a milestone.");
        stage.DurationDays = req.DurationDays ?? StageScheduler.Duration(null, req.PlannedStart, req.PlannedEnd) ?? stage.DurationDays;
        stage.PlannedStart = req.PlannedStart; stage.PlannedEnd = req.PlannedEnd;
        stage.ActualStart = req.ActualStart; stage.ActualEnd = req.ActualEnd;
        stage.OwnerId = req.OwnerId; stage.AssigneeId = req.AssigneeId;
        stage.Description = req.Description?.Trim();
        stage.Status = req.Status;
        if (req.Status is StageStatus.InProgress or StageStatus.Completed) stage.ActualStart ??= today;
        if (req.Status == StageStatus.Completed) stage.ActualEnd ??= today;
        if (req.Status is StageStatus.Pending or StageStatus.InProgress) stage.ActualEnd = null;
    }

    public async Task<IReadOnlyList<StageDto>> CreateStageAsync(Guid projectId, UpsertStageRequest req, CancellationToken ct = default)
    {
        var project = await access.GetProjectAsync(projectId, ct);
        await access.RequireProjectEditAsync(project, ct);
        RequireScheduleVersion(project, req.ProjectVersion);
        var stages = await db.ProjectStages.Where(s => s.ProjectId == projectId).OrderBy(s => s.Order).ToListAsync(ct);
        var stage = new ProjectStage { TenantId = project.TenantId, ProjectId = projectId, CreatedAt = clock.Now };

        // Insert at the requested position, shifting later stages down. The stage before it decides whether it may already be started.
        var index = Math.Clamp(req.Order ?? stages.Count, 0, stages.Count);
        stages.Insert(index, stage);
        StageSequence.EnsureAllowed(StageSequence.PreviousOf(stages, stage), stage, req.Status);
        await ApplyStageAsync(stage, req, ct);
        for (var i = 0; i < stages.Count; i++) stages[i].Order = i;
        db.ProjectStages.Add(stage);
        FinishStageSchedule(project, stages, index, req.PlannedStart, req.ScheduleReason);
        recorder.Activity("project.stage_added", "Project", projectId, $"Added stage \"{stage.Name}\" to \"{project.Name}\"", projectId);
        await db.SaveChangesAsync(ct);
        await completion.SyncStagesAsync([StageSequence.NextOf(stages, stage)?.Id], ct);
        return await GetStagesAsync(projectId, ct);
    }

    public async Task<IReadOnlyList<StageDto>> UpdateStageAsync(Guid projectId, Guid stageId, UpsertStageRequest req, CancellationToken ct = default)
    {
        var project = await access.GetProjectAsync(projectId, ct);
        await access.RequireProjectEditAsync(project, ct);
        RequireScheduleVersion(project, req.ProjectVersion);
        var stages = await db.ProjectStages.Where(s => s.ProjectId == projectId).OrderBy(s => s.Order).ToListAsync(ct);
        var stage = stages.FirstOrDefault(s => s.Id == stageId) ?? throw new NotFoundException("Stage not found.");
        var old = stage.Status;
        var oldStart = stage.PlannedStart; var oldEnd = stage.PlannedEnd; var oldDuration = stage.DurationDays;
        if (project.StageScheduleMode != StageScheduleMode.Manual)
        {
            var days = req.DurationDays ?? (req.PlannedStart is { } ns && ns != oldStart && (req.PlannedEnd is null || req.PlannedEnd == oldEnd)
                ? StageScheduler.Duration(oldDuration, oldStart, oldEnd) : null);
            if (days is < 0 or > 36500) throw new ValidationException("durationDays", "Use 0 to 36500 calendar days.");
            var start = req.PlannedStart ?? oldStart; var end = req.PlannedEnd ?? oldEnd;
            if (days is { } d && start is { } s && (req.PlannedEnd is null || req.PlannedEnd == oldEnd))
            {
                if ((long)s.DayNumber + d > DateOnly.MaxValue.DayNumber) throw new ValidationException("schedule", "The duration exceeds the supported calendar.");
                end = s.AddDays(d);
            }
            req = req with { PlannedStart = start, PlannedEnd = end, DurationDays = days };
        }
        if (project.StageScheduleMode != StageScheduleMode.Manual && old == StageStatus.Completed &&
            (req.PlannedStart != oldStart || req.PlannedEnd != oldEnd || (req.DurationDays is { } proposedDuration && proposedDuration != StageScheduler.Duration(oldDuration, oldStart, oldEnd))))
            throw new ValidationException("schedule", "Completed stage plans are protected from automatic rescheduling.");

        // Work out where the stage will sit first: what comes before it decides whether it may be started or completed.
        if (req.Order is { } order && order != stage.Order)
        {
            stages.Remove(stage);
            stages.Insert(Math.Clamp(order, 0, stages.Count), stage);
        }
        StageSequence.EnsureAllowed(StageSequence.PreviousOf(stages, stage), stage, req.Status);
        await ApplyStageAsync(stage, req, ct);
        if (project.StageScheduleMode != StageScheduleMode.Manual)
        {
            if (req.DurationDays is { } allocated)
            {
                // A duration edit changes the end; a start edit keeps the allocated duration.
                if (req.PlannedStart is { } ps && req.PlannedEnd is { } pe && req.PlannedEnd != oldEnd && pe.DayNumber - ps.DayNumber != allocated)
                    throw new ValidationException("durationDays", "The planned dates and allocated duration do not match.");
            }
            stage.PlannedStart ??= oldStart;
            FinishStageSchedule(project, stages, stages.IndexOf(stage), stage.PlannedStart, req.ScheduleReason);
        }
        for (var i = 0; i < stages.Count; i++) stages[i].Order = i;

        if (old != stage.Status)
            recorder.Activity("project.stage_status", "Project", projectId, $"Stage \"{stage.Name}\" of \"{project.Name}\": {old} → {stage.Status}", projectId, old.ToString(), stage.Status.ToString());
        await db.SaveChangesAsync(ct);
        // Finishing a stage opens the next one (whose own tasks may already say where it stands).
        await completion.SyncStagesAsync([StageSequence.NextOf(stages, stage)?.Id], ct);
        return await GetStagesAsync(projectId, ct);
    }

    /// <summary>
    /// Saves a new order for the whole timeline. Nothing about a stage's own state changes, but who is locked does: a stage is locked
    /// while the one before it is unfinished, so moving stages around can open some and hold back others (never complete anything).
    /// </summary>
    public async Task<IReadOnlyList<StageDto>> ReorderStagesAsync(Guid projectId, ReorderStagesRequest req, CancellationToken ct = default)
    {
        var project = await access.GetProjectAsync(projectId, ct);
        await access.RequireProjectEditAsync(project, ct);
        RequireScheduleVersion(project, req.ProjectVersion);
        var stages = await db.ProjectStages.Where(s => s.ProjectId == projectId).OrderBy(s => s.Order).ToListAsync(ct);
        var wanted = req.StageIds ?? [];
        if (wanted.Count != stages.Count || wanted.Distinct().Count() != wanted.Count || stages.Any(s => !wanted.Contains(s.Id)))
            throw new ValidationException("stageIds", "List every stage of this project exactly once.");

        var before = string.Join(", ", stages.Select(s => s.Name));
        for (var i = 0; i < wanted.Count; i++) stages.First(s => s.Id == wanted[i]).Order = i;
        var after = string.Join(", ", stages.OrderBy(s => s.Order).Select(s => s.Name));
        FinishStageSchedule(project, stages.OrderBy(s => s.Order).ToList(), 0, null, req.ScheduleReason);
        if (before != after)
            recorder.Activity("project.timeline_reordered", "Project", projectId, $"Reordered the timeline of \"{project.Name}\": {after}", projectId);
        await db.SaveChangesAsync(ct);
        // The stages that are now next in line may already have all their tasks done.
        await completion.SyncStagesAsync(stages.Select(s => (Guid?)s.Id), ct);
        return await GetStagesAsync(projectId, ct);
    }

    public async Task<IReadOnlyList<StageDto>> DeleteStageAsync(Guid projectId, Guid stageId, CancellationToken ct = default, int? projectVersion = null)
    {
        var project = await access.GetProjectAsync(projectId, ct);
        await access.RequireProjectEditAsync(project, ct);
        var stages = await db.ProjectStages.Where(s => s.ProjectId == projectId).OrderBy(s => s.Order).ToListAsync(ct);
        var stage = stages.FirstOrDefault(s => s.Id == stageId) ?? throw new NotFoundException("Stage not found.");
        var index = stages.IndexOf(stage);
        RequireScheduleVersion(project, projectVersion);
        db.ProjectStages.Remove(stage);
        stages.Remove(stage);
        for (var i = 0; i < stages.Count; i++) stages[i].Order = i;
        FinishStageSchedule(project, stages, Math.Min(index, stages.Count), null, null);
        await db.SaveChangesAsync(ct);
        // The stage that now follows the one before it may have just become available.
        if (index < stages.Count) await completion.SyncStagesAsync([stages[index].Id], ct);
        return await GetStagesAsync(projectId, ct);
    }
}
