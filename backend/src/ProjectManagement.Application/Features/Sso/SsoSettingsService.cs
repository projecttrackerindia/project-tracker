using System.Security.Cryptography;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Sso;

public record SsoConnectionDto(SsoProtocol Protocol, string Name, bool Enabled, bool EnforceForDomains, bool AutoProvision, TenantRole DefaultRole,
    string? Authority, string? ClientId, bool HasClientSecret, string? SamlEntityId, string? SamlSsoUrl, bool HasSamlCertificate,
    string? CertificateSubject, DateTime? CertificateExpiresAt, DateTime? LastUsedAt);
public record SsoDomainDto(Guid Id, string Domain, string TxtName, string TxtValue, bool Verified, DateTime? VerifiedAt, DateTime? LastCheckedAt);
public record ScimTokenDto(Guid Id, string Name, string Prefix, DateTime CreatedAt, DateTime? LastUsedAt, bool Revoked);
/// <summary>What the identity provider needs to know about this application.</summary>
public record SsoServiceProviderDto(string OidcRedirectUri, string SamlEntityId, string SamlAcsUrl, string SamlMetadataUrl, string ScimBaseUrl);
public record SsoSettingsDto(bool Entitled, bool CanManage, SsoConnectionDto? Connection, IReadOnlyList<SsoDomainDto> Domains,
    IReadOnlyList<ScimTokenDto> ScimTokens, SsoServiceProviderDto ServiceProvider);

public record SaveSsoConnectionRequest(SsoProtocol Protocol, string? Name, bool Enabled, bool EnforceForDomains, bool AutoProvision, TenantRole? DefaultRole,
    string? Authority, string? ClientId, string? ClientSecret, string? SamlEntityId, string? SamlSsoUrl, string? SamlCertificate);
public record AddSsoDomainRequest(string? Domain);
public record CreateScimTokenRequest(string? Name);
public record CreatedScimTokenDto(ScimTokenDto Token, string Secret);
public record SsoCheckDto(bool Ok, string Message, string? Issuer);

/// <summary>Where the application is reachable, for the addresses identity providers call back on.</summary>
public static class PublicUrls
{
    public static string Api(AppOptions o) => (string.IsNullOrWhiteSpace(o.ApiBaseUrl) ? o.WebBaseUrl : o.ApiBaseUrl!).TrimEnd('/');
    public static string Web(AppOptions o) => o.WebBaseUrl.TrimEnd('/');
    public static string OidcCallback(AppOptions o) => $"{Api(o)}/api/v1/auth/sso/oidc/callback";
    public static string SamlAcs(AppOptions o) => $"{Api(o)}/api/v1/auth/sso/saml/acs";
    public static string SamlEntityId(AppOptions o, Guid tenantId) => $"{Api(o)}/api/v1/auth/sso/saml/{tenantId}/metadata";
    public static string ExternalCallback(AppOptions o, string provider) => $"{Api(o)}/api/v1/auth/external/{provider}/callback";
    public static string ScimBase(AppOptions o) => $"{Api(o)}/scim/v2";
}

