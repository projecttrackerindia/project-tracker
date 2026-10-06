using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Auth;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Workspaces;

public record WorkspaceDto(Guid Id, string Name, string Slug, WorkspaceType Type, TenantRole Role, string? Description, string PlanCode, int MemberCount);
public record PlanSummaryDto(string Code, string Name, SubscriptionStatus Status, DateTime? TrialEnd, DateTime? PeriodEnd, bool CancelAtPeriodEnd, bool Downgraded);
public record CurrentWorkspaceDto(Guid Id, string Name, string Slug, WorkspaceType Type, TenantRole Role, string? Description,
    IReadOnlyList<string> Permissions, PlanSummaryDto Plan, IReadOnlyDictionary<string, long> Entitlements,
    IReadOnlyDictionary<string, int> Modules, int ReportCount = 0);
/// <summary>Everything the app shows or hides based on what a person may do. <see cref="Fingerprint"/> changes exactly when that changes.</summary>
public record ContextDto(UserDto User, IReadOnlyList<WorkspaceDto> Workspaces, CurrentWorkspaceDto? Current, string Fingerprint = "",
    Organization.AccessBlockedDto? Blocked = null, IReadOnlyList<Admin.ConsentDocumentDto>? PendingConsent = null);
public record FingerprintDto(string Fingerprint);
public record CreateWorkspaceRequest(string Name, string? Description);
public record UpdateWorkspaceRequest(string Name, string? Description);
public record SwitchResult(string AccessToken, DateTime ExpiresAt);

public record MemberDto(Guid UserId, string DisplayName, string Email, TenantRole Role, DateTime JoinedAt, string? JobRole = null);
public record UpdateMemberRoleRequest(TenantRole Role);
/// <summary>Creates the account directly: the administrator picks the first password, which the person must replace at first sign-in.</summary>
public record CreateMemberRequest(string Email, string DisplayName, TenantRole Role, string Password, Guid? OrgRoleId = null, Guid? ReportsToUserId = null);
public record InviteRequest(string Email, TenantRole Role, Guid? OrgRoleId = null, Guid? ReportsToUserId = null);
public record InvitationDto(Guid Id, string Email, TenantRole Role, InvitationStatus Status, DateTime ExpiresAt, DateTime CreatedAt, string? InvitedBy,
    string? JobRole = null, string? ReportsTo = null);
public record InvitationLookupDto(string WorkspaceName, string Email, TenantRole Role, string? InvitedBy, bool Expired, bool Accepted, string? JobRole = null);
public record AcceptInvitationRequest(string Token);

/// <summary>
/// The defaults of each access level. They apply to everyone except Owners (who always have everything) and the people whose job role
/// has its own access settings: <see cref="NotAppliedTo"/> names those people, so a change here never silently misses anyone.
/// </summary>
public record PermissionMatrixDto(IReadOnlyList<TenantRole> Roles, IReadOnlyList<string> Permissions, IReadOnlyList<string> Locked,
    IReadOnlyDictionary<string, IReadOnlyDictionary<string, bool>> Matrix, bool CanEdit, IReadOnlyList<string>? NotAppliedTo = null);
public record SetPermissionRequest(TenantRole Role, string Permission, bool Allowed);

