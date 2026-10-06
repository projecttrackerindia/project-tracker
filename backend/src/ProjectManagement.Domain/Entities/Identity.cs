using ProjectManagement.Domain.Common;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Domain.Entities;

public class User : AuditableEntity
{
    public string Email { get; set; } = "";
    public string NormalizedEmail { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public string PasswordHash { get; set; } = "";
    public bool EmailVerified { get; set; }
    public string? EmailVerificationTokenHash { get; set; }
    public DateTime? EmailVerificationExpiresAt { get; set; }
    public string? PasswordResetTokenHash { get; set; }
    public DateTime? PasswordResetExpiresAt { get; set; }
    public bool IsActive { get; set; } = true;
    public bool IsPlatformAdmin { get; set; }
    /// <summary>
    /// Set when an administrator created the account and chose its first password: until the person picks their own,
    /// nothing but signing in, changing the password and signing out works.
    /// </summary>
    public bool MustChangePassword { get; set; }
    public int FailedLoginCount { get; set; }
    public DateTime? LockoutEnd { get; set; }
    public DateTime? LastLoginAt { get; set; }
    public string TimeZone { get; set; } = "Asia/Kolkata";

    // Two-step verification (authenticator app). Secrets are stored encrypted, never in clear text.
    public bool MfaEnabled { get; set; }
    public DateTime? MfaEnabledAt { get; set; }
    /// <summary>The active TOTP secret (encrypted).</summary>
    public string? MfaSecret { get; set; }
    /// <summary>A secret being set up: becomes active only once the user proves their app shows the right code.</summary>
    public string? MfaPendingSecret { get; set; }
    /// <summary>Latest time step already accepted, so a code cannot be used twice.</summary>
    public long MfaLastStep { get; set; }
}

/// <summary>One-time recovery code for when the authenticator app is lost. Only a hash is kept.</summary>
public class MfaRecoveryCode : Entity
{
    public Guid UserId { get; set; }
    public string CodeHash { get; set; } = "";
    public DateTime CreatedAt { get; set; }
    public DateTime? UsedAt { get; set; }
}

/// <summary>A login session; refresh tokens rotate inside a session.</summary>
public class UserSession : Entity
{
    public Guid UserId { get; set; }
    public Guid? WorkspaceId { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime LastSeenAt { get; set; }
    public DateTime ExpiresAt { get; set; }
    public DateTime? RevokedAt { get; set; }
    public string? IpAddress { get; set; }
    public string? UserAgent { get; set; }
    /// <summary>How the session was opened: password, password+mfa, sso, google, microsoft, github, apple.</summary>
    public string? AuthMethod { get; set; }
    /// <summary>
    /// Set when an organization's own single sign-on opened the session: that organization's identity provider vouched for the person,
    /// so its "require two-step verification" rule counts as met for this session (the provider applies its own MFA).
    /// </summary>
    public Guid? SsoTenantId { get; set; }
}

public class RefreshToken : Entity
{
    public Guid SessionId { get; set; }
    public Guid UserId { get; set; }
    public string TokenHash { get; set; } = "";
    public DateTime CreatedAt { get; set; }
    public DateTime ExpiresAt { get; set; }
    public DateTime? UsedAt { get; set; }
    public Guid? ReplacedByTokenId { get; set; }
}

public class Tenant : AuditableEntity, ISoftDelete
{
    public string Name { get; set; } = "";
    public string Slug { get; set; } = "";
    public string? Description { get; set; }
    public WorkspaceType Type { get; set; }
    public Guid OwnerUserId { get; set; }
    public TenantStatus Status { get; set; } = TenantStatus.Active;
    public bool TrialUsed { get; set; }
    /// <summary>The currency of budgets, cost and bill rates (ISO code). Null = the platform's billing currency.</summary>
    public string? CostCurrency { get; set; }
    /// <summary>The workspace has switched the AI assistant off (nothing of its data is ever sent to the model).</summary>
    public bool AiDisabled { get; set; }
    /// <summary>What the organization tells the assistant about itself and how it works (written by an Owner or Admin, shared with every answer).</summary>
    public string? AiInstructions { get; set; }
    /// <summary>Whether every member sees every project (the default) or only the projects of their own teams and the ones they were added to.</summary>
    public ProjectVisibility ProjectVisibility { get; set; } = ProjectVisibility.Organization;

    /// <summary>What appears under "Bill to" on invoices: the company's legal name, address and tax id (GSTIN). Empty = the workspace name.</summary>
    public string? BillingName { get; set; }
    public string? BillingAddress { get; set; }
    public string? BillingTaxId { get; set; }

    /// <summary>Soft delete: members lose access, all data is retained and the tenant can be restored by a platform admin.</summary>
    public bool IsDeleted { get; set; }
    public DateTime? DeletedAt { get; set; }
    public Guid? DeletedBy { get; set; }
}

public class TenantMember : TenantEntity
{
    public Guid UserId { get; set; }
    public TenantRole Role { get; set; }
    public User? User { get; set; }

    /// <summary>Job role in the organization chart (CTO, Developer...). Null = not placed on the chart yet.</summary>
    public Guid? OrgRoleId { get; set; }
    /// <summary>The person this member reports to (another member of the same tenant).</summary>
    public Guid? ReportsToUserId { get; set; }

