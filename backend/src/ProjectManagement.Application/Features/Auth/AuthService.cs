using System.Net;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Auth;

/// <summary>
/// Account lockout with exponential backoff (ASVS 2.2.1): the first lockout lasts App:LockoutMinutes, each further one in a row doubles it,
/// up to a day. A successful sign-in or a password reset starts the streak again.
/// </summary>
public static class LockoutPolicy
{
    public const int MaxMinutes = 24 * 60;

    public static DateTime Next(User user, DateTime now, int baseMinutes)
    {
        user.LockoutStreak = Math.Clamp(user.LockoutStreak + 1, 1, 16);
        var minutes = Math.Min((double)Math.Max(1, baseMinutes) * Math.Pow(2, user.LockoutStreak - 1), MaxMinutes);
        return now.AddMinutes(minutes);
    }
}

/// <summary>WorkspaceType: "personal" (default) or "organization" (needs OrganizationName), or "invited" to create none and join by invitation.</summary>
/// <summary>Website is the hidden honeypot (must stay empty); FormToken comes from GET /auth/signup-form; TurnstileToken only when Turnstile is on.</summary>
public record RegisterRequest(string Email, string Password, string DisplayName, bool AcceptedTerms, string? ReturnUrl = null,
    string? WorkspaceType = null, string? OrganizationName = null, string? Website = null, string? FormToken = null, string? TurnstileToken = null);
public record LoginRequest(string Email, string Password);
public record VerifyEmailRequest(string Token);
public record ResendVerificationRequest(string Email, string? ReturnUrl = null);
public record ForgotPasswordRequest(string Email);
public record ResetPasswordRequest(string Token, string Password);
public record ChangePasswordRequest(string CurrentPassword, string NewPassword);
public record UpdateProfileRequest(string DisplayName, string? TimeZone);
public record RefreshRequest(string? RefreshToken);
/// <summary>The workspace's "Sign out after inactivity" time in minutes (0 = never) and whether the caller may change it.</summary>
public record IdlePolicyDto(int Minutes, bool CanManage, IReadOnlyList<int> Choices);
public record SetIdlePolicyRequest(int Minutes);
/// <summary>What the lock screen shows: whose session it is, which ways of unlocking it has, and how many tries are left.</summary>
public record LockStateDto(bool Locked, Guid UserId, string DisplayName, bool HasAvatar, bool HasPassword, bool HasPasskey, int AttemptsLeft, int IdleMinutes);

public record UserDto(Guid Id, string Email, string DisplayName, bool EmailVerified, bool IsPlatformAdmin, string TimeZone, bool MfaEnabled = false, bool MustChangePassword = false, bool HasAvatar = false);
public record SessionDto(Guid Id, DateTime CreatedAt, DateTime LastSeenAt, string? IpAddress, string? UserAgent, bool IsCurrent, string? AuthMethod = null, string? Device = null, string? Location = null);
/// <summary>One sign-in of the person's account: when, from which browser and network, how, whether it is still signed in, and whether it was new.</summary>
public record SignInDto(Guid Id, DateTime At, DateTime LastSeenAt, string Device, string? Network, string? AuthMethod, bool Current, bool Active, bool NewDevice, DateTime? ReportedAt);

/// <summary>Result of login / refresh. The refresh token is delivered by the API layer (cookie or body).</summary>
/// <summary>A signed-in session. RefreshToken is null when the caller keeps the refresh token it already has (see AuthService.RefreshAsync).</summary>
public record AuthResult(string AccessToken, DateTime ExpiresAt, UserDto User, string? RefreshToken, DateTime RefreshExpiresAt);
/// <summary>Either a session, or (when two-step verification is on) a challenge to answer with a code.</summary>
public record LoginOutcome(AuthResult? Session, string? MfaChallenge);
public record RegisterResult(Guid UserId, bool RequiresEmailVerification);

/// <summary>Creates a tenant together with its owner membership and FREE subscription.</summary>
public class WorkspaceProvisioner(IAppDbContext db, AppClock clock)
{
    public async Task<Tenant> CreateAsync(string name, WorkspaceType type, Guid ownerId, string? description = null,
        string? slugHint = null, CancellationToken ct = default)
    {
        var baseSlug = WorkspaceSlugs.For(slugHint ?? name);
        var slug = baseSlug;
        while (await db.Tenants.IgnoreQueryFilters().AnyAsync(t => t.Slug == slug, ct))
            slug = $"{baseSlug}-{Guid.NewGuid().ToString("N")[..4]}";

        var now = clock.Now;
        var free = await db.Plans.FirstAsync(p => p.Code == EntitlementService.FreePlan, ct);
        var tenant = new Tenant
        {
            Name = name.Trim(), Slug = slug, Type = type, Description = description?.Trim(),
            OwnerUserId = ownerId, CreatedAt = now, CreatedBy = ownerId,
        };
        db.Tenants.Add(tenant);
        db.TenantMembers.Add(new TenantMember { TenantId = tenant.Id, UserId = ownerId, Role = TenantRole.Owner, CreatedAt = now });
        db.Subscriptions.Add(new Subscription
        {
            TenantId = tenant.Id, PlanId = free.Id, Status = SubscriptionStatus.Active,
            CurrentPeriodStart = now, CreatedAt = now,
        });
        return tenant;
    }
}

