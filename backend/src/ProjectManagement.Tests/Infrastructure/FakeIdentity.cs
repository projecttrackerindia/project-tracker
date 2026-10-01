using System.Collections.Concurrent;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;
using ProjectManagement.Application.Features.Sso;

namespace ProjectManagement.Tests.Infrastructure;

/// <summary>
/// Stands in for every OpenID Connect provider the API talks to (https://idp.test, https://accounts.google.com ...): discovery, signing keys
/// and a token endpoint that signs real RS256 ID tokens. A test registers what a code should sign in as with <see cref="Issue"/>.
/// </summary>
public sealed class FakeIdentityProvider : HttpMessageHandler
{
    private readonly RSA _key = RSA.Create(2048);
    private const string Kid = "test-key-1";
    private readonly ConcurrentDictionary<string, (Dictionary<string, object> Claims, string? Verifier)> _codes = new();
    public ConcurrentBag<Dictionary<string, string>> TokenRequests { get; } = new();

    /// <summary>A code the token endpoint will exchange for an ID token carrying these claims (sub, email, nonce ...).</summary>
    public string Issue(Dictionary<string, object> claims, string? expectVerifier = null)
    {
        var code = Convert.ToHexString(RandomNumberGenerator.GetBytes(12));
        _codes[code] = (claims, expectVerifier);
        return code;
    }

    private static string Issuer(Uri u) => $"{u.Scheme}://{u.Host}";

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        var u = request.RequestUri!;
        var issuer = Issuer(u);
        if (u.AbsolutePath.EndsWith("/.well-known/openid-configuration"))
            return Json(new
            {
                issuer, authorization_endpoint = $"{issuer}/authorize", token_endpoint = $"{issuer}/token", jwks_uri = $"{issuer}/jwks",
                response_types_supported = new[] { "code" }, subject_types_supported = new[] { "public" }, id_token_signing_alg_values_supported = new[] { "RS256" },
            });
        if (u.AbsolutePath == "/jwks")
        {
            var p = _key.ExportParameters(false);
            return Json(new { keys = new[] { new { kty = "RSA", use = "sig", alg = "RS256", kid = Kid, n = Base64UrlEncoder.Encode(p.Modulus), e = Base64UrlEncoder.Encode(p.Exponent) } } });
        }
        if (u.AbsolutePath == "/token" && request.Method == HttpMethod.Post)
        {
            var form = (await request.Content!.ReadAsStringAsync(ct)).Split('&').Select(x => x.Split('=', 2))
                .ToDictionary(x => Uri.UnescapeDataString(x[0]), x => Uri.UnescapeDataString(x.ElementAtOrDefault(1) ?? "").Replace('+', ' '));
            TokenRequests.Add(form);
            if (!_codes.TryRemove(form.GetValueOrDefault("code") ?? "", out var grant)) return Json(new { error = "invalid_grant" }, HttpStatusCode.BadRequest);
            if (grant.Verifier is not null && form.GetValueOrDefault("code_verifier") != grant.Verifier) return Json(new { error = "invalid_grant", error_description = "PKCE" }, HttpStatusCode.BadRequest);
            var now = DateTime.UtcNow;
            var token = new JsonWebTokenHandler().CreateToken(new SecurityTokenDescriptor
            {
                Issuer = issuer, Audience = form["client_id"], IssuedAt = now, NotBefore = now, Expires = now.AddMinutes(5), Claims = grant.Claims,
                SigningCredentials = new SigningCredentials(new RsaSecurityKey(_key) { KeyId = Kid }, SecurityAlgorithms.RsaSha256),
            });
            return Json(new { id_token = token, access_token = "at", token_type = "Bearer" });
        }
        return new HttpResponseMessage(HttpStatusCode.NotFound);
    }

    private static HttpResponseMessage Json(object body, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json") };
}

/// <summary>DNS for tests: a domain "has" a TXT record once a test publishes it.</summary>
public sealed class FakeDns : IDomainVerifier
{
    private readonly ConcurrentDictionary<(string, string), bool> _records = new();
    public void Publish(string domain, string value) => _records[(domain, value)] = true;
    public Task<bool> HasTxtRecordAsync(string domain, string expected, CancellationToken ct = default) => Task.FromResult(_records.ContainsKey((domain, expected)));
}
