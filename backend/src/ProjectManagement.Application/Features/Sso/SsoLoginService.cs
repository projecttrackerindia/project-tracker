using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Distributed;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Admin;
using ProjectManagement.Application.Features.Auth;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Sso;

/// <summary>Sign-in with Google, Microsoft, GitHub and Apple (Auth:{Provider}:*). A provider without its settings is simply not offered.</summary>
public class ExternalAuthOptions
{
    public const string Section = "Auth";
    public OAuthApp Google { get; set; } = new();
    public OAuthApp Microsoft { get; set; } = new();
    public OAuthApp GitHub { get; set; } = new();
    public AppleApp Apple { get; set; } = new();

    public class OAuthApp
    {
        public string? ClientId { get; set; }
        public string? ClientSecret { get; set; }
        public bool Configured => !string.IsNullOrWhiteSpace(ClientId) && !string.IsNullOrWhiteSpace(ClientSecret);
    }

    /// <summary>Apple: the Services ID (ClientId), Team ID, Key ID and the .p8 private key (PEM; "\n" for line breaks is fine).</summary>
    public class AppleApp
    {
        public string? ClientId { get; set; }
        public string? TeamId { get; set; }
        public string? KeyId { get; set; }
        public string? PrivateKey { get; set; }
        public bool Configured => !string.IsNullOrWhiteSpace(ClientId) && !string.IsNullOrWhiteSpace(TeamId) && !string.IsNullOrWhiteSpace(KeyId) && !string.IsNullOrWhiteSpace(PrivateKey);
    }
}

public record ExternalProviderDto(string Id, string Name);
public record SsoDiscoveryDto(bool Sso, string? Name, bool Enforced);
public record UserLoginDto(Guid Id, string Provider, string Name, string? Email, DateTime CreatedAt, DateTime? LastUsedAt);
/// <summary>The end of a redirect sign-in: a session to hand to the browser (or none, when an account was only linked) and where to go.</summary>
public record SignInCompletion(AuthResult? Session, string RedirectTo);

/// <summary>Which organization's single sign-on applies to an email address (its domain verified, the connection on).</summary>
public class SsoPolicy(IAppDbContext db)
{
    public static string? DomainOf(string? email)
    {
        var at = email?.LastIndexOf('@') ?? -1;
        return at < 0 ? null : email![(at + 1)..].Trim().TrimEnd('.').ToLowerInvariant();
    }

    public async Task<SsoConnection?> ForEmailAsync(string email, CancellationToken ct = default)
    {
        var domain = DomainOf(email);
        if (domain is null) return null;
        return await (from d in db.SsoDomains.AsNoTracking()
                      join c in db.SsoConnections.AsNoTracking() on d.TenantId equals c.TenantId
                      join t in db.Tenants.AsNoTracking() on c.TenantId equals t.Id
                      where d.Domain == domain && d.VerifiedAt != null && c.Enabled && t.Status == TenantStatus.Active
                      select c).FirstOrDefaultAsync(ct);
    }

    /// <summary>
    /// The connection this person must use instead of a password, if any: their email is on an enforcing organization's verified domain.
    /// That organization's Owners are exempt, so a broken identity provider can never lock everybody out.
    /// </summary>
    public async Task<SsoConnection?> EnforcedForAsync(string email, Guid? userId, CancellationToken ct = default)
    {
        var c = await ForEmailAsync(email, ct);
        if (c is not { EnforceForDomains: true }) return null;
        if (userId is { } u && await db.TenantMembers.AnyAsync(m => m.TenantId == c.TenantId && m.UserId == u && m.Role == TenantRole.Owner, ct)) return null;
        return c;
    }
}

