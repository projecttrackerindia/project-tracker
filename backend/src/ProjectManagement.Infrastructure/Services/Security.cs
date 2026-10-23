using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Infrastructure.Services;

public class JwtOptions
{
    public const string Section = "Jwt";
    public string Issuer { get; set; } = "projectmanagement";
    public string Audience { get; set; } = "projectmanagement-web";
    /// <summary>HMAC signing key (>= 32 bytes). Supply through user-secrets / environment / a vault — never commit real keys.</summary>
    public string SigningKey { get; set; } = "";
    public int AccessTokenMinutes { get; set; } = 15;
}

public static class JwtClaims
{
    public const string SessionId = "sid";
    public const string WorkspaceId = "wid";
}

/// <summary>PBKDF2 hashing via ASP.NET Core Identity's PasswordHasher (versioned, salted, upgradeable).</summary>
public class PasswordHasherAdapter : Application.Abstractions.IPasswordHasher
{
    private readonly PasswordHasher<object> _hasher = new();

    public string Hash(string password) => _hasher.HashPassword(null!, password);

    /// <summary>False for accounts without a password of their own (made by single sign-on or a social sign-in) and for malformed hashes.</summary>
    public bool Verify(string hash, string password)
    {
        if (string.IsNullOrEmpty(hash) || hash == Application.Abstractions.PasswordHashes.None) return false;
        try { return _hasher.VerifyHashedPassword(null!, hash, password) != PasswordVerificationResult.Failed; }
        catch (FormatException) { return false; }
    }
}

public class TokenService(IOptions<JwtOptions> options, TimeProvider clock) : ITokenService
{
    private readonly JwtOptions _opt = options.Value;
    private readonly JsonWebTokenHandler _handler = new();

    public static SymmetricSecurityKey KeyFrom(string signingKey) => new(Encoding.UTF8.GetBytes(signingKey));

    public AccessToken CreateAccessToken(User user, Guid sessionId, Guid? workspaceId)
    {
        var now = clock.GetUtcNow().UtcDateTime;
        var expires = now.AddMinutes(_opt.AccessTokenMinutes);
        var claims = new Dictionary<string, object>
        {
            [JwtRegisteredClaimNames.Sub] = user.Id.ToString(),
            [JwtRegisteredClaimNames.Jti] = Guid.NewGuid().ToString("N"),
            [JwtRegisteredClaimNames.Email] = user.Email,
            [JwtClaims.SessionId] = sessionId.ToString(),
        };
        if (workspaceId is { } wid) claims[JwtClaims.WorkspaceId] = wid.ToString();

        var descriptor = new SecurityTokenDescriptor
        {
            Issuer = _opt.Issuer, Audience = _opt.Audience, IssuedAt = now, NotBefore = now, Expires = expires,
            Claims = claims,
            SigningCredentials = new SigningCredentials(KeyFrom(_opt.SigningKey), SecurityAlgorithms.HmacSha256),
        };
        return new AccessToken(_handler.CreateToken(descriptor), expires);
    }

    // ---- two-step verification challenge: "<userId>.<expiry>" signed with a key derived from (not equal to) the JWT key
    private byte[] ChallengeKey => HKDF.DeriveKey(HashAlgorithmName.SHA256, Encoding.UTF8.GetBytes(_opt.SigningKey), 32, info: Encoding.UTF8.GetBytes("pm-mfa-challenge"));
    private static string B64(byte[] b) => Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    private static byte[] FromB64(string s) => Convert.FromBase64String(s.Replace('-', '+').Replace('_', '/').PadRight(s.Length + (4 - s.Length % 4) % 4, '='));

    public string CreateChallenge(Guid userId, TimeSpan lifetime)
    {
        var payload = Encoding.UTF8.GetBytes($"{userId:N}.{clock.GetUtcNow().Add(lifetime).ToUnixTimeSeconds()}");
        return $"{B64(payload)}.{B64(HMACSHA256.HashData(ChallengeKey, payload))}";
    }

    public Guid? ReadChallenge(string token)
    {
        try
        {
            var parts = token.Split('.');
            if (parts.Length != 2) return null;
            var payload = FromB64(parts[0]);
            if (!CryptographicOperations.FixedTimeEquals(HMACSHA256.HashData(ChallengeKey, payload), FromB64(parts[1]))) return null;
            var fields = Encoding.UTF8.GetString(payload).Split('.');
            if (fields.Length != 2 || !long.TryParse(fields[1], out var expiry) || expiry < clock.GetUtcNow().ToUnixTimeSeconds()) return null;
            return Guid.TryParseExact(fields[0], "N", out var id) ? id : null;
        }
        catch (FormatException) { return null; }
    }

    /// <summary>256-bit random token; only its SHA-256 hash is ever stored.</summary>
    public (string Raw, string Hash) CreateOpaqueToken()
    {
        var raw = Base64Url(RandomNumberGenerator.GetBytes(32));
        return (raw, Hash(raw));
    }

    public string Hash(string rawToken) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(rawToken)));

    private static string Base64Url(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}

