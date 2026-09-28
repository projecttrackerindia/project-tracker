using ProjectManagement.Domain.Common;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Domain;

/// <summary>One kind of notification and how it is delivered when the user has not chosen otherwise.</summary>
public record NotificationKind(NotificationType Type, string Label, string Description, bool InApp, bool Email, bool Browser, bool Locked);

public static class NotificationCatalog
{
    public static readonly NotificationKind[] All =
    [
        new(NotificationType.TaskAssigned, "Task assigned to me", "Someone assigns a task to you.", true, true, false, false),
        new(NotificationType.Mention, "Mentions", "Someone @mentions you in a comment or in a project chat.", true, true, false, false),
        new(NotificationType.Comment, "Comments on my tasks", "New comments on tasks you are assigned to or reported.", true, false, false, false),
        new(NotificationType.DueSoon, "Due date approaching", "A task assigned to you is due today or tomorrow.", true, false, false, false),
        new(NotificationType.Overdue, "Overdue tasks", "A task assigned to you is past its due date.", true, true, false, false),
        new(NotificationType.Invitation, "Invitations", "You are invited to join an organization.", true, true, false, false),
        new(NotificationType.Subscription, "Billing and subscription", "Plan changes, payment problems and expiry (sent to organization owners).", true, true, false, false),
        new(NotificationType.Issue, "Test issues", "A test issue is reported, assigned to you, fixed, reopened or resolved on a project you work on.", true, false, false, false),
        new(NotificationType.ReportReady, "Reports ready", "A report you asked for has been generated and can be downloaded.", true, false, true, false),
        // Security alerts cannot be switched off in-app or by email.
        new(NotificationType.Security, "Security alerts", "Password changes and other account security events. Always on.", true, true, false, true),
    ];

    public static NotificationKind For(NotificationType type) => All.First(k => k.Type == type);
}

/// <summary>A user's own choice of channels for one kind of notification (applies in every workspace). No row = the catalog default.</summary>
public class NotificationPreference : Entity
{
    public Guid UserId { get; set; }
    public NotificationType Type { get; set; }
    public bool InApp { get; set; }
    public bool Email { get; set; }
    public bool Browser { get; set; }
}
