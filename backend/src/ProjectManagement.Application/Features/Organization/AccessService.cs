using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Organization;

public record ModuleInfoDto(string Id, string Label, string Description, int[] Levels, IReadOnlyDictionary<int, string> Hints,
    IReadOnlyDictionary<int, string[]> Grants);
public record ActionInfoDto(string Key, string Label, string Description, bool Delegable);
public record SuggestedDto(IReadOnlyDictionary<string, int> Modules, IReadOnlyDictionary<string, bool> Actions);
public record RoleAccessDto(Guid RoleId, string Name, string Color, Guid? ParentRoleId, int People, bool HasProfile,
    IReadOnlyDictionary<string, int> Modules, IReadOnlyDictionary<string, bool> Actions, SuggestedDto? Suggested);
public record AccessMatrixDto(IReadOnlyList<ModuleInfoDto> Modules, IReadOnlyList<ActionInfoDto> Actions, IReadOnlyList<RoleAccessDto> Roles,
    bool CanEdit, bool PlanAllows, bool IsOrgAdmin, IReadOnlyDictionary<string, int> MyLevels);
public record SetAccessRequest(IReadOnlyDictionary<string, int> Modules, IReadOnlyDictionary<string, bool>? Actions);

/// <summary>
/// Where a person's access comes from. Owner: everything, always. Admin: the Admin access level (never narrowed by a job role).
/// JobRole: their job role has its own access settings, and those decide everything for them. AccessLevel: the defaults of their access
/// level (Manager, Member or Guest), as set on the access-level matrix.
/// </summary>
public enum AccessSource { Owner, Admin, JobRole, AccessLevel }

/// <summary>What one person can actually open and do right now, and which single rule decided it.</summary>
public record EffectiveAccessDto(Guid UserId, string Name, string Email, TenantRole AccessLevel, string? JobRole, AccessSource Source,
    IReadOnlyDictionary<string, int> Modules, IReadOnlyList<string> Permissions, string ProjectReach = "everything", int Projects = 0, IReadOnlyList<string>? Teams = null);
public record EffectiveAccessListDto(IReadOnlyList<EffectiveAccessDto> People, int ByJobRole, int ByAccessLevel);

/// <summary>
/// What each job role can see and do. The organization's admins (Owner / Admin) have this by default and can hand it to others.
/// A person who has been handed it (a "delegate") can only change roles below their own in the chart, can never give a role
/// more than they have themselves, and can never hand out the permissions that themselves grant access to others.
/// </summary>
public class AccessService(IAppDbContext db, ICurrentContext ctx, PermissionService permissions, EntitlementService entitlements, Recorder recorder)
{
    private bool IsOrgAdmin => ctx.Role is TenantRole.Owner or TenantRole.Admin;

    private Guid RequireOrganization()
    {
        var tid = ctx.RequireTenantId();
        if (ctx.WorkspaceType == WorkspaceType.Personal)
            throw new ForbiddenException("Personal workspaces do not have job roles.", "PERSONAL_WORKSPACE");
        return tid;
    }

    /// <summary>The profile a role without its own gets shown as: what a plain Member is allowed today.</summary>
    private async Task<AccessProfile> BaselineAsync(CancellationToken ct)
    {
        var levels = new Dictionary<string, int>();
        foreach (var m in Modules.All) levels[m.Id] = m.Snap(await permissions.TierLevelAsync(m.Id, TenantRole.Member, ct));
        var actions = new Dictionary<string, bool>();
        foreach (var a in Modules.Actions) actions[a.Key] = await permissions.RoleHasAsync(TenantRole.Member, a.Key, ct);
        return AccessProfile.Build(levels, actions);
    }

    private static Dictionary<string, bool> ActionMap(AccessProfile p)
    {
        var granted = p.Permissions();
        return Modules.Actions.ToDictionary(a => a.Key, a => granted.Contains(a.Key));
    }

