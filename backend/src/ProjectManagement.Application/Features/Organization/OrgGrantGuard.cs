using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Organization;

/// <summary>
/// Stops someone who was handed <see cref="Permissions.OrgStructure"/> (a "delegate", i.e. not an Owner or Admin) from using the
/// organization chart to raise their own access or reach: they can only place people in job roles strictly below their own, never in
/// a role that carries more than they have or any of the permissions that hand out access, never change their own place, and never
/// pull someone into their own reporting line to gain sight of that person's work. Owners and Admins are not restricted here.
/// </summary>
public class OrgGrantGuard(IAppDbContext db, ICurrentContext ctx, PermissionService permissions)
{
    public bool IsOrgAdmin => ctx.Role is TenantRole.Owner or TenantRole.Admin;

    private static ForbiddenException Deny(string message) => new(message, "PERMISSION_DENIED");

    private async Task<Guid?> MyRoleAsync(Guid tid, CancellationToken ct) =>
        await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid && m.UserId == ctx.UserId).Select(m => m.OrgRoleId).FirstOrDefaultAsync(ct);

    private async Task<Dictionary<Guid, Guid?>> ParentsAsync(CancellationToken ct) =>
        await db.OrgRoles.AsNoTracking().ToDictionaryAsync(r => r.Id, r => r.ParentRoleId, ct);

    /// <summary>True when <paramref name="roleId"/> sits strictly below <paramref name="ancestor"/> in the tree.</summary>
    public static bool IsStrictlyBelow(Guid roleId, Guid ancestor, IReadOnlyDictionary<Guid, Guid?> parents)
    {
        var seen = 0;
        for (Guid? cur = parents.GetValueOrDefault(roleId); cur is { } id && seen++ <= parents.Count; cur = parents.GetValueOrDefault(id))
            if (id == ancestor) return true;
        return false;
    }

    private async Task EnsureBelowMineAsync(Guid roleId, Guid tid, Dictionary<Guid, Guid?>? parents, CancellationToken ct)
    {
        var mine = await MyRoleAsync(tid, ct);
        parents ??= await ParentsAsync(ct);
        if (mine is not { } m || !IsStrictlyBelow(roleId, m, parents))
            throw Deny("You can only use job roles below your own role in the chart.");
    }

    /// <summary>A delegate may hand out a job role only when it is below their own, gives nothing they lack, and grants no delegable action.</summary>
    public async Task EnsureRoleGrantableAsync(Guid roleId, CancellationToken ct = default)
    {
        if (IsOrgAdmin) return;
        var tid = ctx.RequireTenantId();
        var role = await db.OrgRoles.AsNoTracking().FirstOrDefaultAsync(r => r.Id == roleId, ct) ?? throw new NotFoundException("Role not found.");
        await EnsureBelowMineAsync(role.Id, tid, null, ct);
        if (AccessProfile.Parse(role.AccessJson) is not { } profile) return;   // no own access: the person keeps their access level's defaults
        var granted = profile.Permissions();
        foreach (var a in Modules.Actions.Where(a => a.Delegable))
            if (granted.Contains(a.Key))
                throw Deny($"Only organization admins can place people in a role that may “{a.Label.ToLowerInvariant()}”.");
        foreach (var m in Modules.All)
            if (profile.Level(m.Id) > await permissions.LevelAsync(m.Id, ct))
                throw Deny($"That role has more access to {m.Label} than you have yourself.");
        foreach (var p in granted)
            if (!await permissions.HasAsync(p, ct))
                throw Deny("That role has a permission that you do not have yourself.");
    }

    /// <summary>Assigning (or clearing) someone's job role.</summary>
    public async Task EnsureCanAssignRoleAsync(TenantMember target, Guid? roleId, CancellationToken ct = default)
    {
        if (IsOrgAdmin) return;
        if (target.UserId == ctx.UserId) throw Deny("You cannot change your own job role. Ask an organization admin.");
        if (ctx.Role is not { } mine || target.Role >= mine) throw Deny("You cannot change the job role of someone at or above your own access level.");
        if (target.OrgRoleId is { } current && await db.OrgRoles.AnyAsync(r => r.Id == current, ct))
            await EnsureBelowMineAsync(current, ctx.RequireTenantId(), null, ct);
        if (roleId is { } r) await EnsureRoleGrantableAsync(r, ct);
    }

    /// <summary>Moving a role in the tree: both the role and its new parent must stay inside the delegate's own branch.</summary>
    public async Task EnsureCanMoveRoleAsync(Guid roleId, Guid? newParent, CancellationToken ct = default)
    {
        if (IsOrgAdmin) return;
        var tid = ctx.RequireTenantId();
        var parents = await ParentsAsync(ct);
        await EnsureBelowMineAsync(roleId, tid, parents, ct);
        var mine = await MyRoleAsync(tid, ct);
        if (newParent is not { } p || (p != mine && !IsStrictlyBelow(p, mine!.Value, parents)))
            throw Deny("You can only move roles within the part of the chart below your own role.");
    }

    /// <summary>
    /// Changing who someone reports to. A delegate cannot change their own manager, and cannot bring a person into their own reporting
    /// line (which would let them see that person's work) unless that person is already in it.
    /// </summary>
    public async Task EnsureCanSetReportsToAsync(TenantMember target, Guid? bossId, CancellationToken ct = default)
    {
        if (IsOrgAdmin) return;
        var me = ctx.RequireUserId();
        if (target.UserId == me) throw Deny("You cannot change who you report to. Ask an organization admin.");
        if (ctx.Role is not { } mine || target.Role >= mine) throw Deny("You cannot change the manager of someone at or above your own access level.");
        if (bossId is not { } boss) { if (!await InMyLineAsync(target.UserId, ct)) throw Deny("You can only change the manager of people in your own reporting line."); return; }
        var tid = ctx.RequireTenantId();
        var chain = await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid).ToDictionaryAsync(m => m.UserId, m => m.ReportsToUserId, ct);
        var intoMyLine = false;
        var seen = new HashSet<Guid>();
        for (Guid? cur = boss; cur is { } id && seen.Add(id); cur = chain.GetValueOrDefault(id))
            if (id == me) { intoMyLine = true; break; }
        if (intoMyLine && !await InMyLineAsync(target.UserId, ct))
            throw Deny("You cannot move someone into your own reporting line. Ask an organization admin.");
    }

    private async Task<bool> InMyLineAsync(Guid userId, CancellationToken ct)
    {
        var me = ctx.RequireUserId();
        var tid = ctx.RequireTenantId();
        var chain = await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid).ToDictionaryAsync(m => m.UserId, m => m.ReportsToUserId, ct);
        var seen = new HashSet<Guid> { userId };
        for (Guid? cur = chain.GetValueOrDefault(userId); cur is { } id && seen.Add(id); cur = chain.GetValueOrDefault(id))
            if (id == me) return true;
        return false;
    }

    /// <summary>
    /// Whether <paramref name="inviter"/> (not necessarily the signed-in person) may still grant an invitation: they must hold the
    /// invite permission in that organization, outrank the access level, and (for delegates) the job role must still be below theirs
    /// and carry no delegable action. Works across workspaces, so every lookup is filtered by tenant explicitly.
    /// </summary>
    public async Task<string?> InviterProblemAsync(TenantInvitation invite, CancellationToken ct = default)
    {
        var tid = invite.TenantId;
        var inviter = invite.CreatedBy is { } by
            ? await db.TenantMembers.AsNoTracking().FirstOrDefaultAsync(m => m.TenantId == tid && m.UserId == by, ct)
            : null;
        if (inviter is null) return "The person who invited you is no longer a member of this organization. Ask for a new invitation.";
        if (inviter.Role == TenantRole.Owner) return null;
        if (invite.Role >= inviter.Role) return "The person who invited you can no longer grant this access level. Ask for a new invitation.";

        var roles = await db.OrgRoles.IgnoreQueryFilters().AsNoTracking().Where(r => r.TenantId == tid && !r.IsDeleted)
            .Select(r => new { r.Id, r.ParentRoleId, r.AccessJson }).ToListAsync(ct);
        var profile = inviter.Role is TenantRole.Manager or TenantRole.Member or TenantRole.Guest && inviter.OrgRoleId is { } ir
            ? AccessProfile.Parse(roles.FirstOrDefault(r => r.Id == ir)?.AccessJson) : null;
        var overrides = await db.RolePermissionOverrides.IgnoreQueryFilters().AsNoTracking()
            .Where(o => o.TenantId == tid && o.Role == inviter.Role).ToDictionaryAsync(o => o.Permission, o => o.Allowed, ct);
        bool Has(string p) => profile is not null ? profile.Permissions().Contains(p)
            : overrides.TryGetValue(p, out var a) ? a : Permissions.DefaultAllowed(inviter.Role, p);

        if (!Has(Permissions.MembersInvite)) return "The person who invited you can no longer invite members. Ask for a new invitation.";
        if (inviter.Role == TenantRole.Admin) return null;
        if ((invite.OrgRoleId is not null || invite.ReportsToUserId is not null) && !Has(Permissions.OrgStructure))
            return "The person who invited you can no longer place people on the organization chart. Ask for a new invitation.";
        if (invite.OrgRoleId is { } rid && roles.Any(r => r.Id == rid))
        {
            var parents = roles.ToDictionary(r => r.Id, r => r.ParentRoleId);
            if (inviter.OrgRoleId is not { } mine || !IsStrictlyBelow(rid, mine, parents))
                return "The person who invited you can no longer grant this job role. Ask for a new invitation.";
            if (AccessProfile.Parse(roles.First(r => r.Id == rid).AccessJson) is { } target
                && Modules.Actions.Any(a => a.Delegable && target.Permissions().Contains(a.Key)))
                return "The person who invited you can no longer grant this job role. Ask for a new invitation.";
        }
        return null;
    }
}
