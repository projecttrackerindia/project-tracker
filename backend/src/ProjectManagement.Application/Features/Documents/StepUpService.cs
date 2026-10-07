using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Services;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Auth;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Documents;

/// <summary>
/// A fresh two-step check (authenticator or recovery code) that unlocks confidential values for a few minutes. The token is random, stored only as a hash,
/// belongs to one person and is refused after it expires.
/// </summary>
public class StepUpService(IAppDbContext db, ICurrentContext ctx, AppClock clock, MfaService mfa, Recorder recorder)
{
    public const int Minutes = 5;

    private static string Hash(string token) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));

    public async Task<StepUpDto> VerifyAsync(StepUpRequest req, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == me, ct) ?? throw new NotFoundException("User not found.");
        if (!user.MfaEnabled) throw new ConflictException("Turn on two-step verification in your account security first. Confidential values need it.", "MFA_NOT_ENABLED");
        if (!await mfa.VerifyCodeAsync(user, req.Code ?? "", ct))
        {
            await mfa.RegisterFailureAsync(user, "code", ct);
            throw new ValidationException("code", "That code is not correct.");
        }
        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
        var expires = clock.Now.AddMinutes(Minutes);
        db.StepUpGrants.RemoveRange(await db.StepUpGrants.Where(g => g.UserId == me && g.ExpiresAt < clock.Now).ToListAsync(ct));
        db.StepUpGrants.Add(new StepUpGrant { UserId = me, TokenHash = Hash(token), ExpiresAt = expires });
        recorder.Audit("user.step_up", "User", me, null, new { minutes = Minutes });
        await db.SaveChangesAsync(ct);
        return new StepUpDto(token, expires);
    }

    public async Task<bool> IsFreshAsync(Guid userId, string? token, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(token)) return false;
        var h = Hash(token.Trim());
        return await db.StepUpGrants.AsNoTracking().AnyAsync(g => g.TokenHash == h && g.UserId == userId && g.ExpiresAt > clock.Now, ct);
    }
}
