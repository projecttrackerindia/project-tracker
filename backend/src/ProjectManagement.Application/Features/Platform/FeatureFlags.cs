using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Platform;

public record FeatureFlagDefinition(string Key, string Label, string Description, bool Default);

/// <summary>
/// The features that can be switched per workspace, team or person, each with its safe default (what everyone gets until an admin
/// decides otherwise). The same keys are in frontend/src/lib/flags.ts. A key not in this list is refused.
/// </summary>
public static class FeatureFlagCatalog
{
    public const string SmartGrouping = "smart-grouping", WhatsNew = "whats-new", ShakeToReport = "shake-to-report", ReportProblem = "report-problem";

    public static readonly FeatureFlagDefinition[] All =
    [
        new(SmartGrouping, "Grouped notifications", "Bursts of updates about one project or thread show as one group and ping once.", true),
        new(WhatsNew, "What’s new", "A short note about the release, once, after each update.", true),
        new(ReportProblem, "Report a problem", "The “Report a problem” button in the ⋯ menu and Settings.", true),
        new(ShakeToReport, "Shake to report", "On a phone, shaking opens “Report a problem”.", false),
    ];

    public static FeatureFlagDefinition? Find(string? key) => All.FirstOrDefault(d => string.Equals(d.Key, key?.Trim(), StringComparison.OrdinalIgnoreCase));
}

public static class FeatureFlagScopes
{
    public const string Workspace = "workspace", Team = "team", User = "user";
}

public record FeatureFlagOverrideDto(string Scope, Guid TargetId, string Name, bool Enabled);
/// <param name="Workspace">The workspace's own setting, or null when it follows the default.</param>
public record FeatureFlagDto(string Key, string Label, string Description, bool Default, bool? Workspace, bool Effective, IReadOnlyList<FeatureFlagOverrideDto> Overrides);
/// <param name="Enabled">On or off; null removes the setting at this scope (back to the next one up).</param>
public record SetFeatureFlagRequest(string Scope, Guid? TargetId, bool? Enabled);

/// <summary>Feature flags: resolved for the signed-in person (most specific wins: person, team, workspace, default) and managed by admins.</summary>
public class FeatureFlagService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder)
{
    private bool IsAdmin => ctx.Role is TenantRole.Owner or TenantRole.Admin;

    /// <summary>Every flag for the signed-in person: their own setting, else any of their teams' (on wins), else the workspace's, else the default.</summary>
    public async Task<IReadOnlyDictionary<string, bool>> MineAsync(CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var teams = await db.TeamMembers.AsNoTracking().Where(m => m.UserId == uid).Select(m => m.TeamId).ToListAsync(ct);
        var rows = await db.FeatureFlags.AsNoTracking()
            .Where(f => f.Scope == FeatureFlagScopes.Workspace || (f.Scope == FeatureFlagScopes.User && f.TargetId == uid) || (f.Scope == FeatureFlagScopes.Team && teams.Contains(f.TargetId)))
            .ToListAsync(ct);
        return FeatureFlagCatalog.All.ToDictionary(d => d.Key, d => Resolve(d, rows.Where(r => r.Key == d.Key).ToList()));
    }

    public static bool Resolve(FeatureFlagDefinition d, IReadOnlyList<FeatureFlag> rows)
    {
        if (rows.FirstOrDefault(r => r.Scope == FeatureFlagScopes.User) is { } u) return u.Enabled;
        var team = rows.Where(r => r.Scope == FeatureFlagScopes.Team).ToList();
        if (team.Count > 0) return team.Any(r => r.Enabled);
        if (rows.FirstOrDefault(r => r.Scope == FeatureFlagScopes.Workspace) is { } w) return w.Enabled;
        return d.Default;
    }

