using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Projects;

/// <summary>What the caller may do with one action item, so the screen only offers what will work.</summary>
public record ActionItemCan(bool Edit, bool Delete, bool Complete);

public record ActionItemDto(Guid Id, Guid ProjectId, string Title, string? Details, UserRefDto? Assignee, DateOnly? DueDate, Priority Priority, ActionItemStatus Status,
    bool IsOverdue, DateTime CreatedAt, UserRefDto? CreatedBy, DateTime? CompletedAt, UserRefDto? CompletedBy, ActionItemCan Can);

public record CreateActionItemRequest(string? Title, string? Details, Guid? AssigneeId, DateOnly? DueDate, Priority? Priority);
/// <summary>All the editable fields at once: what is sent replaces what was there (an empty assignee or due date clears it).</summary>
public record UpdateActionItemRequest(string? Title, string? Details, Guid? AssigneeId, DateOnly? DueDate, Priority Priority, ActionItemStatus Status);
public record SetActionItemStatusRequest(ActionItemStatus Status);

/// <summary>
/// Action items of a project: follow-ups with an owner, a due date and a priority, kept next to the project's status. Anyone who can see the project can
/// read them; people who may create tasks can add them; the person who added an item, the person it is assigned to and managers can change it.
/// </summary>
public class ActionItemService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, PermissionService permissions, ProjectAccess access, NotificationService notifications)
{
    private const int MaxListed = 500;

    // ------------------------------------------------------------------ rules

    private async Task<Project> ViewableProjectAsync(Guid projectId, CancellationToken ct)
    {
        var project = await access.GetProjectAsync(projectId, ct);
        await permissions.RequireModuleAsync(Modules.Projects, AccessLevel.View, ct);
        return project;
    }

    private static void RequireOpen(Project project)
    {
        if (project.Status == ProjectStatus.Archived)
            throw new ConflictException("This project is archived and read-only. Restore it to work on its action items.", "PROJECT_ARCHIVED");
    }

    /// <summary>Whoever oversees the project's work: task editors (managers and up) and the project's owner.</summary>
    private async Task<bool> IsManagerAsync(Project project, CancellationToken ct) =>
        await permissions.HasAsync(Permissions.TasksEdit, ct) || (project.OwnerId == ctx.UserId && !access.IsRestricted);

    private static string CleanTitle(string? title)
    {
        var t = (title ?? "").Trim();
        if (t.Length == 0) throw new ValidationException("title", "Give the action item a short title.");
        if (t.Length > 200) throw new ValidationException("title", "The title can be at most 200 characters.");
        return t;
    }

    private static string? CleanDetails(string? details)
    {
        var d = details?.Replace("\r\n", "\n").Trim();
        if (string.IsNullOrEmpty(d)) return null;
        if (d.Length > 2000) throw new ValidationException("details", "The details can be at most 2000 characters.");
        return d;
    }

    private async Task<ActionItem> FindAsync(Guid projectId, Guid id, CancellationToken ct) =>
        await db.ActionItems.FirstOrDefaultAsync(a => a.Id == id && a.ProjectId == projectId, ct) ?? throw new NotFoundException("Action item not found.", "ACTION_ITEM_NOT_FOUND");

    /// <summary>The assignee must be someone in the workspace who can be given work (not a guest).</summary>
    private async Task CheckAssigneeAsync(Guid? assigneeId, CancellationToken ct)
    {
        if (assigneeId is not { } a) return;
        await access.EnsureTenantMemberAsync(a, "assigneeId", ct);
        var tid = ctx.RequireTenantId();
        if (await db.TenantMembers.AnyAsync(m => m.TenantId == tid && m.UserId == a && m.Role == TenantRole.Guest, ct))
            throw new ValidationException("assigneeId", "Guests cannot be given action items.");
    }

    // ------------------------------------------------------------------ read