    public async Task<AccessMatrixDto> GetAsync(CancellationToken ct = default)
    {
        RequireOrganization();
        await permissions.RequireAsync(Permissions.AccessManage, ct);

        var roles = await db.OrgRoles.AsNoTracking().OrderBy(r => r.SortOrder).ThenBy(r => r.CreatedAt).ToListAsync(ct);
        var tenantId = ctx.RequireTenantId();
        var people = await db.TenantMembers.Where(m => m.TenantId == tenantId && m.OrgRoleId != null).GroupBy(m => m.OrgRoleId!.Value)
            .Select(g => new { Id = g.Key, Count = g.Count() }).ToDictionaryAsync(x => x.Id, x => x.Count, ct);
        var baseline = await BaselineAsync(ct);
        var planAllows = await entitlements.GetValueAsync(FeatureKeys.AdvancedPermissions, ct) != 0;

        var rows = roles.Select(r =>
        {
            var own = AccessProfile.Parse(r.AccessJson);
            var p = own ?? baseline;
            var suggested = SuggestedAccess.For(r.Name);
            return new RoleAccessDto(r.Id, r.Name, r.Color, r.ParentRoleId, people.GetValueOrDefault(r.Id), own is not null,
                Modules.All.ToDictionary(m => m.Id, m => p.Level(m.Id)), ActionMap(p),
                suggested is null ? null : new SuggestedDto(Modules.All.ToDictionary(m => m.Id, m => suggested.Level(m.Id)), ActionMap(suggested)));
        }).ToList();

        return new AccessMatrixDto(
            Modules.All.Select(m => new ModuleInfoDto(m.Id, m.Label, m.Description, m.Levels, m.Hints,
                m.Levels.ToDictionary(l => l, l => Modules.PermissionsAt(m.Id, l).ToArray()))).ToList(),
            Modules.Actions.Select(a => new ActionInfoDto(a.Key, a.Label, a.Description, a.Delegable)).ToList(),
            rows, CanEdit: planAllows, PlanAllows: planAllows, IsOrgAdmin, await permissions.LevelsAsync(ct));
    }

    // ---------------------------------------------------------------- change

    private async Task<OrgRole> FindRoleAsync(Guid id, CancellationToken ct) =>
        await db.OrgRoles.FirstOrDefaultAsync(r => r.Id == id, ct) ?? throw new NotFoundException("Role not found.");

    /// <summary>Delegates may only change roles that sit strictly below their own role in the chart.</summary>
    private async Task EnsureRoleInScopeAsync(OrgRole target, CancellationToken ct)
    {
        if (IsOrgAdmin) return;
        var tid = ctx.RequireTenantId(); // TenantMembers is not tenant-filtered, and a person is a member of several workspaces
        var mine = await db.TenantMembers.Where(m => m.TenantId == tid && m.UserId == ctx.UserId).Select(m => m.OrgRoleId).FirstOrDefaultAsync(ct);
        var parents = await db.OrgRoles.AsNoTracking().ToDictionaryAsync(r => r.Id, r => r.ParentRoleId, ct);
        var seen = 0;
        for (Guid? cur = target.ParentRoleId; cur is { } id && seen++ <= parents.Count; cur = parents.GetValueOrDefault(id))
            if (mine is { } m && id == m) return;
        throw new ForbiddenException("You can only change the access of roles below your own role in the chart.", "PERMISSION_DENIED");
    }

