using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Integrations;

public record ApiKeyDto(Guid Id, string Name, string Prefix, ApiKeyScope Scope, string Owner, DateTime CreatedAt, DateTime? ExpiresAt, DateTime? LastUsedAt,
    string? LastUsedIp, DateTime? RevokedAt, string Status);
/// <summary>The one time the secret is ever visible.</summary>
public record CreatedApiKeyDto(ApiKeyDto Key, string Secret);
public record CreateApiKeyRequest(string Name, ApiKeyScope Scope, int? ExpiresInDays);

/// <summary>Who a valid API key stands for.</summary>
public record ApiKeyIdentity(Guid KeyId, Guid UserId, Guid TenantId, ApiKeyScope Scope);

public static class ApiKeyFormat
{
    public const string Marker = "pmk_";

    public static bool LooksLikeKey(string? token) => token is { Length: > 20 } && token.StartsWith(Marker, StringComparison.Ordinal);

    /// <summary>Splits "pmk_ab12cd34_secret" into its lookup prefix and secret.</summary>
    public static bool TrySplit(string token, out string prefix, out string secret)
    {
        prefix = secret = "";
        var i = token.IndexOf('_', Marker.Length);
        if (i < 0 || i == token.Length - 1) return false;
        prefix = token[..i]; secret = token[(i + 1)..];
        return prefix.Length == Marker.Length + 8;
    }

    public static string Hash(string secret) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(secret))).ToLowerInvariant();
}

/// <summary>Checks a presented key on every request. Runs before the request context exists, so it reads the database directly.</summary>
public class ApiKeyAuthenticator(IAppDbContext db, TimeProvider time, EntitlementService entitlements)
{
    /// <summary>Keys are only honoured while the workspace's plan includes API access, so a downgrade switches them off without revoking them.</summary>
    public async Task<bool> PlanAllowsAsync(Guid tenantId, CancellationToken ct) =>
        (await entitlements.GetEntitlementsAsync(tenantId, ct)).GetValueOrDefault(FeatureKeys.ApiAccess) > 0;

    private static readonly TimeSpan TouchEvery = TimeSpan.FromMinutes(1);

    public async Task<ApiKeyIdentity?> AuthenticateAsync(string token, string? ip, CancellationToken ct)
    {
        if (!ApiKeyFormat.TrySplit(token, out var prefix, out var secret)) return null;
        var now = time.GetUtcNow().UtcDateTime;
        var key = await db.ApiKeys.IgnoreQueryFilters().AsNoTracking().FirstOrDefaultAsync(k => k.Prefix == prefix, ct);

        // Compare against a hash even when the prefix is unknown, so timing does not reveal which prefixes exist.
        var given = Encoding.ASCII.GetBytes(ApiKeyFormat.Hash(secret));
        var expected = Encoding.ASCII.GetBytes(key?.SecretHash ?? new string('0', 64));
        if (!CryptographicOperations.FixedTimeEquals(given, expected) || key is null) return null;
        if (key.RevokedAt is not null || (key.ExpiresAt is { } exp && exp <= now)) return null;

        var owner = await db.Users.IgnoreQueryFilters().AsNoTracking().Where(u => u.Id == key.UserId).Select(u => u.IsActive).FirstOrDefaultAsync(ct);
        if (!owner) return null;

        if (key.LastUsedAt is null || now - key.LastUsedAt > TouchEvery)
            await db.ApiKeys.IgnoreQueryFilters().Where(k => k.Id == key.Id).ExecuteUpdateAsync(s => s.SetProperty(k => k.LastUsedAt, now).SetProperty(k => k.LastUsedIp, ip), ct);
        return new ApiKeyIdentity(key.Id, key.UserId, key.TenantId, key.Scope);
    }
}

/// <summary>Creating, listing and revoking a workspace's API keys. Owners and admins only, on plans that include API access.</summary>
public class ApiKeyService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, EntitlementService entitlements)
{
    private const int MaxActive = 20;
    private static readonly int[] AllowedExpiry = [30, 90, 365];

