using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Organization;

public record OrgRoleDto(Guid Id, string Name, string? Description, string Color, Guid? ParentRoleId, double? PosX, double? PosY,
    int PeopleCount, int ChildCount, bool IsDeleted, DateTime? DeletedAt, bool HasAccess);
public record OrgPersonDto(Guid UserId, string DisplayName, string Email, TenantRole AccessRole, Guid? RoleId, Guid? ReportsToUserId);
public record OrgStructureDto(IReadOnlyList<OrgRoleDto> Roles, IReadOnlyList<OrgPersonDto> People, bool CanManage);

public record CreateOrgRoleRequest(string Name, string? Description, string? Color, Guid? ParentRoleId);
public record UpdateOrgRoleRequest(string Name, string? Description, string? Color);
public record MoveOrgRoleRequest(Guid? ParentRoleId);
public record OrgLayoutItem(Guid Id, double? X, double? Y);
public record OrgLayoutRequest(IReadOnlyList<OrgLayoutItem> Items);
public record AssignOrgRoleRequest(Guid? RoleId);
public record SetReportsToRequest(Guid? ReportsToUserId);
public record ApplyOrgTemplateRequest(string Template);

/// <summary>
/// The organization chart: job roles (a tree), which role each person holds and who reports to whom.
/// Anyone except guests can read it; only holders of <see cref="Permissions.OrgStructure"/> can change it.
/// </summary>
public class OrgService(IAppDbContext db, ICurrentContext ctx, PermissionService permissions, Recorder recorder, AppClock clock)
{
    private const int MaxRoles = 200;
    private static readonly string[] Palette = ["#8b5cf6", "#38bdf8", "#34d399", "#fbbf24", "#fb7185", "#c084fc", "#f97316", "#94a3b8"];

    /// <summary>Roles for a starter template: (name, parent name, description, colour).</summary>
    private static readonly Dictionary<string, (string Name, string? Parent, string Description, string Color)[]> Templates = new(StringComparer.OrdinalIgnoreCase)
    {
        ["software"] =
        [
            ("CTO", null, "Owns technology strategy and the whole delivery organization.", "#8b5cf6"),
            ("Principal Manager", "CTO", "Senior manager across product, delivery and data.", "#7c3aed"),
            ("Product Manager", "Principal Manager", "Owns the product roadmap and priorities.", "#38bdf8"),
            ("Delivery Manager", "Principal Manager", "Owns delivery, timelines and release readiness.", "#34d399"),
            ("Business Analyst", "Product Manager", "Turns business needs into requirements.", "#c084fc"),
            ("Business User", "Product Manager", "Stakeholder who follows progress (mostly view-only).", "#94a3b8"),
            ("Project Lead", "Delivery Manager", "Leads a project team day to day.", "#fbbf24"),
            ("Developer", "Project Lead", "Builds and ships features.", "#f97316"),
            ("Tester (QA)", "Project Lead", "Verifies quality before release.", "#fb7185"),
            ("Data Engineer", "Principal Manager", "Builds and maintains data pipelines.", "#38bdf8"),
            ("Data Analyst", "Principal Manager", "Analyses data and builds reports.", "#34d399"),
        ],
    };

    // ---------------------------------------------------------------- read

    private Guid RequireOrganization()
    {
        var tid = ctx.RequireTenantId();
        if (ctx.WorkspaceType == WorkspaceType.Personal)
            throw new ForbiddenException("Personal workspaces do not have an organization chart.", "PERSONAL_WORKSPACE");
        if (ctx.Role == TenantRole.Guest)
            throw new ForbiddenException("Guests cannot view the organization chart.", "PERMISSION_DENIED");
        return tid;
    }

    private async Task<Guid> RequireManageAsync(CancellationToken ct)
    {
        var tid = RequireOrganization();
        await permissions.RequireAsync(Permissions.OrgStructure, ct);
        return tid;
    }

