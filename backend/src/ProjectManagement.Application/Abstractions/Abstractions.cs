using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Abstractions;

public interface IAppDbContext
{
    Task<int> LockTenantLedgerAsync(Guid tenantId, CancellationToken ct);
    DbSet<AiCreditAccount> AiCreditAccounts { get; }
    DbSet<AiCreditReservation> AiCreditReservations { get; }
    DbSet<AiCreditEntry> AiCreditEntries { get; }
    DbSet<AiCreditBudget> AiCreditBudgets { get; }
    DbSet<AiCreditBudgetUsage> AiCreditBudgetUsages { get; }
    DbSet<AiCreditBudgetHold> AiCreditBudgetHolds { get; }
    DbSet<User> Users { get; }
    DbSet<UserSession> UserSessions { get; }
    DbSet<RefreshToken> RefreshTokens { get; }
    DbSet<MfaRecoveryCode> MfaRecoveryCodes { get; }
    DbSet<Tenant> Tenants { get; }
    DbSet<TenantMember> TenantMembers { get; }
    DbSet<TenantInvitation> TenantInvitations { get; }
    DbSet<RolePermissionOverride> RolePermissionOverrides { get; }
    DbSet<Team> Teams { get; }
    DbSet<DocumentType> DocumentTypes { get; }
    DbSet<Document> Documents { get; }
    DbSet<DocumentVersion> DocumentVersions { get; }
    DbSet<DocumentSection> DocumentSections { get; }
    DbSet<DocumentTag> DocumentTags { get; }
    DbSet<DocumentLink> DocumentLinks { get; }
    DbSet<DocumentGrant> DocumentGrants { get; }
    DbSet<DocumentFile> DocumentFiles { get; }
    DbSet<WorkflowDefinition> WorkflowDefinitions { get; }
    DbSet<DocumentApproval> DocumentApprovals { get; }
    DbSet<ApprovalDecision> ApprovalDecisions { get; }
    DbSet<AccessRequest> AccessRequests { get; }
    DbSet<DocumentRequirement> DocumentRequirements { get; }
    DbSet<ApiDefinition> ApiDefinitions { get; }
    DbSet<ApiEndpoint> ApiEndpoints { get; }
    DbSet<ApiSnapshot> ApiSnapshots { get; }
    DbSet<EndpointRevision> EndpointRevisions { get; }
    DbSet<SensitiveValue> SensitiveValues { get; }
    DbSet<DocumentKey> DocumentKeys { get; }
    /// <summary>Inside a transaction, lets the retention job delete audit rows (PostgreSQL only; elsewhere nothing to do). Without it the database refuses every update and delete of an audit row.</summary>
    Task AllowAuditPurgeAsync(CancellationToken ct);
    DbSet<StepUpGrant> StepUpGrants { get; }
    DbSet<TeamMember> TeamMembers { get; }
    DbSet<OrgRole> OrgRoles { get; }
    DbSet<Project> Projects { get; }
    DbSet<ProjectMember> ProjectMembers { get; }
    DbSet<WorkflowStatus> WorkflowStatuses { get; }
    DbSet<ProjectStage> ProjectStages { get; }
    DbSet<StageIssue> StageIssues { get; }
    DbSet<WorkType> WorkTypes { get; }
    DbSet<WorkTask> WorkTasks { get; }
    DbSet<WorkTaskComment> WorkTaskComments { get; }
    DbSet<WorkTaskAttachment> WorkTaskAttachments { get; }
    DbSet<ProjectGroup> ProjectGroups { get; }
    DbSet<DueDateChange> DueDateChanges { get; }
    DbSet<StageIssueEvent> StageIssueEvents { get; }
    DbSet<Label> Labels { get; }
    DbSet<CustomTimelineTemplate> CustomTimelineTemplates { get; }
    DbSet<TaskItem> Tasks { get; }
    DbSet<TaskLabel> TaskLabels { get; }
    DbSet<TaskDependency> TaskDependencies { get; }
    DbSet<Milestone> Milestones { get; }
    DbSet<TenantFeatureOverride> TenantFeatureOverrides { get; }
    DbSet<PlatformSetting> PlatformSettings { get; }
    DbSet<Webhook> Webhooks { get; }
    DbSet<WebhookDelivery> WebhookDeliveries { get; }
    DbSet<PasswordHistory> PasswordHistories { get; }
    DbSet<TenantSecuritySettings> TenantSecuritySettings { get; }
    DbSet<UserConsent> UserConsents { get; }
    DbSet<Conversation> Conversations { get; }
    DbSet<ConversationMember> ConversationMembers { get; }
    DbSet<ChatMessage> ChatMessages { get; }
    DbSet<ChatMention> ChatMentions { get; }
    DbSet<ApiKey> ApiKeys { get; }
    DbSet<SsoConnection> SsoConnections { get; }
    DbSet<SsoDomain> SsoDomains { get; }
    DbSet<SsoGroupMapping> SsoGroupMappings { get; }
    DbSet<ScimToken> ScimTokens { get; }
    DbSet<UserLogin> UserLogins { get; }
    DbSet<CustomFieldDefinition> CustomFieldDefinitions { get; }
    DbSet<CustomFieldValue> CustomFieldValues { get; }
    DbSet<ChecklistItem> ChecklistItems { get; }
    DbSet<PrioritySetting> PrioritySettings { get; }
    DbSet<ReportExport> ReportExports { get; }
    DbSet<Sprint> Sprints { get; }
    DbSet<TimeEntry> TimeEntries { get; }
    DbSet<TimesheetApproval> TimesheetApprovals { get; }
    DbSet<SlaPolicy> SlaPolicies { get; }
    DbSet<CalendarFeed> CalendarFeeds { get; }
    DbSet<InboundMailbox> InboundMailboxes { get; }
    DbSet<GitConnection> GitConnections { get; }
    DbSet<GoogleConnection> GoogleConnections { get; }
    DbSet<ProjectMeeting> ProjectMeetings { get; }
    DbSet<MeetingParticipant> MeetingParticipants { get; }
    DbSet<DevLink> DevLinks { get; }
    DbSet<TenantDataPolicy> TenantDataPolicies { get; }
    DbSet<AutomationRun> AutomationRuns { get; }
    DbSet<PushSubscription> PushSubscriptions { get; }
    DbSet<DeviceLoginRequest> DeviceLoginRequests { get; }
    DbSet<IdempotencyRecord> IdempotencyRecords { get; }
    DbSet<PasskeyCredential> PasskeyCredentials { get; }
    DbSet<EmailLog> EmailLogs { get; }
    DbSet<BillingEvent> BillingEvents { get; }
    DbSet<EmailSuppression> EmailSuppressions { get; }
    DbSet<PasskeyChallenge> PasskeyChallenges { get; }
    DbSet<Reminder> Reminders { get; }
    DbSet<AiConversation> AiConversations { get; }
    DbSet<AiJob> AiJobs { get; }
    DbSet<AiSchedule> AiSchedules { get; }
    DbSet<AiMessage> AiMessages { get; }
    DbSet<AiAttachment> AiAttachments { get; }
    DbSet<ChatAttachment> ChatAttachments { get; }
    DbSet<ChatReaction> ChatReactions { get; }
    DbSet<AiUserProfile> AiUserProfiles { get; }
    DbSet<ReminderSettings> ReminderSettings { get; }
    DbSet<ReminderPolicy> ReminderPolicies { get; }
    DbSet<AutomationRule> AutomationRules { get; }
    DbSet<TaskComment> TaskComments { get; }
    DbSet<Activity> Activities { get; }
    DbSet<Notification> Notifications { get; }
    DbSet<NotificationPreference> NotificationPreferences { get; }
    DbSet<Attachment> Attachments { get; }
    DbSet<AuditLog> AuditLogs { get; }
    DbSet<Plan> Plans { get; }
    DbSet<PlanFeature> PlanFeatures { get; }
    DbSet<Subscription> Subscriptions { get; }
    DbSet<Invoice> Invoices { get; }

