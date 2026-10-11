using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Entities;

/// <summary>Reserved for a verified organization-owned installation; no public token registration endpoint.</summary>
public class WhatsAppConnection : TenantEntity, ITenantScoped
{
    public string AppId { get; set; } = "";
    public string BusinessAccountId { get; set; } = "";
    public string PhoneNumberId { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public string AccessTokenProtected { get; set; } = "";
    public Guid InstalledBy { get; set; }
    public DateTime ConnectedAt { get; set; }
    public DateTime? TokenExpiresAt { get; set; }
    public bool Active { get; set; }
    public DateTime? HealthAttemptedAt { get; set; }
    public DateTime? HealthCheckedAt { get; set; }
    public Guid? HealthLeaseId { get; set; }
    public DateTime? HealthLeaseUntil { get; set; }
    public string? HealthConfigurationHash { get; set; }
    public string HealthState { get; set; } = "unchecked";
    public bool? HealthTokenValid { get; set; }
    public bool? HealthScopesPresent { get; set; }
    public bool? HealthAssetsVerified { get; set; }
    public bool? HealthAppSubscribed { get; set; }
    public bool? HealthPhoneVerified { get; set; }
}

/// <summary>Inbound message metadata only. No phone numbers, message text, attachments or authorization claims.</summary>
public class WhatsAppInboundReceipt : TenantEntity, ITenantScoped
{
    public string AppId { get; set; } = "";
    public string PhoneNumberId { get; set; } = "";
    public string ProviderMessageId { get; set; } = "";
    public string MessageType { get; set; } = "";
    public DateTime ProviderCreatedAt { get; set; }
    public DateTime ReceivedAt { get; set; }
}