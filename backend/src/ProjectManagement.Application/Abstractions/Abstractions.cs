using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Abstractions;

public interface IAppDbContext
{
    DbSet<User> Users { get; }
    DbSet<UserSession> UserSessions { get; }
    DbSet<RefreshToken> RefreshTokens { get; }
    DbSet<MfaRecoveryCode> MfaRecoveryCodes { get; }
    DbSet<Tenant> Tenants { get; }
    DbSet<TenantMember> TenantMembers { get; }
    DbSet<TenantInvitation> TenantInvitations { get; }
    DbSet<RolePermissionOverride> RolePermissionOverrides { get; }
    DbSet<Team> Teams { get; }
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

public interface ISecretProtector
{
    string Protect(string plainText);
    string Unprotect(string protectedText);
}

public record EmailMessage(string To, string Subject, string Html, string? Text = null);

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

public interface IPaymentProvider
{
    Task<PaymentResult> ChargeAsync(Guid tenantId, string planCode, decimal amount, string currency, CancellationToken ct = default);
}
