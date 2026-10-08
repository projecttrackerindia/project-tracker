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

    // ---------------------------------------------------------------- read

    public async Task<IReadOnlyList<MeetingDto>> ListAsync(Guid projectId, CancellationToken ct = default)
    {
        await access.GetProjectAsync(projectId, ct); // 404 if not visible, same as every other project-scoped read
        var meetings = await db.ProjectMeetings.AsNoTracking().Where(m => m.ProjectId == projectId)
            .Include(m => m.Participants).Include(m => m.Organizer).OrderByDescending(m => m.StartTimeUtc).ToListAsync(ct);
        return meetings.Select(m => ToDto(m, m.Organizer?.DisplayName ?? "")).ToList();
    }

    public async Task<MeetingDto> GetAsync(Guid meetingId, CancellationToken ct = default)
    {
        var meeting = await db.ProjectMeetings.AsNoTracking().Include(m => m.Participants).Include(m => m.Organizer)
            .FirstOrDefaultAsync(m => m.Id == meetingId, ct) ?? throw new NotFoundException("Meeting not found.");
        return ToDto(meeting, meeting.Organizer?.DisplayName ?? "");
    }

    // ---------------------------------------------------------------- cancel

    public async Task CancelAsync(Guid meetingId, CancellationToken ct = default)
    {
        var meeting = await db.ProjectMeetings.FirstOrDefaultAsync(m => m.Id == meetingId, ct) ?? throw new NotFoundException("Meeting not found.");
        if (meeting.OrganizerUserId != ctx.UserId && !await permissions.HasAsync(Permissions.ProjectsEdit, ct))
            throw new ForbiddenException("Only the organizer can cancel this meeting.", "PERMISSION_DENIED");
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