public class WorkspaceService(
    IAppDbContext db, ICurrentContext ctx, ITokenService tokens, IEmailSender email, IOptions<AppOptions> options,
    AppClock clock, Recorder recorder, WorkspaceProvisioner provisioner, PermissionService permissions, EntitlementService entitlements,
    ProjectManagement.Application.Features.Organization.ReportingLineService reporting, ProjectManagement.Application.Features.Organization.OrgSecurityService orgSecurity,
    ProjectManagement.Application.Features.Consent.ConsentService consent, IPasswordHasher hasher, PasswordPolicyService passwordPolicy, ILogger<WorkspaceService> log)
{
    private readonly AppOptions _opt = options.Value;
    private const int MaxOwnedOrganizations = 10;

    // ---------------------------------------------------------------- context & workspaces

    public async Task<ContextDto> GetContextAsync(CancellationToken ct = default)
    {
        var userId = ctx.RequireUserId();
        var user = await db.Users.AsNoTracking().FirstAsync(u => u.Id == userId, ct);
        var workspaces = await ListAsync(ct);
        CurrentWorkspaceDto? current = null;

        if (ctx.TenantId is { } tid && ctx.Role is { } role)
        {
            var tenant = await db.Tenants.AsNoTracking().FirstAsync(t => t.Id == tid, ct);
            var plan = await entitlements.GetEffectivePlanAsync(tid, ct);
            current = new CurrentWorkspaceDto(tenant.Id, tenant.Name, tenant.Slug, tenant.Type, role, tenant.Description,
                await permissions.EffectiveAsync(ct),
                new PlanSummaryDto(plan.Plan.Code, plan.Plan.Name, plan.Status, plan.TrialEnd, plan.PeriodEnd, plan.CancelAtPeriodEnd, plan.Downgraded),
                await entitlements.GetEntitlementsAsync(tid, ct),
                await permissions.LevelsAsync(ct),
                await reporting.CountMineAsync(userId, tid, ct));
        }
        var blocked = current is null && ctx.BlockedWorkspace is { } b ? new Organization.AccessBlockedDto(b.WorkspaceId, b.Code, b.Message) : null;
        var consentStatus = await consent.StatusForAsync(userId, ct);
        var dto = new ContextDto(AuthService.ToDto(user), workspaces, current, Blocked: blocked,
            PendingConsent: consentStatus.UpToDate ? null : consentStatus.Pending);
        return dto with { Fingerprint = FingerprintOf(dto) };
    }

    /// <summary>
    /// A short hash of the parts of the context that decide what the menus and buttons show: role, permissions, module levels, plan and
    /// entitlements, and which workspaces the person belongs to. Things that change all the time (member counts) are left out on purpose.
    /// </summary>
    public static string FingerprintOf(ContextDto c)
    {
        var parts = new List<string>
        {
            $"u:{c.User.Id}:{c.User.EmailVerified}:{c.User.IsPlatformAdmin}:{c.User.MfaEnabled}",
        };
        parts.AddRange(c.Workspaces.OrderBy(w => w.Id).Select(w => $"w:{w.Id}:{w.Type}:{w.Role}:{w.PlanCode}:{w.Name}"));
        if (c.Current is { } cur)
        {
            parts.Add($"c:{cur.Id}:{cur.Role}:{cur.Plan.Code}:{cur.Plan.Status}:{cur.Plan.Downgraded}:r{(cur.ReportCount > 0 ? 1 : 0)}");
            parts.AddRange(cur.Permissions.OrderBy(p => p, StringComparer.Ordinal).Select(p => $"p:{p}"));
            parts.AddRange(cur.Entitlements.OrderBy(e => e.Key, StringComparer.Ordinal).Select(e => $"e:{e.Key}={e.Value}"));
            parts.AddRange(cur.Modules.OrderBy(m => m.Key, StringComparer.Ordinal).Select(m => $"m:{m.Key}={m.Value}"));
        }
        if (c.Blocked is { } bl) parts.Add($"blocked:{bl.Code}");   // so the app notices the moment the block is lifted (or changes)
        if (c.PendingConsent is { Count: > 0 } pc) parts.Add($"consent:{string.Join(',', pc.Select(d => $"{d.Type}={d.Version}"))}");
        return Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(string.Join("\n", parts))))[..24].ToLowerInvariant();
    }

    public async Task<IReadOnlyList<WorkspaceDto>> ListAsync(CancellationToken ct = default)
    {
        var userId = ctx.RequireUserId();
        var rows = await (from m in db.TenantMembers
                          join t in db.Tenants on m.TenantId equals t.Id
                          where m.UserId == userId && t.Status == TenantStatus.Active
                          orderby t.Type, t.Name
                          select new { Tenant = t, m.Role }).AsNoTracking().ToListAsync(ct);
        var ids = rows.Select(r => r.Tenant.Id).ToList();
        var counts = await db.TenantMembers.Where(m => ids.Contains(m.TenantId))
            .GroupBy(m => m.TenantId).Select(g => new { Id = g.Key, Count = g.Count() }).ToDictionaryAsync(x => x.Id, x => x.Count, ct);
        var subs = await db.Subscriptions.AsNoTracking().Include(s => s.Plan)
            .Where(s => ids.Contains(s.TenantId)).ToDictionaryAsync(s => s.TenantId, ct);
        var now = clock.Now;

        return rows.Select(r =>
        {
            var code = subs.TryGetValue(r.Tenant.Id, out var s) && s.Plan is not null && !EntitlementService.IsLapsed(s, now)
                ? s.Plan.Code : EntitlementService.FreePlan;
            return new WorkspaceDto(r.Tenant.Id, r.Tenant.Name, r.Tenant.Slug, r.Tenant.Type, r.Role, r.Tenant.Description,
                code, counts.GetValueOrDefault(r.Tenant.Id));
        }).ToList();
    }

    public async Task<WorkspaceDto> CreateOrganizationAsync(CreateWorkspaceRequest req, CancellationToken ct = default)
    {
        var userId = ctx.RequireUserId();
        var owned = await db.Tenants.CountAsync(t => t.OwnerUserId == userId && t.Type == WorkspaceType.Organization, ct);
        if (owned >= MaxOwnedOrganizations)
            throw new ValidationException("name", $"You can own up to {MaxOwnedOrganizations} organizations.");

        var tenant = await provisioner.CreateAsync(req.Name, WorkspaceType.Organization, userId, req.Description, null, ct);
        recorder.Audit("workspace.created", "Tenant", tenant.Id, newValue: new { tenant.Name, tenant.Slug }, tenantId: tenant.Id);
        await db.SaveChangesAsync(ct);
        return new WorkspaceDto(tenant.Id, tenant.Name, tenant.Slug, tenant.Type, TenantRole.Owner, tenant.Description, EntitlementService.FreePlan, 1);
    }

    public async Task<SwitchResult> SwitchAsync(Guid workspaceId, CancellationToken ct = default)
    {
        var userId = ctx.RequireUserId();
        var sessionId = ctx.SessionId ?? throw new UnauthorizedException();
        // Membership is validated server-side; the client never asserts its own tenant.
        var allowed = await (from m in db.TenantMembers
                             join t in db.Tenants on m.TenantId equals t.Id
                             where m.UserId == userId && m.TenantId == workspaceId && t.Status == TenantStatus.Active
                             select m.Id).AnyAsync(ct);
        if (!allowed) throw new NotFoundException("Workspace not found.");

        var user = await db.Users.FirstAsync(u => u.Id == userId, ct);
        var session = await db.UserSessions.FirstAsync(s => s.Id == sessionId, ct);
        // A session opened by this organization's own single sign-on meets its two-step rule (the identity provider applies its own).
        var blocked = await orgSecurity.CheckAccessAsync(workspaceId, user.MfaEnabled || session.SsoTenantId == workspaceId, ctx.IpAddress, ct);
        if (blocked is not null) throw new ForbiddenException(blocked.Message, blocked.Code);

        session.WorkspaceId = workspaceId;
        await db.SaveChangesAsync(ct);
        var token = tokens.CreateAccessToken(user, sessionId, workspaceId);
        return new SwitchResult(token.Token, token.ExpiresAt);
    }

    public async Task<WorkspaceDto> UpdateAsync(UpdateWorkspaceRequest req, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.OrgManage, ct);
        var tid = ctx.RequireTenantId();
        var tenant = await db.Tenants.FirstAsync(t => t.Id == tid, ct);
        var old = new { tenant.Name, tenant.Description };
        tenant.Name = req.Name.Trim();
        tenant.Description = req.Description?.Trim();
        recorder.Audit("workspace.updated", "Tenant", tid, old, new { tenant.Name, tenant.Description });
        await db.SaveChangesAsync(ct);
        return (await ListAsync(ct)).First(w => w.Id == tid);
    }

    // ---------------------------------------------------------------- members

    public async Task<IReadOnlyList<MemberDto>> GetMembersAsync(CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        var hideEmail = ctx.Role == TenantRole.Guest;
        var rows = await db.TenantMembers.AsNoTracking().Include(m => m.User)
            .Where(m => m.TenantId == tid).OrderByDescending(m => m.Role).ThenBy(m => m.User!.DisplayName).ToListAsync(ct);
        var roleIds = rows.Where(m => m.OrgRoleId != null).Select(m => m.OrgRoleId!.Value).Distinct().ToList();
        var roleNames = await db.OrgRoles.AsNoTracking().Where(r => roleIds.Contains(r.Id)).ToDictionaryAsync(r => r.Id, r => r.Name, ct); // deleted roles are filtered out
        return rows.Select(m => new MemberDto(m.UserId, m.User!.DisplayName, hideEmail ? "" : m.User.Email, m.Role, m.CreatedAt,
            m.OrgRoleId is { } rid && roleNames.TryGetValue(rid, out var jobRole) ? jobRole : null)).ToList();
    }

    /// <summary>
    /// Creates a brand-new account with a first password the administrator chose, makes it a member of this organization and
    /// tells the person by email (without the password). It never touches an existing account: someone who already has one is
    /// invited instead, so they keep their own password. Until they choose a new password they can do nothing else.
    /// </summary>
    public async Task<MemberDto> CreateMemberAsync(CreateMemberRequest req, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.MembersManage, ct);
        var tid = ctx.RequireTenantId();
        if (ctx.WorkspaceType == WorkspaceType.Personal)
            throw new ForbiddenException("Personal workspaces cannot have additional members. Create an organization to collaborate.", "PERSONAL_WORKSPACE");
        EnsureCanAssign(req.Role);

        string? jobRoleName = null;
        if (req.OrgRoleId is not null || req.ReportsToUserId is not null)
        {
            await permissions.RequireAsync(Permissions.OrgStructure, ct);
            if (req.OrgRoleId is { } roleId)
                jobRoleName = await db.OrgRoles.Where(r => r.Id == roleId).Select(r => r.Name).FirstOrDefaultAsync(ct)
                    ?? throw new ValidationException("orgRoleId", "That job role does not exist.");
            if (req.ReportsToUserId is { } bossId && !await db.TenantMembers.AnyAsync(m => m.TenantId == tid && m.UserId == bossId, ct))
                throw new ValidationException("reportsToUserId", "That person is not a member of this organization.");
        }

        var normalized = Text.NormalizeEmail(req.Email);
        if (await db.Users.AnyAsync(u => u.NormalizedEmail == normalized, ct))
            throw new ConflictException("Someone already has an account with this email. Send them an invitation instead, so they keep their own password.", "ACCOUNT_EXISTS");

        var now = clock.Now;
        var pendingInvites = await db.TenantInvitations.Where(i => i.TenantId == tid && i.NormalizedEmail == normalized && i.Status == InvitationStatus.Pending && i.ExpiresAt > now).ToListAsync(ct);
        var members = await db.TenantMembers.CountAsync(m => m.TenantId == tid, ct);
        var pendingOthers = await db.TenantInvitations.CountAsync(i => i.TenantId == tid && i.Status == InvitationStatus.Pending && i.ExpiresAt > now && i.NormalizedEmail != normalized, ct);
        await entitlements.EnsureWithinLimitAsync(FeatureKeys.MaxMembers, members + pendingOthers, 1, ct);
        await passwordPolicy.EnsureAcceptableAsync("password", req.Password, req.Email, req.DisplayName, null, ct);

        // The administrator vouches for the address and the password is temporary, so the email counts as verified.
        var user = new User
        {
            Email = req.Email.Trim(), NormalizedEmail = normalized, DisplayName = req.DisplayName.Trim(), PasswordHash = hasher.Hash(req.Password),
            EmailVerified = true, MustChangePassword = true, CreatedAt = now, CreatedBy = ctx.UserId,
        };
        db.Users.Add(user);
        var member = new TenantMember
        {
            TenantId = tid, UserId = user.Id, Role = req.Role, CreatedAt = now, CreatedBy = ctx.UserId,
            OrgRoleId = req.OrgRoleId, ReportsToUserId = req.ReportsToUserId,
        };
        db.TenantMembers.Add(member);
        foreach (var invite in pendingInvites) invite.Status = InvitationStatus.Revoked; // the account now exists, so an open invitation would only confuse

        // Never the password. The account can be identified by its email and the fact that it was created directly.
        recorder.Audit("member.created", "User", user.Id, newValue: new { user.Email, req.Role, JobRole = jobRoleName });
        recorder.Activity("member.created", "Member", user.Id, $"Created an account for {user.DisplayName} ({user.Email}) as {req.Role}");
        var tenant = await db.Tenants.AsNoTracking().FirstAsync(t => t.Id == tid, ct);
        var creator = await db.Users.AsNoTracking().FirstAsync(u => u.Id == ctx.UserId, ct);
        await db.SaveChangesAsync(ct);

        var link = $"{_opt.WebBaseUrl.TrimEnd('/')}/login";
        var what = $"{creator.DisplayName} created an account for you in \"{tenant.Name}\" as {req.Role}{(jobRoleName is null ? "" : $" ({jobRoleName})")}. " +
            "Your administrator will give you your temporary password separately; you'll be asked to choose your own when you first sign in.";
        await email.TrySendAsync(new EmailMessage(user.Email, $"Your account in {tenant.Name}",
            EmailTemplates.Wrap($"Welcome to {tenant.Name}", $"Hi {System.Net.WebUtility.HtmlEncode(user.DisplayName)},", what, "Sign in", link, preheader: "Your administrator created an account for you.", kind: EmailKind.Welcome,
                details: [("Workspace", tenant.Name), ("Role", req.Role.ToString())]), $"{what} Sign in: {link}", "welcome"), log, ct);
        return new MemberDto(user.Id, user.DisplayName, user.Email, req.Role, member.CreatedAt, jobRoleName);
    }

    private void EnsureCanAssign(TenantRole target)
    {
        var mine = ctx.Role ?? throw new ForbiddenException();
        if (target == TenantRole.Owner)
            throw new ForbiddenException("Ownership cannot be assigned through this action.", "PERMISSION_DENIED");
        if (mine != TenantRole.Owner && target >= mine)
            throw new ForbiddenException("You cannot assign a role equal to or higher than your own.", "PERMISSION_DENIED");
    }

    public async Task<MemberDto> UpdateMemberRoleAsync(Guid userId, UpdateMemberRoleRequest req, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.MembersManage, ct);
        var tid = ctx.RequireTenantId();
        var member = await db.TenantMembers.Include(m => m.User).FirstOrDefaultAsync(m => m.TenantId == tid && m.UserId == userId, ct)
            ?? throw new NotFoundException("Member not found.");
        if (member.Role == TenantRole.Owner)
            throw new ForbiddenException("The workspace owner's role cannot be changed.", "PERMISSION_DENIED");
        if (ctx.Role != TenantRole.Owner && member.Role >= ctx.Role)
            throw new ForbiddenException("You cannot change the role of someone at or above your own level.", "PERMISSION_DENIED");
        EnsureCanAssign(req.Role);

        var old = member.Role;
        member.Role = req.Role;
        recorder.Audit("member.role_changed", "TenantMember", member.Id, old.ToString(), req.Role.ToString());
        recorder.Activity("member.role_changed", "Member", userId, $"{member.User!.DisplayName} is now {req.Role}");
        await db.SaveChangesAsync(ct);
        return new MemberDto(member.UserId, member.User.DisplayName, member.User.Email, member.Role, member.CreatedAt);
    }

    public async Task RemoveMemberAsync(Guid userId, CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        var member = await db.TenantMembers.Include(m => m.User).FirstOrDefaultAsync(m => m.TenantId == tid && m.UserId == userId, ct)
            ?? throw new NotFoundException("Member not found.");
        var leaving = userId == ctx.UserId;

        if (member.Role == TenantRole.Owner)
            throw new ForbiddenException("The workspace owner cannot be removed.", "PERMISSION_DENIED");
        if (!leaving)
        {
            await permissions.RequireAsync(Permissions.MembersManage, ct);
            if (ctx.Role != TenantRole.Owner && member.Role >= ctx.Role)
                throw new ForbiddenException("You cannot remove someone at or above your own level.", "PERMISSION_DENIED");
        }

        // People who reported to the leaver move up to the leaver's own manager, so the chart never has dangling lines.
        foreach (var report in await db.TenantMembers.Where(m => m.TenantId == tid && m.ReportsToUserId == userId).ToListAsync(ct))
            report.ReportsToUserId = member.ReportsToUserId;

        db.ProjectMembers.RemoveRange(await db.ProjectMembers.Where(p => p.UserId == userId).ToListAsync(ct));
        db.TeamMembers.RemoveRange(await db.TeamMembers.Where(p => p.UserId == userId).ToListAsync(ct));
        db.TenantMembers.Remove(member);
        recorder.Audit(leaving ? "member.left" : "member.removed", "TenantMember", member.Id, member.Role.ToString());
        recorder.Activity(leaving ? "member.left" : "member.removed", "Member", userId,
            leaving ? $"{member.User!.DisplayName} left the workspace" : $"{member.User!.DisplayName} was removed from the workspace");
        await db.SaveChangesAsync(ct);
    }

    // ---------------------------------------------------------------- invitations

    private static InvitationDto ToDto(TenantInvitation i, string? inviter, string? jobRole = null, string? reportsTo = null) =>
        new(i.Id, i.Email, i.Role, i.Status, i.ExpiresAt, i.CreatedAt, inviter, jobRole, reportsTo);

    private async Task<(Dictionary<Guid, string> Roles, Dictionary<Guid, string> People)> NamesAsync(IEnumerable<TenantInvitation> invites, CancellationToken ct)
    {
        var roleIds = invites.Where(i => i.OrgRoleId != null).Select(i => i.OrgRoleId!.Value).Distinct().ToList();
        var userIds = invites.Where(i => i.ReportsToUserId != null).Select(i => i.ReportsToUserId!.Value).Distinct().ToList();
        return (await db.OrgRoles.AsNoTracking().Where(r => roleIds.Contains(r.Id)).ToDictionaryAsync(r => r.Id, r => r.Name, ct),
                await db.Users.AsNoTracking().Where(u => userIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct));
    }

    public async Task<IReadOnlyList<InvitationDto>> GetInvitationsAsync(CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.MembersInvite, ct);
        var tid = ctx.RequireTenantId();
        var now = clock.Now;
        var rows = await (from i in db.TenantInvitations
                          join u in db.Users on i.CreatedBy equals (Guid?)u.Id into inviters
                          from inviter in inviters.DefaultIfEmpty()
                          where i.TenantId == tid && i.Status == InvitationStatus.Pending && i.ExpiresAt > now
                          orderby i.CreatedAt descending
                          select new { Invitation = i, Inviter = inviter.DisplayName }).AsNoTracking().ToListAsync(ct);
        var (roles, people) = await NamesAsync(rows.Select(r => r.Invitation), ct);
        return rows.Select(r => ToDto(r.Invitation, r.Inviter,
            r.Invitation.OrgRoleId is { } rid && roles.TryGetValue(rid, out var role) ? role : null,
            r.Invitation.ReportsToUserId is { } uid && people.TryGetValue(uid, out var boss) ? boss : null)).ToList();
    }

    public async Task<InvitationDto> InviteAsync(InviteRequest req, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.MembersInvite, ct);
        var tid = ctx.RequireTenantId();
        if (ctx.WorkspaceType == WorkspaceType.Personal)
            throw new ForbiddenException("Personal workspaces cannot have additional members. Create an organization to collaborate.", "PERSONAL_WORKSPACE");
        EnsureCanAssign(req.Role);

        // Placing a person on the organization chart is an org-structure action, so it needs that permission.
        string? jobRoleName = null, reportsToName = null;
        if (req.OrgRoleId is not null || req.ReportsToUserId is not null)
        {
            await permissions.RequireAsync(Permissions.OrgStructure, ct);
            if (req.OrgRoleId is { } roleId)
                jobRoleName = await db.OrgRoles.Where(r => r.Id == roleId).Select(r => r.Name).FirstOrDefaultAsync(ct)
                    ?? throw new ValidationException("orgRoleId", "That job role does not exist.");
            if (req.ReportsToUserId is { } bossId)
                reportsToName = await db.TenantMembers.Where(m => m.TenantId == tid && m.UserId == bossId).Select(m => m.User!.DisplayName).FirstOrDefaultAsync(ct)
                    ?? throw new ValidationException("reportsToUserId", "That person is not a member of this organization.");
        }

        var normalized = Text.NormalizeEmail(req.Email);
        var now = clock.Now;
        var already = await (from m in db.TenantMembers join u in db.Users on m.UserId equals u.Id
                             where m.TenantId == tid && u.NormalizedEmail == normalized select m.Id).AnyAsync(ct);
        if (already) throw new ConflictException("This person is already a member of the workspace.", "ALREADY_MEMBER");

        var existing = await db.TenantInvitations.FirstOrDefaultAsync(i =>
            i.TenantId == tid && i.NormalizedEmail == normalized && i.Status == InvitationStatus.Pending && i.ExpiresAt > now, ct);
        if (existing is not null) throw new ConflictException("An invitation for this email is already pending.", "INVITATION_PENDING");

        var pending = await db.TenantInvitations.CountAsync(i => i.TenantId == tid && i.Status == InvitationStatus.Pending && i.ExpiresAt > now, ct);
        var members = await db.TenantMembers.CountAsync(m => m.TenantId == tid, ct);
        await entitlements.EnsureWithinLimitAsync(FeatureKeys.MaxMembers, members + pending, 1, ct);

        var (raw, hash) = tokens.CreateOpaqueToken();
        var invite = new TenantInvitation
        {
            TenantId = tid, Email = req.Email.Trim(), NormalizedEmail = normalized, Role = req.Role, TokenHash = hash,
            OrgRoleId = req.OrgRoleId, ReportsToUserId = req.ReportsToUserId,
            ExpiresAt = now.AddDays(_opt.InvitationDays), CreatedAt = now, CreatedBy = ctx.UserId,
        };
        db.TenantInvitations.Add(invite);
        recorder.Audit("member.invited", "TenantInvitation", invite.Id, newValue: new { invite.Email, invite.Role, JobRole = jobRoleName, ReportsTo = reportsToName });
        recorder.Activity("member.invited", "Invitation", invite.Id, $"Invited {invite.Email} as {invite.Role}");

        var tenant = await db.Tenants.AsNoTracking().FirstAsync(t => t.Id == tid, ct);
        var inviter = await db.Users.AsNoTracking().FirstAsync(u => u.Id == ctx.UserId, ct);
        await db.SaveChangesAsync(ct);

        var link = $"{_opt.WebBaseUrl.TrimEnd('/')}/invite?token={Uri.EscapeDataString(raw)}";
        await email.TrySendAsync(new EmailMessage(invite.Email, $"{inviter.DisplayName} invited you to {tenant.Name}",
            EmailTemplates.Wrap($"Join {tenant.Name}", "Hello,",
                $"{inviter.DisplayName} invited you to join \"{tenant.Name}\" as {invite.Role}{(jobRoleName is null ? "" : $" ({jobRoleName})")}. This invitation expires in {_opt.InvitationDays} days.",
                "Accept invitation", link, preheader: $"{inviter.DisplayName} invited you to join {tenant.Name}.", kind: EmailKind.Invitation,
                details: [("Workspace", tenant.Name), ("Role", invite.Role.ToString()), ("Invited by", inviter.DisplayName)]), $"{inviter.DisplayName} invited you to join \"{tenant.Name}\" as {invite.Role}{(jobRoleName is null ? "" : $" ({jobRoleName})")}. Accept your invitation: {link}", "invite"), log, ct);
        return ToDto(invite, inviter.DisplayName, jobRoleName, reportsToName);
    }

    public async Task RevokeInvitationAsync(Guid invitationId, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.MembersInvite, ct);
        var tid = ctx.RequireTenantId();
        var invite = await db.TenantInvitations.FirstOrDefaultAsync(i => i.Id == invitationId && i.TenantId == tid, ct)
            ?? throw new NotFoundException("Invitation not found.");
        if (invite.Status != InvitationStatus.Pending) throw new ConflictException("This invitation is no longer pending.");
        invite.Status = InvitationStatus.Revoked;
        recorder.Audit("member.invitation_revoked", "TenantInvitation", invite.Id, invite.Email);
        await db.SaveChangesAsync(ct);
    }

    public async Task<InvitationLookupDto> LookupInvitationAsync(string token, CancellationToken ct = default)
    {
        var hash = tokens.Hash(token);
        var row = await (from i in db.TenantInvitations
                         join t in db.Tenants on i.TenantId equals t.Id
                         join u in db.Users on i.CreatedBy equals (Guid?)u.Id into inviters
                         from inviter in inviters.DefaultIfEmpty()
                         where i.TokenHash == hash
                         select new { i, t.Name, Inviter = inviter.DisplayName }).AsNoTracking().FirstOrDefaultAsync(ct)
            ?? throw new NotFoundException("This invitation link is invalid.");
        var jobRole = row.i.OrgRoleId is { } rid
            ? await db.OrgRoles.IgnoreQueryFilters().Where(r => r.Id == rid && r.TenantId == row.i.TenantId && !r.IsDeleted).Select(r => r.Name).FirstOrDefaultAsync(ct)
            : null;
        return new InvitationLookupDto(row.Name, row.i.Email, row.i.Role, row.Inviter,
            row.i.ExpiresAt <= clock.Now || row.i.Status is InvitationStatus.Revoked or InvitationStatus.Expired,
            row.i.Status == InvitationStatus.Accepted, jobRole);
    }

    public async Task<WorkspaceDto> AcceptInvitationAsync(AcceptInvitationRequest req, CancellationToken ct = default)
    {
        var userId = ctx.RequireUserId();
        var hash = tokens.Hash(req.Token);
        var invite = await db.TenantInvitations.FirstOrDefaultAsync(i => i.TokenHash == hash, ct)
            ?? throw new NotFoundException("This invitation link is invalid.");
        var user = await db.Users.FirstAsync(u => u.Id == userId, ct);

        if (invite.Status != InvitationStatus.Pending || invite.ExpiresAt <= clock.Now)
            throw new ConflictException("This invitation has expired or is no longer valid.", "INVITATION_INVALID");
        if (invite.NormalizedEmail != user.NormalizedEmail)
            throw new ForbiddenException($"This invitation was sent to {invite.Email}. Sign in with that account to accept it.", "INVITATION_EMAIL_MISMATCH");

        if (!await db.Tenants.AnyAsync(t => t.Id == invite.TenantId, ct)) // soft-deleted tenants are filtered out
            throw new ConflictException("This organization is no longer available.", "INVITATION_INVALID");

        var alreadyMember = await db.TenantMembers.AnyAsync(m => m.TenantId == invite.TenantId && m.UserId == userId, ct);
        if (!alreadyMember)
        {
            // The role or manager may have been deleted / left since the invitation was sent; then the person simply starts unplaced.
            var roleStillThere = invite.OrgRoleId is { } rid && await db.OrgRoles.IgnoreQueryFilters().AnyAsync(r => r.Id == rid && r.TenantId == invite.TenantId && !r.IsDeleted, ct);
            var bossStillThere = invite.ReportsToUserId is { } bid && await db.TenantMembers.AnyAsync(m => m.TenantId == invite.TenantId && m.UserId == bid, ct);
            db.TenantMembers.Add(new TenantMember
            {
                TenantId = invite.TenantId, UserId = userId, Role = invite.Role, CreatedAt = clock.Now, CreatedBy = invite.CreatedBy,
                OrgRoleId = roleStillThere ? invite.OrgRoleId : null, ReportsToUserId = bossStillThere ? invite.ReportsToUserId : null,
            });
        }
        invite.Status = InvitationStatus.Accepted;
        invite.AcceptedAt = clock.Now;
        invite.AcceptedByUserId = userId;
        // The caller's current workspace may differ from the one being joined, so only the (tenant-tagged) audit trail is written here.
        recorder.Audit("member.joined", "TenantInvitation", invite.Id, newValue: new { invite.Role }, tenantId: invite.TenantId);
        await db.SaveChangesAsync(ct);
        return (await ListAsync(ct)).First(w => w.Id == invite.TenantId);
    }

    // ---------------------------------------------------------------- roles & permissions

    public async Task<PermissionMatrixDto> GetPermissionMatrixAsync(CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.OrgManage, ct);
        var roles = new[] { TenantRole.Owner, TenantRole.Admin, TenantRole.Manager, TenantRole.Member, TenantRole.Guest };
        var matrix = new Dictionary<string, IReadOnlyDictionary<string, bool>>();
        foreach (var role in roles)
        {
            var row = new Dictionary<string, bool>();
            foreach (var p in Permissions.All) row[p] = await permissions.RoleHasAsync(role, p, ct);
            matrix[role.ToString()] = row;
        }
        var canEdit = await permissions.HasAsync(Permissions.PermissionsManage, ct)
            && await entitlements.GetValueAsync(FeatureKeys.AdvancedPermissions, ct) != 0;
        // Managers, Members and Guests whose job role has its own access get exactly that instead (see PermissionService).
        var tid = ctx.RequireTenantId();
        var profiled = await (from m in db.TenantMembers.AsNoTracking()
                              join r in db.OrgRoles.AsNoTracking() on m.OrgRoleId equals (Guid?)r.Id
                              join u in db.Users.AsNoTracking() on m.UserId equals u.Id
                              where m.TenantId == tid && r.AccessJson != null
                                    && (m.Role == TenantRole.Manager || m.Role == TenantRole.Member || m.Role == TenantRole.Guest)
                              orderby u.DisplayName
                              select new { u.DisplayName, Role = r.Name }).ToListAsync(ct);
        return new PermissionMatrixDto(roles, Permissions.All, Permissions.Locked, matrix, canEdit, profiled.Select(p => $"{p.DisplayName} ({p.Role})").ToList());
    }

    public async Task SetPermissionAsync(SetPermissionRequest req, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.PermissionsManage, ct);
        await entitlements.EnsureFeatureAsync(FeatureKeys.AdvancedPermissions, ct);
        var tid = ctx.RequireTenantId();

        if (!Permissions.All.Contains(req.Permission)) throw new ValidationException("permission", "Unknown permission.");
        if (req.Role == TenantRole.Owner) throw new ValidationException("role", "Owner permissions cannot be changed.");
        if (Permissions.Locked.Contains(req.Permission)) throw new ValidationException("permission", "This permission cannot be changed.");

        var row = await db.RolePermissionOverrides.FirstOrDefaultAsync(o => o.Role == req.Role && o.Permission == req.Permission, ct);
        var isDefault = Permissions.DefaultAllowed(req.Role, req.Permission) == req.Allowed;
        if (isDefault) { if (row is not null) db.RolePermissionOverrides.Remove(row); }
        else if (row is null)
            db.RolePermissionOverrides.Add(new RolePermissionOverride { TenantId = tid, Role = req.Role, Permission = req.Permission, Allowed = req.Allowed });
        else row.Allowed = req.Allowed;

        recorder.Audit("permission.changed", "RolePermission", null, newValue: new { req.Role, req.Permission, req.Allowed });
        await db.SaveChangesAsync(ct);
    }
}
