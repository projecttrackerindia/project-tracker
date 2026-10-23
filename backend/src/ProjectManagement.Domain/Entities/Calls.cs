using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Entities;

/// <summary>
/// One of our own video calls (a room on our media server): in a project, in a chat conversation, or on its own. The people in it are
/// <see cref="CallParticipant"/> rows. When the project agent is asked along, <see cref="AgentSessionId"/> is its meeting-bot session,
/// so the transcript, minutes and follow-ups work exactly as for a Google Meet or Teams call - without anyone having to let it in.
/// </summary>
public class CallRoom : TenantEntity, ITenantScoped
{
    public string Title { get; set; } = "";
    /// <summary>The media server's room name: unique, unguessable.</summary>
    public string RoomName { get; set; } = "";
    /// <summary>"project", "chat" or "adhoc".</summary>
    public string Kind { get; set; } = "adhoc";
    public Guid? ProjectId { get; set; }
    public Guid? MeetingId { get; set; }
    public Guid? ConversationId { get; set; }
    public Guid StartedBy { get; set; }
    public DateTime StartedAt { get; set; }
    public DateTime? EndedAt { get; set; }
    /// <summary>"live" or "ended".</summary>
    public string Status { get; set; } = "live";
    public bool AgentEnabled { get; set; }
    public Guid? AgentSessionId { get; set; }
    /// <summary>Highest number of people in the call at once.</summary>
    public int PeakParticipants { get; set; }
}

/// <summary>Someone invited to or in a call. Invited people may join; others only through the project or conversation the call belongs to.</summary>
public class CallParticipant : TenantEntity, ITenantScoped
{
    public Guid CallId { get; set; }
    public Guid UserId { get; set; }
    /// <summary>"host" or "member".</summary>
    public string Role { get; set; } = "member";
    public DateTime? InvitedAt { get; set; }
    public DateTime? JoinedAt { get; set; }
    public DateTime? LeftAt { get; set; }
    /// <summary>Seconds in the call so far (summed over reconnects).</summary>
    public int Seconds { get; set; }
}
