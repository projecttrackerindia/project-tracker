using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Organization;

public record OrgSecurityDto(bool RequireMfa, bool IpAllowlistEnabled, IReadOnlyList<string> IpRanges, string? MyIp, bool Entitled);
public record SetOrgSecurityRequest(bool RequireMfa, bool IpAllowlistEnabled, IReadOnlyList<string>? IpRanges);
public record ProjectVisibilityDto(string Mode, int Teams, int PeopleWithoutTeam);
public record SetProjectVisibilityRequest(string Mode);
public record AccessBlockedDto(Guid WorkspaceId, string Code, string Message);

/// <summary>
/// An organization's own access rules on top of the platform's: require two-step verification, and/or only allow this workspace from
/// listed IP addresses/ranges. Checked wherever a workspace is entered (CurrentContextMiddleware, WorkspaceService.SwitchAsync) so a
/// blocked person finds out immediately and clearly, rather than having requests fail one at a time for no obvious reason.
/// </summary>
public class OrgSecurityService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, EntitlementService entitlements)
{
    private void RequireManage()
    {
        if (ctx.Role is not (Domain.Enums.TenantRole.Owner or Domain.Enums.TenantRole.Admin))
            throw new ForbiddenException("Only owners and admins can change organization security.", "PERMISSION_DENIED");
    }

    public async Task<OrgSecurityDto> GetAsync(CancellationToken ct = default)
    {
        var tenantId = ctx.RequireTenantId();
        var row = await db.TenantSecuritySettings.AsNoTracking().FirstOrDefaultAsync(s => s.TenantId == tenantId, ct);
        var entitled = await entitlements.GetValueAsync(FeatureKeys.AdvancedSecurity, ct) > 0;
        return new OrgSecurityDto(row?.RequireMfa ?? false, row?.IpAllowlistEnabled ?? false,
            row is null ? [] : IpAllowlist.ParseEntries(row.IpRanges), ctx.IpAddress, entitled);
    }

    public async Task<OrgSecurityDto> SetAsync(SetOrgSecurityRequest req, CancellationToken ct = default)
    {
        var tenantId = ctx.RequireTenantId();
        RequireManage();
        await entitlements.EnsureFeatureAsync(FeatureKeys.AdvancedSecurity, ct);

        var entries = IpAllowlist.ParseEntries(string.Join('\n', req.IpRanges ?? []));
        if (entries.Count > IpAllowlist.MaxEntries) throw new ValidationException("ipRanges", $"List at most {IpAllowlist.MaxEntries} addresses or ranges.");
        foreach (var entry in entries)
            if (!IpAllowlist.TryValidateEntry(entry, out var error)) throw new ValidationException("ipRanges", error!);

        // Two safety checks so an admin can never accidentally lock everyone — including themselves — out with their own change.
        if (req.RequireMfa)
        {
            var me = await db.Users.AsNoTracking().Where(u => u.Id == ctx.RequireUserId()).Select(u => u.MfaEnabled).FirstAsync(ct);
            if (!me) throw new ValidationException("requireMfa", "Turn on two-step verification for your own account first (Settings → Security), or you would be locked out of this workspace.");
        }
        if (req.IpAllowlistEnabled)
        {
            if (entries.Count == 0) throw new ValidationException("ipRanges", "Add at least one address or range.");
            if (!IpAllowlist.Matches(entries, ctx.IpAddress))
                throw new ValidationException("ipRanges", $"Add your own address first ({ctx.IpAddress ?? "unknown"}), or you would be locked out of this workspace.");
        }

        var row = await db.TenantSecuritySettings.FirstOrDefaultAsync(s => s.TenantId == tenantId, ct);
        var before = row is null ? null : new { row.RequireMfa, row.IpAllowlistEnabled, row.IpRanges };
        if (row is null) db.TenantSecuritySettings.Add(row = new TenantSecuritySettings { TenantId = tenantId });
        row.RequireMfa = req.RequireMfa;
        row.IpAllowlistEnabled = req.IpAllowlistEnabled;
        row.IpRanges = string.Join('\n', entries);
        recorder.Audit("org.security_changed", "Tenant", tenantId, oldValue: before, newValue: new { row.RequireMfa, row.IpAllowlistEnabled, row.IpRanges }, tenantId: tenantId);
        await db.SaveChangesAsync(ct);
        return await GetAsync(ct);
    }

