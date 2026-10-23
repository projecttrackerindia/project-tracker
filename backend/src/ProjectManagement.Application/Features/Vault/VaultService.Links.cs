using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Vault;

public record CreateSecretLinkRequest(string? TokenHash, Guid? ItemId, string? Note, string? Cipher, int MaxViews, int Hours, bool HasPassphrase, string? Salt, string? Params, string? StepUp);
public record SecretLinkDto(Guid Id, string? Note, Guid? ItemId, string? ItemTitle, DateTime CreatedAt, DateTime ExpiresAt, int Views, int MaxViews, bool HasPassphrase, string State, DateTime? LastOpenedAt);

/// <summary>
/// Self-destructing links, from the signed-in side: make one (for an item the person may copy, or for a secret typed on the spot), see
/// their own links and whether each was opened, and revoke one. The secret is encrypted in the browser with a key that only the link's
/// #fragment carries; what arrives here cannot be read.
/// </summary>
public partial class VaultService
{
    public static readonly int[] LinkHours = [1, 24, 72, 168];
    public const int MaxLinkViews = 5, MaxOpenLinks = 50, MaxLinkCipherChars = 140_000;

    public async Task<SecretLinkDto> CreateSecretLinkAsync(CreateSecretLinkRequest req, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (tid, me) = Who();
        var hash = (req.TokenHash ?? "").Trim().ToLowerInvariant();
        if (!TokenHashForm().IsMatch(hash)) throw new ValidationException("tokenHash", "The link's token hash is not in the expected form.");
        if (!LinkHours.Contains(req.Hours)) throw new ValidationException("hours", "Choose 1 hour, a day, 3 days or a week.");
        if (req.MaxViews < 1 || req.MaxViews > MaxLinkViews) throw new ValidationException("maxViews", $"A link opens 1 to {MaxLinkViews} times.");
        var cipher = B64(req.Cipher, "cipher", MaxLinkCipherChars, 40);
        string? salt = null, prm = null;
        if (req.HasPassphrase)
        {
            salt = B64(req.Salt, "salt", 64, 16);
            prm = (req.Params ?? "").Trim();
            if (!LinkParams().IsMatch(prm)) throw new ValidationException("params", "Unknown passphrase settings.");
        }
        string? title = null;
        if (req.ItemId is { } itemId)
        {
            // Only what the person may copy, and with the same checks as a copy (two-step, approval, risk, decoys) for a guarded item.
            var (item, c, access) = await ItemAsync(itemId, VaultAccess.View, ct);
            if (item.UseOnly) throw new ForbiddenException("A use-only item cannot be sent: nobody may see its value.", "VAULT_USE_ONLY");
            if (!item.Sealed) await GuardAsync(item, c, "link", req.StepUp, ct);
            title = item.Title;
            _ = access;
        }
        var open = await db.VaultSecretLinks.CountAsync(l => l.CreatedBy == me && l.BurnedAt == null && l.RevokedAt == null && l.ExpiresAt > clock.Now, ct);
        if (open >= MaxOpenLinks) throw new TooManyRequestsException("You have many open links. Revoke the ones you no longer need.", "VAULT_LIMITED");
        if (await db.VaultSecretLinks.IgnoreQueryFilters().AnyAsync(l => l.TokenHash == hash, ct)) throw new ConflictException("Make the link again.", "VAULT_LINK_EXISTS");
        var link = new VaultSecretLink
        {
            TenantId = tid, TokenHash = hash, ItemId = req.ItemId, Note = Clip(req.Note, 200), Cipher = cipher, HasPassphrase = req.HasPassphrase, Salt = salt, Params = prm,
            MaxViews = req.MaxViews, ExpiresAt = clock.Now.AddHours(req.Hours), CreatedAt = clock.Now, CreatedBy = me,
        };
        db.VaultSecretLinks.Add(link);
        recorder.Audit("vault.link_created", req.ItemId is null ? "User" : "VaultItem", req.ItemId ?? me, null,
            new { item = title, views = req.MaxViews, hours = req.Hours, passphrase = req.HasPassphrase });
        await db.SaveChangesAsync(ct);
        return LinkDto(link, title);
    }
    [GeneratedRegex("^[0-9a-f]{64}$")] private static partial Regex TokenHashForm();
    [GeneratedRegex(@"^argon2id;m=\d{4,6};t=\d;p=\d$")] private static partial Regex LinkParams();

    private SecretLinkDto LinkDto(VaultSecretLink l, string? title) => new(l.Id, l.Note, l.ItemId, title, l.CreatedAt, l.ExpiresAt, l.Views, l.MaxViews, l.HasPassphrase,
        l.RevokedAt != null ? "revoked" : l.BurnedAt != null ? "used" : l.ExpiresAt <= clock.Now ? "expired" : "open", l.LastOpenedAt);

    /// <summary>The person's own links of the last 30 days.</summary>
    public async Task<IReadOnlyList<SecretLinkDto>> MySecretLinksAsync(CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (_, me) = Who();
        var since = clock.Now.AddDays(-30);
        var rows = await db.VaultSecretLinks.AsNoTracking().Where(l => l.CreatedBy == me && l.CreatedAt > since).OrderByDescending(l => l.CreatedAt).Take(100).ToListAsync(ct);
        var ids = rows.Where(r => r.ItemId != null).Select(r => r.ItemId!.Value).Distinct().ToList();
        var titles = await db.VaultItems.AsNoTracking().Where(i => ids.Contains(i.Id) && !i.Sealed).ToDictionaryAsync(i => i.Id, i => i.Title, ct);
        return rows.Select(r => LinkDto(r, r.ItemId is { } i ? titles.GetValueOrDefault(i) : null)).ToList();
    }

    public async Task RevokeSecretLinkAsync(Guid id, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (_, me) = Who();
        var l = await db.VaultSecretLinks.FirstOrDefaultAsync(x => x.Id == id && x.CreatedBy == me, ct) ?? throw new NotFoundException("Not found.", "VAULT_NOT_FOUND");
        if (l.RevokedAt != null || l.BurnedAt != null) return;
        l.RevokedAt = clock.Now; l.Cipher = "";
        recorder.Audit("vault.link_revoked", "User", me, null, new { link = id });
        await db.SaveChangesAsync(ct);
    }
}
