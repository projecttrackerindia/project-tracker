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

/// <summary>Capability checks: role defaults plus per-tenant overrides (spec section 9).</summary>
public class PermissionService(IAppDbContext db, ICurrentContext ctx)
{
    private Dictionary<(TenantRole, string), bool>? _overrides;

    private async Task<Dictionary<(TenantRole, string), bool>> OverridesAsync(CancellationToken ct)
    {
        if (_overrides is not null) return _overrides;
        if (ctx.TenantId is null) return _overrides = new();
        var rows = await db.RolePermissionOverrides.AsNoTracking().ToListAsync(ct);
        return _overrides = rows.ToDictionary(o => (o.Role, o.Permission), o => o.Allowed);
    }

    // ---- job-role access profile
    // Owners and Admins (the people who run the organization) are never narrowed by a job role. Managers, Members and Guests
    // who sit in a job role that has an access profile get exactly what that profile says; everyone else keeps the defaults
    // of their access level.
    private AccessProfile? _profile;
    private HashSet<string>? _profilePermissions;
    private bool _profileLoaded;

    /// <summary>The current user's job-role access profile, or null when their access level's defaults apply.</summary>
    public async Task<AccessProfile?> ProfileAsync(CancellationToken ct = default)
    {
        if (_profileLoaded) return _profile;
        _profileLoaded = true;
        if (ctx.TenantId is not { } tid || ctx.UserId is not { } uid || ctx.WorkspaceType == WorkspaceType.Personal) return null;
        if (ctx.Role is not (TenantRole.Manager or TenantRole.Member or TenantRole.Guest)) return null;
        // OrgRoles carries the tenant + soft-delete filters, so a deleted role simply means "no profile".
        var json = await (from m in db.TenantMembers.AsNoTracking()
                          join r in db.OrgRoles.AsNoTracking() on m.OrgRoleId equals (Guid?)r.Id
                          where m.TenantId == tid && m.UserId == uid
                          select r.AccessJson).FirstOrDefaultAsync(ct);
        _profile = AccessProfile.Parse(json);
        _profilePermissions = _profile?.Permissions();
        return _profile;
    }

    public async Task<bool> HasAsync(string permission, CancellationToken ct = default)
    {
        if (ctx.Role is not { } role) return false;
        if (await ProfileAsync(ct) is not null) return _profilePermissions!.Contains(permission);
        return await RoleHasAsync(role, permission, ct);
    }

    /// <summary>The defaults of an access level (with the tenant's overrides). Used when no job-role profile applies.</summary>
    public async Task<bool> RoleHasAsync(TenantRole role, string permission, CancellationToken ct = default)
    {
        if (role == TenantRole.Owner || ctx.WorkspaceType == WorkspaceType.Personal) return true;
        if ((await OverridesAsync(ct)).TryGetValue((role, permission), out var allowed)) return allowed;
        return Permissions.DefaultAllowed(role, permission);
    }

    public async Task RequireAsync(string permission, CancellationToken ct = default)
    {
        if (!await HasAsync(permission, ct))
            throw new ForbiddenException($"Your role does not allow this action ({permission}).", "PERMISSION_DENIED");
    }

    /// <summary>
    /// Full task-editing rights (Permissions.TasksEdit) let someone edit any task; without those, editing is
    /// allowed only on a task assigned to them - everyone else's tasks are read-only. The bulk overload requires
    /// every task in the batch to be theirs when they lack the blanket permission (e.g. planning several tasks
    /// into a sprint at once).
    /// </summary>
    public async Task RequireTaskEditAsync(TaskItem task, CancellationToken ct = default) => await RequireTaskEditAsync([task], ct);

    public async Task RequireTaskEditAsync(IReadOnlyCollection<TaskItem> tasks, CancellationToken ct = default)
    {
        if (await HasAsync(Permissions.TasksEdit, ct)) return;
        if (tasks.Count > 0 && tasks.All(t => t.AssigneeId == ctx.UserId)) return;
        throw new ForbiddenException("You can only edit tasks assigned to you.", "PERMISSION_DENIED");
    }

    public async Task<IReadOnlyList<string>> EffectiveAsync(CancellationToken ct = default)
    {
        var list = new List<string>();
        foreach (var p in Permissions.All)
            if (await HasAsync(p, ct)) list.Add(p);
        if (await HasBroadReportsAccessAsync(ct)) list.Add(BroadReportsKey);
        return list;
    }

