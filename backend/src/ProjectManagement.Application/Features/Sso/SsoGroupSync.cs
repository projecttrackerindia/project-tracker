using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Sso;

public record GroupMappingDto(Guid Id, string Group, Guid TeamId, string TeamName);
public record GroupMappingsDto(IReadOnlyList<GroupMappingDto> Items, IReadOnlyList<string> SeenGroups);
public record AddGroupMappingRequest(string? Group, Guid TeamId);

/// <summary>
/// Group to team mapping. At every single sign-on the identity provider's group list decides the person's teams among the teams that have a mapping: they
/// are added to the teams of the groups they have and removed from mapped teams they were added to by an earlier sign-in and no longer qualify for. Teams
/// joined by hand are never removed. A provider that sends no group claim means the person has no groups (most omit an empty list). Because documents can be shared with a team, this is
/// how a directory group becomes document access.
/// </summary>
public static class SsoGroupSync
{
    public static async Task SyncAsync(IAppDbContext db, Recorder recorder, AppClock clock, Guid tenantId, Guid userId, IReadOnlyList<string>? groups, CancellationToken ct)
    {
        var mappings = await db.SsoGroupMappings.IgnoreQueryFilters().AsNoTracking().Where(m => m.TenantId == tenantId).ToListAsync(ct);
        if (mappings.Count == 0) return;
        var have = (groups ?? []).ToHashSet(StringComparer.OrdinalIgnoreCase);   // a sign-in with no group claim means no groups: providers omit an empty list, and failing closed is the safe way
        var teamIds = mappings.Select(m => m.TeamId).Distinct().ToList();
        var existingTeams = (await db.Teams.IgnoreQueryFilters().AsNoTracking().Where(t => t.TenantId == tenantId && teamIds.Contains(t.Id)).Select(t => t.Id).ToListAsync(ct)).ToHashSet();
        var wanted = mappings.Where(m => have.Contains(m.Group) && existingTeams.Contains(m.TeamId)).Select(m => m.TeamId).ToHashSet();
        var current = await db.TeamMembers.IgnoreQueryFilters().Where(x => x.TenantId == tenantId && x.UserId == userId && teamIds.Contains(x.TeamId)).ToListAsync(ct);
        int added = 0, removed = 0;
        foreach (var team in wanted.Where(t => current.All(x => x.TeamId != t)))
        {
            db.TeamMembers.Add(new TeamMember { TenantId = tenantId, TeamId = team, UserId = userId, ViaSso = true, CreatedAt = clock.Now });
            added++;
        }
        foreach (var gone in current.Where(x => x.ViaSso && !wanted.Contains(x.TeamId)).ToList()) { db.TeamMembers.Remove(gone); removed++; }
        if (added + removed > 0) recorder.Audit("sso.groups_synced", "User", userId, null, new { added, removed }, tenantId: tenantId, userId: userId);
    }
}

public class SsoGroupMappingService(IAppDbContext db, ICurrentContext ctx, Recorder recorder, EntitlementService entitlements)
{
    public const int Max = 200;

    private Guid RequireAdmin()
    {
        var tid = ctx.RequireTenantId();
        if (ctx.WorkspaceType != WorkspaceType.Organization) throw new ForbiddenException("Single sign-on is for organization workspaces.", "PERMISSION_DENIED");
        if (ctx.Role is not (TenantRole.Owner or TenantRole.Admin)) throw new ForbiddenException("Only owners and admins can manage single sign-on.", "PERMISSION_DENIED");
        return tid;
    }

    public async Task<GroupMappingsDto> ListAsync(CancellationToken ct = default)
    {
        var tid = RequireAdmin();
        var rows = await db.SsoGroupMappings.AsNoTracking().Where(m => m.TenantId == tid).OrderBy(m => m.Group).ToListAsync(ct);
        var names = await db.Teams.AsNoTracking().ToDictionaryAsync(t => t.Id, t => t.Name, ct);
        return new GroupMappingsDto(rows.Select(m => new GroupMappingDto(m.Id, m.Group, m.TeamId, names.GetValueOrDefault(m.TeamId) ?? "Removed team")).ToList(), []);
    }

    public async Task<GroupMappingsDto> AddAsync(AddGroupMappingRequest req, CancellationToken ct = default)
    {
        var tid = RequireAdmin();
        await entitlements.EnsureFeatureAsync(FeatureKeys.AdvancedSecurity, ct);
        var group = (req.Group ?? "").Trim();
        if (group.Length is 0 or > 200) throw new ValidationException("group", "Enter the group's name or id exactly as your identity provider sends it (up to 200 characters).");
        var team = await db.Teams.AsNoTracking().FirstOrDefaultAsync(t => t.Id == req.TeamId, ct) ?? throw new ValidationException("teamId", "Choose a team of this organization.");
        if (await db.SsoGroupMappings.CountAsync(m => m.TenantId == tid, ct) >= Max) throw new ValidationException("group", $"At most {Max} mappings.");
        var lower = group.ToLower();
        if (await db.SsoGroupMappings.AnyAsync(m => m.TenantId == tid && m.TeamId == team.Id && m.Group.ToLower() == lower, ct)) throw new ConflictException("That group is already mapped to this team.", "MAPPING_EXISTS");
        var row = new SsoGroupMapping { TenantId = tid, Group = group, TeamId = team.Id };
        db.SsoGroupMappings.Add(row);
        recorder.Audit("sso.group_mapped", "SsoGroupMapping", row.Id, null, new { group, team = team.Name }, tenantId: tid);
        await db.SaveChangesAsync(ct);
        return await ListAsync(ct);
    }

    public async Task<GroupMappingsDto> RemoveAsync(Guid id, CancellationToken ct = default)
    {
        var tid = RequireAdmin();
        var row = await db.SsoGroupMappings.FirstOrDefaultAsync(m => m.Id == id && m.TenantId == tid, ct) ?? throw new NotFoundException("Mapping not found.");
        db.SsoGroupMappings.Remove(row);
        recorder.Audit("sso.group_unmapped", "SsoGroupMapping", row.Id, new { row.Group }, null, tenantId: tid);
        await db.SaveChangesAsync(ct);
        return await ListAsync(ct);
    }
}