public class MfaOptions
{
    public const string Section = "Mfa";
    /// <summary>Key that encrypts authenticator secrets. When empty, one is derived from the JWT signing key (rotating that key then invalidates enrolments, so set this in production).</summary>
    public string? EncryptionKey { get; set; }
    /// <summary>
    /// The same key, encrypted by Google Cloud KMS (base64 of the KMS ciphertext). When set with <see cref="KmsKeyName"/>, the key is never in the
    /// server settings in clear: it is unwrapped by KMS once at start-up (with the machine's own service account), and lives only in memory.
    /// </summary>
    public string? EncryptionKeyWrapped { get; set; }
    /// <summary>projects/P/locations/L/keyRings/R/cryptoKeys/K</summary>
    public string? KmsKeyName { get; set; }
}

/// <summary>
/// Unwraps the master key with Google Cloud KMS: an access token from the machine's metadata server (the VM's or Cloud Run's service account,
/// which needs the CryptoKey Decrypter role), then KMS decrypt. Fails loudly: running with a different key would make every stored secret unreadable.
/// </summary>
public static class KmsMasterKey
{
    private const string Metadata = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

    public static string Unwrap(string keyName, string wrappedBase64, HttpMessageHandler? handler = null)
    {
        if (!System.Text.RegularExpressions.Regex.IsMatch(keyName, @"^projects/[^/]+/locations/[^/]+/keyRings/[^/]+/cryptoKeys/[^/]+$"))
            throw new InvalidOperationException("Mfa:KmsKeyName must look like projects/P/locations/L/keyRings/R/cryptoKeys/K.");
        using var http = handler is null ? new HttpClient() : new HttpClient(handler, disposeHandler: false);
        http.Timeout = TimeSpan.FromSeconds(15);
        using var tokenReq = new HttpRequestMessage(HttpMethod.Get, Metadata);
        tokenReq.Headers.Add("Metadata-Flavor", "Google");
        using var tokenRes = http.Send(tokenReq);
        if (!tokenRes.IsSuccessStatusCode) throw new InvalidOperationException($"KMS: the metadata server gave no token ({(int)tokenRes.StatusCode}).");
        var token = System.Text.Json.JsonDocument.Parse(tokenRes.Content.ReadAsStream()).RootElement.GetProperty("access_token").GetString();
        using var req = new HttpRequestMessage(HttpMethod.Post, $"https://cloudkms.googleapis.com/v1/{keyName}:decrypt")
        {
            Content = new StringContent(System.Text.Json.JsonSerializer.Serialize(new { ciphertext = wrappedBase64.Trim() }), Encoding.UTF8, "application/json"),
        };
        req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        using var res = http.Send(req);
        var body = new StreamReader(res.Content.ReadAsStream()).ReadToEnd();
        if (!res.IsSuccessStatusCode) throw new InvalidOperationException($"KMS could not unwrap the master key ({(int)res.StatusCode}). Check the key name and that the service account may decrypt with it.");
        var plain = System.Text.Json.JsonDocument.Parse(body).RootElement.GetProperty("plaintext").GetString() ?? "";
        return Encoding.UTF8.GetString(Convert.FromBase64String(plain));
    }
}

/// <summary>AES-256-GCM: every value gets its own random nonce and is authenticated, so tampering is detected.</summary>
public class AesSecretProtector(IOptions<JwtOptions> jwt, IOptions<MfaOptions> mfa) : ISecretProtector
{
    private readonly byte[] _key = HKDF.DeriveKey(HashAlgorithmName.SHA256, Encoding.UTF8.GetBytes(Material(jwt.Value, mfa.Value)), 32, info: Encoding.UTF8.GetBytes("pm-mfa-secret"));

    /// <summary>The key material: unwrapped by KMS when a wrapped key is configured, else the configured key, else the JWT signing key.</summary>
    private static string Material(JwtOptions jwt, MfaOptions mfa)
    {
        if (!string.IsNullOrWhiteSpace(mfa.EncryptionKeyWrapped))
        {
            if (string.IsNullOrWhiteSpace(mfa.KmsKeyName)) throw new InvalidOperationException("Mfa:EncryptionKeyWrapped is set without Mfa:KmsKeyName.");
            return KmsMasterKey.Unwrap(mfa.KmsKeyName, mfa.EncryptionKeyWrapped);
        }
        return string.IsNullOrWhiteSpace(mfa.EncryptionKey) ? jwt.SigningKey : mfa.EncryptionKey;
    }

    public string Protect(string plainText)
    {
        var nonce = RandomNumberGenerator.GetBytes(12);
        var plain = Encoding.UTF8.GetBytes(plainText);
        var cipher = new byte[plain.Length];
        var tag = new byte[16];
        using var aes = new AesGcm(_key, 16);
        aes.Encrypt(nonce, plain, cipher, tag);
        return Convert.ToBase64String([.. nonce, .. tag, .. cipher]);
    }

    public string Unprotect(string protectedText)
    {
        var all = Convert.FromBase64String(protectedText);
        var plain = new byte[all.Length - 28];
        using var aes = new AesGcm(_key, 16);
        aes.Decrypt(all.AsSpan(0, 12), all.AsSpan(28), all.AsSpan(12, 16), plain);
        return Encoding.UTF8.GetString(plain);
    }
}
