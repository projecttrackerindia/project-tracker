using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.People;

public record MemberStatusDto(Guid UserId, MemberStatus Status, DateTime? DeactivatedAt, Guid? DeactivatedBy);

/// <summary>One module whose level changes for a person (0 None, 1 View, 2 Edit, 3 Full).</summary>
public record ModuleChangeDto(string Module, string Label, int From, int To);

/// <summary>What one person gains and loses if the change goes ahead.</summary>
public record PersonImpactDto(Guid UserId, string Name, IReadOnlyList<ModuleChangeDto> Modules, IReadOnlyList<string> Gained, IReadOnlyList<string> Lost, bool LosesWorkspace);

/// <summary>
/// The result of a dry run: nothing is saved. <c>Blocked</c> is true when the change would be refused (for example it would leave the
/// workspace without an active Owner or Admin), with the reason in <c>Warnings</c>.
/// </summary>
public record ImpactPreviewDto(string Kind, IReadOnlyList<PersonImpactDto> People, int Affected, IReadOnlyList<string> Warnings, bool Blocked);

/// <summary>
/// A change to preview. Kind: "accessLevel" (UserId + Role), "jobRole" (UserId + OrgRoleId, null = no job role), "roleAccess" (RoleId +
/// Modules/Actions; Modules null = back to the access level defaults), "suspend" or "remove" (UserId).
/// </summary>
public record ImpactRequest(string Kind, Guid? UserId = null, TenantRole? Role = null, Guid? OrgRoleId = null, Guid? RoleId = null,
    IReadOnlyDictionary<string, int>? Modules = null, IReadOnlyDictionary<string, bool>? Actions = null);

/// <summary>
/// People &amp; Roles administration that is not on the older member/org endpoints: suspending and reactivating members, and dry runs
/// that show who gains or loses what before a change is saved. Effective access is worked out with the same rules as
/// <see cref="Organization.AccessService.EffectiveAsync"/> (Owner: everything; Admin: Admin defaults; anyone else: their job role's own
/// access settings when it has them, otherwise their access level's defaults).
/// </summary>
public class PeopleAdminService(IAppDbContext db, ICurrentContext ctx, PermissionService permissions, AppClock clock, Recorder recorder)
{
    private Guid RequireOrganization()
    {
        var tid = ctx.RequireTenantId();
        if (ctx.WorkspaceType == WorkspaceType.Personal)
            throw new ForbiddenException("Personal workspaces do not have other members.", "PERSONAL_WORKSPACE");
        return tid;
    }

    private async Task<TenantMember> FindAsync(Guid tid, Guid userId, CancellationToken ct) =>
        await db.TenantMembers.Include(m => m.User).FirstOrDefaultAsync(m => m.TenantId == tid && m.UserId == userId, ct)
        ?? throw new NotFoundException("Member not found.");

    /// <summary>Same level rules as removing someone: never the Owner, never yourself, and only people below your own level (Owners excepted).</summary>
    private void EnsureCanActOn(TenantMember target, string verb)
    {
        if (target.Role == TenantRole.Owner)
            throw new ForbiddenException($"The workspace owner cannot be {verb}.", "OWNER_PROTECTED");
        if (target.UserId == ctx.UserId)
            throw new ForbiddenException($"You cannot {(verb == "suspended" ? "suspend" : "reactivate")} yourself.", "PERMISSION_DENIED");
        if (ctx.Role != TenantRole.Owner && target.Role >= ctx.Role)
            throw new ForbiddenException("You cannot change someone at or above your own level.", "PERMISSION_DENIED");
    }

    /// <summary>True when, without <paramref name="userId"/>, nobody active would still hold Owner or Admin.</summary>
    private async Task<bool> WouldLeaveNoAdminAsync(Guid tid, Guid userId, CancellationToken ct) =>
        !await db.TenantMembers.AnyAsync(m => m.TenantId == tid && m.UserId != userId && m.Status == MemberStatus.Active
            && (m.Role == TenantRole.Owner || m.Role == TenantRole.Admin), ct);

    private const string LastAdminMessage = "This would leave the workspace without an active Owner or Admin. Make someone else an Admin first.";