/// <summary>
/// An organization's single sign-on, verified domains and SCIM tokens (Workspace settings → Single sign-on). Owners and Admins of an
/// organization on a plan with advanced security. Domains must be proven with a DNS TXT record before single sign-on or provisioning
/// acts on them, so an identity provider can only ever sign in people whose email the organization owns.
/// </summary>
public class SsoSettingsService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, EntitlementService entitlements,
    ISecretProtector secrets, IOidcProtocol oidc, ISamlProtocol saml, IDomainVerifier dns, IOptions<AppOptions> options)
{
    public const string TxtPrefix = "projecttracker-verification=";
    private readonly AppOptions _o = options.Value;

    private Guid RequireOrgAdmin()
    {
        var tid = ctx.RequireTenantId();
        if (ctx.WorkspaceType != WorkspaceType.Organization) throw new ForbiddenException("Single sign-on is for organization workspaces.", "PERMISSION_DENIED");
        if (ctx.Role is not (TenantRole.Owner or TenantRole.Admin)) throw new ForbiddenException("Only owners and admins can manage single sign-on.", "PERMISSION_DENIED");
        return tid;
    }

    public async Task<SsoSettingsDto> GetAsync(CancellationToken ct = default)
    {
        var tid = RequireOrgAdmin();
        var entitled = await entitlements.GetValueAsync(FeatureKeys.AdvancedSecurity, ct) > 0;
        var c = await db.SsoConnections.AsNoTracking().FirstOrDefaultAsync(x => x.TenantId == tid, ct);
        var domains = await db.SsoDomains.AsNoTracking().Where(d => d.TenantId == tid).OrderBy(d => d.Domain).ToListAsync(ct);
        var tokens = await db.ScimTokens.AsNoTracking().Where(t => t.TenantId == tid).OrderByDescending(t => t.CreatedAt).ToListAsync(ct);
        (string Subject, DateTime NotAfter)? cert = null;
        if (!string.IsNullOrWhiteSpace(c?.SamlCertificate)) { try { cert = saml.Inspect(c.SamlCertificate); } catch (ValidationException) { } }
        return new SsoSettingsDto(entitled, true,
            c is null ? null : new SsoConnectionDto(c.Protocol, c.Name, c.Enabled, c.EnforceForDomains, c.AutoProvision, c.DefaultRole, c.Authority, c.ClientId,
                !string.IsNullOrEmpty(c.ClientSecret), c.SamlEntityId, c.SamlSsoUrl, !string.IsNullOrEmpty(c.SamlCertificate), cert?.Subject, cert?.NotAfter, c.LastUsedAt),
            domains.Select(ToDto).ToList(), tokens.Select(ToDto).ToList(),
            new SsoServiceProviderDto(PublicUrls.OidcCallback(_o), PublicUrls.SamlEntityId(_o, tid), PublicUrls.SamlAcs(_o), PublicUrls.SamlEntityId(_o, tid), PublicUrls.ScimBase(_o)));
    }

    private static SsoDomainDto ToDto(SsoDomain d) => new(d.Id, d.Domain, d.Domain, TxtPrefix + d.VerificationToken, d.VerifiedAt is not null, d.VerifiedAt, d.LastCheckedAt);
    private static ScimTokenDto ToDto(ScimToken t) => new(t.Id, t.Name, t.Prefix, t.CreatedAt, t.LastUsedAt, t.RevokedAt is not null);

    private static string? HttpsUrl(string? value, string field, string label)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var v = value.Trim();
        if (!Uri.TryCreate(v, UriKind.Absolute, out var u) || (u.Scheme != Uri.UriSchemeHttps && !u.IsLoopback))
            throw new ValidationException(field, $"{label} must be an https:// address.");
        return v.TrimEnd('/');
    }

    public async Task<SsoSettingsDto> SaveConnectionAsync(SaveSsoConnectionRequest req, CancellationToken ct = default)
    {
        var tid = RequireOrgAdmin();
        await entitlements.EnsureFeatureAsync(FeatureKeys.AdvancedSecurity, ct);
        var c = await db.SsoConnections.FirstOrDefaultAsync(x => x.TenantId == tid, ct);
        var isNew = c is null;
        c ??= new SsoConnection { TenantId = tid };

        c.Protocol = req.Protocol;
        c.Name = string.IsNullOrWhiteSpace(req.Name) ? "Single sign-on" : Text.Truncate(req.Name.Trim(), 80)!;
        c.AutoProvision = req.AutoProvision;
        c.DefaultRole = req.DefaultRole is TenantRole.Admin or TenantRole.Manager or TenantRole.Member or TenantRole.Guest ? req.DefaultRole.Value : TenantRole.Member;
        if (req.Protocol == SsoProtocol.Oidc)
        {
            c.Authority = HttpsUrl(req.Authority, "authority", "The issuer (authority)") ?? throw new ValidationException("authority", "Enter the identity provider's issuer address.");
            c.ClientId = string.IsNullOrWhiteSpace(req.ClientId) ? throw new ValidationException("clientId", "Enter the client ID.") : req.ClientId.Trim();
            if (!string.IsNullOrWhiteSpace(req.ClientSecret)) c.ClientSecret = secrets.Protect(req.ClientSecret.Trim());
            if (string.IsNullOrEmpty(c.ClientSecret)) throw new ValidationException("clientSecret", "Enter the client secret.");
            await oidc.DiscoverAsync(c.Authority, ct);   // refuses an address that is not an OpenID Connect provider
        }
        else
        {
            c.SamlEntityId = string.IsNullOrWhiteSpace(req.SamlEntityId) ? throw new ValidationException("samlEntityId", "Enter the identity provider's entity ID.") : req.SamlEntityId.Trim();
            c.SamlSsoUrl = HttpsUrl(req.SamlSsoUrl, "samlSsoUrl", "The sign-in address") ?? throw new ValidationException("samlSsoUrl", "Enter the identity provider's sign-in (SSO) address.");
            if (!string.IsNullOrWhiteSpace(req.SamlCertificate)) { saml.Inspect(req.SamlCertificate); c.SamlCertificate = req.SamlCertificate.Trim(); }
            if (string.IsNullOrEmpty(c.SamlCertificate)) throw new ValidationException("samlCertificate", "Paste the identity provider's signing certificate.");
        }
        var hasVerified = await db.SsoDomains.AnyAsync(d => d.TenantId == tid && d.VerifiedAt != null, ct);
        if (req.Enabled && !hasVerified) throw new ValidationException("enabled", "Verify at least one email domain before turning single sign-on on.");
        c.Enabled = req.Enabled;
        c.EnforceForDomains = req.Enabled && req.EnforceForDomains;
        if (isNew) db.SsoConnections.Add(c);
        recorder.Audit("sso.connection_saved", "SsoConnection", c.Id, newValue: new { c.Protocol, c.Enabled, c.EnforceForDomains, c.AutoProvision, c.Authority, c.ClientId, c.SamlEntityId, c.SamlSsoUrl }, tenantId: tid);
        await db.SaveChangesAsync(ct);
        return await GetAsync(ct);
    }

    /// <summary>Reads the provider's discovery document (OpenID Connect) or the certificate (SAML) to show that the settings make sense.</summary>
    public async Task<SsoCheckDto> CheckAsync(CancellationToken ct = default)
    {
        var tid = RequireOrgAdmin();
        var c = await db.SsoConnections.AsNoTracking().FirstOrDefaultAsync(x => x.TenantId == tid, ct) ?? throw new NotFoundException("Save the single sign-on settings first.");
        try
        {
            if (c.Protocol == SsoProtocol.Oidc)
            {
                var e = await oidc.DiscoverAsync(c.Authority!, ct);
                return new SsoCheckDto(true, $"Found the provider. Sign-in goes to {new Uri(e.AuthorizationEndpoint).Host}.", e.Issuer);
            }
            var cert = saml.Inspect(c.SamlCertificate!);
            return cert.NotAfter < clock.Now
                ? new SsoCheckDto(false, $"The certificate ({cert.Subject}) expired on {cert.NotAfter:d MMM yyyy}.", c.SamlEntityId)
                : new SsoCheckDto(true, $"Certificate {cert.Subject}, valid until {cert.NotAfter:d MMM yyyy}.", c.SamlEntityId);
        }
        catch (ValidationException ex) { return new SsoCheckDto(false, ex.Message, null); }
    }

    public async Task<SsoSettingsDto> AddDomainAsync(AddSsoDomainRequest req, CancellationToken ct = default)
    {
        var tid = RequireOrgAdmin();
        await entitlements.EnsureFeatureAsync(FeatureKeys.AdvancedSecurity, ct);
        var domain = (req.Domain ?? "").Trim().TrimEnd('.').ToLowerInvariant();
        if (domain.StartsWith('@')) domain = domain[1..];
        if (domain.Length is < 3 or > 253 || !domain.Contains('.') || Uri.CheckHostName(domain) != UriHostNameType.Dns)
            throw new ValidationException("domain", "Enter a domain such as acme.com.");
        if (await db.SsoDomains.AnyAsync(d => d.TenantId == tid && d.Domain == domain, ct)) throw new ConflictException("This domain is already listed.", "DOMAIN_EXISTS");
        if (await db.SsoDomains.CountAsync(d => d.TenantId == tid, ct) >= 20) throw new ValidationException("domain", "An organization can list at most 20 domains.");
        var d = new SsoDomain { TenantId = tid, Domain = domain, VerificationToken = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant() };
        db.SsoDomains.Add(d);
        recorder.Audit("sso.domain_added", "SsoDomain", d.Id, newValue: new { domain }, tenantId: tid);
        await db.SaveChangesAsync(ct);
        return await GetAsync(ct);
    }

    public async Task<SsoSettingsDto> VerifyDomainAsync(Guid id, CancellationToken ct = default)
    {
        var tid = RequireOrgAdmin();
        var d = await db.SsoDomains.FirstOrDefaultAsync(x => x.Id == id && x.TenantId == tid, ct) ?? throw new NotFoundException("Domain not found.");
        if (d.VerifiedAt is not null) return await GetAsync(ct);
        d.LastCheckedAt = clock.Now;
        if (!await dns.HasTxtRecordAsync(d.Domain, TxtPrefix + d.VerificationToken, ct))
        {
            await db.SaveChangesAsync(ct);
            throw new ValidationException("domain", $"The TXT record was not found on {d.Domain} yet. DNS changes can take a while to appear; try again in a few minutes.");
        }
        if (await db.SsoDomains.AnyAsync(x => x.Domain == d.Domain && x.VerifiedAt != null && x.Id != d.Id, ct))
            throw new ConflictException("Another organization has already verified this domain.", "DOMAIN_TAKEN");
        d.VerifiedAt = clock.Now;
        recorder.Audit("sso.domain_verified", "SsoDomain", d.Id, newValue: new { d.Domain }, tenantId: tid);
        await db.SaveChangesAsync(ct);
        return await GetAsync(ct);
    }

    public async Task<SsoSettingsDto> RemoveDomainAsync(Guid id, CancellationToken ct = default)
    {
        var tid = RequireOrgAdmin();
        var d = await db.SsoDomains.FirstOrDefaultAsync(x => x.Id == id && x.TenantId == tid, ct) ?? throw new NotFoundException("Domain not found.");
        db.SsoDomains.Remove(d);
        // Without any verified domain, single sign-on has nobody it may sign in: switch it off rather than leave it half working.
        if (!await db.SsoDomains.AnyAsync(x => x.TenantId == tid && x.VerifiedAt != null && x.Id != id, ct)
            && await db.SsoConnections.FirstOrDefaultAsync(x => x.TenantId == tid, ct) is { Enabled: true } c)
        { c.Enabled = false; c.EnforceForDomains = false; }
        recorder.Audit("sso.domain_removed", "SsoDomain", d.Id, oldValue: new { d.Domain }, tenantId: tid);
        await db.SaveChangesAsync(ct);
        return await GetAsync(ct);
    }

    public async Task<CreatedScimTokenDto> CreateScimTokenAsync(CreateScimTokenRequest req, CancellationToken ct = default)
    {
        var tid = RequireOrgAdmin();
        await entitlements.EnsureFeatureAsync(FeatureKeys.AdvancedSecurity, ct);
        if (await db.ScimTokens.CountAsync(t => t.TenantId == tid && t.RevokedAt == null, ct) >= 5)
            throw new ValidationException("name", "Revoke an old token first: at most 5 can be active.");
        var secret = ScimTokens.NewSecret();
        var t = new ScimToken
        {
            TenantId = tid, Name = string.IsNullOrWhiteSpace(req.Name) ? "Identity provider" : Text.Truncate(req.Name.Trim(), 80)!,
            Prefix = secret[..12], TokenHash = ScimTokens.Hash(secret),
        };
        db.ScimTokens.Add(t);
        recorder.Audit("scim.token_created", "ScimToken", t.Id, newValue: new { t.Name, t.Prefix }, tenantId: tid);
        await db.SaveChangesAsync(ct);
        return new CreatedScimTokenDto(ToDto(t), secret);
    }

    public async Task<SsoSettingsDto> RevokeScimTokenAsync(Guid id, CancellationToken ct = default)
    {
        var tid = RequireOrgAdmin();
        var t = await db.ScimTokens.FirstOrDefaultAsync(x => x.Id == id && x.TenantId == tid, ct) ?? throw new NotFoundException("Token not found.");
        t.RevokedAt ??= clock.Now;
        recorder.Audit("scim.token_revoked", "ScimToken", t.Id, tenantId: tid);
        await db.SaveChangesAsync(ct);
        return await GetAsync(ct);
    }
}

/// <summary>SCIM bearer tokens: "scim_" plus 40 random characters; only a SHA-256 hash is kept.</summary>
public static class ScimTokens
{
    public static string NewSecret() => "scim_" + Convert.ToBase64String(RandomNumberGenerator.GetBytes(30)).Replace('+', 'a').Replace('/', 'b').TrimEnd('=');
    public static string Hash(string secret) => Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(secret)));
}