    public async Task SetAsync(Guid roleId, SetAccessRequest req, CancellationToken ct = default)
    {
        RequireOrganization();
        await permissions.RequireAsync(Permissions.AccessManage, ct);
        await entitlements.EnsureFeatureAsync(FeatureKeys.AdvancedPermissions, ct);
        var role = await FindRoleAsync(roleId, ct);
        await EnsureRoleInScopeAsync(role, ct);

        foreach (var (id, level) in req.Modules)
        {
            var def = Modules.Find(id) ?? throw new ValidationException("modules", $"Unknown module “{id}”.");
            if (!def.Levels.Contains(level)) throw new ValidationException("modules", $"{def.Label} cannot be set to level {level}.");
        }
        foreach (var key in req.Actions?.Keys ?? [])
            if (Modules.Actions.All(a => a.Key != key)) throw new ValidationException("actions", $"Unknown action “{key}”.");

        var profile = AccessProfile.Build(req.Modules, req.Actions ?? new Dictionary<string, bool>());
        var before = AccessProfile.Parse(role.AccessJson) ?? await BaselineAsync(ct);
        var granted = profile.Permissions();

        if (!IsOrgAdmin)
        {
            foreach (var m in Modules.All)
                if (profile.Level(m.Id) > await permissions.LevelAsync(m.Id, ct))
                    throw new ForbiddenException($"You cannot give a role more access to {m.Label} than you have yourself.", "PERMISSION_DENIED");
            var was = before.Permissions();
            foreach (var a in Modules.Actions.Where(a => a.Delegable))
                if (granted.Contains(a.Key) != was.Contains(a.Key))
                    throw new ForbiddenException($"Only organization admins can change who may “{a.Label.ToLowerInvariant()}”.", "PERMISSION_DENIED");
            foreach (var p in granted)
                if (!await permissions.HasAsync(p, ct))
                    throw new ForbiddenException("You cannot give a role a permission that you do not have yourself.", "PERMISSION_DENIED");
        }

        role.AccessJson = profile.ToJson();
        recorder.Audit("org.access_changed", "OrgRole", roleId, new { role.Name, Levels = before.Levels }, new { role.Name, profile.Levels, profile.Overrides });
        await db.SaveChangesAsync(ct);
    }

    // ---------------------------------------------------------------- effective access

