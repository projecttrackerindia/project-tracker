using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Chat;
using ProjectManagement.Application.Features.Integrations;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.ProjectMeetings;

public record MeetingParticipantDto(Guid? UserId, string Name, string Email, string Role, string RsvpStatus);
public record MeetingDto(Guid Id, Guid ProjectId, string Title, string? Description, DateTimeOffset StartTime, DateTimeOffset EndTime, string TimeZone,
    string Status, string MeetUri, Guid OrganizerUserId, string OrganizerName, IReadOnlyList<MeetingParticipantDto> Participants);

/// <summary>Start Meeting: participants default to everyone who can see the project (spec section 2) unless the organizer names a specific list.</summary>
public record StartMeetingRequest(string? Title, IReadOnlyList<Guid>? ParticipantUserIds);
/// <summary>Schedule Meeting: the organizer always names start/end explicitly, in a real instant (not a bare local time) so no timezone is guessed.</summary>
public record ScheduleMeetingRequest(string Title, string? Description, DateTimeOffset StartTime, DateTimeOffset EndTime, string TimeZone, IReadOnlyList<Guid>? ParticipantUserIds);
public record RescheduleMeetingRequest(DateTimeOffset StartTime, DateTimeOffset EndTime);
public record AddMeetingParticipantRequest(Guid UserId);

