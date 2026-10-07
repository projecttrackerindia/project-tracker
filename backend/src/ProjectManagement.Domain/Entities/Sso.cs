using ProjectManagement.Domain.Common;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Domain.Entities;

public enum SsoProtocol { Oidc, Saml }

/// <summary>
/// An organization's own identity provider (Microsoft Entra ID, Okta, Google Workspace, OneLogin, JumpCloud ...), over OpenID Connect or
/// SAML 2.0. It signs in only people whose email is on one of the organization's verified domains (<see cref="SsoDomain"/>), so an
/// identity provider can never speak for anyone outside the company. One per organization. Not tenant-filtered on purpose: it is read
/// while someone is signing in, before there is a workspace in context; services filter by <see cref="TenantEntity.TenantId"/> themselves.
/// </summary>
public class SsoConnection : TenantEntity
{
    public SsoProtocol Protocol { get; set; }
    /// <summary>Shown on the sign-in button: "Continue with {Name}".</summary>
    public string Name { get; set; } = "Single sign-on";
    public bool Enabled { get; set; }
    /// <summary>People on the verified domains must use single sign-on; password sign-in is refused (Owners keep it, as a way back in).</summary>
    public bool EnforceForDomains { get; set; }
    /// <summary>The first single sign-on of someone new creates their account and adds them to the organization.</summary>
    public bool AutoProvision { get; set; } = true;
    public TenantRole DefaultRole { get; set; } = TenantRole.Member;

    // OpenID Connect
    public string? Authority { get; set; }
    public string? ClientId { get; set; }
    /// <summary>Encrypted.</summary>
    public string? ClientSecret { get; set; }

    // SAML 2.0
    /// <summary>The identity provider's entity ID (the Issuer of its responses).</summary>
    public string? SamlEntityId { get; set; }
    /// <summary>Where sign-in requests are sent (HTTP-Redirect binding).</summary>
    public string? SamlSsoUrl { get; set; }
    /// <summary>The identity provider's signing certificate (base64 DER, or PEM).</summary>
    public string? SamlCertificate { get; set; }

    public DateTime? LastUsedAt { get; set; }
}

/// <summary>An email domain an organization has proven it owns, with a DNS TXT record. Only verified domains count.</summary>
public class SsoDomain : TenantEntity
{
    /// <summary>Lower case, e.g. "acme.com".</summary>
    public string Domain { get; set; } = "";
    /// <summary>The value to publish: a TXT record "projecttracker-verification=&lt;token&gt;" on the domain.</summary>
    public string VerificationToken { get; set; } = "";
    public DateTime? VerifiedAt { get; set; }
    public DateTime? LastCheckedAt { get; set; }
}

/// <summary>A bearer token for SCIM 2.0 provisioning (the identity provider creates, updates and removes members). Stored hashed.</summary>
public class ScimToken : TenantEntity
{
    public string Name { get; set; } = "";
    public string Prefix { get; set; } = "";
    public string TokenHash { get; set; } = "";
    public DateTime? LastUsedAt { get; set; }
    public DateTime? RevokedAt { get; set; }
}

/// <summary>
/// An outside identity linked to an account: a Google, Microsoft, GitHub or Apple account ("google", "microsoft", "github", "apple"), or
/// an organization's single sign-on ("sso:&lt;connection id&gt;"). <see cref="Subject"/> is the provider's stable id for the person.
/// </summary>
public class UserLogin : Entity
{
    public Guid UserId { get; set; }
    public string Provider { get; set; } = "";
    public string Subject { get; set; } = "";
    public string? Email { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime? LastUsedAt { get; set; }
}

/// <summary>Which team a person joins when their identity provider says they belong to a group (the "groups" claim or attribute). Sync happens at sign-in.</summary>
public class SsoGroupMapping : TenantEntity, ITenantScoped
{
    /// <summary>The group's name or id exactly as the identity provider sends it (compared without regard to case).</summary>
    public string Group { get; set; } = "";
    public Guid TeamId { get; set; }
}
