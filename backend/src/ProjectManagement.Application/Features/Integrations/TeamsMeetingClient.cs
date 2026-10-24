using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Features.Reminders;

namespace ProjectManagement.Application.Features.Integrations;

/// <summary>Microsoft Graph refused or failed a calendar call. Never shown as-is; callers turn it into a plain message.</summary>
public class TeamsApiException(string action, HttpStatusCode status) : Exception($"Outlook calendar {action} failed: {(int)status}")
{
    public HttpStatusCode Status { get; } = status;
}

/// <summary>
/// The Outlook calendar event behind a meeting organized by someone who connected Microsoft: created as them with a Teams meeting on it
/// (isOnlineMeeting + teamsForBusiness), so Outlook sends the real invitations and keeps the real RSVPs, exactly as Google Calendar does for
/// Google Meet (<see cref="GoogleMeetingClient"/>). Uses the person's own Calendars.ReadWrite grant, never a shared credential.
/// </summary>
public class TeamsMeetingClient(IHttpClientFactory http, MicrosoftProductivityAuthService auth, ILogger<TeamsMeetingClient> log)
{
    private const string Events = "https://graph.microsoft.com/v1.0/me/events";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull };

    public async Task<CreatedGoogleMeeting> CreateEventAsync(Guid organizerUserId, string title, string? description, DateTime startUtc, DateTime endUtc,
        string timeZone, IReadOnlyList<GoogleMeetingAttendee> attendees, CancellationToken ct = default, string? recurrenceRule = null)
    {
        var (zone, windows) = Zone(timeZone);
        var payload = new
        {
            subject = title,
            body = description is null ? null : new { contentType = "text", content = description },
            start = When(startUtc, zone, windows),
            end = When(endUtc, zone, windows),
            attendees = attendees.Select(Attendee),
            isOnlineMeeting = true,
            onlineMeetingProvider = "teamsForBusiness",
            allowNewTimeProposals = true,
            recurrence = Recurrence(recurrenceRule, startUtc, zone),
        };
        using var doc = await SendAsync(HttpMethod.Post, Events, organizerUserId, payload, "create", ct);
        return Parse(doc!.RootElement);
    }

    public async Task<CreatedGoogleMeeting> RescheduleEventAsync(Guid organizerUserId, string eventId, DateTime startUtc, DateTime endUtc, string timeZone, CancellationToken ct = default)
    {
        var (zone, windows) = Zone(timeZone);
        using var doc = await SendAsync(HttpMethod.Patch, $"{Events}/{Uri.EscapeDataString(eventId)}", organizerUserId,
            new { start = When(startUtc, zone, windows), end = When(endUtc, zone, windows) }, "reschedule", ct);
        return Parse(doc!.RootElement);
    }

    /// <summary>Replaces the attendee list (Outlook sends the new invitations and the cancellations itself).</summary>
    public async Task<CreatedGoogleMeeting> UpdateAttendeesAsync(Guid organizerUserId, string eventId, IReadOnlyList<GoogleMeetingAttendee> attendees, CancellationToken ct = default)
    {
        using var doc = await SendAsync(HttpMethod.Patch, $"{Events}/{Uri.EscapeDataString(eventId)}", organizerUserId,
            new { attendees = attendees.Select(Attendee) }, "update participants", ct);
        return Parse(doc!.RootElement);
    }

    /// <summary>Each attendee's real answer from Outlook, in the same words Google uses (accepted, declined, tentative, needsAction).</summary>
    public async Task<IReadOnlyList<GoogleAttendeeStatus>> GetAttendeeStatusAsync(Guid organizerUserId, string eventId, CancellationToken ct = default)
    {
        using var doc = await SendAsync(HttpMethod.Get, $"{Events}/{Uri.EscapeDataString(eventId)}?$select=attendees", organizerUserId, null, "read attendees", ct, missingIsEmpty: true);
        if (doc is null || !doc.RootElement.TryGetProperty("attendees", out var list) || list.ValueKind != JsonValueKind.Array) return [];
        var result = new List<GoogleAttendeeStatus>();
        foreach (var a in list.EnumerateArray())
        {
            var email = a.TryGetProperty("emailAddress", out var e) && e.TryGetProperty("address", out var addr) ? addr.GetString() : null;
            if (string.IsNullOrWhiteSpace(email)) continue;
            var response = a.TryGetProperty("status", out var s) && s.TryGetProperty("response", out var r) ? r.GetString() : null;
            result.Add(new GoogleAttendeeStatus(email, response switch
            {
                "accepted" or "organizer" => "accepted",
                "declined" => "declined",
                "tentativelyAccepted" => "tentative",
                _ => "needsAction",
            }));
        }
        return result;
    }

    /// <summary>Cancels the meeting; Outlook tells every attendee. An event already gone counts as cancelled.</summary>
    public async Task CancelEventAsync(Guid organizerUserId, string eventId, CancellationToken ct = default)
    {
        using var _ = await SendAsync(HttpMethod.Post, $"{Events}/{Uri.EscapeDataString(eventId)}/cancel", organizerUserId,
            new { comment = "This meeting was cancelled in Project Tracker." }, "cancel", ct, missingIsEmpty: true);
    }

    // ------------------------------------------------------------------ helpers

    private static object Attendee(GoogleMeetingAttendee a) => new { emailAddress = new { address = a.Email }, type = a.Optional ? "optional" : "required" };

    /// <summary>Outlook wants a local time and a zone name; Windows names are understood everywhere, IANA names are not.</summary>
    private static (NodaTime.DateTimeZone Zone, string Name) Zone(string timeZone)
    {
        var zone = ZoneTime.IsKnown(timeZone) ? ZoneTime.Find(timeZone) : NodaTime.DateTimeZone.Utc;
        if (zone.Id is "UTC" or "Etc/UTC") return (NodaTime.DateTimeZone.Utc, "UTC");
        if (Windows.TryGetValue(zone.Id, out var known)) return (zone, known);
        // The runtime may carry no time zone mapping (no ICU); an unknown zone is sent as UTC, which is always the right instant.
        return TimeZoneInfo.TryConvertIanaIdToWindowsId(zone.Id, out var windows) ? (zone, windows) : (NodaTime.DateTimeZone.Utc, "UTC");
    }

    /// <summary>Windows names Outlook understands everywhere, for the zones people here schedule in most.</summary>
    private static readonly Dictionary<string, string> Windows = new(StringComparer.OrdinalIgnoreCase)
    {
        ["Asia/Kolkata"] = "India Standard Time", ["Asia/Calcutta"] = "India Standard Time", ["Asia/Dubai"] = "Arabian Standard Time",
        ["Asia/Singapore"] = "Singapore Standard Time", ["Asia/Tokyo"] = "Tokyo Standard Time", ["Asia/Shanghai"] = "China Standard Time",
        ["Asia/Hong_Kong"] = "China Standard Time", ["Asia/Kathmandu"] = "Nepal Standard Time", ["Asia/Dhaka"] = "Bangladesh Standard Time",
        ["Asia/Colombo"] = "Sri Lanka Standard Time", ["Asia/Riyadh"] = "Arab Standard Time", ["Asia/Jakarta"] = "SE Asia Standard Time",
        ["Europe/London"] = "GMT Standard Time", ["Europe/Dublin"] = "GMT Standard Time", ["Europe/Paris"] = "Romance Standard Time",
        ["Europe/Berlin"] = "W. Europe Standard Time", ["Europe/Amsterdam"] = "W. Europe Standard Time", ["Europe/Madrid"] = "Romance Standard Time",
        ["Europe/Rome"] = "W. Europe Standard Time", ["Europe/Zurich"] = "W. Europe Standard Time", ["Europe/Moscow"] = "Russian Standard Time",
        ["America/New_York"] = "Eastern Standard Time", ["America/Chicago"] = "Central Standard Time", ["America/Denver"] = "Mountain Standard Time",
        ["America/Phoenix"] = "US Mountain Standard Time", ["America/Los_Angeles"] = "Pacific Standard Time", ["America/Toronto"] = "Eastern Standard Time",
        ["America/Sao_Paulo"] = "E. South America Standard Time", ["Australia/Sydney"] = "AUS Eastern Standard Time", ["Australia/Melbourne"] = "AUS Eastern Standard Time",
        ["Australia/Perth"] = "W. Australia Standard Time", ["Pacific/Auckland"] = "New Zealand Standard Time", ["Africa/Johannesburg"] = "South Africa Standard Time",
        ["Africa/Nairobi"] = "E. Africa Standard Time", ["Africa/Lagos"] = "W. Central Africa Standard Time",
    };

    private static object When(DateTime utc, NodaTime.DateTimeZone zone, string name) =>
        new { dateTime = ZoneTime.ToLocal(DateTime.SpecifyKind(utc, DateTimeKind.Utc), zone).ToString("yyyy-MM-dd'T'HH:mm:ss"), timeZone = name };

    /// <summary>The three rhythms <see cref="ProjectMeetings.MeetingRecurrence"/> writes (daily, weekdays, weekly; a count), as Graph's pattern.</summary>
    internal static object? Recurrence(string? rule, DateTime startUtc, NodaTime.DateTimeZone zone)
    {
        if (string.IsNullOrWhiteSpace(rule)) return null;
        var parts = rule.Replace("RRULE:", "", StringComparison.OrdinalIgnoreCase).Split(';', StringSplitOptions.RemoveEmptyEntries)
            .Select(p => p.Split('=', 2)).Where(p => p.Length == 2).ToDictionary(p => p[0].ToUpperInvariant(), p => p[1].ToUpperInvariant());
        var count = parts.TryGetValue("COUNT", out var c) && int.TryParse(c, out var n) ? n : 1;
        if (count < 2) return null;
        var local = ZoneTime.ToLocal(DateTime.SpecifyKind(startUtc, DateTimeKind.Utc), zone);
        var range = new { type = "numbered", startDate = local.ToString("yyyy-MM-dd"), numberOfOccurrences = count };
        string Day(DayOfWeek d) => d.ToString().ToLowerInvariant();
        return parts.GetValueOrDefault("FREQ") switch
        {
            "DAILY" => new { pattern = new { type = "daily", interval = 1 }, range },
            "WEEKLY" when parts.GetValueOrDefault("BYDAY") == "MO,TU,WE,TH,FR" =>
                new { pattern = (object)new { type = "weekly", interval = 1, daysOfWeek = new[] { "monday", "tuesday", "wednesday", "thursday", "friday" }, firstDayOfWeek = "monday" }, range },
            "WEEKLY" => new { pattern = (object)new { type = "weekly", interval = 1, daysOfWeek = new[] { Day(local.DayOfWeek) }, firstDayOfWeek = "monday" }, range },
            _ => null,
        };
    }

    private static CreatedGoogleMeeting Parse(JsonElement e)
    {
        string? S(JsonElement o, string name) => o.ValueKind == JsonValueKind.Object && o.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        var id = S(e, "id") ?? throw new TeamsApiException("read", HttpStatusCode.BadGateway);
        var join = e.TryGetProperty("onlineMeeting", out var om) ? S(om, "joinUrl") : null;
        return new CreatedGoogleMeeting(id, join ?? S(e, "onlineMeetingUrl") ?? "", null, S(e, "webLink") ?? "");
    }

    private async Task<JsonDocument?> SendAsync(HttpMethod method, string url, Guid organizerUserId, object? payload, string action, CancellationToken ct, bool missingIsEmpty = false)
    {
        var grant = await auth.GetMeetingsGrantAsync(organizerUserId, ct);
        using var req = new HttpRequestMessage(method, url);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", grant.AccessToken);
        if (payload is not null) req.Content = new StringContent(JsonSerializer.Serialize(payload, Json), Encoding.UTF8, "application/json");
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct); deadline.CancelAfter(TimeSpan.FromSeconds(30));
        HttpResponseMessage res;
        try { res = await http.CreateClient("microsoft-productivity").SendAsync(req, deadline.Token); }
        catch (Exception ex) when (ex is HttpRequestException || ex is OperationCanceledException && !ct.IsCancellationRequested)
        { throw new TeamsApiException(action, HttpStatusCode.GatewayTimeout); }
        using (res)
        {
            if (missingIsEmpty && res.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.Gone) return null;
            if (!res.IsSuccessStatusCode)
            {
                log.LogWarning("Outlook calendar {Action} failed: {Status}", action, (int)res.StatusCode);
                throw new TeamsApiException(action, res.StatusCode);
            }
            if (res.StatusCode is HttpStatusCode.Accepted or HttpStatusCode.NoContent) return null;
            var body = await res.Content.ReadAsStringAsync(ct);
            if (string.IsNullOrWhiteSpace(body)) return null;
            try { return JsonDocument.Parse(body); }
            catch (JsonException) { throw new TeamsApiException(action, HttpStatusCode.BadGateway); }
        }
    }
}
