using System.Linq.Expressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Common;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Infrastructure.Persistence;

public class AppDbContext(DbContextOptions<AppDbContext> options, ICurrentContext current, TimeProvider clock, ProjectManagement.Application.Services.EntitlementCache? entitlementCache = null,
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
    public DbSet<DevLink> DevLinks => Set<DevLink>();
    public DbSet<TenantDataPolicy> TenantDataPolicies => Set<TenantDataPolicy>();
    public DbSet<AutomationRun> AutomationRuns => Set<AutomationRun>();
    public DbSet<PushSubscription> PushSubscriptions => Set<PushSubscription>();
    public DbSet<Reminder> Reminders => Set<Reminder>();
    public DbSet<AiConversation> AiConversations => Set<AiConversation>();
    public DbSet<AiMessage> AiMessages => Set<AiMessage>();
    public DbSet<AiAttachment> AiAttachments => Set<AiAttachment>();
    public DbSet<ReminderSettings> ReminderSettings => Set<ReminderSettings>();
    public DbSet<ReminderPolicy> ReminderPolicies => Set<ReminderPolicy>();
    public DbSet<AutomationRule> AutomationRules => Set<AutomationRule>();
    public DbSet<TaskComment> TaskComments => Set<TaskComment>();
    public DbSet<Activity> Activities => Set<Activity>();
    public DbSet<Notification> Notifications => Set<Notification>();
    public DbSet<NotificationPreference> NotificationPreferences => Set<NotificationPreference>();
    public DbSet<Attachment> Attachments => Set<Attachment>();
    public DbSet<AuditLog> AuditLogs => Set<AuditLog>();
    public DbSet<Plan> Plans => Set<Plan>();
    public DbSet<PlanFeature> PlanFeatures => Set<PlanFeature>();
    public DbSet<Subscription> Subscriptions => Set<Subscription>();
    public DbSet<Invoice> Invoices => Set<Invoice>();

    /// <summary>Read by the global query filters. Null (no workspace) matches nothing: default deny.</summary>
    internal Guid? CurrentTenantId => current.TenantId;

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
        ConfigureBilling(b);
        ApplyQueryFilters(b);
    }

    private static void ConfigureIdentity(ModelBuilder b)
    {
        b.Entity<User>(e =>
        {
            e.HasIndex(x => x.NormalizedEmail).IsUnique();
            e.Property(x => x.Email).HasMaxLength(254);
            e.Property(x => x.NormalizedEmail).HasMaxLength(254);
            e.Property(x => x.DisplayName).HasMaxLength(100);
            e.HasIndex(x => x.EmailVerificationTokenHash);
            e.HasIndex(x => x.PasswordResetTokenHash);
        });
        b.Entity<UserSession>(e => { e.HasIndex(x => x.UserId); e.Property(x => x.AuthMethod).HasMaxLength(32); });
        b.Entity<RefreshToken>(e =>
        {
            e.HasIndex(x => x.TokenHash).IsUnique();
            e.HasIndex(x => x.SessionId);
            e.Property(x => x.TokenHash).HasMaxLength(128);
        });
        b.Entity<MfaRecoveryCode>(e =>
        {
            e.HasIndex(x => new { x.UserId, x.CodeHash }).IsUnique();
            e.Property(x => x.CodeHash).HasMaxLength(64);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<Tenant>(e =>
        {
            e.HasIndex(x => x.Slug).IsUnique();
            e.HasIndex(x => x.OwnerUserId);
            e.Property(x => x.Name).HasMaxLength(80);
            e.Property(x => x.Slug).HasMaxLength(60);
            e.Property(x => x.CostCurrency).HasMaxLength(3);
            e.Property(x => x.AiInstructions).HasMaxLength(4000);
        });
        b.Entity<TenantMember>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.UserId }).IsUnique();
            e.HasIndex(x => x.UserId);
            e.HasIndex(x => x.OrgRoleId);
            e.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Restrict);
            e.HasOne<OrgRole>().WithMany().HasForeignKey(x => x.OrgRoleId).OnDelete(DeleteBehavior.SetNull);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.ReportsToUserId).OnDelete(DeleteBehavior.SetNull);
            e.Property(x => x.CostRate).HasPrecision(12, 2);
            e.Property(x => x.BillRate).HasPrecision(12, 2);
        });
        b.Entity<OrgRole>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.ParentRoleId });
            e.Property(x => x.Name).HasMaxLength(60);
            e.Property(x => x.Description).HasMaxLength(300);
            e.Property(x => x.Color).HasMaxLength(9);
            e.Property(x => x.AccessJson).HasMaxLength(4000);
            e.HasOne<OrgRole>().WithMany().HasForeignKey(x => x.ParentRoleId).OnDelete(DeleteBehavior.Restrict);
        });
        b.Entity<TenantInvitation>(e =>
        {
            e.HasIndex(x => x.TokenHash).IsUnique();
            e.HasIndex(x => new { x.TenantId, x.NormalizedEmail });
        });
        b.Entity<RolePermissionOverride>(e => e.HasIndex(x => new { x.TenantId, x.Role, x.Permission }).IsUnique());
        b.Entity<Team>(e =>
        {
            e.HasIndex(x => x.TenantId);
            e.HasMany(x => x.Members).WithOne().HasForeignKey(x => x.TeamId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<TeamMember>(e =>
        {
            e.HasIndex(x => new { x.TeamId, x.UserId }).IsUnique();
            e.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Restrict);
        });
    }

    private static void ConfigureWork(ModelBuilder b)
    {
        b.Entity<Project>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.Key });
            e.HasIndex(x => new { x.TenantId, x.Status });
            e.HasIndex(x => new { x.TenantId, x.DueDate });
            e.Property(x => x.Name).HasMaxLength(120);
            e.Property(x => x.Key).HasMaxLength(10);
            e.HasOne(x => x.Owner).WithMany().HasForeignKey(x => x.OwnerId).OnDelete(DeleteBehavior.Restrict);
            e.HasOne(x => x.Team).WithMany().HasForeignKey(x => x.TeamId).OnDelete(DeleteBehavior.SetNull);
            e.HasOne(x => x.Group).WithMany().HasForeignKey(x => x.ProjectGroupId).OnDelete(DeleteBehavior.Restrict);
            e.HasIndex(x => x.ProjectGroupId);
            e.HasMany(x => x.Members).WithOne().HasForeignKey(x => x.ProjectId).OnDelete(DeleteBehavior.Cascade);
            e.HasMany(x => x.Statuses).WithOne().HasForeignKey(x => x.ProjectId).OnDelete(DeleteBehavior.Cascade);
            e.HasMany(x => x.Stages).WithOne().HasForeignKey(x => x.ProjectId).OnDelete(DeleteBehavior.Cascade);
            e.Property(x => x.Version).IsConcurrencyToken();
            e.Property(x => x.DeliveryMethod).HasDefaultValue(DeliveryMethod.Hybrid).HasSentinel(DeliveryMethod.Hybrid);
            e.Property(x => x.BudgetHours).HasPrecision(10, 2);
            e.Property(x => x.BudgetAmount).HasPrecision(14, 2);
            e.Property(x => x.BillRate).HasPrecision(12, 2);
        });
        b.Entity<ProjectMember>(e =>
        {
            e.HasIndex(x => new { x.ProjectId, x.UserId }).IsUnique();
            e.HasIndex(x => new { x.TenantId, x.UserId });
            e.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Restrict);
        });
        b.Entity<WorkflowStatus>(e => { e.HasIndex(x => new { x.ProjectId, x.Order }); e.Property(x => x.Name).HasMaxLength(40); e.Property(x => x.Color).HasMaxLength(9); });
        b.Entity<ProjectStage>(e => { e.HasIndex(x => new { x.ProjectId, x.Order }); e.Property(x => x.Name).HasMaxLength(80); });
        b.Entity<WorkType>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.Order });
            e.HasIndex(x => new { x.TenantId, x.Name }).IsUnique();
            e.Property(x => x.Name).HasMaxLength(60);
            e.Property(x => x.Description).HasMaxLength(200);
        });
        b.Entity<WorkTask>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.Number }).IsUnique();
            e.HasIndex(x => new { x.TenantId, x.Status, x.DueDate });
            e.HasIndex(x => new { x.TenantId, x.AssigneeId });
            e.HasIndex(x => new { x.TenantId, x.RelatedProjectId });
            e.HasIndex(x => new { x.TenantId, x.WorkTypeId });
            e.HasIndex(x => new { x.TenantId, x.Kind, x.RelatedProjectId });
            e.Property(x => x.Title).HasMaxLength(200);
            e.Property(x => x.Description).HasMaxLength(8000);
            e.Property(x => x.Kind).HasDefaultValue(WorkTaskKind.Operational).HasSentinel(WorkTaskKind.Operational);
            e.HasOne(x => x.WorkType).WithMany().HasForeignKey(x => x.WorkTypeId).OnDelete(DeleteBehavior.Restrict);
            // The SLA monitor looks for open work whose response or resolution time has run out.
            e.HasIndex(x => new { x.Status, x.ResolutionDueAt });
            e.HasIndex(x => new { x.Status, x.ResponseDueAt });
        });
        b.Entity<SlaPolicy>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.WorkTypeId, x.Priority });
            e.HasOne<WorkType>().WithMany().HasForeignKey(x => x.WorkTypeId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<WorkTaskComment>(e => { e.HasIndex(x => x.WorkTaskId); e.Property(x => x.Body).HasMaxLength(4000); });
        b.Entity<WorkTaskAttachment>(e => { e.HasIndex(x => x.WorkTaskId); e.Property(x => x.FileName).HasMaxLength(200); e.Property(x => x.ContentType).HasMaxLength(120); e.Property(x => x.StorageKey).HasMaxLength(200); e.Property(x => x.Sha256).HasMaxLength(64); });
        b.Entity<ProjectGroup>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.Order });
            e.HasIndex(x => new { x.TenantId, x.Name }).IsUnique();
            e.Property(x => x.Name).HasMaxLength(60);
            e.Property(x => x.Description).HasMaxLength(200);
        });
        b.Entity<DueDateChange>(e =>
        {
            e.HasIndex(x => new { x.ProjectId, x.CreatedAt });
            e.HasIndex(x => x.TaskId);
            e.Property(x => x.Reason).HasMaxLength(500);
            e.Property(x => x.Dependency).HasMaxLength(300);
        });
        b.Entity<StageIssue>(e =>
        {
            e.HasIndex(x => new { x.ProjectId, x.Number }).IsUnique();
            e.HasIndex(x => new { x.ProjectId, x.StageId, x.Status });
            e.HasIndex(x => new { x.TenantId, x.AssigneeId });
            e.Property(x => x.Title).HasMaxLength(200);
            e.Property(x => x.Details).HasMaxLength(4000);
            e.HasOne<ProjectStage>().WithMany().HasForeignKey(x => x.StageId).OnDelete(DeleteBehavior.SetNull);   // the issue stays as history when its stage is deleted
        });
        b.Entity<StageIssueEvent>(e =>
        {
            e.HasIndex(x => x.IssueId);
            e.Property(x => x.Kind).HasMaxLength(20);
            e.Property(x => x.Note).HasMaxLength(1000);
            e.HasOne<StageIssue>().WithMany().HasForeignKey(x => x.IssueId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<CustomTimelineTemplate>(e => { e.HasIndex(x => x.TenantId); e.Property(x => x.Name).HasMaxLength(80); e.Property(x => x.Description).HasMaxLength(300); });
        b.Entity<Label>(e => { e.HasIndex(x => x.TenantId); e.Property(x => x.Name).HasMaxLength(40); e.Property(x => x.Color).HasMaxLength(9); });

        b.Entity<TaskItem>(e =>
        {
            e.ToTable("Tasks");
            e.HasIndex(x => new { x.ProjectId, x.Number }).IsUnique();
            e.HasIndex(x => new { x.TenantId, x.ProjectId });
            e.HasIndex(x => new { x.TenantId, x.AssigneeId });
            e.HasIndex(x => new { x.TenantId, x.DueDate });
            e.HasIndex(x => new { x.ProjectId, x.StatusId });
            e.Property(x => x.Title).HasMaxLength(200);
            e.Property(x => x.EstimatedHours).HasPrecision(9, 2);
            e.Property(x => x.ActualHours).HasPrecision(9, 2);
            e.Property(x => x.Version).IsConcurrencyToken();
            e.HasOne(x => x.Project).WithMany().HasForeignKey(x => x.ProjectId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Status).WithMany().HasForeignKey(x => x.StatusId).OnDelete(DeleteBehavior.Restrict);
            e.HasOne(x => x.Assignee).WithMany().HasForeignKey(x => x.AssigneeId).OnDelete(DeleteBehavior.Restrict);
            e.HasOne(x => x.Reporter).WithMany().HasForeignKey(x => x.ReporterId).OnDelete(DeleteBehavior.Restrict);
            e.HasOne(x => x.ParentTask).WithMany(x => x.Subtasks).HasForeignKey(x => x.ParentTaskId).OnDelete(DeleteBehavior.Restrict);
            e.HasOne<Milestone>().WithMany().HasForeignKey(x => x.MilestoneId).OnDelete(DeleteBehavior.SetNull);
            e.HasOne<Sprint>().WithMany().HasForeignKey(x => x.SprintId).OnDelete(DeleteBehavior.SetNull);
            e.HasOne<ProjectStage>().WithMany().HasForeignKey(x => x.StageId).OnDelete(DeleteBehavior.SetNull);
            e.HasIndex(x => x.SprintId);
            e.HasIndex(x => x.StageId);
            e.HasMany(x => x.Labels).WithOne().HasForeignKey(x => x.TaskId).OnDelete(DeleteBehavior.Cascade);
            e.HasMany(x => x.Comments).WithOne().HasForeignKey(x => x.TaskId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<TaskDependency>(e =>
        {
            e.HasIndex(x => new { x.TaskId, x.DependsOnTaskId }).IsUnique();
            e.HasIndex(x => x.DependsOnTaskId);
            e.HasOne(x => x.Task).WithMany().HasForeignKey(x => x.TaskId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.DependsOnTask).WithMany().HasForeignKey(x => x.DependsOnTaskId).OnDelete(DeleteBehavior.Restrict);
        });
        b.Entity<Milestone>(e =>
        {
            e.HasIndex(x => new { x.ProjectId, x.SortOrder });
            e.HasIndex(x => new { x.TenantId, x.DueDate });
            e.Property(x => x.Name).HasMaxLength(120);
            e.Property(x => x.Description).HasMaxLength(2000);
            e.HasOne(x => x.Owner).WithMany().HasForeignKey(x => x.OwnerId).OnDelete(DeleteBehavior.SetNull);
            e.HasOne<ProjectStage>().WithMany().HasForeignKey(x => x.StageId).OnDelete(DeleteBehavior.SetNull);
            e.HasIndex(x => x.StageId);
        });
        b.Entity<Sprint>(e =>
        {
            e.HasIndex(x => new { x.ProjectId, x.Status });
            e.Property(x => x.Name).HasMaxLength(100);
            e.Property(x => x.Goal).HasMaxLength(500);
            e.HasOne<Project>().WithMany().HasForeignKey(x => x.ProjectId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<ReportExport>(e =>
        {
            e.HasIndex(x => new { x.UserId, x.CreatedAt });
            e.HasIndex(x => new { x.Status, x.CreatedAt });
            e.Property(x => x.FileName).HasMaxLength(200);
            e.Property(x => x.StorageKey).HasMaxLength(300);
            e.Property(x => x.Error).HasMaxLength(300);
        });
        b.Entity<ChecklistItem>(e =>
        {
            e.HasIndex(x => new { x.TaskId, x.Position });
            e.Property(x => x.Title).HasMaxLength(200);
            e.HasOne<TaskItem>().WithMany().HasForeignKey(x => x.TaskId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<PrioritySetting>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.Level }).IsUnique();
            e.Property(x => x.Name).HasMaxLength(20);
            e.Property(x => x.Color).HasMaxLength(7);
        });
        b.Entity<CustomFieldDefinition>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.SortOrder });
            e.Property(x => x.Name).HasMaxLength(40);
            e.Property(x => x.Options).HasMaxLength(2000);
        });
        b.Entity<CustomFieldValue>(e =>
        {
            e.HasIndex(x => new { x.TaskId, x.FieldId }).IsUnique();
            e.HasIndex(x => x.FieldId);
            e.Property(x => x.Value).HasMaxLength(500);
            e.HasOne<TaskItem>().WithMany().HasForeignKey(x => x.TaskId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<CustomFieldDefinition>().WithMany().HasForeignKey(x => x.FieldId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<ApiKey>(e =>
        {
            e.HasIndex(x => x.Prefix).IsUnique();
            e.HasIndex(x => x.TenantId);
            e.Property(x => x.Name).HasMaxLength(60);
            e.Property(x => x.Prefix).HasMaxLength(20);
            e.Property(x => x.SecretHash).HasMaxLength(64);
            e.Property(x => x.LastUsedIp).HasMaxLength(64);
            e.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<Webhook>(e =>
        {
            e.HasIndex(x => x.TenantId);
            e.Property(x => x.Name).HasMaxLength(60);
            e.Property(x => x.Url).HasMaxLength(500);
            e.Property(x => x.SecretProtected).HasMaxLength(300);
            e.Property(x => x.Events).HasMaxLength(1000);
            e.Property(x => x.DisabledReason).HasMaxLength(200);
            e.Property(x => x.LastStatus).HasMaxLength(20);
            e.Property(x => x.Format).HasDefaultValue(WebhookFormat.Json).HasSentinel(WebhookFormat.Json);
        });
        b.Entity<CalendarFeed>(e =>
        {
            e.HasIndex(x => x.TokenHash).IsUnique();
            e.HasIndex(x => new { x.TenantId, x.UserId }).IsUnique();
            e.Property(x => x.TokenHash).HasMaxLength(64);
            e.Property(x => x.TokenProtected).HasMaxLength(300);
            e.Property(x => x.Prefix).HasMaxLength(16);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<InboundMailbox>(e =>
        {
            e.HasIndex(x => x.Token).IsUnique();
            e.HasIndex(x => x.TenantId).IsUnique();
            e.Property(x => x.Token).HasMaxLength(40);
            e.Property(x => x.LastError).HasMaxLength(300);
            e.HasOne<WorkType>().WithMany().HasForeignKey(x => x.WorkTypeId).OnDelete(DeleteBehavior.SetNull);
        });
        b.Entity<GitConnection>(e =>
        {
            e.HasIndex(x => x.Token).IsUnique();
            e.HasIndex(x => x.TenantId);
            e.Property(x => x.Name).HasMaxLength(60);
            e.Property(x => x.Token).HasMaxLength(40);
            e.Property(x => x.SecretProtected).HasMaxLength(300);
            e.Property(x => x.LastError).HasMaxLength(300);
        });
        b.Entity<DevLink>(e =>
        {
            e.HasIndex(x => new { x.TaskId, x.OccurredAt });
            e.HasIndex(x => new { x.WorkTaskId, x.OccurredAt });
            e.HasIndex(x => new { x.TenantId, x.Provider, x.Kind, x.ExternalId });
            e.Property(x => x.Kind).HasMaxLength(20);
            e.Property(x => x.ExternalId).HasMaxLength(80);
            e.Property(x => x.Title).HasMaxLength(300);
            e.Property(x => x.Url).HasMaxLength(500);
            e.Property(x => x.Repository).HasMaxLength(200);
            e.Property(x => x.Author).HasMaxLength(120);
            e.Property(x => x.State).HasMaxLength(20);
            e.HasOne<TaskItem>().WithMany().HasForeignKey(x => x.TaskId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<WorkTask>().WithMany().HasForeignKey(x => x.WorkTaskId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<TenantDataPolicy>(e => e.HasIndex(x => x.TenantId).IsUnique());
        b.Entity<AiConversation>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.UserId, x.LastMessageAt });
            e.Property(x => x.Title).HasMaxLength(120);
        });
        b.Entity<AiMessage>(e =>
        {
            e.HasIndex(x => new { x.ConversationId, x.CreatedAt });
            e.HasIndex(x => new { x.TenantId, x.CreatedAt });               // a workspace's credits used this month
            e.Property(x => x.Role).HasMaxLength(12);
            e.Property(x => x.Tier).HasMaxLength(12);
            e.Property(x => x.Model).HasMaxLength(64);
            e.Property(x => x.RouteReason).HasMaxLength(120);
            e.Property(x => x.Status).HasMaxLength(12);
            e.HasOne<AiConversation>().WithMany().HasForeignKey(x => x.ConversationId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<AiAttachment>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.UserId, x.MessageId });
            e.HasIndex(x => x.MessageId);
            e.Property(x => x.FileName).HasMaxLength(150);
            e.Property(x => x.ContentType).HasMaxLength(120);
            e.Property(x => x.StorageKey).HasMaxLength(200);
        });
        b.Entity<Reminder>(e =>
        {
            e.HasIndex(x => new { x.State, x.NextFireAt });                 // the scheduler's question: what is due
            e.HasIndex(x => new { x.TenantId, x.UserId, x.State });
            e.HasIndex(x => new { x.TenantId, x.SystemKey }).IsUnique();    // one automatic reminder per date and step
            e.HasIndex(x => new { x.TargetType, x.TargetId });
            e.HasIndex(x => x.ActionTokenHash);
            e.HasIndex(x => x.CreatedBy);
            e.Property(x => x.Title).HasMaxLength(200);
            e.Property(x => x.Note).HasMaxLength(1000);
            e.Property(x => x.TargetKey).HasMaxLength(40);
            e.Property(x => x.TargetTitle).HasMaxLength(200);
            e.Property(x => x.Link).HasMaxLength(300);
            e.Property(x => x.TimeZone).HasMaxLength(64);
            e.Property(x => x.LocalAt).HasMaxLength(16);
            e.Property(x => x.Recurrence).HasMaxLength(120);
            e.Property(x => x.SystemKey).HasMaxLength(160);
            e.Property(x => x.ActionTokenHash).HasMaxLength(64);
        });
        b.Entity<ReminderSettings>(e =>
        {
            e.HasIndex(x => x.UserId).IsUnique();
            e.Property(x => x.WorkDays).HasMaxLength(20);
            e.Property(x => x.DueLeads).HasMaxLength(40);
            e.Property(x => x.OverdueSteps).HasMaxLength(40);
            e.Property(x => x.LastBriefingDay).HasMaxLength(8);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<ReminderPolicy>(e =>
        {
            e.HasIndex(x => x.TenantId).IsUnique();
            e.Property(x => x.Steps).HasMaxLength(120);
        });
        b.Entity<PushSubscription>(e =>
        {
            e.HasIndex(x => x.Endpoint).IsUnique();
            e.HasIndex(x => x.UserId);
            e.Property(x => x.Endpoint).HasMaxLength(800);
            e.Property(x => x.P256dh).HasMaxLength(200);
            e.Property(x => x.Auth).HasMaxLength(100);
            e.Property(x => x.UserAgent).HasMaxLength(300);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<WebhookDelivery>(e =>
        {
            e.HasIndex(x => new { x.WebhookId, x.ActivityId }).IsUnique();
            e.HasIndex(x => new { x.Status, x.NextAttemptAt });
            e.HasIndex(x => new { x.WebhookId, x.CreatedAt });
            e.Property(x => x.EventType).HasMaxLength(60);
            e.Property(x => x.ResponseSnippet).HasMaxLength(600);
            e.Property(x => x.Error).HasMaxLength(300);
            e.HasOne<Webhook>().WithMany().HasForeignKey(x => x.WebhookId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<TenantSecuritySettings>(e =>
        {
            e.HasIndex(x => x.TenantId).IsUnique();
            e.Property(x => x.IpRanges).HasMaxLength(6000);
        });
        b.Entity<SsoConnection>(e =>
        {
            e.HasIndex(x => x.TenantId).IsUnique();   // one identity provider per organization
            e.Property(x => x.Name).HasMaxLength(80);
            e.Property(x => x.Authority).HasMaxLength(400);
            e.Property(x => x.ClientId).HasMaxLength(300);
            e.Property(x => x.ClientSecret).HasMaxLength(1000);
            e.Property(x => x.SamlEntityId).HasMaxLength(400);
            e.Property(x => x.SamlSsoUrl).HasMaxLength(800);
            e.Property(x => x.SamlCertificate).HasMaxLength(12000);
            e.HasOne<Tenant>().WithMany().HasForeignKey(x => x.TenantId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<SsoDomain>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.Domain }).IsUnique();
            // A domain can be verified by one organization only.
            e.HasIndex(x => x.Domain).IsUnique().HasFilter("\"VerifiedAt\" IS NOT NULL").HasDatabaseName("IX_SsoDomains_Domain_Verified");
            e.Property(x => x.Domain).HasMaxLength(253);
            e.Property(x => x.VerificationToken).HasMaxLength(64);
            e.HasOne<Tenant>().WithMany().HasForeignKey(x => x.TenantId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<ScimToken>(e =>
        {
            e.HasIndex(x => x.TokenHash).IsUnique();
            e.HasIndex(x => x.TenantId);
            e.Property(x => x.Name).HasMaxLength(80);
            e.Property(x => x.Prefix).HasMaxLength(16);
            e.Property(x => x.TokenHash).HasMaxLength(128);
            e.HasOne<Tenant>().WithMany().HasForeignKey(x => x.TenantId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<UserLogin>(e =>
        {
            e.HasIndex(x => new { x.Provider, x.Subject }).IsUnique();
            e.HasIndex(x => x.UserId);
            e.Property(x => x.Provider).HasMaxLength(64);
            e.Property(x => x.Subject).HasMaxLength(256);
            e.Property(x => x.Email).HasMaxLength(320);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<PasswordHistory>(e =>
        {
            e.HasIndex(x => new { x.UserId, x.ReplacedAt });
            e.Property(x => x.Hash).HasMaxLength(200);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<UserConsent>(e =>
        {
            e.HasIndex(x => new { x.UserId, x.DocumentType, x.Version }).IsUnique();
            e.Property(x => x.DocumentType).HasMaxLength(30);
            e.Property(x => x.IpAddress).HasMaxLength(64);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<Conversation>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.LastMessageAt });
            e.HasIndex(x => new { x.TenantId, x.DirectKey }).IsUnique();   // one direct chat per pair of people (groups have no key)
            e.HasIndex(x => x.ProjectId).IsUnique();                       // one team chat per project (other chats have no project)
            e.Property(x => x.Name).HasMaxLength(80);
            e.Property(x => x.DirectKey).HasMaxLength(80);
            e.Property(x => x.LastMessageSnippet).HasMaxLength(200);
        });
        b.Entity<ConversationMember>(e =>
        {
            e.HasIndex(x => new { x.ConversationId, x.UserId }).IsUnique();
            e.HasIndex(x => new { x.TenantId, x.UserId });
            e.HasOne<Conversation>().WithMany().HasForeignKey(x => x.ConversationId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<ChatMessage>(e =>
        {
            e.HasIndex(x => new { x.ConversationId, x.CreatedAt });
            e.Property(x => x.Body).HasMaxLength(4000);
            e.HasOne<Conversation>().WithMany().HasForeignKey(x => x.ConversationId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<ChatMention>(e =>
        {
            e.HasIndex(x => new { x.UserId, x.ConversationId });
            e.HasIndex(x => x.MessageId);
            e.HasOne<ChatMessage>().WithMany().HasForeignKey(x => x.MessageId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<TenantFeatureOverride>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.FeatureKey }).IsUnique();
            e.Property(x => x.FeatureKey).HasMaxLength(64);
            e.Property(x => x.Reason).HasMaxLength(200);
        });
        b.Entity<PlatformSetting>(e =>
        {
            e.HasIndex(x => x.Key).IsUnique();
            e.Property(x => x.Key).HasMaxLength(64);
            e.Property(x => x.Value).HasMaxLength(500);
        });
        b.Entity<TimeEntry>(e =>
        {
            e.Ignore(x => x.IsRunning);
            e.HasIndex(x => new { x.TaskId, x.WorkDate });
            e.HasIndex(x => new { x.WorkTaskId, x.WorkDate });
            e.HasIndex(x => new { x.UserId, x.WorkDate });
            e.HasIndex(x => new { x.ProjectId, x.WorkDate });
            e.Property(x => x.Note).HasMaxLength(500);
            e.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Restrict);
            e.HasOne<TaskItem>().WithMany().HasForeignKey(x => x.TaskId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<WorkTask>().WithMany().HasForeignKey(x => x.WorkTaskId).OnDelete(DeleteBehavior.Cascade);
            // Time is spent on exactly one thing: a project task or a work task.
            e.ToTable(t => t.HasCheckConstraint("CK_TimeEntries_OneTarget",
                "(\"TaskId\" IS NOT NULL AND \"WorkTaskId\" IS NULL) OR (\"TaskId\" IS NULL AND \"WorkTaskId\" IS NOT NULL)"));
        });
        b.Entity<TimesheetApproval>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.UserId, x.WeekStart }).IsUnique();
            e.HasIndex(x => new { x.TenantId, x.Status, x.WeekStart });
            e.Property(x => x.Note).HasMaxLength(500);
            e.Property(x => x.ReviewNote).HasMaxLength(500);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<AutomationRule>(e =>
        {
            e.HasIndex(x => new { x.ProjectId, x.Trigger });
            e.Property(x => x.Name).HasMaxLength(100);
            e.Property(x => x.ActionText).HasMaxLength(500);
            e.Property(x => x.MoreActionsJson).HasMaxLength(4000);
            e.HasIndex(x => new { x.TenantId, x.Trigger });
            e.HasOne<Project>().WithMany().HasForeignKey(x => x.ProjectId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<AutomationRun>(e =>
        {
            e.HasIndex(x => new { x.RuleId, x.TaskId, x.Period }).IsUnique();
            e.Property(x => x.Period).HasMaxLength(20);
            e.HasOne<AutomationRule>().WithMany().HasForeignKey(x => x.RuleId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<TaskItem>().WithMany().HasForeignKey(x => x.TaskId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<TaskLabel>(e =>
        {
            e.HasIndex(x => new { x.TaskId, x.LabelId }).IsUnique();
            e.HasOne(x => x.Label).WithMany().HasForeignKey(x => x.LabelId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<TaskComment>(e =>
        {
            e.HasIndex(x => x.TaskId);
            e.HasOne(x => x.Author).WithMany().HasForeignKey(x => x.AuthorId).OnDelete(DeleteBehavior.Restrict);
        });
        b.Entity<Activity>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.CreatedAt });
            e.HasIndex(x => new { x.TenantId, x.ProjectId, x.CreatedAt });
            e.Property(x => x.Action).HasMaxLength(60);
            e.Property(x => x.Summary).HasMaxLength(500);
            e.HasOne(x => x.Actor).WithMany().HasForeignKey(x => x.ActorId).OnDelete(DeleteBehavior.Restrict);
        });
        b.Entity<Notification>(e =>
        {
            e.HasIndex(x => new { x.UserId, x.ReadAt });
            e.HasIndex(x => x.DedupeKey);
            e.HasIndex(x => x.EmailPending);
            e.HasIndex(x => x.PushPending);
            e.Property(x => x.DedupeKey).HasMaxLength(100);
        });
        b.Entity<Attachment>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.ProjectId });
            e.HasIndex(x => x.TaskId);
            e.HasIndex(x => x.IssueId);
            e.Property(x => x.FileName).HasMaxLength(200);
            e.Property(x => x.ContentType).HasMaxLength(100);
            e.Property(x => x.StorageKey).HasMaxLength(200);
            e.Property(x => x.Sha256).HasMaxLength(64);
        });
        b.Entity<NotificationPreference>(e =>
        {
            e.HasIndex(x => new { x.UserId, x.Type }).IsUnique();
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<AuditLog>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.CreatedAt });
            e.HasIndex(x => x.CreatedAt);
            e.Property(x => x.Action).HasMaxLength(60);
            e.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Restrict);
        });
    }

    private static void ConfigureBilling(ModelBuilder b)
    {
        b.Entity<Plan>(e =>
        {
            e.HasIndex(x => x.Code).IsUnique();
            e.Property(x => x.Code).HasMaxLength(20);
            e.HasMany(x => x.Features).WithOne().HasForeignKey(x => x.PlanId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<PlanFeature>(e => { e.HasIndex(x => new { x.PlanId, x.FeatureKey }).IsUnique(); e.Property(x => x.FeatureKey).HasMaxLength(60); });
        b.Entity<Subscription>(e =>
        {
            e.HasIndex(x => x.TenantId).IsUnique();
            e.HasOne(x => x.Plan).WithMany().HasForeignKey(x => x.PlanId).OnDelete(DeleteBehavior.Restrict);
        });
        b.Entity<Invoice>(e => { e.HasIndex(x => new { x.TenantId, x.IssuedAt }); e.Property(x => x.Number).HasMaxLength(40); });
    }

    /// <summary>
    /// Defence in depth for tenant isolation: every tenant-owned entity is filtered by the server-resolved tenant,
    /// and soft-deleted rows are hidden. Explicit <c>IgnoreQueryFilters()</c> is only used by system jobs.
    /// </summary>
    private void ApplyQueryFilters(ModelBuilder b)
    {
        foreach (var entityType in b.Model.GetEntityTypes())
        {
            var clr = entityType.ClrType;
            var tenantScoped = typeof(ITenantScoped).IsAssignableFrom(clr);
            var softDelete = typeof(ISoftDelete).IsAssignableFrom(clr);
            if (!tenantScoped && !softDelete) continue;

            var e = Expression.Parameter(clr, "e");
            Expression? body = null;
            if (tenantScoped)
            {
                var tenantId = Expression.Convert(Expression.Property(e, nameof(ITenantScoped.TenantId)), typeof(Guid?));
                var currentTenant = Expression.Property(Expression.Constant(this), nameof(CurrentTenantId));
                body = Expression.Equal(tenantId, currentTenant);
            }
            if (softDelete)
            {
                var notDeleted = Expression.Not(Expression.Property(e, nameof(ISoftDelete.IsDeleted)));
                body = body is null ? notDeleted : Expression.AndAlso(body, notDeleted);
            }
            entityType.SetQueryFilter(Expression.Lambda(body!, e));
        }
    }

    // ------------------------------------------------------------------ audit stamping & write guard

    public override int SaveChanges(bool acceptAllChangesOnSuccess)
    {
        Stamp();
        return base.SaveChanges(acceptAllChangesOnSuccess);
    }

    public override async Task<int> SaveChangesAsync(bool acceptAllChangesOnSuccess, CancellationToken cancellationToken = default)
    {
        Stamp();
        // Remember what changes a workspace's plan or entitlements *before* saving (the tracker is cleared afterwards).
        var tenants = new HashSet<Guid>(); var plansChanged = false;
        if (entitlementCache is { Enabled: true })
        {
            foreach (var e in ChangeTracker.Entries().Where(e => e.State is EntityState.Added or EntityState.Modified or EntityState.Deleted))
            {
                if (e.Entity is Subscription sub) tenants.Add(sub.TenantId);
                else if (e.Entity is TenantFeatureOverride o) tenants.Add(o.TenantId);
                else if (e.Entity is Plan or PlanFeature) plansChanged = true;
            }
        }
        // Activity written in this save is what other people's open screens need to hear about (sent only once it is committed).
        var changes = changeFeed is null ? null : ChangeTracker.Entries<Activity>().Where(e => e.State == EntityState.Added)
            .Select(e => new ChangeEvent(e.Entity.TenantId, e.Entity.EntityType, e.Entity.EntityId, e.Entity.ProjectId, e.Entity.Action, e.Entity.ActorId)).ToList();
        var saved = await base.SaveChangesAsync(acceptAllChangesOnSuccess, cancellationToken);
        if (entitlementCache is not null)
        {
            if (plansChanged) entitlementCache.InvalidateAllPlans();
            foreach (var t in tenants) await entitlementCache.InvalidateTenantAsync(t, cancellationToken);
        }
        if (changes is { Count: > 0 }) changeFeed!.Publish(changes);
        return saved;
    }

    private void Stamp()
    {
        var now = clock.GetUtcNow().UtcDateTime;
        var userId = current.UserId;
        var tenantId = current.TenantId;

        foreach (var entry in ChangeTracker.Entries())
        {
            if (entry.Entity is AuditableEntity audit)
            {
                if (entry.State == EntityState.Added)
                {
                    if (audit.CreatedAt == default) audit.CreatedAt = now;
                    audit.CreatedBy ??= userId;
                }
                else if (entry.State == EntityState.Modified)
                {
                    audit.UpdatedAt = now;
                    audit.UpdatedBy = userId;
                }
            }

            if (entry.Entity is ITenantScoped scoped && entry.State is EntityState.Added or EntityState.Modified or EntityState.Deleted)
            {
                if (scoped.TenantId == Guid.Empty)
                    scoped.TenantId = tenantId ?? throw new InvalidOperationException(
                        $"{entry.Entity.GetType().Name} is tenant-owned but no tenant is in context.");
                // Requests can never write into a tenant other than the one resolved for them.
                if (tenantId is not null && scoped.TenantId != tenantId)
                    throw new InvalidOperationException($"Blocked cross-tenant write to {entry.Entity.GetType().Name}.");
            }
        }
    }
}

/// <summary>Used by <c>dotnet ef</c> at design time (no live database needed to scaffold migrations).</summary>
public class DesignTimeDbContextFactory : Microsoft.EntityFrameworkCore.Design.IDesignTimeDbContextFactory<AppDbContext>
{
    public AppDbContext CreateDbContext(string[] args)
    {
        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseNpgsql("Host=localhost;Database=projectmanagement;Username=postgres;Password=postgres")
            .Options;
        return new AppDbContext(options, new CurrentContext(), TimeProvider.System);
    }
}
