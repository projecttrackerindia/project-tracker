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

public record RegisterRequest(string Email, string Password, string DisplayName, bool AcceptedTerms);
public record LoginRequest(string Email, string Password);
public record VerifyEmailRequest(string Token);
public record ResendVerificationRequest(string Email);
public record ForgotPasswordRequest(string Email);
public record ResetPasswordRequest(string Token, string Password);
public record ChangePasswordRequest(string CurrentPassword, string NewPassword);
public record UpdateProfileRequest(string DisplayName, string? TimeZone);
public record RefreshRequest(string? RefreshToken);

public record UserDto(Guid Id, string Email, string DisplayName, bool EmailVerified, bool IsPlatformAdmin, string TimeZone, bool MfaEnabled = false, bool MustChangePassword = false);
public record SessionDto(Guid Id, DateTime CreatedAt, DateTime LastSeenAt, string? IpAddress, string? UserAgent, bool IsCurrent, string? AuthMethod = null);

/// <summary>Result of login / refresh. The refresh token is delivered by the API layer (cookie or body).</summary>
public record AuthResult(string AccessToken, DateTime ExpiresAt, UserDto User, string RefreshToken, DateTime RefreshExpiresAt);
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
    ILogger<AuthService> log)
{
    private readonly AppOptions _opt = options.Value;

    public static UserDto ToDto(User u) => new(u.Id, u.Email, u.DisplayName, u.EmailVerified, u.IsPlatformAdmin, u.TimeZone, u.MfaEnabled, u.MustChangePassword);

    // ---------------------------------------------------------------- registration

    public async Task<RegisterResult> RegisterAsync(RegisterRequest req, CancellationToken ct = default)
    {
        var normalized = Text.NormalizeEmail(req.Email);
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
            Email = req.Email.Trim(), NormalizedEmail = normalized, DisplayName = req.DisplayName.Trim(),
            PasswordHash = hasher.Hash(req.Password), EmailVerified = !_opt.RequireEmailVerification, CreatedAt = now,
        };
        string? rawToken = null;
        if (_opt.RequireEmailVerification) rawToken = SetVerificationToken(user);
        db.Users.Add(user);

        var workspace = await provisioner.CreateAsync("Personal Workspace", WorkspaceType.Personal, user.Id, null,
            $"{user.DisplayName} personal", ct);
        recorder.Audit("user.registered", "User", user.Id, tenantId: workspace.Id, userId: user.Id);
        await db.SaveChangesAsync(ct);
        await consent.RecordCurrentAsync(user.Id, ctx.IpAddress, ct);

        if (rawToken is not null) await SendVerificationEmailAsync(user, rawToken, ct);
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
    private Task<bool> SendVerificationEmailAsync(User user, string rawToken, CancellationToken ct)
    {
        var link = $"{_opt.WebBaseUrl.TrimEnd('/')}/verify-email?token={Uri.EscapeDataString(rawToken)}";
        return email.TrySendAsync(new EmailMessage(user.Email, "Verify your email address",
            EmailTemplates.Wrap("Verify your email", $"Hi {WebUtility.HtmlEncode(user.DisplayName)},", "Confirm your email address to activate your account.",
                "Verify email", link, preheader: "Confirm your address to finish creating your account."), $"Verify your email: {link}", "verify"), log, ct);
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
    }

    public async Task ResendVerificationAsync(ResendVerificationRequest req, CancellationToken ct = default)
    {
        var normalized = Text.NormalizeEmail(req.Email);
        var user = await db.Users.FirstOrDefaultAsync(u => u.NormalizedEmail == normalized, ct);
        if (user is null || user.EmailVerified || !user.IsActive) return; // never reveal account state
        var raw = SetVerificationToken(user);
        await db.SaveChangesAsync(ct);
        await SendVerificationEmailAsync(user, raw, ct);
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
        if (user.LockoutEnd is { } lockEnd && lockEnd > now)
        {
            AppTelemetry.Count(AppTelemetry.Logins, "locked");
            throw new TooManyRequestsException("Too many failed sign-in attempts. Try again later.", "ACCOUNT_LOCKED");
        }
        // An organization that requires its own single sign-on for this email's domain: the password is not the way in (Owners excepted).
        if (await ssoPolicy.EnforcedForAsync(user.Email, user.Id, ct) is { } enforced)
            throw new ForbiddenException($"{enforced.Name} is required for this account. Use \"Sign in with SSO\".", "SSO_REQUIRED");

        if (!user.IsActive || !hasher.Verify(user.PasswordHash, req.Password))
        {
            if (user.IsActive && ++user.FailedLoginCount >= _opt.MaxFailedLogins)
            {
                user.LockoutEnd = now.AddMinutes(_opt.LockoutMinutes);
                user.FailedLoginCount = 0;
                recorder.Audit("user.locked_out", "User", user.Id, userId: user.Id);
            }
            await db.SaveChangesAsync(ct);
            AppTelemetry.Count(AppTelemetry.Logins, "wrong_password");
            throw new UnauthorizedException("Invalid email or password.", "INVALID_CREDENTIALS");
        }
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
    public async Task<AuthResult> SignInExternalAsync(User user, string method, Guid? preferredWorkspace, Guid? ssoTenantId, CancellationToken ct)
    {
        user.FailedLoginCount = 0;
        user.LockoutEnd = null;
        user.LastLoginAt = clock.Now;
        var workspaceId = await PickWorkspaceAsync(user.Id, preferredWorkspace, ct);
        var result = await IssueSessionAsync(user, workspaceId, ct, method, ssoTenantId);
        recorder.Audit("user.login", "User", user.Id, newValue: new { Method = method }, userId: user.Id, tenantId: workspaceId);
        AppTelemetry.Count(AppTelemetry.Logins, "success");
        await db.SaveChangesAsync(ct);
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

    /// <summary>A short-lived proof that the first step of a sign-in succeeded; the second step (an authenticator code) completes it.</summary>
    public string CreateMfaChallenge(User user) => tokens.CreateChallenge(user.Id, TimeSpan.FromMinutes(5));

    private Task<AuthResult> IssueSessionAsync(User user, Guid? workspaceId, CancellationToken ct, string? method = null, Guid? ssoTenantId = null)
    {
        var now = clock.Now;
        var session = new UserSession
        {
            UserId = user.Id, WorkspaceId = workspaceId, CreatedAt = now, LastSeenAt = now,
            ExpiresAt = now.AddDays(_opt.RefreshTokenDays), IpAddress = ctx.IpAddress, UserAgent = Text.Truncate(ctx.UserAgent, 300),
            AuthMethod = method, SsoTenantId = ssoTenantId,
        };
        db.UserSessions.Add(session);
        var (raw, refresh) = NewRefreshToken(session, user.Id);
        var access = tokens.CreateAccessToken(user, session.Id, workspaceId);
        return Task.FromResult(new AuthResult(access.Token, access.ExpiresAt, ToDto(user), raw, refresh.ExpiresAt));
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
    public async Task<AuthResult> RefreshAsync(string? rawToken, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(rawToken)) throw new UnauthorizedException("Refresh token missing.", "INVALID_REFRESH_TOKEN");

        var hash = tokens.Hash(rawToken);
        var stored = await db.RefreshTokens.FirstOrDefaultAsync(t => t.TokenHash == hash, ct)
            ?? throw new UnauthorizedException("Invalid refresh token.", "INVALID_REFRESH_TOKEN");
        var session = await db.UserSessions.FirstOrDefaultAsync(s => s.Id == stored.SessionId, ct);
        var now = clock.Now;

        if (session is null || session.RevokedAt is not null || stored.ExpiresAt <= now)
            throw new UnauthorizedException("Session expired. Please sign in again.", "SESSION_EXPIRED");

        if (stored.UsedAt is { } usedAt)
        {
            // A near-simultaneous second request (e.g. two tabs) is benign; anything later is token theft.
            if ((now - usedAt).TotalSeconds > _opt.RefreshReuseGraceSeconds)
            {
                session.RevokedAt = now;
                recorder.Audit("session.reuse_detected", "UserSession", session.Id, userId: stored.UserId);
                await db.SaveChangesAsync(ct);
            }
            throw new UnauthorizedException("Refresh token has already been used.", "REFRESH_TOKEN_REUSED");
        }

        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == stored.UserId, ct);
        if (user is null || !user.IsActive) throw new UnauthorizedException("Account is disabled.", "ACCOUNT_DISABLED");

        var workspaceId = await PickWorkspaceAsync(user.Id, session.WorkspaceId, ct);
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
        return rows.Select(s => new SessionDto(s.Id, s.CreatedAt, s.LastSeenAt, s.IpAddress, s.UserAgent, s.Id == ctx.SessionId, s.AuthMethod)).ToList();
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
                "Choose a new password", link, preheader: "Choose a new password. The link expires soon."), $"Reset your password: {link}", "reset"), log, ct);
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
        user.PasswordResetTokenHash = null;
        user.PasswordResetExpiresAt = null;
        user.EmailVerified = true; // receiving the reset email proves mailbox ownership
        user.MustChangePassword = false; // a password chosen through the emailed link is the person's own
        user.FailedLoginCount = 0;
        user.LockoutEnd = null;
        await RevokeSessionsAsync(user.Id, null, ct);
        recorder.Audit("user.password_reset", "User", user.Id, userId: user.Id);
        await db.SaveChangesAsync(ct);
        await SecurityAlertAsync(user, "Your password was reset", "Your password was just reset with an emailed link. If this was not you, contact your administrator immediately.", ct);
    }

    public async Task ChangePasswordAsync(ChangePasswordRequest req, CancellationToken ct = default)
    {
        var userId = ctx.RequireUserId();
        var user = await db.Users.FirstAsync(u => u.Id == userId, ct);
        if (!hasher.Verify(user.PasswordHash, req.CurrentPassword))
            throw new ValidationException("currentPassword", "Current password is incorrect.");
        await passwordPolicy.EnsureAcceptableAsync("newPassword", req.NewPassword, user.Email, user.DisplayName, user, ct);
        if (user.MustChangePassword && hasher.Verify(user.PasswordHash, req.NewPassword))
            throw new ValidationException("newPassword", "Choose a password different from the temporary one you were given.");

        await passwordPolicy.RememberOutgoingAsync(user, ct);
        user.PasswordHash = hasher.Hash(req.NewPassword);
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
        if (!string.IsNullOrWhiteSpace(req.TimeZone)) user.TimeZone = req.TimeZone.Trim();
        await db.SaveChangesAsync(ct);
        return ToDto(user);
    }
}

