using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Auth;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Application.Services;

namespace ProjectManagement.Application.Features.Vault;

/// <summary>The password plus either a two-step code (or recovery code) or a passkey assertion (a challenge from <c>step-up/passkey/options</c>).</summary>
public record RevealStepUpRequest(string? Password, string? Code = null, Guid? ChallengeId = null, JsonElement? Response = null);

/// <summary>
/// The vault is copy-only by default. Showing a value on screen needs both something the person knows (the account password, checked with the
/// same hasher as sign-in) and something they have (a current authenticator code through <see cref="MfaService"/>, or one of their passkeys).
/// Both pass: a reveal grant for a few minutes, bound to the person and this workspace. Every failure is written to the audit trail and counts
/// towards the normal account lockout.
/// </summary>
public class RevealStepUpService(IAppDbContext db, ICurrentContext ctx, AppClock clock, IPasswordHasher hasher, MfaService mfa, PasskeyService passkeys,
    StepUpService stepUp, Recorder recorder)
{
    public async Task<StepUpDto> VerifyAsync(RevealStepUpRequest req, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        ctx.RequireTenantId();
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == me, ct) ?? throw new NotFoundException("User not found.");
        if (user.LockoutEnd is { } end && end > clock.Now)
            throw new TooManyRequestsException("Too many failed attempts. Try again later.", "ACCOUNT_LOCKED");

        var hasPasskey = await db.PasskeyCredentials.AsNoTracking().AnyAsync(p => p.UserId == me, ct);
        if (!user.MfaEnabled && !hasPasskey)
            throw new ConflictException("Turn on two-step verification or add a passkey to reveal values.", "REVEAL_SECOND_FACTOR_MISSING");

        if (string.IsNullOrEmpty(req.Password) || !hasher.Verify(user.PasswordHash, req.Password))
        {
            await FailedAsync(me, "password", ct);
            await mfa.RegisterFailureAsync(user, "password", ct);
            throw new ValidationException("password", "That password is not correct.");
        }

        if (req.ChallengeId is { } challenge && req.Response is { } response)
        {
            try { await passkeys.FinishStepUpAsync(new PasskeyFinishRequest(challenge, response), ct); }
            catch (AppException)
            {
                await FailedAsync(me, "passkey", ct);
                throw;
            }
            return await stepUp.IssueRevealAsync("passkey", ct);
        }

        if (string.IsNullOrWhiteSpace(req.Code))
        {
            await FailedAsync(me, "second factor missing", ct);
            throw new ForbiddenException("Your password is right. Now confirm with a two-step code or a passkey.", "REVEAL_SECOND_FACTOR_REQUIRED");
        }
        if (!user.MfaEnabled || !await mfa.VerifyCodeAsync(user, req.Code, ct))
        {
            await FailedAsync(me, "code", ct);
            await mfa.RegisterFailureAsync(user, "code", ct);
            throw new ValidationException("code", "That code is not correct.");
        }
        return await stepUp.IssueRevealAsync("code", ct);
    }

    private async Task FailedAsync(Guid me, string what, CancellationToken ct)
    {
        recorder.Audit("vault.reveal_verify_failed", "User", me, null, new { failed = what });
        await db.SaveChangesAsync(ct);
    }
}
