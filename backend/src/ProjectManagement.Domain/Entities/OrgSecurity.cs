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
}