    public async Task<ProjectVisibilityDto> GetVisibilityAsync(CancellationToken ct = default)
    {
        var tenantId = ctx.RequireTenantId();
        var mode = await db.Tenants.AsNoTracking().Where(t => t.Id == tenantId).Select(t => t.ProjectVisibility).FirstAsync(ct);
        var teams = await db.Teams.CountAsync(ct);
        var inTeam = db.TeamMembers.Select(m => m.UserId);
        var withoutTeam = await db.TenantMembers.CountAsync(m => m.TenantId == tenantId && m.Role != Domain.Enums.TenantRole.Guest && !inTeam.Contains(m.UserId), ct);
        return new ProjectVisibilityDto(mode == Domain.Enums.ProjectVisibility.Teams ? "teams" : "organization", teams, withoutTeam);
    }

    /// <summary>Organization: everyone who is not a guest sees every project. Teams: people see their own teams' projects, the ones they own or were added to, and everything when their role says so.</summary>
    public async Task<ProjectVisibilityDto> SetVisibilityAsync(SetProjectVisibilityRequest req, CancellationToken ct = default)
    {
        var tenantId = ctx.RequireTenantId();
        if (ctx.Role is not (Domain.Enums.TenantRole.Owner or Domain.Enums.TenantRole.Admin))
            throw new ForbiddenException("Only owners and admins can change who sees which projects.", "PERMISSION_DENIED");
        var mode = req.Mode?.Trim().ToLowerInvariant() switch
        {
            "teams" => Domain.Enums.ProjectVisibility.Teams,
            "organization" => Domain.Enums.ProjectVisibility.Organization,
            _ => throw new ValidationException("mode", "Choose 'organization' or 'teams'."),
        };
        var tenant = await db.Tenants.FirstAsync(t => t.Id == tenantId, ct);
        if (tenant.ProjectVisibility != mode)
        {
            recorder.Audit("org.project_visibility_changed", "Tenant", tenantId, oldValue: new { tenant.ProjectVisibility }, newValue: new { ProjectVisibility = mode }, tenantId: tenantId);
            tenant.ProjectVisibility = mode;
            await db.SaveChangesAsync(ct);
        }
        return await GetVisibilityAsync(ct);
    }

    /// <summary>
    /// Null when the workspace may be entered. Otherwise the reason, for a clear message instead of requests just quietly failing.
    /// Explicit parameters (not ICurrentContext): called while the caller's context for *this* workspace is still being resolved.
    /// <paramref name="mfaEnabled"/> is treated as satisfied for API keys, which cannot have two-step verification of their own.
    /// </summary>
    public async Task<AccessBlockedDto?> CheckAccessAsync(Guid tenantId, bool mfaEnabled, string? ip, CancellationToken ct = default)
    {
        var row = await db.TenantSecuritySettings.IgnoreQueryFilters().AsNoTracking().FirstOrDefaultAsync(s => s.TenantId == tenantId, ct);
        if (row is null || (!row.RequireMfa && !row.IpAllowlistEnabled)) return null;
        var entitlementValue = (await entitlements.GetEntitlementsAsync(tenantId, ct)).GetValueOrDefault(FeatureKeys.AdvancedSecurity);
        if (entitlementValue <= 0) return null;   // plan lapsed: fail open, not closed

        if (row.RequireMfa && !mfaEnabled)
            return new AccessBlockedDto(tenantId, "ORG_MFA_REQUIRED", "This organization requires two-step verification. Turn it on in Settings → Security to continue.");
        if (row.IpAllowlistEnabled && !IpAllowlist.Matches(IpAllowlist.ParseEntries(row.IpRanges), ip))
            return new AccessBlockedDto(tenantId, "ORG_IP_BLOCKED", "Your network is not on this organization's allowed list. Ask an administrator to add it.");
        return null;
    }
}
