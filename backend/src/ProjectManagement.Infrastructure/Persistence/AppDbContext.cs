using System.Linq.Expressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Common;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Infrastructure.Persistence;

public partial class AppDbContext(DbContextOptions<AppDbContext> options, ICurrentContext current, TimeProvider clock, ProjectManagement.Application.Services.EntitlementCache? entitlementCache = null,
    IChangeFeed? changeFeed = null)
    : DbContext(options), IAppDbContext
{
    public DbSet<User> Users => Set<User>();
    public DbSet<UserSession> UserSessions => Set<UserSession>();
    public DbSet<RefreshToken> RefreshTokens => Set<RefreshToken>();
    public DbSet<MfaRecoveryCode> MfaRecoveryCodes => Set<MfaRecoveryCode>();
    public DbSet<Tenant> Tenants => Set<Tenant>();
    public DbSet<TenantMember> TenantMembers => Set<TenantMember>();
    public DbSet<TenantInvitation> TenantInvitations => Set<TenantInvitation>();
    public DbSet<RolePermissionOverride> RolePermissionOverrides => Set<RolePermissionOverride>();
    public DbSet<Team> Teams => Set<Team>();
    public DbSet<DocumentType> DocumentTypes => Set<DocumentType>();
    public DbSet<Document> Documents => Set<Document>();
    public DbSet<DocumentVersion> DocumentVersions => Set<DocumentVersion>();
    public DbSet<DocumentSection> DocumentSections => Set<DocumentSection>();
    public DbSet<DocumentTag> DocumentTags => Set<DocumentTag>();
    public DbSet<DocumentLink> DocumentLinks => Set<DocumentLink>();
    public DbSet<DocumentGrant> DocumentGrants => Set<DocumentGrant>();
    public DbSet<DocumentFile> DocumentFiles => Set<DocumentFile>();
    public DbSet<WorkflowDefinition> WorkflowDefinitions => Set<WorkflowDefinition>();
    public DbSet<DocumentApproval> DocumentApprovals => Set<DocumentApproval>();
    public DbSet<ApprovalDecision> ApprovalDecisions => Set<ApprovalDecision>();
    public DbSet<AccessRequest> AccessRequests => Set<AccessRequest>();
    public DbSet<DocumentRequirement> DocumentRequirements => Set<DocumentRequirement>();
    public DbSet<ApiDefinition> ApiDefinitions => Set<ApiDefinition>();
    public DbSet<ApiEndpoint> ApiEndpoints => Set<ApiEndpoint>();
    public DbSet<ApiSnapshot> ApiSnapshots => Set<ApiSnapshot>();
    public DbSet<SensitiveValue> SensitiveValues => Set<SensitiveValue>();
    public DbSet<DocumentKey> DocumentKeys => Set<DocumentKey>();
    public DbSet<StepUpGrant> StepUpGrants => Set<StepUpGrant>();
    public DbSet<EndpointRevision> EndpointRevisions => Set<EndpointRevision>();
    public DbSet<TeamMember> TeamMembers => Set<TeamMember>();
    public DbSet<OrgRole> OrgRoles => Set<OrgRole>();
    public DbSet<Project> Projects => Set<Project>();
    public DbSet<ProjectMember> ProjectMembers => Set<ProjectMember>();
    public DbSet<WorkflowStatus> WorkflowStatuses => Set<WorkflowStatus>();
    public DbSet<ProjectStage> ProjectStages => Set<ProjectStage>();
    public DbSet<StageIssue> StageIssues => Set<StageIssue>();
    public DbSet<WorkType> WorkTypes => Set<WorkType>();
    public DbSet<WorkTask> WorkTasks => Set<WorkTask>();
    public DbSet<WorkTaskComment> WorkTaskComments => Set<WorkTaskComment>();
    public DbSet<WorkTaskAttachment> WorkTaskAttachments => Set<WorkTaskAttachment>();
    public DbSet<ProjectGroup> ProjectGroups => Set<ProjectGroup>();
    public DbSet<DueDateChange> DueDateChanges => Set<DueDateChange>();
    public DbSet<StageIssueEvent> StageIssueEvents => Set<StageIssueEvent>();
    public DbSet<Label> Labels => Set<Label>();
    public DbSet<CustomTimelineTemplate> CustomTimelineTemplates => Set<CustomTimelineTemplate>();
    public DbSet<TaskItem> Tasks => Set<TaskItem>();
    public DbSet<TaskLabel> TaskLabels => Set<TaskLabel>();
    public DbSet<TaskDependency> TaskDependencies => Set<TaskDependency>();
    public DbSet<Milestone> Milestones => Set<Milestone>();
    public DbSet<TenantFeatureOverride> TenantFeatureOverrides => Set<TenantFeatureOverride>();
    public DbSet<PlatformSetting> PlatformSettings => Set<PlatformSetting>();
    public DbSet<Webhook> Webhooks => Set<Webhook>();
    public DbSet<WebhookDelivery> WebhookDeliveries => Set<WebhookDelivery>();
    public DbSet<PasswordHistory> PasswordHistories => Set<PasswordHistory>();
    public DbSet<TenantSecuritySettings> TenantSecuritySettings => Set<TenantSecuritySettings>();
    public DbSet<UserConsent> UserConsents => Set<UserConsent>();
    public DbSet<Conversation> Conversations => Set<Conversation>();
    public DbSet<ConversationMember> ConversationMembers => Set<ConversationMember>();
    public DbSet<ChatMessage> ChatMessages => Set<ChatMessage>();
    public DbSet<ChatMention> ChatMentions => Set<ChatMention>();
    public DbSet<ApiKey> ApiKeys => Set<ApiKey>();
    public DbSet<SsoConnection> SsoConnections => Set<SsoConnection>();
    public DbSet<SsoDomain> SsoDomains => Set<SsoDomain>();
    public DbSet<ScimToken> ScimTokens => Set<ScimToken>();
    public DbSet<UserLogin> UserLogins => Set<UserLogin>();
    public DbSet<CustomFieldDefinition> CustomFieldDefinitions => Set<CustomFieldDefinition>();
    public DbSet<CustomFieldValue> CustomFieldValues => Set<CustomFieldValue>();
    public DbSet<ChecklistItem> ChecklistItems => Set<ChecklistItem>();
    public DbSet<PrioritySetting> PrioritySettings => Set<PrioritySetting>();
    public DbSet<ReportExport> ReportExports => Set<ReportExport>();
    public DbSet<Sprint> Sprints => Set<Sprint>();
    public DbSet<TimeEntry> TimeEntries => Set<TimeEntry>();
    public DbSet<TimesheetApproval> TimesheetApprovals => Set<TimesheetApproval>();
    public DbSet<SlaPolicy> SlaPolicies => Set<SlaPolicy>();
    public DbSet<CalendarFeed> CalendarFeeds => Set<CalendarFeed>();
    public DbSet<InboundMailbox> InboundMailboxes => Set<InboundMailbox>();
    public DbSet<GitConnection> GitConnections => Set<GitConnection>();
    public DbSet<GoogleConnection> GoogleConnections => Set<GoogleConnection>();
    public DbSet<ProjectMeeting> ProjectMeetings => Set<ProjectMeeting>();
    public DbSet<MeetingParticipant> MeetingParticipants => Set<MeetingParticipant>();
    public DbSet<DevLink> DevLinks => Set<DevLink>();
    public DbSet<TenantDataPolicy> TenantDataPolicies => Set<TenantDataPolicy>();
    public DbSet<AutomationRun> AutomationRuns => Set<AutomationRun>();
    public DbSet<PushSubscription> PushSubscriptions => Set<PushSubscription>();
    public DbSet<DeviceLoginRequest> DeviceLoginRequests => Set<DeviceLoginRequest>();
    public DbSet<IdempotencyRecord> IdempotencyRecords => Set<IdempotencyRecord>();
    public DbSet<PasskeyCredential> PasskeyCredentials => Set<PasskeyCredential>();
    public DbSet<EmailLog> EmailLogs => Set<EmailLog>();
    public DbSet<BillingEvent> BillingEvents => Set<BillingEvent>();
    public DbSet<EmailSuppression> EmailSuppressions => Set<EmailSuppression>();
    public DbSet<PasskeyChallenge> PasskeyChallenges => Set<PasskeyChallenge>();
    public DbSet<Reminder> Reminders => Set<Reminder>();
    public DbSet<AiConversation> AiConversations => Set<AiConversation>();
    public DbSet<AiMessage> AiMessages => Set<AiMessage>();
    public DbSet<AiAttachment> AiAttachments => Set<AiAttachment>();
    public DbSet<ChatAttachment> ChatAttachments => Set<ChatAttachment>();
    public DbSet<ChatReaction> ChatReactions => Set<ChatReaction>();
    public DbSet<AiUserProfile> AiUserProfiles => Set<AiUserProfile>();
    public DbSet<ReminderSettings> ReminderSettings => Set<ReminderSettings>();
    public DbSet<ReminderPolicy> ReminderPolicies => Set<ReminderPolicy>();
    public DbSet<AutomationRule> AutomationRules => Set<AutomationRule>();
    public DbSet<TaskComment> TaskComments => Set<TaskComment>();
    public DbSet<Activity> Activities => Set<Activity>();
    public DbSet<Notification> Notifications => Set<Notification>();
    public DbSet<NotificationPreference> NotificationPreferences => Set<NotificationPreference>();
    public DbSet<Attachment> Attachments => Set<Attachment>();
    public DbSet<AuditLog> AuditLogs => Set<AuditLog>();
    public DbSet<SsoGroupMapping> SsoGroupMappings => Set<SsoGroupMapping>();
    public DbSet<Plan> Plans => Set<Plan>();
    public DbSet<PlanFeature> PlanFeatures => Set<PlanFeature>();
    public DbSet<Subscription> Subscriptions => Set<Subscription>();
    public DbSet<Invoice> Invoices => Set<Invoice>();

    /// <summary>Read by the global query filters. Null (no workspace) matches nothing: default deny.</summary>
    internal Guid? CurrentTenantId => current.TenantId;
    /// <summary>How far this request's person reaches into projects (see <see cref="ProjectScope"/>). Read by the project filter below.</summary>
    internal ProjectScope CurrentProjectScope => current.ProjectScope;
    internal Guid? CurrentUserId => current.UserId;
    internal bool ProjectsRestricted => current.RestrictsProjects;
    internal bool CurrentIsOrgAdmin => current.Role is TenantRole.Owner or TenantRole.Admin;
    internal bool CurrentIsGuest => current.Role == TenantRole.Guest;
    internal DateTime CurrentNow => clock.GetUtcNow().UtcDateTime;
    internal Guid[] ReachableProjects => current.ProjectIds;

    public async Task<int> PendingMigrationCountAsync(CancellationToken ct = default) => (await Database.GetPendingMigrationsAsync(ct)).Count();

    protected override void ConfigureConventions(ModelConfigurationBuilder builder)
    {
        // Enums are stored as readable strings (portable across PostgreSQL / SQLite).
        builder.Properties<WorkspaceType>().HaveConversion<string>().HaveMaxLength(32);
        builder.Properties<TenantStatus>().HaveConversion<string>().HaveMaxLength(32);
        builder.Properties<TenantRole>().HaveConversion<string>().HaveMaxLength(32);
        builder.Properties<ProjectStatus>().HaveConversion<string>().HaveMaxLength(32);
        builder.Properties<Priority>().HaveConversion<string>().HaveMaxLength(32);
        builder.Properties<SprintStatus>().HaveConversion<string>().HaveMaxLength(32);
        builder.Properties<ReportKind>().HaveConversion<string>().HaveMaxLength(32);
        builder.Properties<ReportFormat>().HaveConversion<string>().HaveMaxLength(32);
        builder.Properties<ReportExportStatus>().HaveConversion<string>().HaveMaxLength(32);
        builder.Properties<CustomFieldType>().HaveConversion<string>().HaveMaxLength(32);
        builder.Properties<ApiKeyScope>().HaveConversion<string>().HaveMaxLength(32);
        builder.Properties<ConversationType>().HaveConversion<string>().HaveMaxLength(32);
        builder.Properties<ConversationRole>().HaveConversion<string>().HaveMaxLength(32);
        builder.Properties<ChatMessageKind>().HaveConversion<string>().HaveMaxLength(32);
        builder.Properties<WebhookDeliveryStatus>().HaveConversion<string>().HaveMaxLength(32);
        builder.Properties<AutomationTrigger>().HaveConversion<string>().HaveMaxLength(32);
        builder.Properties<AutomationAction>().HaveConversion<string>().HaveMaxLength(32);
        builder.Properties<AutomationTarget>().HaveConversion<string>().HaveMaxLength(32);
        builder.Properties<StatusCategory>().HaveConversion<string>().HaveMaxLength(32);
        builder.Properties<StageStatus>().HaveConversion<string>().HaveMaxLength(32);
        builder.Properties<IssueStatus>().HaveConversion<string>().HaveMaxLength(32);
        builder.Properties<ProjectType>().HaveConversion<string>().HaveMaxLength(32);
        builder.Properties<DeliveryMethod>().HaveConversion<string>().HaveMaxLength(32);
        builder.Properties<WorkTaskStatus>().HaveConversion<string>().HaveMaxLength(32);
        builder.Properties<WorkTaskKind>().HaveConversion<string>().HaveMaxLength(32);
        builder.Properties<DependencyType>().HaveConversion<string>().HaveMaxLength(32);
        builder.Properties<SubscriptionStatus>().HaveConversion<string>().HaveMaxLength(32);
        builder.Properties<InvitationStatus>().HaveConversion<string>().HaveMaxLength(32);
        builder.Properties<InvoiceStatus>().HaveConversion<string>().HaveMaxLength(32);
        builder.Properties<NotificationType>().HaveConversion<string>().HaveMaxLength(32);
        builder.Properties<SsoProtocol>().HaveConversion<string>().HaveMaxLength(16);
        builder.Properties<TimesheetStatus>().HaveConversion<string>().HaveMaxLength(16);
        builder.Properties<WebhookFormat>().HaveConversion<string>().HaveMaxLength(16);
        builder.Properties<GitProvider>().HaveConversion<string>().HaveMaxLength(16);
        builder.Properties<ReminderSource>().HaveConversion<string>().HaveMaxLength(16);
        builder.Properties<ReminderState>().HaveConversion<string>().HaveMaxLength(16);
        builder.Properties<ReminderTarget>().HaveConversion<string>().HaveMaxLength(16);
        builder.Properties<DocumentStatus>().HaveConversion<string>().HaveMaxLength(24);
        builder.Properties<DocumentVisibility>().HaveConversion<string>().HaveMaxLength(16);
        builder.Properties<SectionKind>().HaveConversion<string>().HaveMaxLength(16);
        builder.Properties<LinkTarget>().HaveConversion<string>().HaveMaxLength(16);
        builder.Properties<LinkRelation>().HaveConversion<string>().HaveMaxLength(16);
        builder.Properties<SensitivityClass>().HaveConversion<string>().HaveMaxLength(16);
        builder.Properties<ApiMethod>().HaveConversion<string>().HaveMaxLength(8);
        builder.Properties<ApiAuthScheme>().HaveConversion<string>().HaveMaxLength(12);
        builder.Properties<ApproverKind>().HaveConversion<string>().HaveMaxLength(16);
        builder.Properties<ApprovalRule>().HaveConversion<string>().HaveMaxLength(8);
        builder.Properties<ApprovalState>().HaveConversion<string>().HaveMaxLength(20);
        builder.Properties<DecisionKind>().HaveConversion<string>().HaveMaxLength(20);
        builder.Properties<AccessRequestStatus>().HaveConversion<string>().HaveMaxLength(16);
        builder.Properties<GrantPrincipal>().HaveConversion<string>().HaveMaxLength(16);
        builder.Properties<DocAccessLevel>().HaveConversion<string>().HaveMaxLength(16);
        builder.Properties<MeetingStatus>().HaveConversion<string>().HaveMaxLength(16);
        builder.Properties<AttendeeRsvpStatus>().HaveConversion<string>().HaveMaxLength(16);
        builder.Properties<MeetingParticipantRole>().HaveConversion<string>().HaveMaxLength(16);

        // Everything is UTC. SQLite hands back "unspecified" kinds, which would serialise without a 'Z'.
        builder.Properties<DateTime>().HaveConversion<UtcConverter>();
        builder.Properties<DateTime?>().HaveConversion<NullableUtcConverter>();
        builder.Properties<decimal>().HavePrecision(18, 2);
    }

    private sealed class UtcConverter() : ValueConverter<DateTime, DateTime>(
        v => v.Kind == DateTimeKind.Utc ? v : v.ToUniversalTime(), v => DateTime.SpecifyKind(v, DateTimeKind.Utc));

    private sealed class NullableUtcConverter() : ValueConverter<DateTime?, DateTime?>(
        v => v.HasValue ? (v.Value.Kind == DateTimeKind.Utc ? v : v.Value.ToUniversalTime()) : v,
        v => v.HasValue ? DateTime.SpecifyKind(v.Value, DateTimeKind.Utc) : v);

    protected override void OnModelCreating(ModelBuilder b)
    {
        ConfigureIdentity(b);
        ConfigureWork(b);
        ConfigureDocuments(b);
        ConfigureBilling(b);
        ApplyQueryFilters(b);
    }
}
