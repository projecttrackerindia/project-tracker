using ProjectManagement.Domain.Common;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Domain.Enums
{
    /// <summary>A meeting's own lifecycle inside Project Tracker. The Google Calendar event is the source of truth for the invitation/RSVP
    /// workflow; this is only how Project Tracker reflects it.</summary>
    public enum MeetingStatus { Scheduled, Cancelled, Completed }

    /// <summary>A Calendar attendee's response, mirrored from Google (never invented locally).</summary>
    public enum AttendeeRsvpStatus { NeedsAction, Accepted, Declined, Tentative }

    public enum MeetingParticipantRole { Organizer, Attendee }

    /// <summary>
    /// Where a meeting lives. Google: an event on the organizer's Google Calendar with a Meet link. Microsoft: an event on their Outlook
    /// calendar with a Teams meeting. ProjectTracker: our own call (our media server, the project agent joins without any lobby) with no
    /// outside calendar. The event id and join address fields hold that service's values.
    /// </summary>
    public enum MeetingProvider { Google = 0, Microsoft = 1, ProjectTracker = 2 }
}

namespace ProjectManagement.Domain.Entities
{
    /// <summary>
    /// A Google Meet / Calendar meeting organized from a project. Project Tracker never implements its own video conferencing, invitation
    /// e-mail or RSVP mechanism: this row is a reflection of a real Google Calendar event (GoogleCalendarEventId) that carries a Google Meet
    /// conference (GoogleMeetUri) - both created through the organizer's own Google account (see <see cref="GoogleConnection"/>). Cancelling
    /// or rescheduling here updates that same Calendar event; it is never recreated.
    /// </summary>
    public class ProjectMeeting : TenantEntity, ITenantScoped
    {
        public Guid ProjectId { get; set; }
        public Guid OrganizerUserId { get; set; }
        public string Title { get; set; } = "";
        public string? Description { get; set; }
        public DateTime StartTimeUtc { get; set; }
        public DateTime EndTimeUtc { get; set; }
        /// <summary>IANA zone the organizer scheduled it in (e.g. "Asia/Kolkata"); times above are always UTC regardless.</summary>
        public string TimeZone { get; set; } = "UTC";
        public string? RecurrenceRule { get; set; }
        public string? CalendarUrl { get; set; }
        public MeetingStatus Status { get; set; } = MeetingStatus.Scheduled;
        /// <summary>Which service holds the meeting; <see cref="GoogleCalendarEventId"/> and <see cref="GoogleMeetUri"/> are that service's event id and join address.</summary>
        public MeetingProvider Provider { get; set; } = MeetingProvider.Google;
        public string GoogleCalendarEventId { get; set; } = "";
        /// <summary>The Meet space's resource name ("spaces/{id}"), when created through the Meet API rather than only Calendar conferenceData.</summary>
        public string? GoogleMeetSpaceName { get; set; }
        public string GoogleMeetUri { get; set; } = "";
        public DateTime? CancelledAt { get; set; }
        /// <summary>A stand-up ("Schedule scrum call"): after each session a summary of the project's work is posted to its chat.</summary>
        public bool IsScrum { get; set; }
        /// <summary>The meeting-zone day ("yyyyMMdd") whose stand-up summary was last posted, so each session gets exactly one.</summary>
        public string? LastSummaryDay { get; set; }

        public Project? Project { get; set; }
        public User? Organizer { get; set; }
        public ICollection<MeetingParticipant> Participants { get; set; } = new List<MeetingParticipant>();
    }

    /// <summary>
    /// A Google Meet / Calendar meeting for the workspace as a whole - a team stand-up that belongs to no single project ("Schedule scrum
    /// call" with "No project"). Like <see cref="ProjectMeeting"/> it only reflects the real Calendar event, which Google owns; it is kept
    /// here so the people invited see it on their Calendar page and the organizer can cancel or move it.
    /// </summary>
    public class WorkspaceMeeting : TenantEntity, ITenantScoped
    {
        public Guid OrganizerUserId { get; set; }
        public string Title { get; set; } = "";
        public string? Description { get; set; }
        public DateTime StartTimeUtc { get; set; }
        public DateTime EndTimeUtc { get; set; }
        public string TimeZone { get; set; } = "UTC";
        public string? RecurrenceRule { get; set; }
        public string? CalendarUrl { get; set; }
        public MeetingStatus Status { get; set; } = MeetingStatus.Scheduled;
        /// <summary>Which service holds the meeting (see <see cref="ProjectMeeting.Provider"/>).</summary>
        public MeetingProvider Provider { get; set; } = MeetingProvider.Google;
        public string GoogleCalendarEventId { get; set; } = "";
        public string GoogleMeetUri { get; set; } = "";
        public bool IsScrum { get; set; }
        public DateTime? CancelledAt { get; set; }

        public User? Organizer { get; set; }
        public ICollection<WorkspaceMeetingAttendee> Attendees { get; set; } = new List<WorkspaceMeetingAttendee>();
    }

    /// <summary>Someone invited to a <see cref="WorkspaceMeeting"/> (the organizer included), so it shows on their Calendar.</summary>
    public class WorkspaceMeetingAttendee : TenantEntity, ITenantScoped
    {
        public Guid MeetingId { get; set; }
        public Guid UserId { get; set; }
        public string Email { get; set; } = "";
        public bool IsOrganizer { get; set; }

        public WorkspaceMeeting? Meeting { get; set; }
        public User? User { get; set; }
    }

    /// <summary>
    /// One invitee of a <see cref="ProjectMeeting"/>. Denormalizes ProjectId (the pattern <see cref="Attachment"/> already uses for a
    /// child-of-project row) so the same project-visibility query filter that scopes the meeting also scopes its participants, with no
    /// bespoke access code. RsvpStatus is never set by Project Tracker itself - only synchronized from the Google Calendar event's attendee
    /// response, which is the authoritative RSVP state (spec: do not build an independent accept/decline mechanism).
    /// </summary>
    public class MeetingParticipant : TenantEntity, ITenantScoped
    {
        public Guid MeetingId { get; set; }
        public Guid ProjectId { get; set; }
        /// <summary>Null for an attendee who is on the Calendar invitation by email only (not a Project Tracker member, e.g. an external guest address entered by the organizer).</summary>
        public Guid? UserId { get; set; }
        public string Email { get; set; } = "";
        public MeetingParticipantRole Role { get; set; } = MeetingParticipantRole.Attendee;
        public AttendeeRsvpStatus RsvpStatus { get; set; } = AttendeeRsvpStatus.NeedsAction;
        /// <summary>Google's own id for this attendee on the Calendar event, when known (not always returned).</summary>
        public string? GoogleAttendeeId { get; set; }
        public bool IsRequired { get; set; } = true;

        public ProjectMeeting? Meeting { get; set; }
        public User? User { get; set; }
    }
}
