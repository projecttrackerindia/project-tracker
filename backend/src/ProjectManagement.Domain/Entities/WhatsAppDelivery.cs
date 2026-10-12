using ProjectManagement.Domain.Common;
namespace ProjectManagement.Domain.Entities;
/// <summary>Durable notification delivery metadata. No message body, recipient phone or token.</summary>
public class WhatsAppDelivery : TenantEntity, ITenantScoped
{
    public Guid UserId { get; set; }
    public Guid NotificationId { get; set; }
    public Guid ConnectionId { get; set; }
    public DateTime ConnectionConnectedAt { get; set; }
    public Guid ContactId { get; set; }
    public int PreferencesVersion { get; set; }
    public string ConfigurationHash { get; set; } = "";
    public string Category { get; set; } = "";
    public string ResourceKind { get; set; } = "";
    public Guid ResourceId { get; set; }
    public Guid? ResourceProjectId { get; set; }
    public string State { get; set; } = "queued";
    public string? Reason { get; set; }
    public DateTime AvailableAt { get; set; }
    public DateTime ExpiresAt { get; set; }
    public Guid? LeaseId { get; set; }
    public DateTime? LeaseUntil { get; set; }
    public int PreparationAttempts { get; set; }
    public DateTime? AttemptedAt { get; set; }
    public DateTime? AcceptedAt { get; set; }
    public DateTime? ProviderStatusAt { get; set; }
    public string? ProviderMessageId { get; set; }
    public string CallbackTag { get; set; } = "";
    public string? RecipientHash { get; set; }
}