    public async Task<OrgStructureDto> GetAsync(CancellationToken ct = default)
    {
        var tid = RequireOrganization();
        var roles = await db.OrgRoles.IgnoreQueryFilters().AsNoTracking().Where(r => r.TenantId == tid)
            .OrderBy(r => r.SortOrder).ThenBy(r => r.CreatedAt).ToListAsync(ct);
        var members = await db.TenantMembers.AsNoTracking().Include(m => m.User).Where(m => m.TenantId == tid)
            .OrderBy(m => m.User!.DisplayName).ToListAsync(ct);

        var people = members.GroupBy(m => m.OrgRoleId).Where(g => g.Key is not null).ToDictionary(g => g.Key!.Value, g => g.Count());
        var kids = roles.Where(r => !r.IsDeleted && r.ParentRoleId is not null).GroupBy(r => r.ParentRoleId!.Value).ToDictionary(g => g.Key, g => g.Count());

        return new OrgStructureDto(
            roles.Select(r => new OrgRoleDto(r.Id, r.Name, r.Description, r.Color, r.ParentRoleId, r.PosX, r.PosY,
                people.GetValueOrDefault(r.Id), kids.GetValueOrDefault(r.Id), r.IsDeleted, r.DeletedAt, r.AccessJson != null)).ToList(),
            members.Select(m => new OrgPersonDto(m.UserId, m.User!.DisplayName, m.User.Email, m.Role,
                // a member pointing at a deleted role is shown as unassigned
                roles.Any(r => r.Id == m.OrgRoleId && !r.IsDeleted) ? m.OrgRoleId : null, m.ReportsToUserId)).ToList(),
            await permissions.HasAsync(Permissions.OrgStructure, ct));
    }

    // ---------------------------------------------------------------- roles

    private static string CleanColor(string? color, int index) =>
        string.IsNullOrWhiteSpace(color) ? Palette[index % Palette.Length] : color.Trim();

    private async Task EnsureNameFreeAsync(string name, Guid? exceptId, CancellationToken ct)
    {
        var lower = name.ToLower();
        if (await db.OrgRoles.AnyAsync(r => r.Name.ToLower() == lower && r.Id != exceptId, ct))
            throw new ConflictException($"A role named “{name}” already exists.", "ROLE_NAME_EXISTS");
    }

    /// <summary>True when <paramref name="candidate"/> is <paramref name="roleId"/> itself or sits below it in the tree.</summary>
    private static bool IsSelfOrDescendant(Guid roleId, Guid candidate, IReadOnlyDictionary<Guid, Guid?> parents)
    {
        var guard = 0;
        Guid? cur = candidate;
        while (cur is { } id && guard++ <= parents.Count)
        {
            if (id == roleId) return true;
            cur = parents.GetValueOrDefault(id);
        }
        return false;
    }

    private async Task<Dictionary<Guid, Guid?>> ParentMapAsync(CancellationToken ct) =>
        await db.OrgRoles.AsNoTracking().ToDictionaryAsync(r => r.Id, r => r.ParentRoleId, ct);

    private async Task<OrgRole> FindActiveAsync(Guid id, CancellationToken ct) =>
        await db.OrgRoles.FirstOrDefaultAsync(r => r.Id == id, ct) ?? throw new NotFoundException("Role not found.");

    public async Task<OrgRoleDto> CreateRoleAsync(CreateOrgRoleRequest req, CancellationToken ct = default)
    {
        var tid = await RequireManageAsync(ct);
        var name = req.Name.Trim();
        var count = await db.OrgRoles.CountAsync(ct);
        if (count >= MaxRoles) throw new ValidationException("name", $"An organization can have up to {MaxRoles} roles.");
        await EnsureNameFreeAsync(name, null, ct);
        if (req.ParentRoleId is { } p && !await db.OrgRoles.AnyAsync(r => r.Id == p, ct))
            throw new ValidationException("parentRoleId", "The parent role does not exist.");

        var role = new OrgRole
        {
            TenantId = tid, Name = name, Description = req.Description?.Trim(), Color = CleanColor(req.Color, count),
            ParentRoleId = req.ParentRoleId, SortOrder = count,
        };
        db.OrgRoles.Add(role);
        recorder.Audit("org.role_created", "OrgRole", role.Id, newValue: new { role.Name, role.ParentRoleId });
        await db.SaveChangesAsync(ct);
        return new OrgRoleDto(role.Id, role.Name, role.Description, role.Color, role.ParentRoleId, null, null, 0, 0, false, null, false);
    }

    public async Task UpdateRoleAsync(Guid id, UpdateOrgRoleRequest req, CancellationToken ct = default)
    {
        await RequireManageAsync(ct);
        var role = await FindActiveAsync(id, ct);
        var name = req.Name.Trim();
        await EnsureNameFreeAsync(name, id, ct);

        var old = new { role.Name, role.Description, role.Color };
        role.Name = name;
        role.Description = string.IsNullOrWhiteSpace(req.Description) ? null : req.Description.Trim();
        if (!string.IsNullOrWhiteSpace(req.Color)) role.Color = req.Color.Trim();
        recorder.Audit("org.role_updated", "OrgRole", id, old, new { role.Name, role.Description, role.Color });
        await db.SaveChangesAsync(ct);
    }

