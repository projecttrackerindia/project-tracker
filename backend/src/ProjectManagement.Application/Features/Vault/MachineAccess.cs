using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Distributed;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Vault;

public record MachineVariable(string Name, string Value);
public record MachineSecretsDto(string Collection, IReadOnlyList<MachineVariable> Variables);

/// <summary>
/// A GitHub Actions run reading a guarded collection. The run proves who it is with the OpenID Connect token GitHub mints for it (signed
/// by GitHub, for our audience, naming the repository, branch and environment, valid minutes); we check the signature against GitHub's
/// published keys and every claim against the binding, refuse a token used before, then hand over the collection's values. No password or
/// API key is stored anywhere for this.
/// </summary>
public class MachineAccess(IAppDbContext db, IHttpClientFactory http, IDistributedCache cache, AppClock clock, Recorder recorder, VaultService vault)
{
    public const string Issuer = "https://token.actions.githubusercontent.com";
    private static readonly ConcurrentDictionary<string, (RSA Key, DateTime Until)> Keys = new();

    private static UnauthorizedException Denied(string why) => new($"This pipeline may not read the vault: {why}", "MACHINE_DENIED");

    public async Task<MachineSecretsDto> ReadAsync(Guid bindingId, string? authorization, CancellationToken ct = default)
    {
        var token = authorization is { } a && a.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) ? a[7..].Trim() : null;
        if (string.IsNullOrEmpty(token)) throw Denied("send the run's GitHub OIDC token as Authorization: Bearer.");
        // Found by id alone, before any workspace is known: the token must then be for exactly this binding's workspace and repository.
        var m = await db.VaultMachineBindings.IgnoreQueryFilters().FirstOrDefaultAsync(x => x.Id == bindingId && x.DisabledAt == null, ct) ?? throw Denied("unknown or removed.");
        var c = await db.VaultCollections.IgnoreQueryFilters().AsNoTracking().FirstOrDefaultAsync(x => x.Id == m.CollectionId && x.TenantId == m.TenantId, ct);
        if (c is null || c.Sealed || c.LockedAt != null || c.ArchivedAt != null) throw Denied("the collection is not available.");

        var claims = await VerifyAsync(token, ct);
        string Claim(string name) => claims.TryGetValue(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
        var aud = claims.TryGetValue("aud", out var audEl) ? audEl : default;
        var expected = VaultService.MachineAudience(m.TenantId);
        var audOk = aud.ValueKind == JsonValueKind.String ? aud.GetString() == expected : aud.ValueKind == JsonValueKind.Array && aud.EnumerateArray().Any(x => x.ValueKind == JsonValueKind.String && x.GetString() == expected);
        if (!audOk) throw Denied($"request the token with audience {expected}.");
        if (!string.Equals(Claim("repository"), m.Repository, StringComparison.OrdinalIgnoreCase)) throw Denied("a different repository.");
        var repoId = Claim("repository_id");
        if (m.RepositoryId is not null && m.RepositoryId != repoId) throw Denied("the repository was replaced (its id changed).");
        var gitRef = Claim("ref");
        if (!RefMatches(m.RefPattern, gitRef)) throw Denied($"{gitRef} is not an allowed branch or tag.");
        if (m.Environment is not null && !string.Equals(Claim("environment"), m.Environment, StringComparison.Ordinal)) throw Denied($"the job must run in the {m.Environment} environment.");

        // Each token is used once (the jti), for as long as it could otherwise be replayed.
        var jti = Claim("jti");
        if (jti.Length is < 8 or > 200) throw Denied("the token has no id.");
        var seenKey = $"vault-oidc-jti:{jti}";
        if (await cache.GetStringAsync(seenKey, ct) is not null) throw Denied("this token was already used.");
        var exp = claims.TryGetValue("exp", out var e) && e.ValueKind == JsonValueKind.Number && e.TryGetInt64(out var secs) ? DateTimeOffset.FromUnixTimeSeconds(secs).UtcDateTime : clock.Now.AddMinutes(10);
        await cache.SetStringAsync(seenKey, "1", new DistributedCacheEntryOptions { AbsoluteExpiration = new DateTimeOffset(exp.AddMinutes(2), TimeSpan.Zero) }, ct);

        var vars = await vault.MachineVariablesAsync(m.TenantId, c.Id, ct);
        if (m.RepositoryId is null && repoId.Length > 0) m.RepositoryId = repoId;   // pinned on first use
        var run = Claim("run_id");
        m.LastUsedAt = clock.Now;
        m.LastRun = Cut(Claim("repository") + "#" + run + " " + Claim("workflow"), 200);
        recorder.Audit("vault.machine_read", "VaultCollection", c.Id, null, new
        {
            collection = c.Name, repository = Claim("repository"), @ref = gitRef, environment = Claim("environment"), workflow = Claim("workflow"), run, sha = Claim("sha"), actor = Claim("actor"), variables = vars.Count,
        }, tenantId: m.TenantId, userId: null);
        await db.SaveChangesAsync(ct);
        return new MachineSecretsDto(c.Name, vars.Select(v => new MachineVariable(v.Name, v.Value)).ToList());
    }