    DatabaseFacade Database { get; }
    /// <summary>How many schema migrations the database has not applied yet (0 when it is up to date).</summary>
    Task<int> PendingMigrationCountAsync(CancellationToken ct = default);
    Task<int> SaveChangesAsync(CancellationToken cancellationToken = default);
}

/// <summary>
/// Identity, workspace and tenant resolved server-side for the current request (spec section 57).
/// Nothing here is ever taken from a client-supplied TenantId / UserId / Role.
/// </summary>
public interface ICurrentContext
{
    Guid? UserId { get; }
    Guid? SessionId { get; }
    Guid? TenantId { get; }
    TenantRole? Role { get; }
    WorkspaceType? WorkspaceType { get; }
    bool IsPlatformAdmin { get; }
    string? IpAddress { get; }
    string? UserAgent { get; }
    /// <summary>Set instead of TenantId when the access token names a workspace the person is a member of, but the organization's own
    /// security rules (required two-step verification, an IP allowlist) refuse this particular request. Lets GetContextAsync explain
    /// why, rather than the person just seeing "no workspace" with no way to tell what to do about it.</summary>
    (Guid WorkspaceId, string Code, string Message)? BlockedWorkspace { get; }
    /// <summary>The signed-in person still has the temporary password an administrator gave them and must replace it.</summary>
    bool MustChangePassword { get; }
    /// <summary>How far this request's person may reach into projects (decided once per request, from the workspace setting and their role). Every project and task query is narrowed by it.</summary>
    ProjectScope ProjectScope { get; }
    /// <summary>The one team this request looks at (the person picked it in the app and may pick it), or null for every team they can see. Reads only; narrows every project and task query.</summary>
    Guid? TeamLens { get; }
    /// <summary>True when this request reaches only some of the workspace's projects (a narrowed scope, or one team in view).</summary>
    bool RestrictsProjects { get; }
    /// <summary>The projects this request reaches when <see cref="RestrictsProjects"/> is true (worked out once per request; empty otherwise).</summary>
    Guid[] ProjectIds { get; }
    /// <summary>A project this request has just created is part of what it can see, whatever team it is in.</summary>
    void GrantProject(Guid projectId);
    Guid RequireUserId();
    Guid RequireTenantId();
}

