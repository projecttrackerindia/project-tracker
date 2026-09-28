using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Entities
{
    /// <summary>
    /// A platform administrator's exception to one organization's plan, for example "API access for 30 days while they evaluate". It replaces
    /// the plan's value for that one feature until it expires. Not tenant-filtered: it is read across tenants by the entitlement service.
    /// </summary>
    public class TenantFeatureOverride : TenantEntity
    {
        public string FeatureKey { get; set; } = "";
        public long Value { get; set; }
        public string Reason { get; set; } = "";
        public DateTime? ExpiresAt { get; set; }
    }

    /// <summary>A platform-wide switch or message (sign-ups open, maintenance mode, announcement banner). One row per key.</summary>
    public class PlatformSetting : AuditableEntity
    {
        public string Key { get; set; } = "";
        public string Value { get; set; } = "";
    }
}
