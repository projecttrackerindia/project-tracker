using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace ProjectManagement.Application.Features.Integrations;

public record GoogleMeetingAttendee(string Email, bool Optional = false);
public record CreatedGoogleMeeting(string EventId, string MeetUri, string? MeetSpaceName, string HtmlLink);
/// <summary>One attendee's real RSVP, straight from Google: "needsAction", "accepted", "declined" or "tentative" - the authoritative state,
/// never invented locally (spec section 11).</summary>
public record GoogleAttendeeStatus(string Email, string ResponseStatus);

/// <summary>Google's own error response. Never shown to the person as-is - callers turn it into one of the plain-language messages the
/// product requires (e.g. "We couldn't create the Google Meet right now. Please try again."); the technical detail stays server-side.</summary>
public class GoogleApiException(string action, HttpStatusCode status, string body) : Exception($"Google Calendar {action} failed: {(int)status}")
{
    public HttpStatusCode Status { get; } = status;
    public string Body { get; } = body.Length > 500 ? body[..500] : body;
}

/// <summary>
/// Creates, reschedules and cancels the Calendar event behind a Project Tracker meeting, through the organizer's own Google account
/// (<see cref="GoogleCalendarAuthService"/>). Google's documented, recommended way to get a Google Meet conference on an event is
/// conferenceData.createRequest on Calendar's events.insert itself - that single call provisions the Meet space and returns its join
/// URL, and Calendar's own attendee/invitation/RSVP mechanism is the real one (never reimplemented here). A direct client for
/// meet.googleapis.com (space members, co-hosts, conference records, transcripts) is deliberately not built yet: those are later,
/// separate concerns from "schedule a meeting with a Meet link" (spec sections 14 and 20).
/// </summary>
public class GoogleMeetingClient(IHttpClientFactory http, GoogleCalendarAuthService auth, ILogger<GoogleMeetingClient> log)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private const string EventsUrl = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

    /// <summary>Creates the event with a brand-new Meet conference and the given attendees. sendUpdates=all means Google sends the real
    /// Calendar invitation e-mail to every attendee - Project Tracker's own notification (added by the caller) is additional, not a
    /// replacement for it.</summary>
    public async Task<CreatedGoogleMeeting> CreateEventAsync(Guid organizerUserId, string title, string? description, DateTime startUtc, DateTime endUtc,
        string timeZone, IReadOnlyList<GoogleMeetingAttendee> attendees, CancellationToken ct = default)
    {
        var token = await auth.GetAccessTokenAsync(organizerUserId, ct);
        var payload = new
        {
            summary = title,
            description,
            start = new { dateTime = startUtc.ToString("o"), timeZone },
            end = new { dateTime = endUtc.ToString("o"), timeZone },
            attendees = attendees.Select(a => new { email = a.Email, optional = a.Optional }),
            conferenceData = new { createRequest = new { requestId = Guid.NewGuid().ToString("N"), conferenceSolutionKey = new { type = "hangoutsMeet" } } },
            reminders = new { useDefault = true },
        };
        var doc = await SendAsync(HttpMethod.Post, $"{EventsUrl}?conferenceDataVersion=1&sendUpdates=all", token, payload, "create", ct);
        return Parse(doc);
    }

    /// <summary>Moves an existing event to a new time; the Meet conference and attendee list are untouched.</summary>
    public async Task<CreatedGoogleMeeting> RescheduleEventAsync(Guid organizerUserId, string eventId, DateTime startUtc, DateTime endUtc, string timeZone, CancellationToken ct = default)
    {
        var token = await auth.GetAccessTokenAsync(organizerUserId, ct);
        var payload = new { start = new { dateTime = startUtc.ToString("o"), timeZone }, end = new { dateTime = endUtc.ToString("o"), timeZone } };
        var doc = await SendAsync(HttpMethod.Patch, $"{EventsUrl}/{eventId}?sendUpdates=all", token, payload, "reschedule", ct);
        return Parse(doc);
    }

    /// <summary>Replaces the event's attendee list outright (Calendar's PATCH replaces the whole field when it is sent, not merges it) - used
    /// to add or remove a participant. Existing attendees not included in <paramref name="attendees"/> are dropped from the invitation.</summary>
    public async Task<CreatedGoogleMeeting> UpdateAttendeesAsync(Guid organizerUserId, string eventId, IReadOnlyList<GoogleMeetingAttendee> attendees, CancellationToken ct = default)
    {
        var token = await auth.GetAccessTokenAsync(organizerUserId, ct);
        var payload = new { attendees = attendees.Select(a => new { email = a.Email, optional = a.Optional }) };
        var doc = await SendAsync(HttpMethod.Patch, $"{EventsUrl}/{eventId}?sendUpdates=all", token, payload, "update participants", ct);
        return Parse(doc);
    }

    /// <summary>Each attendee's real response, straight from the Calendar event - the only place RSVP ever comes from (spec section 11:
    /// "do not implement our own fake accept/decline system").</summary>
    public async Task<IReadOnlyList<GoogleAttendeeStatus>> GetAttendeeStatusAsync(Guid organizerUserId, string eventId, CancellationToken ct = default)
    {
        var token = await auth.GetAccessTokenAsync(organizerUserId, ct);
        using var req = new HttpRequestMessage(HttpMethod.Get, $"{EventsUrl}/{eventId}");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        using var res = await http.CreateClient("google-calendar").SendAsync(req, ct);
        var body = await res.Content.ReadAsStringAsync(ct);
        // Gone/NotFound: the organizer (or someone) deleted the event directly in Calendar. Nothing to report - the caller keeps whatever
        // RSVP state it last knew, rather than failing a page load over an event that no longer exists on Google's side.
        if (res.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.Gone) return [];
        if (!res.IsSuccessStatusCode)
        {
            log.LogWarning("Google Calendar attendee read failed for event {EventId}: {Status} {Body}", eventId, (int)res.StatusCode, body.Length > 300 ? body[..300] : body);
            throw new GoogleApiException("read attendees", res.StatusCode, body);
        }
        var doc = JsonDocument.Parse(body).RootElement;
        if (!doc.TryGetProperty("attendees", out var list)) return [];
        var result = new List<GoogleAttendeeStatus>();
        foreach (var a in list.EnumerateArray())
            if (a.TryGetProperty("email", out var e) && e.GetString() is { } email)
                result.Add(new GoogleAttendeeStatus(email, a.TryGetProperty("responseStatus", out var r) ? r.GetString() ?? "needsAction" : "needsAction"));
        return result;
    }

    /// <summary>Cancels the event; Calendar notifies every attendee itself (sendUpdates=all).</summary>
    public async Task CancelEventAsync(Guid organizerUserId, string eventId, CancellationToken ct = default)
    {
        var token = await auth.GetAccessTokenAsync(organizerUserId, ct);
        using var req = new HttpRequestMessage(HttpMethod.Delete, $"{EventsUrl}/{eventId}?sendUpdates=all");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        using var res = await http.CreateClient("google-calendar").SendAsync(req, ct);
        // Gone means Google already considers the event deleted (e.g. the organizer removed it directly in Calendar) - that is success here, not a failure to surface.
        if (res.IsSuccessStatusCode || res.StatusCode == HttpStatusCode.Gone) return;
        var body = await res.Content.ReadAsStringAsync(ct);
        log.LogWarning("Google Calendar cancel failed for event {EventId}: {Status} {Body}", eventId, (int)res.StatusCode, body.Length > 300 ? body[..300] : body);
        throw new GoogleApiException("cancel", res.StatusCode, body);
    }

    private async Task<JsonElement> SendAsync(HttpMethod method, string url, string token, object payload, string action, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(method, url) { Content = new StringContent(JsonSerializer.Serialize(payload, Json), Encoding.UTF8, "application/json") };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        using var res = await http.CreateClient("google-calendar").SendAsync(req, ct);
        var body = await res.Content.ReadAsStringAsync(ct);
        if (!res.IsSuccessStatusCode)
        {
            log.LogWarning("Google Calendar {Action} failed: {Status} {Body}", action, (int)res.StatusCode, body.Length > 300 ? body[..300] : body);
            throw new GoogleApiException(action, res.StatusCode, body);
        }
        return JsonDocument.Parse(body).RootElement;
    }

    private static CreatedGoogleMeeting Parse(JsonElement doc)
    {
        var eventId = doc.GetProperty("id").GetString()!;
        var htmlLink = doc.TryGetProperty("htmlLink", out var h) ? h.GetString() ?? "" : "";
        string? meetUri = null, spaceName = null;
        if (doc.TryGetProperty("conferenceData", out var cd))
        {
            if (cd.TryGetProperty("entryPoints", out var eps))
                foreach (var ep in eps.EnumerateArray())
                    if (ep.TryGetProperty("entryPointType", out var t) && t.GetString() == "video" && ep.TryGetProperty("uri", out var u)) { meetUri = u.GetString(); break; }
            if (cd.TryGetProperty("conferenceId", out var ci)) spaceName = ci.GetString();
        }
        return new CreatedGoogleMeeting(eventId, meetUri ?? "", spaceName, htmlLink);
    }
}
