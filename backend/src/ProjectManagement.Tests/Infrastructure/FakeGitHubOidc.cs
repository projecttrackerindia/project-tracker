using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace ProjectManagement.Tests.Infrastructure;

/// <summary>Stands in for GitHub Actions' OpenID Connect issuer: publishes a signing key and mints run tokens a test describes.</summary>
public sealed class FakeGitHubOidc : HttpMessageHandler
{
    public RSA Key { get; } = RSA.Create(2048);
    public string Kid { get; } = "test-" + Guid.NewGuid().ToString("N")[..12];
    public int KeyFetches;

    private static string B64(byte[] b) => Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        Interlocked.Increment(ref KeyFetches);
        var p = Key.ExportParameters(false);
        var body = JsonSerializer.Serialize(new { keys = new[] { new { kty = "RSA", kid = Kid, alg = "RS256", use = "sig", n = B64(p.Modulus!), e = B64(p.Exponent!) } } });
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") });
    }

    /// <summary>A token as GitHub would mint it for a run; <paramref name="change"/> adjusts the claims, <paramref name="signer"/> signs instead of the published key.</summary>
    public string Mint(string repository, string audience, string gitRef = "refs/heads/main", string? environment = null, string repositoryId = "123456",
        Action<Dictionary<string, object?>>? change = null, RSA? signer = null, string alg = "RS256", TimeSpan? age = null)
    {
        var now = DateTimeOffset.UtcNow - (age ?? TimeSpan.Zero);
        var claims = new Dictionary<string, object?>
        {
            ["iss"] = "https://token.actions.githubusercontent.com", ["aud"] = audience, ["sub"] = $"repo:{repository}:ref:{gitRef}",
            ["repository"] = repository, ["repository_id"] = repositoryId, ["repository_owner"] = repository.Split('/')[0], ["ref"] = gitRef,
            ["sha"] = "0123456789abcdef0123456789abcdef01234567", ["workflow"] = "Deploy", ["run_id"] = "987654321", ["actor"] = "asha-rao",
            ["event_name"] = "push", ["jti"] = Guid.NewGuid().ToString(), ["iat"] = now.ToUnixTimeSeconds(), ["nbf"] = now.ToUnixTimeSeconds(), ["exp"] = now.AddMinutes(5).ToUnixTimeSeconds(),
        };
        if (environment is not null) claims["environment"] = environment;
        change?.Invoke(claims);
        var header = B64(JsonSerializer.SerializeToUtf8Bytes(new { alg, kid = Kid, typ = "JWT" }));
        var payload = B64(JsonSerializer.SerializeToUtf8Bytes(claims.Where(kv => kv.Value is not null).ToDictionary(kv => kv.Key, kv => kv.Value)));
        var sig = (signer ?? Key).SignData(Encoding.ASCII.GetBytes(header + "." + payload), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        return $"{header}.{payload}.{B64(sig)}";
    }
}
