using System.Collections.Concurrent;
using System.Collections.Specialized;
using System.Net.Http.Headers;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using DnsClient;
using ITfoxtec.Identity.Saml2;
using ITfoxtec.Identity.Saml2.Schemas;
using Microsoft.Extensions.Logging;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Protocols;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;
using Microsoft.IdentityModel.Tokens;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Sso;

namespace ProjectManagement.Infrastructure.Services;

/// <summary>
/// OpenID Connect (authorization code with PKCE). Discovery documents and signing keys are cached per provider and refreshed when a token
/// is signed with a key we have not seen yet (providers rotate keys). HTTP goes through the "oidc" client, so tests can stand in for a provider.
/// </summary>
public sealed class OidcProtocol(IHttpClientFactory http, ILogger<OidcProtocol> log) : IOidcProtocol
{
    private readonly ConcurrentDictionary<string, ConfigurationManager<OpenIdConnectConfiguration>> _managers = new();
    private const string MicrosoftConsumers = "9188040d-6c67-4c5b-b112-36a304b66dad";

    private ConfigurationManager<OpenIdConnectConfiguration> ManagerFor(string authority) =>
        _managers.GetOrAdd(authority.TrimEnd('/'), a => new ConfigurationManager<OpenIdConnectConfiguration>(
            $"{a}/.well-known/openid-configuration", new OpenIdConnectConfigurationRetriever(),
            new HttpDocumentRetriever(http.CreateClient("oidc")) { RequireHttps = !IsLocal(a) }));

    private static bool IsLocal(string url) => Uri.TryCreate(url, UriKind.Absolute, out var u) && u.IsLoopback;