    public async Task<IReadOnlyList<ActionItemDto>> ListAsync(Guid projectId, CancellationToken ct = default)
    {
        var project = await ViewableProjectAsync(projectId, ct);
        var all = await db.ActionItems.AsNoTracking().Where(a => a.ProjectId == projectId).OrderByDescending(a => a.CreatedAt).Take(MaxListed).ToListAsync(ct);
        // Open ones first, the soonest due first (undated last), then the more urgent; finished ones after them, the latest finished first.
        var rows = all.OrderBy(a => a.Status == ActionItemStatus.Completed)
            .ThenBy(a => a.Status == ActionItemStatus.Completed ? 0 : a.DueDate is null ? 1 : 0)
            .ThenBy(a => a.Status == ActionItemStatus.Completed ? DateOnly.MinValue : a.DueDate ?? DateOnly.MaxValue)
            .ThenByDescending(a => (int)a.Priority)
            .ThenByDescending(a => a.Status == ActionItemStatus.Completed ? a.CompletedAt : a.CreatedAt).ToList();
        return await ToDtosAsync(project, rows, ct);
    }

    private async Task<IReadOnlyList<ActionItemDto>> ToDtosAsync(Project project, IReadOnlyList<ActionItem> rows, CancellationToken ct)
    {
        if (rows.Count == 0) return [];
        var me = ctx.UserId;
        var manager = await IsManagerAsync(project, ct);
        var canCreate = await permissions.HasAsync(Permissions.TasksCreate, ct);
        var archived = project.Status == ProjectStatus.Archived;
        var today = clock.Today;
        var people = rows.SelectMany(r => new[] { r.AssigneeId, r.CreatedBy, r.CompletedBy }).Where(x => x != null).Select(x => x!.Value).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => people.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        UserRefDto? Ref(Guid? id) => id is { } u && names.TryGetValue(u, out var n) ? new UserRefDto(u, n) : null;

        return rows.Select(r =>
        {
            var mine = r.CreatedBy == me; var assigned = r.AssigneeId == me;
            var can = new ActionItemCan(Edit: !archived && (manager || mine || assigned), Delete: !archived && (manager || (mine && canCreate)), Complete: !archived && (manager || mine || assigned));
            return new ActionItemDto(r.Id, r.ProjectId, r.Title, r.Details, Ref(r.AssigneeId), r.DueDate, r.Priority, r.Status,
                r.Status != ActionItemStatus.Completed && r.DueDate is { } d && d < today, r.CreatedAt, Ref(r.CreatedBy), r.CompletedAt, Ref(r.CompletedBy), can);
        }).ToList();
    }

    private async Task<ActionItemDto> OneAsync(Project project, ActionItem item, CancellationToken ct) => (await ToDtosAsync(project, [item], ct))[0];

    // ------------------------------------------------------------------ write

    private async Task NotifyAssignedAsync(Project project, ActionItem item, CancellationToken ct)
    {
        if (item.AssigneeId is not { } who) return;
        await notifications.AddAsync(who, NotificationType.TaskAssigned, $"Action item assigned to you: {item.Title}", $"{project.Name}{(item.DueDate is { } d ? $" · due {d:dd MMM yyyy}" : "")}",
            $"/project-status?project={project.Id}&actions=1", ct: ct);
    }

    public async Task<ActionItemDto> CreateAsync(Guid projectId, CreateActionItemRequest req, CancellationToken ct = default)
    {
        var project = await ViewableProjectAsync(projectId, ct);
        await permissions.RequireAsync(Permissions.TasksCreate, ct);
        RequireOpen(project);
        var title = CleanTitle(req.Title);
        var details = CleanDetails(req.Details);
        await CheckAssigneeAsync(req.AssigneeId, ct);

        var item = new ActionItem
        {
            TenantId = project.TenantId, ProjectId = projectId, Title = title, Details = details, AssigneeId = req.AssigneeId, DueDate = req.DueDate,
            Priority = req.Priority ?? Priority.Medium, Status = ActionItemStatus.Open, CreatedAt = clock.Now,
        };
        db.ActionItems.Add(item);
        recorder.Activity("actionitem.created", "ActionItem", item.Id, $"Added action item “{title}” to \"{project.Name}\"", projectId);
        await NotifyAssignedAsync(project, item, ct);
        await db.SaveChangesAsync(ct);
        return await OneAsync(project, item, ct);
    }

