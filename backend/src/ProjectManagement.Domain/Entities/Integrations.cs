using ProjectManagement.Domain.Common;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Domain.Enums
{
    /// <summary>How a webhook's requests are written: signed JSON for your own systems, or a ready-made message for a Slack or Microsoft Teams channel.</summary>
    public enum WebhookFormat { Json, Slack, Teams }

    /// <summary>Where commits and pull requests come from.</summary>
    public enum GitProvider { GitHub, AzureDevOps }
}

namespace ProjectManagement.Domain.Entities
{
    /// <summary>
    /// A person's private calendar subscription (an iCalendar feed) for one workspace: Outlook, Google Calendar or Apple Calendar fetch it by
    /// URL. The token is looked up by its hash and kept encrypted so its owner can copy the address again; resetting it makes the old
    /// address stop working.
    /// </summary>
    public class CalendarFeed : TenantEntity, ITenantScoped
    {
        public Guid UserId { get; set; }
        public string TokenHash { get; set; } = "";
        public string TokenProtected { get; set; } = "";
        /// <summary>The first characters of the token, so the address can be recognised in the list without revealing it.</summary>
        public string Prefix { get; set; } = "";
        public DateTime? LastUsedAt { get; set; }
    }

    /// <summary>
    /// A workspace's inbound mailbox: email sent to it (through a provider such as Mailgun, SendGrid or Postmark forwarding to this server)
    /// becomes operational work. Only mail from members of the workspace is accepted.
    /// </summary>
    public class InboundMailbox : TenantEntity, ITenantScoped
    {
        public bool Enabled { get; set; } = true;
        /// <summary>A random token: part of the address (work+token@domain) and of the URL the provider posts to.</summary>
        public string Token { get; set; } = "";
        public Guid? WorkTypeId { get; set; }
        public Priority Priority { get; set; } = Priority.Medium;
        public int Received { get; set; }
        public DateTime? LastReceivedAt { get; set; }
        public string? LastError { get; set; }
        /// <summary>Emails accepted on <see cref="Day"/> (a daily cap keeps a mail loop from flooding the workspace).</summary>
        public DateOnly? Day { get; set; }
        public int DayCount { get; set; }
    }

    /// <summary>
    /// A connection to a GitHub or Azure DevOps repository host. Its push and pull-request events are posted to a URL containing the token
    /// and checked with the secret; commits that mention a task key (WEB-12, WT-5) are linked to it.
    /// </summary>
    public class GitConnection : TenantEntity, ITenantScoped
    {
        public GitProvider Provider { get; set; }
        public string Name { get; set; } = "";
        public string Token { get; set; } = "";
        /// <summary>GitHub: the webhook secret (HMAC). Azure DevOps: the password of the service hook's basic authentication. Encrypted.</summary>
        public string SecretProtected { get; set; } = "";
        /// <summary>"Fixes WEB-12" / "Closes WT-5" in a commit on the default branch, or a merged pull request, completes the task.</summary>
        public bool CloseOnKeyword { get; set; } = true;
        public int Received { get; set; }
        public DateTime? LastReceivedAt { get; set; }
        public string? LastError { get; set; }
    }

    /// <summary>A commit or pull request that mentions a project task or a work task.</summary>
    public class DevLink : TenantEntity, ITenantScoped
    {
        public Guid? TaskId { get; set; }
        public Guid? WorkTaskId { get; set; }
        public GitProvider Provider { get; set; }
        /// <summary>"commit" or "pull_request".</summary>
        public string Kind { get; set; } = "commit";
        /// <summary>The commit SHA or pull request number.</summary>
        public string ExternalId { get; set; } = "";
        public string Title { get; set; } = "";
        public string Url { get; set; } = "";
        public string? Repository { get; set; }
        public string? Author { get; set; }
        /// <summary>Pull requests: open, merged or closed.</summary>
        public string? State { get; set; }
        public DateTime OccurredAt { get; set; }
    }

    /// <summary>
    /// How long a workspace keeps its history. Empty values keep everything (activity is never kept longer than the plan allows).
    /// The nightly maintenance job deletes what is older.
    /// </summary>
    public class TenantDataPolicy : TenantEntity, ITenantScoped
    {
        public int? ActivityRetentionDays { get; set; }
        public int? NotificationRetentionDays { get; set; }
        public int? ChatRetentionDays { get; set; }
        public int? AuditRetentionDays { get; set; }
        public DateTime? LastPurgedAt { get; set; }
    }
}