    private async Task<OpenIdConnectConfiguration> ConfigAsync(string authority, CancellationToken ct)
    {
        try { return await ManagerFor(authority).GetConfigurationAsync(ct); }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            log.LogWarning(ex, "OpenID Connect discovery failed for {Authority}", authority);
            throw new ValidationException("authority", "The identity provider's discovery document (/.well-known/openid-configuration) could not be read.");
        }
    }

    public async Task<OidcEndpoints> DiscoverAsync(string authority, CancellationToken ct = default)
    {
        var c = await ConfigAsync(authority, ct);
        return new OidcEndpoints(c.Issuer, c.AuthorizationEndpoint, c.TokenEndpoint);
    }

    public async Task<ExternalIdentity> RedeemAsync(OidcRedeemRequest req, CancellationToken ct = default)
    {
        var config = await ConfigAsync(req.Authority, ct);
        var form = new Dictionary<string, string>
        {
            ["grant_type"] = "authorization_code", ["code"] = req.Code, ["redirect_uri"] = req.RedirectUri,
            ["client_id"] = req.ClientId, ["client_secret"] = req.ClientSecret,
        };
        if (!string.IsNullOrEmpty(req.CodeVerifier)) form["code_verifier"] = req.CodeVerifier;   // PKCE (not used by Apple)
        using var tokenResponse = await http.CreateClient("oidc").PostAsync(config.TokenEndpoint, new FormUrlEncodedContent(form), ct);
        var body = await tokenResponse.Content.ReadAsStringAsync(ct);
        if (!tokenResponse.IsSuccessStatusCode)
        {
            log.LogWarning("Token endpoint {Endpoint} answered {Status}: {Body}", config.TokenEndpoint, (int)tokenResponse.StatusCode, body.Length > 300 ? body[..300] : body);
            throw new UnauthorizedException("The identity provider did not accept the sign-in.", "SSO_TOKEN_REJECTED");
        }
        var idToken = JsonDocument.Parse(body).RootElement.TryGetProperty("id_token", out var t) ? t.GetString() : null;
        if (string.IsNullOrEmpty(idToken)) throw new UnauthorizedException("The identity provider returned no ID token.", "SSO_TOKEN_REJECTED");

        var result = await ValidateAsync(req, config, idToken, ct);
        if (!result.IsValid && result.Exception is SecurityTokenSignatureKeyNotFoundException)
        {
            ManagerFor(req.Authority).RequestRefresh();   // keys were rotated: fetch them again, once
            config = await ConfigAsync(req.Authority, ct);
            result = await ValidateAsync(req, config, idToken, ct);
        }
        if (!result.IsValid)
        {
            log.LogWarning(result.Exception, "ID token from {Authority} failed validation", req.Authority);
            throw new UnauthorizedException("The identity provider's answer could not be verified.", "SSO_TOKEN_INVALID");
        }
        var claims = result.ClaimsIdentity.Claims.ToLookup(c => c.Type, c => c.Value);
        string? One(string type) => claims[type].FirstOrDefault();
        if (One("nonce") != req.Nonce) throw new UnauthorizedException("The sign-in answer does not belong to this sign-in.", "SSO_NONCE_MISMATCH");

        var email = One("email");
        if (string.IsNullOrWhiteSpace(email) && req.Issuer == IssuerRule.MicrosoftAnyTenant)
            email = new[] { One("preferred_username"), One("upn") }.FirstOrDefault(v => v?.Contains('@') == true);
        var verified = string.Equals(One("email_verified"), "true", StringComparison.OrdinalIgnoreCase)
            || (req.Issuer == IssuerRule.MicrosoftAnyTenant && (One("tid") == MicrosoftConsumers || string.Equals(One("xms_edov"), "true", StringComparison.OrdinalIgnoreCase)));
        var name = One("name") ?? string.Join(' ', new[] { One("given_name"), One("family_name") }.Where(v => !string.IsNullOrWhiteSpace(v)));
        return new ExternalIdentity(One("sub") ?? throw new UnauthorizedException("The ID token has no subject.", "SSO_TOKEN_INVALID"),
            string.IsNullOrWhiteSpace(email) ? null : email.Trim(), verified, string.IsNullOrWhiteSpace(name) ? null : name.Trim());
    }

    private static Task<TokenValidationResult> ValidateAsync(OidcRedeemRequest req, OpenIdConnectConfiguration config, string idToken, CancellationToken ct)
    {
        var parameters = new TokenValidationParameters
        {
            ValidAudience = req.ClientId, ValidateAudience = true,
            IssuerSigningKeys = config.SigningKeys, ValidateIssuerSigningKey = true,
            ValidateLifetime = true, ClockSkew = TimeSpan.FromMinutes(2),
            ValidateIssuer = true, ValidIssuer = config.Issuer,
        };
        if (req.Issuer == IssuerRule.MicrosoftAnyTenant)
            // Microsoft's common endpoint publishes "https://login.microsoftonline.com/{tenantid}/v2.0": the token must name its own tenant.
            parameters.IssuerValidator = (issuer, token, _) =>
            {
                var tid = (token as JsonWebToken)?.TryGetPayloadValue<string>("tid", out var v) == true ? v : null;
                var expected = config.Issuer.Replace("{tenantid}", tid ?? "", StringComparison.OrdinalIgnoreCase);
                return tid is not null && string.Equals(issuer, expected, StringComparison.OrdinalIgnoreCase) ? issuer
                    : throw new SecurityTokenInvalidIssuerException($"Unexpected issuer {issuer}.");
            };
        return new JsonWebTokenHandler().ValidateTokenAsync(idToken, parameters);
    }
}

/// <summary>GitHub sign-in: OAuth code exchange, then the profile and the verified primary email.</summary>
public sealed class GitHubOAuth(IHttpClientFactory http) : IGitHubOAuth
{
    public async Task<ExternalIdentity> RedeemAsync(string clientId, string clientSecret, string code, string redirectUri, CancellationToken ct = default)
    {
        var client = http.CreateClient("oidc");
        using var tokenReq = new HttpRequestMessage(HttpMethod.Post, "https://github.com/login/oauth/access_token")
        {
            Content = new FormUrlEncodedContent(new Dictionary<string, string> { ["client_id"] = clientId, ["client_secret"] = clientSecret, ["code"] = code, ["redirect_uri"] = redirectUri }),
        };
        tokenReq.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        using var tokenRes = await client.SendAsync(tokenReq, ct);
        var tokenJson = JsonDocument.Parse(await tokenRes.Content.ReadAsStringAsync(ct)).RootElement;
        if (!tokenJson.TryGetProperty("access_token", out var at) || string.IsNullOrEmpty(at.GetString()))
            throw new UnauthorizedException("GitHub did not accept the sign-in.", "SSO_TOKEN_REJECTED");
        var token = at.GetString()!;

        async Task<JsonElement> Get(string url)
        {
            using var r = new HttpRequestMessage(HttpMethod.Get, url);
            r.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            r.Headers.UserAgent.Add(new ProductInfoHeaderValue("ProjectTracker", "1.0"));
            r.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
            using var res = await client.SendAsync(r, ct);
            if (!res.IsSuccessStatusCode) throw new UnauthorizedException("GitHub did not return the profile.", "SSO_TOKEN_REJECTED");
            return JsonDocument.Parse(await res.Content.ReadAsStringAsync(ct)).RootElement.Clone();
        }
        var user = await Get("https://api.github.com/user");
        var emails = await Get("https://api.github.com/user/emails");
        var chosen = emails.EnumerateArray().Where(e => e.GetProperty("verified").GetBoolean())
            .OrderByDescending(e => e.GetProperty("primary").GetBoolean()).Select(e => e.GetProperty("email").GetString()).FirstOrDefault();
        var name = user.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String ? n.GetString() : user.GetProperty("login").GetString();
        return new ExternalIdentity(user.GetProperty("id").GetRawText(), chosen, chosen is not null, name);
    }
}