    public async Task<ActionItemDto> UpdateAsync(Guid projectId, Guid id, UpdateActionItemRequest req, CancellationToken ct = default)
    {
        var project = await ViewableProjectAsync(projectId, ct);
        RequireOpen(project);
        var item = await FindAsync(projectId, id, ct);
        var manager = await IsManagerAsync(project, ct);
        if (!(manager || item.CreatedBy == ctx.UserId || item.AssigneeId == ctx.UserId))
            throw new ForbiddenException("Only the person who added an action item, the person it is assigned to, or a manager can change it.", "PERMISSION_DENIED");

        var title = CleanTitle(req.Title);
        var details = CleanDetails(req.Details);
        await CheckAssigneeAsync(req.AssigneeId, ct);

        var was = item.Status;
        var reassigned = req.AssigneeId != item.AssigneeId;
        item.Title = title; item.Details = details; item.AssigneeId = req.AssigneeId; item.DueDate = req.DueDate; item.Priority = req.Priority;
        ApplyStatus(item, req.Status);
        recorder.Activity("actionitem.updated", "ActionItem", id, was != item.Status ? $"Action item “{title}”: {was} → {item.Status}" : $"Updated action item “{title}”", projectId,
            was.ToString(), item.Status.ToString());
        if (reassigned) await NotifyAssignedAsync(project, item, ct);
        await db.SaveChangesAsync(ct);
        return await OneAsync(project, item, ct);
    }

    public async Task<ActionItemDto> SetStatusAsync(Guid projectId, Guid id, SetActionItemStatusRequest req, CancellationToken ct = default)
    {
        var project = await ViewableProjectAsync(projectId, ct);
        RequireOpen(project);
        var item = await FindAsync(projectId, id, ct);
        var manager = await IsManagerAsync(project, ct);
        if (!(manager || item.CreatedBy == ctx.UserId || item.AssigneeId == ctx.UserId))
            throw new ForbiddenException("Only the person who added an action item, the person it is assigned to, or a manager can change it.", "PERMISSION_DENIED");
        var was = item.Status;
        if (was == req.Status) return await OneAsync(project, item, ct);
        ApplyStatus(item, req.Status);
        recorder.Activity("actionitem.status", "ActionItem", id, $"Action item “{item.Title}”: {was} → {item.Status}", projectId, was.ToString(), item.Status.ToString());
        await db.SaveChangesAsync(ct);
        return await OneAsync(project, item, ct);
    }

    public async Task DeleteAsync(Guid projectId, Guid id, CancellationToken ct = default)
    {
        var project = await ViewableProjectAsync(projectId, ct);
        RequireOpen(project);
        var item = await FindAsync(projectId, id, ct);
        var manager = await IsManagerAsync(project, ct);
        if (!(manager || (item.CreatedBy == ctx.UserId && await permissions.HasAsync(Permissions.TasksCreate, ct))))
            throw new ForbiddenException("Only the person who added an action item, or a manager, can delete it.", "PERMISSION_DENIED");
        db.ActionItems.Remove(item);
        recorder.Activity("actionitem.deleted", "ActionItem", id, $"Deleted action item “{item.Title}”", projectId);
        await db.SaveChangesAsync(ct);
    }

    /// <summary>Completing stamps who and when; reopening clears it.</summary>
    private void ApplyStatus(ActionItem item, ActionItemStatus next)
    {
        if (next == ActionItemStatus.Completed && item.Status != ActionItemStatus.Completed) { item.CompletedAt = clock.Now; item.CompletedBy = ctx.UserId; }
        else if (next != ActionItemStatus.Completed) { item.CompletedAt = null; item.CompletedBy = null; }
        item.Status = next;
    }
}
