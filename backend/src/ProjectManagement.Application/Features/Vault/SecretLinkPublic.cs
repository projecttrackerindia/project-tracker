using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Vault;

public record SecretLinkInfoDto(string State, string? Note, string? From, string? Workspace, bool HasPassphrase, string? Salt, string? Params, DateTime? ExpiresAt, int ViewsLeft);
public record SecretLinkOpenDto(string Cipher, int ViewsLeft);

/// <summary>
/// Opening a self-destructing link, without signing in: the token in the address finds it (only its hash is stored), the first request only
/// describes it (so a chat app's link preview does not use it up), and opening hands out the ciphertext — the last allowed opening destroys
/// it. The key to read it is in the link's #fragment, which browsers never send: nothing here can read the secret.
/// </summary>
public class SecretLinkPublic(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder)
{
    public static string Hash(string token) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token))).ToLowerInvariant();

    private async Task<VaultSecretLink?> FindAsync(string token, CancellationToken ct)
    {
        var t = (token ?? "").Trim();
        if (t.Length is < 20 or > 100) return null;
        var hash = Hash(t);
        // A link is found by its token alone, before any workspace is known: the hash is unique across workspaces.
        return await db.VaultSecretLinks.IgnoreQueryFilters().FirstOrDefaultAsync(l => l.TokenHash == hash, ct);
    }

    private bool Live(VaultSecretLink l) => l.RevokedAt == null && l.BurnedAt == null && l.ExpiresAt > clock.Now && l.Views < l.MaxViews && l.Cipher.Length > 0;
    private static readonly SecretLinkInfoDto Gone = new("gone", null, null, null, false, null, null, null, 0);

    public async Task<SecretLinkInfoDto> InfoAsync(string token, CancellationToken ct = default)
    {
        var l = await FindAsync(token, ct);
        if (l is null || !Live(l)) return Gone;   // used, revoked, expired or never existed: one answer for all
        var from = l.CreatedBy is { } by ? await db.Users.AsNoTracking().Where(u => u.Id == by).Select(u => u.DisplayName).FirstOrDefaultAsync(ct) : null;
        var ws = await db.Tenants.IgnoreQueryFilters().AsNoTracking().Where(t => t.Id == l.TenantId).Select(t => t.Name).FirstOrDefaultAsync(ct);
        return new SecretLinkInfoDto("ready", l.Note, from, ws, l.HasPassphrase, l.Salt, l.Params, l.ExpiresAt, l.MaxViews - l.Views);
    }

    public async Task<SecretLinkOpenDto> OpenAsync(string token, CancellationToken ct = default)
    {
        var l = await FindAsync(token, ct);
        if (l is null || !Live(l)) throw new NotFoundException("This link was already opened, was revoked, or has expired.", "LINK_GONE");
        l.Views++;
        l.LastOpenedAt = clock.Now;
        l.LastOpenedIp = Text.Truncate(ctx.IpAddress, 64);
        var cipher = l.Cipher;
        var left = l.MaxViews - l.Views;
        if (left <= 0) { l.BurnedAt = clock.Now; l.Cipher = ""; }
        recorder.Audit("vault.link_opened", l.ItemId is null ? "User" : "VaultItem", l.ItemId ?? l.CreatedBy, null, new { link = l.Id, viewsLeft = left, burned = left <= 0 }, tenantId: l.TenantId, userId: null);
        if (l.CreatedBy is { } owner)
            db.Notifications.Add(new Notification
            {
                TenantId = l.TenantId, UserId = owner, Type = NotificationType.Security, CreatedAt = clock.Now,
                Title = left <= 0 ? "Your one-time link was opened and destroyed" : $"Your secret link was opened ({left} more allowed)",
                Body = $"{(l.Note is { Length: > 0 } n ? $"“{Text.Truncate(n, 80)}”. " : "")}If you did not expect this, change the secret.", Link = "/vault?view=links",
            });
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateConcurrencyException) { throw new NotFoundException("This link was already opened, was revoked, or has expired.", "LINK_GONE"); }
        return new SecretLinkOpenDto(cipher, Math.Max(0, left));
    }
}