/// <summary>Apple requires its client secret to be a JWT signed (ES256) with the team's key; it is made fresh for each sign-in.</summary>
public sealed class AppleClientSecret : IAppleClientSecret
{
    public string Create(string teamId, string keyId, string clientId, string privateKeyPem)
    {
        using var ec = ECDsa.Create();
        ec.ImportFromPem(privateKeyPem.Replace("\\n", "\n"));
        var now = DateTime.UtcNow;
        return new JsonWebTokenHandler().CreateToken(new SecurityTokenDescriptor
        {
            Issuer = teamId, Audience = "https://appleid.apple.com", IssuedAt = now, NotBefore = now, Expires = now.AddMinutes(10),
            Claims = new Dictionary<string, object> { ["sub"] = clientId },
            SigningCredentials = new SigningCredentials(new ECDsaSecurityKey(ec) { KeyId = keyId }, SecurityAlgorithms.EcdsaSha256),
        });
    }
}

/// <summary>SAML 2.0 service provider on ITfoxtec.Identity.Saml2: redirect-binding requests, post-binding responses with signature checks.</summary>
public sealed class SamlProtocol : ISamlProtocol
{
    public static X509Certificate2 ReadCertificate(string text)
    {
        var body = text.Trim();
        if (body.Contains("-----BEGIN", StringComparison.Ordinal))
            body = string.Concat(body.Split('\n').Select(l => l.Trim()).Where(l => l.Length > 0 && !l.StartsWith("-----", StringComparison.Ordinal)));
        try { return X509CertificateLoader.LoadCertificate(Convert.FromBase64String(body.Replace("\r", "").Replace("\n", "").Replace(" ", ""))); }
        catch (Exception ex) when (ex is FormatException or CryptographicException)
        { throw new ValidationException("samlCertificate", "The certificate could not be read. Paste the identity provider's signing certificate (PEM or base64)."); }
    }

    private static Saml2Configuration Configure(SamlSettings s)
    {
        var config = new Saml2Configuration
        {
            Issuer = s.SpEntityId,
            SingleSignOnDestination = new Uri(s.IdpSsoUrl),
            AllowedIssuer = s.IdpEntityId,
            // Identity providers usually sign with self-signed certificates: trust is the pinned certificate itself, not a chain.
            CertificateValidationMode = System.ServiceModel.Security.X509CertificateValidationMode.None,
            RevocationMode = X509RevocationMode.NoCheck,
        };
        config.AllowedAudienceUris.Add(s.SpEntityId);
        config.SignatureValidationCertificates.Add(ReadCertificate(s.IdpCertificate));
        return config;
    }

