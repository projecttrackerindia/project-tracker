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

/// <summary>Project visibility: guests only see projects they are explicitly a member of.</summary>
public class ProjectAccess(IAppDbContext db, ICurrentContext ctx, PermissionService permissions)
{
    public bool IsRestricted => ctx.Role == TenantRole.Guest;

    public IQueryable<Project> VisibleProjects()
    {
        var uid = ctx.UserId;
        return IsRestricted ? db.Projects.Where(p => p.Members.Any(m => m.UserId == uid)) : db.Projects;
    }

    public IQueryable<TaskItem> VisibleTasks()
    {
        var uid = ctx.UserId;
        return IsRestricted
            ? db.Tasks.Where(t => db.ProjectMembers.Any(m => m.ProjectId == t.ProjectId && m.UserId == uid))
            : db.Tasks;
    }

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

    public async Task RequireProjectEditAsync(Project project, CancellationToken ct = default)
    {
        if (await permissions.HasAsync(Permissions.ProjectsEdit, ct)) return;
        // "Members may edit projects they own" is an access-level default; a job-role profile that says view-only means view-only.
        if (project.OwnerId == ctx.UserId && !IsRestricted && !await permissions.HasProfileAsync(ct)) return;
        throw new ForbiddenException("Your role does not allow editing this project.", "PERMISSION_DENIED");
    }
}
