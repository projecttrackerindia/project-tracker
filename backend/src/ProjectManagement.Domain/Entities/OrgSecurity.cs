using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Entities;

/// <summary>
/// An organization's own access rules, on top of the platform's: require every member to have two-step verification turned on, and/or
/// only allow sign-in to this workspace from listed networks. One row per tenant, created the first time either is turned on.
/// An Enterprise-tier feature (FeatureKeys.AdvancedSecurity): if the plan no longer includes it, the settings stay saved but stop
/// being enforced, so a downgrade never locks a whole workspace out by itself.
/// </summary>
public class TenantSecuritySettings : TenantEntity, ITenantScoped
{
    public bool RequireMfa { get; set; }
    public bool IpAllowlistEnabled { get; set; }
    /// <summary>One IP address or CIDR range per line (e.g. "203.0.113.9" or "10.0.0.0/8"). Empty when the allowlist is off.</summary>
    public string IpRanges { get; set; } = "";

    /// <summary>How long a revealed secret stays on screen before it is masked again (10, 15, 30, 60 or a custom 5-300). Business plans can change it; others use the default.</summary>
    public int RevealSeconds { get; set; } = 15;

    // The tamper-evident audit trail (see AuditChainService): where the verified chain starts after old rows were purged, and how far it was last checked.
    public long? ChainAnchorSeq { get; set; }
    public string? ChainAnchorHash { get; set; }
    public long? ChainVerifiedSeq { get; set; }
    public string? ChainVerifiedHash { get; set; }
    public DateTime? ChainVerifiedAt { get; set; }
    public long? ChainBrokenSeq { get; set; }
    public DateTime? ChainBrokenAt { get; set; }
}