    /// <summary>
    /// Everyone's effective access, computed with exactly the rules <see cref="PermissionService"/> enforces: one source per person, so an
    /// administrator can see who a change to the access-level matrix or to a job role actually reaches.
    /// </summary>
    public async Task<EffectiveAccessListDto> EffectiveAsync(CancellationToken ct = default)
    {
        var tid = RequireOrganization();
        if (!await permissions.HasAsync(Permissions.AccessManage, ct) && !await permissions.HasAsync(Permissions.PermissionsManage, ct))
            throw new ForbiddenException("You cannot see everyone's access.", "PERMISSION_DENIED");

        var members = await (from m in db.TenantMembers.AsNoTracking()
                             join u in db.Users.AsNoTracking() on m.UserId equals u.Id
                             where m.TenantId == tid
                             orderby u.DisplayName
                             select new { m.UserId, u.DisplayName, u.Email, m.Role, m.OrgRoleId }).ToListAsync(ct);
        var roles = await db.OrgRoles.AsNoTracking().ToDictionaryAsync(r => r.Id, r => new { r.Name, r.AccessJson }, ct);

        // An access level's defaults are the same for everyone at that level: work each out once.
        var byLevel = new Dictionary<TenantRole, (Dictionary<string, int> Modules, List<string> Permissions)>();
        async Task<(Dictionary<string, int>, List<string>)> DefaultsAsync(TenantRole level)
        {
            if (byLevel.TryGetValue(level, out var known)) return known;
            var mods = new Dictionary<string, int>();
            foreach (var m in Modules.All) mods[m.Id] = level == TenantRole.Owner ? m.Max : m.Snap(await permissions.TierLevelAsync(m.Id, level, ct));
            var perms = new List<string>();
            foreach (var p in Permissions.All) if (await permissions.RoleHasAsync(level, p, ct)) perms.Add(p);
            return byLevel[level] = (mods, perms);
        }

        // Which projects each person can open: everything, their own teams' (plus ones they own or were added to), or only the ones they were added to.
        var visibility = await db.Tenants.AsNoTracking().Where(t => t.Id == tid).Select(t => t.ProjectVisibility).FirstAsync(ct);
        var projectRows = await db.Projects.IgnoreQueryFilters().AsNoTracking().Where(p => p.TenantId == tid && !p.IsDeleted && p.Status != ProjectStatus.Archived).Select(p => new { p.Id, p.OwnerId, p.TeamId }).ToListAsync(ct);
        var addedTo = (await db.ProjectMembers.AsNoTracking().Select(pm => new { pm.UserId, pm.ProjectId }).ToListAsync(ct)).GroupBy(x => x.UserId).ToDictionary(g => g.Key, g => g.Select(x => x.ProjectId).ToHashSet());
        var teamRows = await db.Teams.AsNoTracking().Select(t => new { t.Id, t.Name }).ToListAsync(ct);
        var teamOf = (await db.TeamMembers.AsNoTracking().Select(tm => new { tm.UserId, tm.TeamId }).ToListAsync(ct)).GroupBy(x => x.UserId).ToDictionary(g => g.Key, g => g.Select(x => x.TeamId).ToHashSet());
        (string Reach, int Count, IReadOnlyList<string> Teams) Reach(Guid user, TenantRole level, IEnumerable<string> perms)
        {
            var myTeams = teamOf.GetValueOrDefault(user) ?? [];
            var names = teamRows.Where(t => myTeams.Contains(t.Id)).Select(t => t.Name).OrderBy(n => n).ToList();
            var added = addedTo.GetValueOrDefault(user) ?? [];
            if (level == TenantRole.Guest) return ("added", projectRows.Count(p => added.Contains(p.Id)), names);
            if (visibility == ProjectVisibility.Teams && !perms.Contains(Permissions.ProjectsViewAll))
                return ("teams", projectRows.Count(p => p.OwnerId == user || added.Contains(p.Id) || (p.TeamId is { } t && myTeams.Contains(t))), names);
            return ("everything", projectRows.Count, names);
        }

        var people = new List<EffectiveAccessDto>();
        foreach (var m in members)
        {
            var role = m.OrgRoleId is { } rid && roles.TryGetValue(rid, out var r) ? r : null;
            var profile = m.Role is TenantRole.Manager or TenantRole.Member or TenantRole.Guest ? AccessProfile.Parse(role?.AccessJson) : null;
            if (profile is not null)
            {
                var jobPerms = profile.Permissions().OrderBy(p => p).ToList();
                var jr = Reach(m.UserId, m.Role, jobPerms);
                people.Add(new EffectiveAccessDto(m.UserId, m.DisplayName, m.Email, m.Role, role?.Name, AccessSource.JobRole,
                    Modules.All.ToDictionary(x => x.Id, x => profile.Level(x.Id)), jobPerms, jr.Reach, jr.Count, jr.Teams));
                continue;
            }
            var (mods, perms) = await DefaultsAsync(m.Role);
            var source = m.Role switch { TenantRole.Owner => AccessSource.Owner, TenantRole.Admin => AccessSource.Admin, _ => AccessSource.AccessLevel };
            var lr = Reach(m.UserId, m.Role, perms);
            people.Add(new EffectiveAccessDto(m.UserId, m.DisplayName, m.Email, m.Role, role?.Name, source, mods, perms, lr.Reach, lr.Count, lr.Teams));
        }
        return new EffectiveAccessListDto(people, people.Count(p => p.Source == AccessSource.JobRole), people.Count(p => p.Source == AccessSource.AccessLevel));
    }

    /// <summary>Back to "use each person's access level defaults".</summary>
    public async Task ResetAsync(Guid roleId, CancellationToken ct = default)
    {
        RequireOrganization();
        await permissions.RequireAsync(Permissions.AccessManage, ct);
        var role = await FindRoleAsync(roleId, ct);
        await EnsureRoleInScopeAsync(role, ct);
        if (role.AccessJson is null) return;
        role.AccessJson = null;
        recorder.Audit("org.access_reset", "OrgRole", roleId, new { role.Name });
        await db.SaveChangesAsync(ct);
    }
}
