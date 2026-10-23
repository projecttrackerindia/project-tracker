using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Entities;

/// <summary>
/// What a workspace's members get when they have not chosen for themselves: channels per kind of notification, quiet hours and the daily
/// digest. A person's own choice always wins (preferences are personal and follow them to every workspace); these only fill the gaps.
/// One row per workspace, created the first time an admin saves.
/// </summary>
public class WorkspaceNotificationDefaults : TenantEntity, ITenantScoped
{
    /// <summary>Kinds whose channels differ from the platform's, as "TaskAssigned=ieb;Briefing=" (i = in the app, e = e-mail, b = desktop and phone).</summary>
    public string Channels { get; set; } = "";
    /// <summary>The workspace sets quiet hours for people who have not set their own (otherwise the platform's 21:00 to 08:00).</summary>
    public bool QuietCustom { get; set; }
    /// <summary>Null with <see cref="QuietCustom"/> = no quiet hours.</summary>
    public TimeOnly? QuietStart { get; set; }
    public TimeOnly? QuietEnd { get; set; }
    /// <summary>The workspace turns digest mode on (or off) for people who have not chosen.</summary>
    public bool DigestCustom { get; set; }
    /// <summary>Null with <see cref="DigestCustom"/> = updates arrive at once.</summary>
    public TimeOnly? DigestTime { get; set; }
}

/// <summary>A setup-health check an admin marked as not needed here ("we do not use WhatsApp"), so it stops counting against the workspace.</summary>
public class SetupCheckDismissal : TenantEntity, ITenantScoped
{
    public string CheckId { get; set; } = "";
    public string? Reason { get; set; }
}
