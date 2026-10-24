using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Entities;

/// <summary>
/// One person's choices about their connected accounts in one workspace: which service their meetings use, and whether their notifications
/// also reach them as Slack direct messages.
/// </summary>
public class PersonalConnectionSettings : TenantEntity, ITenantScoped
{
    public Guid UserId { get; set; }
    /// <summary>"auto" (Google, then Microsoft, then our own call), "google", "microsoft" or "ours".</summary>
    public string MeetingService { get; set; } = "auto";
    /// <summary>Slack direct messages: "off", "needs" (only what asks something of the person) or "all".</summary>
    public string SlackMessages { get; set; } = "off";
}

/// <summary>
/// A person's own Slack user in the workspace's connected Slack ("Sign in with Slack"): who they are there, so the Project Tracker bot can
/// send them direct messages. No Slack token of theirs is kept; the bot's own token sends.
/// </summary>
public class SlackUserLink : TenantEntity, ITenantScoped
{
    public Guid UserId { get; set; }
    public string SlackTeamId { get; set; } = "";
    public string SlackUserId { get; set; } = "";
    public string? Name { get; set; }
    public string? Email { get; set; }
    public DateTime ConnectedAt { get; set; }
    public string? LastError { get; set; }
}