public class AuthService(
    IAppDbContext db, ICurrentContext ctx, IPasswordHasher hasher, ITokenService tokens, IEmailSender email,
    IOptions<AppOptions> options, AppClock clock, Recorder recorder, WorkspaceProvisioner provisioner, MfaService mfa, SecurityAlerts alerts, ProjectManagement.Application.Features.Admin.PlatformSettingsCache platform,
    PasswordPolicyService passwordPolicy, ProjectManagement.Application.Features.Consent.ConsentService consent, ProjectManagement.Application.Features.Sso.SsoPolicy ssoPolicy,
    ILogger<AuthService> log, WelcomeMailer? welcome = null, SignupGuard? signupGuard = null, SessionApprovalGate? approvalGate = null)
{
    private readonly AppOptions _opt = options.Value;
    /// <summary>The session the last IssueSessionAsync opened (not saved yet), so "Single active session" can end the others.</summary>
    private Guid _issuedSessionId;

    public static UserDto ToDto(User u) => new(u.Id, u.Email, u.DisplayName, u.EmailVerified, u.IsPlatformAdmin, u.TimeZone, u.MfaEnabled, u.MustChangePassword, u.AvatarKey is not null);

    // ---------------------------------------------------------------- registration

    public async Task<RegisterResult> RegisterAsync(RegisterRequest req, CancellationToken ct = default)
    {
        var normalized = Text.NormalizeEmail(req.Email);
        // Bot checks and the email domain first: a script learns nothing about which addresses already have accounts.
        if (signupGuard is not null) await signupGuard.EnsureAllowedAsync(req, ctx.IpAddress, ct);
        if (!(await platform.GetAsync(ct)).SignupsEnabled)
        {
            // Closed to newcomers, but someone who has been invited to a workspace may still create the account they need to accept it.
            var checkedAt = clock.Now;
            if (!await db.TenantInvitations.AnyAsync(i => i.NormalizedEmail == normalized && i.Status == InvitationStatus.Pending && i.ExpiresAt > checkedAt, ct))
                throw new ForbiddenException("New sign-ups are closed right now. Ask an administrator for an invitation.", "SIGNUPS_DISABLED");
        }
        if (await db.Users.AnyAsync(u => u.NormalizedEmail == normalized, ct))
            throw new ConflictException("An account with this email already exists.", "EMAIL_TAKEN");
        await passwordPolicy.EnsureAcceptableAsync("password", req.Password, req.Email, req.DisplayName, null, ct);

        var now = clock.Now;
        var user = new User
        {
            Email = req.Email.Trim(), NormalizedEmail = normalized, DisplayName = SignupRules.Clean(req.DisplayName),
            PasswordHash = hasher.Hash(req.Password), EmailVerified = !_opt.RequireEmailVerification, CreatedAt = now,
        };
        passwordPolicy.Stamp(user, req.Password);
        string? rawToken = null;
        if (_opt.RequireEmailVerification) rawToken = SetVerificationToken(user);
        db.Users.Add(user);

        // One workspace, the kind the person chose: never a personal one on top of an organization.
        var kind = (req.WorkspaceType ?? "personal").Trim().ToLowerInvariant();
        if (kind == "invited")
        {
            var at = clock.Now;
            if (!await db.TenantInvitations.AnyAsync(i => i.NormalizedEmail == normalized && i.Status == InvitationStatus.Pending && i.ExpiresAt > at, ct))
                kind = "personal";   // nothing to join: fall back to a workspace of their own
        }
        Tenant? workspace = null;
        if (kind is "organization" or "organisation")
        {
            var org = SignupRules.Clean(req.OrganizationName);
            if (SignupRules.OrganizationProblem(org) is { } orgProblem) throw new ValidationException("organizationName", orgProblem);
            workspace = await provisioner.CreateAsync(org, WorkspaceType.Organization, user.Id, null, org, ct);
        }
        else if (kind != "invited")
            workspace = await provisioner.CreateAsync("Personal Workspace", WorkspaceType.Personal, user.Id, null, $"{user.DisplayName} personal", ct);
        recorder.Audit("user.registered", "User", user.Id, newValue: new { Workspace = kind }, tenantId: workspace?.Id, userId: user.Id);
        await db.SaveChangesAsync(ct);
        await consent.RecordCurrentAsync(user.Id, ctx.IpAddress, ct);

        if (rawToken is not null) await SendVerificationEmailAsync(user, rawToken, ct, req.ReturnUrl);
        else if (welcome is not null) await welcome.SendAsync(user, ct);   // no verification step: the account is ready now
        return new RegisterResult(user.Id, _opt.RequireEmailVerification);
    }

    private string SetVerificationToken(User user)
    {
        var (raw, hash) = tokens.CreateOpaqueToken();
        user.EmailVerificationTokenHash = hash;
        user.EmailVerificationExpiresAt = clock.Now.AddHours(_opt.VerificationTokenHours);
        return raw;
    }

    // A slow or unreachable mail server must not turn registration/resend into a failed request: the account is already saved by
    // the time this runs, so a delivery problem here is logged and reported through Go live / resend, not thrown back at the caller.
    private Task<bool> SendVerificationEmailAsync(User user, string rawToken, CancellationToken ct, string? returnUrl = null)
    {
        var link = $"{_opt.WebBaseUrl.TrimEnd('/')}/verify-email?token={Uri.EscapeDataString(rawToken)}";
        var redirect = ProjectManagement.Application.Features.Sso.SsoLoginService.SafeReturnUrl(returnUrl);
        if (redirect != "/") link += $"&redirect={Uri.EscapeDataString(redirect)}";
        return email.TrySendAsync(new EmailMessage(user.Email, "Verify your email address",
            EmailTemplates.Wrap("Verify your email", $"Hi {WebUtility.HtmlEncode(user.DisplayName)},", "Confirm your email address to activate your account.",
                "Verify email", link, preheader: "Confirm your address to finish creating your account.", kind: EmailKind.Welcome), $"Verify your email: {link}", "verify"), log, ct);
    }

    public async Task VerifyEmailAsync(VerifyEmailRequest req, CancellationToken ct = default)
    {
        var hash = tokens.Hash(req.Token);
        var user = await db.Users.FirstOrDefaultAsync(u => u.EmailVerificationTokenHash == hash, ct);
        if (user is null || user.EmailVerificationExpiresAt < clock.Now)
            throw new ValidationException("token", "This verification link is invalid or has expired.");

        user.EmailVerified = true;
        user.EmailVerificationTokenHash = null;
        user.EmailVerificationExpiresAt = null;
        recorder.Audit("user.email_verified", "User", user.Id, userId: user.Id);
        await db.SaveChangesAsync(ct);
        if (welcome is not null) await welcome.SendAsync(user, ct);
    }

    public async Task ResendVerificationAsync(ResendVerificationRequest req, CancellationToken ct = default)
    {
        var normalized = Text.NormalizeEmail(req.Email);
        var user = await db.Users.FirstOrDefaultAsync(u => u.NormalizedEmail == normalized, ct);
        if (user is null || user.EmailVerified || !user.IsActive) return; // never reveal account state
        var raw = SetVerificationToken(user);
        await db.SaveChangesAsync(ct);
        await SendVerificationEmailAsync(user, raw, ct, req.ReturnUrl);
    }

    // ---------------------------------------------------------------- login / sessions

    public async Task<LoginOutcome> LoginAsync(LoginRequest req, CancellationToken ct = default)
    {
        var normalized = Text.NormalizeEmail(req.Email);
        var user = await db.Users.FirstOrDefaultAsync(u => u.NormalizedEmail == normalized, ct);
        var now = clock.Now;

        if (user is null)
        {
            hasher.Hash(req.Password); // spend comparable time so response timing does not reveal which emails exist
            AppTelemetry.Count(AppTelemetry.Logins, "wrong_password");
            throw new UnauthorizedException("Invalid email or password.", "INVALID_CREDENTIALS");
        }
        // The password is checked first, so neither a lockout nor an organization's single sign-on rule tells a stranger that the address
        // has an account, and a stranger cannot keep an account locked by guessing: while locked, wrong guesses get the generic answer.
        var passwordOk = user.IsActive && hasher.Verify(user.PasswordHash, req.Password);
        var locked = user.LockoutEnd is { } lockEnd && lockEnd > now;
        if (!passwordOk)
        {
            if (!locked) await RegisterFailedPasswordAsync(user, now, ct);
            AppTelemetry.Count(AppTelemetry.Logins, locked ? "locked" : "wrong_password");
            throw new UnauthorizedException("Invalid email or password.", "INVALID_CREDENTIALS");
        }
        if (locked)
        {
            AppTelemetry.Count(AppTelemetry.Logins, "locked");
            throw new TooManyRequestsException("Too many failed sign-in attempts. Try again later.", "ACCOUNT_LOCKED");
        }
        // An organization that requires its own single sign-on for this email's domain: the password is not the way in (Owners excepted).
        if (await ssoPolicy.EnforcedForAsync(user.Email, user.Id, ct) is { } enforced)
            throw new ForbiddenException($"{enforced.Name} is required for this account. Use \"Sign in with SSO\".", "SSO_REQUIRED");
        if (!user.EmailVerified && _opt.RequireEmailVerification)
            throw new ForbiddenException("Verify your email address before signing in.", "EMAIL_NOT_VERIFIED");

        // Password was right. With two-step verification on, no session yet: the caller must answer a challenge with a code.
        if (user.MfaEnabled)
        {
            await db.SaveChangesAsync(ct);
            AppTelemetry.Count(AppTelemetry.Logins, "mfa_required");
            return new LoginOutcome(null, tokens.CreateChallenge(user.Id, TimeSpan.FromMinutes(5)));
        }
        return new LoginOutcome(await SignInAsync(user, "password", ct), null);
    }

    /// <summary>Counts a wrong password towards the lockout (sign-in and changing the password share the same budget).</summary>
    private async Task RegisterFailedPasswordAsync(User user, DateTime now, CancellationToken ct)
    {
        if (user.IsActive && ++user.FailedLoginCount >= _opt.MaxFailedLogins)
        {
            user.LockoutEnd = LockoutPolicy.Next(user, now, _opt.LockoutMinutes);
            user.FailedLoginCount = 0;
            recorder.Audit("user.locked_out", "User", user.Id, newValue: new { Streak = user.LockoutStreak, Until = user.LockoutEnd }, userId: user.Id);
        }
        await db.SaveChangesAsync(ct);
    }

    /// <summary>Second step of a sign-in: the challenge from the password step plus an authenticator code or a recovery code.</summary>
    public async Task<AuthResult> CompleteMfaLoginAsync(MfaLoginRequest req, CancellationToken ct = default)
    {
        var userId = tokens.ReadChallenge(req.Challenge ?? "") ?? throw new UnauthorizedException("This sign-in expired. Enter your email and password again.", "MFA_CHALLENGE_INVALID");
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == userId, ct) ?? throw new UnauthorizedException("This sign-in expired. Enter your email and password again.", "MFA_CHALLENGE_INVALID");
        if (user.LockoutEnd is { } lockEnd && lockEnd > clock.Now)
            throw new TooManyRequestsException("Too many failed sign-in attempts. Try again later.", "ACCOUNT_LOCKED");
        if (!user.IsActive || !user.MfaEnabled) throw new UnauthorizedException("This sign-in expired. Enter your email and password again.", "MFA_CHALLENGE_INVALID");

        if (!await mfa.VerifyCodeAsync(user, req.Code ?? "", ct))
        {
            recorder.Audit("user.mfa_login_failed", "User", user.Id, userId: user.Id);
            AppTelemetry.Count(AppTelemetry.Logins, "wrong_code");
            await mfa.RegisterFailureAsync(user, "code", ct);
            throw new UnauthorizedException("That code is not correct.", "INVALID_MFA_CODE");
        }
        return await SignInAsync(user, "password+mfa", ct);
    }

    private Task<AuthResult> SignInAsync(User user, string method, CancellationToken ct) => SignInExternalAsync(user, method, null, null, ct);

    /// <summary>
    /// Opens a session for someone already authenticated (password, a social sign-in, or an organization's single sign-on). With
    /// <paramref name="ssoTenantId"/>, that organization's identity provider vouched for the person, which satisfies its two-step rule.
    /// </summary>
    public Task<AuthResult> SignInExternalAsync(User user, string method, Guid? preferredWorkspace, Guid? ssoTenantId, CancellationToken ct) =>
        SignInCoreAsync(user, method, preferredWorkspace, ssoTenantId, null, ct);

    /// <summary>
    /// "Single active session": a sign-in that a signed-in device allowed (or the person approved with the fallback) opens its session now and
    /// ends every other session of the account, each told why.
    /// </summary>
    public Task<AuthResult> SignInApprovedAsync(User user, SessionApproval approval, CancellationToken ct) =>
        SignInCoreAsync(user, approval.Method, approval.WorkspaceId, approval.SsoTenantId, approval, ct);

    private async Task<AuthResult> SignInCoreAsync(User user, string method, Guid? preferredWorkspace, Guid? ssoTenantId, SessionApproval? approved, CancellationToken ct)
    {
        user.FailedLoginCount = 0;
        user.LockoutEnd = null;
        user.LockoutStreak = 0;
        var workspaceId = await PickWorkspaceAsync(user.Id, preferredWorkspace, ct);
        // Signed in somewhere already and "Single active session" applies: the password (and code) were right, but a device that is signed in must
        // allow this one first. A sign-in approved on the phone (device login) was already allowed by a signed-in device.
        var replaces = approved is not null;
        if (approvalGate is not null && approved is null && await approvalGate.RequiredAsync(user, ct))
        {
            if (method != "device") throw new SessionApprovalRequired(await approvalGate.StartAsync(user, method, workspaceId, ssoTenantId, ct));
            replaces = true;
        }
        user.LastLoginAt = clock.Now;
        var result = await IssueSessionAsync(user, workspaceId, ct, method, ssoTenantId);
        var newSession = _issuedSessionId;
        List<Guid> ended = [];
        var device = approved?.Device ?? SessionDevice.Describe(Text.Truncate(ctx.UserAgent, 300), null, SessionDevice.App(ctx.UserAgent, false));
        if (replaces && approvalGate is not null)
        {
            ended = await approvalGate.EndOtherSessionsAsync(user.Id, newSession, device, ct);
            if (approved is not null) approved.ResultSessionId = newSession;
        }
        recorder.Audit("user.login", "User", user.Id, newValue: new { Method = method, Approved = approved?.DecidedVia }, userId: user.Id, tenantId: workspaceId);
        AppTelemetry.Count(AppTelemetry.Logins, "success");
        await db.SaveChangesAsync(ct);
        if (ended.Count > 0 && approvalGate is not null) await approvalGate.AnnounceSignedOutAsync(user.Id, ended, device, ct);
        return result;
    }

    /// <summary>Preferred workspace if the user is still an active member, else personal, else any.</summary>
    private async Task<Guid?> PickWorkspaceAsync(Guid userId, Guid? preferred, CancellationToken ct)
    {
        var memberships = await (from m in db.TenantMembers
                                 join t in db.Tenants on m.TenantId equals t.Id
                                 where m.UserId == userId && t.Status == TenantStatus.Active
                                 orderby t.Type, m.CreatedAt
                                 select new { t.Id, t.Type }).ToListAsync(ct);
        if (preferred is { } p && memberships.Any(x => x.Id == p)) return p;
        return memberships.FirstOrDefault()?.Id;
    }

    /// <summary>The tab's own workspace while the person is still in it, otherwise the session's (or, failing that, any they are in).</summary>
    private async Task<Guid?> RefreshWorkspaceAsync(Guid userId, Guid? requested, Guid? sessionWorkspace, CancellationToken ct)
    {
        if (requested is { } r && await PickWorkspaceAsync(userId, r, ct) == r) return r;
        return await PickWorkspaceAsync(userId, sessionWorkspace, ct);
    }

    /// <summary>A short-lived proof that the first step of a sign-in succeeded; the second step (an authenticator code) completes it.</summary>
    public string CreateMfaChallenge(User user) => tokens.CreateChallenge(user.Id, TimeSpan.FromMinutes(5));

    private async Task<AuthResult> IssueSessionAsync(User user, Guid? workspaceId, CancellationToken ct, string? method = null, Guid? ssoTenantId = null)
    {
        var now = clock.Now;
        var agent = Text.Truncate(ctx.UserAgent, 300);
        var newDevice = await IsNewDeviceAsync(user.Id, agent, ctx.IpAddress, ct);
        var session = new UserSession
        {
            UserId = user.Id, WorkspaceId = workspaceId, CreatedAt = now, LastSeenAt = now,
            ExpiresAt = now.AddDays(_opt.RefreshTokenDays), IpAddress = ctx.IpAddress, UserAgent = agent, LastActivityAt = now,
            AuthMethod = method, SsoTenantId = ssoTenantId, NewDevice = newDevice,
        };
        db.UserSessions.Add(session);
        _issuedSessionId = session.Id;
        var (raw, refresh) = NewRefreshToken(session, user.Id);
        var access = tokens.CreateAccessToken(user, session.Id, workspaceId);
        if (newDevice)
            await SecurityAlertAsync(user, "New sign-in to your account",
                $"{DeviceLoginService.Describe(agent)}{(Network(ctx.IpAddress) is { } net ? $" on network {net}" : "")} signed in at {now:HH:mm} UTC. If this was you, there is nothing to do. " +
                "If not, open Account → Sign-in history and choose \"This wasn't me\": that sign-in ends at once. Then change your password.", ct);
        return new AuthResult(access.Token, access.ExpiresAt, ToDto(user), raw, refresh.ExpiresAt);
    }

    /// <summary>The network a sign-in came from, coarse enough to stay the same at home or the office: the first three parts of the address.</summary>
    public static string? Network(string? ip)
    {
        if (string.IsNullOrWhiteSpace(ip) || !System.Net.IPAddress.TryParse(ip, out var a)) return null;
        if (a.IsIPv4MappedToIPv6) a = a.MapToIPv4();
        if (a.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork) { var b = a.GetAddressBytes(); return $"{b[0]}.{b[1]}.{b[2]}.x"; }
        var parts = a.ToString().Split(':');
        return string.Join(':', parts.Take(3)) + ":…";
    }

    /// <summary>
    /// The first sign-in from this browser (kind and system) on this network in six months, for someone who has signed in before: worth telling
    /// them about. A first sign-in ever is not.
    /// </summary>
    private async Task<bool> IsNewDeviceAsync(Guid userId, string? agent, string? ip, CancellationToken ct)
    {
        var since = clock.Now.AddDays(-180);
        var earlier = await db.UserSessions.AsNoTracking().Where(s => s.UserId == userId && s.CreatedAt > since).OrderByDescending(s => s.CreatedAt).Take(200)
            .Select(s => new { s.UserAgent, s.IpAddress }).ToListAsync(ct);
        if (earlier.Count == 0) return false;
        var device = DeviceLoginService.Describe(agent); var net = Network(ip);
        return !earlier.Any(e => DeviceLoginService.Describe(e.UserAgent) == device && Network(e.IpAddress) == net);
    }

    /// <summary>The person's sign-ins over the last 90 days, newest first, signed-in ones and ended ones.</summary>
    public async Task<IReadOnlyList<SignInDto>> SignInsAsync(CancellationToken ct = default)
    {
        var userId = ctx.RequireUserId();
        var now = clock.Now; var since = now.AddDays(-90);
        var rows = await db.UserSessions.AsNoTracking().Where(s => s.UserId == userId && s.CreatedAt > since).OrderByDescending(s => s.CreatedAt).Take(100).ToListAsync(ct);
        return rows.Select(s => new SignInDto(s.Id, s.CreatedAt, s.LastSeenAt, DeviceLoginService.Describe(s.UserAgent), Network(s.IpAddress), s.AuthMethod, s.Id == ctx.SessionId,
            s.RevokedAt == null && s.ExpiresAt > now, s.NewDevice, s.ReportedAt)).ToList();
    }

    /// <summary>
    /// "This wasn't me": that sign-in ends at once (its refresh tokens with it), it is marked as reported, and the account owner is told what
    /// to do next. The sign-in being used to report cannot be reported.
    /// </summary>
    public async Task ReportSignInAsync(Guid sessionId, CancellationToken ct = default)
    {
        var userId = ctx.RequireUserId();
        if (sessionId == ctx.SessionId) throw new ValidationException("session", "This is the sign-in you are using now.");
        var session = await db.UserSessions.FirstOrDefaultAsync(s => s.Id == sessionId && s.UserId == userId, ct) ?? throw new NotFoundException("Sign-in not found.");
        var now = clock.Now;
        session.RevokedAt ??= now; session.ReportedAt ??= now;
        await db.RefreshTokens.Where(t => t.SessionId == sessionId && t.UsedAt == null).ExecuteUpdateAsync(u => u.SetProperty(t => t.UsedAt, now), ct);
        recorder.Audit("session.reported", "UserSession", sessionId, newValue: new { Device = DeviceLoginService.Describe(session.UserAgent), Network = Network(session.IpAddress) }, userId: userId);
        await db.SaveChangesAsync(ct);
        var user = await db.Users.FirstAsync(u => u.Id == userId, ct);
        await SecurityAlertAsync(user, "A sign-in you did not recognise was ended",
            $"{DeviceLoginService.Describe(session.UserAgent)} is signed out. Change your password now{(user.MfaEnabled ? "" : " and turn on two-step verification")}, so it cannot sign in again.", ct);
    }

    private (string Raw, RefreshToken Token) NewRefreshToken(UserSession session, Guid userId)
    {
        var (raw, hash) = tokens.CreateOpaqueToken();
        var token = new RefreshToken
        {
            SessionId = session.Id, UserId = userId, TokenHash = hash, CreatedAt = clock.Now, ExpiresAt = session.ExpiresAt,
        };
        db.RefreshTokens.Add(token);
        return (raw, token);
    }

    /// <summary>Rotates the refresh token. Presenting an already-used token revokes the whole session.</summary>
    public Task<AuthResult> RefreshAsync(string? rawToken, CancellationToken ct = default) => RefreshAsync(rawToken, null, ct);

    /// <summary>
    /// Rotates the refresh token, issuing the access token for <paramref name="requestedWorkspace"/> (the workspace the calling tab is in) when the
    /// person is still a member of it, otherwise for the session's workspace. The token is claimed atomically, so two simultaneous refreshes
    /// cannot both rotate it. A second use within the grace window (another tab of the same browser) gets a fresh access token for the same
    /// session and no new refresh token (the browser already holds the one the first request issued). A later reuse revokes the whole session.
    /// </summary>
    public async Task<AuthResult> RefreshAsync(string? rawToken, Guid? requestedWorkspace, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(rawToken)) throw new UnauthorizedException("Refresh token missing.", "INVALID_REFRESH_TOKEN");

        var hash = tokens.Hash(rawToken);
        var stored = await db.RefreshTokens.FirstOrDefaultAsync(t => t.TokenHash == hash, ct)
            ?? throw new UnauthorizedException("Invalid refresh token.", "INVALID_REFRESH_TOKEN");
        var session = await db.UserSessions.FirstOrDefaultAsync(s => s.Id == stored.SessionId, ct);
        var now = clock.Now;

        // Ended by "Single active session" (signed in on another device) or to secure the account: say so, in the person's words.
        if (session?.RevokedAt is not null && session.EndedReason is { Length: > 0 } reason)
            throw new UnauthorizedException(reason, "SESSION_REPLACED");
        if (session is null || session.RevokedAt is not null || stored.ExpiresAt <= now)
            throw new UnauthorizedException("Session expired. Please sign in again.", "SESSION_EXPIRED");

        // "Sign out after inactivity": a session nobody has really used for longer than its workspace allows is locked, and stays locked until
        // the person unlocks it (passkey or password). The token is left untouched, so unlocking can still rotate it.
        await EnsureNotIdleAsync(session, now, ct);

        // Claim the token in one statement: of two simultaneous requests exactly one sees "unused" and rotates it.
        var storedId = stored.Id;
        var claimed = stored.UsedAt is null
            && await db.RefreshTokens.Where(t => t.Id == storedId && t.UsedAt == null).ExecuteUpdateAsync(s => s.SetProperty(t => t.UsedAt, (DateTime?)now), ct) == 1;
        if (!claimed)
        {
            var current = await db.RefreshTokens.AsNoTracking().Where(t => t.Id == storedId)
                .Select(t => new { t.UsedAt, t.ReplacedByTokenId }).FirstAsync(ct);
            var usedAt = current.UsedAt ?? now;
            // A near-simultaneous second request (e.g. two tabs) is benign; anything later is token theft.
            if ((now - usedAt).TotalSeconds > _opt.RefreshReuseGraceSeconds)
            {
                session.RevokedAt = now;
                recorder.Audit("session.reuse_detected", "UserSession", session.Id, userId: stored.UserId);
                await db.SaveChangesAsync(ct);
                throw new UnauthorizedException("Refresh token has already been used.", "REFRESH_TOKEN_REUSED");
            }
            // Within the grace window: only while the token that replaced it is still the live one (or is being written right now).
            var successorLive = current.ReplacedByTokenId is not { } successorId
                || await db.RefreshTokens.AnyAsync(t => t.Id == successorId && t.UsedAt == null && t.ExpiresAt > now, ct);
            if (!successorLive) throw new UnauthorizedException("Refresh token has already been used.", "REFRESH_TOKEN_REUSED");
            var graceUser = await db.Users.FirstOrDefaultAsync(u => u.Id == stored.UserId, ct);
            if (graceUser is null || !graceUser.IsActive) throw new UnauthorizedException("Account is disabled.", "ACCOUNT_DISABLED");
            var graceWorkspace = await RefreshWorkspaceAsync(graceUser.Id, requestedWorkspace, session.WorkspaceId, ct);
            var graceAccess = tokens.CreateAccessToken(graceUser, session.Id, graceWorkspace);
            // A fresh refresh token too (a sibling of the one that replaced it; both stay valid). Without it, a browser whose first refresh
            // response was lost - the page navigated or reloaded while it was on its way, so the rotated cookie never arrived - keeps the
            // old cookie, and its next refresh after the grace window looks like theft and ends a perfectly good session.
            var (graceRaw, graceNext) = NewRefreshToken(session, graceUser.Id);
            session.LastSeenAt = now;
            await db.SaveChangesAsync(ct);
            return new AuthResult(graceAccess.Token, graceAccess.ExpiresAt, ToDto(graceUser), graceRaw, graceNext.ExpiresAt);
        }

        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == stored.UserId, ct);
        if (user is null || !user.IsActive) throw new UnauthorizedException("Account is disabled.", "ACCOUNT_DISABLED");

        var workspaceId = await RefreshWorkspaceAsync(user.Id, requestedWorkspace, session.WorkspaceId, ct);
        session.WorkspaceId = workspaceId;
        session.LastSeenAt = now;
        session.IpAddress = ctx.IpAddress ?? session.IpAddress;

        stored.UsedAt = now;
        var (raw, next) = NewRefreshToken(session, user.Id);
        stored.ReplacedByTokenId = next.Id;
        var access = tokens.CreateAccessToken(user, session.Id, workspaceId);
        await db.SaveChangesAsync(ct);
        return new AuthResult(access.Token, access.ExpiresAt, ToDto(user), raw, next.ExpiresAt);
    }

    public async Task LogoutAsync(string? rawRefreshToken, CancellationToken ct = default)
    {
        Guid? sessionId = ctx.SessionId;
        if (sessionId is null && !string.IsNullOrWhiteSpace(rawRefreshToken))
        {
            var hash = tokens.Hash(rawRefreshToken);
            sessionId = (await db.RefreshTokens.FirstOrDefaultAsync(t => t.TokenHash == hash, ct))?.SessionId;
        }
        if (sessionId is null) return;
        var session = await db.UserSessions.FirstOrDefaultAsync(s => s.Id == sessionId, ct);
        if (session is null || session.RevokedAt is not null) return;
        session.RevokedAt = clock.Now;
        recorder.Audit("user.logout", "User", session.UserId, userId: session.UserId);
        await db.SaveChangesAsync(ct);
    }

    public async Task LogoutAllAsync(CancellationToken ct = default)
    {
        var userId = ctx.RequireUserId();
        await RevokeSessionsAsync(userId, exceptSessionId: null, ct);
        // Every refresh token of the account is spent too, not only its sessions ended: none of them can be presented again.
        var spentAt = clock.Now;
        await db.RefreshTokens.Where(t => t.UserId == userId && t.UsedAt == null).ExecuteUpdateAsync(u => u.SetProperty(t => t.UsedAt, (DateTime?)spentAt), ct);
        recorder.Audit("user.logout_all", "User", userId);
        await db.SaveChangesAsync(ct);
    }

    private async Task RevokeSessionsAsync(Guid userId, Guid? exceptSessionId, CancellationToken ct)
    {
        var now = clock.Now;
        var sessions = await db.UserSessions
            .Where(s => s.UserId == userId && s.RevokedAt == null && s.Id != exceptSessionId).ToListAsync(ct);
        foreach (var s in sessions) s.RevokedAt = now;
    }

    public async Task<IReadOnlyList<SessionDto>> GetSessionsAsync(CancellationToken ct = default)
    {
        var userId = ctx.RequireUserId();
        var now = clock.Now;
        var rows = await db.UserSessions.AsNoTracking()
            .Where(s => s.UserId == userId && s.RevokedAt == null && s.ExpiresAt > now)
            .OrderByDescending(s => s.LastSeenAt).ToListAsync(ct);
        return rows.Select(s =>
        {
            var app = SessionDevice.App(s.UserAgent, false);
            return new SessionDto(s.Id, s.CreatedAt, s.LastSeenAt, s.IpAddress, s.UserAgent, s.Id == ctx.SessionId, s.AuthMethod,
                SessionDevice.Describe(s.UserAgent, null, app), SessionDevice.Location(s.IpAddress, null, false));
        }).ToList();
    }

    public async Task RevokeSessionAsync(Guid sessionId, CancellationToken ct = default)
    {
        var userId = ctx.RequireUserId();
        var session = await db.UserSessions.FirstOrDefaultAsync(s => s.Id == sessionId && s.UserId == userId, ct)
            ?? throw new NotFoundException("Session not found.");
        session.RevokedAt ??= clock.Now;
        recorder.Audit("session.revoked", "UserSession", sessionId);
        await db.SaveChangesAsync(ct);
    }

    // ---------------------------------------------------------------- sign out after inactivity (idle lock)

    public const int DefaultIdleMinutes = 30;
    public const int MaxUnlockAttempts = 5;
    /// <summary>The choices an Owner or Admin has: 15, 30 (the default), 60 minutes, 4 hours, or 0 = never.</summary>
    public static readonly int[] IdleChoices = [15, 30, 60, 240, 0];

    /// <summary>When the person last really used the app: the activity ping's time, or for an older session its last refresh (never before it opened).</summary>
    public static DateTime LastActivity(DateTime? lastActivityAt, DateTime lastSeenAt, DateTime createdAt) =>
        lastActivityAt ?? (lastSeenAt > createdAt ? lastSeenAt : createdAt);

    /// <summary>Whether a session last used at <paramref name="lastActivity"/> has been idle for longer than the workspace's <paramref name="minutes"/> (0 = never).</summary>
    public static bool IsIdle(DateTime lastActivity, int minutes, DateTime now) => minutes > 0 && now - lastActivity > TimeSpan.FromMinutes(minutes);

    /// <summary>
    /// The idle time of a workspace. Read before any workspace is chosen for the request (refresh, unlock), so the tenant filter is bypassed for
    /// exactly that workspace's own settings row and nothing else.
    /// </summary>
    public async Task<int> IdleMinutesAsync(Guid? workspaceId, CancellationToken ct = default)
    {
        if (workspaceId is not { } wid) return DefaultIdleMinutes;
        var stored = await db.TenantSecuritySettings.IgnoreQueryFilters().AsNoTracking().Where(s => s.TenantId == wid).Select(s => (int?)s.IdleTimeoutMinutes).FirstOrDefaultAsync(ct);
        return stored ?? DefaultIdleMinutes;
    }

    private async Task EnsureNotIdleAsync(UserSession session, DateTime now, CancellationToken ct)
    {
        if (session.LockedAt is null && IsIdle(LastActivity(session.LastActivityAt, session.LastSeenAt, session.CreatedAt), await IdleMinutesAsync(session.WorkspaceId, ct), now))
        {
            session.LockedAt = now;
            session.UnlockFailures = 0;
            recorder.Audit("session.auto_locked", "UserSession", session.Id, newValue: new { Reason = "idle" }, tenantId: session.WorkspaceId, userId: session.UserId);
            await db.SaveChangesAsync(ct);
        }
        if (session.LockedAt is not null)
            throw new UnauthorizedException("You were away for a while. Unlock to carry on.", "SESSION_IDLE_LOCKED");
    }

    /// <summary>The idle time of the caller's workspace, for the app's timer and for Settings › Security.</summary>
    public async Task<IdlePolicyDto> IdlePolicyAsync(CancellationToken ct = default)
    {
        var tenantId = ctx.RequireTenantId();
        return new IdlePolicyDto(await IdleMinutesAsync(tenantId, ct), CanManageIdle, IdleChoices);
    }

    private bool CanManageIdle => !ctx.ViaApiKey && ctx.Role is TenantRole.Owner or TenantRole.Admin;

    /// <summary>Owners and admins only: how long the app may sit unused before it locks, for everyone in this workspace. Audited.</summary>
    public async Task<IdlePolicyDto> SetIdlePolicyAsync(SetIdlePolicyRequest req, CancellationToken ct = default)
    {
        var tenantId = ctx.RequireTenantId();
        if (!CanManageIdle) throw new ForbiddenException("Only owners and admins can change when people are signed out.", "PERMISSION_DENIED");
        if (!IdleChoices.Contains(req.Minutes)) throw new ValidationException("minutes", "Choose 15, 30 or 60 minutes, 4 hours, or never.");
        var row = await db.TenantSecuritySettings.FirstOrDefaultAsync(s => s.TenantId == tenantId, ct);
        var isNew = row is null;
        if (row is null) { row = new TenantSecuritySettings { TenantId = tenantId }; db.TenantSecuritySettings.Add(row); }
        if (row.IdleTimeoutMinutes != req.Minutes || isNew)
        {
            recorder.Audit("org.idle_timeout_changed", "Tenant", tenantId, oldValue: new { Minutes = row.IdleTimeoutMinutes }, newValue: new { req.Minutes }, tenantId: tenantId);
            row.IdleTimeoutMinutes = req.Minutes;
        }
        await db.SaveChangesAsync(ct);
        return new IdlePolicyDto(row.IdleTimeoutMinutes, true, IdleChoices);
    }

    /// <summary>
    /// The app's activity ping, sent only on real use (keyboard, pointer, touch; at most about once a minute). It moves the session's last activity;
    /// background polling and realtime never call it. A session that is already idle or locked never gets here (CurrentContextMiddleware).
    /// </summary>
    public async Task<IdlePolicyDto> ActivityAsync(CancellationToken ct = default)
    {
        var sessionId = ctx.SessionId ?? throw new UnauthorizedException("Sign in first.", "UNAUTHORIZED");
        var session = await db.UserSessions.FirstOrDefaultAsync(s => s.Id == sessionId && s.RevokedAt == null, ct)
            ?? throw new UnauthorizedException("Your session has ended. Please sign in again.", "SESSION_REVOKED");
        var now = clock.Now;
        // Already idle or locked: the ping cannot reopen it, only unlocking can.
        await EnsureNotIdleAsync(session, now, ct);
        // Many tabs pinging together write at most once in a while.
        if (session.LastActivityAt is not { } last || now - last > TimeSpan.FromSeconds(20))
        {
            session.LastActivityAt = now;
            await db.SaveChangesAsync(ct);
        }
        return new IdlePolicyDto(await IdleMinutesAsync(session.WorkspaceId, ct), CanManageIdle, IdleChoices);
    }

    /// <summary>The session a refresh token belongs to, while it is still open (locked or not).</summary>
    private async Task<(RefreshToken Token, UserSession Session, User User)> OpenSessionAsync(string? rawToken, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(rawToken)) throw new UnauthorizedException("Refresh token missing.", "INVALID_REFRESH_TOKEN");
        var hash = tokens.Hash(rawToken);
        var stored = await db.RefreshTokens.FirstOrDefaultAsync(t => t.TokenHash == hash, ct)
            ?? throw new UnauthorizedException("Invalid refresh token.", "INVALID_REFRESH_TOKEN");
        var session = await db.UserSessions.FirstOrDefaultAsync(s => s.Id == stored.SessionId, ct);
        var now = clock.Now;
        if (session?.RevokedAt is not null && session.EndedReason is { Length: > 0 } reason) throw new UnauthorizedException(reason, "SESSION_REPLACED");
        if (session is null || session.RevokedAt is not null || stored.ExpiresAt <= now || stored.UsedAt is not null)
            throw new UnauthorizedException("Session expired. Please sign in again.", "SESSION_EXPIRED");
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == stored.UserId, ct);
        if (user is null || !user.IsActive) throw new UnauthorizedException("Account is disabled.", "ACCOUNT_DISABLED");
        return (stored, session, user);
    }

    /// <summary>Locks the session now (the app's timer ran out). Works with the access token or, once that has expired, the refresh cookie.</summary>
    public async Task LockAsync(string? rawToken, CancellationToken ct = default)
    {
        UserSession? session = null;
        if (ctx.SessionId is { } sid) session = await db.UserSessions.FirstOrDefaultAsync(s => s.Id == sid && s.RevokedAt == null, ct);
        if (session is null && !string.IsNullOrWhiteSpace(rawToken)) session = (await OpenSessionAsync(rawToken, ct)).Session;
        if (session is null) throw new UnauthorizedException("Session expired. Please sign in again.", "SESSION_EXPIRED");
        if (session.LockedAt is not null) return;
        session.LockedAt = clock.Now;
        session.UnlockFailures = 0;
        recorder.Audit("session.auto_locked", "UserSession", session.Id, newValue: new { Reason = "timer" }, tenantId: session.WorkspaceId, userId: session.UserId);
        await db.SaveChangesAsync(ct);
    }

    /// <summary>What the lock screen shows for the session behind this refresh token.</summary>
    public async Task<LockStateDto> LockStateAsync(string? rawToken, CancellationToken ct = default)
    {
        var (_, session, user) = await OpenSessionAsync(rawToken, ct);
        var hasPasskey = await db.PasskeyCredentials.AsNoTracking().AnyAsync(p => p.UserId == user.Id, ct);
        return new LockStateDto(session.LockedAt is not null, user.Id, user.DisplayName, user.AvatarKey is not null, !string.IsNullOrEmpty(user.PasswordHash), hasPasskey,
            Math.Max(0, MaxUnlockAttempts - session.UnlockFailures), await IdleMinutesAsync(session.WorkspaceId, ct));
    }

    /// <summary>The person whose session this refresh token opens (for a passkey challenge only they can answer).</summary>
    public async Task<Guid> LockedUserIdAsync(string? rawToken, CancellationToken ct = default) => (await OpenSessionAsync(rawToken, ct)).User.Id;

    /// <summary>Whether this is the account's password (an account without one, signed in another way, has none to match).</summary>
    public bool PasswordMatches(User user, string? password) =>
        user.IsActive && !string.IsNullOrEmpty(user.PasswordHash) && !string.IsNullOrEmpty(password) && hasher.Verify(user.PasswordHash, password);

    /// <summary>
    /// Unlocks a locked session with a fresh proof that it is still the same person (<paramref name="verify"/>: their password or one of their own
    /// passkeys). The session already passed its sign-in rules (two-step included) when it opened, so this proof is enough to carry on; a passkey is two
    /// factors by itself. Wrong answers count: after five in a row the session is signed out for good. The refresh token is rotated as on a refresh.
    /// </summary>
    public async Task<AuthResult> UnlockAsync(string? rawToken, string method, Func<User, Task<bool>> verify, Guid? requestedWorkspace, CancellationToken ct = default)
    {
        var (stored, session, user) = await OpenSessionAsync(rawToken, ct);
        var now = clock.Now;
        if (user.LockoutEnd is { } lockEnd && lockEnd > now)
            throw new TooManyRequestsException("Too many failed attempts. Try again later.", "ACCOUNT_LOCKED");
        if (!await verify(user))
        {
            session.UnlockFailures++;
            recorder.Audit("session.unlock_failed", "UserSession", session.Id, newValue: new { Method = method, Attempt = session.UnlockFailures }, tenantId: session.WorkspaceId, userId: user.Id);
            if (session.UnlockFailures >= MaxUnlockAttempts)
            {
                session.RevokedAt = now;
                session.EndedReason = "Signed out after too many wrong unlock attempts. Sign in again.";
                stored.UsedAt = now;
                recorder.Audit("session.unlock_signed_out", "UserSession", session.Id, tenantId: session.WorkspaceId, userId: user.Id);
                await db.SaveChangesAsync(ct);
                throw new UnauthorizedException(session.EndedReason, "SESSION_UNLOCK_SIGNED_OUT");
            }
            await db.SaveChangesAsync(ct);
            var left = MaxUnlockAttempts - session.UnlockFailures;
            throw new UnauthorizedException(method == "passkey" ? $"That passkey didn't work. {left} {(left == 1 ? "try" : "tries")} left." : $"Wrong password. {left} {(left == 1 ? "try" : "tries")} left.", "UNLOCK_FAILED");
        }

        var wasLocked = session.LockedAt is not null;
        session.LockedAt = null;
        session.UnlockFailures = 0;
        session.LastActivityAt = now;
        session.LastSeenAt = now;
        var workspaceId = await RefreshWorkspaceAsync(user.Id, requestedWorkspace, session.WorkspaceId, ct);
        session.WorkspaceId = workspaceId;
        stored.UsedAt = now;
        var (raw, next) = NewRefreshToken(session, user.Id);
        stored.ReplacedByTokenId = next.Id;
        var access = tokens.CreateAccessToken(user, session.Id, workspaceId);
        recorder.Audit("session.unlocked", "UserSession", session.Id, newValue: new { Method = method, WasLocked = wasLocked }, tenantId: workspaceId, userId: user.Id);
        await db.SaveChangesAsync(ct);
        return new AuthResult(access.Token, access.ExpiresAt, ToDto(user), raw, next.ExpiresAt);
    }

    // ---------------------------------------------------------------- password management

    public async Task ForgotPasswordAsync(ForgotPasswordRequest req, CancellationToken ct = default)
    {
        var normalized = Text.NormalizeEmail(req.Email);
        var user = await db.Users.FirstOrDefaultAsync(u => u.NormalizedEmail == normalized, ct);
        if (user is null || !user.IsActive) return; // always respond identically

        var (raw, hash) = tokens.CreateOpaqueToken();
        user.PasswordResetTokenHash = hash;
        user.PasswordResetExpiresAt = clock.Now.AddHours(_opt.ResetTokenHours);
        recorder.Audit("user.password_reset_requested", "User", user.Id, userId: user.Id);
        await db.SaveChangesAsync(ct);

        var link = $"{_opt.WebBaseUrl.TrimEnd('/')}/reset-password?token={Uri.EscapeDataString(raw)}";
        await email.TrySendAsync(new EmailMessage(user.Email, "Reset your password",
            EmailTemplates.Wrap("Reset your password", $"Hi {WebUtility.HtmlEncode(user.DisplayName)},",
                $"We received a request to reset your password. This link expires in {_opt.ResetTokenHours} hours. If you did not ask for this, you can ignore this email.",
                "Choose a new password", link, preheader: "Choose a new password. The link expires soon.", kind: EmailKind.Security), $"Reset your password: {link}", "reset"), log, ct);
    }

    public async Task ResetPasswordAsync(ResetPasswordRequest req, CancellationToken ct = default)
    {
        var hash = tokens.Hash(req.Token);
        var user = await db.Users.FirstOrDefaultAsync(u => u.PasswordResetTokenHash == hash, ct);
        if (user is null || user.PasswordResetExpiresAt < clock.Now)
            throw new ValidationException("token", "This reset link is invalid or has expired.");
        await passwordPolicy.EnsureAcceptableAsync("password", req.Password, user.Email, user.DisplayName, user, ct);

        await passwordPolicy.RememberOutgoingAsync(user, ct);
        user.PasswordHash = hasher.Hash(req.Password);
        passwordPolicy.Stamp(user, req.Password);
        user.PasswordResetTokenHash = null;
        user.PasswordResetExpiresAt = null;
        user.EmailVerified = true; // receiving the reset email proves mailbox ownership
        user.MustChangePassword = false; // a password chosen through the emailed link is the person's own
        user.FailedLoginCount = 0;
        user.LockoutEnd = null;
        user.LockoutStreak = 0;
        await RevokeSessionsAsync(user.Id, null, ct);
        recorder.Audit("user.password_reset", "User", user.Id, userId: user.Id);
        await db.SaveChangesAsync(ct);
        await SecurityAlertAsync(user, "Your password was reset", "Your password was just reset with an emailed link. If this was not you, contact your administrator immediately.", ct);
    }

    public async Task ChangePasswordAsync(ChangePasswordRequest req, CancellationToken ct = default)
    {
        var userId = ctx.RequireUserId();
        var user = await db.Users.FirstAsync(u => u.Id == userId, ct);
        var now = clock.Now;
        if (user.LockoutEnd is { } lockEnd && lockEnd > now)
            throw new TooManyRequestsException("Too many failed attempts. Try again later.", "ACCOUNT_LOCKED");
        if (!hasher.Verify(user.PasswordHash, req.CurrentPassword))
        {
            await RegisterFailedPasswordAsync(user, now, ct);   // guessing the current password counts like guessing at sign-in
            throw new ValidationException("currentPassword", "Current password is incorrect.");
        }
        await passwordPolicy.EnsureAcceptableAsync("newPassword", req.NewPassword, user.Email, user.DisplayName, user, ct);
        if (user.MustChangePassword && hasher.Verify(user.PasswordHash, req.NewPassword))
            throw new ValidationException("newPassword", "Choose a password different from the temporary one you were given.");

        await passwordPolicy.RememberOutgoingAsync(user, ct);
        user.PasswordHash = hasher.Hash(req.NewPassword);
        passwordPolicy.Stamp(user, req.NewPassword);
        user.MustChangePassword = false;
        await RevokeSessionsAsync(userId, ctx.SessionId, ct);
        recorder.Audit("user.password_changed", "User", userId);
        await SecurityAlertAsync(user, "Your password was changed", "If this was not you, reset your password straight away and sign out of all devices.", ct);
        await db.SaveChangesAsync(ct);
    }

    private Task SecurityAlertAsync(User user, string title, string body, CancellationToken ct) => alerts.SendAsync(user, title, body, ct);

    public async Task<UserDto> UpdateProfileAsync(UpdateProfileRequest req, CancellationToken ct = default)
    {
        var userId = ctx.RequireUserId();
        var user = await db.Users.FirstAsync(u => u.Id == userId, ct);
        user.DisplayName = req.DisplayName.Trim();
        if (!string.IsNullOrWhiteSpace(req.TimeZone))
        {
            user.TimeZone = req.TimeZone.Trim();
            // Choosing UTC by hand is a real choice (a device or a column default reporting UTC is not): it is remembered by turning
            // "Follow this device" off, which is what makes a UTC profile zone count (AppClock.ZoneFor).
            if (ProjectManagement.Application.Features.Reminders.ZoneTime.IsKnown(user.TimeZone) && ProjectManagement.Application.Features.Reminders.ZoneTime.IsPlaceholder(user.TimeZone))
            {
                var settings = await db.ReminderSettings.FirstOrDefaultAsync(s => s.UserId == userId, ct);
                if (settings is null) db.ReminderSettings.Add(new ReminderSettings { UserId = userId, FollowDeviceTimeZone = false });
                else settings.FollowDeviceTimeZone = false;
            }
        }
        await db.SaveChangesAsync(ct);
        return ToDto(user);
    }
}
