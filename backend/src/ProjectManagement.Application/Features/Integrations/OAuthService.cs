using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Integrations;

public record OAuthRegisterRequest(string? ClientName, IReadOnlyList<string>? RedirectUris, string? ClientUri, string? LogoUri);
public record OAuthClientInfo(string ClientId, string Name, string? ClientUri, string? LogoUri, bool RedirectAllowed, bool Known);
public record OAuthConsentRequest(string ClientId, string RedirectUri, string? State, string CodeChallenge, string? CodeChallengeMethod, string? Scope, string? Resource, bool Approve);
public record OAuthConsentResult(string Redirect);
public record OAuthTokenResult(string AccessToken, string TokenType, int ExpiresIn, string RefreshToken, string Scope);
public record ConnectedAppDto(Guid Id, string ClientName, string ClientId, string Person, bool Mine, string Scope, DateTime CreatedAt, DateTime? LastUsedAt);

/// <summary>An OAuth error in the shape RFC 6749 asks for: {"error": code, "error_description": text}.</summary>
public class OAuthException(string error, string description, int status = 400) : Exception(description)
{
    public string Error { get; } = error;
    public int Status { get; } = status;
}

/// <summary>
/// Connected apps: OAuth 2.1 for MCP clients such as Claude and ChatGPT. The app registers itself, sends the person to the consent page
/// (authorization code with PKCE, S256 only), and swaps the code for a one-hour access token plus a rotating refresh token. An access
/// token is an API key linked to the grant, so the MCP server and every endpoint behind it apply the person's own role and permissions,
/// limited to reading unless they allowed changes. Works on every plan; revoking the connection ends every token at once.
/// </summary>
public class OAuthService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, IOptions<AppOptions> app)
{
    public const string ScopeRead = "mcp:read", ScopeWrite = "mcp:write";
    public const int AccessSeconds = 3600, RefreshDays = 60, CodeMinutes = 5, MaxRedirects = 10;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public string Issuer => app.Value.WebBaseUrl.TrimEnd('/');
    public string Resource => $"{Issuer}/api/v1/mcp";

    public JsonObject AuthorizationServerMetadata() => new()
    {
        ["issuer"] = Issuer,
        ["authorization_endpoint"] = $"{Issuer}/oauth/authorize",
        ["token_endpoint"] = $"{Issuer}/oauth/token",
        ["registration_endpoint"] = $"{Issuer}/oauth/register",
        ["revocation_endpoint"] = $"{Issuer}/oauth/revoke",
        ["response_types_supported"] = new JsonArray("code"),
        ["grant_types_supported"] = new JsonArray("authorization_code", "refresh_token"),
        ["code_challenge_methods_supported"] = new JsonArray("S256"),
        ["token_endpoint_auth_methods_supported"] = new JsonArray("none"),
        ["scopes_supported"] = new JsonArray(ScopeRead, ScopeWrite),
        ["service_documentation"] = $"{Issuer}/features/connect-ai/",
    };

    public JsonObject ProtectedResourceMetadata() => new()
    {
        ["resource"] = Resource,
        ["authorization_servers"] = new JsonArray(Issuer),
        ["scopes_supported"] = new JsonArray(ScopeRead, ScopeWrite),
        ["bearer_methods_supported"] = new JsonArray("header"),
        ["resource_name"] = "ProjectTracker",
        ["resource_documentation"] = $"{Issuer}/features/connect-ai/",
    };