public class CurrentContext : ICurrentContext
{
    public Guid? UserId { get; set; }
    public Guid? SessionId { get; set; }
    public Guid? TenantId { get; set; }
    public TenantRole? Role { get; set; }
    public WorkspaceType? WorkspaceType { get; set; }
    public bool IsPlatformAdmin { get; set; }
    public string? IpAddress { get; set; }
    public string? UserAgent { get; set; }
    public (Guid WorkspaceId, string Code, string Message)? BlockedWorkspace { get; set; }
    public bool MustChangePassword { get; set; }
    public ProjectScope ProjectScope { get; set; }
    public Guid? TeamLens { get; set; }
    public bool RestrictsProjects { get; set; }
    public Guid[] ProjectIds { get; set; } = [];
    public void GrantProject(Guid projectId) { if (RestrictsProjects && !ProjectIds.Contains(projectId)) ProjectIds = [.. ProjectIds, projectId]; }

    public Guid RequireUserId() => UserId ?? throw new Exceptions.UnauthorizedException();
    public Guid RequireTenantId() => TenantId ?? throw new Exceptions.ForbiddenException(
        "No active workspace. Select a workspace first.", "WORKSPACE_REQUIRED");
}

public interface IPasswordHasher
{
    string Hash(string password);
    bool Verify(string hash, string password);
}

public record AccessToken(string Token, DateTime ExpiresAt);

public interface ITokenService
{
    AccessToken CreateAccessToken(User user, Guid sessionId, Guid? workspaceId);
    /// <summary>Random opaque token plus the hash that is persisted.</summary>
    (string Raw, string Hash) CreateOpaqueToken();
    string Hash(string rawToken);
    /// <summary>A short-lived signed token that proves the password step of a sign-in succeeded (second step of two-step verification).</summary>
    string CreateChallenge(Guid userId, TimeSpan lifetime);
    /// <summary>The user a valid, unexpired challenge was issued for, otherwise null.</summary>
    Guid? ReadChallenge(string token);
}

/// <summary>Encrypts secrets that must be recoverable (for example authenticator-app secrets) before they reach the database.</summary>
/// <summary>Accounts created by single sign-on or a social sign-in have no password until the person sets one (forgot / reset password).</summary>
public static class PasswordHashes
{
    public const string None = "!";
}

