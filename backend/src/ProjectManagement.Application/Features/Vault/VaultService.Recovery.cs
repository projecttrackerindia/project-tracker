using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Vault;

public record VaultRecoveryShareInput(Guid TrusteeUserId, int TrusteeGeneration, string? Envelope, string? Signature);
public record VaultRecoveryCircleRequest(int Threshold, IReadOnlyList<VaultRecoveryShareInput>? Shares, string? StepUp);
public record VaultCircleMemberDto(UserRefDto Person, bool Stale);
public record VaultRecoveryCircleDto(int Threshold, IReadOnlyList<VaultCircleMemberDto> Members, DateTime CreatedAt, bool Usable);
public record VaultRecoveryReleaseDto(UserRefDto Trustee, string? TrusteeEd25519Public, string? Envelope, string? Signature, bool Refused, DateTime At);
public record VaultRecoveryStatusDto(Guid Id, int Threshold, int Helpers, DateTime CreatedAt, DateTime ExpiresAt, bool Completed, bool Cancelled, IReadOnlyList<VaultRecoveryReleaseDto> Releases);
public record VaultRecoveryToHelpDto(Guid RequestId, UserRefDto Person, string X25519Public, string MlKemPublic, DateTime CreatedAt, DateTime ExpiresAt, string? IpAddress, string? UserAgent,
    string ShareEnvelope, string ShareSignature, string OwnerEd25519Public, int OwnerGeneration, int Threshold);

/// <summary>
/// The recovery circle for the sealed vault. The browser splits the identity secret among 2–7 colleagues (any 2–7 of them can give it back)
/// and encrypts each share to that colleague's own keys; the server only keeps those envelopes. Someone who lost every passkey and their
/// recovery key asks from a new browser; each colleague compares a code with them by phone or in person, then re-encrypts their share to that
/// browser's one-time keys. Nothing the server holds, or sees pass through, is enough to open anything.
/// </summary>
public partial class VaultService
{
    public const int MaxCircle = 7, RecoveryHours = 24, RecoveryStartsPerDay = 3;

    private async Task<VaultIdentity> MyIdentityAsync(CancellationToken ct)
    {
        var (_, me) = Who();
        return await db.VaultIdentities.FirstOrDefaultAsync(i => i.UserId == me, ct) ?? throw new ConflictException("Set up your vault keys first.", "VAULT_NO_KEYS");
    }

    public async Task<VaultRecoveryCircleDto?> RecoveryCircleAsync(CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (_, me) = Who();
        return await CircleOfAsync(me, ct);
    }

