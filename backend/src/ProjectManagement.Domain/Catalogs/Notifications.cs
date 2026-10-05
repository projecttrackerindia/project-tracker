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
        new(NotificationType.Message, "Chat messages", "Someone sends you a direct or group message while you are away from the chat (one notice per conversation, kept up to date).", true, false, true, false),
        new(NotificationType.Comment, "Comments on my tasks", "New comments on tasks you are assigned to or reported.", true, false, false, false),
        new(NotificationType.Reminder, "My reminders", "Reminders you set yourself, when their time comes.", true, false, true, false),
        new(NotificationType.Nudge, "Reminders from others", "Someone reminds you about work.", true, true, true, false),
        new(NotificationType.DueSoon, "Due date approaching", "Work assigned to you is due soon (when: Reminders → Settings).", true, false, false, false),
        new(NotificationType.Overdue, "Overdue work", "Work assigned to you, or that you oversee, is past its due date.", true, true, false, false),
        new(NotificationType.Briefing, "Morning briefing", "Once a day: what is due, overdue and coming up.", true, false, false, false),
        new(NotificationType.PortfolioDigest, "Weekly portfolio brief", "Every Monday: which projects are at risk or delayed, and why. Sent to organization owners and admins.", true, true, false, false),
        new(NotificationType.Invitation, "Invitations", "You are invited to join an organization.", true, true, false, false),
        new(NotificationType.Subscription, "Billing and subscription", "Plan changes, payment problems and expiry (sent to organization owners).", true, true, false, false),
        new(NotificationType.Issue, "Test issues", "A test issue is reported, assigned to you, fixed, reopened or resolved on a project you work on.", true, false, false, false),
        new(NotificationType.ReportReady, "Reports ready", "A report you asked for has been generated and can be downloaded.", true, false, true, false),
        new(NotificationType.Approval, "Timesheet approvals", "A timesheet is waiting for you to approve it, or yours was approved or returned.", true, true, false, false),
        new(NotificationType.ServiceLevel, "Service levels (SLA)", "Operational work you are assigned or raised is about to miss, or has missed, its response or resolution target.", true, true, true, false),
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
