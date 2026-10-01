namespace ProjectManagement.Application.Features.Sso;

/// <summary>The endpoints an OpenID Connect provider publishes in its discovery document.</summary>
public record OidcEndpoints(string Issuer, string AuthorizationEndpoint, string TokenEndpoint);

/// <summary>Who an identity provider says signed in.</summary>
/// <param name="Subject">The provider's stable id for the person (never reassigned).</param>
/// <param name="EmailVerified">Whether the provider itself says it checked the email address.</param>
public record ExternalIdentity(string Subject, string? Email, bool EmailVerified, string? Name);

/// <summary>How the issuer of an ID token is checked. Microsoft's common endpoint issues tokens from each customer's own tenant.</summary>
public enum IssuerRule { Exact, MicrosoftAnyTenant }

public record OidcRedeemRequest(string Authority, string ClientId, string ClientSecret, string Code, string RedirectUri, string CodeVerifier, string Nonce,
    IssuerRule Issuer = IssuerRule.Exact);

/// <summary>OpenID Connect: discovery, and redeeming an authorization code (with PKCE) for a validated ID token.</summary>
public interface IOidcProtocol
{
    Task<OidcEndpoints> DiscoverAsync(string authority, CancellationToken ct = default);
    /// <summary>Exchanges the code and validates the ID token (signature against the provider's keys, issuer, audience, lifetime, nonce).</summary>
    Task<ExternalIdentity> RedeemAsync(OidcRedeemRequest req, CancellationToken ct = default);
}

/// <summary>GitHub sign-in (OAuth 2.0, not OpenID Connect): the code is exchanged for a token used to read the profile and verified emails.</summary>
public interface IGitHubOAuth
{
    Task<ExternalIdentity> RedeemAsync(string clientId, string clientSecret, string code, string redirectUri, CancellationToken ct = default);
}

/// <summary>Sign in with Apple's client secret: a short-lived JWT signed with the team's private key (ES256).</summary>
public interface IAppleClientSecret
{
    string Create(string teamId, string keyId, string clientId, string privateKeyPem);
}

public record SamlSettings(string SpEntityId, string AcsUrl, string IdpEntityId, string IdpSsoUrl, string IdpCertificate);
public record SamlRequest(string RedirectUrl, string RequestId);
public record SamlIdentity(string NameId, string? Email, string? Name, string? InResponseTo);

/// <summary>SAML 2.0 service provider: sign-in requests (HTTP-Redirect) and validated responses (HTTP-POST, signed by the identity provider).</summary>
public interface ISamlProtocol
{
    SamlRequest CreateRequest(SamlSettings settings, string relayState);
    /// <summary>Reads and validates a response: signature with the provider's certificate, issuer, audience, recipient, time window.</summary>
    SamlIdentity ReadResponse(SamlSettings settings, IReadOnlyDictionary<string, string> form);
    /// <summary>Checks a certificate can be read; returns its subject and expiry for display.</summary>
    (string Subject, DateTime NotAfter) Inspect(string certificate);
}

/// <summary>DNS: whether a domain publishes a given TXT record.</summary>
public interface IDomainVerifier
{
    Task<bool> HasTxtRecordAsync(string domain, string expected, CancellationToken ct = default);
}
