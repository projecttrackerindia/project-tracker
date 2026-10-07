using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Documents;

public sealed record DataKey(int Version, byte[] Key);

/// <summary>
/// Envelope encryption for sensitive values. Each workspace has its own data key (AES-256); the platform's master key only ever wraps data keys, so rotating a
/// workspace's key re-encrypts its values without touching the master. A value's ciphertext is bound to the workspace, document and row (additional data),
/// so ciphertext copied to another row or workspace does not open.
/// </summary>
public class EnvelopeCrypto(IAppDbContext db, ISecretProtector protector, AppClock clock)
{
    private readonly Dictionary<(Guid, int), DataKey> _cache = [];

    public async Task<DataKey> ActiveKeyAsync(Guid tenantId, CancellationToken ct = default)
    {
        var row = await db.DocumentKeys.IgnoreQueryFilters().Where(k => k.TenantId == tenantId && k.Active).OrderByDescending(k => k.Version).FirstOrDefaultAsync(ct);
        if (row is null)
        {
            row = await CreateAsync(tenantId, 1, ct);   // two first writes at the same instant: the loser gets a conflict and retries
        }
        return Open(row);
    }

    public async Task<DataKey> KeyAsync(Guid tenantId, int version, CancellationToken ct = default)
    {
        if (_cache.TryGetValue((tenantId, version), out var hit)) return hit;
        var row = await db.DocumentKeys.IgnoreQueryFilters().FirstOrDefaultAsync(k => k.TenantId == tenantId && k.Version == version, ct)
            ?? throw new InvalidOperationException("The data key for this value is missing.");
        return Open(row);
    }

    /// <summary>Makes a new active key; the previous one stays readable until every value has moved to the new one.</summary>
    public async Task<DataKey> RotateAsync(Guid tenantId, CancellationToken ct = default)
    {
        var rows = await db.DocumentKeys.IgnoreQueryFilters().Where(k => k.TenantId == tenantId).ToListAsync(ct);
        foreach (var k in rows.Where(k => k.Active)) { k.Active = false; k.RetiredAt = clock.Now; }
        var created = await CreateAsync(tenantId, (rows.Count == 0 ? 0 : rows.Max(k => k.Version)) + 1, ct);
        return Open(created);
    }

    private async Task<DocumentKey> CreateAsync(Guid tenantId, int version, CancellationToken ct)
    {
        var key = RandomNumberGenerator.GetBytes(32);
        var row = new DocumentKey { TenantId = tenantId, Version = version, Active = true, WrappedKey = protector.Protect(Convert.ToBase64String(key)), CreatedAt = clock.Now };
        db.DocumentKeys.Add(row);
        await db.SaveChangesAsync(ct);
        _cache[(tenantId, version)] = new DataKey(version, key);
        return row;
    }

    private DataKey Open(DocumentKey row)
    {
        if (_cache.TryGetValue((row.TenantId, row.Version), out var hit)) return hit;
        var key = new DataKey(row.Version, Convert.FromBase64String(protector.Unprotect(row.WrappedKey)));
        _cache[(row.TenantId, row.Version)] = key;
        return key;
    }

    public string Encrypt(DataKey key, string plain, string aad)
    {
        var nonce = RandomNumberGenerator.GetBytes(12);
        var data = Encoding.UTF8.GetBytes(plain);
        var cipher = new byte[data.Length]; var tag = new byte[16];
        using var gcm = new AesGcm(key.Key, 16);
        gcm.Encrypt(nonce, data, cipher, tag, Encoding.UTF8.GetBytes(aad));
        return Convert.ToBase64String([.. nonce, .. tag, .. cipher]);
    }

    public string Decrypt(DataKey key, string cipherText, string aad)
    {
        var all = Convert.FromBase64String(cipherText);
        if (all.Length < 28) throw new CryptographicException("Too short.");
        var plain = new byte[all.Length - 28];
        using var gcm = new AesGcm(key.Key, 16);
        gcm.Decrypt(all.AsSpan(0, 12), all.AsSpan(28), all.AsSpan(12, 16), plain, Encoding.UTF8.GetBytes(aad));
        return Encoding.UTF8.GetString(plain);
    }
}
