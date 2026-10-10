using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Entities;

/// <summary>One Slack installation belongs to one organization. Tokens never appear in API DTOs.</summary>
public class SlackConnection : TenantEntity, ITenantScoped
{
    public string TeamId { get; set; } = "";
    public string TeamName { get; set; } = "";
    public string AppId { get; set; } = "";
    public string BotUserId { get; set; } = "";
    public string BotTokenProtected { get; set; } = "";
    public string Scopes { get; set; } = "";
    public Guid InstalledBy { get; set; }
    public DateTime ConnectedAt { get; set; }
    public bool Active { get; set; }
    public string? LastError { get; set; }
}

/// <summary>Global lookup by cryptographic state hash; all other lookups use explicit tenant and user IDs.</summary>
public class SlackOAuthAttempt : Entity
{
    public Guid TenantId { get; set; }
    public Guid UserId { get; set; }
    public string StateHash { get; set; } = "";
    public string BrowserHash { get; set; } = "";
    public string ReturnPath { get; set; } = "";
    public DateTime ExpiresAt { get; set; }
    public DateTime? ConsumedAt { get; set; }
}

/// <summary>Signed lifecycle event IDs prevent an old retry from revoking a later installation.</summary>
public class SlackEventReceipt : Entity
{
    public string AppId { get; set; } = "";
    public string TeamId { get; set; } = "";
    public string EventId { get; set; } = "";
    public DateTime ReceivedAt { get; set; }
}