public static class EmailTemplates
{
    /// <summary>
    /// The one look every e-mail shares: a quiet card with the product name, a single clear button, the link in words for programs that block buttons, and an
    /// optional line (and "stop emails like this" link) at the foot. Table layout and inline styles, because mail programs ignore almost everything else; light
    /// and dark both read well (the colors are chosen to survive automatic inversion).
    /// </summary>
    public static string Wrap(string title, string greeting, string body, string cta, string link, string? footer = null, string? preheader = null, string? unsubscribeUrl = null)
    {
        static string enc(string s) => WebUtility.HtmlEncode(s);
        var foot = footer is null ? "" : $"<p style=\"margin:0 0 6px;font-size:12px;line-height:18px;color:#8a82a6\">{enc(footer)}</p>";
        var stop = unsubscribeUrl is null ? "" : $"<p style=\"margin:0;font-size:12px;line-height:18px;color:#8a82a6\"><a href=\"{enc(unsubscribeUrl)}\" style=\"color:#8a82a6;text-decoration:underline\">Stop emails like this</a></p>";
        var hidden = preheader is null ? "" : $"<div style=\"display:none;max-height:0;overflow:hidden;opacity:0;color:transparent\">{enc(preheader)}</div>";
        return $$"""
            <!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>{{enc(title)}}</title></head>
            <body style="margin:0;padding:0;background:#f4f1fb">{{hidden}}
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1fb"><tr><td align="center" style="padding:28px 14px">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px">
                <tr><td style="padding:0 6px 14px;font-family:Inter,Segoe UI,Arial,sans-serif;font-size:15px;font-weight:700;color:#221a3a"><span style="display:inline-block;width:22px;height:22px;line-height:22px;text-align:center;border-radius:7px;background:#7c3aed;color:#ffffff;font-size:13px;vertical-align:middle">&#10003;</span>&nbsp; Project Tracker</td></tr>
                <tr><td style="background:#ffffff;border:1px solid #e7e1f7;border-radius:16px;padding:28px 26px;font-family:Inter,Segoe UI,Arial,sans-serif;color:#221a3a">
                  <h1 style="margin:0 0 14px;font-size:21px;line-height:28px;letter-spacing:-.2px;color:#221a3a">{{enc(title)}}</h1>
                  <p style="margin:0 0 10px;font-size:15px;line-height:24px;color:#221a3a">{{greeting}}</p>
                  <p style="margin:0 0 22px;font-size:15px;line-height:24px;color:#4a4268">{{enc(body)}}</p>
                  <p style="margin:0 0 22px"><a href="{{enc(link)}}" style="display:inline-block;background:#7c3aed;color:#ffffff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:600;font-size:15px">{{enc(cta)}}</a></p>
                  <p style="margin:0;font-size:12px;line-height:18px;color:#8a82a6">If the button does not work, copy this link: <a href="{{enc(link)}}" style="color:#7c3aed;word-break:break-all">{{enc(link)}}</a></p>
                </td></tr>
                <tr><td style="padding:16px 8px 0;font-family:Inter,Segoe UI,Arial,sans-serif">{{foot}}{{stop}}</td></tr>
              </table>
            </td></tr></table></body></html>
            """;
    }

