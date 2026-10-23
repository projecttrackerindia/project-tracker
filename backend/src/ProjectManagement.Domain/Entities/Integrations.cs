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
    /// One person's Google account, connected so Project Tracker can create Calendar events with a Google Meet conference on their behalf.
    /// Per-user (not a shared workspace credential): a meeting is organized as the Project Tracker user who scheduled it, which is only
    /// possible when each organizer has their own Google grant. The refresh token is encrypted at rest and is never sent to the browser;
    /// the short-lived access token is cached here purely to avoid a refresh on every call and is also encrypted.
    /// </summary>
    public class GoogleConnection : TenantEntity, ITenantScoped
    {
        public Guid ConsentEpoch { get; set; }
        public Guid UserId { get; set; }
        public string GoogleEmail { get; set; } = "";
        public string RefreshTokenProtected { get; set; } = "";
        public string? AccessTokenProtected { get; set; }
        public DateTime? AccessTokenExpiresAt { get; set; }
        /// <summary>Space-separated OAuth scopes actually granted (Google may grant fewer than requested).</summary>
        public string Scopes { get; set; } = "";
        public DateTime ConnectedAt { get; set; }
        public DateTime? LastSyncAt { get; set; }
        public string? LastError { get; set; }
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

        // From the GitHub App (richer than a plain webhook): the branch, checks, reviews, size and risk of a pull request.
        public string? Branch { get; set; }
        public string? HeadSha { get; set; }
        /// <summary>success, failure or pending (the latest checks on the head commit).</summary>
        public string? ChecksState { get; set; }
        /// <summary>approved, changes_requested or pending.</summary>
        public string? ReviewState { get; set; }
        /// <summary>GitHub user ids asked to review, comma separated, and since when.</summary>
        public string? ReviewerIds { get; set; }
        public DateTime? ReviewRequestedAt { get; set; }
        public long? AuthorGitHubId { get; set; }
        public bool Draft { get; set; }
        public int? Additions { get; set; }
        public int? Deletions { get; set; }
        public int? ChangedFiles { get; set; }
        /// <summary>The files changed (up to 60 paths, one per line): for risk and for who knows which part of the code.</summary>
        public string? Files { get; set; }
        /// <summary>0-100, and the reasons (a reason to look twice, never a gate).</summary>
        public int? RiskScore { get; set; }
        public string? RiskReasons { get; set; }
        public DateTime? OpenedAt { get; set; }
        public DateTime? MergedAt { get; set; }
        /// <summary>The first commit of a merged pull request (lead time starts here).</summary>
        public DateTime? FirstCommitAt { get; set; }
        public DateTime? NudgedAt { get; set; }
    }

    /// <summary>
    /// The workspace's installation of the ProjectTracker GitHub App: no secrets to paste, every chosen repository's events arrive, and the
    /// app can create branches. One GitHub account (organization or user) per row; an installation belongs to one workspace.
    /// </summary>
    public class GitHubInstallation : TenantEntity, ITenantScoped
    {
        public long InstallationId { get; set; }
        public string AccountLogin { get; set; } = "";
        public string AccountType { get; set; } = "Organization";
        /// <summary>all or selected.</summary>
        public string RepositorySelection { get; set; } = "selected";
        /// <summary>The repositories it can see (full names, one per line), refreshed on install and on changes.</summary>
        public string Repositories { get; set; } = "";
        public Guid InstalledBy { get; set; }
        public DateTime? SuspendedAt { get; set; }
        /// <summary>Status follows the code: which task status each event moves to (JSON). Empty: the defaults.</summary>
        public string? StatusRules { get; set; }
        /// <summary>Folders where a first-time change is a reason to look twice (one per line, like db/migrations or src/payments).</summary>
        public string RiskyPaths { get; set; } = "";
        /// <summary>"Fixes WEB-12" in a merged pull request or a commit on the default branch completes the task.</summary>
        public bool CloseOnKeyword { get; set; } = true;
        public int Received { get; set; }
        public DateTime? LastEventAt { get; set; }
        public string? LastError { get; set; }
    }

    /// <summary>A deployment GitHub reported (for delivery metrics): which commit went to which environment, and how it ended.</summary>
    public class GitDeployment : TenantEntity, ITenantScoped
    {
        public long DeploymentId { get; set; }
        public string Repository { get; set; } = "";
        public string Environment { get; set; } = "";
        public string Sha { get; set; } = "";
        /// <summary>success, failure, error, in_progress or queued.</summary>
        public string State { get; set; } = "queued";
        public DateTime StartedAt { get; set; }
        public DateTime? FinishedAt { get; set; }
        public string? Url { get; set; }
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

    /// <summary>
    /// One browser or installed app that accepts push notifications for a person (Web Push). It belongs to the person, not a workspace, and
    /// is removed when the push service says it is gone.
    /// </summary>
    public class PushSubscription : Entity
    {
        public Guid UserId { get; set; }
        public string Endpoint { get; set; } = "";
        public string P256dh { get; set; } = "";
        public string Auth { get; set; } = "";
        public string? UserAgent { get; set; }
        public DateTime CreatedAt { get; set; }
        public DateTime? LastSuccessAt { get; set; }
        public int Failures { get; set; }
        /// <summary>The person chose this device to approve their sign-ins on other screens (a plan feature).</summary>
        public bool AllowsSignIn { get; set; }
    }
}
