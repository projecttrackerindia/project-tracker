using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Vault;

public record VaultIdentityDto(Guid UserId, string X25519Public, string MlKemPublic, string Ed25519Public, string SelfSignature, string Fingerprint, int Generation);
public record VaultUnlockDto(Guid Id, VaultUnlockKind Kind, string Label, string? CredentialId, string Salt, string Params, string WrappedSeed, DateTime CreatedAt, DateTime? LastUsedAt);
public record VaultKeysMeDto(VaultIdentityDto? Identity, IReadOnlyList<VaultUnlockDto> Unlocks);
public record VaultUnlockInput(VaultUnlockKind Kind, string? Label, string? CredentialId, string? Salt, string? Params, string? WrappedSeed);
public record VaultSetupRequest(string? X25519Public, string? MlKemPublic, string? Ed25519Public, string? SelfSignature, string? Fingerprint, IReadOnlyList<VaultUnlockInput>? Unlocks,
    bool Reset = false, string? StepUp = null);
public record VaultEnvelopeDto(int KeyVersion, string Envelope, string Signature, Guid SenderUserId, string? SenderEd25519Public, int RecipientGeneration);
public record VaultRecipientDto(Guid UserId, string Name, VaultAccess Access, VaultIdentityDto? Identity);
public record VaultCollectionKeysDto(Guid CollectionId, bool Sealed, int KeyVersion, bool RekeyNeeded, VaultAccess MyAccess, IReadOnlyList<VaultEnvelopeDto> Mine, IReadOnlyList<VaultRecipientDto>? Pending);
public record VaultEnvelopeInput(Guid RecipientUserId, int KeyVersion, int RecipientGeneration, string? Envelope, string? Signature);
public record VaultSealedFileDto(Guid Id, int KeyVersion, string Wrapped, long SizeBytes, DateTime At);
public record VaultSealedItemDto(Guid Id, Guid CollectionId, VaultItemKind Kind, int KeyVersion, string Blob, DateTime? ExpiresAt, int? RotateEveryDays, string? RotationReason,
    DateTime CreatedAt, DateTime? UpdatedAt, DateTime? ValueChangedAt, DateTime? DeletedAt, VaultAccess MyAccess, IReadOnlyList<VaultSealedFileDto> Files, int Versions);
/// <summary><paramref name="Id"/>: made in the browser for a new item, because the item's id is bound into its encryption.</summary>
public record SaveSealedItemRequest(Guid CollectionId, VaultItemKind Kind, int KeyVersion, string? Blob, DateTime? ExpiresAt, int? RotateEveryDays, bool ValueChanged = false, string? Reason = null, Guid? Id = null);
public record VaultSealedVersionDto(Guid Id, int KeyVersion, string Blob, DateTime At, UserRefDto? By, string? Reason);
public record VaultBlobInput(Guid Id, string? Blob);
public record VaultRekeyRequest(int NewVersion, IReadOnlyList<VaultEnvelopeInput>? Envelopes, IReadOnlyList<VaultBlobInput>? Items, IReadOnlyList<VaultBlobInput>? Versions, IReadOnlyList<VaultBlobInput>? Files);
public record VaultSealFile(Guid Id, string? Wrapped, string? Cipher);
public record VaultSealRequest(VaultEnvelopeInput? Envelope, IReadOnlyList<VaultBlobInput>? Items, IReadOnlyList<VaultSealFile>? Files, string? StepUp);
public record VaultExportFile(Guid Id, string FileName, string ContentType, string Data);
public record VaultExportItem(Guid Id, VaultItemKind Kind, string Title, string? Url, IReadOnlyList<string> Tags, SensitivityClass Class, IReadOnlyList<VaultFieldDto> Fields,
    DateTime? ExpiresAt, int? RotateEveryDays, IReadOnlyList<VaultExportFile> Files);
public record VaultItemEventRequest(string? Action, string? Field);
public record VaultDeviceLinkRequest(string? Label, string? X25519Public, string? MlKemPublic);
public record VaultDeviceLinkDto(Guid Id, string Label, string X25519Public, string MlKemPublic, DateTime CreatedAt, DateTime ExpiresAt, string? IpAddress, string? UserAgent,
    bool Approved, bool Denied, string? Envelope, string? Signature);
public record VaultDeviceApproveRequest(string? Envelope, string? Signature);

/// <summary>
/// The sealed (zero-knowledge) side of the vault. Secrets are encrypted in the browser; this service only keeps public keys, keys wrapped to
/// those public keys, and ciphertext — and still decides who may fetch any of it, records every fetch, and keeps keys honest: an envelope is
/// accepted only for someone who has access now, envelopes of people who lost access are removed at once (and the collection is marked for a
/// new key), and a new key must re-encrypt every item, earlier value and file in one go.
/// </summary>
public partial class VaultService
{
    public const int MaxSealedBlobChars = 400_000, DeviceLinkMinutes = 10;
    private static readonly string[] SealedUseEvents = ["revealed", "copied", "totp_used"];

    // ------------------------------------------------------------------ small validators

    private static string B64(string? s, string field, int maxChars, int minChars = 8)
    {
        var t = (s ?? "").Trim();
        if (t.Length < minChars || t.Length > maxChars || !B64Chars().IsMatch(t)) throw new ValidationException(field, $"“{field}” is missing or not in the expected form.");
        return t;
    }
    [GeneratedRegex("^[A-Za-z0-9+/=_-]+$")] private static partial Regex B64Chars();

    private static VaultIdentityDto ToDto(VaultIdentity i) => new(i.UserId, i.X25519Public, i.MlKemPublic, i.Ed25519Public, i.SelfSignature, i.Fingerprint, i.Generation);

    private void RejectSealed(VaultItem item)
    {
        if (item.Sealed) throw new ConflictException("This item is sealed: it is opened in your browser with your vault keys.", "VAULT_SEALED");
    }

    // ------------------------------------------------------------------ identity and unlocking

    public async Task<VaultKeysMeDto> KeysMeAsync(CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (_, me) = Who();
        var id = await db.VaultIdentities.AsNoTracking().FirstOrDefaultAsync(i => i.UserId == me, ct);
        var unlocks = await db.VaultUnlocks.AsNoTracking().Where(u => u.UserId == me).OrderBy(u => u.CreatedAt).ToListAsync(ct);
        return new VaultKeysMeDto(id is null ? null : ToDto(id), unlocks.Select(u => new VaultUnlockDto(u.Id, u.Kind, u.Label, u.CredentialId, u.Salt, u.Params, u.WrappedSeed, u.CreatedAt, u.LastUsedAt)).ToList());
    }

