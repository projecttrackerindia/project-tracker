using Microsoft.EntityFrameworkCore;

using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Projects;

/// <summary>A group with how many projects it holds (the ones the caller can see) and how many of those are not archived.</summary>
public record ProjectGroupDto(Guid Id, string Name, string? Description, int Order, bool IsActive, int ProjectCount, int ActiveProjectCount);

public record UpsertProjectGroupRequest(string? Name, string? Description, bool? IsActive);
public record ReorderProjectGroupsRequest(IReadOnlyList<Guid>? GroupIds);

/// <summary>
/// The workspace's master list of project groups. Anyone who can see projects can read it (the pickers and the status page use it);
/// changing it needs the "manage project groups" permission. The rules keep the list usable: names are unique, there is always at least one
/// active group to create projects in, and a group that still holds projects is only deleted after they have been moved.
/// </summary>
public class ProjectGroupService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, PermissionService permissions, ProjectAccess access)
{
    public const string DefaultName = "Other Projects";
    public const string InUseCode = "PROJECT_GROUP_IN_USE";
    public const string LastActiveCode = "PROJECT_GROUP_LAST_ACTIVE";

    // ------------------------------------------------------------------ read

    /// <summary>
    /// A workspace always has a group to put projects in: the first time anyone asks, an empty workspace gets the default one ("Other Projects"),
    /// which the owner can rename. (Done here, in the workspace's own context, rather than when the workspace is created.)
    /// </summary>
    public async Task EnsureDefaultAsync(CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        if (await db.ProjectGroups.AnyAsync(ct)) return;
        var group = new ProjectGroup { TenantId = tid, Name = DefaultName, Order = 0, IsActive = true, CreatedAt = clock.Now };
        db.ProjectGroups.Add(group);
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateException)   // two requests did this at the same moment: the other one won, which is fine
        {
            db.ProjectGroups.Remove(group);
        }
    }

    public async Task<IReadOnlyList<ProjectGroupDto>> ListAsync(bool activeOnly = false, CancellationToken ct = default)
    {
        ctx.RequireTenantId();
        await permissions.RequireModuleAsync(Modules.Projects, AccessLevel.View, ct);
        await EnsureDefaultAsync(ct);
        var q = db.ProjectGroups.AsNoTracking().AsQueryable();
        if (activeOnly) q = q.Where(g => g.IsActive);
        var groups = await q.OrderBy(g => g.Order).ThenBy(g => g.Name).ToListAsync(ct);

        var counts = await access.VisibleProjects().AsNoTracking().Where(p => p.ProjectGroupId != null)
            .GroupBy(p => p.ProjectGroupId!.Value).Select(g => new { g.Key, Total = g.Count(), Active = g.Count(p => p.Status != ProjectStatus.Archived) })
            .ToDictionaryAsync(x => x.Key, ct);
        return groups.Select(g => new ProjectGroupDto(g.Id, g.Name, g.Description, g.Order, g.IsActive,
            counts.TryGetValue(g.Id, out var c) ? c.Total : 0, counts.TryGetValue(g.Id, out var c2) ? c2.Active : 0)).ToList();
    }

    /// <summary>The group a project is put in when nothing else is said (used by imports and start-up): the first active one.</summary>
    public async Task<Guid?> DefaultGroupIdAsync(CancellationToken ct = default)
    {
        await EnsureDefaultAsync(ct);
        return await db.ProjectGroups.AsNoTracking().Where(g => g.IsActive).OrderBy(g => g.Order).Select(g => (Guid?)g.Id).FirstOrDefaultAsync(ct);
    }

    // ------------------------------------------------------------------ write

    private static string CleanName(string? name)
    {
        var n = (name ?? "").Trim();
        if (n.Length < 2 || n.Length > 60) throw new ValidationException("name", "A group name needs 2 to 60 characters.");
        return n;
    }

    private static string? CleanDescription(string? text)
    {
        var d = text?.Trim();
        if (string.IsNullOrEmpty(d)) return null;
        if (d.Length > 200) throw new ValidationException("description", "The description can be at most 200 characters.");
        return d;
    }

    private async Task EnsureNameFreeAsync(string name, Guid? except, CancellationToken ct)
    {
        var lower = name.ToLower();
        if (await db.ProjectGroups.AnyAsync(g => g.Id != except && g.Name.ToLower() == lower, ct))
            throw new ValidationException("name", "A project group with this name already exists.");
    }

    private async Task<ProjectGroupDto> DtoAsync(Guid id, CancellationToken ct) => (await ListAsync(false, ct)).First(g => g.Id == id);

    public async Task<ProjectGroupDto> CreateAsync(UpsertProjectGroupRequest req, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.ProjectGroupsManage, ct);
        var tid = ctx.RequireTenantId();
        await EnsureDefaultAsync(ct);
        var name = CleanName(req.Name);
        await EnsureNameFreeAsync(name, null, ct);
        if (await db.ProjectGroups.CountAsync(ct) >= 100) throw new ValidationException("name", "A workspace can have up to 100 project groups.");

        var order = (await db.ProjectGroups.MaxAsync(g => (int?)g.Order, ct) ?? -1) + 1;
        var group = new ProjectGroup { TenantId = tid, Name = name, Description = CleanDescription(req.Description), Order = order, IsActive = req.IsActive ?? true, CreatedAt = clock.Now };
        db.ProjectGroups.Add(group);
        recorder.Audit("projectgroup.created", "ProjectGroup", group.Id, newValue: new { group.Name });
        await db.SaveChangesAsync(ct);
        return await DtoAsync(group.Id, ct);
    }

    public async Task<ProjectGroupDto> UpdateAsync(Guid id, UpsertProjectGroupRequest req, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.ProjectGroupsManage, ct);
        var group = await db.ProjectGroups.FirstOrDefaultAsync(g => g.Id == id, ct) ?? throw new NotFoundException("Project group not found.", "PROJECT_GROUP_NOT_FOUND");
        var name = req.Name is null ? group.Name : CleanName(req.Name);
        if (name != group.Name) await EnsureNameFreeAsync(name, id, ct);

        var active = req.IsActive ?? group.IsActive;
        if (group.IsActive && !active && !await db.ProjectGroups.AnyAsync(g => g.Id != id && g.IsActive, ct))
            throw new ConflictException("Keep at least one active project group, so new projects have somewhere to go. Activate another group first.", LastActiveCode);

        var was = (group.Name, group.IsActive);
        group.Name = name;
        if (req.Description is not null) group.Description = CleanDescription(req.Description);
        group.IsActive = active;
        if (was != (group.Name, group.IsActive))
            recorder.Audit("projectgroup.updated", "ProjectGroup", id, oldValue: new { Name = was.Item1, IsActive = was.Item2 }, newValue: new { group.Name, group.IsActive });
        await db.SaveChangesAsync(ct);
        return await DtoAsync(id, ct);
    }

    public async Task<IReadOnlyList<ProjectGroupDto>> ReorderAsync(ReorderProjectGroupsRequest req, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.ProjectGroupsManage, ct);
        var groups = await db.ProjectGroups.OrderBy(g => g.Order).ThenBy(g => g.Name).ToListAsync(ct);
        var wanted = req.GroupIds ?? [];
        if (wanted.Count != groups.Count || wanted.Distinct().Count() != groups.Count || groups.Any(g => !wanted.Contains(g.Id)))
            throw new ValidationException("groupIds", "Send every project group exactly once.");
        for (var i = 0; i < wanted.Count; i++) groups.First(g => g.Id == wanted[i]).Order = i;
        await db.SaveChangesAsync(ct);
        return await ListAsync(false, ct);
    }

    /// <summary>
    /// Deletes a group. One that still holds projects (archived ones included, since every project needs a group) is only deleted when
    /// <paramref name="moveTo"/> names another active group, and the projects are moved there first.
    /// </summary>
    public async Task DeleteAsync(Guid id, Guid? moveTo, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.ProjectGroupsManage, ct);
        var group = await db.ProjectGroups.FirstOrDefaultAsync(g => g.Id == id, ct) ?? throw new NotFoundException("Project group not found.", "PROJECT_GROUP_NOT_FOUND");
        if (!await db.ProjectGroups.AnyAsync(g => g.Id != id, ct))
            throw new ConflictException("This is the only project group. Add another one before deleting it.", LastActiveCode);
        if (group.IsActive && !await db.ProjectGroups.AnyAsync(g => g.Id != id && g.IsActive, ct))
            throw new ConflictException("Keep at least one active project group, so new projects have somewhere to go. Activate another group first.", LastActiveCode);

        // Deleted projects still point at the group (they can be restored), so they are moved along with the rest.
        var projects = await db.Projects.IgnoreQueryFilters().Where(p => p.ProjectGroupId == id && p.TenantId == group.TenantId).ToListAsync(ct);
        if (projects.Count > 0)
        {
            if (moveTo is not { } target)
                throw new ConflictException($"This group still has {projects.Count} project{(projects.Count == 1 ? "" : "s")}. Move {(projects.Count == 1 ? "it" : "them")} to another group first, or choose a group to move {(projects.Count == 1 ? "it" : "them")} to.", InUseCode);
            if (target == id) throw new ValidationException("moveTo", "Choose a different group to move the projects to.");
            var to = await db.ProjectGroups.FirstOrDefaultAsync(g => g.Id == target, ct) ?? throw new ValidationException("moveTo", "The group to move the projects to was not found.");
            if (!to.IsActive) throw new ValidationException("moveTo", "The group to move the projects to is inactive.");
            foreach (var p in projects) p.ProjectGroupId = to.Id;
        }
        db.ProjectGroups.Remove(group);
        recorder.Audit("projectgroup.deleted", "ProjectGroup", id, oldValue: new { group.Name, Moved = projects.Count, moveTo });
        await db.SaveChangesAsync(ct);
    }

    // ------------------------------------------------------------------ used when a workspace is created and at start-up

    /// <summary>Makes sure the workspace has a group to put projects in, and that no project is left without one. Returns whether anything was added.</summary>
    public static async Task<bool> EnsureAsync(IAppDbContext db, Guid tenantId, DateTime now, CancellationToken ct)
    {
        var changed = false;
        var group = await db.ProjectGroups.IgnoreQueryFilters().Where(g => g.TenantId == tenantId).OrderBy(g => g.Order).FirstOrDefaultAsync(ct);
        if (group is null)
        {
            group = new ProjectGroup { TenantId = tenantId, Name = DefaultName, Order = 0, IsActive = true, CreatedAt = now };
            db.ProjectGroups.Add(group);
            changed = true;
        }
        foreach (var p in await db.Projects.IgnoreQueryFilters().Where(p => p.TenantId == tenantId && p.ProjectGroupId == null).ToListAsync(ct))
        {
            p.ProjectGroupId = group.Id;
            changed = true;
        }
        return changed;
    }
}
