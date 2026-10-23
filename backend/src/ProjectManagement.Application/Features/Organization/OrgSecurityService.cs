using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Application.Features.Auth;

namespace ProjectManagement.Application.Features.Organization;

public record OrgSecurityDto(bool RequireMfa, bool IpAllowlistEnabled, IReadOnlyList<string> IpRanges, string? MyIp, bool Entitled,
    int MinPasswordLength = 0, int SessionHours = 0, IReadOnlyList<string>? AllowedSignIn = null, int PlatformMinPasswordLength = 8);
/// <summary>The newer rules are optional: left out, they keep their current values.</summary>
public record SetOrgSecurityRequest(bool RequireMfa, bool IpAllowlistEnabled, IReadOnlyList<string>? IpRanges,
    int? MinPasswordLength = null, int? SessionHours = null, IReadOnlyList<string>? AllowedSignIn = null);
/// <summary>How the sign-in being checked was made, for the workspace's own rules.</summary>
public record SignInFacts(string? Method, DateTime OpenedAt, int? PasswordLength);
/// <summary>One member in the admin's security view: what protects their account and what does not.</summary>
public record MemberSecurityDto(Guid UserId, string Name, string Email, string Role, bool TwoStep, int Passkeys, DateTime? PasswordChangedAt, int? PasswordLength,
    DateTime? LastSignInAt, IReadOnlyList<string> Issues, DateTime? RemindedAt);
public record SecurityOverviewDto(int Members, int WithoutTwoStep, int WeakPasswords, int OldPasswords, IReadOnlyList<MemberSecurityDto> People);
public record SecurityReminderRequest(IReadOnlyList<Guid> UserIds, string Topic);
public record ProjectVisibilityDto(string Mode, int Teams, int PeopleWithoutTeam);
public record SetProjectVisibilityRequest(string Mode);
public record AccessBlockedDto(Guid WorkspaceId, string Code, string Message);

