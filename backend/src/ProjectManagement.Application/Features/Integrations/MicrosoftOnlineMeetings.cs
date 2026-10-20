using System.Globalization;
using System.Net.Http.Headers;
using System.Text.Json;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Exceptions;

namespace ProjectManagement.Application.Features.Integrations;

/// <summary>
/// For the project agent only: the online meetings (Microsoft Teams, or a Google Meet link) on the acting person's own Outlook calendar in the
/// next few minutes, so the meeting bot can be sent to the ones that name the project. Reads the subject, times and join link of the
/// person's own events (Calendars.ReadBasic: never bodies or attendees), and only when that person connected Outlook calendars and the agent
/// is set to join calls from the calendar. Nothing is stored except what the bot needs to join.
/// </summary>
public class MicrosoftOnlineMeetings(MicrosoftProductivityAuthService auth, IOptions<MicrosoftProductivityOptions> options, IHttpClientFactory http)
{
    private static readonly string[] JoinHosts = ["teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft", "meet.google.com"];

    /// <summary>Whether this is a link the meeting bot can join (Teams or Google Meet, https).</summary>
    public static bool Joinable(string? url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var u) && u.Scheme == Uri.UriSchemeHttps && JoinHosts.Contains(u.Host, StringComparer.OrdinalIgnoreCase) && url!.Length <= 1000;

    public static string Platform(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var u) && u.Host.Contains("teams", StringComparison.OrdinalIgnoreCase) ? "Microsoft Teams" : "Google Meet";

    /// <summary>The current person's online meetings starting between the two instants (empty when Outlook calendars are not connected).</summary>
    public async Task<IReadOnlyList<CalendarMeet>> ListUpcomingAsync(DateTime fromUtc, DateTime toUtc, CancellationToken ct)
    {
        if (!options.Value.Enabled || !options.Value.CalendarsEnabled) return [];
        MicrosoftMailGrant grant;
        try { grant = await auth.GetCalendarGrantAsync(ct); }
        catch (AppException) { return []; }   // not connected, or without the calendar permission
        var query = "calendarView?$top=50&$select=id,subject,start,end,isCancelled,isOnlineMeeting,onlineMeeting,onlineMeetingUrl" +
                    "&startDateTime=" + Uri.EscapeDataString(fromUtc.ToString("o", CultureInfo.InvariantCulture)) +
                    "&endDateTime=" + Uri.EscapeDataString(toUtc.ToString("o", CultureInfo.InvariantCulture));
        using var request = new HttpRequestMessage(HttpMethod.Get, "https://graph.microsoft.com/v1.0/me/" + query);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", grant.AccessToken);
        request.Headers.Add("Prefer", "outlook.timezone=\"UTC\"");
        using var response = await http.CreateClient("microsoft-productivity").SendAsync(request, ct);
        if (!response.IsSuccessStatusCode) throw new ConflictException("Outlook did not list the calendar's meetings.", "MICROSOFT_CALENDAR_UNAVAILABLE");
        var body = await response.Content.ReadAsStringAsync(ct);
        if (body.Length > 512_000) throw new ConflictException("The calendar answer was too large.", "MICROSOFT_CALENDAR_UNAVAILABLE");
        return Parse(body, fromUtc, toUtc);
    }

    /// <summary>The Graph calendarView answer as meetings with a joinable link that start in [from, to] (public for tests).</summary>
    public static IReadOnlyList<CalendarMeet> Parse(string json, DateTime fromUtc, DateTime toUtc)
    {
        using var doc = JsonDocument.Parse(json);
        if (!doc.RootElement.TryGetProperty("value", out var items) || items.ValueKind != JsonValueKind.Array) return [];
        var list = new List<CalendarMeet>();
        foreach (var e in items.EnumerateArray().Take(50))
        {
            if (e.ValueKind != JsonValueKind.Object) continue;
            if (e.TryGetProperty("isCancelled", out var c) && c.ValueKind == JsonValueKind.True) continue;
            string? link = null;
            if (e.TryGetProperty("onlineMeeting", out var om) && om.ValueKind == JsonValueKind.Object && om.TryGetProperty("joinUrl", out var j) && j.ValueKind == JsonValueKind.String) link = j.GetString();
            if (link is null && e.TryGetProperty("onlineMeetingUrl", out var u) && u.ValueKind == JsonValueKind.String) link = u.GetString();
            if (!Joinable(link)) continue;
            if (Time(e, "start") is not { } start || Time(e, "end") is not { } end || end <= start || start < fromUtc || start > toUtc) continue;
            var id = e.TryGetProperty("id", out var i) && i.ValueKind == JsonValueKind.String ? i.GetString() ?? "" : "";
            var subject = e.TryGetProperty("subject", out var s) && s.ValueKind == JsonValueKind.String ? s.GetString() ?? "" : "";
            if (id.Length is 0 or > 500) continue;
            list.Add(new CalendarMeet("ms:" + id[..Math.Min(id.Length, 190)], subject.Length > 300 ? subject[..300] : subject, start, end, link!));
        }
        return list;
    }

    private static DateTime? Time(JsonElement e, string name)
    {
        if (!e.TryGetProperty(name, out var t) || t.ValueKind != JsonValueKind.Object || !t.TryGetProperty("dateTime", out var d) || d.ValueKind != JsonValueKind.String) return null;
        return DateTime.TryParse(d.GetString(), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var at)
            ? DateTime.SpecifyKind(at, DateTimeKind.Utc) : null;
    }
}