/// <summary>
/// Google Meet/Calendar meetings, scoped to a project. Project Tracker never implements its own conferencing, invitation e-mail or RSVP
/// mechanism (spec section 27): every write here is really a write to the organizer's own Google Calendar event
/// (<see cref="GoogleMeetingClient"/>), and what is stored locally is a reflection of that event for the project's own UI, chat and reports.
/// Participants are always restricted to people who can already see the project - never the whole tenant - the same rule
/// <see cref="ProjectAccess"/> already enforces for everything else project-scoped (spec section 6).
/// </summary>
public class MeetingService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, ProjectAccess access,
    PermissionService permissions, NotificationService notifications, GoogleMeetingClient google, ChatService chat)
{
    private const int DefaultStartNowMinutes = 60;
    private record MeetingCard(Guid MeetingId, string Title, DateTime StartTimeUtc, DateTime EndTimeUtc, string TimeZone, string MeetUri, int ParticipantCount, string Status);

    // ---------------------------------------------------------------- who may be invited

    /// <summary>The project's owner and members (plus, in a team-restricted workspace, everyone on the project's team) - the only people an
    /// organizer may invite, and the picker a "Start/Schedule meeting" screen shows.</summary>
    public async Task<IReadOnlyList<MeetingParticipantDto>> EligibleParticipantsAsync(Guid projectId, CancellationToken ct = default)
    {
        var project = await access.GetProjectAsync(projectId, ct);
        var ids = await EligibleUserIdsAsync(project, ct);
        var hideEmail = ctx.Role == TenantRole.Guest;
        var rows = await db.Users.AsNoTracking().Where(u => ids.Contains(u.Id)).OrderBy(u => u.DisplayName)
            .Select(u => new { u.Id, u.DisplayName, u.Email }).ToListAsync(ct);
        return rows.Select(u => new MeetingParticipantDto(u.Id, u.DisplayName, hideEmail ? "" : u.Email, u.Id == project.OwnerId ? "Owner" : "Member", "NeedsAction")).ToList();
    }

    private async Task<HashSet<Guid>> EligibleUserIdsAsync(Project project, CancellationToken ct)
    {
        var ids = new HashSet<Guid> { project.OwnerId };
        foreach (var id in await db.ProjectMembers.AsNoTracking().Where(m => m.ProjectId == project.Id).Select(m => m.UserId).ToListAsync(ct)) ids.Add(id);
        if (project.TeamId is { } team && await db.Tenants.Where(t => t.Id == project.TenantId).Select(t => t.ProjectVisibility).FirstAsync(ct) == ProjectVisibility.Teams)
            foreach (var id in await db.TeamMembers.AsNoTracking().Where(m => m.TeamId == team).Select(m => m.UserId).ToListAsync(ct)) ids.Add(id);
        return ids;
    }

    // ---------------------------------------------------------------- create

    /// <summary>"Start Google Meet": a meeting from right now, a default hour long unless the organizer already knows otherwise - meant to be
    /// the fastest path in the product (spec: "Click Google Meet → select participants → Start → meeting link available immediately").</summary>
    public Task<MeetingDto> StartNowAsync(Guid projectId, StartMeetingRequest req, CancellationToken ct = default)
    {
        var start = DateTimeOffset.UtcNow;
        return CreateAsync(projectId, req.Title, null, start, start.AddMinutes(DefaultStartNowMinutes), "UTC", req.ParticipantUserIds, ct);
    }

    /// <summary>"Schedule Google Meet": the organizer's own title, time and attendee list.</summary>
    public Task<MeetingDto> ScheduleAsync(Guid projectId, ScheduleMeetingRequest req, CancellationToken ct = default)
    {
        if (req.EndTime <= req.StartTime) throw new ValidationException("endTime", "The meeting must end after it starts.");
        if (req.StartTime < DateTimeOffset.UtcNow.AddMinutes(-5)) throw new ValidationException("startTime", "Choose a time that has not already passed.");
        return CreateAsync(projectId, req.Title, req.Description, req.StartTime, req.EndTime, req.TimeZone, req.ParticipantUserIds, ct);
    }

    private async Task<MeetingDto> CreateAsync(Guid projectId, string? title, string? description, DateTimeOffset start, DateTimeOffset end, string timeZone,
        IReadOnlyList<Guid>? requestedParticipants, CancellationToken ct)
    {
        var project = await access.GetProjectAsync(projectId, ct);
        var organizerId = ctx.RequireUserId();
        var eligible = await EligibleUserIdsAsync(project, ct);
        // The organizer does not have to add themselves (they are always there), but anyone they *do* name must already be able to see the project.
        var invitedIds = (requestedParticipants ?? eligible.Where(id => id != organizerId)).Distinct().ToList();
        var unknown = invitedIds.Where(id => !eligible.Contains(id)).ToList();
        if (unknown.Count > 0) throw new ValidationException("participantUserIds", "Only people who can already see this project may be invited.");

        var users = await db.Users.AsNoTracking().Where(u => invitedIds.Contains(u.Id) || u.Id == organizerId)
            .Select(u => new { u.Id, u.DisplayName, u.Email }).ToListAsync(ct);
        var organizer = users.First(u => u.Id == organizerId);
        var attendees = users.Where(u => u.Id != organizerId).Select(u => new GoogleMeetingAttendee(u.Email)).ToList();

        var meetingTitle = string.IsNullOrWhiteSpace(title) ? $"{project.Name} Discussion" : title.Trim();
        CreatedGoogleMeeting created;
        try { created = await google.CreateEventAsync(organizerId, meetingTitle, description, start.UtcDateTime, end.UtcDateTime, timeZone, attendees, ct); }
        catch (GoogleApiException) { throw new ConflictException("We couldn't create the Google Meet right now. Please try again.", "GOOGLE_MEET_CREATE_FAILED"); }

        var meeting = new ProjectMeeting
        {
            TenantId = project.TenantId, ProjectId = projectId, OrganizerUserId = organizerId, Title = meetingTitle, Description = description,
            StartTimeUtc = start.UtcDateTime, EndTimeUtc = end.UtcDateTime, TimeZone = timeZone, Status = MeetingStatus.Scheduled,
            GoogleCalendarEventId = created.EventId, GoogleMeetSpaceName = created.MeetSpaceName, GoogleMeetUri = created.MeetUri,
            CreatedAt = clock.Now, CreatedBy = organizerId,
        };
        db.ProjectMeetings.Add(meeting);
        meeting.Participants.Add(new MeetingParticipant { TenantId = project.TenantId, ProjectId = projectId, Meeting = meeting, UserId = organizerId, Email = organizer.Email, Role = MeetingParticipantRole.Organizer, RsvpStatus = AttendeeRsvpStatus.Accepted, CreatedAt = clock.Now });
        foreach (var u in users.Where(u => u.Id != organizerId))
            meeting.Participants.Add(new MeetingParticipant { TenantId = project.TenantId, ProjectId = projectId, Meeting = meeting, UserId = u.Id, Email = u.Email, Role = MeetingParticipantRole.Attendee, RsvpStatus = AttendeeRsvpStatus.NeedsAction, CreatedAt = clock.Now });

        recorder.Activity("meeting.scheduled", "ProjectMeeting", meeting.Id, $"Scheduled \"{meetingTitle}\" on \"{project.Name}\"", projectId);
        recorder.Audit("meeting.scheduled", "ProjectMeeting", meeting.Id, newValue: new { meeting.Title, meeting.StartTimeUtc, meeting.EndTimeUtc, Participants = invitedIds.Count });
        foreach (var u in users.Where(u => u.Id != organizerId))
            await notifications.AddAsync(u.Id, NotificationType.Meeting, $"{organizer.DisplayName} scheduled a Google Meet", $"{meetingTitle} · {start:dd MMM} at {start:h:mm tt}", $"/projects/{projectId}?tab=meetings&meeting={meeting.Id}", ct: ct);

        await db.SaveChangesAsync(ct);

        var card = new MeetingCard(meeting.Id, meetingTitle, meeting.StartTimeUtc, meeting.EndTimeUtc, timeZone, created.MeetUri, meeting.Participants.Count, "Scheduled");
        await chat.PostMeetingCardAsync(projectId, card, $"📹 {organizer.DisplayName} scheduled a Google Meet: {meetingTitle}", ct);

        return ToDto(meeting, organizer.DisplayName);
    }

    // ---------------------------------------------------------------- reschedule

    /// <summary>Changes a meeting's time: updates the real Calendar event first (Google notifies attendees itself, sendUpdates=all), then
    /// reflects the new time locally. The Meet link, conference and attendee list are untouched.</summary>
    public async Task<MeetingDto> RescheduleAsync(Guid meetingId, RescheduleMeetingRequest req, CancellationToken ct = default)
    {
        if (req.EndTime <= req.StartTime) throw new ValidationException("endTime", "The meeting must end after it starts.");
        if (req.StartTime < DateTimeOffset.UtcNow.AddMinutes(-5)) throw new ValidationException("startTime", "Choose a time that has not already passed.");
        var meeting = await db.ProjectMeetings.Include(m => m.Participants).ThenInclude(p => p.User).Include(m => m.Organizer)
            .FirstOrDefaultAsync(m => m.Id == meetingId, ct) ?? throw new NotFoundException("Meeting not found.");
        await RequireOrganizerOrEditAsync(meeting, ct);
        if (meeting.Status != MeetingStatus.Scheduled) throw new ConflictException("Only a scheduled meeting can be rescheduled.", "MEETING_NOT_SCHEDULED");

        var oldStart = meeting.StartTimeUtc;
        try { await google.RescheduleEventAsync(meeting.OrganizerUserId, meeting.GoogleCalendarEventId, req.StartTime.UtcDateTime, req.EndTime.UtcDateTime, meeting.TimeZone, ct); }
        catch (GoogleApiException) { throw new ConflictException("We couldn't reschedule the Google Meet right now. Please try again.", "GOOGLE_MEET_RESCHEDULE_FAILED"); }

        meeting.StartTimeUtc = req.StartTime.UtcDateTime;
        meeting.EndTimeUtc = req.EndTime.UtcDateTime;
        recorder.Activity("meeting.rescheduled", "ProjectMeeting", meeting.Id, $"Rescheduled \"{meeting.Title}\" from {oldStart:g} to {meeting.StartTimeUtc:g}", meeting.ProjectId);
        recorder.Audit("meeting.rescheduled", "ProjectMeeting", meeting.Id, oldValue: new { StartTimeUtc = oldStart }, newValue: new { meeting.StartTimeUtc, meeting.EndTimeUtc });
        var actorName = await db.Users.AsNoTracking().Where(u => u.Id == ctx.UserId).Select(u => u.DisplayName).FirstOrDefaultAsync(ct) ?? "Someone";
        foreach (var p in meeting.Participants.Where(p => p.UserId != null && p.UserId != ctx.UserId))
            await notifications.AddAsync(p.UserId!.Value, NotificationType.Meeting, $"{actorName} rescheduled a Google Meet", $"{meeting.Title} · now {meeting.StartTimeUtc:dd MMM} at {meeting.StartTimeUtc:t} UTC", $"/projects/{meeting.ProjectId}?tab=meetings&meeting={meeting.Id}", ct: ct);
        await db.SaveChangesAsync(ct);

        var card = new MeetingCard(meeting.Id, meeting.Title, meeting.StartTimeUtc, meeting.EndTimeUtc, meeting.TimeZone, meeting.GoogleMeetUri, meeting.Participants.Count, "Scheduled");
        await chat.PostMeetingCardAsync(meeting.ProjectId, card, $"📹 {actorName} rescheduled the Google Meet: {meeting.Title}", ct);
        return ToDto(meeting, meeting.Organizer?.DisplayName ?? "");
    }

    // ---------------------------------------------------------------- participant management

    /// <summary>Adds one more person to a scheduled meeting - must already be able to see the project, same rule as at creation.</summary>
    public async Task<MeetingDto> AddParticipantAsync(Guid meetingId, AddMeetingParticipantRequest req, CancellationToken ct = default)
    {
        var meeting = await db.ProjectMeetings.Include(m => m.Participants).Include(m => m.Organizer)
            .FirstOrDefaultAsync(m => m.Id == meetingId, ct) ?? throw new NotFoundException("Meeting not found.");
        await RequireOrganizerOrEditAsync(meeting, ct);
        if (meeting.Status != MeetingStatus.Scheduled) throw new ConflictException("Only a scheduled meeting can have its participants changed.", "MEETING_NOT_SCHEDULED");
        if (meeting.Participants.Any(p => p.UserId == req.UserId)) throw new ConflictException("That person is already invited.", "ALREADY_INVITED");
        var project = await db.Projects.AsNoTracking().FirstAsync(p => p.Id == meeting.ProjectId, ct);
        if (!(await EligibleUserIdsAsync(project, ct)).Contains(req.UserId))
            throw new ValidationException("userId", "Only people who can already see this project may be invited.");
        var user = await db.Users.AsNoTracking().Where(u => u.Id == req.UserId).Select(u => new { u.Id, u.DisplayName, u.Email }).FirstOrDefaultAsync(ct)
            ?? throw new NotFoundException("That person was not found.");

        var attendees = meeting.Participants.Where(p => p.UserId != meeting.OrganizerUserId).Select(p => new GoogleMeetingAttendee(p.Email)).Append(new GoogleMeetingAttendee(user.Email)).ToList();
        try { await google.UpdateAttendeesAsync(meeting.OrganizerUserId, meeting.GoogleCalendarEventId, attendees, ct); }
        catch (GoogleApiException) { throw new ConflictException("We couldn't update the Google Meet's attendees right now. Please try again.", "GOOGLE_MEET_UPDATE_FAILED"); }

        // db.MeetingParticipants.Add (not meeting.Participants.Add): the meeting here was loaded from the database, not newly created, so it is
        // already tracked as Unchanged. Its Id (set by a property initializer, not the database) is never the CLR default, so EF cannot tell
        // from the key alone that this new row is new rather than possibly-already-existing when it is attached only through a collection
        // navigation on an existing parent - it gets marked Modified instead of Added, and the "UPDATE" that follows matches zero rows
        // (DbUpdateConcurrencyException). Adding straight to the DbSet makes the Added state explicit regardless of the key value.
        // Setting MeetingId explicitly (the FK), not the Meeting navigation, is deliberate: EF's relationship fixup then adds this entity to
        // meeting.Participants on its own because the FK matches an already-tracked principal - adding it there a second time by hand would
        // double it up in that in-memory list (and so in the MeetingDto returned below), even though only one row is ever actually inserted.
        var participant = new MeetingParticipant { TenantId = meeting.TenantId, ProjectId = meeting.ProjectId, MeetingId = meeting.Id, UserId = user.Id, Email = user.Email, Role = MeetingParticipantRole.Attendee, RsvpStatus = AttendeeRsvpStatus.NeedsAction, CreatedAt = clock.Now };
        db.MeetingParticipants.Add(participant);
        recorder.Activity("meeting.participant_added", "ProjectMeeting", meeting.Id, $"Added {user.DisplayName} to \"{meeting.Title}\"", meeting.ProjectId);
        recorder.Audit("meeting.participant_added", "ProjectMeeting", meeting.Id, newValue: new { user.Id, user.Email });
        await notifications.AddAsync(user.Id, NotificationType.Meeting, "You were added to a Google Meet", $"{meeting.Title} · {meeting.StartTimeUtc:dd MMM} at {meeting.StartTimeUtc:t} UTC", $"/projects/{meeting.ProjectId}?tab=meetings&meeting={meeting.Id}", ct: ct);
        await db.SaveChangesAsync(ct);
        return ToDto(meeting, meeting.Organizer?.DisplayName ?? "");
    }

    /// <summary>Removes a participant (never the organizer - cancel the meeting instead).</summary>
    public async Task<MeetingDto> RemoveParticipantAsync(Guid meetingId, Guid userId, CancellationToken ct = default)
    {
        var meeting = await db.ProjectMeetings.Include(m => m.Participants).Include(m => m.Organizer)
            .FirstOrDefaultAsync(m => m.Id == meetingId, ct) ?? throw new NotFoundException("Meeting not found.");
        await RequireOrganizerOrEditAsync(meeting, ct);
        if (meeting.Status != MeetingStatus.Scheduled) throw new ConflictException("Only a scheduled meeting can have its participants changed.", "MEETING_NOT_SCHEDULED");
        if (userId == meeting.OrganizerUserId) throw new ConflictException("The organizer cannot be removed. Cancel the meeting instead.", "ORGANIZER_REQUIRED");
        var row = meeting.Participants.FirstOrDefault(p => p.UserId == userId) ?? throw new NotFoundException("That person is not on this meeting.");

        var attendees = meeting.Participants.Where(p => p.UserId != meeting.OrganizerUserId && p.UserId != userId).Select(p => new GoogleMeetingAttendee(p.Email)).ToList();
        try { await google.UpdateAttendeesAsync(meeting.OrganizerUserId, meeting.GoogleCalendarEventId, attendees, ct); }
        catch (GoogleApiException) { throw new ConflictException("We couldn't update the Google Meet's attendees right now. Please try again.", "GOOGLE_MEET_UPDATE_FAILED"); }

        db.MeetingParticipants.Remove(row);
        meeting.Participants.Remove(row);   // also drop it from the in-memory collection, so the DTO returned below does not still list them
        recorder.Activity("meeting.participant_removed", "ProjectMeeting", meeting.Id, $"Removed {row.User?.DisplayName ?? row.Email} from \"{meeting.Title}\"", meeting.ProjectId);
        recorder.Audit("meeting.participant_removed", "ProjectMeeting", meeting.Id, oldValue: new { UserId = userId, row.Email });
        await db.SaveChangesAsync(ct);
        return ToDto(meeting, meeting.Organizer?.DisplayName ?? "");
    }

    private async Task RequireOrganizerOrEditAsync(ProjectMeeting meeting, CancellationToken ct)
    {
        if (meeting.OrganizerUserId != ctx.UserId && !await permissions.HasAsync(Permissions.ProjectsEdit, ct))
            throw new ForbiddenException("Only the organizer can change this meeting.", "PERMISSION_DENIED");
    }

    // ---------------------------------------------------------------- read

    public async Task<IReadOnlyList<MeetingDto>> ListAsync(Guid projectId, CancellationToken ct = default)
    {
        await access.GetProjectAsync(projectId, ct); // 404 if not visible, same as every other project-scoped read
        var meetings = await db.ProjectMeetings.Where(m => m.ProjectId == projectId)
            .Include(m => m.Participants).ThenInclude(p => p.User).Include(m => m.Organizer).OrderByDescending(m => m.StartTimeUtc).ToListAsync(ct);
        foreach (var m in meetings.Where(m => m.Status == MeetingStatus.Scheduled)) await SyncRsvpAsync(m, ct);
        await db.SaveChangesAsync(ct);
        return meetings.Select(m => ToDto(m, m.Organizer?.DisplayName ?? "")).ToList();
    }

    public async Task<MeetingDto> GetAsync(Guid meetingId, CancellationToken ct = default)
    {
        var meeting = await db.ProjectMeetings.Include(m => m.Participants).ThenInclude(p => p.User).Include(m => m.Organizer)
            .FirstOrDefaultAsync(m => m.Id == meetingId, ct) ?? throw new NotFoundException("Meeting not found.");
        if (meeting.Status == MeetingStatus.Scheduled) { await SyncRsvpAsync(meeting, ct); await db.SaveChangesAsync(ct); }
        return ToDto(meeting, meeting.Organizer?.DisplayName ?? "");
    }

    /// <summary>
    /// Pulls each attendee's real response off the Calendar event and reflects it locally - the only source of RSVP state (spec section 11).
    /// Best-effort and silent: a meeting list must still render if Google is briefly unreachable or the organizer's grant has expired, so
    /// this never throws - it just leaves the RSVP state as it last knew it and tries again next read.
    /// </summary>
    private async Task SyncRsvpAsync(ProjectMeeting meeting, CancellationToken ct)
    {
        IReadOnlyList<GoogleAttendeeStatus> statuses;
        try { statuses = await google.GetAttendeeStatusAsync(meeting.OrganizerUserId, meeting.GoogleCalendarEventId, ct); }
        catch { return; }
        if (statuses.Count == 0) return;
        var byEmail = statuses.ToDictionary(s => s.Email, s => s.ResponseStatus, StringComparer.OrdinalIgnoreCase);
        foreach (var p in meeting.Participants)
        {
            if (p.Role == MeetingParticipantRole.Organizer || !byEmail.TryGetValue(p.Email, out var status)) continue;
            var mapped = status switch { "accepted" => AttendeeRsvpStatus.Accepted, "declined" => AttendeeRsvpStatus.Declined, "tentative" => AttendeeRsvpStatus.Tentative, _ => AttendeeRsvpStatus.NeedsAction };
            if (p.RsvpStatus != mapped) p.RsvpStatus = mapped;
        }
    }

    // ---------------------------------------------------------------- cancel

    public async Task CancelAsync(Guid meetingId, CancellationToken ct = default)
    {
        var meeting = await db.ProjectMeetings.FirstOrDefaultAsync(m => m.Id == meetingId, ct) ?? throw new NotFoundException("Meeting not found.");
        await RequireOrganizerOrEditAsync(meeting, ct);
        if (meeting.Status == MeetingStatus.Cancelled) return;

        try { await google.CancelEventAsync(meeting.OrganizerUserId, meeting.GoogleCalendarEventId, ct); }
        catch (GoogleApiException) { throw new ConflictException("We couldn't cancel the Google Meet right now. Please try again.", "GOOGLE_MEET_CANCEL_FAILED"); }

        meeting.Status = MeetingStatus.Cancelled;
        meeting.CancelledAt = clock.Now;
        recorder.Activity("meeting.cancelled", "ProjectMeeting", meeting.Id, $"Cancelled \"{meeting.Title}\"", meeting.ProjectId);
        recorder.Audit("meeting.cancelled", "ProjectMeeting", meeting.Id);
        var participantCount = await db.MeetingParticipants.AsNoTracking().CountAsync(p => p.MeetingId == meeting.Id, ct);
        var participants = await db.MeetingParticipants.AsNoTracking().Where(p => p.MeetingId == meeting.Id && p.UserId != null && p.UserId != meeting.OrganizerUserId).Select(p => p.UserId!.Value).ToListAsync(ct);
        foreach (var userId in participants)
            await notifications.AddAsync(userId, NotificationType.Meeting, "A Google Meet was cancelled", meeting.Title, $"/projects/{meeting.ProjectId}?tab=meetings", ct: ct);
        await db.SaveChangesAsync(ct);

        var byName = await db.Users.AsNoTracking().Where(u => u.Id == ctx.UserId).Select(u => u.DisplayName).FirstOrDefaultAsync(ct) ?? "Someone";
        var card = new MeetingCard(meeting.Id, meeting.Title, meeting.StartTimeUtc, meeting.EndTimeUtc, meeting.TimeZone, meeting.GoogleMeetUri, participantCount, "Cancelled");
        await chat.PostMeetingCardAsync(meeting.ProjectId, card, $"📹 {byName} cancelled the Google Meet: {meeting.Title}", ct);
    }

    private static MeetingDto ToDto(ProjectMeeting m, string organizerName) => new(m.Id, m.ProjectId, m.Title, m.Description,
        new DateTimeOffset(m.StartTimeUtc, TimeSpan.Zero), new DateTimeOffset(m.EndTimeUtc, TimeSpan.Zero), m.TimeZone, m.Status.ToString(), m.GoogleMeetUri,
        m.OrganizerUserId, organizerName, m.Participants.Select(p => new MeetingParticipantDto(p.UserId, p.User?.DisplayName ?? p.Email, p.Email, p.Role.ToString(), p.RsvpStatus.ToString())).ToList());
}
