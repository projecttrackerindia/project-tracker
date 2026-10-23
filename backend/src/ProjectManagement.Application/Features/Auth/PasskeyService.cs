using System.Text.Json;
using Fido2NetLib;
using Fido2NetLib.Objects;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Auth;

public record PasskeyDto(Guid Id, string Name, DateTime CreatedAt, DateTime? LastUsedAt, bool BackedUp);
public record PasskeyOptionsDto(Guid ChallengeId, JsonElement Options);
public record PasskeyLoginOptionsRequest(string? Email);
public record PasskeyFinishRequest(Guid ChallengeId, JsonElement Response, string? Name = null);

/// <summary>
/// Passkeys: sign in with the phone's or laptop's own fingerprint, face or screen lock instead of a password. The device keeps a private key that never
/// leaves it; the server keeps the public half and checks a signature over a fresh challenge, bound to this site's address (so a look-alike site gets
/// nothing). It is two factors in one (the device and the person's unlock), so it also satisfies a workspace's two-step rule. Available on every plan:
/// it is safety, not a feature to sell.
/// </summary>
public class PasskeyService(IAppDbContext db, ICurrentContext ctx, AppClock clock, IOptions<AppOptions> app, IConfiguration config, AuthService auth, Recorder recorder, ProjectManagement.Application.Features.Notifications.SecurityAlerts alerts)
{
    private static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(5);
    private const int MaxPasskeys = 10;

    /// <summary>The relying party: the site's own domain, and the addresses its pages are served from. Settings Passkeys:RpId and Passkeys:Origins override them.</summary>
    private Fido2 Relying()
    {
        var web = new Uri(app.Value.WebBaseUrl);
        var origins = config.GetSection("Passkeys:Origins").Get<string[]>() is { Length: > 0 } o ? o : [web.GetLeftPart(UriPartial.Authority)];
        return new Fido2(new Fido2Configuration { RPID = config["Passkeys:RpId"] ?? web.Host, RPName = "Project Tracker", Origins = new HashSet<string>(origins) });
    }

    // ------------------------------------------------------------------ add a passkey (signed in)

    public async Task<IReadOnlyList<PasskeyDto>> ListAsync(CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var rows = await db.PasskeyCredentials.AsNoTracking().Where(p => p.UserId == uid).OrderBy(p => p.CreatedAt).ToListAsync(ct);
        return rows.Select(p => new PasskeyDto(p.Id, p.Name, p.CreatedAt, p.LastUsedAt, p.BackedUp)).ToList();
    }

    public async Task<PasskeyOptionsDto> BeginRegistrationAsync(CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var user = await db.Users.AsNoTracking().FirstAsync(u => u.Id == uid, ct);
        var existing = await db.PasskeyCredentials.AsNoTracking().Where(p => p.UserId == uid).ToListAsync(ct);
        if (existing.Count >= MaxPasskeys) throw new ValidationException("passkey", $"You can keep up to {MaxPasskeys} passkeys. Remove one first.");
        var handle = existing.FirstOrDefault()?.UserHandle ?? uid.ToByteArray();
        var options = Relying().RequestNewCredential(new RequestNewCredentialParams
        {
            User = new Fido2User { Id = handle, Name = user.Email, DisplayName = user.DisplayName },
            ExcludeCredentials = existing.Select(p => new PublicKeyCredentialDescriptor(B64.Decode(p.CredentialId))).ToList(),
            AuthenticatorSelection = new AuthenticatorSelection { ResidentKey = ResidentKeyRequirement.Required, UserVerification = UserVerificationRequirement.Required },
            AttestationPreference = AttestationConveyancePreference.None,
        });
        return await StoreAsync(uid, "register", options.ToJson(), ct);
    }