    /// <summary>Synthetic key (not a real permission) the client checks with useCan to decide whether to offer a
    /// full "anyone in the workspace" picker versus one scoped to a manager's own reporting line.</summary>
    public const string BroadReportsKey = "reports.broad";

    /// <summary>
    /// True for Owners/Admins, and for anyone whose job-role profile explicitly grants the reports permission - but
    /// not for a plain Manager who only has it as a role default. "Can open Reports" (Permissions.ReportsView) and
    /// "can see anyone's timesheet/calendar, not just people in their reporting line" are different things: a
    /// Manager gets the former by default, but stays limited to their team for the latter unless an admin
    /// explicitly widens it through a job-role profile.
    /// </summary>
    public async Task<bool> HasBroadReportsAccessAsync(CancellationToken ct = default)
    {
        if (ctx.Role is TenantRole.Owner or TenantRole.Admin || ctx.WorkspaceType == WorkspaceType.Personal) return true;
        if (await ProfileAsync(ct) is { } profile) return profile.Permissions().Contains(Permissions.ReportsView);
        return false;
    }

    // ---- module levels (which menus a person can open, and how far)

    /// <summary>What an access level gets per module when no job-role profile applies, derived from its capabilities.</summary>
    public async Task<int> TierLevelAsync(string module, TenantRole role, CancellationToken ct = default)
    {
        async Task<bool> Has(string p) => await RoleHasAsync(role, p, ct);
        switch (module)
        {
            case Modules.Projects: return await Has(Permissions.ProjectsDelete) ? 3 : await Has(Permissions.ProjectsCreate) || await Has(Permissions.ProjectsEdit) ? 2 : 1;
            case Modules.Tasks: return await Has(Permissions.TasksDelete) ? 3 : await Has(Permissions.TasksCreate) || await Has(Permissions.TasksEdit) ? 2 : 1;
            // Work management is internal operational work: guests never see it.
            case Modules.Work: return role == TenantRole.Guest ? 0 : await Has(Permissions.WorkDelete) ? 3 : await Has(Permissions.WorkCreate) || await Has(Permissions.WorkEdit) ? 2 : 1;
            case Modules.Teams: return await Has(Permissions.TeamsManage) ? 2 : 1;
            // Members and Billing are administrative areas: unlike the other modules, no permission means no menu at all,
            // not just a read-only view (the Members roster itself stays reachable elsewhere - see WorkspaceControllers -
            // as the shared "who's in the workspace" picker used when assigning tasks, projects, teams and so on).
            case Modules.Members: return await Has(Permissions.MembersManage) ? 3 : await Has(Permissions.MembersInvite) ? 2 : 0;
            case Modules.Reports: return await Has(Permissions.ReportsView) ? 1 : 0;
            case Modules.Audit: return await Has(Permissions.AuditView) ? 1 : 0;
            case Modules.Billing: return role == TenantRole.Admin ? (await Has(Permissions.BillingManage) ? 3 : 1) : 0;
            case Modules.Organization: return role == TenantRole.Guest ? 0 : 1;
            default: return 1; // calendar, activity
        }
    }

    public async Task<int> LevelAsync(string module, CancellationToken ct = default)
    {
        var def = Modules.Find(module) ?? throw new ArgumentException($"Unknown module '{module}'.", nameof(module));
        if (ctx.Role is not { } role) return 0;
        if (role == TenantRole.Owner || ctx.WorkspaceType == WorkspaceType.Personal) return def.Max;
        if (await ProfileAsync(ct) is { } profile) return profile.Level(module);
        return def.Snap(await TierLevelAsync(module, role, ct));
    }

    public async Task<IReadOnlyDictionary<string, int>> LevelsAsync(CancellationToken ct = default)
    {
        var map = new Dictionary<string, int>();
        foreach (var m in Modules.All) map[m.Id] = await LevelAsync(m.Id, ct);
        return map;
    }

    public async Task RequireModuleAsync(string module, int min = AccessLevel.View, CancellationToken ct = default)
    {
        if (await LevelAsync(module, ct) >= min) return;
        var label = Modules.Find(module)?.Label ?? module;
        throw new ForbiddenException($"Your role does not have access to {label}.", "MODULE_ACCESS_DENIED");
    }

    /// <summary>True when a job-role profile (not the access level's defaults) decides this user's access.</summary>
    public async Task<bool> HasProfileAsync(CancellationToken ct = default) => await ProfileAsync(ct) is not null;
}
