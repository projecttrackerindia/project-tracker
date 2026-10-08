using System.Collections.Concurrent;
using System.Net;
using System.Security.Cryptography;
using System.Text.Json;

namespace ProjectManagement.Tests.Infrastructure;

/// <summary>
/// Stands in for Google's OAuth token endpoint and the Calendar API, for the "google-calendar" named HTTP client. A test registers what an
/// authorization code should redeem as with <see cref="IssueCode"/>; everything after that (refresh, event create/reschedule/cancel) just
/// works against in-memory state, the same way a real Google account would answer.
/// </summary>
public sealed class FakeGoogleCalendar : HttpMessageHandler
{
    private sealed record Grant(string Email, string Scope);
    private readonly ConcurrentDictionary<string, Grant> _codes = new();
    private readonly ConcurrentDictionary<string, Grant> _refreshTokens = new();
    private readonly ConcurrentDictionary<string, JsonElement> _events = new();
    public ConcurrentBag<string> AccessTokensIssued { get; } = new();
    public ConcurrentBag<string> RevokedTokens { get; } = new();
    /// <summary>When set, every token-endpoint call fails (simulates an expired/revoked grant, for GOOGLE_TOKEN_EXPIRED tests).</summary>
    public bool RefreshFails { get; set; }

    public string IssueCode(string email = "owner@example.com", string scope = "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/meetings.space.created")
    {
        var code = Convert.ToHexString(RandomNumberGenerator.GetBytes(12));
        _codes[code] = new Grant(email, scope);
        return code;
    }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        var u = request.RequestUri!;
        var path = u.AbsolutePath;

        if (path == "/token" && request.Method == HttpMethod.Post)
        {
            var form = (await request.Content!.ReadAsStringAsync(ct)).Split('&').Select(x => x.Split('=', 2))
                .ToDictionary(x => Uri.UnescapeDataString(x[0]), x => Uri.UnescapeDataString(x.ElementAtOrDefault(1) ?? ""));
            if (RefreshFails) return Json(new { error = "invalid_grant" }, HttpStatusCode.BadRequest);
            if (form.GetValueOrDefault("grant_type") == "authorization_code")
            {
                if (!_codes.TryRemove(form.GetValueOrDefault("code") ?? "", out var grant)) return Json(new { error = "invalid_grant" }, HttpStatusCode.BadRequest);
                var refresh = "rt_" + Convert.ToHexString(RandomNumberGenerator.GetBytes(8));
                _refreshTokens[refresh] = grant;
                var access = "at_" + Convert.ToHexString(RandomNumberGenerator.GetBytes(8));
                AccessTokensIssued.Add(access);
                return Json(new { access_token = access, refresh_token = refresh, expires_in = 3600, scope = grant.Scope, token_type = "Bearer" });
            }
            if (form.GetValueOrDefault("grant_type") == "refresh_token")
            {
                if (!_refreshTokens.ContainsKey(form.GetValueOrDefault("refresh_token") ?? "")) return Json(new { error = "invalid_grant" }, HttpStatusCode.BadRequest);
                var access = "at_" + Convert.ToHexString(RandomNumberGenerator.GetBytes(8));
                AccessTokensIssued.Add(access);
                return Json(new { access_token = access, expires_in = 3600, token_type = "Bearer" });
            }
            return Json(new { error = "unsupported_grant_type" }, HttpStatusCode.BadRequest);
        }
        if (path == "/revoke" && request.Method == HttpMethod.Post)
        {
            var form = (await request.Content!.ReadAsStringAsync(ct)).Split('&').Select(x => x.Split('=', 2)).ToDictionary(x => x[0], x => x.ElementAtOrDefault(1) ?? "");
            RevokedTokens.Add(form.GetValueOrDefault("token", ""));
            return Json(new { });
        }
        if (path == "/oauth2/v2/userinfo")
        {
            var auth = request.Headers.Authorization?.Parameter ?? "";
            var grant = _refreshTokens.Values.FirstOrDefault(); // any issued grant stands in for "whoever this access token belongs to" - fine for tests
            return Json(new { email = grant?.Email ?? "owner@example.com" });
        }
        if (path.StartsWith("/calendar/v3/calendars/primary/events") && request.Method == HttpMethod.Post)
        {
            var id = "evt_" + Convert.ToHexString(RandomNumberGenerator.GetBytes(6));
            using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(ct));
            var ev = Merge(id, body.RootElement);
            _events[id] = ev;
            return Json(ev);
        }
        if (path.StartsWith("/calendar/v3/calendars/primary/events/"))
        {
            var id = path[(path.LastIndexOf('/') + 1)..];
            if (request.Method == HttpMethod.Delete)
            {
                _events.TryRemove(id, out _);
                return new HttpResponseMessage(HttpStatusCode.NoContent);
            }
            if (request.Method == HttpMethod.Patch)
            {
                if (!_events.TryGetValue(id, out var existing)) return Json(new { error = new { message = "Not Found" } }, HttpStatusCode.NotFound);
                using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(ct));
                var ev = Merge(id, body.RootElement, existing);
                _events[id] = ev;
                return Json(ev);
            }
        }
        return new HttpResponseMessage(HttpStatusCode.NotFound);
    }

    /// <summary>Builds (or updates) the event JSON the client expects back: an id, htmlLink, and - the first time, or whenever the request
    /// asked for one - a conferenceData block with a fake Meet entry point, the way Calendar really answers conferenceDataVersion=1.</summary>
    private static JsonElement Merge(string id, JsonElement req, JsonElement? existing = null)
    {
        using var doc = JsonDocument.Parse(JsonSerializer.Serialize(new
        {
            id,
            htmlLink = $"https://calendar.google.com/event?eid={id}",
            summary = Prop(req, "summary") ?? Prop(existing, "summary"),
            start = req.TryGetProperty("start", out var s) ? s : existing?.GetProperty("start"),
            end = req.TryGetProperty("end", out var e) ? e : existing?.GetProperty("end"),
            conferenceData = req.TryGetProperty("conferenceData", out _) || existing is null
                ? new { conferenceId = $"meet-{id}", entryPoints = new[] { new { entryPointType = "video", uri = $"https://meet.google.com/{id}" } } }
                : (object?)(existing?.TryGetProperty("conferenceData", out var cd) == true ? cd : null),
        }));
        return doc.RootElement.Clone();
    }

    private static string? Prop(JsonElement? e, string name) => e is { } v && v.TryGetProperty(name, out var p) ? p.GetString() : null;

    private static HttpResponseMessage Json(object body, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(JsonSerializer.Serialize(body), System.Text.Encoding.UTF8, "application/json") };
}
