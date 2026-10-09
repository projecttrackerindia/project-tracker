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
    // ---------------------------------------------------------------- workflow statuses (per project)

    public async Task<IReadOnlyList<StatusDto>> GetStatusesAsync(Guid projectId, CancellationToken ct = default) =>
        await db.WorkflowStatuses.AsNoTracking().Where(s => s.ProjectId == projectId).OrderBy(s => s.Order)
            .Select(s => new StatusDto(s.Id, s.Name, s.Order, s.Category, s.Color)).ToListAsync(ct);

    private async Task<Project> RequireWorkflowAccessAsync(Guid projectId, CancellationToken ct)
    {
        await permissions.RequireAsync(Permissions.WorkflowManage, ct);
        await entitlements.EnsureFeatureAsync(FeatureKeys.CustomWorkflows, ct);
        return await access.GetProjectAsync(projectId, ct);
    }

    public async Task<IReadOnlyList<StatusDto>> CreateStatusAsync(Guid projectId, UpsertStatusRequest req, CancellationToken ct = default)
    {
        var project = await RequireWorkflowAccessAsync(projectId, ct);
        var existing = await db.WorkflowStatuses.Where(s => s.ProjectId == projectId).ToListAsync(ct);
        if (existing.Any(s => s.Name.Equals(req.Name.Trim(), StringComparison.OrdinalIgnoreCase)))
            throw new ConflictException("A status with this name already exists.", "STATUS_EXISTS");
        db.WorkflowStatuses.Add(new WorkflowStatus
        {
            TenantId = project.TenantId, ProjectId = projectId, Name = req.Name.Trim(), Category = req.Category,
            Color = req.Color ?? "#8b5cf6", Order = req.Order ?? (existing.Count == 0 ? 0 : existing.Max(s => s.Order) + 1), CreatedAt = clock.Now,
        });
        recorder.Activity("workflow.status_added", "Project", projectId, $"Added status \"{req.Name.Trim()}\" to \"{project.Name}\"", projectId);
        await db.SaveChangesAsync(ct);
        return await GetStatusesAsync(projectId, ct);
    }

    public async Task<IReadOnlyList<StatusDto>> UpdateStatusAsync(Guid projectId, Guid statusId, UpsertStatusRequest req, CancellationToken ct = default)
    {
        await RequireWorkflowAccessAsync(projectId, ct);
        var all = await db.WorkflowStatuses.Where(s => s.ProjectId == projectId).ToListAsync(ct);
        var status = all.FirstOrDefault(s => s.Id == statusId) ?? throw new NotFoundException("Status not found.");
        if (all.Any(s => s.Id != statusId && s.Name.Equals(req.Name.Trim(), StringComparison.OrdinalIgnoreCase)))
            throw new ConflictException("A status with this name already exists.", "STATUS_EXISTS");

        if (status.Category != req.Category)
        {
            var remaining = all.Where(s => s.Id != statusId).Select(s => s.Category).ToList();
            if (status.Category is StatusCategory.Todo or StatusCategory.Done && !remaining.Contains(status.Category))
                throw new ConflictException($"A project needs at least one {status.Category} status.", "STATUS_REQUIRED");
        }
        status.Name = req.Name.Trim(); status.Category = req.Category;
        if (req.Color is not null) status.Color = req.Color;
        if (req.Order is { } order) status.Order = order;

        // Tasks moved into / out of a Done category keep completion timestamps consistent.
        var tasks = await db.Tasks.Where(t => t.StatusId == statusId).ToListAsync(ct);
        foreach (var t in tasks)
            t.CompletedAt = req.Category == StatusCategory.Done ? t.CompletedAt ?? clock.Now : null;
        await db.SaveChangesAsync(ct);
        // Tasks that just became (or stopped being) done change how far their stages have got.
        await completion.SyncStagesAsync(tasks.Select(t => t.StageId), ct);
        return await GetStatusesAsync(projectId, ct);
    }

    public async Task<IReadOnlyList<StatusDto>> ReorderStatusesAsync(Guid projectId, ReorderStatusesRequest req, CancellationToken ct = default)
    {
        var project = await RequireWorkflowAccessAsync(projectId, ct);
        var all = await db.WorkflowStatuses.Where(s => s.ProjectId == projectId).ToListAsync(ct);
        var wanted = req.StatusIds ?? [];
        if (wanted.Count != all.Count || wanted.Distinct().Count() != wanted.Count || all.Any(s => !wanted.Contains(s.Id)))
            throw new ValidationException("statusIds", "List every status of this project exactly once.");
        var before = string.Join(", ", all.OrderBy(s => s.Order).Select(s => s.Name));
        for (var i = 0; i < wanted.Count; i++) all.First(s => s.Id == wanted[i]).Order = i;
        var after = string.Join(", ", all.OrderBy(s => s.Order).Select(s => s.Name));
        if (before != after) recorder.Activity("project.workflow_reordered", "Project", projectId, $"Reordered the workflow of \"{project.Name}\": {after}", projectId);
        await db.SaveChangesAsync(ct);
        return await GetStatusesAsync(projectId, ct);
    }

    public async Task<IReadOnlyList<StatusDto>> DeleteStatusAsync(Guid projectId, Guid statusId, CancellationToken ct = default)
    {
        await RequireWorkflowAccessAsync(projectId, ct);
        var all = await db.WorkflowStatuses.Where(s => s.ProjectId == projectId).ToListAsync(ct);
        var status = all.FirstOrDefault(s => s.Id == statusId) ?? throw new NotFoundException("Status not found.");
        if (await db.Tasks.IgnoreQueryFilters().AnyAsync(t => t.StatusId == statusId && !t.IsDeleted, ct))
            throw new ConflictException("Move the tasks in this status before deleting it.", "STATUS_IN_USE");
        if (status.Category is StatusCategory.Todo or StatusCategory.Done && all.Count(s => s.Category == status.Category) == 1)
            throw new ConflictException($"A project needs at least one {status.Category} status.", "STATUS_REQUIRED");
        db.WorkflowStatuses.Remove(status);
        await db.SaveChangesAsync(ct);
        return await GetStatusesAsync(projectId, ct);
    }
}
