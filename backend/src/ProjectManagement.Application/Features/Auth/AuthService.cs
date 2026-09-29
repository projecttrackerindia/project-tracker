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
public record SessionDto(Guid Id, DateTime CreatedAt, DateTime LastSeenAt, string? IpAddress, string? UserAgent, bool IsCurrent);

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
        var baseSlug = Text.Slugify(slugHint ?? name);
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
    PasswordPolicyService passwordPolicy, ProjectManagement.Application.Features.Consent.ConsentService consent, ILogger<AuthService> log)
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
                "Verify email", link), $"Verify your email: {link}"), log, ct);
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

    private async Task<AuthResult> SignInAsync(User user, string method, CancellationToken ct)
    {
        user.FailedLoginCount = 0;
        user.LockoutEnd = null;
        user.LastLoginAt = clock.Now;
        var workspaceId = await PickWorkspaceAsync(user.Id, null, ct);
        var result = await IssueSessionAsync(user, workspaceId, ct);
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

    private Task<AuthResult> IssueSessionAsync(User user, Guid? workspaceId, CancellationToken ct)
    {
        var now = clock.Now;
        var session = new UserSession
        {
            UserId = user.Id, WorkspaceId = workspaceId, CreatedAt = now, LastSeenAt = now,
            ExpiresAt = now.AddDays(_opt.RefreshTokenDays), IpAddress = ctx.IpAddress, UserAgent = Text.Truncate(ctx.UserAgent, 300),
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
        return rows.Select(s => new SessionDto(s.Id, s.CreatedAt, s.LastSeenAt, s.IpAddress, s.UserAgent, s.Id == ctx.SessionId)).ToList();
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
                "Choose a new password", link), $"Reset your password: {link}"), log, ct);
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
    public static string Wrap(string title, string greeting, string body, string cta, string link, string? footer = null)
    {
        var note = footer is null ? "" : $"<p style=\"font-size:12px;color:#928aa9\">{WebUtility.HtmlEncode(footer)}</p>";
        return $$"""
            <div style="font-family:Inter,Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#221a3a">
              <h2 style="margin:0 0 12px">{{WebUtility.HtmlEncode(title)}}</h2>
              <p>{{greeting}}</p>
              <p>{{WebUtility.HtmlEncode(body)}}</p>
              <p><a href="{{WebUtility.HtmlEncode(link)}}" style="display:inline-block;background:#7c3aed;color:#fff;padding:10px 18px;border-radius:9px;text-decoration:none;font-weight:600">{{WebUtility.HtmlEncode(cta)}}</a></p>
              <p style="font-size:12px;color:#928aa9">If the button does not work, copy this link: {{WebUtility.HtmlEncode(link)}}</p>
              {{note}}
            </div>
            """;
    }
}
