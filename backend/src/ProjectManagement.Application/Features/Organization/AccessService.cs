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
        var people = await db.TenantMembers.Where(m => m.OrgRoleId != null).GroupBy(m => m.OrgRoleId!.Value)
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
