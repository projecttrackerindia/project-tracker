using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Entities
{
    /// <summary>
    /// An app that may ask people to connect it (Claude, ChatGPT and other MCP clients), registered by the app itself (OAuth dynamic client
    /// registration, RFC 7591). Public clients: no secret; every authorization uses PKCE. Not tied to a workspace.
    /// </summary>
    public class OAuthClient : AuditableEntity
    {
        /// <summary>The public client_id ("ptc_" and 32 hex characters).</summary>
        public string ClientId { get; set; } = "";
        public string Name { get; set; } = "";
        /// <summary>JSON array of the exact redirect URIs the client registered.</summary>
        public string RedirectUrisJson { get; set; } = "[]";
        public string? ClientUri { get; set; }
        public string? LogoUri { get; set; }
        public DateTime? LastUsedAt { get; set; }
    }

    /// <summary>A one-time authorization code (hash only), valid for a few minutes, bound to the client, redirect, PKCE challenge, person and workspace.</summary>
    public class OAuthCode : AuditableEntity
    {
        public string CodeHash { get; set; } = "";
        public string ClientId { get; set; } = "";
        public Guid UserId { get; set; }
        public Guid TenantId { get; set; }
        public string RedirectUri { get; set; } = "";
        public string CodeChallenge { get; set; } = "";
        /// <summary>mcp:read or "mcp:read mcp:write".</summary>
        public string Scope { get; set; } = "";
        public string? Resource { get; set; }
        public DateTime ExpiresAt { get; set; }
        public DateTime? UsedAt { get; set; }
    }

    /// <summary>
    /// A person's approval for an app to work in one workspace on their behalf. Its access tokens are short-lived API keys linked to it; the
    /// refresh token (hash only) rotates on every use. Revoking the grant ends every token at once.
    /// </summary>
    public class OAuthGrant : TenantEntity, ITenantScoped
    {
        public string ClientId { get; set; } = "";
        public string ClientName { get; set; } = "";
        public Guid UserId { get; set; }
        public string Scope { get; set; } = "";
        public string RefreshHash { get; set; } = "";
        public DateTime RefreshExpiresAt { get; set; }
        public Guid? AccessKeyId { get; set; }
        public DateTime? LastUsedAt { get; set; }
        public DateTime? RevokedAt { get; set; }
    }
}