    /// <summary>Connect a role to a new parent (or make it a root). A role can never be placed under itself or its own sub-roles.</summary>
    public async Task MoveRoleAsync(Guid id, MoveOrgRoleRequest req, CancellationToken ct = default)
    {
        await RequireManageAsync(ct);
        var role = await FindActiveAsync(id, ct);
        if (req.ParentRoleId is { } parent)
        {
            if (!await db.OrgRoles.AnyAsync(r => r.Id == parent, ct)) throw new NotFoundException("The new parent role was not found.");
            if (IsSelfOrDescendant(id, parent, await ParentMapAsync(ct)))
                throw new ConflictException("A role cannot report to itself or to one of its own sub-roles.", "ORG_CYCLE");
        }
        if (role.ParentRoleId == req.ParentRoleId) return;

        var old = role.ParentRoleId;
        role.ParentRoleId = req.ParentRoleId;
        recorder.Audit("org.role_moved", "OrgRole", id, new { ParentRoleId = old }, new { req.ParentRoleId });
        await db.SaveChangesAsync(ct);
    }

    public async Task SaveLayoutAsync(OrgLayoutRequest req, CancellationToken ct = default)
    {
        await RequireManageAsync(ct);
        var ids = req.Items.Select(i => i.Id).ToList();
        var roles = await db.OrgRoles.Where(r => ids.Contains(r.Id)).ToDictionaryAsync(r => r.Id, ct);
        foreach (var item in req.Items)
        {
            if (!roles.TryGetValue(item.Id, out var role)) continue;
            role.PosX = item.X is { } x && double.IsFinite(x) ? x : null;
            role.PosY = item.Y is { } y && double.IsFinite(y) ? y : null;
        }
        await db.SaveChangesAsync(ct);
    }

    /// <summary>
    /// Soft delete. People and sub-roles are moved to <paramref name="moveTo"/> (default: the deleted role's parent),
    /// so nobody is left without a place. The role itself stays in the database and can be restored.
    /// </summary>
    public async Task<(int People, int Roles)> DeleteRoleAsync(Guid id, Guid? moveTo, CancellationToken ct = default)
    {
        var tid = await RequireManageAsync(ct);
        var role = await FindActiveAsync(id, ct);
        var parents = await ParentMapAsync(ct);

        var target = moveTo ?? role.ParentRoleId;
        if (moveTo is { } m)
        {
            if (!parents.ContainsKey(m)) throw new NotFoundException("The role to move people to was not found.");
            if (IsSelfOrDescendant(id, m, parents))
                throw new ConflictException("Choose a role outside the one being deleted.", "ORG_CYCLE");
        }

        var children = await db.OrgRoles.Where(r => r.ParentRoleId == id).ToListAsync(ct);
        foreach (var child in children) child.ParentRoleId = target;
        var people = await db.TenantMembers.Where(x => x.TenantId == tid && x.OrgRoleId == id).ToListAsync(ct);
        foreach (var person in people) person.OrgRoleId = target;

        role.PreviousParentRoleId = role.ParentRoleId;
        role.ParentRoleId = null;
        role.PosX = role.PosY = null;
        role.IsDeleted = true;
        role.DeletedAt = clock.Now;
        role.DeletedBy = ctx.UserId;
        recorder.Audit("org.role_deleted", "OrgRole", id, new { role.Name }, new { MovedTo = target, People = people.Count, SubRoles = children.Count });
        await db.SaveChangesAsync(ct);
        return (people.Count, children.Count);
    }

    /// <summary>Bring a deleted role back under its previous parent (or as a root if that role is gone).</summary>
    public async Task<OrgRoleDto> RestoreRoleAsync(Guid id, CancellationToken ct = default)
    {
        var tid = await RequireManageAsync(ct);
        var role = await db.OrgRoles.IgnoreQueryFilters().FirstOrDefaultAsync(r => r.Id == id && r.TenantId == tid, ct)
            ?? throw new NotFoundException("Role not found.");
        if (!role.IsDeleted) throw new ConflictException("This role is not deleted.", "NOT_DELETED");
        await EnsureNameFreeAsync(role.Name, id, ct);

        var parent = role.PreviousParentRoleId;
        if (parent is { } p && !await db.OrgRoles.AnyAsync(r => r.Id == p, ct)) parent = null;
        role.IsDeleted = false;
        role.DeletedAt = null;
        role.DeletedBy = null;
        role.ParentRoleId = parent;
        role.PreviousParentRoleId = null;
        recorder.Audit("org.role_restored", "OrgRole", id, newValue: new { role.Name, role.ParentRoleId });
        await db.SaveChangesAsync(ct);
        return new OrgRoleDto(role.Id, role.Name, role.Description, role.Color, role.ParentRoleId, null, null, 0, 0, false, null, role.AccessJson != null);
    }