    public async Task<PasskeyDto> FinishRegistrationAsync(PasskeyFinishRequest req, CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var challenge = await TakeAsync(req.ChallengeId, "register", uid, ct);
        var options = CredentialCreateOptions.FromJson(challenge.OptionsJson);
        var attestation = JsonSerializer.Deserialize<AuthenticatorAttestationRawResponse>(req.Response.GetRawText()) ?? throw new ValidationException("passkey", "The device sent nothing.");
        RegisteredPublicKeyCredential made;
        try
        {
            made = await Relying().MakeNewCredentialAsync(new MakeNewCredentialParams
            {
                AttestationResponse = attestation, OriginalOptions = options,
                IsCredentialIdUniqueToUserCallback = async (args, token) => !await db.PasskeyCredentials.AnyAsync(p => p.CredentialId == B64.Encode(args.CredentialId), token),
            }, ct);
        }
        catch (Fido2VerificationException) { throw new ValidationException("passkey", "This passkey could not be verified. Try again."); }

        var row = new PasskeyCredential
        {
            UserId = uid, CredentialId = B64.Encode(made.Id), PublicKey = made.PublicKey, UserHandle = options.User.Id, SignCount = made.SignCount,
            Name = Text.Truncate(string.IsNullOrWhiteSpace(req.Name) ? "Passkey" : req.Name.Trim(), 80)!, AaGuid = made.AaGuid, BackedUp = made.IsBackedUp, CreatedAt = clock.Now,
        };
        db.PasskeyCredentials.Add(row);
        recorder.Audit("user.passkey_added", "User", uid, newValue: new { row.Name }, userId: uid);
        await db.SaveChangesAsync(ct);
        var owner = await db.Users.FirstAsync(u => u.Id == uid, ct);
        await alerts.SendAsync(owner, "A passkey was added to your account", $"“{row.Name}” can now sign in to your account. If this was not you, remove it under Account → Sign-in & security and sign out everywhere.", ct);
        return new PasskeyDto(row.Id, row.Name, row.CreatedAt, null, row.BackedUp);
    }

    public async Task RenameAsync(Guid id, string name, CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var row = await db.PasskeyCredentials.FirstOrDefaultAsync(p => p.Id == id && p.UserId == uid, ct) ?? throw new NotFoundException("That passkey is no longer there.");
        name = Text.Truncate(name?.Trim() ?? "", 80) ?? "";
        if (name.Length == 0) throw new ValidationException("name", "Give the passkey a name.");
        row.Name = name;
        await db.SaveChangesAsync(ct);
    }

    public async Task RemoveAsync(Guid id, CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var row = await db.PasskeyCredentials.FirstOrDefaultAsync(p => p.Id == id && p.UserId == uid, ct) ?? throw new NotFoundException("That passkey is no longer there.");
        db.PasskeyCredentials.Remove(row);
        recorder.Audit("user.passkey_removed", "User", uid, oldValue: new { row.Name }, userId: uid);
        await db.SaveChangesAsync(ct);
        var owner = await db.Users.FirstAsync(u => u.Id == uid, ct);
        await alerts.SendAsync(owner, "A passkey was removed from your account", $"“{row.Name}” can no longer sign in. If this was not you, change your password and sign out everywhere.", ct);
    }

    // ------------------------------------------------------------------ sign in (anonymous)

    /// <summary>
    /// The device picks from the passkeys it holds for this site (discoverable credentials). The answer never lists an account's credentials, whatever
    /// email was typed, so it reveals nothing about who has an account or a passkey. The email is accepted for compatibility and ignored.
    /// </summary>
    public async Task<PasskeyOptionsDto> BeginSignInAsync(PasskeyLoginOptionsRequest req, CancellationToken ct = default)
    {
        _ = req;
        var allowed = new List<PublicKeyCredentialDescriptor>();
        var options = Relying().GetAssertionOptions(new GetAssertionOptionsParams { AllowedCredentials = allowed, UserVerification = UserVerificationRequirement.Required });
        return await StoreAsync(null, "login", options.ToJson(), ct);
    }

    public async Task<AuthResult> FinishSignInAsync(PasskeyFinishRequest req, CancellationToken ct = default)
    {
        var challenge = await TakeAsync(req.ChallengeId, "login", null, ct);
        var options = AssertionOptions.FromJson(challenge.OptionsJson);
        var assertion = JsonSerializer.Deserialize<AuthenticatorAssertionRawResponse>(req.Response.GetRawText()) ?? throw new ValidationException("passkey", "The device sent nothing.");
        var credentialId = B64.Encode(assertion.RawId);
        var stored = await db.PasskeyCredentials.FirstOrDefaultAsync(p => p.CredentialId == credentialId, ct);
        var user = stored is null ? null : await db.Users.FirstOrDefaultAsync(u => u.Id == stored.UserId && u.IsActive, ct);
        if (stored is null || user is null || (user.LockoutEnd is { } l && l > clock.Now)) throw new UnauthorizedException("This passkey is not recognized.");
        if (!user.EmailVerified && app.Value.RequireEmailVerification) throw new UnauthorizedException("This passkey is not recognized.");
        try
        {
            var result = await Relying().MakeAssertionAsync(new MakeAssertionParams
            {
                AssertionResponse = assertion, OriginalOptions = options, StoredPublicKey = stored.PublicKey, StoredSignatureCounter = (uint)stored.SignCount,
                IsUserHandleOwnerOfCredentialIdCallback = (args, token) => Task.FromResult(args.UserHandle is null || args.UserHandle.AsSpan().SequenceEqual(stored.UserHandle)),
            }, ct);
            stored.SignCount = result.SignCount;
        }
        catch (Fido2VerificationException) { throw new UnauthorizedException("This passkey could not be verified."); }
        stored.LastUsedAt = clock.Now;
        return await auth.SignInExternalAsync(user, "passkey", null, null, ct);
    }