    public SamlRequest CreateRequest(SamlSettings settings, string relayState)
    {
        var config = Configure(settings);
        var binding = new Saml2RedirectBinding();
        binding.SetRelayStateQuery(new Dictionary<string, string> { ["s"] = relayState });
        var request = new Saml2AuthnRequest(config)
        {
            AssertionConsumerServiceUrl = new Uri(settings.AcsUrl),
            NameIdPolicy = new NameIdPolicy { AllowCreate = true, Format = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress" },
        };
        binding.Bind(request);
        return new SamlRequest(binding.RedirectLocation.OriginalString, request.IdAsString);
    }

    public SamlIdentity ReadResponse(SamlSettings settings, IReadOnlyDictionary<string, string> form)
    {
        var config = Configure(settings);
        var formValues = new NameValueCollection();
        foreach (var (k, v) in form) formValues[k] = v;
        var request = new ITfoxtec.Identity.Saml2.Http.HttpRequest { Method = "POST", Form = formValues, Query = new NameValueCollection(), Binding = new Saml2PostBinding() };
        var binding = new Saml2PostBinding();
        var response = new Saml2AuthnResponse(config);
        try
        {
            binding.ReadSamlResponse(request, response);
            if (response.Status != Saml2StatusCodes.Success) throw new UnauthorizedException("The identity provider did not sign you in.", "SSO_REJECTED");
            binding.Unbind(request, response);   // checks the signature, issuer, audience, destination and validity window
        }
        catch (UnauthorizedException) { throw; }
        catch (Exception ex) { throw new UnauthorizedException($"The sign-in answer could not be verified: {ex.Message}", "SSO_TOKEN_INVALID"); }

        var claims = response.ClaimsIdentity.Claims.ToList();
        string? Find(params string[] types) => claims.FirstOrDefault(c => types.Contains(c.Type, StringComparer.OrdinalIgnoreCase))?.Value;
        var nameId = Find(ClaimTypes.NameIdentifier) ?? throw new UnauthorizedException("The sign-in answer has no NameID.", "SSO_TOKEN_INVALID");
        var email = Find(ClaimTypes.Email, "email", "mail", "emailaddress", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress", "urn:oid:0.9.2342.19200300.100.1.3")
            ?? (nameId.Contains('@') ? nameId : null);
        var name = Find(ClaimTypes.Name, "name", "displayName", "http://schemas.microsoft.com/identity/claims/displayname", "urn:oid:2.16.840.1.113730.3.1.241")
            ?? string.Join(' ', new[] { Find(ClaimTypes.GivenName, "givenName", "firstName"), Find(ClaimTypes.Surname, "sn", "surname", "lastName") }.Where(x => !string.IsNullOrWhiteSpace(x)));
        return new SamlIdentity(nameId, email, string.IsNullOrWhiteSpace(name) ? null : name, response.InResponseToAsString);
    }

    public (string Subject, DateTime NotAfter) Inspect(string certificate)
    {
        using var cert = ReadCertificate(certificate);
        return (cert.Subject, cert.NotAfter.ToUniversalTime());
    }
}

/// <summary>Domain ownership by DNS TXT record (looked up through the system's resolvers).</summary>
public sealed class DnsDomainVerifier(ILogger<DnsDomainVerifier> log) : IDomainVerifier
{
    private static readonly LookupClient Lookup = new(new LookupClientOptions { UseCache = false, Timeout = TimeSpan.FromSeconds(5), Retries = 1 });

    public async Task<bool> HasTxtRecordAsync(string domain, string expected, CancellationToken ct = default)
    {
        try
        {
            var result = await Lookup.QueryAsync(domain, QueryType.TXT, cancellationToken: ct);
            return result.Answers.TxtRecords().Any(r => string.Concat(r.Text).Trim() == expected);
        }
        catch (DnsResponseException ex) { log.LogInformation(ex, "TXT lookup for {Domain} failed", domain); return false; }
    }

    public async Task<IReadOnlyList<string>> GetRecordsAsync(string domain, string type, CancellationToken ct = default)
    {
        try
        {
            var result = await Lookup.QueryAsync(domain, type.Equals("CNAME", StringComparison.OrdinalIgnoreCase) ? QueryType.CNAME : QueryType.TXT, cancellationToken: ct);
            return type.Equals("CNAME", StringComparison.OrdinalIgnoreCase) ? result.Answers.CnameRecords().Select(r => r.CanonicalName.Value).ToList() : result.Answers.TxtRecords().Select(r => string.Concat(r.Text).Trim()).ToList();
        }
        catch (Exception ex) when (ex is DnsResponseException or OperationCanceledException == false) { log.LogInformation(ex, "{Type} lookup for {Domain} failed", type, domain); return []; }
    }
}