    private static string Cut(string s, int max) => s.Length <= max ? s : s[..max];

    /// <summary>A branch or tag pattern: * matches within one path segment, ** (or a lone *) anything.</summary>
    public static bool RefMatches(string pattern, string gitRef)
    {
        if (pattern == "*") return gitRef.StartsWith("refs/", StringComparison.Ordinal);
        var re = "^" + Regex.Escape(pattern).Replace(@"\*\*", "\u0001").Replace(@"\*", "[^/]*").Replace("\u0001", ".*") + "$";
        return Regex.IsMatch(gitRef, re, RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
    }

    // ------------------------------------------------------------------ the token

    private static byte[] B64Url(string s)
    {
        var t = s.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(t + new string('=', (4 - t.Length % 4) % 4));
    }

    private async Task<Dictionary<string, JsonElement>> VerifyAsync(string jwt, CancellationToken ct)
    {
        var parts = jwt.Split('.');
        if (parts.Length != 3 || jwt.Length > 8000) throw Denied("not a token.");
        Dictionary<string, JsonElement> header, payload;
        try
        {
            header = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(B64Url(parts[0]))!;
            payload = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(B64Url(parts[1]))!;
        }
        catch (Exception e) when (e is FormatException or JsonException or ArgumentException) { throw Denied("not a token."); }
        static string Str(Dictionary<string, JsonElement> d, string n) => d.TryGetValue(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
        if (Str(header, "alg") != "RS256") throw Denied("unexpected signature algorithm.");
        var kid = Str(header, "kid");
        if (Str(payload, "iss") != Issuer) throw Denied("not issued by GitHub Actions.");

        var key = await KeyAsync(kid, ct) ?? throw Denied("signed with an unknown key.");
        var signed = Encoding.ASCII.GetBytes(parts[0] + "." + parts[1]);
        byte[] sig;
        try { sig = B64Url(parts[2]); } catch (FormatException) { throw Denied("not a token."); }
        if (!key.VerifyData(signed, sig, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1)) throw Denied("the signature does not match.");

        var now = clock.Now;
        long Num(string n) => payload.TryGetValue(n, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var x) ? x : 0;
        var exp = Num("exp"); var nbf = Num("nbf"); var iat = Num("iat");
        var unix = new DateTimeOffset(now, TimeSpan.Zero).ToUnixTimeSeconds();
        if (exp == 0 || unix > exp + 60) throw Denied("the token expired.");
        if ((nbf != 0 && unix < nbf - 60) || (iat != 0 && unix < iat - 60)) throw Denied("the token is not valid yet.");
        if (exp - (iat == 0 ? unix : iat) > 3600) throw Denied("the token lives too long.");
        return payload;
    }

    /// <summary>GitHub's signing keys, fetched from its published key set and kept for an hour; an unknown key id fetches again (key rotation).</summary>
    private async Task<RSA?> KeyAsync(string kid, CancellationToken ct)
    {
        if (Keys.TryGetValue(kid, out var hit) && hit.Until > DateTime.UtcNow) return hit.Key;
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(5));
            var client = http.CreateClient("github-oidc");
            using var res = await client.GetAsync(Issuer + "/.well-known/jwks", timeout.Token);
            if (!res.IsSuccessStatusCode) return null;
            using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync(timeout.Token));
            foreach (var jwk in doc.RootElement.GetProperty("keys").EnumerateArray())
            {
                if (jwk.TryGetProperty("kty", out var kty) && kty.GetString() != "RSA") continue;
                var id = jwk.TryGetProperty("kid", out var kv) ? kv.GetString() ?? "" : "";
                var rsa = RSA.Create();
                rsa.ImportParameters(new RSAParameters { Modulus = B64Url(jwk.GetProperty("n").GetString()!), Exponent = B64Url(jwk.GetProperty("e").GetString()!) });
                Keys[id] = (rsa, DateTime.UtcNow.AddHours(1));
            }
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or JsonException or KeyNotFoundException or FormatException or CryptographicException) { return null; }
        return Keys.TryGetValue(kid, out var now) ? now.Key : null;
    }
}
