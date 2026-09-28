using System.Net;
using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Auth;

public record MfaStatusDto(bool Enabled, DateTime? EnabledAt, int RecoveryCodesLeft);
public record MfaSetupRequest(string Password);
public record MfaSetupDto(string Secret, string OtpAuthUri);
public record MfaEnableRequest(string Code);
public record MfaConfirmRequest(string Password, string Code);
public record MfaRecoveryCodesDto(IReadOnlyList<string> Codes);
public record MfaLoginRequest(string Challenge, string Code);
/// <summary>Returned instead of a session when the password was right but a second step is still needed.</summary>
public record MfaChallengeDto(bool MfaRequired, string Challenge);

/// <summary>
/// Two-step verification with an authenticator app (TOTP) and one-time recovery codes. Secrets are encrypted at rest, codes cannot be
/// replayed, and wrong codes count towards the same account lockout as wrong passwords.
/// </summary>
public class MfaService(IAppDbContext db, ICurrentContext ctx, IPasswordHasher hasher, ISecretProtector protector, AppClock clock,
    Recorder recorder, SecurityAlerts alerts, IOptions<AppOptions> options)
{
    private const int RecoveryCodeCount = 10;
    private readonly AppOptions _opt = options.Value;

    // ---------------------------------------------------------------- helpers

    private async Task<User> CurrentUserAsync(CancellationToken ct) =>
        await db.Users.FirstAsync(u => u.Id == ctx.RequireUserId(), ct);

    /// <summary>Password prompts inside the app are brute-force targets too, so failures feed the normal lockout counter.</summary>
    private async Task RequirePasswordAsync(User user, string password, CancellationToken ct)
    {
        if (user.LockoutEnd is { } end && end > clock.Now)
            throw new TooManyRequestsException("Too many failed attempts. Try again later.", "ACCOUNT_LOCKED");
        if (hasher.Verify(user.PasswordHash, password)) return;
        await RegisterFailureAsync(user, "password", ct);
        throw new ValidationException("password", "That password is not correct.");
    }

    /// <summary>Counts a failed attempt and locks the account after too many. Saves.</summary>
    public async Task RegisterFailureAsync(User user, string what, CancellationToken ct)
    {
        if (++user.FailedLoginCount >= _opt.MaxFailedLogins)
        {
            user.LockoutEnd = clock.Now.AddMinutes(_opt.LockoutMinutes);
            user.FailedLoginCount = 0;
            recorder.Audit("user.locked_out", "User", user.Id, newValue: new { Reason = $"wrong {what}" }, userId: user.Id);
        }
        await db.SaveChangesAsync(ct);
    }

    private static string Normalize(string code) => code.Replace(" ", "").Replace("-", "").Trim().ToUpperInvariant();
    private static string HashCode(string normalized) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(normalized))).ToLowerInvariant();

    private async Task<IReadOnlyList<string>> IssueRecoveryCodesAsync(User user, CancellationToken ct)
    {
        db.MfaRecoveryCodes.RemoveRange(await db.MfaRecoveryCodes.Where(c => c.UserId == user.Id).ToListAsync(ct));
        var codes = new List<string>();
        for (var i = 0; i < RecoveryCodeCount; i++)
        {
            var raw = Totp.Base32Encode(RandomNumberGenerator.GetBytes(7))[..10]; // 50 bits of randomness
            codes.Add($"{raw[..5]}-{raw[5..]}");
            db.MfaRecoveryCodes.Add(new MfaRecoveryCode { UserId = user.Id, CodeHash = HashCode(raw), CreatedAt = clock.Now });
        }
        return codes;
    }

    /// <summary>True for a valid authenticator code (once per time step) or an unused recovery code (once).</summary>
    public async Task<bool> VerifyCodeAsync(User user, string code, CancellationToken ct)
    {
        if (user.MfaSecret is null) return false;
        var normalized = Normalize(code);
        if (normalized.Length == Totp.Digits)
        {
            if (!Totp.TryVerify(protector.Unprotect(user.MfaSecret), normalized, clock.Now, user.MfaLastStep, out var step)) return false;
            user.MfaLastStep = step;
            return true;
        }
        if (normalized.Length != 10) return false;
        var hash = HashCode(normalized);
        var row = await db.MfaRecoveryCodes.FirstOrDefaultAsync(c => c.UserId == user.Id && c.CodeHash == hash && c.UsedAt == null, ct);
        if (row is null) return false;
        row.UsedAt = clock.Now;
        recorder.Audit("user.mfa_recovery_code_used", "User", user.Id, userId: user.Id);
        return true;
    }

    // ---------------------------------------------------------------- self service

    public async Task<MfaStatusDto> GetStatusAsync(CancellationToken ct = default)
    {
        var user = await CurrentUserAsync(ct);
        return new MfaStatusDto(user.MfaEnabled, user.MfaEnabledAt, await db.MfaRecoveryCodes.CountAsync(c => c.UserId == user.Id && c.UsedAt == null, ct));
    }

    /// <summary>Step 1: after the password, hand out a new secret (shown as a QR code). It is not active until step 2 succeeds.</summary>
    public async Task<MfaSetupDto> BeginSetupAsync(MfaSetupRequest req, CancellationToken ct = default)
    {
        var user = await CurrentUserAsync(ct);
        if (user.MfaEnabled) throw new ConflictException("Two-step verification is already on. Turn it off first to set it up again.", "MFA_ALREADY_ENABLED");
        await RequirePasswordAsync(user, req.Password, ct);

        var secret = Totp.NewSecret();
        user.MfaPendingSecret = protector.Protect(secret);
        await db.SaveChangesAsync(ct);
        return new MfaSetupDto(string.Join(' ', Enumerable.Range(0, (secret.Length + 3) / 4).Select(i => secret.Substring(i * 4, Math.Min(4, secret.Length - i * 4)))),
            Totp.OtpAuthUri("Project Management", user.Email, secret));
    }

    /// <summary>Step 2: the person types the code their app shows. That proves the app has the secret; only then is it switched on.</summary>
    public async Task<MfaRecoveryCodesDto> EnableAsync(MfaEnableRequest req, CancellationToken ct = default)
    {
        var user = await CurrentUserAsync(ct);
        if (user.MfaEnabled) throw new ConflictException("Two-step verification is already on.", "MFA_ALREADY_ENABLED");
        if (user.MfaPendingSecret is null) throw new ConflictException("Start the setup first.", "MFA_SETUP_NOT_STARTED");
        if (user.LockoutEnd is { } end && end > clock.Now) throw new TooManyRequestsException("Too many failed attempts. Try again later.", "ACCOUNT_LOCKED");

        if (!Totp.TryVerify(protector.Unprotect(user.MfaPendingSecret), Normalize(req.Code), clock.Now, 0, out var step))
        {
            await RegisterFailureAsync(user, "code", ct);
            throw new ValidationException("code", "That code is not correct. Check the code in your app and try again.");
        }

        user.MfaSecret = user.MfaPendingSecret;
        user.MfaPendingSecret = null;
        user.MfaLastStep = step;
        user.MfaEnabled = true;
        user.MfaEnabledAt = clock.Now;
        var codes = await IssueRecoveryCodesAsync(user, ct);
        recorder.Audit("user.mfa_enabled", "User", user.Id);
        await alerts.SendAsync(user, "Two-step verification was turned on", "An authenticator app is now required when you sign in. Keep your recovery codes somewhere safe.", ct);
        await db.SaveChangesAsync(ct);
        return new MfaRecoveryCodesDto(codes);
    }

    private async Task<User> RequireStrongProofAsync(MfaConfirmRequest req, CancellationToken ct)
    {
        var user = await CurrentUserAsync(ct);
        if (!user.MfaEnabled) throw new ConflictException("Two-step verification is not on.", "MFA_NOT_ENABLED");
        await RequirePasswordAsync(user, req.Password, ct);
        if (!await VerifyCodeAsync(user, req.Code, ct))
        {
            await RegisterFailureAsync(user, "code", ct);
            throw new ValidationException("code", "That code is not correct.");
        }
        return user;
    }

    /// <summary>Turning it off needs both the password and a current code, so a stolen session alone cannot remove the protection.</summary>
    public async Task DisableAsync(MfaConfirmRequest req, CancellationToken ct = default)
    {
        var user = await RequireStrongProofAsync(req, ct);
        Clear(user);
        db.MfaRecoveryCodes.RemoveRange(await db.MfaRecoveryCodes.Where(c => c.UserId == user.Id).ToListAsync(ct));
        recorder.Audit("user.mfa_disabled", "User", user.Id);
        await alerts.SendAsync(user, "Two-step verification was turned off", "Your account is now protected by your password only. If this was not you, change your password immediately.", ct);
        await db.SaveChangesAsync(ct);
    }

    public async Task<MfaRecoveryCodesDto> RegenerateRecoveryCodesAsync(MfaConfirmRequest req, CancellationToken ct = default)
    {
        var user = await RequireStrongProofAsync(req, ct);
        var codes = await IssueRecoveryCodesAsync(user, ct);
        recorder.Audit("user.mfa_recovery_regenerated", "User", user.Id);
        await alerts.SendAsync(user, "New recovery codes were generated", "Your previous recovery codes no longer work.", ct);
        await db.SaveChangesAsync(ct);
        return new MfaRecoveryCodesDto(codes);
    }

    public static void Clear(User user)
    {
        user.MfaEnabled = false;
        user.MfaEnabledAt = null;
        user.MfaSecret = null;
        user.MfaPendingSecret = null;
        user.MfaLastStep = 0;
    }
}