    public async Task<MemberStatusDto> SuspendAsync(Guid userId, CancellationToken ct = default)
    {
        var tid = RequireOrganization();
        await permissions.RequireAsync(Permissions.MembersManage, ct);
        var member = await FindAsync(tid, userId, ct);
        EnsureCanActOn(member, "suspended");
        if (member.Status == MemberStatus.Suspended) return new MemberStatusDto(userId, member.Status, member.DeactivatedAt, member.DeactivatedBy);
        if (member.Role >= TenantRole.Admin && await WouldLeaveNoAdminAsync(tid, userId, ct))
            throw new ConflictException(LastAdminMessage, "LAST_ADMIN");

        var now = clock.Now;
        member.Status = MemberStatus.Suspended;
        member.DeactivatedAt = now;
        member.DeactivatedBy = ctx.UserId;
        // Their sessions in this workspace end now; the middleware refuses anything else they still hold with MEMBER_SUSPENDED.
        foreach (var s in await db.UserSessions.Where(s => s.UserId == userId && s.WorkspaceId == tid && s.RevokedAt == null).ToListAsync(ct))
            s.RevokedAt = now;
        recorder.Audit("member.suspended", "TenantMember", member.Id, MemberStatus.Active.ToString(), MemberStatus.Suspended.ToString());
        recorder.Activity("member.suspended", "Member", userId, $"{member.User!.DisplayName} was suspended");
        await db.SaveChangesAsync(ct);
        return new MemberStatusDto(userId, member.Status, member.DeactivatedAt, member.DeactivatedBy);
    }

    public async Task<MemberStatusDto> ReactivateAsync(Guid userId, CancellationToken ct = default)
    {
        var tid = RequireOrganization();
        await permissions.RequireAsync(Permissions.MembersManage, ct);
        var member = await FindAsync(tid, userId, ct);
        EnsureCanActOn(member, "reactivated");
        if (member.Status == MemberStatus.Active) return new MemberStatusDto(userId, member.Status, null, null);
        member.Status = MemberStatus.Active;
        member.DeactivatedAt = null;
        member.DeactivatedBy = null;
        recorder.Audit("member.reactivated", "TenantMember", member.Id, MemberStatus.Suspended.ToString(), MemberStatus.Active.ToString());
        recorder.Activity("member.reactivated", "Member", userId, $"{member.User!.DisplayName} was reactivated");
        await db.SaveChangesAsync(ct);
        return new MemberStatusDto(userId, member.Status, null, null);
    }

    // ---------------------------------------------------------------- dry run

    private readonly Dictionary<TenantRole, (Dictionary<string, int> Modules, HashSet<string> Permissions)> _levelDefaults = new();

    private async Task<(Dictionary<string, int> Modules, HashSet<string> Permissions)> DefaultsAsync(TenantRole level, CancellationToken ct)
    {
        if (_levelDefaults.TryGetValue(level, out var known)) return known;
        var mods = new Dictionary<string, int>();
        foreach (var m in Modules.All) mods[m.Id] = level == TenantRole.Owner ? m.Max : m.Snap(await permissions.TierLevelAsync(m.Id, level, ct));
        var perms = new HashSet<string>();
        foreach (var p in Permissions.All) if (level == TenantRole.Owner || await permissions.RoleHasAsync(level, p, ct)) perms.Add(p);
        return _levelDefaults[level] = (mods, perms);
    }

    /// <summary>One person's access for an access level and job-role profile, by the same rule PermissionService enforces.</summary>
    private async Task<(Dictionary<string, int> Modules, HashSet<string> Permissions)> EffectiveAsync(TenantRole level, AccessProfile? jobProfile, CancellationToken ct)
    {
        if (jobProfile is not null && level is TenantRole.Manager or TenantRole.Member or TenantRole.Guest)
            return (Modules.All.ToDictionary(m => m.Id, m => jobProfile.Level(m.Id)), jobProfile.Permissions());
        return await DefaultsAsync(level, ct);
    }

    private static PersonImpactDto Diff(Guid userId, string name, (Dictionary<string, int> Modules, HashSet<string> Permissions) before,
        (Dictionary<string, int> Modules, HashSet<string> Permissions)? after)
    {
        var mods = new List<ModuleChangeDto>();
        foreach (var m in Modules.All)
        {
            var from = before.Modules.GetValueOrDefault(m.Id);
            var to = after is { } a ? a.Modules.GetValueOrDefault(m.Id) : 0;
            if (from != to) mods.Add(new ModuleChangeDto(m.Id, m.Label, from, to));
        }
        HashSet<string> afterPerms = after is { } aa ? aa.Permissions : new HashSet<string>();
        return new PersonImpactDto(userId, name, mods,
            afterPerms.Except(before.Permissions).OrderBy(p => p).ToList(), before.Permissions.Except(afterPerms).OrderBy(p => p).ToList(), after is null);
    }