/// <summary>Something changed in a workspace (one activity record): enough for open screens to know what to reload, nothing more.</summary>
public record ChangeEvent(Guid TenantId, string EntityType, Guid? EntityId, Guid? ProjectId, string Action, Guid? ActorId);

/// <summary>Tells the people who have the app open that something changed, so boards and lists update without a reload.</summary>
public interface IChangeFeed
{
    void Publish(IReadOnlyList<ChangeEvent> changes);
}

public interface ISecretProtector
{
    string Protect(string plainText);
    string Unprotect(string protectedText);
}

/// <param name="Kind">What the message is for ("verify", "reset", "invite", "security" ...). Messages with a kind are kept and retried if the mail server is down; without one a failure is reported to the caller.</param>
/// <param name="Headers">Extra headers, such as List-Unsubscribe.</param>
public record EmailMessage(string To, string Subject, string Html, string? Text = null, string? Kind = null, IReadOnlyDictionary<string, string>? Headers = null);

/// <summary>A provider that really sends (SMTP, Resend, or the development log). The app talks to <see cref="IEmailSender"/>, which adds suppression, logging and retries around one of these.</summary>
public interface IEmailTransport : IEmailSender { }

public interface IEmailSender
{
    /// <summary>"log" (messages are only written to the server log) or "smtp".</summary>
    string Name { get; }
    Task SendAsync(EmailMessage message, CancellationToken ct = default);
}

/// <summary>
/// Where uploaded files live (spec section 28: storage is abstracted; files never go into PostgreSQL). Keys are opaque and generated
/// by the server. Implementations: local disk today; S3 / Azure Blob / GCS can be added behind the same interface.
/// </summary>
public interface IFileStorage
{
    string Name { get; }
    Task SaveAsync(string key, Stream content, CancellationToken ct = default);
    Task<Stream?> OpenReadAsync(string key, CancellationToken ct = default);
    Task DeleteAsync(string key, CancellationToken ct = default);
    Task<bool> ExistsAsync(string key, CancellationToken ct = default);
}

public record PaymentResult(bool Success, string? Reference, string? Error);

/// <summary>What the browser needs to open the provider's payment window for a subscription.</summary>
public record HostedCheckout(string Provider, string KeyId, string SubscriptionId, string Name, string Description, long AmountMinor, string Currency);

/// <summary>
/// Takes the money. The simulated provider charges at once; a real one (Razorpay) is hosted: the owner pays in the provider's window, and the provider then
/// tells us by a signed message (and the browser's confirmation) that the subscription is active, charged again each month, failed or cancelled.
/// </summary>
public interface IPaymentProvider
{
    /// <summary>"mock" or "razorpay".</summary>
    string Name { get; }
    /// <summary>True when the owner has to pay in the provider's window (nothing is charged on the server alone).</summary>
    bool RequiresCheckout { get; }
    Task<PaymentResult> ChargeAsync(Guid tenantId, string planCode, decimal amount, string currency, CancellationToken ct = default);
    /// <summary>The provider's id for a plan at this price (created, or re-created after a price change).</summary>
    Task<string> EnsurePlanAsync(string planCode, string name, decimal price, string currency, string? existingId, decimal? existingAmount, CancellationToken ct = default, string period = "monthly");
    /// <param name="period">"monthly" or "yearly": how often the price is charged.</param>
    /// <param name="startAt">The first charge, when it should not be now (a change of people that starts at the next renewal, so nobody pays twice for the current one).</param>
    /// <param name="description">What the payment window says is being bought.</param>
    Task<HostedCheckout> StartSubscriptionAsync(Guid tenantId, string planCode, string planName, string providerPlanId, decimal price, string currency, CancellationToken ct = default, string period = "monthly", DateTime? startAt = null, string? description = null);
    Task CancelSubscriptionAsync(string providerSubscriptionId, bool atCycleEnd, CancellationToken ct = default);
    bool VerifyCheckout(string paymentId, string subscriptionId, string signature);
    bool VerifyWebhook(string body, string? signature);
}
