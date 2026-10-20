using ProjectManagement.Domain.Common;
namespace ProjectManagement.Domain.Entities;

/// <summary>
/// A signed-in Google account the meeting bot joins calls with (installation-wide, managed by platform administrators): its browser
/// cookies, stored only encrypted and handed to a bot worker for the call it joins.
/// </summary>
public class MeetingBotIdentity : AuditableEntity
{
    public string Email { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public string CookiesProtected { get; set; } = "";
    public bool Active { get; set; } = true;
    public DateTime? LastUsedAt { get; set; }
    public string? LastError { get; set; }
    public DateTime? LastErrorAt { get; set; }
}

/// <summary>One person's notetaker: the project its notes are filed under, whether it joins their calendar's calls, and whether minutes are written.</summary>
public class NotetakerSettings : TenantEntity, ITenantScoped
{
    public Guid UserId { get; set; }
    public Guid? ProjectId { get; set; }
    public bool AutoJoin { get; set; }
    public bool AutoMinutes { get; set; } = true;
    /// <summary>Email the minutes to the person as soon as they are written.</summary>
    public bool AutoEmail { get; set; } = true;
    /// <summary>Create the minutes' action items as tasks in the project (assigned by name where a member matches).</summary>
    public bool AutoTasks { get; set; }
    /// <summary>Erase the transcript once the minutes are written and the agent has read it (the minutes stay).</summary>
    public bool DeleteTranscript { get; set; } = true;
}

/// <summary>The minutes (MOM) of one session the bot attended, written by the agent from the transcript; encrypted.</summary>
public class MeetingMinutes : TenantEntity, ITenantScoped
{
    public Guid BotRowId { get; set; }
    public Guid ProjectId { get; set; }
    public Guid UserId { get; set; }
    public string Title { get; set; } = "";
    public string ContentProtected { get; set; } = "";
    public string Status { get; set; } = "ready";
    public DateTime? SentAt { get; set; }
    public string? Model { get; set; }
}