    // ------------------------------------------------------------------ a fresh check with a passkey (instead of an authenticator code)

    /// <summary>A challenge only this person's passkeys can answer (for a fresh check before sensitive steps, such as the vault's).</summary>
    public async Task<PasskeyOptionsDto> BeginStepUpAsync(CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var creds = await db.PasskeyCredentials.AsNoTracking().Where(p => p.UserId == me).Select(p => p.CredentialId).ToListAsync(ct);
        if (creds.Count == 0) throw new ConflictException("Add a passkey to your account first (My account → Security).", "NO_PASSKEY");
        var options = Relying().GetAssertionOptions(new GetAssertionOptionsParams
        {
            AllowedCredentials = creds.Select(c => new PublicKeyCredentialDescriptor(B64.Decode(c))).ToList(), UserVerification = UserVerificationRequirement.Required,
        });
        return await StoreAsync(me, "step-up", options.ToJson(), ct);
    }

    /// <summary>Checks the answer: one of this person's own passkeys, with their fingerprint, face or PIN (user verification), once.</summary>
    public async Task FinishStepUpAsync(PasskeyFinishRequest req, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var challenge = await TakeAsync(req.ChallengeId, "step-up", me, ct);
        var options = AssertionOptions.FromJson(challenge.OptionsJson);
        var assertion = JsonSerializer.Deserialize<AuthenticatorAssertionRawResponse>(req.Response.GetRawText()) ?? throw new ValidationException("passkey", "The device sent nothing.");
        var credentialId = B64.Encode(assertion.RawId);
        var stored = await db.PasskeyCredentials.FirstOrDefaultAsync(p => p.CredentialId == credentialId && p.UserId == me, ct)
            ?? throw new ForbiddenException("That passkey is not one of yours.", "PASSKEY_NOT_YOURS");
        try
        {
            var result = await Relying().MakeAssertionAsync(new MakeAssertionParams
            {
                AssertionResponse = assertion, OriginalOptions = options, StoredPublicKey = stored.PublicKey, StoredSignatureCounter = (uint)stored.SignCount,
                IsUserHandleOwnerOfCredentialIdCallback = (args, token) => Task.FromResult(args.UserHandle is null || args.UserHandle.AsSpan().SequenceEqual(stored.UserHandle)),
            }, ct);
            stored.SignCount = result.SignCount;
        }
        catch (Fido2VerificationException) { throw new ForbiddenException("This passkey could not be verified.", "PASSKEY_INVALID"); }
        stored.LastUsedAt = clock.Now;
        await db.SaveChangesAsync(ct);
    }

    // ------------------------------------------------------------------ challenges

    private async Task<PasskeyOptionsDto> StoreAsync(Guid? userId, string purpose, string json, CancellationToken ct)
    {
        var now = clock.Now;
        var row = new PasskeyChallenge { UserId = userId, Purpose = purpose, OptionsJson = json, CreatedAt = now };
        db.PasskeyChallenges.Add(row);
        await db.PasskeyChallenges.Where(c => c.CreatedAt < now - Lifetime).ExecuteDeleteAsync(ct);   // forgotten as new ones arrive
        await db.SaveChangesAsync(ct);
        return new PasskeyOptionsDto(row.Id, JsonDocument.Parse(json).RootElement.Clone());
    }

    /// <summary>The challenge for this answer, removed in the same step: a signed answer can be used once.</summary>
    private async Task<PasskeyChallenge> TakeAsync(Guid id, string purpose, Guid? userId, CancellationToken ct)
    {
        var row = await db.PasskeyChallenges.FirstOrDefaultAsync(c => c.Id == id && c.Purpose == purpose && c.UserId == userId, ct);
        if (row is null || row.CreatedAt < clock.Now - Lifetime) throw new ValidationException("passkey", "This request has expired. Try again.");
        var removed = await db.PasskeyChallenges.Where(c => c.Id == id).ExecuteDeleteAsync(ct);
        if (removed == 0) throw new ValidationException("passkey", "This request has expired. Try again.");
        return row;
    }
}

internal static class B64
{
    public static string Encode(byte[] bytes) => System.Buffers.Text.Base64Url.EncodeToString(bytes);
    public static byte[] Decode(string text) => System.Buffers.Text.Base64Url.DecodeFromChars(text);
}