    public async Task<IReadOnlyList<FeatureFlagDto>> ListAsync(CancellationToken ct = default)
    {
        if (!IsAdmin) throw new ForbiddenException("Only owners and admins can manage feature flags.", "PERMISSION_DENIED");
        var rows = await db.FeatureFlags.AsNoTracking().ToListAsync(ct);
        var teamIds = rows.Where(r => r.Scope == FeatureFlagScopes.Team).Select(r => r.TargetId).Distinct().ToList();
        var userIds = rows.Where(r => r.Scope == FeatureFlagScopes.User).Select(r => r.TargetId).Distinct().ToList();
        var teams = await db.Teams.AsNoTracking().Where(t => teamIds.Contains(t.Id)).ToDictionaryAsync(t => t.Id, t => t.Name, ct);
        var users = await db.Users.AsNoTracking().Where(u => userIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        return FeatureFlagCatalog.All.Select(d =>
        {
            var mine = rows.Where(r => string.Equals(r.Key, d.Key, StringComparison.Ordinal)).ToList();
            var w = mine.FirstOrDefault(r => r.Scope == FeatureFlagScopes.Workspace);
            var overrides = mine.Where(r => r.Scope != FeatureFlagScopes.Workspace)
                .Select(r => new FeatureFlagOverrideDto(r.Scope, r.TargetId, r.Scope == FeatureFlagScopes.Team ? teams.GetValueOrDefault(r.TargetId, "A team") : users.GetValueOrDefault(r.TargetId, "Someone"), r.Enabled))
                .OrderBy(o => o.Scope).ThenBy(o => o.Name).ToList();
            return new FeatureFlagDto(d.Key, d.Label, d.Description, d.Default, w?.Enabled, w?.Enabled ?? d.Default, overrides);
        }).ToList();
    }

    public async Task<IReadOnlyList<FeatureFlagDto>> SetAsync(string key, SetFeatureFlagRequest req, CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        if (ctx.ViaApiKey) throw new ForbiddenException("API keys cannot change feature flags.", "API_KEY_NOT_ALLOWED");
        if (!IsAdmin) throw new ForbiddenException("Only owners and admins can manage feature flags.", "PERMISSION_DENIED");
        var def = FeatureFlagCatalog.Find(key) ?? throw new NotFoundException("Unknown feature.");
        var scope = (req.Scope ?? "").Trim().ToLowerInvariant();
        Guid target;
        switch (scope)
        {
            case FeatureFlagScopes.Workspace: target = Guid.Empty; break;
            case FeatureFlagScopes.Team:
                target = req.TargetId ?? Guid.Empty;
                if (!await db.Teams.AsNoTracking().AnyAsync(t => t.Id == target, ct)) throw new ValidationException("targetId", "Choose a team in this workspace.");
                break;
            case FeatureFlagScopes.User:
                target = req.TargetId ?? Guid.Empty;
                if (!await db.TenantMembers.AsNoTracking().AnyAsync(m => m.TenantId == tid && m.UserId == target, ct)) throw new ValidationException("targetId", "Choose a member of this workspace.");
                break;
            default: throw new ValidationException("scope", "Scope is workspace, team or user.");
        }
        var row = await db.FeatureFlags.FirstOrDefaultAsync(f => f.Key == def.Key && f.Scope == scope && f.TargetId == target, ct);
        var before = row?.Enabled;
        if (req.Enabled is not { } on)
        {
            if (row is not null) db.FeatureFlags.Remove(row);
        }
        else
        {
            if (row is null) db.FeatureFlags.Add(row = new FeatureFlag { TenantId = tid, Key = def.Key, Scope = scope, TargetId = target, CreatedAt = clock.Now, CreatedBy = ctx.UserId });
            row.Enabled = on; row.UpdatedAt = clock.Now; row.UpdatedBy = ctx.UserId;
        }
        if (before != req.Enabled) recorder.Audit("feature_flag.changed", "FeatureFlag", row?.Id, new { key = def.Key, scope, target, enabled = before }, new { key = def.Key, scope, target, enabled = req.Enabled }, tenantId: tid);
        await db.SaveChangesAsync(ct);
        return await ListAsync(ct);
    }
}
