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
                issues.TryGetValue(r.Stage.Id, out var iss) ? iss.Open : 0, iss?.Total ?? 0);
        }).ToList();
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
        var stages = await db.ProjectStages.Where(s => s.ProjectId == projectId).OrderBy(s => s.Order).ToListAsync(ct);
        var stage = new ProjectStage { TenantId = project.TenantId, ProjectId = projectId, CreatedAt = clock.Now };

        // Insert at the requested position, shifting later stages down. The stage before it decides whether it may already be started.
        var index = Math.Clamp(req.Order ?? stages.Count, 0, stages.Count);
        stages.Insert(index, stage);
        StageSequence.EnsureAllowed(StageSequence.PreviousOf(stages, stage), stage, req.Status);
        await ApplyStageAsync(stage, req, ct);
        for (var i = 0; i < stages.Count; i++) stages[i].Order = i;
        db.ProjectStages.Add(stage);
        recorder.Activity("project.stage_added", "Project", projectId, $"Added stage \"{stage.Name}\" to \"{project.Name}\"", projectId);
        await db.SaveChangesAsync(ct);
        await completion.SyncStagesAsync([StageSequence.NextOf(stages, stage)?.Id], ct);
        return await GetStagesAsync(projectId, ct);
    }

    public async Task<IReadOnlyList<StageDto>> UpdateStageAsync(Guid projectId, Guid stageId, UpsertStageRequest req, CancellationToken ct = default)
    {
        var project = await access.GetProjectAsync(projectId, ct);
        await access.RequireProjectEditAsync(project, ct);
        var stages = await db.ProjectStages.Where(s => s.ProjectId == projectId).OrderBy(s => s.Order).ToListAsync(ct);
        var stage = stages.FirstOrDefault(s => s.Id == stageId) ?? throw new NotFoundException("Stage not found.");
        var old = stage.Status;

        // Work out where the stage will sit first: what comes before it decides whether it may be started or completed.
        if (req.Order is { } order && order != stage.Order)
        {
            stages.Remove(stage);
            stages.Insert(Math.Clamp(order, 0, stages.Count), stage);
        }
        StageSequence.EnsureAllowed(StageSequence.PreviousOf(stages, stage), stage, req.Status);
        await ApplyStageAsync(stage, req, ct);
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
        var stages = await db.ProjectStages.Where(s => s.ProjectId == projectId).OrderBy(s => s.Order).ToListAsync(ct);
        var wanted = req.StageIds ?? [];
        if (wanted.Count != stages.Count || wanted.Distinct().Count() != wanted.Count || stages.Any(s => !wanted.Contains(s.Id)))
            throw new ValidationException("stageIds", "List every stage of this project exactly once.");

        var before = string.Join(", ", stages.Select(s => s.Name));
        for (var i = 0; i < wanted.Count; i++) stages.First(s => s.Id == wanted[i]).Order = i;
        var after = string.Join(", ", stages.OrderBy(s => s.Order).Select(s => s.Name));
        if (before != after)
            recorder.Activity("project.timeline_reordered", "Project", projectId, $"Reordered the timeline of \"{project.Name}\": {after}", projectId);
        await db.SaveChangesAsync(ct);
        // The stages that are now next in line may already have all their tasks done.
        await completion.SyncStagesAsync(stages.Select(s => (Guid?)s.Id), ct);
        return await GetStagesAsync(projectId, ct);
    }

    public async Task<IReadOnlyList<StageDto>> DeleteStageAsync(Guid projectId, Guid stageId, CancellationToken ct = default)
    {
        var project = await access.GetProjectAsync(projectId, ct);
        await access.RequireProjectEditAsync(project, ct);
        var stages = await db.ProjectStages.Where(s => s.ProjectId == projectId).OrderBy(s => s.Order).ToListAsync(ct);
        var stage = stages.FirstOrDefault(s => s.Id == stageId) ?? throw new NotFoundException("Stage not found.");
        var index = stages.IndexOf(stage);
        db.ProjectStages.Remove(stage);
        stages.Remove(stage);
        for (var i = 0; i < stages.Count; i++) stages[i].Order = i;
        await db.SaveChangesAsync(ct);
        // The stage that now follows the one before it may have just become available.
        if (index < stages.Count) await completion.SyncStagesAsync([stages[index].Id], ct);
        return await GetStagesAsync(projectId, ct);
    }
}
