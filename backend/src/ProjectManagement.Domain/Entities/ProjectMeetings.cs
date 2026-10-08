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
        public MeetingStatus Status { get; set; } = MeetingStatus.Scheduled;
        public string GoogleCalendarEventId { get; set; } = "";
        /// <summary>The Meet space's resource name ("spaces/{id}"), when created through the Meet API rather than only Calendar conferenceData.</summary>
        public string? GoogleMeetSpaceName { get; set; }
        public string GoogleMeetUri { get; set; } = "";
        public DateTime? CancelledAt { get; set; }

        public Project? Project { get; set; }
        public User? Organizer { get; set; }
        public ICollection<MeetingParticipant> Participants { get; set; } = new List<MeetingParticipant>();
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