    private async Task<VaultRecoveryCircleDto?> CircleOfAsync(Guid owner, CancellationToken ct)
    {
        var shares = await db.VaultRecoveryShares.AsNoTracking().Where(s => s.UserId == owner).ToListAsync(ct);
        if (shares.Count == 0) return null;
        var mine = await db.VaultIdentities.AsNoTracking().Where(i => i.UserId == owner).Select(i => (int?)i.Generation).FirstOrDefaultAsync(ct);
        var ids = shares.Select(s => s.TrusteeUserId).ToList();
        var gens = await db.VaultIdentities.AsNoTracking().Where(i => ids.Contains(i.UserId)).ToDictionaryAsync(i => i.UserId, i => i.Generation, ct);
        var names = await db.Users.AsNoTracking().Where(u => ids.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        var members = shares.OrderBy(s => names.GetValueOrDefault(s.TrusteeUserId)).Select(s => new VaultCircleMemberDto(
            new UserRefDto(s.TrusteeUserId, names.GetValueOrDefault(s.TrusteeUserId) ?? "Former member"),
            s.Generation != mine || !gens.TryGetValue(s.TrusteeUserId, out var g) || g != s.TrusteeGeneration)).ToList();
        var threshold = shares[0].Threshold;
        return new VaultRecoveryCircleDto(threshold, members, shares.Min(s => s.CreatedAt), members.Count(m => !m.Stale) >= threshold);
    }

    /// <summary>Sets (or replaces) the circle. Needs a fresh two-step check: it decides who could, together, open this person's vault.</summary>
    public async Task<VaultRecoveryCircleDto> SetRecoveryCircleAsync(VaultRecoveryCircleRequest req, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (tid, me) = Who();
        var identity = await MyIdentityAsync(ct);
        if (!await stepUp.IsFreshAsync(me, req.StepUp, ct))
            throw new ForbiddenException("Confirm it is you first: the people in your circle could, together, open your vault.", "STEP_UP_REQUIRED");
        var shares = (req.Shares ?? []).ToList();
        if (shares.Count < 2 || shares.Count > MaxCircle) throw new ValidationException("shares", $"Choose 2 to {MaxCircle} people.");
        if (req.Threshold < 2 || req.Threshold > shares.Count) throw new ValidationException("threshold", "How many of them must help: at least 2, at most everyone in the circle.");
        var ids = shares.Select(s => s.TrusteeUserId).ToList();
        if (ids.Distinct().Count() != ids.Count || ids.Contains(me)) throw new ValidationException("shares", "Each person once, and not yourself.");
        var members = await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid && ids.Contains(m.UserId) && m.Role != TenantRole.Guest).Select(m => m.UserId).ToListAsync(ct);
        if (members.Count != ids.Count) throw new ValidationException("shares", "Everyone in the circle must be a member of this workspace (not a guest).");
        var keys = await db.VaultIdentities.AsNoTracking().Where(i => ids.Contains(i.UserId)).ToDictionaryAsync(i => i.UserId, i => i.Generation, ct);
        foreach (var s in shares)
            if (!keys.TryGetValue(s.TrusteeUserId, out var g) || g != s.TrusteeGeneration)
                throw new ConflictException("Someone in the circle has no vault keys yet, or just changed them. Reload and try again.", "VAULT_CIRCLE_KEYS");

        db.VaultRecoveryShares.RemoveRange(await db.VaultRecoveryShares.Where(s => s.UserId == me).ToListAsync(ct));
        foreach (var s in shares)
            db.VaultRecoveryShares.Add(new VaultRecoveryShare
            {
                TenantId = tid, UserId = me, TrusteeUserId = s.TrusteeUserId, Threshold = req.Threshold, Generation = identity.Generation, TrusteeGeneration = s.TrusteeGeneration,
                Envelope = B64(s.Envelope, "envelope", 4000, 1500), Signature = B64(s.Signature, "signature", 120, 80), CreatedAt = clock.Now, CreatedBy = me,
            });
        recorder.Audit("vault.recovery_circle_set", "User", me, null, new { threshold = req.Threshold, people = shares.Count });
        var name = await NameAsync(me, ct);
        var day = $"vault-circle:{me}:";
        var stamp = $":{clock.Now:yyyyMMdd}";
        var told = (await db.Notifications.AsNoTracking().Where(n => n.DedupeKey != null && n.DedupeKey.StartsWith(day) && n.DedupeKey.EndsWith(stamp)).Select(n => n.UserId).ToListAsync(ct)).ToHashSet();
        foreach (var t in ids.Where(t => !told.Contains(t)))
            await notifications.AddAsync(t, NotificationType.Security, $"{name} added you to their vault recovery circle",
                $"If they ever lose every way to unlock, {req.Threshold} of the {shares.Count} people in it can help them back in. Only help after you have spoken to them.", "/vault?view=keys",
                dedupeKey: $"vault-circle:{me}:{t}:{clock.Now:yyyyMMdd}", ct: ct);
        await db.SaveChangesAsync(ct);
        return (await CircleOfAsync(me, ct))!;
    }

    public async Task ClearRecoveryCircleAsync(CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (_, me) = Who();
        var rows = await db.VaultRecoveryShares.Where(s => s.UserId == me).ToListAsync(ct);
        if (rows.Count == 0) return;
        db.VaultRecoveryShares.RemoveRange(rows);
        recorder.Audit("vault.recovery_circle_cleared", "User", me, null, new { people = rows.Count });
        await db.SaveChangesAsync(ct);
    }

    // ------------------------------------------------------------------ asking for help