    private void RequireAdmin()
    {
        if (ctx.Role is not (TenantRole.Owner or TenantRole.Admin))
            throw new ForbiddenException("Only owners and admins can manage API keys.", "PERMISSION_DENIED");
    }

    private ApiKeyDto ToDto(ApiKey k, string owner)
    {
        var now = clock.Now;
        var status = k.RevokedAt is not null ? "Revoked" : k.ExpiresAt is { } e && e <= now ? "Expired" : "Active";
        return new ApiKeyDto(k.Id, k.Name, k.Prefix, k.Scope, owner, k.CreatedAt, k.ExpiresAt, k.LastUsedAt, k.LastUsedIp, k.RevokedAt, status);
    }

    public async Task<IReadOnlyList<ApiKeyDto>> ListAsync(CancellationToken ct = default)
    {
        RequireAdmin();
        var rows = await db.ApiKeys.AsNoTracking().Include(k => k.User).OrderByDescending(k => k.CreatedAt).Take(200).ToListAsync(ct);
        return rows.Select(k => ToDto(k, k.User?.DisplayName ?? "Unknown")).ToList();
    }

    public async Task<CreatedApiKeyDto> CreateAsync(CreateApiKeyRequest req, CancellationToken ct = default)
    {
        RequireAdmin();
        await entitlements.EnsureFeatureAsync(FeatureKeys.ApiAccess, ct);
        var name = (req.Name ?? "").Trim();
        if (name.Length is < 1 or > 60) throw new ValidationException("name", "Give the key a name (up to 60 characters), for example the tool that will use it.");
        if (!Enum.IsDefined(req.Scope)) throw new ValidationException("scope", "Unknown access level.");
        if (req.ExpiresInDays is { } d && !AllowedExpiry.Contains(d)) throw new ValidationException("expiresInDays", "Choose 30, 90 or 365 days, or no expiry.");
        var now = clock.Now;
        if (await db.ApiKeys.CountAsync(k => k.RevokedAt == null && (k.ExpiresAt == null || k.ExpiresAt > now), ct) >= MaxActive)
            throw new ConflictException($"A workspace can have at most {MaxActive} active API keys. Revoke one you no longer use.", "LIMIT_REACHED");

        string prefix;
        do { prefix = ApiKeyFormat.Marker + Convert.ToHexString(RandomNumberGenerator.GetBytes(4)).ToLowerInvariant(); }
        while (await db.ApiKeys.IgnoreQueryFilters().AnyAsync(k => k.Prefix == prefix, ct));
        var secret = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', 'A'); // 256 bits, no separator characters

        var key = new ApiKey
        {
            TenantId = ctx.RequireTenantId(), UserId = ctx.RequireUserId(), Name = name, Prefix = prefix, SecretHash = ApiKeyFormat.Hash(secret), Scope = req.Scope,
            ExpiresAt = req.ExpiresInDays is { } days ? now.AddDays(days) : null, CreatedAt = now, CreatedBy = ctx.UserId,
        };
        db.ApiKeys.Add(key);
        recorder.Audit("apikey.created", "ApiKey", key.Id, newValue: new { key.Name, key.Prefix, key.Scope, key.ExpiresAt });
        await db.SaveChangesAsync(ct);
        var owner = await db.Users.Where(u => u.Id == key.UserId).Select(u => u.DisplayName).FirstAsync(ct);
        return new CreatedApiKeyDto(ToDto(key, owner), $"{prefix}_{secret}");
    }

    public async Task RevokeAsync(Guid id, CancellationToken ct = default)
    {
        RequireAdmin(); // revoking stays possible after a downgrade
        var key = await db.ApiKeys.FirstOrDefaultAsync(k => k.Id == id, ct) ?? throw new NotFoundException("API key not found.");
        if (key.RevokedAt is not null) return;
        key.RevokedAt = clock.Now; key.RevokedBy = ctx.UserId;
        recorder.Audit("apikey.revoked", "ApiKey", id, oldValue: new { key.Name, key.Prefix });
        await db.SaveChangesAsync(ct);
    }
}
