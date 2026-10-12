using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Enums;
namespace ProjectManagement.Application.Services;

// Rebuild the current permissions for a durable operation. Never restore a saved administrator role.
public static class WorkspaceExecutionPrincipal
{
    public static async Task ConfigureAsync(IServiceProvider sp, Guid userId, Guid tenantId, Guid? teamId, CancellationToken ct)
    {
        var db = sp.GetRequiredService<IAppDbContext>(); var cc = sp.GetRequiredService<CurrentContext>();
        if (!await db.Users.AsNoTracking().AnyAsync(u => u.Id == userId && u.IsActive, ct))
            throw new ForbiddenException("The requester account is inactive.", "ACCOUNT_INACTIVE");
        var member = await db.TenantMembers.AsNoTracking().FirstOrDefaultAsync(m => m.TenantId == tenantId && m.UserId == userId, ct)
            ?? throw new ForbiddenException("The requester is no longer a workspace member.", "NOT_A_MEMBER");
        var tenant = await db.Tenants.IgnoreQueryFilters().AsNoTracking().FirstOrDefaultAsync(t => t.Id == tenantId && !t.IsDeleted && t.Status == TenantStatus.Active, ct)
            ?? throw new ForbiddenException("This workspace is unavailable.", "WORKSPACE_UNAVAILABLE");
        cc.UserId = userId; cc.TenantId = tenantId; cc.Role = member.Role; cc.WorkspaceType = tenant.Type; cc.IsPlatformAdmin = false;
        var permissions = sp.GetRequiredService<PermissionService>();
        cc.ProjectScope = member.Role == TenantRole.Guest ? ProjectScope.Members
            : tenant.ProjectVisibility == ProjectVisibility.Teams && !await permissions.HasAsync(Permissions.ProjectsViewAll, ct) ? ProjectScope.Teams : ProjectScope.None;
        cc.TeamLens = teamId;
        cc.RestrictsProjects = cc.ProjectScope != ProjectScope.None || cc.TeamLens is not null;
        cc.ProjectIds = [];
        if (cc.RestrictsProjects)
        {
            var projects = db.Projects.IgnoreQueryFilters().AsNoTracking().Where(p => p.TenantId == tenantId && !p.IsDeleted);
            if (teamId is { } team) projects = projects.Where(p => p.TeamId == team);
            if (cc.ProjectScope == ProjectScope.Members) projects = projects.Where(p => db.ProjectMembers.Any(m => m.ProjectId == p.Id && m.UserId == userId));
            else if (cc.ProjectScope == ProjectScope.Teams) projects = projects.Where(p => p.OwnerId == userId
                || db.ProjectMembers.Any(m => m.ProjectId == p.Id && m.UserId == userId)
                || p.TeamId != null && db.TeamMembers.Any(m => m.TeamId == p.TeamId && m.UserId == userId));
            cc.ProjectIds = await projects.Select(p => p.Id).ToArrayAsync(ct);
        }
        await sp.GetRequiredService<ProjectAccess>().RequireLensAsync(teamId, ct);
    }
}