    private static VaultUnlock UnlockFrom(Guid tid, Guid me, VaultUnlockInput u, DateTime now)
    {
        if (!Enum.IsDefined(u.Kind)) throw new ValidationException("unlocks", "Unknown unlock kind.");
        return new VaultUnlock
        {
            TenantId = tid, UserId = me, Kind = u.Kind, Label = Clip(u.Label, 80) ?? (u.Kind == VaultUnlockKind.Passkey ? "Passkey" : "Recovery key"),
            CredentialId = u.Kind == VaultUnlockKind.Passkey ? B64(u.CredentialId, "credentialId", 1400) : null,
            Salt = B64(u.Salt, "salt", 200, 16), Params = Clip(u.Params, 200) ?? "", WrappedSeed = B64(u.WrappedSeed, "wrappedSeed", 400, 40), CreatedAt = now, CreatedBy = me,
        };
    }

    /// <summary>
    /// Saves the public keys made in the browser and at least one way to unlock (a recovery key is required, so a lost passkey is not a lost
    /// vault). A reset (new keys) needs a fresh two-step check, and every sealed collection key the old keys could open is dropped: the
    /// person gets them again from someone who manages each collection.
    /// </summary>
    public async Task<VaultKeysMeDto> SetupKeysAsync(VaultSetupRequest req, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (tid, me) = Who();
        var x = B64(req.X25519Public, "x25519Public", 64, 40);
        var k = B64(req.MlKemPublic, "mlKemPublic", 2000, 1500);
        var e = B64(req.Ed25519Public, "ed25519Public", 64, 40);
        var sig = B64(req.SelfSignature, "selfSignature", 120, 80);
        var fp = (req.Fingerprint ?? "").Trim();
        if (!Fingerprint().IsMatch(fp)) throw new ValidationException("fingerprint", "The safety code is not in the expected form.");
        var unlocks = (req.Unlocks ?? []).Take(10).ToList();
        if (!unlocks.Any(u => u.Kind == VaultUnlockKind.RecoveryKey)) throw new ValidationException("unlocks", "Save a recovery key first: without it, a lost passkey means a lost vault.");
        var existing = await db.VaultIdentities.FirstOrDefaultAsync(i => i.UserId == me, ct);
        if (existing is not null && !req.Reset) throw new ConflictException("Your vault keys are already set up.", "VAULT_KEYS_EXIST");
        if (existing is not null)
        {
            if (!await stepUp.IsFreshAsync(me, req.StepUp, ct)) throw new ForbiddenException("Confirm with your authenticator first: new keys cut you off from sealed collections until they are shared with you again.", "STEP_UP_REQUIRED");
            var mine = await db.VaultKeyEnvelopes.Where(v => v.RecipientUserId == me).ToListAsync(ct);
            db.VaultKeyEnvelopes.RemoveRange(mine);
            db.VaultUnlocks.RemoveRange(await db.VaultUnlocks.Where(u => u.UserId == me).ToListAsync(ct));
            existing.X25519Public = x; existing.MlKemPublic = k; existing.Ed25519Public = e; existing.SelfSignature = sig; existing.Fingerprint = fp;
            existing.Generation++; existing.UpdatedAt = clock.Now; existing.UpdatedBy = me;
            recorder.Audit("vault.keys_reset", "User", me, null, new { generation = existing.Generation, droppedKeys = mine.Count });
            // Personal sealed collections opened only with the old keys can never be opened again; they are marked so the owner sees it.
        }
        else
        {
            db.VaultIdentities.Add(new VaultIdentity { TenantId = tid, UserId = me, X25519Public = x, MlKemPublic = k, Ed25519Public = e, SelfSignature = sig, Fingerprint = fp, CreatedAt = clock.Now, CreatedBy = me });
            recorder.Audit("vault.keys_created", "User", me, null, new { fingerprint = fp[..11] });
        }
        foreach (var u in unlocks) db.VaultUnlocks.Add(UnlockFrom(tid, me, u, clock.Now));
        await db.SaveChangesAsync(ct);
        return await KeysMeAsync(ct);
    }
    [GeneratedRegex(@"^\d{5}( \d{5}){11}$")] private static partial Regex Fingerprint();

    public async Task<VaultKeysMeDto> AddUnlockAsync(VaultUnlockInput req, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (tid, me) = Who();
        if (!await db.VaultIdentities.AnyAsync(i => i.UserId == me, ct)) throw new ConflictException("Set up your vault keys first.", "VAULT_NO_KEYS");
        if (await db.VaultUnlocks.CountAsync(u => u.UserId == me, ct) >= 10) throw new ValidationException("unlocks", "Ten ways to unlock is the most.");
        var u = UnlockFrom(tid, me, req, clock.Now);
        db.VaultUnlocks.Add(u);
        recorder.Audit("vault.unlock_added", "User", me, null, new { kind = u.Kind.ToString(), u.Label });
        await db.SaveChangesAsync(ct);
        return await KeysMeAsync(ct);
    }

    public async Task<VaultKeysMeDto> RemoveUnlockAsync(Guid id, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (_, me) = Who();
        var u = await db.VaultUnlocks.FirstOrDefaultAsync(x => x.Id == id && x.UserId == me, ct) ?? throw new NotFoundException("Not found.", "VAULT_NOT_FOUND");
        if (u.Kind == VaultUnlockKind.RecoveryKey && !await db.VaultUnlocks.AnyAsync(x => x.UserId == me && x.Id != id && x.Kind == VaultUnlockKind.RecoveryKey, ct))
            throw new ConflictException("Keep at least one recovery key: make a new one before removing this one.", "VAULT_LAST_RECOVERY");
        db.VaultUnlocks.Remove(u);
        recorder.Audit("vault.unlock_removed", "User", me, null, new { kind = u.Kind.ToString(), u.Label });
        await db.SaveChangesAsync(ct);
        return await KeysMeAsync(ct);
    }

    /// <summary>The browser tells the server which way it unlocked (recorded; the server never sees the secret).</summary>
    public async Task UnlockedAsync(Guid unlockId, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (_, me) = Who();
        var u = await db.VaultUnlocks.FirstOrDefaultAsync(x => x.Id == unlockId && x.UserId == me, ct) ?? throw new NotFoundException("Not found.", "VAULT_NOT_FOUND");
        u.LastUsedAt = clock.Now;
        recorder.Audit("vault.unlocked", "User", me, null, new { kind = u.Kind.ToString(), u.Label });
        if (u.Kind == VaultUnlockKind.RecoveryKey)
            await notifications.AddAsync(me, NotificationType.Security, "Your vault was unlocked with the recovery key", "If that was not you, reset your vault keys and change your password.", "/vault?view=keys", toSelf: true, ct: ct);
        await db.SaveChangesAsync(ct);
    }

