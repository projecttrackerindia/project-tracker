using ProjectManagement.Domain.Common;
namespace ProjectManagement.Domain.Entities;
/// <summary>Private, self-service contact proof. This does not grant messaging consent or project access.</summary>
public class WhatsAppContactLink : TenantEntity, ITenantScoped
{
    public Guid UserId { get; set; }
    public Guid ConnectionId { get; set; }
    public DateTime ConnectionConnectedAt { get; set; }
    public string PhoneProtected { get; set; } = "";
    public string? PhoneHash { get; set; }
    public string ConfigurationHash { get; set; } = "";
    public string? ChallengeHash { get; set; }
    public DateTime? ChallengeIssuedAt { get; set; }
    public DateTime? ChallengeExpiresAt { get; set; }
    public DateTime? VerifiedAt { get; set; }
    public string? ConsentVersion { get; set; }
    public DateTime? ConsentAt { get; set; }
    public int NotificationPreferencesVersion { get; set; }
    public string? NotificationConsentVersion { get; set; }
    public DateTime? NotificationConsentAt { get; set; }
    public DateTime? NotificationConsentExpiresAt { get; set; }
    public bool NotifyTaskAssignments { get; set; }
    public bool NotifyOverdue { get; set; }
    public bool NotifySupportUpdates { get; set; }
    public string? NotificationTimeZone { get; set; }
    public int NotificationQuietStartMinutes { get; set; } = 1320;
    public int NotificationQuietEndMinutes { get; set; } = 480;
    public DateTime RateWindowAt { get; set; }
    public int ChallengesIssued { get; set; }
}
