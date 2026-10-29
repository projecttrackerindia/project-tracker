using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
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
/// <param name="Provider">Where it lives: "google" (Google Meet), "microsoft" (Teams) or "ours" (a Project Tracker call); <paramref name="ProviderName"/> says it in words.</param>
public record MeetingDto(Guid Id, Guid ProjectId, string Title, string? Description, DateTimeOffset StartTime, DateTimeOffset EndTime, string TimeZone,
    string Status, string MeetUri, Guid OrganizerUserId, string OrganizerName, IReadOnlyList<MeetingParticipantDto> Participants, string? RecurrenceRule = null, string? CalendarUrl = null,
    bool IsScrum = false, string Provider = "google", string ProviderName = "Google Meet", string Notetaker = "off");

/// <summary>Start Meeting: participants default to everyone who can see the project (spec section 2) unless the organizer names a specific list.</summary>
/// <param name="Service">"auto" (default: the organizer's choice, else Google, Microsoft, our own call), "google", "microsoft" or "ours".</param>
/// <param name="Notetaker">"off", "transcript", "voice" (transcript, and it speaks up when something is being missed), or empty (the project agent's settings decide).</param>
public record StartMeetingRequest(string? Title, IReadOnlyList<Guid>? ParticipantUserIds, string? Service = null, string? Notetaker = null);
/// <summary>Schedule Meeting: the organizer always names start/end explicitly, in a real instant (not a bare local time) so no timezone is guessed.</summary>
/// <param name="TeamIds">Whole teams invited: their members are added as people when it is scheduled (for a project, those who can see it).</param>
/// <param name="Video">How people join: "inapp" (a Project Tracker call), "teams", "meet", "zoho" (with <paramref name="VideoUrl"/> pasted, or Teams / Meet
/// from the organizer's connected calendar) or "none". Empty keeps <paramref name="Service"/> deciding, as before.</param>
public record ScheduleMeetingRequest(string Title, string? Description, DateTimeOffset StartTime, DateTimeOffset EndTime, string TimeZone, IReadOnlyList<Guid>? ParticipantUserIds, MeetingRepeat? Repeat = null,
    bool Scrum = false, string? Service = null, string? Notetaker = null, IReadOnlyList<Guid>? TeamIds = null, string? Video = null, string? VideoUrl = null);
public record RescheduleMeetingRequest(DateTimeOffset StartTime, DateTimeOffset EndTime);
/// <summary>One session (<paramref name="OccurrenceStart"/>, where the rule puts it) changed: Scope "this", "following" or "all"; a new time, a new title, or cancelled.</summary>
public record ChangeOccurrenceRequest(DateTimeOffset OccurrenceStart, string? Scope, DateTimeOffset? StartTime = null, DateTimeOffset? EndTime = null, string? Title = null, bool Cancel = false);
/// <summary>What changed; <paramref name="NewSeriesRef"/> is the series that carries on after a "this and following" change.</summary>
public record OccurrenceChangeResultDto(string Scope, string Ref, DateTimeOffset? Start, DateTimeOffset? End, string? NewSeriesRef);
/// <summary>A meeting's title and agenda (the description), edited from the calendar. Only meetings held by Project Tracker itself: a Google or
/// Outlook event is edited in that calendar, so the invitation people have never says something else.</summary>
public record UpdateMeetingDetailsRequest(string Title, string? Description);
public record AddMeetingParticipantRequest(Guid UserId);
/// <summary>A reply to an invitation to a Project Tracker call: "accepted", "tentative" or "declined".</summary>
public record MeetingRsvpRequest(string Response);
/// <summary>A meeting scheduled for the workspace as a whole (a team stand-up that belongs to no one project). Google Calendar holds it;
/// Project Tracker keeps no project row for it, so this is just what the organizer needs right after creating it.</summary>
public record WorkspaceMeetingDto(Guid Id, string Title, string MeetUri, string? CalendarUrl, DateTimeOffset StartTime, DateTimeOffset EndTime, string TimeZone, string? RecurrenceRule, int ParticipantCount,
    string Provider = "google", string ProviderName = "Google Meet");
/// <summary>One workspace meeting as its attendees see it on the Calendar; <c>CanManage</c> = the organizer, or an Owner/Admin of the workspace.</summary>
public record WorkspaceMeetingDetailDto(Guid Id, string Title, string? Description, DateTimeOffset StartTime, DateTimeOffset EndTime, string TimeZone, string Status,
    string MeetUri, string? CalendarUrl, string? RecurrenceRule, bool IsScrum, Guid OrganizerUserId, string OrganizerName, bool CanManage, IReadOnlyList<MeetingParticipantDto> Attendees,
    string Provider = "google", string ProviderName = "Google Meet");

