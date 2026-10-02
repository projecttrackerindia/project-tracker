namespace ProjectManagement.Domain.Enums;

public enum WorkspaceType { Personal, Organization }
public enum TenantStatus { Active, Suspended }

/// <summary>Numeric value = privilege level (higher is more privileged).</summary>
public enum TenantRole { Guest = 1, Member = 2, Manager = 3, Admin = 4, Owner = 5 }

public enum ProjectStatus { Planning, Active, OnHold, Completed, Cancelled, Archived }
public enum Priority { Low, Medium, High, Critical }
public enum StatusCategory { Todo, Active, Done, Cancelled }
public enum StageStatus { Pending, InProgress, Completed, Delayed }

/// <summary>How one task depends on another (spec section 18). The names read "predecessor-to-successor".</summary>
public enum DependencyType
{
    /// <summary>The predecessor must finish before this task can start. The common case.</summary>
    FinishToStart,
    /// <summary>The predecessor must have started before this task can start.</summary>
    StartToStart,
    /// <summary>The predecessor must finish before this task can finish.</summary>
    FinishToFinish,
    /// <summary>The predecessor must have started before this task can finish.</summary>
    StartToFinish,
}
public enum SubscriptionStatus { Trial, Active, PastDue, Cancelled, Expired }
public enum InvitationStatus { Pending, Accepted, Revoked, Expired }
public enum InvoiceStatus { Paid, Failed, Refunded }
public enum NotificationType { TaskAssigned, Mention, Comment, DueSoon, Overdue, Invitation, Subscription, Security, ReportReady, Issue, Approval, ServiceLevel, Reminder, Nudge, Briefing }