    /// <summary>From a browser that cannot unlock: ask the circle. Everyone in it is told, and so is the person (on every device), in case it was not them.</summary>
    public async Task<VaultRecoveryStatusDto> StartRecoveryAsync(VaultDeviceLinkRequest req, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (tid, me) = Who();
        await MyIdentityAsync(ct);
        var circle = await CircleOfAsync(me, ct) ?? throw new ConflictException("You have no recovery circle. Use your recovery key, or ask an admin to reset your vault keys.", "VAULT_NO_CIRCLE");
        if (!circle.Usable) throw new ConflictException("Too many people in your circle changed their keys or left: it can no longer give your key back.", "VAULT_CIRCLE_STALE");
        var day = clock.Now.AddDays(-1);
        if (await db.VaultRecoveryRequests.CountAsync(r => r.UserId == me && r.CreatedAt > day, ct) >= RecoveryStartsPerDay)
            throw new TooManyRequestsException("You asked your circle several times today. Wait for their answers.", "VAULT_LIMITED");
        foreach (var old in await db.VaultRecoveryRequests.Where(r => r.UserId == me && r.CompletedAt == null && !r.Cancelled && r.ExpiresAt > clock.Now).ToListAsync(ct))
            old.Cancelled = true;
        var r = new VaultRecoveryRequest
        {
            TenantId = tid, UserId = me, X25519Public = B64(req.X25519Public, "x25519Public", 64, 40), MlKemPublic = B64(req.MlKemPublic, "mlKemPublic", 2000, 1500),
            ExpiresAt = clock.Now.AddHours(RecoveryHours), IpAddress = Clip(ctx.IpAddress, 64), UserAgent = Clip(ctx.UserAgent, 300), CreatedAt = clock.Now, CreatedBy = me,
        };
        db.VaultRecoveryRequests.Add(r);
        recorder.Audit("vault.recovery_requested", "User", me, null, new { threshold = circle.Threshold, ip = r.IpAddress });
        var name = await NameAsync(me, ct);
        foreach (var m in circle.Members.Where(m => !m.Stale))
            await notifications.AddAsync(m.Person.Id, NotificationType.Security, $"{name} asks you to help unlock their vault",
                "Call them or see them in person and compare the 8-digit code before you help. Never help on a message alone.", $"/vault?view=keys&help={r.Id}", dedupeKey: $"vault-recover:{r.Id}:{m.Person.Id}", ct: ct);
        await notifications.AddAsync(me, NotificationType.Security, "Your vault recovery circle was asked for help",
            $"From {(r.IpAddress is { } ip ? ip : "a browser")}. If this was not you, cancel it in the vault and change your password.", "/vault?view=keys", dedupeKey: $"vault-recover-self:{r.Id}", toSelf: true, ct: ct);
        await db.SaveChangesAsync(ct);
        return await StatusDtoAsync(r, circle.Threshold, ct);
    }

    private async Task<VaultRecoveryStatusDto> StatusDtoAsync(VaultRecoveryRequest r, int threshold, CancellationToken ct)
    {
        var releases = await db.VaultRecoveryReleases.AsNoTracking().Where(x => x.RequestId == r.Id).OrderBy(x => x.CreatedAt).ToListAsync(ct);
        var ids = releases.Select(x => x.TrusteeUserId).ToList();
        var names = await db.Users.AsNoTracking().Where(u => ids.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        var eds = await db.VaultIdentities.AsNoTracking().Where(i => ids.Contains(i.UserId)).ToDictionaryAsync(i => i.UserId, i => i.Ed25519Public, ct);
        var helpers = await db.VaultRecoveryShares.CountAsync(s => s.UserId == r.UserId, ct);
        var open = r.CompletedAt == null && !r.Cancelled && r.ExpiresAt > clock.Now;
        return new VaultRecoveryStatusDto(r.Id, threshold, helpers, r.CreatedAt, r.ExpiresAt, r.CompletedAt != null, r.Cancelled,
            releases.Select(x => new VaultRecoveryReleaseDto(new UserRefDto(x.TrusteeUserId, names.GetValueOrDefault(x.TrusteeUserId) ?? "Former member"), eds.GetValueOrDefault(x.TrusteeUserId),
                open ? x.Envelope : null, open ? x.Signature : null, x.Refused, x.CreatedAt)).ToList());
    }

    /// <summary>The asking browser checks how many shares have come back (each encrypted to its one-time keys).</summary>
    public async Task<VaultRecoveryStatusDto> RecoveryStatusAsync(Guid id, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (_, me) = Who();
        var r = await db.VaultRecoveryRequests.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id && x.UserId == me, ct) ?? throw new NotFoundException("Not found.", "VAULT_NOT_FOUND");
        var threshold = await db.VaultRecoveryShares.Where(s => s.UserId == me).Select(s => (int?)s.Threshold).FirstOrDefaultAsync(ct) ?? 0;
        return await StatusDtoAsync(r, threshold, ct);
    }

    /// <summary>Done (unlocked) or given up: the shares that came back are destroyed either way.</summary>
    public async Task FinishRecoveryAsync(Guid id, bool recovered, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (_, me) = Who();
        var r = await db.VaultRecoveryRequests.FirstOrDefaultAsync(x => x.Id == id && x.UserId == me, ct) ?? throw new NotFoundException("Not found.", "VAULT_NOT_FOUND");
        if (r.CompletedAt != null || r.Cancelled) return;
        if (recovered) r.CompletedAt = clock.Now; else r.Cancelled = true;
        foreach (var x in await db.VaultRecoveryReleases.Where(x => x.RequestId == id).ToListAsync(ct)) { x.Envelope = null; x.Signature = null; }
        recorder.Audit(recovered ? "vault.recovered_by_circle" : "vault.recovery_cancelled", "User", me, null, new { request = id });
        await db.SaveChangesAsync(ct);
    }

