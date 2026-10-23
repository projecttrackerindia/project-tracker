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

        // ---- filters: fewer, more useful calls. Empty means no filter.
        /// <summary>Only events of these projects (comma-separated ids).</summary>
        public string? FilterProjects { get; set; }
        /// <summary>Only work of these priorities (comma-separated: High,Critical).</summary>
        public string? FilterPriorities { get; set; }
        /// <summary>Status changes only when the new status is one of these (comma-separated names, "Done" also matching Completed and Resolved).</summary>
        public string? FilterStatuses { get; set; }
        /// <summary>When the owner was warned that deliveries keep failing (before the automatic switch-off). Cleared by a success.</summary>
        public DateTime? WarnedAt { get; set; }
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
        /// <summary>How long the receiver took to answer the last attempt.</summary>
        public int? DurationMs { get; set; }
        /// <summary>A replay: the delivery whose event this sends again.</summary>
        public Guid? ReplayOf { get; set; }
    }

    /// <summary>
    /// A private address other systems post to (a monitoring alert, a website form, a core-banking job failure). Each request is turned into
    /// an Operations ticket, a project task or a reminder by a mapping set from an example request; repeats of the same thing are merged into
    /// the open item with a count instead of becoming a hundred items.
    /// </summary>
    public class IncomingWebhook : TenantEntity, ITenantScoped
    {
        public string Name { get; set; } = "";
        /// <summary>The secret part of the address (…/hooks/in/{Token}).</summary>
        public string Token { get; set; } = "";
        /// <summary>Optional: requests must carry this secret (a header) or an HMAC-SHA256 signature made with it. Encrypted.</summary>
        public string? SecretProtected { get; set; }
        /// <summary>ticket (Operations), task (a project task) or reminder.</summary>
        public string Target { get; set; } = "ticket";
        public Guid? ProjectId { get; set; }
        public Guid? WorkTypeId { get; set; }
        /// <summary>Who gets the work (or the reminder) when the request does not name a member.</summary>
        public Guid? AssigneeId { get; set; }
        public string DefaultPriority { get; set; } = "Medium";
        /// <summary>The mapping as JSON: title, description, priority, dedupe key, assignee and resolve templates ({{path.in.request}}).</summary>
        public string Mapping { get; set; } = "{}";
        /// <summary>Repeats within this many minutes of the last one are merged into the open item.</summary>
        public int MergeMinutes { get; set; } = 1440;
        public bool IsActive { get; set; } = true;
        /// <summary>The work is raised as this member (the person who set the address up, unless changed).</summary>
        public Guid ActingUserId { get; set; }
        public int Received { get; set; }
        public int CreatedCount { get; set; }
        public int MergedCount { get; set; }
        public DateTime? LastReceivedAt { get; set; }
        public string? LastError { get; set; }
        /// <summary>The last request body (cut to 8 KB), for setting the mapping by example.</summary>
        public string? Sample { get; set; }
    }

    /// <summary>One request to an incoming address and what became of it.</summary>
    public class IncomingWebhookEvent : TenantEntity, ITenantScoped
    {
        public Guid IncomingWebhookId { get; set; }
        public DateTime ReceivedAt { get; set; }
        /// <summary>created, merged, resolved, ignored, rejected or failed.</summary>
        public string Status { get; set; } = "";
        public string? DedupeKey { get; set; }
        public string? Title { get; set; }
        public string? TargetType { get; set; }
        public Guid? TargetId { get; set; }
        public string? TargetKey { get; set; }
        public string? Error { get; set; }
        /// <summary>The request body, cut to 4 KB.</summary>
        public string? Body { get; set; }
    }

    /// <summary>The open item a stream of repeats is merged into, with how many times it was seen.</summary>
    public class IncomingWebhookThread : TenantEntity, ITenantScoped
    {
        public Guid IncomingWebhookId { get; set; }
        public string DedupeKey { get; set; } = "";
        public string TargetType { get; set; } = "";
        public Guid TargetId { get; set; }
        public string? TargetKey { get; set; }
        public int Count { get; set; }
        public DateTime FirstAt { get; set; }
        public DateTime LastAt { get; set; }
    }
}