/// <summary>
/// Meetings scoped to a project. Each lives in one service (<see cref="MeetingCalendar"/>): the organizer's Google Calendar with a Meet link,
/// their Outlook calendar with a Teams meeting, or - with no calendar connected, or by choice - our own call, which the project agent joins.
/// For Google and Outlook, every write here is really a write to the organizer's own calendar event (they send the invitations and keep the
/// RSVPs); what is stored locally is a reflection of that event for the project's own UI, chat and reports.
/// Participants are always restricted to people who can already see the project - never the whole tenant - the same rule
/// <see cref="ProjectAccess"/> already enforces for everything else project-scoped (spec section 6).
/// </summary>
public class MeetingService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, ProjectAccess access,
    PermissionService permissions, NotificationService notifications, MeetingCalendar calendar, ChatService chat, MeetNotetaker notetaker, ILogger<MeetingService> log)
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
        return CreateAsync(projectId, req.Title, null, start, start.AddMinutes(DefaultStartNowMinutes), "UTC", req.ParticipantUserIds, ct, service: req.Service,
            notetakerChoice: MeetNotetaker.Parse(req.Notetaker));
    }

    /// <summary>"Schedule Google Meet": the organizer's own title, time and attendee list.</summary>
    public async Task<MeetingDto> ScheduleAsync(Guid projectId, ScheduleMeetingRequest req, CancellationToken ct = default, Guid? seriesRootId = null)
    {
        if (req.EndTime <= req.StartTime) throw new ValidationException("endTime", "The meeting must end after it starts.");
        if (req.StartTime < DateTimeOffset.UtcNow.AddMinutes(-5)) throw new ValidationException("startTime", "Choose a time that has not already passed.");
        var video = Video(req.Video, req.VideoUrl, req.Service);
        var people = req.ParticipantUserIds;
        var teams = CleanTeams(req.TeamIds);
        if (teams.Count > 0)
        {
            // A team is its members, at the moment it is scheduled: the ones who can see the project are invited (the rest could not open it).
            var project = await access.GetProjectAsync(projectId, ct);
            var eligible = await EligibleUserIdsAsync(project, ct);
            var members = await TeamMemberIdsAsync(teams, ct);
            people = (people ?? []).Concat(members.Where(eligible.Contains)).Where(id => id != ctx.UserId).Distinct().ToList();
        }
        return await CreateAsync(projectId, req.Title, req.Description, req.StartTime, req.EndTime, req.TimeZone, people, ct, MeetingRecurrence.Rule(req.Repeat, req.StartTime, req.TimeZone), req.Scrum, video.Service,
            MeetNotetaker.Parse(req.Notetaker), video.Kind, video.Link, teams.Count > 0 ? string.Join(",", teams) : null, seriesRootId);
    }

    /// <summary>The teams named, each once, at most 20.</summary>
    private static List<Guid> CleanTeams(IReadOnlyList<Guid>? ids)
    {
        var list = (ids ?? []).Where(i => i != Guid.Empty).Distinct().ToList();
        if (list.Count > 20) throw new ValidationException("teamIds", "Invite at most 20 teams at once.");
        return list;
    }

    private async Task<List<Guid>> TeamMemberIdsAsync(List<Guid> teams, CancellationToken ct)
    {
        var known = await db.Teams.AsNoTracking().Where(t => teams.Contains(t.Id)).Select(t => t.Id).ToListAsync(ct);
        if (known.Count != teams.Count) throw new ValidationException("teamIds", "One of those teams does not exist in this workspace.");
        return await db.TeamMembers.AsNoTracking().Where(m => teams.Contains(m.TeamId)).Select(m => m.UserId).Distinct().ToListAsync(ct);
    }

    /// <summary>
    /// How people join, from the schedule form's Video choice: In-app is our own call; Teams and Meet use the organizer's connected calendar,
    /// or the address they pasted (then our own call holds the meeting and the pasted address is the join link); Zoho needs the address; None has no link.
    /// </summary>
    private static (string? Service, string? Kind, string? Link) Video(string? video, string? url, string? service)
    {
        var kind = video?.Trim().ToLowerInvariant();
        if (string.IsNullOrEmpty(kind)) return (service, null, null);
        var link = url?.Trim();
        if (!string.IsNullOrEmpty(link))
        {
            if (link.Length > 500 || !Uri.TryCreate(link, UriKind.Absolute, out var u) || u.Scheme != Uri.UriSchemeHttps)
                throw new ValidationException("videoUrl", "Paste the meeting's full https:// link.");
        }
        else link = null;
        return kind switch
        {
            "inapp" => ("ours", "inapp", null),
            "teams" => link is null ? ("microsoft", "teams", null) : ("ours", "teams", link),
            "meet" => link is null ? ("google", "meet", null) : ("ours", "meet", link),
            "zoho" => link is null ? throw new ValidationException("videoUrl", "Paste the Zoho Meeting link people join with.") : ("ours", "zoho", link),
            "none" => ("ours", "none", null),
            _ => throw new ValidationException("video", "Choose In-app, Teams, Meet, Zoho or None."),
        };
    }

    private async Task<MeetingDto> CreateAsync(Guid projectId, string? title, string? description, DateTimeOffset start, DateTimeOffset end, string timeZone,
        IReadOnlyList<Guid>? requestedParticipants, CancellationToken ct, string? recurrenceRule = null, bool scrum = false, string? service = null,
        MeetingNotetaker notetakerChoice = MeetingNotetaker.ProjectDefault, string? videoKind = null, string? videoLink = null, string? teamIds = null, Guid? seriesRootId = null)
    {
        var project = await access.GetProjectAsync(projectId, ct);
        // Checked before anything reaches a calendar: a notetaker that cannot come must not leave an invitation behind that promises one.
        await notetaker.RequireAsync(projectId, notetakerChoice, ct);
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
        var choice = await calendar.ChooseAsync(organizerId, service, ct);
        var provider = MeetingCalendar.ToProvider(choice.Provider);
        var meetingId = Guid.CreateVersion7();
        CreatedGoogleMeeting created;
        try { created = await calendar.CreateAsync(provider, meetingId, false, organizerId, meetingTitle, description, start.UtcDateTime, end.UtcDateTime, timeZone, attendees, ct, recurrenceRule); }
        catch (MeetingCalendarException ex) { throw MeetingCalendar.Failed(ex); }
        var what = MeetingCalendar.Name(provider);

        var meeting = new ProjectMeeting
        {
            Id = meetingId, Provider = provider,
            TenantId = project.TenantId, ProjectId = projectId, OrganizerUserId = organizerId, Title = meetingTitle, Description = description,
            StartTimeUtc = start.UtcDateTime, EndTimeUtc = end.UtcDateTime, TimeZone = timeZone, Status = MeetingStatus.Scheduled,
            GoogleCalendarEventId = created.EventId, GoogleMeetSpaceName = created.MeetSpaceName, GoogleMeetUri = created.MeetUri, RecurrenceRule = recurrenceRule, CalendarUrl = created.HtmlLink,
            IsScrum = scrum, Notetaker = notetakerChoice, CreatedAt = clock.Now, CreatedBy = organizerId,
            VideoKind = videoKind, VideoLink = videoLink, AttendeeTeamIds = teamIds, SeriesRootId = seriesRootId,
        };
        db.ProjectMeetings.Add(meeting);
        meeting.Participants.Add(new MeetingParticipant { TenantId = project.TenantId, ProjectId = projectId, Meeting = meeting, UserId = organizerId, Email = organizer.Email, Role = MeetingParticipantRole.Organizer, RsvpStatus = AttendeeRsvpStatus.Accepted, CreatedAt = clock.Now });
        foreach (var u in users.Where(u => u.Id != organizerId))
            meeting.Participants.Add(new MeetingParticipant { TenantId = project.TenantId, ProjectId = projectId, Meeting = meeting, UserId = u.Id, Email = u.Email, Role = MeetingParticipantRole.Attendee, RsvpStatus = AttendeeRsvpStatus.NeedsAction, CreatedAt = clock.Now });

        recorder.Activity("meeting.scheduled", "ProjectMeeting", meeting.Id, $"Scheduled \"{meetingTitle}\" on \"{project.Name}\"", projectId);
        recorder.Audit("meeting.scheduled", "ProjectMeeting", meeting.Id, newValue: new { meeting.Title, meeting.StartTimeUtc, meeting.EndTimeUtc, Participants = invitedIds.Count, Notetaker = MeetNotetaker.Key(notetakerChoice) });
        var whenText = InZone(start, ProjectManagement.Application.Features.Reminders.ZoneTime.IsKnown(timeZone) ? timeZone : "UTC");
        foreach (var u in users.Where(u => u.Id != organizerId))
            await notifications.AddAsync(u.Id, NotificationType.Meeting, $"{organizer.DisplayName} invited you to a {what}", $"{meetingTitle} · {whenText}{InvitationHint(provider)}", MeetingReminders.MeetLink(meeting.Id, false), ct: ct);

        await db.SaveChangesAsync(ct);
        await MeetingReminders.PlanAsync(db, clock.Now, ct, meeting.Id);

        var card = new MeetingCard(meeting.Id, meetingTitle, meeting.StartTimeUtc, meeting.EndTimeUtc, timeZone, created.MeetUri, meeting.Participants.Count, "Scheduled");
        await chat.PostMeetingCardAsync(projectId, card, $"📹 {organizer.DisplayName} scheduled a {what}: {meetingTitle}", ct);

        return ToDto(meeting, organizer.DisplayName);
    }

    // ---------------------------------------------------------------- workspace meetings (no project)

    /// <summary>Who a workspace-level meeting (no project) may invite: the workspace's active members, guests excluded - a guest only ever sees
    /// the projects they were invited to, so a "whole workspace" picker must not offer (or reveal) them.</summary>
    public async Task<IReadOnlyList<MeetingParticipantDto>> WorkspaceParticipantsAsync(CancellationToken ct = default)
    {
        RequireNotGuest();
        var tid = ctx.RequireTenantId();
        var rows = await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid && m.Role != TenantRole.Guest && m.User!.IsActive)
            .OrderBy(m => m.User!.DisplayName).Select(m => new { m.UserId, m.User!.DisplayName, m.User.Email, m.Role }).ToListAsync(ct);
        return rows.Select(u => new MeetingParticipantDto(u.UserId, u.DisplayName, u.Email, u.Role.ToString(), "NeedsAction")).ToList();
    }

    /// <summary>
    /// "Schedule a scrum call" without choosing a project: the same Google Calendar + Meet event as a project meeting, but the attendees are
    /// picked from the workspace's members and nothing is posted to a project's chat or meeting list (there is none). Everyone invited still
    /// gets the Calendar invitation from Google and an in-app notification.
    /// </summary>
    public async Task<WorkspaceMeetingDto> ScheduleForWorkspaceAsync(ScheduleMeetingRequest req, CancellationToken ct = default, Guid? seriesRootId = null, string? ruleOverride = null)
    {
        RequireNotGuest();
        if (string.IsNullOrWhiteSpace(req.Title)) throw new ValidationException("title", "Give the meeting a title.");
        if (req.Title.Trim().Length > 200) throw new ValidationException("title", ProjectManagement.Application.Common.TextLimits.TooLong(200, req.Title.Trim().Length));
        if (req.Description is { Length: > 4000 }) throw new ValidationException("description", "Keep the agenda to 4,000 characters.");
        if (req.EndTime <= req.StartTime) throw new ValidationException("endTime", "The meeting must end after it starts.");
        if (req.StartTime < DateTimeOffset.UtcNow.AddMinutes(-5)) throw new ValidationException("startTime", "Choose a time that has not already passed.");
        // Checked before anything reaches Google: an unknown or missing zone must never leave an invitation sent with nothing recorded here.
        if (!ProjectManagement.Application.Features.Reminders.ZoneTime.IsKnown(req.TimeZone)) throw new ValidationException("timeZone", "Choose a valid time zone for the meeting.");
        if (MeetNotetaker.Wanted(MeetNotetaker.Parse(req.Notetaker)))
            throw new ValidationException("notetaker", "Choose a project to bring the notetaker: it keeps the notes and follow-ups in that project.");
        var tid = ctx.RequireTenantId();
        var organizerId = ctx.RequireUserId();
        var video = Video(req.Video, req.VideoUrl, req.Service);
        var teams = CleanTeams(req.TeamIds);
        var invitedIds = (req.ParticipantUserIds ?? []).Concat(teams.Count > 0 ? await TeamMemberIdsAsync(teams, ct) : new List<Guid>()).Where(id => id != organizerId).Distinct().ToList();
        var members = await db.TenantMembers.AsNoTracking()
            .Where(m => m.TenantId == tid && m.Role != TenantRole.Guest && m.User!.IsActive && (invitedIds.Contains(m.UserId) || m.UserId == organizerId))
            .Select(m => new { m.UserId, m.User!.DisplayName, m.User.Email }).ToListAsync(ct);
        if (invitedIds.Any(id => members.All(m => m.UserId != id)))
            throw new ValidationException("participantUserIds", "Only active members of this workspace may be invited.");
        var organizer = members.FirstOrDefault(m => m.UserId == organizerId) ?? throw new ForbiddenException("Only workspace members can schedule meetings.", "PERMISSION_DENIED");
        var attendees = members.Where(m => m.UserId != organizerId).ToList();

        var title = req.Title.Trim();
        var rule = ruleOverride ?? MeetingRecurrence.Rule(req.Repeat, req.StartTime, req.TimeZone);
        var choice = await calendar.ChooseAsync(organizerId, video.Service, ct);
        var provider = MeetingCalendar.ToProvider(choice.Provider);
        var meetingId = Guid.CreateVersion7();
        CreatedGoogleMeeting created;
        try { created = await calendar.CreateAsync(provider, meetingId, true, organizerId, title, req.Description, req.StartTime.UtcDateTime, req.EndTime.UtcDateTime, req.TimeZone, attendees.Select(a => new GoogleMeetingAttendee(a.Email)).ToList(), ct, rule); }
        catch (MeetingCalendarException ex) { throw MeetingCalendar.Failed(ex); }
        var what = MeetingCalendar.Name(provider);

        var meeting = new WorkspaceMeeting
        {
            Id = meetingId, Provider = provider,
            TenantId = tid, OrganizerUserId = organizerId, Title = title, Description = req.Description, StartTimeUtc = req.StartTime.UtcDateTime, EndTimeUtc = req.EndTime.UtcDateTime,
            TimeZone = req.TimeZone, RecurrenceRule = rule, CalendarUrl = string.IsNullOrEmpty(created.HtmlLink) ? null : created.HtmlLink, Status = MeetingStatus.Scheduled,
            GoogleCalendarEventId = created.EventId, GoogleMeetUri = created.MeetUri, IsScrum = req.Scrum, CreatedAt = clock.Now, CreatedBy = organizerId,
            VideoKind = video.Kind, VideoLink = video.Link, AttendeeTeamIds = teams.Count > 0 ? string.Join(",", teams) : null, SeriesRootId = seriesRootId,
        };
        db.WorkspaceMeetings.Add(meeting);
        foreach (var m in members)
            db.WorkspaceMeetingAttendees.Add(new WorkspaceMeetingAttendee { TenantId = tid, MeetingId = meeting.Id, UserId = m.UserId, Email = m.Email, IsOrganizer = m.UserId == organizerId,
                RsvpStatus = m.UserId == organizerId ? AttendeeRsvpStatus.Accepted : AttendeeRsvpStatus.NeedsAction, CreatedAt = clock.Now });
        recorder.Audit("meeting.scheduled", "WorkspaceMeeting", meeting.Id, newValue: new { Title = title, StartTimeUtc = req.StartTime.UtcDateTime, EndTimeUtc = req.EndTime.UtcDateTime, Participants = attendees.Count, Recurrence = rule, created.EventId });
        var when = InZone(req.StartTime, req.TimeZone);
        foreach (var a in attendees)
            await notifications.AddAsync(a.UserId, NotificationType.Meeting, $"{organizer.DisplayName} invited you to a {what}", $"{title} · {when}{InvitationHint(provider)}", MeetingReminders.MeetLink(meeting.Id, true), ct: ct);
        await db.SaveChangesAsync(ct);
        await MeetingReminders.PlanAsync(db, clock.Now, ct, meeting.Id);
        return new WorkspaceMeetingDto(meeting.Id, title, created.MeetUri, meeting.CalendarUrl, req.StartTime, req.EndTime, req.TimeZone, rule, attendees.Count + 1, MeetingCalendar.Key(provider), what);
    }

    /// <summary>A workspace meeting, for someone invited to it (or an Owner/Admin of the workspace); anyone else gets "not found".</summary>
    public async Task<WorkspaceMeetingDetailDto> GetWorkspaceMeetingAsync(Guid id, CancellationToken ct = default)
    {
        var meeting = await LoadWorkspaceMeetingAsync(id, ct);
        var organizer = await db.Users.AsNoTracking().Where(u => u.Id == meeting.OrganizerUserId).Select(u => u.DisplayName).FirstOrDefaultAsync(ct) ?? "";
        var people = await db.WorkspaceMeetingAttendees.AsNoTracking().Where(a => a.MeetingId == id).OrderByDescending(a => a.IsOrganizer)
            .Select(a => new { a.UserId, a.User!.DisplayName, a.Email, a.IsOrganizer, a.RsvpStatus }).ToListAsync(ct);
        var hideEmail = ctx.Role == TenantRole.Guest;
        return new WorkspaceMeetingDetailDto(meeting.Id, meeting.Title, meeting.Description, new DateTimeOffset(meeting.StartTimeUtc, TimeSpan.Zero), new DateTimeOffset(meeting.EndTimeUtc, TimeSpan.Zero),
            meeting.TimeZone, meeting.Status.ToString(), meeting.GoogleMeetUri, meeting.CalendarUrl, meeting.RecurrenceRule, meeting.IsScrum, meeting.OrganizerUserId, organizer, CanManage(meeting),
            people.Select(p => new MeetingParticipantDto(p.UserId, p.DisplayName, hideEmail ? "" : p.Email, p.IsOrganizer ? "Organizer" : "Attendee", p.IsOrganizer ? "Accepted" : p.RsvpStatus.ToString())).ToList(),
            MeetingCalendar.Key(meeting.Provider), MeetingCalendar.Name(meeting.Provider));
    }

    /// <summary>Cancels the real Calendar event (Google tells the invitees) and marks it cancelled here; the organizer or an Owner/Admin only.</summary>
    public async Task CancelWorkspaceMeetingAsync(Guid id, CancellationToken ct = default)
    {
        var meeting = await LoadWorkspaceMeetingAsync(id, ct);
        if (!CanManage(meeting)) throw new ForbiddenException("Only the organizer can change this meeting.", "PERMISSION_DENIED");
        if (meeting.Status == MeetingStatus.Cancelled) return;
        try { await calendar.CancelAsync(meeting.Provider, meeting.OrganizerUserId, meeting.GoogleCalendarEventId, ct); }
        catch (MeetingCalendarException ex) { throw MeetingCalendar.Failed(ex); }
        meeting.Status = MeetingStatus.Cancelled;
        meeting.CancelledAt = clock.Now;
        recorder.Audit("meeting.cancelled", "WorkspaceMeeting", meeting.Id);
        foreach (var userId in await db.WorkspaceMeetingAttendees.AsNoTracking().Where(a => a.MeetingId == id && !a.IsOrganizer).Select(a => a.UserId).ToListAsync(ct))
            await notifications.AddAsync(userId, NotificationType.Meeting, $"A {MeetingCalendar.Name(meeting.Provider)} was cancelled", meeting.Title, "/meet", ct: ct);
        await db.SaveChangesAsync(ct);
        await MeetingReminders.PlanAsync(db, clock.Now, ct, meeting.Id);
    }

    /// <summary>Moves a one-off workspace meeting (a series is changed in Google Calendar, same rule as project meetings).</summary>
    public async Task<WorkspaceMeetingDetailDto> RescheduleWorkspaceMeetingAsync(Guid id, RescheduleMeetingRequest req, CancellationToken ct = default)
    {
        if (req.EndTime <= req.StartTime) throw new ValidationException("endTime", "The meeting must end after it starts.");
        if (req.StartTime < DateTimeOffset.UtcNow.AddMinutes(-5)) throw new ValidationException("startTime", "Choose a time that has not already passed.");
        var meeting = await LoadWorkspaceMeetingAsync(id, ct);
        if (!CanManage(meeting)) throw new ForbiddenException("Only the organizer can change this meeting.", "PERMISSION_DENIED");
        if (meeting.Status != MeetingStatus.Scheduled) throw new ConflictException("Only a scheduled meeting can be rescheduled.", "MEETING_NOT_SCHEDULED");
        if (meeting.RecurrenceRule is not null && meeting.Provider != MeetingProvider.ProjectTracker) throw SeriesInCalendar(meeting.Provider);
        try { await calendar.RescheduleAsync(meeting.Provider, meeting.OrganizerUserId, meeting.GoogleCalendarEventId, req.StartTime.UtcDateTime, req.EndTime.UtcDateTime, meeting.TimeZone, ct); }
        catch (MeetingCalendarException ex) { throw MeetingCalendar.Failed(ex); }
        var oldStart = meeting.StartTimeUtc;
        meeting.StartTimeUtc = req.StartTime.UtcDateTime;
        meeting.EndTimeUtc = req.EndTime.UtcDateTime;
        recorder.Audit("meeting.rescheduled", "WorkspaceMeeting", meeting.Id, oldValue: new { StartTimeUtc = oldStart }, newValue: new { meeting.StartTimeUtc, meeting.EndTimeUtc });
        var when = InZone(req.StartTime, meeting.TimeZone);
        foreach (var userId in await db.WorkspaceMeetingAttendees.AsNoTracking().Where(a => a.MeetingId == id && !a.IsOrganizer).Select(a => a.UserId).ToListAsync(ct))
            await notifications.AddAsync(userId, NotificationType.Meeting, $"A {MeetingCalendar.Name(meeting.Provider)} was moved", $"{meeting.Title} · now {when}", MeetingReminders.MeetLink(meeting.Id, true), ct: ct);
        await db.SaveChangesAsync(ct);
        await MeetingReminders.PlanAsync(db, clock.Now, ct, meeting.Id);
        return await GetWorkspaceMeetingAsync(id, ct);
    }

    private bool CanManage(WorkspaceMeeting m) => m.OrganizerUserId == ctx.UserId || ctx.Role is TenantRole.Owner or TenantRole.Admin;

    /// <summary>A series in Google or Outlook is changed there (one occurrence or the whole series), never half here.</summary>
    private static ConflictException SeriesInCalendar(MeetingProvider p) =>
        new($"Open this series in {(p == MeetingProvider.Microsoft ? "Outlook" : "Google Calendar")} to move one occurrence or change the series schedule.", "RECURRING_MEETING_EDIT_IN_CALENDAR");

    /// <summary>Where the invitation is, for the notification: the calendar it was sent from, or nowhere (our own calls are joined here).</summary>
    private static string InvitationHint(MeetingProvider p) => p switch
    {
        MeetingProvider.Microsoft => " — the invitation is in your Outlook calendar",
        MeetingProvider.ProjectTracker => " — join it from Project Tracker",
        _ => " — the invitation is in your Google Calendar",
    };

    private async Task<WorkspaceMeeting> LoadWorkspaceMeetingAsync(Guid id, CancellationToken ct)
    {
        var me = ctx.RequireUserId();
        var meeting = await db.WorkspaceMeetings.FirstOrDefaultAsync(m => m.Id == id, ct) ?? throw new NotFoundException("Meeting not found.");
        var invited = await db.WorkspaceMeetingAttendees.AnyAsync(a => a.MeetingId == id && a.UserId == me, ct);
        if (!invited && ctx.Role is not (TenantRole.Owner or TenantRole.Admin)) throw new NotFoundException("Meeting not found.");
        return meeting;
    }

    /// <summary>"07 Jan, 9:30 AM (Asia/Kolkata)" - the time as the organizer meant it, in the zone they scheduled in (validated before this is called).</summary>
    private static string InZone(DateTimeOffset instant, string zone) =>
        $"{ProjectManagement.Application.Features.Reminders.ZoneTime.ToLocal(instant.UtcDateTime, ProjectManagement.Application.Features.Reminders.ZoneTime.Find(zone)):dd MMM, h:mm tt} ({zone})";

    private void RequireNotGuest()
    {
        if (ctx.Role == TenantRole.Guest) throw new ForbiddenException("Guests can schedule meetings only from a project they were invited to.", "PERMISSION_DENIED");
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

        if (meeting.RecurrenceRule is not null && meeting.Provider != MeetingProvider.ProjectTracker) throw SeriesInCalendar(meeting.Provider);
        var oldStart = meeting.StartTimeUtc;
        try { await calendar.RescheduleAsync(meeting.Provider, meeting.OrganizerUserId, meeting.GoogleCalendarEventId, req.StartTime.UtcDateTime, req.EndTime.UtcDateTime, meeting.TimeZone, ct); }
        catch (MeetingCalendarException ex) { throw MeetingCalendar.Failed(ex); }
        var what = MeetingCalendar.Name(meeting.Provider);

        meeting.StartTimeUtc = req.StartTime.UtcDateTime;
        meeting.EndTimeUtc = req.EndTime.UtcDateTime;
        recorder.Activity("meeting.rescheduled", "ProjectMeeting", meeting.Id, $"Rescheduled \"{meeting.Title}\" from {oldStart:g} to {meeting.StartTimeUtc:g}", meeting.ProjectId);
        recorder.Audit("meeting.rescheduled", "ProjectMeeting", meeting.Id, oldValue: new { StartTimeUtc = oldStart }, newValue: new { meeting.StartTimeUtc, meeting.EndTimeUtc });
        var actorName = await db.Users.AsNoTracking().Where(u => u.Id == ctx.UserId).Select(u => u.DisplayName).FirstOrDefaultAsync(ct) ?? "Someone";
        foreach (var p in meeting.Participants.Where(p => p.UserId != null && p.UserId != ctx.UserId))
            await notifications.AddAsync(p.UserId!.Value, NotificationType.Meeting, $"{actorName} rescheduled a {what}", $"{meeting.Title} · now {InZone(req.StartTime, ZoneOf(meeting.TimeZone))}", MeetingReminders.MeetLink(meeting.Id, false), ct: ct);
        await db.SaveChangesAsync(ct);
        await MeetingReminders.PlanAsync(db, clock.Now, ct, meeting.Id);

        var card = new MeetingCard(meeting.Id, meeting.Title, meeting.StartTimeUtc, meeting.EndTimeUtc, meeting.TimeZone, meeting.GoogleMeetUri, meeting.Participants.Count, "Scheduled");
        await chat.PostMeetingCardAsync(meeting.ProjectId, card, $"📹 {actorName} rescheduled the {what}: {meeting.Title}", ct);
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
        try { await calendar.UpdateAttendeesAsync(meeting.Provider, meeting.OrganizerUserId, meeting.GoogleCalendarEventId, attendees, ct); }
        catch (MeetingCalendarException ex) { throw MeetingCalendar.Failed(ex); }

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
        await notifications.AddAsync(user.Id, NotificationType.Meeting, $"You were invited to a {MeetingCalendar.Name(meeting.Provider)}", $"{meeting.Title} · {InZone(new DateTimeOffset(meeting.StartTimeUtc, TimeSpan.Zero), ZoneOf(meeting.TimeZone))}{InvitationHint(meeting.Provider)}", MeetingReminders.MeetLink(meeting.Id, false), ct: ct);
        await db.SaveChangesAsync(ct);
        await MeetingReminders.PlanAsync(db, clock.Now, ct, meeting.Id);
        return ToDto(meeting, meeting.Organizer?.DisplayName ?? "");
    }

    /// <summary>Removes a participant (never the organizer - cancel the meeting instead).</summary>
    public async Task<MeetingDto> RemoveParticipantAsync(Guid meetingId, Guid userId, CancellationToken ct = default)
    {
        var meeting = await db.ProjectMeetings.Include(m => m.Participants).ThenInclude(p => p.User).Include(m => m.Organizer)
            .FirstOrDefaultAsync(m => m.Id == meetingId, ct) ?? throw new NotFoundException("Meeting not found.");
        await RequireOrganizerOrEditAsync(meeting, ct);
        if (meeting.Status != MeetingStatus.Scheduled) throw new ConflictException("Only a scheduled meeting can have its participants changed.", "MEETING_NOT_SCHEDULED");
        if (userId == meeting.OrganizerUserId) throw new ConflictException("The organizer cannot be removed. Cancel the meeting instead.", "ORGANIZER_REQUIRED");
        var row = meeting.Participants.FirstOrDefault(p => p.UserId == userId) ?? throw new NotFoundException("That person is not on this meeting.");

        var attendees = meeting.Participants.Where(p => p.UserId != meeting.OrganizerUserId && p.UserId != userId).Select(p => new GoogleMeetingAttendee(p.Email)).ToList();
        try { await calendar.UpdateAttendeesAsync(meeting.Provider, meeting.OrganizerUserId, meeting.GoogleCalendarEventId, attendees, ct); }
        catch (MeetingCalendarException ex) { throw MeetingCalendar.Failed(ex); }

        db.MeetingParticipants.Remove(row);
        meeting.Participants.Remove(row);   // also drop it from the in-memory collection, so the DTO returned below does not still list them
        recorder.Activity("meeting.participant_removed", "ProjectMeeting", meeting.Id, $"Removed {row.User?.DisplayName ?? row.Email} from \"{meeting.Title}\"", meeting.ProjectId);
        recorder.Audit("meeting.participant_removed", "ProjectMeeting", meeting.Id, oldValue: new { UserId = userId, row.Email });
        if (row.UserId is { } removedId)
            await notifications.AddAsync(removedId, NotificationType.Meeting, $"You are no longer invited to a {MeetingCalendar.Name(meeting.Provider)}", meeting.Title, "/meet", ct: ct);
        await db.SaveChangesAsync(ct);
        await MeetingReminders.PlanAsync(db, clock.Now, ct, meeting.Id);
        return ToDto(meeting, meeting.Organizer?.DisplayName ?? "");
    }

    // ---------------------------------------------------------------- title and agenda

    private const int MaxTitle = 200, MaxAgenda = 4000;

    private static (string Title, string? Description) CleanDetails(UpdateMeetingDetailsRequest req)
    {
        var title = (req.Title ?? "").Trim();
        if (title.Length == 0) throw new ValidationException("title", "Give the meeting a title.");
        if (title.Length > MaxTitle) throw new ValidationException("title", $"Keep the title under {MaxTitle} characters.");
        var description = string.IsNullOrWhiteSpace(req.Description) ? null : req.Description.Trim();
        if (description is { Length: > MaxAgenda }) throw new ValidationException("description", $"Keep the agenda under {MaxAgenda} characters.");
        return (title, description);
    }

    private static ConflictException EditInCalendar(MeetingProvider p) =>
        new($"This meeting lives in {(p == MeetingProvider.Microsoft ? "Outlook" : "Google Calendar")}. Change its title and agenda there so the invitation matches.", "MEETING_EDIT_IN_CALENDAR");

    /// <summary>Renames a project meeting or changes its agenda (the organizer, or someone who may edit projects).</summary>
    public async Task<MeetingDto> UpdateDetailsAsync(Guid meetingId, UpdateMeetingDetailsRequest req, CancellationToken ct = default)
    {
        var (title, description) = CleanDetails(req);
        var meeting = await db.ProjectMeetings.Include(m => m.Participants).ThenInclude(p => p.User).Include(m => m.Organizer)
            .FirstOrDefaultAsync(m => m.Id == meetingId, ct) ?? throw new NotFoundException("Meeting not found.");
        await access.GetProjectAsync(meeting.ProjectId, ct);
        await RequireOrganizerOrEditAsync(meeting, ct);
        if (meeting.Status != MeetingStatus.Scheduled) throw new ConflictException("Only a scheduled meeting can be changed.", "MEETING_NOT_SCHEDULED");
        if (meeting.Provider != MeetingProvider.ProjectTracker) throw EditInCalendar(meeting.Provider);
        var old = new { meeting.Title, meeting.Description };
        meeting.Title = title; meeting.Description = description;
        recorder.Audit("meeting.updated", "ProjectMeeting", meeting.Id, oldValue: old, newValue: new { meeting.Title, meeting.Description });
        await db.SaveChangesAsync(ct);
        return ToDto(meeting, meeting.Organizer?.DisplayName ?? "");
    }

    /// <summary>The same for a workspace meeting (its organizer, or an Owner/Admin).</summary>
    public async Task<WorkspaceMeetingDetailDto> UpdateWorkspaceDetailsAsync(Guid id, UpdateMeetingDetailsRequest req, CancellationToken ct = default)
    {
        var (title, description) = CleanDetails(req);
        var meeting = await LoadWorkspaceMeetingAsync(id, ct);
        if (!CanManage(meeting)) throw new ForbiddenException("Only the organizer can change this meeting.", "PERMISSION_DENIED");
        if (meeting.Status != MeetingStatus.Scheduled) throw new ConflictException("Only a scheduled meeting can be changed.", "MEETING_NOT_SCHEDULED");
        if (meeting.Provider != MeetingProvider.ProjectTracker) throw EditInCalendar(meeting.Provider);
        var old = new { meeting.Title, meeting.Description };
        meeting.Title = title; meeting.Description = description;
        recorder.Audit("meeting.updated", "WorkspaceMeeting", meeting.Id, oldValue: old, newValue: new { meeting.Title, meeting.Description });
        await db.SaveChangesAsync(ct);
        return await GetWorkspaceMeetingAsync(id, ct);
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
        if (meeting.Provider == MeetingProvider.ProjectTracker) return;
        try { statuses = await calendar.AttendeeStatusAsync(meeting.Provider, meeting.OrganizerUserId, meeting.GoogleCalendarEventId, ct); }
        catch (Exception ex) when (ex is not OperationCanceledException) { log.LogWarning(ex, "RSVP sync failed for meeting {MeetingId}", meeting.Id); return; }
        if (statuses.Count == 0) return;
        var byEmail = statuses.ToDictionary(s => s.Email, s => s.ResponseStatus, StringComparer.OrdinalIgnoreCase);
        foreach (var p in meeting.Participants)
        {
            if (p.Role == MeetingParticipantRole.Organizer || !byEmail.TryGetValue(p.Email, out var status)) continue;
            var mapped = status switch { "accepted" => AttendeeRsvpStatus.Accepted, "declined" => AttendeeRsvpStatus.Declined, "tentative" => AttendeeRsvpStatus.Tentative, _ => AttendeeRsvpStatus.NeedsAction };
            if (p.RsvpStatus == mapped) continue;
            var old = p.RsvpStatus;
            p.RsvpStatus = mapped;
            // Low volume by construction (only when the status actually moved), same as MeetingSyncEngine's background sweep - GOOGLE_MEET_RSVP_UPDATED either way.
            recorder.Audit("meeting.rsvp_updated", "ProjectMeeting", meeting.Id, oldValue: new { Rsvp = old.ToString(), p.Email }, newValue: new { Rsvp = mapped.ToString(), p.Email });
        }
    }

    // ---------------------------------------------------------------- cancel

    public async Task CancelAsync(Guid meetingId, CancellationToken ct = default)
    {
        var meeting = await db.ProjectMeetings.FirstOrDefaultAsync(m => m.Id == meetingId, ct) ?? throw new NotFoundException("Meeting not found.");
        await RequireOrganizerOrEditAsync(meeting, ct);
        if (meeting.Status == MeetingStatus.Cancelled) return;

        try { await calendar.CancelAsync(meeting.Provider, meeting.OrganizerUserId, meeting.GoogleCalendarEventId, ct); }
        catch (MeetingCalendarException ex) { throw MeetingCalendar.Failed(ex); }
        var what = MeetingCalendar.Name(meeting.Provider);

        meeting.Status = MeetingStatus.Cancelled;
        meeting.CancelledAt = clock.Now;
        recorder.Activity("meeting.cancelled", "ProjectMeeting", meeting.Id, $"Cancelled \"{meeting.Title}\"", meeting.ProjectId);
        recorder.Audit("meeting.cancelled", "ProjectMeeting", meeting.Id);
        var participantCount = await db.MeetingParticipants.AsNoTracking().CountAsync(p => p.MeetingId == meeting.Id, ct);
        var participants = await db.MeetingParticipants.AsNoTracking().Where(p => p.MeetingId == meeting.Id && p.UserId != null && p.UserId != meeting.OrganizerUserId).Select(p => p.UserId!.Value).ToListAsync(ct);
        foreach (var userId in participants)
            await notifications.AddAsync(userId, NotificationType.Meeting, $"A {what} was cancelled", meeting.Title, "/meet", ct: ct);
        await db.SaveChangesAsync(ct);
        await MeetingReminders.PlanAsync(db, clock.Now, ct, meeting.Id);

        var byName = await db.Users.AsNoTracking().Where(u => u.Id == ctx.UserId).Select(u => u.DisplayName).FirstOrDefaultAsync(ct) ?? "Someone";
        var card = new MeetingCard(meeting.Id, meeting.Title, meeting.StartTimeUtc, meeting.EndTimeUtc, meeting.TimeZone, meeting.GoogleMeetUri, participantCount, "Cancelled");
        await chat.PostMeetingCardAsync(meeting.ProjectId, card, $"📹 {byName} cancelled the {what}: {meeting.Title}", ct);
    }

    private static MeetingDto ToDto(ProjectMeeting m, string organizerName) => new(m.Id, m.ProjectId, m.Title, m.Description,
        new DateTimeOffset(m.StartTimeUtc, TimeSpan.Zero), new DateTimeOffset(m.EndTimeUtc, TimeSpan.Zero), m.TimeZone, m.Status.ToString(), m.GoogleMeetUri,
        m.OrganizerUserId, organizerName, m.Participants.Select(p => new MeetingParticipantDto(p.UserId, p.User?.DisplayName ?? p.Email, p.Email, p.Role.ToString(), p.RsvpStatus.ToString())).ToList(), m.RecurrenceRule, m.CalendarUrl, m.IsScrum,
        MeetingCalendar.Key(m.Provider), MeetingCalendar.Name(m.Provider), MeetNotetaker.Key(m.Notetaker));

    private static string ZoneOf(string zone) => ProjectManagement.Application.Features.Reminders.ZoneTime.IsKnown(zone) ? zone : "UTC";

    // ---------------------------------------------------------------- replies (Project Tracker calls)

    /// <summary>
    /// The invited person's reply to a Project Tracker call. Google and Outlook keep their own invitations and replies (Project Tracker reads
    /// them back), so for those the reply is given in that calendar. Declining takes back the meeting's reminder; accepting brings it back.
    /// </summary>
    public async Task<string> RespondAsync(Guid meetingId, MeetingRsvpRequest req, CancellationToken ct = default)
    {
        var status = ParseRsvp(req.Response);
        var me = ctx.RequireUserId();
        var meeting = await db.ProjectMeetings.FirstOrDefaultAsync(m => m.Id == meetingId, ct) ?? throw new NotFoundException("Meeting not found.");
        if (meeting.Provider != MeetingProvider.ProjectTracker) throw ReplyInCalendar(meeting.Provider);
        if (meeting.Status != MeetingStatus.Scheduled) throw new ConflictException("This meeting is no longer scheduled.", "MEETING_NOT_SCHEDULED");
        var row = await db.MeetingParticipants.FirstOrDefaultAsync(p => p.MeetingId == meetingId && p.UserId == me, ct) ?? throw new NotFoundException("You are not invited to this meeting.");
        if (row.Role == MeetingParticipantRole.Organizer) throw new ConflictException("You organize this meeting. Cancel it if it should not happen.", "ORGANIZER_REQUIRED");
        if (row.RsvpStatus != status)
        {
            var old = row.RsvpStatus;
            row.RsvpStatus = status;
            recorder.Audit("meeting.rsvp_updated", "ProjectMeeting", meeting.Id, oldValue: new { Rsvp = old.ToString() }, newValue: new { Rsvp = status.ToString() });
            await TellOrganizerAsync(meeting.OrganizerUserId, meeting.Title, status, MeetingReminders.MeetLink(meeting.Id, false), ct);
            await db.SaveChangesAsync(ct);
            await MeetingReminders.PlanAsync(db, clock.Now, ct, meeting.Id);
        }
        return status.ToString();
    }

    public async Task<string> RespondWorkspaceAsync(Guid meetingId, MeetingRsvpRequest req, CancellationToken ct = default)
    {
        var status = ParseRsvp(req.Response);
        var me = ctx.RequireUserId();
        var meeting = await db.WorkspaceMeetings.FirstOrDefaultAsync(m => m.Id == meetingId, ct) ?? throw new NotFoundException("Meeting not found.");
        var row = await db.WorkspaceMeetingAttendees.FirstOrDefaultAsync(a => a.MeetingId == meetingId && a.UserId == me, ct) ?? throw new NotFoundException("Meeting not found.");
        if (meeting.Provider != MeetingProvider.ProjectTracker) throw ReplyInCalendar(meeting.Provider);
        if (meeting.Status != MeetingStatus.Scheduled) throw new ConflictException("This meeting is no longer scheduled.", "MEETING_NOT_SCHEDULED");
        if (row.IsOrganizer) throw new ConflictException("You organize this meeting. Cancel it if it should not happen.", "ORGANIZER_REQUIRED");
        if (row.RsvpStatus != status)
        {
            var old = row.RsvpStatus;
            row.RsvpStatus = status;
            recorder.Audit("meeting.rsvp_updated", "WorkspaceMeeting", meeting.Id, oldValue: new { Rsvp = old.ToString() }, newValue: new { Rsvp = status.ToString() });
            await TellOrganizerAsync(meeting.OrganizerUserId, meeting.Title, status, MeetingReminders.MeetLink(meeting.Id, true), ct);
            await db.SaveChangesAsync(ct);
            await MeetingReminders.PlanAsync(db, clock.Now, ct, meeting.Id);
        }
        return status.ToString();
    }

    private static AttendeeRsvpStatus ParseRsvp(string? response) => (response ?? "").Trim().ToLowerInvariant() switch
    {
        "accepted" or "accept" or "yes" => AttendeeRsvpStatus.Accepted,
        "tentative" or "maybe" => AttendeeRsvpStatus.Tentative,
        "declined" or "decline" or "no" => AttendeeRsvpStatus.Declined,
        _ => throw new ValidationException("response", "Reply accepted, tentative or declined."),
    };

    private static ConflictException ReplyInCalendar(MeetingProvider p) =>
        new($"Reply from the invitation in your {(p == MeetingProvider.Microsoft ? "Outlook calendar" : "Google Calendar")}: it keeps the replies for this meeting.", "RSVP_IN_CALENDAR");

    private async Task TellOrganizerAsync(Guid organizerId, string title, AttendeeRsvpStatus status, string link, CancellationToken ct)
    {
        var me = ctx.RequireUserId();
        if (organizerId == me) return;
        var name = await db.Users.AsNoTracking().Where(u => u.Id == me).Select(u => u.DisplayName).FirstOrDefaultAsync(ct) ?? "Someone";
        var verb = status switch { AttendeeRsvpStatus.Accepted => "accepted", AttendeeRsvpStatus.Declined => "declined", _ => "may join" };
        await notifications.AddAsync(organizerId, NotificationType.Meeting, $"{name} {verb}", title, link, ct: ct);
    }

    // ---------------------------------------------------------------- one session, this and following, or the whole series

    /// <summary>
    /// Changes one session of a repeating meeting (<paramref name="req"/>.Scope "this"), it and every later one ("following": the series is
    /// split there - the first part ends before it and a new series carries on from it), or the whole series ("all"). Moving, renaming and
    /// cancelling all work this way. Only for meetings held by Project Tracker: a Google or Outlook series is changed in that calendar.
    /// </summary>
    public async Task<OccurrenceChangeResultDto> ChangeOccurrenceAsync(bool workspace, Guid meetingId, ChangeOccurrenceRequest req, CancellationToken ct = default)
    {
        var scope = (req.Scope ?? "this").Trim().ToLowerInvariant();
        if (scope is not ("this" or "following" or "all")) throw new ValidationException("scope", "Choose this occurrence, this and following, or all.");
        if (!req.Cancel && req.StartTime is null && string.IsNullOrWhiteSpace(req.Title)) throw new ValidationException("startTime", "Say what changes: the time, the title, or cancel it.");
        if (req.StartTime is { } st && (req.EndTime is not { } en || en <= st)) throw new ValidationException("endTime", "The meeting must end after it starts.");
        if (req.StartTime is { } st2 && st2 < DateTimeOffset.UtcNow.AddMinutes(-5)) throw new ValidationException("startTime", "Choose a time that has not already passed.");
        var title = string.IsNullOrWhiteSpace(req.Title) ? null : req.Title.Trim();
        if (title is { Length: > 200 }) throw new ValidationException("title", ProjectManagement.Application.Common.TextLimits.TooLong(200, title.Length));

        ProjectMeeting? pm = null; WorkspaceMeeting? wm = null;
        if (workspace)
        {
            wm = await LoadWorkspaceMeetingAsync(meetingId, ct);
            if (!CanManage(wm)) throw new ForbiddenException("Only the organizer can change this meeting.", "PERMISSION_DENIED");
        }
        else
        {
            pm = await db.ProjectMeetings.Include(m => m.Participants).FirstOrDefaultAsync(m => m.Id == meetingId, ct) ?? throw new NotFoundException("Meeting not found.");
            await RequireOrganizerOrEditAsync(pm, ct);
        }
        var status = pm?.Status ?? wm!.Status;
        var rule = pm is not null ? pm.RecurrenceRule : wm!.RecurrenceRule;
        var provider = pm?.Provider ?? wm!.Provider;
        var firstStart = pm?.StartTimeUtc ?? wm!.StartTimeUtc;
        var firstEnd = pm?.EndTimeUtc ?? wm!.EndTimeUtc;
        var zone = ZoneOf(pm?.TimeZone ?? wm!.TimeZone);
        var meetingTitle = pm?.Title ?? wm!.Title;
        var tid = ctx.RequireTenantId();
        var mref = MeetingSessions.Ref(workspace, meetingId);
        if (status != MeetingStatus.Scheduled) throw new ConflictException("Only a scheduled meeting can be changed.", "MEETING_NOT_SCHEDULED");
        if (rule is null) throw new ConflictException("This meeting does not repeat: move or cancel the meeting itself.", "MEETING_NOT_RECURRING");
        if (provider != MeetingProvider.ProjectTracker) throw SeriesInCalendar(provider);
        var occurrence = req.OccurrenceStart.UtcDateTime;
        if (!MeetingRecurrence.Occurrences(rule, firstStart, zone, occurrence, occurrence.AddSeconds(1)).Any())
            throw new ValidationException("occurrenceStart", "That is not one of this meeting's sessions.");
        if (scope == "following" && occurrence <= firstStart) scope = "all";
        var length = firstEnd - firstStart;

        var people = pm is not null
            ? pm.Participants.Where(p => p.UserId is not null && p.UserId != ctx.UserId).Select(p => p.UserId!.Value).ToList()
            : await db.WorkspaceMeetingAttendees.AsNoTracking().Where(a => a.MeetingId == meetingId && a.UserId != ctx.UserId).Select(a => a.UserId).ToListAsync(ct);
        var whatChanged = req.Cancel ? "cancelled" : req.StartTime is not null ? "moved" : "renamed";
        string? newSeries = null;
        DateTimeOffset? resultStart = req.StartTime, resultEnd = req.EndTime;

        if (scope == "this")
        {
            var change = await db.MeetingOccurrenceChanges.FirstOrDefaultAsync(c => c.MeetingId == meetingId && c.OccurrenceStartUtc == occurrence, ct);
            if (change is null)
            {
                change = new MeetingOccurrenceChange { TenantId = tid, MeetingRef = mref, MeetingId = meetingId, OccurrenceStartUtc = occurrence, CreatedAt = clock.Now, CreatedBy = ctx.UserId };
                db.MeetingOccurrenceChanges.Add(change);
            }
            if (req.Cancel) change.IsCancelled = true;
            if (req.StartTime is { } ns)
            {
                if (Math.Abs((ns.UtcDateTime - occurrence).TotalDays) > MeetingSessions.MaxMove.TotalDays) throw new ValidationException("startTime", "Move one session by at most a month; change the series for more.");
                change.NewStartUtc = ns.UtcDateTime; change.NewEndUtc = req.EndTime!.Value.UtcDateTime;
            }
            if (title is not null) change.Title = title;
            change.UpdatedAt = clock.Now; change.UpdatedBy = ctx.UserId;
        }
        else if (scope == "all")
        {
            if (req.Cancel)
            {
                if (workspace) await CancelWorkspaceMeetingAsync(meetingId, ct); else await CancelAsync(meetingId, ct);
                return new OccurrenceChangeResultDto("all", mref, null, null, null);
            }
            if (req.StartTime is { } ns)
            {
                // The whole series keeps its rhythm from the new time: every session moves by the same amount, one-off changes are let go.
                var shift = ns.UtcDateTime - occurrence;
                var newLength = req.EndTime!.Value.UtcDateTime - ns.UtcDateTime;
                var start = firstStart + shift;
                if (pm is not null) { pm.StartTimeUtc = start; pm.EndTimeUtc = start + newLength; } else { wm!.StartTimeUtc = start; wm.EndTimeUtc = start + newLength; }
                await db.MeetingOccurrenceChanges.Where(c => c.MeetingId == meetingId).ExecuteDeleteAsync(ct);
                resultStart = new DateTimeOffset(start, TimeSpan.Zero); resultEnd = new DateTimeOffset(start + newLength, TimeSpan.Zero);
            }
            if (title is not null) { if (pm is not null) pm.Title = title; else wm!.Title = title; }
        }
        else
        {
            // This and following: the series ends before this session; unless it is cancelled from here on, a new series carries on.
            var taken = MeetingRecurrence.CountBefore(rule, firstStart, zone, occurrence);
            var left = MeetingRecurrence.CountLeft(rule, taken);
            var ended = MeetingRecurrence.EndBefore(rule, occurrence);
            if (pm is not null) pm.RecurrenceRule = ended; else wm!.RecurrenceRule = ended;
            await db.MeetingOccurrenceChanges.Where(c => c.MeetingId == meetingId && c.OccurrenceStartUtc >= occurrence).ExecuteDeleteAsync(ct);
            if (!req.Cancel)
            {
                var start = req.StartTime ?? new DateTimeOffset(occurrence, TimeSpan.Zero);
                var end = req.EndTime ?? start + length;
                var next = MeetingRecurrence.Continue(rule, left is { } n ? Math.Max(1, n) : null);
                if (!MeetingRecurrence.Occurrences(next, start.UtcDateTime, zone, start.UtcDateTime, start.UtcDateTime.AddSeconds(1)).Any())
                    throw new ValidationException("startTime", "Choose a day the series meets on.");
                var root = (pm?.SeriesRootId ?? wm!.SeriesRootId) ?? meetingId;
                await db.SaveChangesAsync(ct);
                if (pm is not null)
                {
                    var made = await CreateAsync(pm.ProjectId, title ?? pm.Title, pm.Description, start, end, zone, people, ct, next, pm.IsScrum, "ours", pm.Notetaker,
                        pm.VideoKind, pm.VideoLink, pm.AttendeeTeamIds, root);
                    newSeries = MeetingSessions.Ref(false, made.Id);
                }
                else
                {
                    var made = await ScheduleForWorkspaceAsync(new ScheduleMeetingRequest(title ?? wm!.Title, wm!.Description, start, end, zone, people, null, wm.IsScrum, "ours", null, null,
                        wm.VideoKind, wm.VideoLink), ct, root, next);
                    newSeries = MeetingSessions.Ref(true, made.Id);
                }
                resultStart = start; resultEnd = end;
            }
        }

        recorder.Audit($"meeting.occurrence_{whatChanged}", workspace ? "WorkspaceMeeting" : "ProjectMeeting", meetingId,
            newValue: new { Scope = scope, Occurrence = occurrence, StartTimeUtc = resultStart?.UtcDateTime, Title = title, NewSeries = newSeries });
        if (pm is not null) recorder.Activity($"meeting.occurrence_{whatChanged}", "ProjectMeeting", meetingId, $"{Cap(whatChanged)} {(scope == "this" ? "one session" : scope == "following" ? "this and following sessions" : "every session")} of \"{meetingTitle}\"", pm.ProjectId);
        if (newSeries is null)
        {
            var link = MeetingReminders.MeetLink(meetingId, workspace);
            var when = req.StartTime is { } at ? $" · now {InZone(at, zone)}" : "";
            foreach (var u in people)
                await notifications.AddAsync(u, NotificationType.Meeting, $"{meetingTitle}: {(scope == "this" ? "one session" : "the series")} {whatChanged}",
                    $"Session of {InZone(new DateTimeOffset(occurrence, TimeSpan.Zero), zone)}{when}", link, ct: ct);
        }
        await db.SaveChangesAsync(ct);
        await MeetingReminders.PlanAsync(db, clock.Now, ct, meetingId);
        return new OccurrenceChangeResultDto(scope, mref, resultStart, resultEnd, newSeries);
    }

    private static string Cap(string s) => s.Length == 0 ? s : char.ToUpperInvariant(s[0]) + s[1..];
}
