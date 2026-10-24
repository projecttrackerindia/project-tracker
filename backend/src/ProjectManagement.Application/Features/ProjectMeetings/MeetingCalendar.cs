using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Integrations;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.ProjectMeetings;

/// <summary>A meeting service failed (Google or Outlook refused, or did not answer). <see cref="Provider"/> names it for the message.</summary>
public class MeetingCalendarException(MeetingProvider provider, string action, Exception inner) : Exception($"{provider} {action} failed", inner)
{
    public MeetingProvider Provider { get; } = provider;
    public string Action { get; } = action;
}

/// <summary>Which service a person's meetings use, and why (for the screens that say so).</summary>
public record MeetingServiceChoiceDto(string Preference, string Provider, string Name, string Reason, bool GoogleReady, bool MicrosoftReady, bool OwnCallsReady);

/// <summary>
/// Where a meeting is created, and every later change to it. A person who connected Google gets Google Calendar + Meet; one who connected
/// Microsoft gets an Outlook event with a Teams meeting; everyone else gets our own call, which the project agent joins without a lobby. A
/// person can also choose (My account > Connected accounts > Meetings), and each meeting remembers where it was made, so a later change in
/// someone's connections never strands an existing meeting.
/// </summary>
public class MeetingCalendar(IAppDbContext db, GoogleMeetingClient google, TeamsMeetingClient teams, MicrosoftProductivityAuthService microsoft,
    GoogleCalendarAuthService googleAuth, Microsoft.Extensions.Options.IOptions<Calls.CallsOptions> calls)
{
    public const string Auto = "auto", Google = "google", Teams = "microsoft", Own = "ours";

    public static string Name(MeetingProvider p) => p switch
    {
        MeetingProvider.Microsoft => "Microsoft Teams meeting",
        MeetingProvider.ProjectTracker => "Project Tracker call",
        _ => "Google Meet",
    };

    public static string Key(MeetingProvider p) => p switch { MeetingProvider.Microsoft => Teams, MeetingProvider.ProjectTracker => Own, _ => Google };

    public async Task<bool> GoogleReadyAsync(Guid userId, CancellationToken ct) => googleAuth.Configured
        && await db.GoogleConnections.AsNoTracking().Where(c => c.UserId == userId).Select(c => c.Scopes).FirstOrDefaultAsync(ct) is { } s
        && s.Split(' ', StringSplitOptions.RemoveEmptyEntries).Contains("https://www.googleapis.com/auth/calendar.events");

    public Task<bool> MicrosoftReadyAsync(Guid userId, CancellationToken ct) => microsoft.CanCreateMeetingsAsync(userId, ct);
    public bool OwnCallsReady => calls.Value.Configured;

    /// <summary>
    /// The service a new meeting by this person goes to. <paramref name="requested"/> (from the meeting form) wins, then their saved choice,
    /// then the automatic order: Google, Microsoft, our own call. A chosen service that is not connected is refused with what to connect.
    /// </summary>
    public async Task<MeetingServiceChoiceDto> ChooseAsync(Guid userId, string? requested, CancellationToken ct)
    {
        var saved = await db.PersonalConnectionSettings.AsNoTracking().Where(s => s.UserId == userId).Select(s => s.MeetingService).FirstOrDefaultAsync(ct);
        var preference = Normalize(requested) ?? Normalize(saved) ?? Auto;
        var g = await GoogleReadyAsync(userId, ct);
        var m = await MicrosoftReadyAsync(userId, ct);
        var own = OwnCallsReady;
        MeetingServiceChoiceDto Pick(MeetingProvider p, string reason) => new(preference, Key(p), Name(p), reason, g, m, own);
        switch (preference)
        {
            case Google when g: return Pick(MeetingProvider.Google, "You chose Google Meet.");
            case Google when await db.GoogleConnections.AsNoTracking().AnyAsync(c => c.UserId == userId, ct):
                throw new ConflictException("Reconnect Google and allow Calendar and Meet to hold meetings in Google Meet, or choose another service.", "GOOGLE_SCOPE_REQUIRED");
            case Google: throw new ConflictException("Connect your Google account (Calendar and Meet) to hold meetings in Google Meet, or choose another service.", "GOOGLE_NOT_CONNECTED");
            case Teams when m: return Pick(MeetingProvider.Microsoft, "You chose Microsoft Teams.");
            case Teams: throw new ConflictException("Connect your Microsoft account with Outlook calendar and Teams meetings, or choose another service.", "MICROSOFT_NOT_CONNECTED");
            case Own when own: return Pick(MeetingProvider.ProjectTracker, "You chose Project Tracker calls.");
            case Own: throw new ConflictException("Project Tracker calls are not set up on this installation yet. Connect Google or Microsoft instead.", "CALLS_UNAVAILABLE");
        }
        if (g) return Pick(MeetingProvider.Google, "Your Google account is connected, so meetings go to Google Calendar with a Meet link.");
        if (m) return Pick(MeetingProvider.Microsoft, "Your Microsoft account is connected, so meetings go to Outlook with a Teams link.");
        if (own) return Pick(MeetingProvider.ProjectTracker, "No calendar is connected, so meetings are Project Tracker calls. The project agent can join them.");
        throw new ConflictException("Connect Google or Microsoft in My account > Connected accounts to schedule meetings.", "GOOGLE_NOT_CONNECTED");
    }

    public static string? Normalize(string? value) => value?.Trim().ToLowerInvariant() switch
    {
        "auto" => Auto, "google" or "meet" or "google_meet" => Google, "microsoft" or "teams" or "outlook" => Teams, "ours" or "own" or "projecttracker" or "calls" => Own,
        _ => null,
    };

    public static MeetingProvider ToProvider(string key) => key switch { Teams => MeetingProvider.Microsoft, Own => MeetingProvider.ProjectTracker, _ => MeetingProvider.Google };

    /// <summary>Creates the meeting in its service. Our own calls need nothing outside: the join address is the meeting's own page.</summary>
    public async Task<CreatedGoogleMeeting> CreateAsync(MeetingProvider p, Guid meetingId, bool workspaceMeeting, Guid organizerUserId, string title, string? description,
        DateTime startUtc, DateTime endUtc, string timeZone, IReadOnlyList<GoogleMeetingAttendee> attendees, CancellationToken ct, string? recurrenceRule = null)
    {
        if (p == MeetingProvider.ProjectTracker) return new CreatedGoogleMeeting($"pt:{meetingId:N}", JoinPath(meetingId, workspaceMeeting), null, "");
        return await Run(p, "create", () => p == MeetingProvider.Microsoft
            ? teams.CreateEventAsync(organizerUserId, title, description, startUtc, endUtc, timeZone, attendees, ct, recurrenceRule)
            : google.CreateEventAsync(organizerUserId, title, description, startUtc, endUtc, timeZone, attendees, ct, recurrenceRule));
    }

    /// <summary>Where people join a meeting held as our own call (it opens, or starts, the call for that meeting).</summary>
    public static string JoinPath(Guid meetingId, bool workspaceMeeting) => workspaceMeeting ? $"/calls/meeting/w/{meetingId}" : $"/calls/meeting/{meetingId}";

    public async Task RescheduleAsync(MeetingProvider p, Guid organizerUserId, string eventId, DateTime startUtc, DateTime endUtc, string timeZone, CancellationToken ct)
    {
        if (p == MeetingProvider.ProjectTracker) return;
        await Run(p, "reschedule", () => p == MeetingProvider.Microsoft
            ? teams.RescheduleEventAsync(organizerUserId, eventId, startUtc, endUtc, timeZone, ct)
            : google.RescheduleEventAsync(organizerUserId, eventId, startUtc, endUtc, timeZone, ct));
    }

    public async Task UpdateAttendeesAsync(MeetingProvider p, Guid organizerUserId, string eventId, IReadOnlyList<GoogleMeetingAttendee> attendees, CancellationToken ct)
    {
        if (p == MeetingProvider.ProjectTracker) return;
        await Run(p, "update participants", () => p == MeetingProvider.Microsoft
            ? teams.UpdateAttendeesAsync(organizerUserId, eventId, attendees, ct)
            : google.UpdateAttendeesAsync(organizerUserId, eventId, attendees, ct));
    }

    public async Task CancelAsync(MeetingProvider p, Guid organizerUserId, string eventId, CancellationToken ct)
    {
        if (p == MeetingProvider.ProjectTracker) return;
        await Run(p, "cancel", async () =>
        {
            if (p == MeetingProvider.Microsoft) await teams.CancelEventAsync(organizerUserId, eventId, ct);
            else await google.CancelEventAsync(organizerUserId, eventId, ct);
            return true;
        });
    }

    /// <summary>Real RSVPs from Google or Outlook; our own calls have none (people simply join).</summary>
    public Task<IReadOnlyList<GoogleAttendeeStatus>> AttendeeStatusAsync(MeetingProvider p, Guid organizerUserId, string eventId, CancellationToken ct) => p switch
    {
        MeetingProvider.ProjectTracker => Task.FromResult<IReadOnlyList<GoogleAttendeeStatus>>([]),
        MeetingProvider.Microsoft => teams.GetAttendeeStatusAsync(organizerUserId, eventId, ct),
        _ => google.GetAttendeeStatusAsync(organizerUserId, eventId, ct),
    };

    private static async Task<T> Run<T>(MeetingProvider p, string action, Func<Task<T>> call)
    {
        try { return await call(); }
        catch (GoogleApiException ex) { throw new MeetingCalendarException(p, action, ex); }
        catch (TeamsApiException ex) { throw new MeetingCalendarException(p, action, ex); }
    }

    /// <summary>The plain message for a failed change ("We couldn't create the Microsoft Teams meeting right now. Please try again.").</summary>
    public static ConflictException Failed(MeetingCalendarException ex)
    {
        var name = Name(ex.Provider);
        var message = ex.Action switch
        {
            "update participants" => $"We couldn't update the {name}'s attendees right now. Please try again.",
            _ => $"We couldn't {ex.Action} the {name} right now. Please try again.",
        };
        return new(message, $"{(ex.Provider == MeetingProvider.Microsoft ? "TEAMS" : "GOOGLE")}_MEET_{ex.Action.Split(' ')[0].ToUpperInvariant()}_FAILED");
    }
}
