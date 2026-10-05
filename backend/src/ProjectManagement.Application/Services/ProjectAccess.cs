using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Services;

/// <summary>
/// Project visibility. The narrowing itself lives in the data layer (AppDbContext filters on <see cref="ICurrentContext.ProjectScope"/>), so a
/// project, a task and everything that belongs to them is hidden the same way on every screen, report and assistant tool - these helpers
/// only name the intent. Guests reach the projects they were added to; in a workspace limited to teams, people reach their own teams'
/// projects and the ones they own or were added to, unless their role says "see every team's projects".
/// </summary>
public class ProjectAccess(IAppDbContext db, ICurrentContext ctx, PermissionService permissions)
{
    public bool IsRestricted => ctx.ProjectScope != ProjectScope.None;

    public IQueryable<Project> VisibleProjects() => db.Projects;

    public IQueryable<TaskItem> VisibleTasks() => db.Tasks;

    public async Task<Project> GetProjectAsync(Guid id, CancellationToken ct = default) =>
        await VisibleProjects().FirstOrDefaultAsync(p => p.Id == id, ct)
        ?? throw new NotFoundException("Project not found.");

    /// <summary>References to other users (owner, assignee, members) must stay inside the current tenant.</summary>
    public async Task EnsureTenantMemberAsync(Guid userId, string field, CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        if (!await db.TenantMembers.AnyAsync(m => m.TenantId == tid && m.UserId == userId, ct))
            throw new ValidationException(field, "That user is not a member of this workspace.");
    }

    /// <summary>
    /// In a workspace limited to teams, whoever is given work on a project must be able to open it: when they could not (another team, not
    /// added), they are added to the project - the explicit, visible way of sharing it. Nothing happens in other workspaces.
    /// </summary>
    public async Task ShareWithAssigneeAsync(Guid projectId, Guid userId, CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        if (await db.Tenants.Where(t => t.Id == tid).Select(t => t.ProjectVisibility).FirstAsync(ct) != ProjectVisibility.Teams) return;
        var project = await db.Projects.AsNoTracking().Where(p => p.Id == projectId).Select(p => new { p.OwnerId, p.TeamId }).FirstOrDefaultAsync(ct);
        if (project is null || project.OwnerId == userId) return;
        var role = await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid && m.UserId == userId).Select(m => (TenantRole?)m.Role).FirstOrDefaultAsync(ct);
        if (role is null or TenantRole.Owner or TenantRole.Admin) return;
        var sees = await db.ProjectMembers.AnyAsync(m => m.ProjectId == projectId && m.UserId == userId, ct)
            || (project.TeamId is { } team && await db.TeamMembers.AnyAsync(m => m.TeamId == team && m.UserId == userId, ct));
        if (!sees) db.ProjectMembers.Add(new ProjectMember { TenantId = tid, ProjectId = projectId, UserId = userId, CreatedAt = DateTime.UtcNow });
    }

    public async Task RequireProjectEditAsync(Project project, CancellationToken ct = default)
    {
        if (await permissions.HasAsync(Permissions.ProjectsEdit, ct)) return;
        // "Members may edit projects they own" is an access-level default; a job-role profile that says view-only means view-only.
        if (project.OwnerId == ctx.UserId && !IsRestricted && !await permissions.HasProfileAsync(ct)) return;
        throw new ForbiddenException("Your role does not allow editing this project.", "PERMISSION_DENIED");
    }
}