    // ---------------------------------------------------------------- people

    private async Task<TenantMember> FindMemberAsync(Guid userId, Guid tid, CancellationToken ct) =>
        await db.TenantMembers.Include(m => m.User).FirstOrDefaultAsync(m => m.TenantId == tid && m.UserId == userId, ct)
        ?? throw new NotFoundException("Member not found.");

    public async Task AssignRoleAsync(Guid userId, AssignOrgRoleRequest req, CancellationToken ct = default)
    {
        var tid = await RequireManageAsync(ct);
        var member = await FindMemberAsync(userId, tid, ct);
        if (req.RoleId is { } r && !await db.OrgRoles.AnyAsync(x => x.Id == r, ct))
            throw new NotFoundException("Role not found.");
        if (member.OrgRoleId == req.RoleId) return;

        var old = member.OrgRoleId;
        member.OrgRoleId = req.RoleId;
        recorder.Audit("org.member_role_assigned", "TenantMember", member.Id, new { RoleId = old }, new { req.RoleId, Member = member.User!.DisplayName });
        await db.SaveChangesAsync(ct);
    }

    /// <summary>Set who a member reports to. Loops (A → B → A) are rejected.</summary>
    public async Task SetReportsToAsync(Guid userId, SetReportsToRequest req, CancellationToken ct = default)
    {
        var tid = await RequireManageAsync(ct);
        var member = await FindMemberAsync(userId, tid, ct);
        if (req.ReportsToUserId is { } boss)
        {
            if (boss == userId) throw new ConflictException("Nobody can report to themselves.", "ORG_CYCLE");
            var chain = await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid).ToDictionaryAsync(m => m.UserId, m => m.ReportsToUserId, ct);
            if (!chain.ContainsKey(boss)) throw new NotFoundException("The person to report to is not a member of this organization.");
            var seen = new HashSet<Guid>();
            for (Guid? cur = boss; cur is { } id && seen.Add(id); cur = chain.GetValueOrDefault(id))
                if (id == userId) throw new ConflictException("That would create a reporting loop.", "ORG_CYCLE");
        }
        if (member.ReportsToUserId == req.ReportsToUserId) return;

        var old = member.ReportsToUserId;
        member.ReportsToUserId = req.ReportsToUserId;
        recorder.Audit("org.reports_to_changed", "TenantMember", member.Id, new { ReportsTo = old }, new { req.ReportsToUserId, Member = member.User!.DisplayName });
        await db.SaveChangesAsync(ct);
    }

    // ---------------------------------------------------------------- templates

    /// <summary>Adds the template's roles that do not exist yet (matched by name). Never touches existing roles or people.</summary>
    public async Task<int> ApplyTemplateAsync(ApplyOrgTemplateRequest req, CancellationToken ct = default)
    {
        var tid = await RequireManageAsync(ct);
        if (!Templates.TryGetValue(req.Template, out var template)) throw new ValidationException("template", "Unknown template.");

        var existing = await db.OrgRoles.ToListAsync(ct);
        var byName = existing.ToDictionary(r => r.Name, r => r, StringComparer.OrdinalIgnoreCase);
        var missing = template.Count(t => !byName.ContainsKey(t.Name));
        if (existing.Count + missing > MaxRoles) throw new ValidationException("template", $"An organization can have up to {MaxRoles} roles.");
        var order = existing.Count;
        var created = 0;
        foreach (var t in template)
        {
            if (byName.ContainsKey(t.Name)) continue;
            var role = new OrgRole
            {
                TenantId = tid, Name = t.Name, Description = t.Description, Color = t.Color, SortOrder = order++,
                ParentRoleId = t.Parent is not null && byName.TryGetValue(t.Parent, out var p) ? p.Id : null,
            };
            db.OrgRoles.Add(role);
            byName[t.Name] = role;
            created++;
        }
        recorder.Audit("org.template_applied", "OrgRole", null, newValue: new { req.Template, Created = created });
        await db.SaveChangesAsync(ct);
        return created;
    }
}
