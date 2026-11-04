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
            // A filter can only sit on the root of an inheritance hierarchy (one table holding several kinds); those roots get their own
            // filter below, written per kind.
            if (entityType.BaseType is not null || entityType.GetDirectlyDerivedTypes().Any()) continue;
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

        // Every kind of work in the one WorkItems table: same tenant, not deleted, and its project must be reachable - a task's or an issue's
        // project, or the project a work task points at (a work task with no project is workspace work and always reachable). ScopeProjectId is
        // that project for every kind (a generated column): a filter on the root of a hierarchy cannot cast to the kinds, because the same
        // filter is applied when one kind is queried on its own.
        // The project must also still exist: a deleted project's tasks, issues and action items vanish from every list (Today, My work, Portfolio,
        // the meeting review, the plan sheet, the assistant) even where the cascade on delete did not reach them, and come back if it is restored.
        b.Entity<WorkItem>().HasQueryFilter(w => w.TenantId == CurrentTenantId && !w.IsDeleted
            && (!ProjectsRestricted || w.ScopeProjectId == null || ReachableProjects.Contains(w.ScopeProjectId!.Value))
            && (w.ScopeProjectId == null || Projects.Any(p => p.Id == w.ScopeProjectId)));

        // Comments on work: a task's or an issue's comment follows its item (and so the item's project); a work task's comment is
        // workspace-wide, as before.
        b.Entity<WorkItemComment>().HasQueryFilter(c => c.TenantId == CurrentTenantId && !c.IsDeleted
            && (!ProjectsRestricted || EF.Property<string>(c, "ItemType") == "Work" || WorkItems.Any(w => w.Id == c.ItemId)));

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
        static bool IsGuid(System.Reflection.PropertyInfo? pi) => pi is not null && (pi.PropertyType == typeof(Guid) || pi.PropertyType == typeof(Guid?));
        string? prop = null;
        foreach (var name in new[] { "ProjectId", "RelatedProjectId" })
            if (IsGuid(clr.GetProperty(name))) { prop = name; break; }
        var hasTask = IsGuid(clr.GetProperty("TaskId"));
        if (prop is null && !hasTask) return null;
        return e =>
        {
            var self = Expression.Constant(this);
            Expression? guard = null;
            if (prop is not null)
            {
                var key = Expression.Property(e, prop);
                var nullable = key.Type == typeof(Guid?);
                // "The project is one of the projects this request reaches": a plain list the database answers from an index.
                Expression guid = nullable ? Expression.Property(key, "Value") : key;
                var reach = Expression.OrElse(Expression.Not(Expression.Property(self, nameof(ProjectsRestricted))),
                    Expression.Call(typeof(Enumerable), nameof(Enumerable.Contains), [typeof(Guid)], Expression.Property(self, nameof(ReachableProjects)), guid));
                // ... and the project still exists (not deleted): what belonged to a deleted project disappears with it.
                var p = Expression.Parameter(typeof(Project), "p");
                Expression pid = Expression.Property(p, "Id");
                if (nullable) pid = Expression.Convert(pid, typeof(Guid?));
                var alive = Expression.Call(typeof(Queryable), nameof(Queryable.Any), [typeof(Project)],
                    Expression.Property(self, nameof(Projects)), Expression.Lambda(Expression.Equal(pid, key), p));
                guard = Expression.AndAlso(reach, alive);
                if (nullable) guard = Expression.OrElse(Expression.Equal(key, Expression.Constant(null, typeof(Guid?))), guard);
            }
            if (hasTask)
            {
                // The work it is about (a task, or for a few records an issue or action item) must still exist - not deleted, nor in a deleted
                // project. When reach is narrowed, a record keyed only by its task follows that task's project (as before).
                var key = Expression.Property(e, "TaskId");
                var nullable = key.Type == typeof(Guid?);
                Expression AnyOf<T>(Expression set) where T : WorkItem
                {
                    var w = Expression.Parameter(typeof(T), "w");
                    Expression id = Expression.Property(w, "Id");
                    if (nullable) id = Expression.Convert(id, typeof(Guid?));
                    return Expression.Call(typeof(Queryable), nameof(Queryable.Any), [typeof(T)], set, Expression.Lambda(Expression.Equal(id, key), w));
                }
                Expression taskOk = AnyOf<WorkItem>(Expression.Property(self, nameof(WorkItems)));
                if (prop is null)
                    taskOk = Expression.AndAlso(taskOk, Expression.OrElse(Expression.Not(Expression.Property(self, nameof(ProjectsRestricted))), AnyOf<TaskItem>(Expression.Property(self, nameof(Tasks)))));
                if (nullable) taskOk = Expression.OrElse(Expression.Equal(key, Expression.Constant(null, typeof(Guid?))), taskOk);
                guard = guard is null ? taskOk : Expression.AndAlso(guard, taskOk);
            }
            return guard!;
        };
    }

}