    public async Task<ImpactPreviewDto> PreviewAsync(ImpactRequest req, CancellationToken ct = default)
    {
        var tid = RequireOrganization();
        var kind = (req.Kind ?? "").Trim();
        var warnings = new List<string>();
        var blocked = false;
        var roles = await db.OrgRoles.AsNoTracking().ToDictionaryAsync(r => r.Id, r => new { r.Name, r.AccessJson }, ct);
        AccessProfile? ProfileOf(Guid? roleId) => roleId is { } id && roles.TryGetValue(id, out var found) ? AccessProfile.Parse(found.AccessJson) : null;

        if (kind == "roleAccess")
        {
            await permissions.RequireAsync(Permissions.AccessManage, ct);
            var roleId = req.RoleId ?? throw new ValidationException("roleId", "Choose a job role.");
            if (!roles.ContainsKey(roleId)) throw new NotFoundException("Role not found.");
            foreach (var (id, level) in req.Modules ?? new Dictionary<string, int>())
            {
                var def = Modules.Find(id) ?? throw new ValidationException("modules", $"Unknown module “{id}”.");
                if (!def.Levels.Contains(level)) throw new ValidationException("modules", $"{def.Label} cannot be set to level {level}.");
            }
            var proposed = req.Modules is null ? null : AccessProfile.Build(req.Modules, req.Actions ?? new Dictionary<string, bool>());
            var holders = await (from m in db.TenantMembers.AsNoTracking()
                                 join u in db.Users.AsNoTracking() on m.UserId equals u.Id
                                 where m.TenantId == tid && m.OrgRoleId == roleId
                                 orderby u.DisplayName
                                 select new { m.UserId, u.DisplayName, m.Role }).ToListAsync(ct);
            var people = new List<PersonImpactDto>();
            foreach (var h in holders)
            {
                var d = Diff(h.UserId, h.DisplayName, await EffectiveAsync(h.Role, ProfileOf(roleId), ct), await EffectiveAsync(h.Role, proposed, ct));
                if (d.Modules.Count > 0 || d.Gained.Count > 0 || d.Lost.Count > 0) people.Add(d);
            }
            if (holders.Any(h => h.Role >= TenantRole.Admin))
                warnings.Add("Owners and Admins in this job role keep full access: a job role never narrows them.");
            return new ImpactPreviewDto(kind, people, people.Count, warnings, blocked);
        }

        var userId = req.UserId ?? throw new ValidationException("userId", "Choose a person.");
        var member = await db.TenantMembers.AsNoTracking().Include(m => m.User).FirstOrDefaultAsync(m => m.TenantId == tid && m.UserId == userId, ct)
            ?? throw new NotFoundException("Member not found.");
        var before = await EffectiveAsync(member.Role, ProfileOf(member.OrgRoleId), ct);
        (Dictionary<string, int>, HashSet<string>)? after;
        switch (kind)
        {
            case "accessLevel":
                await permissions.RequireAsync(Permissions.MembersManage, ct);
                var level = req.Role ?? throw new ValidationException("role", "Choose an access level.");
                if (level == TenantRole.Owner) throw new ForbiddenException("Ownership cannot be assigned through this action.", "PERMISSION_DENIED");
                if (member.Role >= TenantRole.Admin && level < TenantRole.Admin && member.Status == MemberStatus.Active && await WouldLeaveNoAdminAsync(tid, userId, ct))
                { warnings.Add(LastAdminMessage); blocked = true; }
                if (member.Role == TenantRole.Owner) { warnings.Add("The workspace owner's access level cannot be changed."); blocked = true; }
                after = await EffectiveAsync(level, ProfileOf(member.OrgRoleId), ct);
                break;
            case "jobRole":
                await permissions.RequireAsync(Permissions.OrgStructure, ct);
                if (req.OrgRoleId is { } newRole && !roles.ContainsKey(newRole)) throw new NotFoundException("Role not found.");
                after = await EffectiveAsync(member.Role, ProfileOf(req.OrgRoleId), ct);
                if (member.Role >= TenantRole.Admin) warnings.Add("Owners and Admins keep full access whatever their job role.");
                break;
            case "suspend":
            case "remove":
                await permissions.RequireAsync(Permissions.MembersManage, ct);
                if (member.Role == TenantRole.Owner) { warnings.Add("The workspace owner cannot be " + (kind == "suspend" ? "suspended." : "removed.")); blocked = true; }
                else if (member.Role >= TenantRole.Admin && await WouldLeaveNoAdminAsync(tid, userId, ct)) { warnings.Add(LastAdminMessage); blocked = true; }
                after = null;
                if (kind == "remove") warnings.Add("Their project and team memberships end, and anyone reporting to them moves up to their manager.");
                else warnings.Add("They are signed out of this workspace. Their history, assignments and reporting lines stay.");
                break;
            default:
                throw new ValidationException("kind", "Unknown change. Use accessLevel, jobRole, roleAccess, suspend or remove.");
        }
        var diff = Diff(userId, member.User!.DisplayName, before, after);
        List<PersonImpactDto> list = diff.Modules.Count > 0 || diff.Gained.Count > 0 || diff.Lost.Count > 0 || diff.LosesWorkspace ? new List<PersonImpactDto> { diff } : new List<PersonImpactDto>();
        return new ImpactPreviewDto(kind, list, list.Count, warnings, blocked);
    }
}