    // ------------------------------------------------------------------ helping

    /// <summary>Requests from people whose share I hold (for my current keys), that I have not answered yet.</summary>
    public async Task<IReadOnlyList<VaultRecoveryToHelpDto>> RecoveryToHelpAsync(CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (_, me) = Who();
        var myGen = await db.VaultIdentities.AsNoTracking().Where(i => i.UserId == me).Select(i => (int?)i.Generation).FirstOrDefaultAsync(ct);
        if (myGen is null) return [];
        var held = await db.VaultRecoveryShares.AsNoTracking().Where(s => s.TrusteeUserId == me && s.TrusteeGeneration == myGen).ToListAsync(ct);
        if (held.Count == 0) return [];
        var owners = held.Select(s => s.UserId).ToList();
        var requests = await db.VaultRecoveryRequests.AsNoTracking().Where(r => owners.Contains(r.UserId) && r.CompletedAt == null && !r.Cancelled && r.ExpiresAt > clock.Now).ToListAsync(ct);
        var reqIds = requests.Select(r => r.Id).ToList();
        var answered = await db.VaultRecoveryReleases.AsNoTracking().Where(x => reqIds.Contains(x.RequestId) && x.TrusteeUserId == me).Select(x => x.RequestId).ToListAsync(ct);
        var ids = await db.VaultIdentities.AsNoTracking().Where(i => owners.Contains(i.UserId)).ToDictionaryAsync(i => i.UserId, ct);
        var names = await db.Users.AsNoTracking().Where(u => owners.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        var list = new List<VaultRecoveryToHelpDto>();
        foreach (var r in requests.Where(r => !answered.Contains(r.Id)).OrderBy(r => r.CreatedAt))
        {
            var share = held.First(s => s.UserId == r.UserId);
            if (!ids.TryGetValue(r.UserId, out var owner) || owner.Generation != share.Generation) continue;   // their keys changed since: the share is useless
            list.Add(new VaultRecoveryToHelpDto(r.Id, new UserRefDto(r.UserId, names.GetValueOrDefault(r.UserId) ?? "Someone"), r.X25519Public, r.MlKemPublic, r.CreatedAt, r.ExpiresAt,
                MaskIp(r.IpAddress), r.UserAgent, share.Envelope, share.Signature, owner.Ed25519Public, owner.Generation, share.Threshold));
        }
        return list;
    }

    /// <summary>Help (my share, re-encrypted in my browser to the asking browser's one-time keys, after the codes matched) or refuse.</summary>
    public async Task AnswerRecoveryAsync(Guid id, VaultDeviceApproveRequest req, bool help, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (tid, me) = Who();
        var r = await db.VaultRecoveryRequests.FirstOrDefaultAsync(x => x.Id == id, ct) ?? throw new NotFoundException("Not found.", "VAULT_NOT_FOUND");
        var myGen = await db.VaultIdentities.AsNoTracking().Where(i => i.UserId == me).Select(i => (int?)i.Generation).FirstOrDefaultAsync(ct);
        if (r.UserId == me || myGen is null || !await db.VaultRecoveryShares.AnyAsync(s => s.UserId == r.UserId && s.TrusteeUserId == me && s.TrusteeGeneration == myGen, ct))
            throw new NotFoundException("Not found.", "VAULT_NOT_FOUND");
        if (r.CompletedAt != null || r.Cancelled || r.ExpiresAt <= clock.Now) throw new ConflictException("That request has ended.", "VAULT_LINK_ENDED");
        if (await db.VaultRecoveryReleases.AnyAsync(x => x.RequestId == id && x.TrusteeUserId == me, ct)) throw new ConflictException("You already answered.", "VAULT_DECIDED");
        db.VaultRecoveryReleases.Add(new VaultRecoveryRelease
        {
            TenantId = tid, RequestId = id, TrusteeUserId = me, Refused = !help, CreatedAt = clock.Now, CreatedBy = me,
            Envelope = help ? B64(req.Envelope, "envelope", 4000, 1500) : null, Signature = help ? B64(req.Signature, "signature", 120, 80) : null,
        });
        recorder.Audit(help ? "vault.recovery_share_released" : "vault.recovery_refused", "User", r.UserId, null, new { request = id });
        var name = await NameAsync(me, ct);
        await notifications.AddAsync(r.UserId, NotificationType.Security, help ? $"{name} helped unlock your vault" : $"{name} did not help unlock your vault",
            help ? "Once enough people in your circle have helped, the browser you asked from opens your vault." : null, "/vault?view=keys", dedupeKey: $"vault-recover-answer:{id}:{me}", ct: ct);
        await db.SaveChangesAsync(ct);
    }
}
