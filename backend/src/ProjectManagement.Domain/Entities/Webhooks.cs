using ProjectManagement.Domain.Common;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Domain.Enums
{
    public enum WebhookDeliveryStatus { Pending, Succeeded, Failed }
}

namespace ProjectManagement.Domain.Entities
{
    /// <summary>
    /// An address that is told, by an HTTPS request, whenever something happens in the workspace. Each request is signed with the webhook's
    /// secret so the receiver can tell it really came from here.
    /// </summary>
    public class Webhook : TenantEntity, ITenantScoped
    {
        public string Name { get; set; } = "";
        public string Url { get; set; } = "";
        /// <summary>The signing secret, encrypted. Shown to the person once, when it is created or rotated.</summary>
        public string SecretProtected { get; set; } = "";
        /// <summary>Comma-separated event patterns: "*", "task.*" or an exact name such as "task.created". Audit events ("audit.logged") are only sent when named.</summary>
        public string Events { get; set; } = "*";
        /// <summary>Signed JSON for your own systems, or a ready-made message for a Slack or Microsoft Teams channel.</summary>
        public WebhookFormat Format { get; set; } = WebhookFormat.Json;
        /// <summary>Audit log streaming: audit records up to this moment have already been turned into deliveries.</summary>
        public DateTime? AuditCursorAt { get; set; }
        public bool IsActive { get; set; } = true;
        public string? DisabledReason { get; set; }

        /// <summary>Activity up to this moment has already been turned into deliveries; only newer events are sent.</summary>
        public DateTime CursorAt { get; set; }
        public int ConsecutiveFailures { get; set; }
        public DateTime? LastDeliveryAt { get; set; }
        public string? LastStatus { get; set; }
    }

    /// <summary>One event on its way to one webhook, with its retries and the answer it got.</summary>
    public class WebhookDelivery : TenantEntity, ITenantScoped
    {
        public Guid WebhookId { get; set; }
        /// <summary>The activity record this delivery reports (null for test pings). One delivery per activity and webhook.</summary>
        public Guid? ActivityId { get; set; }
        public string EventType { get; set; } = "";
        public string Payload { get; set; } = "";
        public WebhookDeliveryStatus Status { get; set; } = WebhookDeliveryStatus.Pending;
        public int Attempts { get; set; }
        public DateTime NextAttemptAt { get; set; }
        public int? ResponseStatus { get; set; }
        public string? ResponseSnippet { get; set; }
        public string? Error { get; set; }
        public DateTime? DeliveredAt { get; set; }
    }
}