    /// <summary>Several short updates in one message, each with its own link: used instead of many separate e-mails.</summary>
    public static string Digest(string title, string greeting, IReadOnlyList<(string Title, string? Body, string Link)> items, string cta, string link, string? footer, string? preheader, string? unsubscribeUrl)
    {
        static string enc(string s) => WebUtility.HtmlEncode(s);
        var rows = string.Concat(items.Take(15).Select(i => $"<tr><td style=\"padding:10px 0;border-top:1px solid #efeaf9\"><a href=\"{enc(i.Link)}\" style=\"color:#221a3a;font-weight:600;text-decoration:none;font-size:15px\">{enc(i.Title)}</a>{(string.IsNullOrWhiteSpace(i.Body) || i.Body == i.Title ? "" : $"<div style=\"color:#6a6288;font-size:13px;line-height:20px\">{enc(i.Body.Length > 140 ? i.Body[..140] + "…" : i.Body)}</div>")}</td></tr>"));
        var more = items.Count > 15 ? $"<p style=\"font-size:13px;color:#6a6288\">and {items.Count - 15} more.</p>" : "";
        return Wrap(title, greeting, "", cta, link, footer, preheader, unsubscribeUrl)
            .Replace("<p style=\"margin:0 0 22px;font-size:15px;line-height:24px;color:#4a4268\"></p>", $"<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"margin:0 0 22px\">{rows}</table>{more}");
    }
}
