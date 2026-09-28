using ProjectManagement.Domain.Common;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Domain.Enums
{
    public enum ApiKeyScope { ReadOnly, ReadWrite }
}

namespace ProjectManagement.Domain.Entities
{
    /// <summary>
    /// A secret for scripts and integrations. It acts as the person who created it, inside one workspace, with that person's current
    /// role (never more), and can be limited to reading. Only a hash of the secret is stored; the secret itself is shown once.
    /// </summary>
    public class ApiKey : TenantEntity, ITenantScoped
    {
        public string Name { get; set; } = "";
        /// <summary>The visible, non-secret start of the key ("pmk_ab12cd34"); also how a presented key is looked up.</summary>
        public string Prefix { get; set; } = "";
        public string SecretHash { get; set; } = "";
        public Guid UserId { get; set; }
        public ApiKeyScope Scope { get; set; } = ApiKeyScope.ReadOnly;
        public DateTime? ExpiresAt { get; set; }
        public DateTime? LastUsedAt { get; set; }
        public string? LastUsedIp { get; set; }
        public DateTime? RevokedAt { get; set; }
        public Guid? RevokedBy { get; set; }

        public User? User { get; set; }
    }
}