    /// <summary>Public keys of members (for sharing a sealed collection with them, and for comparing safety codes).</summary>
    public async Task<IReadOnlyList<VaultRecipientDto>> DirectoryAsync(IReadOnlyList<Guid>? userIds, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (tid, _) = Who();
        var ids = (userIds ?? []).Distinct().Take(200).ToList();
        var members = await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid && m.Role != TenantRole.Guest && (ids.Count == 0 || ids.Contains(m.UserId)))
            .Select(m => new { m.UserId, Name = m.User!.DisplayName }).ToListAsync(ct);
        var memberIds = members.Select(m => m.UserId).ToList();
        var keys = await db.VaultIdentities.AsNoTracking().Where(i => memberIds.Contains(i.UserId)).ToDictionaryAsync(i => i.UserId, ct);
        return members.OrderBy(m => m.Name).Select(m => new VaultRecipientDto(m.UserId, m.Name, VaultAccess.None, keys.TryGetValue(m.UserId, out var k) ? ToDto(k) : null)).ToList();
    }

    // ------------------------------------------------------------------ who has access now (for keys)

    /// <summary>
    /// Everyone's access to one collection, worked out the same way as for the signed-in person. Memberships are read for the whole workspace
    /// (not narrowed to what the caller can see), so a manager who cannot see a project never makes its members look like they lost access.
    /// </summary>
    private async Task<Dictionary<Guid, VaultAccess>> AccessByUserAsync(VaultCollection c, CancellationToken ct)
    {
        var tid = c.TenantId;
        var members = await db.TenantMembers.IgnoreQueryFilters().AsNoTracking().Where(m => m.TenantId == tid).Select(m => new { m.UserId, m.Role }).ToListAsync(ct);
        if (c.Kind == VaultCollectionKind.Personal)
            return members.Where(m => m.UserId == c.OwnerUserId && m.Role != TenantRole.Guest && c.LockedAt == null).ToDictionary(m => m.UserId, _ => VaultAccess.Manage);
        var shares = await db.VaultShares.IgnoreQueryFilters().AsNoTracking().Where(s => s.TenantId == tid && s.CollectionId == c.Id).ToListAsync(ct);
        var teams = await db.TeamMembers.IgnoreQueryFilters().AsNoTracking().Where(t => t.TenantId == tid).Select(t => new { t.UserId, t.TeamId }).ToListAsync(ct);
        var projectMembers = await db.ProjectMembers.IgnoreQueryFilters().AsNoTracking().Where(p => p.TenantId == tid).Select(p => new { p.UserId, p.ProjectId }).ToListAsync(ct);
        var owners = await db.Projects.IgnoreQueryFilters().AsNoTracking().Where(p => p.TenantId == tid && !p.IsDeleted).Select(p => new { UserId = p.OwnerId, ProjectId = p.Id }).ToListAsync(ct);
        var result = new Dictionary<Guid, VaultAccess>();
        foreach (var m in members)
        {
            var membership = new Membership(teams.Where(t => t.UserId == m.UserId).Select(t => t.TeamId).ToHashSet(),
                projectMembers.Where(p => p.UserId == m.UserId).Select(p => p.ProjectId).Concat(owners.Where(o => o.UserId == m.UserId).Select(o => o.ProjectId)).ToHashSet(), m.Role);
            var a = Evaluate(c, shares, m.UserId, membership);
            if (a > VaultAccess.None) result[m.UserId] = a;
        }
        return result;
    }

    /// <summary>Removes the key envelopes of people who no longer have access; when any go, the collection needs a new key.</summary>
    private async Task<int> DropStaleEnvelopesAsync(VaultCollection c, Dictionary<Guid, VaultAccess> access, CancellationToken ct)
    {
        var generations = await db.VaultIdentities.IgnoreQueryFilters().AsNoTracking().Where(i => i.TenantId == c.TenantId).ToDictionaryAsync(i => i.UserId, i => i.Generation, ct);
        var stale = await db.VaultKeyEnvelopes.IgnoreQueryFilters().Where(v => v.TenantId == c.TenantId && v.CollectionId == c.Id).ToListAsync(ct);
        var gone = stale.Where(v => !access.ContainsKey(v.RecipientUserId)).ToList();
        var outdated = stale.Where(v => access.ContainsKey(v.RecipientUserId) && generations.GetValueOrDefault(v.RecipientUserId) != v.RecipientGeneration).ToList();
        if (gone.Count == 0 && outdated.Count == 0) return 0;
        db.VaultKeyEnvelopes.RemoveRange(gone.Concat(outdated));
        if (gone.Count > 0 && !c.RekeyNeeded)
        {
            c.RekeyNeeded = true;
            recorder.Audit("vault.rekey_needed", "VaultCollection", c.Id, null, new { c.Name, removed = gone.Select(g => g.RecipientUserId).Distinct().Count() }, tenantId: c.TenantId);
        }
        return gone.Count + outdated.Count;
    }

    // ------------------------------------------------------------------ sealed collection keys

    public async Task<VaultCollectionKeysDto> CollectionKeysAsync(Guid id, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (_, me) = Who();
        var (c, access) = await CollectionAsync(id, VaultAccess.View, ct);
        if (!c.Sealed) throw new ConflictException("This collection is not sealed.", "VAULT_NOT_SEALED");
        List<VaultRecipientDto>? pending = null;
        if (access == VaultAccess.Manage)
        {
            var everyone = await AccessByUserAsync(c, ct);
            if (await DropStaleEnvelopesAsync(c, everyone, ct) > 0) await db.SaveChangesAsync(ct);
            var have = await db.VaultKeyEnvelopes.AsNoTracking().Where(v => v.CollectionId == id && v.KeyVersion == c.SealedKeyVersion).Select(v => v.RecipientUserId).ToListAsync(ct);
            var missing = everyone.Keys.Except(have).ToList();
            var keys = await db.VaultIdentities.AsNoTracking().Where(i => missing.Contains(i.UserId)).ToDictionaryAsync(i => i.UserId, ct);
            var names = await db.Users.AsNoTracking().Where(u => missing.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
            pending = missing.Select(u => new VaultRecipientDto(u, names.GetValueOrDefault(u) ?? "Member", everyone[u], keys.TryGetValue(u, out var k) ? ToDto(k) : null)).ToList();
        }
        var mine = await db.VaultKeyEnvelopes.AsNoTracking().Where(v => v.CollectionId == id && v.RecipientUserId == me).OrderByDescending(v => v.KeyVersion).ToListAsync(ct);
        var senders = mine.Select(v => v.SenderUserId).Distinct().ToList();
        var senderKeys = await db.VaultIdentities.AsNoTracking().Where(i => senders.Contains(i.UserId)).ToDictionaryAsync(i => i.UserId, i => i.Ed25519Public, ct);
        return new VaultCollectionKeysDto(c.Id, true, c.SealedKeyVersion, c.RekeyNeeded, access,
            mine.Select(v => new VaultEnvelopeDto(v.KeyVersion, v.Envelope, v.Signature, v.SenderUserId, senderKeys.GetValueOrDefault(v.SenderUserId), v.RecipientGeneration)).ToList(), pending);
    }

    /// <summary>Saves collection keys wrapped (in the sharer's browser) to members who have access now and have set up their keys.</summary>
    public async Task<VaultCollectionKeysDto> SaveEnvelopesAsync(Guid id, IReadOnlyList<VaultEnvelopeInput>? envelopes, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (tid, me) = Who();
        var c = await db.VaultCollections.FirstOrDefaultAsync(x => x.Id == id, ct) ?? throw new NotFoundException("Collection not found.", "VAULT_NOT_FOUND");
        if (!c.Sealed) throw new ConflictException("This collection is not sealed.", "VAULT_NOT_SEALED");
        var everyone = await AccessByUserAsync(c, ct);
        var mineAccess = everyone.GetValueOrDefault(me);
        var list = (envelopes ?? []).Take(500).ToList();
        if (list.Count == 0) throw new ValidationException("envelopes", "Nothing to save.");
        // Only managers hand keys to others; anyone with access may save their own (first key of a collection they made, or after a reset by a manager).
        if (list.Any(e => e.RecipientUserId != me) && mineAccess != VaultAccess.Manage) throw new ForbiddenException("Only people who manage this collection can share its key.", "VAULT_DENIED");
        if (mineAccess == VaultAccess.None) throw new NotFoundException("Collection not found.", "VAULT_NOT_FOUND");
        var recipients = list.Select(e => e.RecipientUserId).Distinct().ToList();
        var ids = await db.VaultIdentities.AsNoTracking().Where(i => recipients.Contains(i.UserId)).ToDictionaryAsync(i => i.UserId, ct);
        var existing = await db.VaultKeyEnvelopes.Where(v => v.CollectionId == id && recipients.Contains(v.RecipientUserId)).ToListAsync(ct);
        foreach (var e in list)
        {
            if (!everyone.ContainsKey(e.RecipientUserId)) throw new ValidationException("envelopes", "A key can only be shared with someone who has access to the collection.");
            if (!ids.TryGetValue(e.RecipientUserId, out var who) || who.Generation != e.RecipientGeneration) throw new ConflictException("Their vault keys changed. Reload and share again.", "VAULT_KEYS_CHANGED");
            if (e.KeyVersion != c.SealedKeyVersion) throw new ConflictException("The collection has a newer key. Reload and try again.", "VAULT_KEY_VERSION");
            db.VaultKeyEnvelopes.RemoveRange(existing.Where(x => x.RecipientUserId == e.RecipientUserId && x.KeyVersion == e.KeyVersion));
            db.VaultKeyEnvelopes.Add(new VaultKeyEnvelope { TenantId = tid, CollectionId = id, KeyVersion = e.KeyVersion, RecipientUserId = e.RecipientUserId, RecipientGeneration = e.RecipientGeneration,
                SenderUserId = me, Envelope = B64(e.Envelope, "envelope", 4000, 1500), Signature = B64(e.Signature, "signature", 120, 80), CreatedAt = clock.Now, CreatedBy = me });
        }
        recorder.Audit("vault.keys_shared", "VaultCollection", id, null, new { c.Name, people = recipients.Count, version = c.SealedKeyVersion });
        await db.SaveChangesAsync(ct);
        return await CollectionKeysAsync(id, ct);
    }

    /// <summary>
    /// A new collection key after someone lost access: every item, earlier value and file key comes back re-encrypted with it, together with the
    /// key wrapped to everyone who has access. All or nothing: anything missing or extra is refused.
    /// </summary>
    public async Task<VaultCollectionKeysDto> RekeyAsync(Guid id, VaultRekeyRequest req, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (tid, me) = Who();
        var (c, _) = await CollectionAsync(id, VaultAccess.Manage, ct);
        if (!c.Sealed) throw new ConflictException("This collection is not sealed.", "VAULT_NOT_SEALED");
        if (req.NewVersion != c.SealedKeyVersion + 1) throw new ConflictException("Someone else changed the key a moment ago. Reload.", "VAULT_KEY_VERSION");
        var everyone = await AccessByUserAsync(c, ct);
        var withKeys = await db.VaultIdentities.AsNoTracking().Where(i => everyone.Keys.Contains(i.UserId)).ToDictionaryAsync(i => i.UserId, i => i.Generation, ct);
        var envs = (req.Envelopes ?? []).ToList();
        if (!envs.Any(e => e.RecipientUserId == me)) throw new ValidationException("envelopes", "Include your own copy of the new key.");
        if (envs.Any(e => !everyone.ContainsKey(e.RecipientUserId) || e.KeyVersion != req.NewVersion || withKeys.GetValueOrDefault(e.RecipientUserId) != e.RecipientGeneration))
            throw new ConflictException("Who has access changed. Reload and try again.", "VAULT_KEYS_CHANGED");

        var items = await db.VaultItems.Where(i => i.CollectionId == id).ToListAsync(ct);
        var itemIds = items.Select(i => i.Id).ToList();
        var versions = await db.VaultItemVersions.Where(v => itemIds.Contains(v.ItemId)).ToListAsync(ct);
        var files = await db.VaultAttachments.Where(a => itemIds.Contains(a.ItemId)).Select(a => new { a.Id, a.KeyVersion }).ToListAsync(ct);
        static Dictionary<Guid, string> Map(IReadOnlyList<VaultBlobInput>? xs, int max) => (xs ?? []).GroupBy(x => x.Id).ToDictionary(g => g.Key, g => B64(g.First().Blob, "blob", max, 20));
        var newItems = Map(req.Items, MaxSealedBlobChars);
        var newVersions = Map(req.Versions, MaxSealedBlobChars);
        var newFiles = Map(req.Files, 500);
        if (!newItems.Keys.ToHashSet().SetEquals(itemIds) || !newVersions.Keys.ToHashSet().SetEquals(versions.Select(v => v.Id)) || !newFiles.Keys.ToHashSet().SetEquals(files.Select(f => f.Id)))
            throw new ConflictException("Everything in the collection must be re-encrypted together. Reload and try again.", "VAULT_REKEY_INCOMPLETE");

        await using var tx = await db.Database.BeginTransactionAsync(ct);   // the file keys are written directly; all of it lands or none of it
        foreach (var i in items) { i.Cipher = newItems[i.Id]; i.KeyVersion = req.NewVersion; }
        foreach (var v in versions) { v.Cipher = newVersions[v.Id]; v.KeyVersion = req.NewVersion; }
        foreach (var f in files)
            await db.VaultAttachments.Where(a => a.Id == f.Id).ExecuteUpdateAsync(u => u.SetProperty(a => a.WrappedItemKey, newFiles[f.Id]).SetProperty(a => a.KeyVersion, req.NewVersion), ct);
        db.VaultKeyEnvelopes.RemoveRange(await db.VaultKeyEnvelopes.Where(v => v.CollectionId == id).ToListAsync(ct));
        foreach (var e in envs)
            db.VaultKeyEnvelopes.Add(new VaultKeyEnvelope { TenantId = tid, CollectionId = id, KeyVersion = req.NewVersion, RecipientUserId = e.RecipientUserId, RecipientGeneration = e.RecipientGeneration,
                SenderUserId = me, Envelope = B64(e.Envelope, "envelope", 4000, 1500), Signature = B64(e.Signature, "signature", 120, 80), CreatedAt = clock.Now, CreatedBy = me });
        c.SealedKeyVersion = req.NewVersion; c.RekeyNeeded = false; c.UpdatedAt = clock.Now; c.UpdatedBy = me;
        recorder.Audit("vault.rekeyed", "VaultCollection", id, null, new { c.Name, version = req.NewVersion, items = items.Count, people = envs.Count });
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return await CollectionKeysAsync(id, ct);
    }

    // ------------------------------------------------------------------ moving a guarded collection to sealed

    /// <summary>
    /// For sealing: every value of a guarded collection, once, to its manager after a fresh two-step check (recorded). The browser encrypts
    /// them with a new collection key and sends them back through <see cref="SealCollectionAsync"/>.
    /// </summary>
    public async Task<IReadOnlyList<VaultExportItem>> ExportForSealingAsync(Guid id, string? stepUpToken, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (tid, me) = Who();
        var (c, _) = await CollectionAsync(id, VaultAccess.Manage, ct);
        if (c.Sealed) throw new ConflictException("This collection is already sealed.", "VAULT_SEALED");
        if (!await stepUp.IsFreshAsync(me, stepUpToken, ct)) throw new ForbiddenException("Confirm with your authenticator first.", "STEP_UP_REQUIRED");
        if (!await db.VaultIdentities.AnyAsync(i => i.UserId == me, ct)) throw new ConflictException("Set up your vault keys first.", "VAULT_NO_KEYS");
        var items = await db.VaultItems.AsNoTracking().Where(i => i.CollectionId == id && i.DeletedAt == null).ToListAsync(ct);
        if (items.Any(i => i.UseOnly)) throw new ConflictException("Use-only items need the server to hold the value. Move them to a guarded collection first.", "VAULT_USE_ONLY");
        if (await db.VaultItems.AnyAsync(i => i.CollectionId == id && i.DeletedAt != null, ct)) throw new ConflictException("Empty this collection’s bin first (restore or wait).", "VAULT_BIN_NOT_EMPTY");
        var ids = items.Select(i => i.Id).ToList();
        var files = await db.VaultAttachments.AsNoTracking().Where(a => ids.Contains(a.ItemId)).ToListAsync(ct);
        var result = new List<VaultExportItem>();
        foreach (var i in items)
        {
            var values = await crypto.OpenAsync(tid, i.Id, i.Cipher, i.WrappedItemKey, i.KeyVersion, ct);
            var fields = ReadDefs(i.FieldsJson).Select(d => new VaultFieldDto(d.Key, d.Label, d.Type, d.Secret, values.GetValueOrDefault(d.Key))).ToList();
            var fs = new List<VaultExportFile>();
            foreach (var f in files.Where(f => f.ItemId == i.Id))
                fs.Add(new VaultExportFile(f.Id, f.FileName, f.ContentType, Convert.ToBase64String(await crypto.OpenFileAsync(tid, i.Id, f.Id, f.WrappedItemKey, f.KeyVersion, f.Cipher, ct))));
            result.Add(new VaultExportItem(i.Id, i.Kind, i.Title, i.Url, SplitTags(i.Tags), i.Class, fields, i.ExpiresAt, i.RotateEveryDays, fs));
        }
        recorder.Audit("vault.exported_for_sealing", "VaultCollection", id, null, new { c.Name, items = items.Count, files = files.Count });
        await db.SaveChangesAsync(ct);
        return result;
    }

    /// <summary>
    /// Turns a guarded collection into a sealed one: every item (and file) comes back encrypted in the browser; the server-readable copies and
    /// their earlier values are destroyed. People on the list then get the key from a manager's browser as they set up their keys.
    /// </summary>
    public async Task<VaultCollectionKeysDto> SealCollectionAsync(Guid id, VaultSealRequest req, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (tid, me) = Who();
        var (c, _) = await CollectionAsync(id, VaultAccess.Manage, ct);
        if (c.Sealed) throw new ConflictException("This collection is already sealed.", "VAULT_SEALED");
        if (!await stepUp.IsFreshAsync(me, req.StepUp, ct)) throw new ForbiddenException("Confirm with your authenticator first.", "STEP_UP_REQUIRED");
        var identity = await db.VaultIdentities.AsNoTracking().FirstOrDefaultAsync(i => i.UserId == me, ct) ?? throw new ConflictException("Set up your vault keys first.", "VAULT_NO_KEYS");
        var env = req.Envelope ?? throw new ValidationException("envelope", "Include your copy of the collection key.");
        if (env.RecipientUserId != me || env.KeyVersion != 1 || env.RecipientGeneration != identity.Generation) throw new ValidationException("envelope", "Include your own copy of the first collection key.");
        if (await db.VaultItems.AnyAsync(i => i.CollectionId == id && (i.UseOnly || i.DeletedAt != null), ct)) throw new ConflictException("Use-only items and the bin must be dealt with first.", "VAULT_USE_ONLY");
        var items = await db.VaultItems.Where(i => i.CollectionId == id).ToListAsync(ct);
        var ids = items.Select(i => i.Id).ToList();
        var blobs = (req.Items ?? []).GroupBy(x => x.Id).ToDictionary(g => g.Key, g => B64(g.First().Blob, "blob", MaxSealedBlobChars, 20));
        if (!blobs.Keys.ToHashSet().SetEquals(ids)) throw new ConflictException("Every item must be sealed together. Reload and try again.", "VAULT_REKEY_INCOMPLETE");
        var files = await db.VaultAttachments.Where(a => ids.Contains(a.ItemId)).ToListAsync(ct);
        var sealedFiles = (req.Files ?? []).GroupBy(f => f.Id).ToDictionary(g => g.Key, g => g.First());
        if (!sealedFiles.Keys.ToHashSet().SetEquals(files.Select(f => f.Id))) throw new ConflictException("Every file must be sealed together. Reload and try again.", "VAULT_REKEY_INCOMPLETE");

        foreach (var i in items)
        {
            i.Cipher = blobs[i.Id]; i.WrappedItemKey = ""; i.KeyVersion = 1; i.Sealed = true;
            i.Title = ""; i.Url = null; i.UsernameHint = null; i.Tags = null; i.FieldsJson = "[]"; i.LinksJson = "[]";
            i.PasswordFingerprint = null; i.Strength = null; i.BreachCount = null; i.BreachCheckedAt = null; i.HasTotp = false; i.UseOnly = false;
            i.UpdatedAt = clock.Now; i.UpdatedBy = me;
        }
        foreach (var f in files)
        {
            var s = sealedFiles[f.Id];
            var bytes = Convert.FromBase64String(B64(s.Cipher, "cipher", 3_000_000, 20));
            if (bytes.Length > MaxAttachmentBytes + 1024) throw new ValidationException("files", "A file kept in the vault can be up to 2 MB.");
            f.Cipher = bytes; f.WrappedItemKey = B64(s.Wrapped, "wrapped", 500, 20); f.KeyVersion = 1; f.Sealed = true; f.FileName = "sealed"; f.ContentType = "application/octet-stream";
        }
        db.VaultItemVersions.RemoveRange(await db.VaultItemVersions.Where(v => ids.Contains(v.ItemId)).ToListAsync(ct));   // server-readable history goes
        db.VaultKeyEnvelopes.Add(new VaultKeyEnvelope { TenantId = tid, CollectionId = id, KeyVersion = 1, RecipientUserId = me, RecipientGeneration = identity.Generation, SenderUserId = me,
            Envelope = B64(env.Envelope, "envelope", 4000, 1500), Signature = B64(env.Signature, "signature", 120, 80), CreatedAt = clock.Now, CreatedBy = me });
        c.Sealed = true; c.SealedKeyVersion = 1; c.RekeyNeeded = false; c.UpdatedAt = clock.Now; c.UpdatedBy = me;
        // Use-only shares cannot exist in a sealed collection (whoever opens the key can read the value): they become view.
        foreach (var s in await db.VaultShares.Where(s => s.CollectionId == id && s.Access == VaultAccess.UseOnly).ToListAsync(ct)) s.Access = VaultAccess.View;
        recorder.Audit("vault.collection_sealed", "VaultCollection", id, null, new { c.Name, items = items.Count, files = files.Count });
        await db.SaveChangesAsync(ct);
        return await CollectionKeysAsync(id, ct);
    }

    // ------------------------------------------------------------------ sealed items

    private async Task<VaultSealedItemDto> SealedDtoAsync(VaultItem i, VaultAccess access, CancellationToken ct)
    {
        var files = await db.VaultAttachments.AsNoTracking().Where(a => a.ItemId == i.Id).OrderBy(a => a.CreatedAt)
            .Select(a => new VaultSealedFileDto(a.Id, a.KeyVersion, a.WrappedItemKey, a.SizeBytes, a.CreatedAt)).ToListAsync(ct);
        var versions = await db.VaultItemVersions.CountAsync(v => v.ItemId == i.Id, ct);
        return new VaultSealedItemDto(i.Id, i.CollectionId, i.Kind, i.KeyVersion, i.Cipher, i.ExpiresAt, i.RotateEveryDays, i.RotationReason, i.CreatedAt, i.UpdatedAt, i.ValueChangedAt, i.DeletedAt, access, files, versions);
    }

    /// <summary>Every sealed item of a collection (ciphertext). Fetching is recorded: whoever fetches can read them all once they hold the key.</summary>
    public async Task<IReadOnlyList<VaultSealedItemDto>> SealedItemsAsync(Guid collectionId, bool bin = false, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (c, access) = await CollectionAsync(collectionId, VaultAccess.View, ct);
        if (!c.Sealed) throw new ConflictException("This collection is not sealed.", "VAULT_NOT_SEALED");
        if (bin && access < VaultAccess.Manage) return [];
        var items = await db.VaultItems.AsNoTracking().Where(i => i.CollectionId == collectionId && i.Sealed && (bin ? i.DeletedAt != null : i.DeletedAt == null)).OrderBy(i => i.CreatedAt).Take(MaxItemsPerCollection).ToListAsync(ct);
        var ids = items.Select(i => i.Id).ToList();
        var files = await db.VaultAttachments.AsNoTracking().Where(a => ids.Contains(a.ItemId)).Select(a => new { a.ItemId, Dto = new VaultSealedFileDto(a.Id, a.KeyVersion, a.WrappedItemKey, a.SizeBytes, a.CreatedAt) }).ToListAsync(ct);
        var versions = await db.VaultItemVersions.AsNoTracking().Where(v => ids.Contains(v.ItemId)).GroupBy(v => v.ItemId).Select(g => new { g.Key, N = g.Count() }).ToListAsync(ct);
        recorder.Audit("vault.sealed_listed", "VaultCollection", collectionId, null, new { c.Name, items = items.Count, bin });
        await db.SaveChangesAsync(ct);
        return items.Select(i => new VaultSealedItemDto(i.Id, i.CollectionId, i.Kind, i.KeyVersion, i.Cipher, i.ExpiresAt, i.RotateEveryDays, i.RotationReason, i.CreatedAt, i.UpdatedAt, i.ValueChangedAt,
            i.DeletedAt, access, files.Where(f => f.ItemId == i.Id).Select(f => f.Dto).ToList(), versions.FirstOrDefault(v => v.Key == i.Id)?.N ?? 0)).ToList();
    }

    private async Task<VaultCollection> SealedCollectionForWriteAsync(Guid collectionId, int keyVersion, CancellationToken ct)
    {
        var (c, _) = await CollectionAsync(collectionId, VaultAccess.Manage, ct);
        if (!c.Sealed) throw new ConflictException("This collection is not sealed.", "VAULT_NOT_SEALED");
        if (c.RekeyNeeded) throw new ConflictException("Someone lost access: make the new key first (it happens when you open the collection).", "VAULT_REKEY_NEEDED");
        if (keyVersion != c.SealedKeyVersion) throw new ConflictException("The collection has a newer key. Reload.", "VAULT_KEY_VERSION");
        return c;
    }

    public async Task<VaultSealedItemDto> CreateSealedItemAsync(SaveSealedItemRequest req, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (tid, me) = Who();
        var c = await SealedCollectionForWriteAsync(req.CollectionId, req.KeyVersion, ct);
        if (!Enum.IsDefined(req.Kind)) throw new ValidationException("kind", "Choose what kind of item this is.");
        if (await db.VaultItems.CountAsync(i => i.CollectionId == c.Id && i.DeletedAt == null, ct) >= MaxItemsPerCollection) throw new ValidationException("collectionId", $"A collection holds at most {MaxItemsPerCollection:N0} items.");
        var days = CleanDays(req.RotateEveryDays) ?? c.RotateEveryDays;
        var newId = req.Id is { } given && given != Guid.Empty ? given : throw new ValidationException("id", "A sealed item's id is made in the browser (it is part of its encryption).");
        if (await db.VaultItems.IgnoreQueryFilters().AnyAsync(i => i.Id == newId, ct)) throw new ConflictException("That id is taken. Try again.", "VAULT_ID_TAKEN");
        var item = new VaultItem
        {
            Id = newId, TenantId = tid, CollectionId = c.Id, Kind = req.Kind, Sealed = true, Title = "", Cipher = B64(req.Blob, "blob", MaxSealedBlobChars, 20), KeyVersion = c.SealedKeyVersion,
            OwnerUserId = me, RotateEveryDays = days, ValueChangedAt = clock.Now, CreatedAt = clock.Now, CreatedBy = me,
        };
        item.ExpiresAt = req.ExpiresAt is { } e ? DateTime.SpecifyKind(e, DateTimeKind.Utc) : days is { } d ? clock.Now.AddDays(d) : null;
        db.VaultItems.Add(item);
        recorder.Audit("vault.item_created", "VaultItem", item.Id, null, new { collection = c.Name, kind = item.Kind.ToString(), sealedItem = true });
        await db.SaveChangesAsync(ct);
        return await SealedDtoAsync(item, VaultAccess.Manage, ct);
    }

    public async Task<VaultSealedItemDto> UpdateSealedItemAsync(Guid id, SaveSealedItemRequest req, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (_, me) = Who();
        var (item, c, _) = await ItemAsync(id, VaultAccess.Manage, ct);
        if (!item.Sealed) throw new ConflictException("This item is not sealed.", "VAULT_NOT_SEALED");
        if (req.CollectionId != item.CollectionId) throw new ValidationException("collectionId", "A sealed item stays in its collection (its key belongs to it). Copy it instead.");
        await SealedCollectionForWriteAsync(c.Id, req.KeyVersion, ct);
        if (req.ValueChanged)
        {
            db.VaultItemVersions.Add(new VaultItemVersion { TenantId = item.TenantId, ItemId = item.Id, Cipher = item.Cipher, KeyVersion = item.KeyVersion, Sealed = true,
                Reason = Clip(req.Reason, 200) ?? (item.RotationReason is not null ? "Changed after: " + item.RotationReason : "Changed"), CreatedAt = clock.Now, CreatedBy = me });
            db.VaultItemVersions.RemoveRange(await db.VaultItemVersions.Where(v => v.ItemId == item.Id).OrderByDescending(v => v.CreatedAt).Skip(MaxVersions - 1).ToListAsync(ct));
            item.ValueChangedAt = clock.Now; item.RotationReason = null; item.ExpiryNotifiedAt = null;
        }
        item.Kind = Enum.IsDefined(req.Kind) ? req.Kind : item.Kind;
        item.Cipher = B64(req.Blob, "blob", MaxSealedBlobChars, 20);
        item.RotateEveryDays = CleanDays(req.RotateEveryDays) ?? c.RotateEveryDays;
        item.ExpiresAt = req.ExpiresAt is { } e ? DateTime.SpecifyKind(e, DateTimeKind.Utc) : item.RotateEveryDays is { } d && item.ValueChangedAt is { } changed ? changed.AddDays(d) : null;
        item.UpdatedAt = clock.Now; item.UpdatedBy = me;
        recorder.Audit("vault.item_changed", "VaultItem", item.Id, null, new { collection = c.Name, valueChanged = req.ValueChanged, sealedItem = true });
        await db.SaveChangesAsync(ct);
        return await SealedDtoAsync(item, VaultAccess.Manage, ct);
    }

    public async Task<IReadOnlyList<VaultSealedVersionDto>> SealedVersionsAsync(Guid id, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (item, c, _) = await ItemAsync(id, VaultAccess.Manage, ct);
        if (!item.Sealed) throw new ConflictException("This item is not sealed.", "VAULT_NOT_SEALED");
        var rows = await db.VaultItemVersions.AsNoTracking().Where(v => v.ItemId == id).OrderByDescending(v => v.CreatedAt).ToListAsync(ct);
        var people = rows.Where(r => r.CreatedBy != null).Select(r => r.CreatedBy!.Value).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => people.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        recorder.Audit("vault.versions_fetched", "VaultItem", id, null, new { collection = c.Name, versions = rows.Count });
        await db.SaveChangesAsync(ct);
        return rows.Select(v => new VaultSealedVersionDto(v.Id, v.KeyVersion, v.Cipher, v.CreatedAt, v.CreatedBy is { } u ? new UserRefDto(u, names.GetValueOrDefault(u) ?? "Former member") : null, v.Reason)).ToList();
    }

    /// <summary>What the browser did with a sealed item (shown, copied, a one-time code), for the audit trail. The server cannot stop it, but it is recorded.</summary>
    public async Task SealedEventAsync(Guid id, VaultItemEventRequest req, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (_, me) = Who();
        var (item, c, _) = await ItemAsync(id, VaultAccess.View, ct);
        if (!item.Sealed) throw new ConflictException("This item is not sealed.", "VAULT_NOT_SEALED");
        var action = (req.Action ?? "").Trim();
        if (!SealedUseEvents.Contains(action)) throw new ValidationException("action", "Unknown event.");
        item.LastUsedAt = clock.Now; item.LastUsedBy = me;
        recorder.Audit($"vault.{action}", "VaultItem", item.Id, null, new { collection = c.Name, field = Clip(req.Field, 60), sealedItem = true });
        await db.SaveChangesAsync(ct);
    }

    public async Task<VaultSealedFileDto> AddSealedFileAsync(Guid id, string wrapped, Stream content, long length, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (tid, me) = Who();
        var (item, c, _) = await ItemAsync(id, VaultAccess.Manage, ct);
        if (!item.Sealed) throw new ConflictException("This item is not sealed.", "VAULT_NOT_SEALED");
        if (c.RekeyNeeded) throw new ConflictException("Make the collection's new key first.", "VAULT_REKEY_NEEDED");
        if (length > MaxAttachmentBytes + 1024) throw new ValidationException("file", "A file kept in the vault can be up to 2 MB.");
        if (await db.VaultAttachments.CountAsync(a => a.ItemId == id, ct) >= MaxAttachments) throw new ValidationException("file", $"An item keeps at most {MaxAttachments} files.");
        using var ms = new MemoryStream();
        await content.CopyToAsync(ms, ct);
        if (ms.Length > MaxAttachmentBytes + 1024) throw new ValidationException("file", "A file kept in the vault can be up to 2 MB.");
        var att = new VaultAttachment { TenantId = tid, ItemId = id, FileName = "sealed", ContentType = "application/octet-stream", SizeBytes = ms.Length, Cipher = ms.ToArray(),
            WrappedItemKey = B64(wrapped, "wrapped", 500, 20), KeyVersion = c.SealedKeyVersion, Sealed = true, CreatedAt = clock.Now, CreatedBy = me };
        db.VaultAttachments.Add(att);
        recorder.Audit("vault.file_added", "VaultItem", id, null, new { collection = c.Name, sealedItem = true });
        await db.SaveChangesAsync(ct);
        return new VaultSealedFileDto(att.Id, att.KeyVersion, att.WrappedItemKey, att.SizeBytes, att.CreatedAt);
    }

    public async Task<byte[]> SealedFileAsync(Guid attachmentId, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var att = await db.VaultAttachments.AsNoTracking().FirstOrDefaultAsync(a => a.Id == attachmentId, ct) ?? throw new NotFoundException("File not found.", "VAULT_NOT_FOUND");
        var (item, c, _) = await ItemAsync(att.ItemId, VaultAccess.View, ct);
        if (!att.Sealed) throw new ConflictException("This file is not sealed.", "VAULT_NOT_SEALED");
        recorder.Audit("vault.revealed", "VaultItem", item.Id, null, new { collection = c.Name, field = "file", sealedItem = true });
        await db.SaveChangesAsync(ct);
        return att.Cipher;
    }

    // ------------------------------------------------------------------ breach checks without the password leaving the browser

    /// <summary>The breached-password range for a five-character hash prefix (the browser hashes; only the prefix reaches here).</summary>
    public async Task<string> BreachRangeAsync(string prefix, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var p = (prefix ?? "").Trim().ToUpperInvariant();
        if (!HashPrefix().IsMatch(p)) throw new ValidationException("prefix", "Five hexadecimal characters.");
        return await breaches.RangeAsync(p, ct);
    }
    [GeneratedRegex("^[0-9A-F]{5}$")] private static partial Regex HashPrefix();

    // ------------------------------------------------------------------ linking a new device

    public async Task<VaultDeviceLinkDto> RequestDeviceLinkAsync(VaultDeviceLinkRequest req, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (tid, me) = Who();
        if (!await db.VaultIdentities.AnyAsync(i => i.UserId == me, ct)) throw new ConflictException("Set up your vault keys first.", "VAULT_NO_KEYS");
        var open = await db.VaultDeviceLinks.CountAsync(l => l.UserId == me && l.CompletedAt == null && !l.Denied && l.ExpiresAt > clock.Now, ct);
        if (open >= 3) throw new TooManyRequestsException("Too many devices are waiting. Approve or refuse them first.", "VAULT_LIMITED");
        var link = new VaultDeviceLink
        {
            TenantId = tid, UserId = me, Label = Clip(req.Label, 80) ?? "A new device", X25519Public = B64(req.X25519Public, "x25519Public", 64, 40), MlKemPublic = B64(req.MlKemPublic, "mlKemPublic", 2000, 1500),
            ExpiresAt = clock.Now.AddMinutes(DeviceLinkMinutes), IpAddress = Clip(ctx.IpAddress, 64), UserAgent = Clip(ctx.UserAgent, 300), CreatedAt = clock.Now, CreatedBy = me,
        };
        db.VaultDeviceLinks.Add(link);
        recorder.Audit("vault.device_link_requested", "User", me, null, new { link.Label });
        await db.SaveChangesAsync(ct);
        return DeviceDto(link, includeEnvelope: false);
    }

    private static VaultDeviceLinkDto DeviceDto(VaultDeviceLink l, bool includeEnvelope) =>
        new(l.Id, l.Label, l.X25519Public, l.MlKemPublic, l.CreatedAt, l.ExpiresAt, l.IpAddress, l.UserAgent, l.ApprovedAt != null, l.Denied, includeEnvelope ? l.Envelope : null, includeEnvelope ? l.Signature : null);

    /// <summary>Devices of mine waiting to be approved (shown on a device that is unlocked).</summary>
    public async Task<IReadOnlyList<VaultDeviceLinkDto>> PendingDeviceLinksAsync(CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (_, me) = Who();
        var rows = await db.VaultDeviceLinks.AsNoTracking().Where(l => l.UserId == me && l.ApprovedAt == null && !l.Denied && l.ExpiresAt > clock.Now).OrderByDescending(l => l.CreatedAt).ToListAsync(ct);
        return rows.Select(l => DeviceDto(l, false)).ToList();
    }

    /// <summary>Approve (with the identity secret encrypted to the new device's one-time keys, after the codes matched) or refuse.</summary>
    public async Task ApproveDeviceLinkAsync(Guid id, VaultDeviceApproveRequest req, bool approve, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (_, me) = Who();
        var l = await db.VaultDeviceLinks.FirstOrDefaultAsync(x => x.Id == id && x.UserId == me, ct) ?? throw new NotFoundException("Not found.", "VAULT_NOT_FOUND");
        if (l.ExpiresAt <= clock.Now || l.ApprovedAt != null || l.Denied) throw new ConflictException("That request has ended. Start again on the new device.", "VAULT_LINK_ENDED");
        if (approve) { l.Envelope = B64(req.Envelope, "envelope", 4000, 1500); l.Signature = B64(req.Signature, "signature", 120, 80); l.ApprovedAt = clock.Now; }
        else l.Denied = true;
        recorder.Audit(approve ? "vault.device_linked" : "vault.device_refused", "User", me, null, new { l.Label, l.IpAddress });
        await db.SaveChangesAsync(ct);
    }

    /// <summary>The new device asks whether it was approved; the envelope is handed over once and then deleted.</summary>
    public async Task<VaultDeviceLinkDto> DeviceLinkStatusAsync(Guid id, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (_, me) = Who();
        var l = await db.VaultDeviceLinks.FirstOrDefaultAsync(x => x.Id == id && x.UserId == me, ct) ?? throw new NotFoundException("Not found.", "VAULT_NOT_FOUND");
        var dto = DeviceDto(l, includeEnvelope: l.ApprovedAt != null && l.CompletedAt == null);
        if (l.ApprovedAt != null && l.CompletedAt == null) { l.CompletedAt = clock.Now; l.Envelope = null; await db.SaveChangesAsync(ct); }
        return dto;
    }
}