/// <summary>
/// An organization's own access rules on top of the platform's: require two-step verification, and/or only allow this workspace from
/// listed IP addresses/ranges. Checked wherever a workspace is entered (CurrentContextMiddleware, WorkspaceService.SwitchAsync) so a
/// blocked person finds out immediately and clearly, rather than having requests fail one at a time for no obvious reason.
/// </summary>
public class OrgSecurityService(IAppDbContext db, ICurrentContext ctx, Recorder recorder, EntitlementService entitlements, AppClock clock,
    ProjectManagement.Application.Features.Admin.PlatformSettingsCache platform, ProjectManagement.Application.Features.Notifications.NotificationService notifications)
{
    private void RequireManage()
    {
        if (ctx.ViaApiKey) throw new ForbiddenException("API keys cannot change organization security.", "API_KEY_NOT_ALLOWED");
        if (ctx.Role is not (Domain.Enums.TenantRole.Owner or Domain.Enums.TenantRole.Admin))
            throw new ForbiddenException("Only owners and admins can change organization security.", "PERMISSION_DENIED");
    }

    public async Task<OrgSecurityDto> GetAsync(CancellationToken ct = default)
    {
        var tenantId = ctx.RequireTenantId();
        var row = await db.TenantSecuritySettings.AsNoTracking().FirstOrDefaultAsync(s => s.TenantId == tenantId, ct);
        var entitled = await entitlements.GetValueAsync(FeatureKeys.AdvancedSecurity, ct) > 0;
        var platformMin = (await platform.GetPasswordPolicyAsync(ct)).MinLength;
        return new OrgSecurityDto(row?.RequireMfa ?? false, row?.IpAllowlistEnabled ?? false,
            row is null ? [] : IpAllowlist.ParseEntries(row.IpRanges), ctx.IpAddress, entitled,
            row?.MinPasswordLength ?? 0, row?.SessionHours ?? 0, Methods(row?.AllowedSignIn), platformMin);
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
            if (!me) throw new ValidationException("requireMfa", "Turn on two-step verification for your own account first (My account → Sign-in & security), or you would be locked out of this workspace.");
        }
        if (req.IpAllowlistEnabled)
        {
            if (entries.Count == 0) throw new ValidationException("ipRanges", "Add at least one address or range.");
            if (!IpAllowlist.Matches(entries, ctx.IpAddress))
                throw new ValidationException("ipRanges", $"Add your own address first ({ctx.IpAddress ?? "unknown"}), or you would be locked out of this workspace.");
        }

        if (req.MinPasswordLength is { } minLength && minLength != 0 && (minLength < PasswordRules.MinAllowed || minLength > PasswordRules.MaxAllowed))
            throw new ValidationException("minPasswordLength", $"Choose {PasswordRules.MinAllowed} to {PasswordRules.MaxAllowed} characters, or 0 to follow the platform.");
        if (req.SessionHours is { } hours && hours != 0 && (hours < 1 || hours > 24 * 90))
            throw new ValidationException("sessionHours", "Choose 1 hour to 90 days, or 0 to follow the platform.");
        List<string>? methods = null;
        if (req.AllowedSignIn is { } wanted)
        {
            methods = wanted.Select(m => (m ?? "").Trim().ToLowerInvariant()).Where(m => m.Length > 0).Distinct().ToList();
            if (methods.FirstOrDefault(m => !AllMethods.Contains(m)) is { } unknown) throw new ValidationException("allowedSignIn", $"Unknown sign-in method: {unknown}.");
            if (methods.Count > 0 && ctx.SessionId is { } mine
                && await db.UserSessions.AsNoTracking().Where(s => s.Id == mine).Select(s => s.AuthMethod).FirstOrDefaultAsync(ct) is { } myMethod
                && !methods.Contains(Category(myMethod)) && Category(myMethod) != "device")
                throw new ValidationException("allowedSignIn", $"Keep the way you signed in now ({Category(myMethod)}), or you would be locked out of this workspace.");
        }
        if (req.MinPasswordLength is > 0 and var min && ctx.UserId is { } meId
            && await db.Users.AsNoTracking().Where(u => u.Id == meId).Select(u => u.PasswordLength).FirstOrDefaultAsync(ct) is { } myLength && myLength < min
            && ctx.SessionId is { } sid && Category(await db.UserSessions.AsNoTracking().Where(s => s.Id == sid).Select(s => s.AuthMethod).FirstOrDefaultAsync(ct)) == "password")
            throw new ValidationException("minPasswordLength", $"Your own password is shorter than {min} characters. Change it first (My account → Sign-in & security), or you would be locked out.");

        var row = await db.TenantSecuritySettings.FirstOrDefaultAsync(s => s.TenantId == tenantId, ct);
        var before = row is null ? null : new { row.RequireMfa, row.IpAllowlistEnabled, row.IpRanges, row.MinPasswordLength, row.SessionHours, row.AllowedSignIn };
        if (row is null) db.TenantSecuritySettings.Add(row = new TenantSecuritySettings { TenantId = tenantId });
        row.RequireMfa = req.RequireMfa;
        row.IpAllowlistEnabled = req.IpAllowlistEnabled;
        row.IpRanges = string.Join('\n', entries);
        if (req.MinPasswordLength is { } ml) row.MinPasswordLength = ml;
        if (req.SessionHours is { } sh) row.SessionHours = sh;
        if (methods is not null) row.AllowedSignIn = methods.Count == AllMethods.Length ? "" : string.Join(',', methods);
        recorder.Audit("org.security_changed", "Tenant", tenantId, oldValue: before,
            newValue: new { row.RequireMfa, row.IpAllowlistEnabled, row.IpRanges, row.MinPasswordLength, row.SessionHours, row.AllowedSignIn }, tenantId: tenantId);
        await db.SaveChangesAsync(ct);
        return await GetAsync(ct);
    }

    public static readonly string[] AllMethods = ["password", "passkey", "google", "microsoft", "github", "apple", "sso"];

    /// <summary>The kind of sign-in a session's method belongs to (password with or without two-step counts as password).</summary>
    public static string Category(string? method) => method switch
    {
        null or "" => "password",
        "password" or "password+mfa" => "password",
        _ => method.ToLowerInvariant(),
    };

    private static List<string> Methods(string? stored) =>
        string.IsNullOrWhiteSpace(stored) ? [.. AllMethods] : stored.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Where(AllMethods.Contains).ToList();

    private static string Label(string m) => m switch
    {
        "password" => "a password", "passkey" => "a passkey", "sso" => "your organization's single sign-on", "github" => "GitHub",
        _ => char.ToUpperInvariant(m[0]) + m[1..],
    };

    private static string Hours(int h) => h % 24 == 0 ? (h == 24 ? "day" : $"{h / 24} days") : h == 1 ? "hour" : $"{h} hours";

    // ---------------------------------------------------------------- the admin's view of members' account security

    /// <summary>
    /// Everyone in the workspace and what protects their account: two-step verification, passkeys, how old and how long their password is
    /// (never the password), when they last signed in, and the gaps to close. Owners and admins only.
    /// </summary>
    public async Task<SecurityOverviewDto> OverviewAsync(CancellationToken ct = default)
    {
        var tenantId = ctx.RequireTenantId();
        RequireManage();
        var row = await db.TenantSecuritySettings.AsNoTracking().FirstOrDefaultAsync(s => s.TenantId == tenantId, ct);
        var strong = Math.Max(12, row?.MinPasswordLength ?? 0);
        var now = clock.Now;
        var people = await (from m in db.TenantMembers.AsNoTracking()
                            join u in db.Users.AsNoTracking() on m.UserId equals u.Id
                            where m.TenantId == tenantId && u.IsActive
                            orderby u.DisplayName
                            select new { u.Id, u.DisplayName, u.Email, m.Role, u.MfaEnabled, u.PasswordChangedAt, u.PasswordLength, u.LastLoginAt, u.PasswordHash }).Take(2000).ToListAsync(ct);
        var ids = people.Select(p => p.Id).ToList();
        var passkeys = await db.PasskeyCredentials.AsNoTracking().Where(k => ids.Contains(k.UserId)).GroupBy(k => k.UserId).Select(g => new { g.Key, Count = g.Count() }).ToDictionaryAsync(x => x.Key, x => x.Count, ct);
        var reminded = await db.Notifications.AsNoTracking().Where(n => n.TenantId == tenantId && ids.Contains(n.UserId) && n.DedupeKey != null && n.DedupeKey.StartsWith("security-remind:") && n.CreatedAt > now.AddDays(-30))
            .GroupBy(n => n.UserId).Select(g => new { g.Key, At = g.Max(n => n.CreatedAt) }).ToDictionaryAsync(x => x.Key, x => x.At, ct);
        var list = people.Select(p =>
        {
            var issues = new List<string>();
            var keys = passkeys.GetValueOrDefault(p.Id);
            if (!p.MfaEnabled && keys == 0) issues.Add("no-two-step");
            var hasPassword = !string.IsNullOrEmpty(p.PasswordHash);
            if (hasPassword && p.PasswordLength is { } len && len < strong) issues.Add("weak-password");
            if (hasPassword && (p.PasswordChangedAt is null || p.PasswordChangedAt < now.AddDays(-365))) issues.Add("old-password");
            if (p.LastLoginAt is null || p.LastLoginAt < now.AddDays(-90)) issues.Add("inactive");
            return new MemberSecurityDto(p.Id, p.DisplayName, p.Email, p.Role.ToString(), p.MfaEnabled, keys, p.PasswordChangedAt, p.PasswordLength, p.LastLoginAt, issues, reminded.TryGetValue(p.Id, out var r) ? r : (DateTime?)null);
        }).ToList();
        return new SecurityOverviewDto(list.Count, list.Count(x => x.Issues.Contains("no-two-step")), list.Count(x => x.Issues.Contains("weak-password")), list.Count(x => x.Issues.Contains("old-password")), list);
    }

    /// <summary>One click: a reminder to each chosen member to turn on two-step verification or change their password (at most once a day each).</summary>
    public async Task<int> RemindAsync(SecurityReminderRequest req, CancellationToken ct = default)
    {
        var tenantId = ctx.RequireTenantId();
        RequireManage();
        var topic = req.Topic?.Trim().ToLowerInvariant();
        if (topic is not ("two-step" or "password")) throw new ValidationException("topic", "Remind about two-step verification or the password.");
        var ids = (req.UserIds ?? []).Distinct().Take(500).ToList();
        if (ids.Count == 0) throw new ValidationException("userIds", "Choose who to remind.");
        var members = await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tenantId && ids.Contains(m.UserId)).Select(m => m.UserId).ToListAsync(ct);
        var day = clock.Now.ToString("yyyyMMdd");
        var workspace = await db.Tenants.AsNoTracking().Where(t => t.Id == tenantId).Select(t => t.Name).FirstAsync(ct);
        var sent = 0;
        foreach (var userId in members)
        {
            var key = $"security-remind:{topic}:{userId:N}:{day}";
            if (await db.Notifications.AnyAsync(n => n.DedupeKey == key, ct)) continue;
            var (title, body) = topic == "two-step"
                ? ("Please turn on two-step verification", $"{workspace} asks everyone to protect their account with an authenticator app or a passkey. It takes a minute: My account → Sign-in & security.")
                : ("Please change your password", $"{workspace} asks you to choose a new, longer password (12 characters or more works well). My account → Sign-in & security.");
            await notifications.AddAsync(userId, NotificationType.Security, title, body, "/account", key, ct: ct);
            sent++;
        }
        recorder.Audit("org.security_reminded", "Tenant", tenantId, newValue: new { topic, count = sent }, tenantId: tenantId);
        await db.SaveChangesAsync(ct);
        return sent;
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
    public async Task<AccessBlockedDto?> CheckAccessAsync(Guid tenantId, bool mfaEnabled, string? ip, CancellationToken ct = default, SignInFacts? signIn = null)
    {
        var row = await db.TenantSecuritySettings.IgnoreQueryFilters().AsNoTracking().FirstOrDefaultAsync(s => s.TenantId == tenantId, ct);
        if (row is null || (!row.RequireMfa && !row.IpAllowlistEnabled && row.MinPasswordLength == 0 && row.SessionHours == 0 && row.AllowedSignIn.Length == 0)) return null;
        var entitlementValue = (await entitlements.GetEntitlementsAsync(tenantId, ct)).GetValueOrDefault(FeatureKeys.AdvancedSecurity);
        if (entitlementValue <= 0) return null;   // plan lapsed: fail open, not closed

        if (row.RequireMfa && !mfaEnabled)
            return new AccessBlockedDto(tenantId, "ORG_MFA_REQUIRED", "This organization requires two-step verification. Turn it on in My account → Sign-in & security to continue.");
        if (row.IpAllowlistEnabled && !IpAllowlist.Matches(IpAllowlist.ParseEntries(row.IpRanges), ip))
            return new AccessBlockedDto(tenantId, "ORG_IP_BLOCKED", "Your network is not on this organization's allowed list. Ask an administrator to add it.");
        // The rules below are about how this person signed in; API keys (no sign-in facts) are not affected by them.
        if (signIn is null) return null;
        var method = Category(signIn.Method);
        var allowed = Methods(row.AllowedSignIn);
        if (signIn.Method is not null && method != "device" && allowed.Count < AllMethods.Length && !allowed.Contains(method))
            return new AccessBlockedDto(tenantId, "ORG_SIGNIN_METHOD", $"This organization does not accept signing in with {Label(method)}. Sign out and sign in with {string.Join(" or ", allowed.Select(Label))}.");
        if (row.SessionHours > 0 && signIn.OpenedAt < clock.Now.AddHours(-row.SessionHours))
            return new AccessBlockedDto(tenantId, "ORG_SESSION_EXPIRED", $"This organization asks you to sign in again every {Hours(row.SessionHours)}. Sign out and sign in again.");
        if (row.MinPasswordLength > 0 && method == "password" && signIn.PasswordLength is { } length && length < row.MinPasswordLength)
            return new AccessBlockedDto(tenantId, "ORG_PASSWORD_TOO_SHORT", $"This organization needs passwords of at least {row.MinPasswordLength} characters. Change your password in My account → Sign-in & security to continue.");
        return null;
    }
}