    /// <summary>Hours a week this person is available for work, in minutes. Null = the standard 40 hours.</summary>
    public int? WeeklyCapacityMinutes { get; set; }
    /// <summary>What an hour of this person's time costs the organization, in the workspace's cost currency. Seen only by Owners and Admins.</summary>
    public decimal? CostRate { get; set; }
    /// <summary>What an hour of this person's billable time is charged at (a project's own rate takes precedence).</summary>
    public decimal? BillRate { get; set; }
}

/// <summary>
/// A job role on the organization chart. Roles form a tree (one parent each). Soft-deleted roles stay in the database
/// and can be restored; their people and sub-roles are moved elsewhere when the role is deleted.
/// </summary>
public class OrgRole : TenantEntity, ITenantScoped, ISoftDelete
{
    public string Name { get; set; } = "";
    public string? Description { get; set; }
    public string Color { get; set; } = "#8b5cf6";
    public Guid? ParentRoleId { get; set; }
    public int SortOrder { get; set; }
    /// <summary>Canvas position saved by the admin; null = auto layout.</summary>
    public double? PosX { get; set; }
    public double? PosY { get; set; }

    public bool IsDeleted { get; set; }
    public DateTime? DeletedAt { get; set; }
    public Guid? DeletedBy { get; set; }
    /// <summary>Where the role hung before it was deleted, so restore can put it back.</summary>
    public Guid? PreviousParentRoleId { get; set; }

    /// <summary>What people in this role may see and do (an <see cref="AccessProfile"/> as JSON). Null = their access level's defaults.</summary>
    public string? AccessJson { get; set; }
}

public class TenantInvitation : TenantEntity
{
    public string Email { get; set; } = "";
    public string NormalizedEmail { get; set; } = "";
    public TenantRole Role { get; set; } = TenantRole.Member;
    public string TokenHash { get; set; } = "";
    public DateTime ExpiresAt { get; set; }
    public InvitationStatus Status { get; set; } = InvitationStatus.Pending;
    public DateTime? AcceptedAt { get; set; }
    public Guid? AcceptedByUserId { get; set; }

    /// <summary>Job role the person lands in when they accept (organization chart). Null = not placed yet.</summary>
    public Guid? OrgRoleId { get; set; }
    /// <summary>Who they will report to. Null = nobody.</summary>
    public Guid? ReportsToUserId { get; set; }
}

/// <summary>Per-tenant override of a role's default capability (spec section 9).</summary>
public class RolePermissionOverride : TenantEntity, ITenantScoped
{
    public TenantRole Role { get; set; }
    public string Permission { get; set; } = "";
    public bool Allowed { get; set; }
}

public class Team : TenantEntity, ITenantScoped
{
    public string Name { get; set; } = "";
    public string? Description { get; set; }
    public ICollection<TeamMember> Members { get; set; } = new List<TeamMember>();
}

public class TeamMember : TenantEntity, ITenantScoped
{
    public Guid TeamId { get; set; }
    public Guid UserId { get; set; }
    public bool IsLead { get; set; }
    public User? User { get; set; }
}


public enum DeviceLoginStatus { Pending = 0, Approved = 1, Denied = 2, Redeemed = 3, Ignored = 4 }

/// <summary>
/// A sign-in on one screen (usually a computer) waiting to be approved on another the person already holds (their phone): the computer shows a
/// number, the phone offers three and the person taps the one they see. The computer redeems it with a secret only it was given. Not tied to an
/// organization: it happens before one is chosen. "Ignored" rows are requests that were never sent to anyone (unknown address, too many requests),
/// kept so the answer looks the same to whoever asked.
/// </summary>
public class DeviceLoginRequest : Entity
{
    public Guid UserId { get; set; }
    public string SecretHash { get; set; } = "";
    public int Number { get; set; }
    public DeviceLoginStatus Status { get; set; }
    public int WrongAttempts { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime ExpiresAt { get; set; }
    public DateTime? DecidedAt { get; set; }
    public string? RequesterIp { get; set; }
    public string? RequesterAgent { get; set; }
}

/// <summary>
/// A write that was sent with an <c>Idempotency-Key</c>: what was asked and what was answered, kept for a day so that a retry (a phone that
/// lost its connection mid-request) gets the same answer instead of doing the work twice.
/// </summary>
public class IdempotencyRecord : Entity
{
    public Guid UserId { get; set; }
    public string Key { get; set; } = "";
    public string RequestHash { get; set; } = "";
    public bool Completed { get; set; }
    public int ResponseStatus { get; set; }
    public string? ContentType { get; set; }
    public string? ResponseBody { get; set; }
    public DateTime CreatedAt { get; set; }
}

/// <summary>A passkey: a key pair kept by the person's phone, laptop or security key. Only the public half is stored here.</summary>
public class PasskeyCredential : Entity
{
    public Guid UserId { get; set; }
    /// <summary>The credential id the device presents, base64url.</summary>
    public string CredentialId { get; set; } = "";
    public byte[] PublicKey { get; set; } = [];
    public byte[] UserHandle { get; set; } = [];
    public long SignCount { get; set; }
    public string Name { get; set; } = "";
    public Guid AaGuid { get; set; }
    public bool BackedUp { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime? LastUsedAt { get; set; }
}

/// <summary>The challenge handed to the browser between "here are the options" and "here is the signed answer"; lives five minutes, used once.</summary>
public class PasskeyChallenge : Entity
{
    public Guid? UserId { get; set; }
    public string Purpose { get; set; } = "";
    public string OptionsJson { get; set; } = "";
    public DateTime CreatedAt { get; set; }
}