/// <summary>
/// Redirect-based sign-in: an organization's single sign-on (OpenID Connect or SAML) and Google / Microsoft / GitHub / Apple.
/// <para>Each sign-in has a one-time state kept server-side for 10 minutes (shared through the distributed cache, so any API server can
/// finish what another started), bound to the browser that started it by a cookie, with PKCE and a nonce for OpenID Connect and the
/// request id for SAML. Accounts are matched by the provider's stable subject first, then by email only when that is safe: a verified
/// domain of the organization (single sign-on) or an email the provider itself verified (social sign-in).</para>
/// </summary>
public class SsoLoginService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, IDistributedCache cache, IOptions<AppOptions> appOptions,
    IOptions<ExternalAuthOptions> externalOptions, IOidcProtocol oidc, IGitHubOAuth github, IAppleClientSecret apple, ISamlProtocol saml, ISecretProtector secrets,
    AuthService auth, WorkspaceProvisioner provisioner, SsoPolicy policy, EntitlementService entitlements, PlatformSettingsCache platform,
    ILogger<SsoLoginService> log)
{
    private readonly AppOptions _o = appOptions.Value;
    private readonly ExternalAuthOptions _x = externalOptions.Value;
    private static readonly TimeSpan StateLife = TimeSpan.FromMinutes(10);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private sealed record Pending(string Kind, string Provider, Guid? ConnectionId, string Nonce, string? Verifier, string BindingHash, bool BindingRequired,
        string ReturnUrl, Guid? LinkUserId, string? SamlRequestId);

    public static readonly string[] SocialProviders = ["google", "microsoft", "github", "apple"];

    // ---------------------------------------------------------------- what is offered

    public IReadOnlyList<ExternalProviderDto> Providers()
    {
        var list = new List<ExternalProviderDto>();
        if (_x.Google.Configured) list.Add(new("google", "Google"));
        if (_x.Microsoft.Configured) list.Add(new("microsoft", "Microsoft"));
        if (_x.GitHub.Configured) list.Add(new("github", "GitHub"));
        if (_x.Apple.Configured) list.Add(new("apple", "Apple"));
        return list;
    }

    public async Task<SsoDiscoveryDto> DiscoverAsync(string? email, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(email) || !email.Contains('@')) return new SsoDiscoveryDto(false, null, false);
        var c = await policy.ForEmailAsync(email.Trim(), ct);
        return c is null ? new SsoDiscoveryDto(false, null, false) : new SsoDiscoveryDto(true, c.Name, c.EnforceForDomains);
    }

    // ---------------------------------------------------------------- starting

    public static string SafeReturnUrl(string? url) =>
        !string.IsNullOrWhiteSpace(url) && url.Length <= 2048 && url.StartsWith('/') && !url.StartsWith("//")
        && !url.Contains('\\') && !url.Any(char.IsControl) && !url.Contains("://") ? url : "/";

    private static string Random(int bytes) => Base64Url(RandomNumberGenerator.GetBytes(bytes));
    private static string Base64Url(byte[] b) => Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    public static string HashBinding(string binding) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(binding)));

    private async Task<string> SaveAsync(Pending p, CancellationToken ct)
    {
        var id = Random(24);
        await cache.SetStringAsync($"signin:{id}", JsonSerializer.Serialize(p, Json), new DistributedCacheEntryOptions { AbsoluteExpirationRelativeToNow = StateLife }, ct);
        return id;
    }

    /// <summary>Takes the state back out (one use only) and checks it belongs to this browser.</summary>
    private async Task<Pending> TakeAsync(string? state, string? binding, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(state) || state.Length > 100) throw new UnauthorizedException("This sign-in link is not valid. Start again.", "SSO_STATE_INVALID");
        var key = $"signin:{state}";
        var json = await cache.GetStringAsync(key, ct);
        if (json is null) throw new UnauthorizedException("This sign-in has expired. Start again.", "SSO_STATE_EXPIRED");
        await cache.RemoveAsync(key, ct);
        var p = JsonSerializer.Deserialize<Pending>(json, Json)!;
        var matches = binding is not null && CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(HashBinding(binding)), Encoding.UTF8.GetBytes(p.BindingHash));
        if (!matches && (p.BindingRequired || binding is not null))
            throw new UnauthorizedException("This sign-in was started in another browser. Start again here.", "SSO_STATE_INVALID");
        return p;
    }

    private static string Challenge(string verifier) => Base64Url(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));

    private static string Query(string endpoint, IEnumerable<KeyValuePair<string, string?>> values) =>
        endpoint + (endpoint.Contains('?') ? "&" : "?") + string.Join('&', values.Where(v => v.Value is not null).Select(v => $"{Uri.EscapeDataString(v.Key)}={Uri.EscapeDataString(v.Value!)}"));

    /// <summary>Starts single sign-on for an email (its verified domain picks the organization), or for an organization by id.</summary>
    public async Task<string> StartSsoAsync(string? email, Guid? tenantId, string? returnUrl, string binding, bool secureBinding, CancellationToken ct = default)
    {
        SsoConnection? c = null;
        if (!string.IsNullOrWhiteSpace(email)) c = await policy.ForEmailAsync(email.Trim(), ct);
        else if (tenantId is { } t) c = await db.SsoConnections.AsNoTracking().FirstOrDefaultAsync(x => x.TenantId == t && x.Enabled, ct);
        if (c is null) throw new NotFoundException("There is no single sign-on for this email address. Sign in with your password instead.");

        var nonce = Random(16);
        if (c.Protocol == SsoProtocol.Oidc)
        {
            var verifier = Random(32);
            var endpoints = await oidc.DiscoverAsync(c.Authority!, ct);
            var state = await SaveAsync(new Pending("sso", "sso", c.Id, nonce, verifier, HashBinding(binding), true, SafeReturnUrl(returnUrl), null, null), ct);
            return Query(endpoints.AuthorizationEndpoint, [
                new("client_id", c.ClientId), new("response_type", "code"), new("scope", "openid email profile"), new("redirect_uri", PublicUrls.OidcCallback(_o)),
                new("state", state), new("nonce", nonce), new("code_challenge", Challenge(verifier)), new("code_challenge_method", "S256"),
                new("login_hint", string.IsNullOrWhiteSpace(email) ? null : email.Trim()),
            ]);
        }
        // SAML posts its answer back cross-site, which only carries the browser cookie when it is SameSite=None (that needs https).
        var pendingId = Random(24);
        var request = saml.CreateRequest(SamlSettingsFor(c), pendingId);
        await cache.SetStringAsync($"signin:{pendingId}", JsonSerializer.Serialize(
            new Pending("sso", "sso", c.Id, nonce, null, HashBinding(binding), secureBinding, SafeReturnUrl(returnUrl), null, request.RequestId), Json),
            new DistributedCacheEntryOptions { AbsoluteExpirationRelativeToNow = StateLife }, ct);
        return request.RedirectUrl;
    }

    private SamlSettings SamlSettingsFor(SsoConnection c) =>
        new(PublicUrls.SamlEntityId(_o, c.TenantId), PublicUrls.SamlAcs(_o), c.SamlEntityId!, c.SamlSsoUrl!, c.SamlCertificate!);

    /// <summary>Starts a Google / Microsoft / GitHub / Apple sign-in, or (with <paramref name="linkUserId"/>) connects one to the signed-in account.</summary>
    public async Task<string> StartExternalAsync(string provider, string? returnUrl, string binding, bool secureBinding, Guid? linkUserId, CancellationToken ct = default)
    {
        provider = provider.ToLowerInvariant();
        if (!Providers().Any(p => p.Id == provider)) throw new NotFoundException("This sign-in option is not available.");
        var nonce = Random(16);
        var verifier = provider is "google" or "microsoft" ? Random(32) : null;
        // Apple answers with a cross-site form post (needs the SameSite=None cookie, so https); the others redirect back with a GET.
        var bindingRequired = provider != "apple" || secureBinding;
        var state = await SaveAsync(new Pending(linkUserId is null ? "social" : "link", provider, null, nonce, verifier, HashBinding(binding), bindingRequired,
            SafeReturnUrl(returnUrl), linkUserId, null), ct);
        var redirect = PublicUrls.ExternalCallback(_o, provider);
        switch (provider)
        {
            case "github":
                return Query("https://github.com/login/oauth/authorize", [new("client_id", _x.GitHub.ClientId), new("redirect_uri", redirect),
                    new("scope", "read:user user:email"), new("state", state), new("allow_signup", "true")]);
            case "apple":
                return Query("https://appleid.apple.com/auth/authorize", [new("client_id", _x.Apple.ClientId), new("redirect_uri", redirect),
                    new("response_type", "code"), new("response_mode", "form_post"), new("scope", "name email"), new("state", state), new("nonce", nonce)]);
            default:
                var (authority, clientId) = provider == "google" ? ("https://accounts.google.com", _x.Google.ClientId) : ("https://login.microsoftonline.com/common/v2.0", _x.Microsoft.ClientId);
                var endpoints = await oidc.DiscoverAsync(authority, ct);
                return Query(endpoints.AuthorizationEndpoint, [new("client_id", clientId), new("response_type", "code"), new("scope", "openid email profile"),
                    new("redirect_uri", redirect), new("state", state), new("nonce", nonce), new("code_challenge", Challenge(verifier!)),
                    new("code_challenge_method", "S256"), new("prompt", "select_account")]);
        }
    }

    // ---------------------------------------------------------------- finishing: single sign-on

    public async Task<SignInCompletion> CompleteOidcSsoAsync(string? code, string? state, string? binding, CancellationToken ct = default)
    {
        var p = await TakeAsync(state, binding, ct);
        var c = await ConnectionAsync(p, SsoProtocol.Oidc, ct);
        if (string.IsNullOrWhiteSpace(code)) throw new UnauthorizedException("The identity provider did not sign you in.", "SSO_REJECTED");
        var who = await oidc.RedeemAsync(new OidcRedeemRequest(c.Authority!, c.ClientId!, secrets.Unprotect(c.ClientSecret!), code, PublicUrls.OidcCallback(_o), p.Verifier!, p.Nonce), ct);
        return await FinishSsoAsync(c, who.Subject, who.Email, who.Name, who.Groups, p.ReturnUrl, ct);
    }

    public async Task<SignInCompletion> CompleteSamlAsync(IReadOnlyDictionary<string, string> form, string? binding, CancellationToken ct = default)
    {
        // The RelayState carries the pending id as "s=<id>" (query-string form).
        var relay = form.GetValueOrDefault("RelayState") ?? "";
        var state = relay.Split('&').Select(x => x.Split('=', 2)).Where(x => x.Length == 2 && x[0] == "s").Select(x => Uri.UnescapeDataString(x[1])).FirstOrDefault();
        var p = await TakeAsync(state, binding, ct);
        var c = await ConnectionAsync(p, SsoProtocol.Saml, ct);
        var who = saml.ReadResponse(SamlSettingsFor(c), form);
        if (who.InResponseTo != p.SamlRequestId) throw new UnauthorizedException("The sign-in answer does not belong to this sign-in.", "SSO_STATE_INVALID");
        return await FinishSsoAsync(c, who.NameId, who.Email, who.Name, who.Groups, p.ReturnUrl, ct);
    }

    private async Task<SsoConnection> ConnectionAsync(Pending p, SsoProtocol protocol, CancellationToken ct)
    {
        if (p.Kind != "sso" || p.ConnectionId is null) throw new UnauthorizedException("This sign-in link is not valid. Start again.", "SSO_STATE_INVALID");
        var c = await db.SsoConnections.FirstOrDefaultAsync(x => x.Id == p.ConnectionId && x.Enabled && x.Protocol == protocol, ct);
        return c ?? throw new UnauthorizedException("Single sign-on has been turned off for this organization.", "SSO_DISABLED");
    }

    private async Task<SignInCompletion> FinishSsoAsync(SsoConnection c, string subject, string? email, string? name, IReadOnlyList<string>? groups, string returnUrl, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(email)) throw new UnauthorizedException("The identity provider did not send an email address.", "SSO_NO_EMAIL");
        email = email.Trim();
        var domain = SsoPolicy.DomainOf(email);
        if (!await db.SsoDomains.AnyAsync(d => d.TenantId == c.TenantId && d.Domain == domain && d.VerifiedAt != null, ct))
            throw new ForbiddenException($"{email} is not on one of this organization's verified domains.", "SSO_DOMAIN_NOT_VERIFIED");

        var provider = $"sso:{c.Id}";
        var normalized = Text.NormalizeEmail(email);
        var login = await db.UserLogins.FirstOrDefaultAsync(l => l.Provider == provider && l.Subject == subject, ct);
        var user = login is not null ? await db.Users.FirstOrDefaultAsync(u => u.Id == login.UserId, ct) : await db.Users.FirstOrDefaultAsync(u => u.NormalizedEmail == normalized, ct);
        var tenant = await db.Tenants.AsNoTracking().FirstAsync(t => t.Id == c.TenantId, ct);

        if (user is null)
        {
            if (!c.AutoProvision) throw new ForbiddenException($"You do not have an account in {tenant.Name} yet. Ask an administrator to add you.", "SSO_NOT_PROVISIONED");
            user = await CreateAccountAsync(email, name, emailVerified: true, ct);
        }
        if (!user.IsActive) throw new ForbiddenException("This account has been disabled.", "ACCOUNT_DISABLED");

        if (!await db.TenantMembers.AnyAsync(m => m.TenantId == c.TenantId && m.UserId == user.Id, ct))
        {
            if (!c.AutoProvision) throw new ForbiddenException($"You are not a member of {tenant.Name}. Ask an administrator to add you.", "SSO_NOT_MEMBER");
            await EnsureSeatAsync(c.TenantId, ct);
            db.TenantMembers.Add(new TenantMember { TenantId = c.TenantId, UserId = user.Id, Role = c.DefaultRole, CreatedAt = clock.Now });
            recorder.Audit("member.provisioned", "TenantMember", user.Id, newValue: new { Via = "sso", Role = c.DefaultRole.ToString() }, userId: user.Id, tenantId: c.TenantId);
        }
        if (login is null) db.UserLogins.Add(login = new UserLogin { UserId = user.Id, Provider = provider, Subject = subject, Email = email, CreatedAt = clock.Now });
        login.LastUsedAt = clock.Now;
        login.Email = email;
        if (!user.EmailVerified) user.EmailVerified = true;   // the organization owns the domain and its provider vouched for the address
        c.LastUsedAt = clock.Now;
        await SsoGroupSync.SyncAsync(db, recorder, clock, c.TenantId, user.Id, groups, ct);

        var session = await auth.SignInExternalAsync(user, "sso", c.TenantId, c.TenantId, ct);
        return new SignInCompletion(session, returnUrl);
    }

    private async Task EnsureSeatAsync(Guid tenantId, CancellationToken ct)
    {
        var limit = (await entitlements.GetEntitlementsAsync(tenantId, ct)).GetValueOrDefault(FeatureKeys.MaxMembers);
        if (limit == FeatureKeys.Unlimited) return;
        var used = await db.TenantMembers.CountAsync(m => m.TenantId == tenantId, ct);
        if (used + 1 > limit) throw new ForbiddenException("This organization has no free seats on its plan. Ask an administrator.", "PLAN_LIMIT_REACHED");
    }

    /// <summary>A new account for someone an identity provider vouched for: no password of its own (one can be set with "forgot password").</summary>
    private async Task<User> CreateAccountAsync(string email, string? name, bool emailVerified, CancellationToken ct)
    {
        var displayName = string.IsNullOrWhiteSpace(name) ? email[..email.IndexOf('@')] : Text.Truncate(name.Trim(), 100)!;
        var user = new User
        {
            Email = email, NormalizedEmail = Text.NormalizeEmail(email), DisplayName = displayName, PasswordHash = PasswordHashes.None,
            EmailVerified = emailVerified, CreatedAt = clock.Now,
        };
        db.Users.Add(user);
        var personal = await provisioner.CreateAsync("Personal Workspace", WorkspaceType.Personal, user.Id, null, $"{displayName} personal", ct);
        recorder.Audit("user.registered", "User", user.Id, newValue: new { Via = "external" }, tenantId: personal.Id, userId: user.Id);
        return user;
    }

    // ---------------------------------------------------------------- finishing: Google / Microsoft / GitHub / Apple

    public async Task<SignInCompletion> CompleteExternalAsync(string provider, string? code, string? state, IReadOnlyDictionary<string, string>? form, string? binding,
        CancellationToken ct = default)
    {
        provider = provider.ToLowerInvariant();
        var p = await TakeAsync(state, binding, ct);
        if (p.Provider != provider || p.Kind is not ("social" or "link")) throw new UnauthorizedException("This sign-in link is not valid. Start again.", "SSO_STATE_INVALID");
        if (string.IsNullOrWhiteSpace(code)) throw new UnauthorizedException("The sign-in was cancelled.", "SSO_REJECTED");
        var redirect = PublicUrls.ExternalCallback(_o, provider);
        var who = provider switch
        {
            "google" => await oidc.RedeemAsync(new OidcRedeemRequest("https://accounts.google.com", _x.Google.ClientId!, _x.Google.ClientSecret!, code, redirect, p.Verifier!, p.Nonce), ct),
            "microsoft" => await oidc.RedeemAsync(new OidcRedeemRequest("https://login.microsoftonline.com/common/v2.0", _x.Microsoft.ClientId!, _x.Microsoft.ClientSecret!, code,
                redirect, p.Verifier!, p.Nonce, IssuerRule.MicrosoftAnyTenant), ct),
            "github" => await github.RedeemAsync(_x.GitHub.ClientId!, _x.GitHub.ClientSecret!, code, redirect, ct),
            "apple" => await RedeemAppleAsync(code, redirect, p, form, ct),
            _ => throw new NotFoundException("This sign-in option is not available."),
        };

        var login = await db.UserLogins.FirstOrDefaultAsync(l => l.Provider == provider && l.Subject == who.Subject, ct);
        if (p.Kind == "link") return await LinkAsync(provider, p.LinkUserId!.Value, login, who, ct);

        User? user = login is not null ? await db.Users.FirstOrDefaultAsync(u => u.Id == login.UserId, ct) : null;
        if (user is null)
        {
            if (string.IsNullOrWhiteSpace(who.Email)) throw new UnauthorizedException($"{Label(provider)} did not share an email address.", "SSO_NO_EMAIL");
            // A company that requires its own single sign-on cannot be bypassed with a personal Google or Microsoft sign-in.
            if (await policy.EnforcedForAsync(who.Email, null, ct) is { } enforced)
                throw new ForbiddenException($"Your organization requires {enforced.Name}. Use \"Sign in with SSO\" instead.", "SSO_REQUIRED");
            var normalized = Text.NormalizeEmail(who.Email);
            user = await db.Users.FirstOrDefaultAsync(u => u.NormalizedEmail == normalized, ct);
            if (user is not null)
            {
                // Linking to an existing account by email is only safe when the provider itself verified that address.
                if (!who.EmailVerified) throw new ForbiddenException($"An account with {who.Email} already exists. Sign in with your password, then connect {Label(provider)} in My account.", "EXTERNAL_EMAIL_UNVERIFIED");
            }
            else
            {
                if (!who.EmailVerified) throw new ForbiddenException($"{Label(provider)} has not verified {who.Email}. Sign up with your email address instead.", "EXTERNAL_EMAIL_UNVERIFIED");
                await EnsureSignupsOpenAsync(normalized, ct);
                user = await CreateAccountAsync(who.Email.Trim(), who.Name, emailVerified: true, ct);
            }
            db.UserLogins.Add(login = new UserLogin { UserId = user.Id, Provider = provider, Subject = who.Subject, Email = who.Email, CreatedAt = clock.Now });
        }
        else if (await policy.EnforcedForAsync(user.Email, user.Id, ct) is { } enforced)
            throw new ForbiddenException($"Your organization requires {enforced.Name}. Use \"Sign in with SSO\" instead.", "SSO_REQUIRED");
        if (!user.IsActive) throw new ForbiddenException("This account has been disabled.", "ACCOUNT_DISABLED");
        login!.LastUsedAt = clock.Now;   // a user found here came from this login, or the login was just added

        // A social sign-in replaces the password, not the second step: people with two-step verification still enter their code.
        if (user.MfaEnabled)
        {
            await db.SaveChangesAsync(ct);
            throw new MfaRequiredRedirect(auth.CreateMfaChallenge(user), provider, p.ReturnUrl);
        }
        var session = await auth.SignInExternalAsync(user, provider, null, null, ct);
        return new SignInCompletion(session, p.ReturnUrl);
    }

    private async Task<ExternalIdentity> RedeemAppleAsync(string code, string redirect, Pending p, IReadOnlyDictionary<string, string>? form, CancellationToken ct)
    {
        var secret = apple.Create(_x.Apple.TeamId!, _x.Apple.KeyId!, _x.Apple.ClientId!, _x.Apple.PrivateKey!);
        var who = await oidc.RedeemAsync(new OidcRedeemRequest("https://appleid.apple.com", _x.Apple.ClientId!, secret, code, redirect, "", p.Nonce), ct);
        // Apple sends the person's name only on the very first sign-in, in the "user" form field.
        if (who.Name is null && form?.GetValueOrDefault("user") is { Length: > 0 } userJson)
        {
            try
            {
                var n = JsonDocument.Parse(userJson).RootElement.GetProperty("name");
                var full = $"{(n.TryGetProperty("firstName", out var f) ? f.GetString() : "")} {(n.TryGetProperty("lastName", out var l) ? l.GetString() : "")}".Trim();
                if (full.Length > 0) who = who with { Name = full };
            }
            catch (Exception ex) when (ex is JsonException or KeyNotFoundException or InvalidOperationException) { log.LogDebug(ex, "Apple user field was not readable"); }
        }
        return who;
    }

    private async Task EnsureSignupsOpenAsync(string normalizedEmail, CancellationToken ct)
    {
        if ((await platform.GetAsync(ct)).SignupsEnabled) return;
        var now = clock.Now;
        if (!await db.TenantInvitations.AnyAsync(i => i.NormalizedEmail == normalizedEmail && i.Status == InvitationStatus.Pending && i.ExpiresAt > now, ct))
            throw new ForbiddenException("New sign-ups are closed right now. Ask an administrator for an invitation.", "SIGNUPS_DISABLED");
    }

    private async Task<SignInCompletion> LinkAsync(string provider, Guid userId, UserLogin? existing, ExternalIdentity who, CancellationToken ct)
    {
        if (existing is not null && existing.UserId != userId)
            throw new ConflictException($"This {Label(provider)} account is already connected to another account.", "ALREADY_LINKED");
        if (existing is null)
        {
            if (await db.UserLogins.AnyAsync(l => l.UserId == userId && l.Provider == provider, ct))
                throw new ConflictException($"Another {Label(provider)} account is already connected. Disconnect it first.", "ALREADY_LINKED");
            db.UserLogins.Add(new UserLogin { UserId = userId, Provider = provider, Subject = who.Subject, Email = who.Email, CreatedAt = clock.Now, LastUsedAt = clock.Now });
            recorder.Audit("user.login_linked", "User", userId, newValue: new { provider }, userId: userId);
            await db.SaveChangesAsync(ct);
        }
        return new SignInCompletion(null, $"/account/security?linked={provider}");
    }

    public static string Label(string provider) => provider switch
    {
        "google" => "Google", "microsoft" => "Microsoft", "github" => "GitHub", "apple" => "Apple",
        _ when provider.StartsWith("sso:") => "Single sign-on", _ => provider,
    };

    // ---------------------------------------------------------------- the signed-in person's connected accounts

    public async Task<IReadOnlyList<UserLoginDto>> MyLoginsAsync(CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var rows = await db.UserLogins.AsNoTracking().Where(l => l.UserId == uid).OrderBy(l => l.CreatedAt).ToListAsync(ct);
        var connectionIds = rows.Where(r => r.Provider.StartsWith("sso:")).Select(r => Guid.TryParse(r.Provider[4..], out var g) ? g : Guid.Empty).ToList();
        var names = await db.SsoConnections.AsNoTracking().Where(c => connectionIds.Contains(c.Id)).ToDictionaryAsync(c => c.Id, c => c.Name, ct);
        return rows.Select(r => new UserLoginDto(r.Id, r.Provider.StartsWith("sso:") ? "sso" : r.Provider,
            r.Provider.StartsWith("sso:") && Guid.TryParse(r.Provider[4..], out var g) && names.TryGetValue(g, out var n) ? n : Label(r.Provider),
            r.Email, r.CreatedAt, r.LastUsedAt)).ToList();
    }

    public async Task UnlinkAsync(Guid id, CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var row = await db.UserLogins.FirstOrDefaultAsync(l => l.Id == id && l.UserId == uid, ct) ?? throw new NotFoundException("Connected account not found.");
        var user = await db.Users.FirstAsync(u => u.Id == uid, ct);
        var others = await db.UserLogins.CountAsync(l => l.UserId == uid && l.Id != id, ct);
        if (user.PasswordHash == PasswordHashes.None && others == 0)
            throw new ValidationException("id", "Set a password first (Forgot password on the sign-in page), or you would have no way to sign in.");
        db.UserLogins.Remove(row);
        recorder.Audit("user.login_unlinked", "User", uid, oldValue: new { row.Provider }, userId: uid);
        await db.SaveChangesAsync(ct);
    }
}

/// <summary>A social sign-in succeeded for someone with two-step verification: the browser continues on the sign-in page with this challenge.</summary>
public class MfaRequiredRedirect(string challenge, string provider, string returnUrl) : Exception("Two-step verification is required.")
{
    public string Challenge { get; } = challenge;
    public string Provider { get; } = provider;
    public string ReturnUrl { get; } = returnUrl;
}
