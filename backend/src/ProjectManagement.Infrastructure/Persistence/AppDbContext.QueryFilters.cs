using System.Linq.Expressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Common;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Infrastructure.Persistence;

public partial class AppDbContext
{
    /// <summary>
    /// Defence in depth for tenant isolation: every tenant-owned entity is filtered by the server-resolved tenant,
    /// and soft-deleted rows are hidden. Explicit <c>IgnoreQueryFilters()</c> is only used by system jobs.
    /// </summary>
    private void ApplyQueryFilters(ModelBuilder b)
    {
        foreach (var entityType in b.Model.GetEntityTypes())
        {
            var clr = entityType.ClrType;
            var tenantScoped = typeof(ITenantScoped).IsAssignableFrom(clr);
            var softDelete = typeof(ISoftDelete).IsAssignableFrom(clr);
            if (!tenantScoped && !softDelete) continue;

            var e = Expression.Parameter(clr, "e");
            Expression? body = null;
            if (tenantScoped)
            {
                var tenantId = Expression.Convert(Expression.Property(e, nameof(ITenantScoped.TenantId)), typeof(Guid?));
                var currentTenant = Expression.Property(Expression.Constant(this), nameof(CurrentTenantId));
                body = Expression.Equal(tenantId, currentTenant);
            }
            if (softDelete)
            {
                var notDeleted = Expression.Not(Expression.Property(e, nameof(ISoftDelete.IsDeleted)));
                body = body is null ? notDeleted : Expression.AndAlso(body, notDeleted);
            }
            // Everything that belongs to a project or a task follows who may see that project (see ProjectScope).
            if (tenantScoped && ProjectScoped(clr) is { } guard) body = Expression.AndAlso(body!, guard(e));
            entityType.SetQueryFilter(Expression.Lambda(body!, e));
        }

        // The project itself: whole workspace, or - when this person's reach is narrowed - the projects they own, were added to, or
        // that belong to a team they are in. Written once here so no query, report or assistant tool has to remember it.
        b.Entity<Project>().HasQueryFilter(p => p.TenantId == CurrentTenantId && !p.IsDeleted && (!ProjectsRestricted || ReachableProjects.Contains(p.Id)));

        // A document is hidden the same way everywhere (lists, counts, links, search, assistant tools): its project must be reachable, and its own
        // visibility must let this person in. Owners and admins of the organization are never locked out of a document in their workspace.
        b.Entity<Document>().HasQueryFilter(d => d.TenantId == CurrentTenantId && !d.IsDeleted
            && (CurrentIsOrgAdmin
                || (!DocumentGrants.Any(g => g.DocumentId == d.Id && g.Deny && (g.ExpiresAt == null || g.ExpiresAt > CurrentNow)
                        && ((g.PrincipalType == GrantPrincipal.User && g.PrincipalId == CurrentUserId)
                            || (g.PrincipalType == GrantPrincipal.Team && TeamMembers.Any(m => m.TeamId == g.PrincipalId && m.UserId == CurrentUserId))
                            || (g.PrincipalType == GrantPrincipal.JobRole && TenantMembers.Any(tm => tm.TenantId == d.TenantId && tm.UserId == CurrentUserId && tm.OrgRoleId == g.PrincipalId))))
                    && (DocumentGrants.Any(g => g.DocumentId == d.Id && !g.Deny && (g.ExpiresAt == null || g.ExpiresAt > CurrentNow)
                            && ((g.PrincipalType == GrantPrincipal.User && g.PrincipalId == CurrentUserId)
                                || (g.PrincipalType == GrantPrincipal.Team && TeamMembers.Any(m => m.TeamId == g.PrincipalId && m.UserId == CurrentUserId))
                                || (g.PrincipalType == GrantPrincipal.JobRole && TenantMembers.Any(tm => tm.TenantId == d.TenantId && tm.UserId == CurrentUserId && tm.OrgRoleId == g.PrincipalId))))
                        || ((d.ProjectId == null || !ProjectsRestricted || ReachableProjects.Contains(d.ProjectId.Value))
                            && ((d.Visibility == DocumentVisibility.Project && d.ProjectId != null)
                                || (d.Visibility == DocumentVisibility.Private && d.OwnerId == CurrentUserId)
                                || (d.Visibility == DocumentVisibility.Team && TeamMembers.Any(m => m.TeamId == d.TeamId && m.UserId == CurrentUserId))
                                || (d.Visibility == DocumentVisibility.Organization && !CurrentIsGuest)))))));
    }

    /// <summary>Entities that must not outlive their project's visibility, with the property that points at the project or task.</summary>
    private static readonly HashSet<Type> NotProjectScoped = [typeof(Project), typeof(ProjectMember), typeof(TeamMember), typeof(Team), typeof(TimeEntry), typeof(Document)];

    private Func<ParameterExpression, Expression>? ProjectScoped(Type clr)
    {
        if (NotProjectScoped.Contains(clr)) return null;
        string? prop = null;
        foreach (var name in new[] { "ProjectId", "RelatedProjectId" })
            if (clr.GetProperty(name) is { } pi && (pi.PropertyType == typeof(Guid) || pi.PropertyType == typeof(Guid?))) { prop = name; break; }
        var viaTask = prop is null && clr.GetProperty("TaskId") is { } ti && (ti.PropertyType == typeof(Guid) || ti.PropertyType == typeof(Guid?));
        if (prop is null && !viaTask) return null;
        return e =>
        {
            var key = Expression.Property(e, prop ?? "TaskId");
            var nullable = key.Type == typeof(Guid?);
            var unrestricted = Expression.Not(Expression.Property(Expression.Constant(this), nameof(ProjectsRestricted)));
            Expression allowed;
            if (viaTask)
            {
                var t = Expression.Parameter(typeof(TaskItem), "t");
                Expression id = Expression.Property(t, "Id");
                if (nullable) id = Expression.Convert(id, typeof(Guid?));
                allowed = Expression.Call(typeof(Queryable), nameof(Queryable.Any), [typeof(TaskItem)],
                    Expression.Property(Expression.Constant(this), nameof(Tasks)), Expression.Lambda(Expression.Equal(id, key), t));
            }
            else
            {
                // "The project is one of the projects this request reaches": a plain list the database answers from an index.
                Expression guid = nullable ? Expression.Property(key, "Value") : key;
                allowed = Expression.Call(typeof(Enumerable), nameof(Enumerable.Contains), [typeof(Guid)], Expression.Property(Expression.Constant(this), nameof(ReachableProjects)), guid);
            }
            Expression guard = Expression.OrElse(unrestricted, allowed);
            return nullable ? Expression.OrElse(Expression.Equal(key, Expression.Constant(null, typeof(Guid?))), guard) : guard;
        };
    }

}