    private static string Hash(string s) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(s))).ToLowerInvariant();
    private static string Token(int bytes = 32) => Convert.ToBase64String(RandomNumberGenerator.GetBytes(bytes)).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    /// <summary>https anywhere, or http only on this machine (local MCP clients); no fragments.</summary>
    private static bool ValidRedirect(string uri) =>
        uri.Length <= 500 && Uri.TryCreate(uri, UriKind.Absolute, out var u) && string.IsNullOrEmpty(u.Fragment) &&
        (u.Scheme == Uri.UriSchemeHttps || (u.Scheme == Uri.UriSchemeHttp && (u.IsLoopback || u.Host == "localhost")));

    private static List<string> Redirects(OAuthClient c) => JsonSerializer.Deserialize<List<string>>(c.RedirectUrisJson, Json) ?? [];

    // ------------------------------------------------------------------ registration (RFC 7591)

    public async Task<JsonObject> RegisterAsync(OAuthRegisterRequest req, CancellationToken ct)
    {
        var uris = (req.RedirectUris ?? []).Select(u => (u ?? "").Trim()).Where(u => u.Length > 0).Distinct().ToList();
        if (uris.Count is 0 or > MaxRedirects || uris.Any(u => !ValidRedirect(u)))
            throw new OAuthException("invalid_redirect_uri", "Give 1 to 10 redirect URIs: https, or http on localhost.");
        var name = (req.ClientName ?? "").Trim();
        if (name.Length == 0) name = new Uri(uris[0]).Host;
        if (name.Length > 120) name = name[..120];
        static string? Url(string? u) => u is { Length: > 0 and <= 500 } && Uri.TryCreate(u, UriKind.Absolute, out var x) && x.Scheme == Uri.UriSchemeHttps ? u : null;
        var client = new OAuthClient
        {
            ClientId = "ptc_" + Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant(), Name = name, RedirectUrisJson = JsonSerializer.Serialize(uris, Json),
            ClientUri = Url(req.ClientUri), LogoUri = Url(req.LogoUri), CreatedAt = clock.Now,
        };
        db.OAuthClients.Add(client);
        await db.SaveChangesAsync(ct);
        return new JsonObject
        {
            ["client_id"] = client.ClientId, ["client_name"] = client.Name, ["redirect_uris"] = new JsonArray(uris.Select(u => (JsonNode)u).ToArray()),
            ["grant_types"] = new JsonArray("authorization_code", "refresh_token"), ["response_types"] = new JsonArray("code"),
            ["token_endpoint_auth_method"] = "none", ["client_id_issued_at"] = new DateTimeOffset(client.CreatedAt).ToUnixTimeSeconds(),
        };
    }

    // ------------------------------------------------------------------ the consent page

    public async Task<OAuthClientInfo> ClientInfoAsync(string clientId, string redirectUri, CancellationToken ct)
    {
        var c = await db.OAuthClients.AsNoTracking().FirstOrDefaultAsync(x => x.ClientId == clientId, ct);
        if (c is null) return new OAuthClientInfo(clientId, "Unknown app", null, null, false, false);
        return new OAuthClientInfo(c.ClientId, c.Name, c.ClientUri, c.LogoUri, Redirects(c).Contains(redirectUri), true);
    }

    /// <summary>The signed-in person approves (or declines) the app for the workspace they are in; the answer goes back to the app's redirect.</summary>
    public async Task<OAuthConsentResult> ConsentAsync(OAuthConsentRequest req, CancellationToken ct)
    {
        var tenant = ctx.RequireTenantId(); var user = ctx.RequireUserId();
        if (ctx.ViaApiKey) throw new ForbiddenException("Connect apps from the signed-in app, not with an API key.");
        var client = await db.OAuthClients.FirstOrDefaultAsync(x => x.ClientId == req.ClientId, ct) ?? throw new ValidationException("clientId", "This app is not registered.");
        if (!Redirects(client).Contains(req.RedirectUri)) throw new ValidationException("redirectUri", "This app did not register that return address.");
        string Back(params (string K, string? V)[] q)
        {
            var sep = req.RedirectUri.Contains('?') ? "&" : "?";
            return req.RedirectUri + sep + string.Join("&", q.Where(x => x.V is not null).Select(x => $"{x.K}={Uri.EscapeDataString(x.V!)}"));
        }
        if (!req.Approve) return new(Back(("error", "access_denied"), ("error_description", "The person declined."), ("state", req.State), ("iss", Issuer)));
        if ((req.CodeChallengeMethod ?? "S256") != "S256" || req.CodeChallenge is not { Length: >= 43 and <= 128 })
            return new(Back(("error", "invalid_request"), ("error_description", "PKCE with S256 is required."), ("state", req.State), ("iss", Issuer)));
        if (req.Resource is { Length: > 0 } res && !string.Equals(res.TrimEnd('/'), Resource, StringComparison.OrdinalIgnoreCase) && !string.Equals(res.TrimEnd('/'), Issuer, StringComparison.OrdinalIgnoreCase))
            return new(Back(("error", "invalid_target"), ("error_description", "Unknown resource."), ("state", req.State), ("iss", Issuer)));
        var wanted = (req.Scope ?? "").Split(' ', StringSplitOptions.RemoveEmptyEntries);
        var scope = wanted.Contains(ScopeWrite) ? $"{ScopeRead} {ScopeWrite}" : ScopeRead;

        var code = Token();
        db.OAuthCodes.Add(new OAuthCode
        {
            CodeHash = Hash(code), ClientId = client.ClientId, UserId = user, TenantId = tenant, RedirectUri = req.RedirectUri, CodeChallenge = req.CodeChallenge,
            Scope = scope, Resource = req.Resource, ExpiresAt = clock.Now.AddMinutes(CodeMinutes), CreatedAt = clock.Now, CreatedBy = user,
        });
        recorder.Audit("oauth.app_connected", "OAuthClient", client.Id, null, new { client.Name, client.ClientId, scope });
        await db.SaveChangesAsync(ct);
        return new(Back(("code", code), ("state", req.State), ("iss", Issuer)));
    }

    // ------------------------------------------------------------------ tokens

    private async Task<(ApiKey Key, string Secret)> IssueAccessKeyAsync(OAuthGrant grant, CancellationToken ct)
    {
        string prefix;
        do { prefix = ApiKeyFormat.Marker + Convert.ToHexString(RandomNumberGenerator.GetBytes(4)).ToLowerInvariant(); }
        while (await db.ApiKeys.IgnoreQueryFilters().AnyAsync(k => k.Prefix == prefix, ct));
        var secret = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', 'A');
        var name = $"{grant.ClientName} (connected app)";
        var key = new ApiKey
        {
            TenantId = grant.TenantId, UserId = grant.UserId, Name = name.Length > 60 ? name[..60] : name, Prefix = prefix, SecretHash = ApiKeyFormat.Hash(secret),
            Scope = grant.Scope.Contains(ScopeWrite) ? ApiKeyScope.ReadWrite : ApiKeyScope.ReadOnly, ExpiresAt = clock.Now.AddSeconds(AccessSeconds),
            OAuthGrantId = grant.Id, CreatedAt = clock.Now, CreatedBy = grant.UserId,
        };
        db.ApiKeys.Add(key);
        return (key, $"{prefix}_{secret}");
    }

    private static bool Pkce(string verifier, string challenge)
    {
        if (verifier.Length is < 43 or > 128) return false;
        var computed = Convert.ToBase64String(SHA256.HashData(Encoding.ASCII.GetBytes(verifier))).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        return CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(computed), Encoding.ASCII.GetBytes(challenge));
    }

    public async Task<OAuthTokenResult> TokenAsync(IReadOnlyDictionary<string, string> form, CancellationToken ct)
    {
        string F(string k) => form.TryGetValue(k, out var v) ? v.Trim() : "";
        var grantType = F("grant_type");
        var now = clock.Now;
        if (grantType == "authorization_code")
        {
            var codeHash = Hash(F("code"));
            var code = await db.OAuthCodes.FirstOrDefaultAsync(c => c.CodeHash == codeHash, ct);
            if (code is null || code.ExpiresAt <= now) throw new OAuthException("invalid_grant", "The code is not valid or has expired.");
            if (code.UsedAt is not null)
            {
                // A code used twice may have been stolen: end what the first use produced.
                foreach (var g in await db.OAuthGrants.IgnoreQueryFilters().Where(g => g.TenantId == code.TenantId && g.UserId == code.UserId && g.ClientId == code.ClientId && g.CreatedAt >= code.CreatedAt && g.RevokedAt == null).ToListAsync(ct))
                    await RevokeGrantAsync(g, ct);
                await db.SaveChangesAsync(ct);
                throw new OAuthException("invalid_grant", "The code was already used.");
            }
            code.UsedAt = now;   // one try only, right or wrong
            await db.SaveChangesAsync(ct);
            if (code.ClientId != F("client_id") || code.RedirectUri != F("redirect_uri")) throw new OAuthException("invalid_grant", "The code was issued to another app or return address.");
            if (!Pkce(F("code_verifier"), code.CodeChallenge)) throw new OAuthException("invalid_grant", "The code verifier does not match.");
            var client = await db.OAuthClients.FirstAsync(c => c.ClientId == code.ClientId, ct);
            client.LastUsedAt = now;
            var refresh = Token();
            var grant = new OAuthGrant
            {
                TenantId = code.TenantId, UserId = code.UserId, ClientId = client.ClientId, ClientName = client.Name, Scope = code.Scope, RefreshHash = Hash(refresh),
                RefreshExpiresAt = now.AddDays(RefreshDays), LastUsedAt = now, CreatedAt = now, CreatedBy = code.UserId,
            };
            db.OAuthGrants.Add(grant);
            var (key, secret) = await IssueAccessKeyAsync(grant, ct);
            grant.AccessKeyId = key.Id;
            await db.SaveChangesAsync(ct);
            return new OAuthTokenResult(secret, "Bearer", AccessSeconds, refresh, grant.Scope);
        }
        if (grantType == "refresh_token")
        {
            var hash = Hash(F("refresh_token"));
            var grant = await db.OAuthGrants.IgnoreQueryFilters().FirstOrDefaultAsync(g => g.RefreshHash == hash, ct);
            if (grant is null || grant.RevokedAt is not null || grant.RefreshExpiresAt <= now) throw new OAuthException("invalid_grant", "The refresh token is not valid. Connect the app again.");
            if (F("client_id") is { Length: > 0 } cid && cid != grant.ClientId) throw new OAuthException("invalid_grant", "The refresh token belongs to another app.");
            var active = await db.Users.IgnoreQueryFilters().AnyAsync(u => u.Id == grant.UserId && u.IsActive, ct)
                && await db.TenantMembers.IgnoreQueryFilters().AnyAsync(m => m.TenantId == grant.TenantId && m.UserId == grant.UserId, ct);
            if (!active) { await RevokeGrantAsync(grant, ct); await db.SaveChangesAsync(ct); throw new OAuthException("invalid_grant", "This person no longer has access to the workspace."); }
            if (grant.AccessKeyId is { } old)
                await db.ApiKeys.IgnoreQueryFilters().Where(k => k.Id == old && k.RevokedAt == null).ExecuteUpdateAsync(s => s.SetProperty(k => k.RevokedAt, now), ct);
            var refresh = Token();
            grant.RefreshHash = Hash(refresh); grant.RefreshExpiresAt = now.AddDays(RefreshDays); grant.LastUsedAt = now;
            var (key, secret) = await IssueAccessKeyAsync(grant, ct);
            grant.AccessKeyId = key.Id;
            await db.SaveChangesAsync(ct);
            return new OAuthTokenResult(secret, "Bearer", AccessSeconds, refresh, grant.Scope);
        }
        throw new OAuthException("unsupported_grant_type", "Use authorization_code or refresh_token.");
    }

    private async Task RevokeGrantAsync(OAuthGrant grant, CancellationToken ct)
    {
        var now = clock.Now;
        grant.RevokedAt ??= now;
        await db.ApiKeys.IgnoreQueryFilters().Where(k => k.OAuthGrantId == grant.Id && k.RevokedAt == null).ExecuteUpdateAsync(s => s.SetProperty(k => k.RevokedAt, now), ct);
    }

    /// <summary>RFC 7009: a refresh or access token the app no longer needs. Unknown tokens are ignored, as the RFC asks.</summary>
    public async Task RevokeTokenAsync(string token, CancellationToken ct)
    {
        token = (token ?? "").Trim();
        if (token.Length == 0) return;
        OAuthGrant? grant = null;
        if (ApiKeyFormat.TrySplit(token, out var prefix, out _))
        {
            var key = await db.ApiKeys.IgnoreQueryFilters().AsNoTracking().FirstOrDefaultAsync(k => k.Prefix == prefix && k.OAuthGrantId != null, ct);
            if (key is not null && key.SecretHash == ApiKeyFormat.Hash(token[(prefix.Length + 1)..])) grant = await db.OAuthGrants.IgnoreQueryFilters().FirstOrDefaultAsync(g => g.Id == key.OAuthGrantId, ct);
        }
        else
        {
            var hash = Hash(token);
            grant = await db.OAuthGrants.IgnoreQueryFilters().FirstOrDefaultAsync(g => g.RefreshHash == hash, ct);
        }
        if (grant is null) return;
        await RevokeGrantAsync(grant, ct);
        await db.SaveChangesAsync(ct);
    }

    // ------------------------------------------------------------------ the person's (and the admin's) list of connected apps

    private bool IsAdmin => ctx.Role is TenantRole.Owner or TenantRole.Admin;

    public async Task<IReadOnlyList<ConnectedAppDto>> ListAsync(CancellationToken ct)
    {
        var me = ctx.RequireUserId();
        var q = db.OAuthGrants.AsNoTracking().Where(g => g.RevokedAt == null && g.RefreshExpiresAt > clock.Now);
        if (!IsAdmin) q = q.Where(g => g.UserId == me);
        var rows = await (from g in q join u in db.Users.AsNoTracking() on g.UserId equals u.Id orderby g.CreatedAt descending
                          select new { g, u.DisplayName }).Take(200).ToListAsync(ct);
        return rows.Select(r => new ConnectedAppDto(r.g.Id, r.g.ClientName, r.g.ClientId, r.DisplayName, r.g.UserId == me, r.g.Scope, r.g.CreatedAt, r.g.LastUsedAt)).ToList();
    }

    public async Task DisconnectAsync(Guid id, CancellationToken ct)
    {
        var me = ctx.RequireUserId();
        var grant = await db.OAuthGrants.FirstOrDefaultAsync(g => g.Id == id, ct) ?? throw new NotFoundException("Connected app not found.");
        if (grant.UserId != me && !IsAdmin) throw new ForbiddenException("You can only disconnect your own apps.", "PERMISSION_DENIED");
        await RevokeGrantAsync(grant, ct);
        recorder.Audit("oauth.app_disconnected", "OAuthGrant", grant.Id, new { grant.ClientName, grant.ClientId }, null);
        await db.SaveChangesAsync(ct);
    }
}
