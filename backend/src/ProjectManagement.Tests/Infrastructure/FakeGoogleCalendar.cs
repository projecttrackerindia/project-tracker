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
    /// <summary>Which grant each issued access token belongs to, so /oauth2/v2/userinfo answers for the token actually presented rather than
    /// an arbitrary grant - this dictionary accumulates across every test in the collection, so "any" grant is never a safe stand-in.</summary>
    private readonly ConcurrentDictionary<string, Grant> _accessTokens = new();
    private readonly ConcurrentDictionary<string, JsonElement> _events = new();
    public ConcurrentBag<string> AccessTokensIssued { get; } = new();
    public ConcurrentBag<string> RevokedTokens { get; } = new();
    /// <summary>When set, every token-endpoint call fails (simulates an expired/revoked grant, for GOOGLE_TOKEN_EXPIRED tests).</summary>
    public bool RefreshFails { get; set; }
    public Action? BeforeRefresh {get;set;}
    public ConcurrentBag<string> SentMail { get; } = new();
    public bool MailOutcomeUnknown { get; set; }
    public bool UserInfoFails { get; set; }
    public bool OmitRefreshToken { get; set; }
    public FakeInboxMailbox Inbox {get;}=new();

    public bool PersonalCalendarBlocked {get;set;}
    public bool PersonalCalendarPaged {get;set;}
    public bool PersonalCalendarResponseLost {get;set;}
    public bool PersonalCalendarReadMismatch {get;set;}
    public Action? BeforePersonalCalendarList {get;set;}
    public ConcurrentBag<string> PersonalCalendarCreates {get;}=new();
    private readonly ConcurrentDictionary<string,JsonElement> _personalCalendarEvents=new();
    public void ResetPersonalCalendar(){PersonalCalendarBlocked=false;PersonalCalendarPaged=false;PersonalCalendarResponseLost=false;PersonalCalendarReadMismatch=false;BeforePersonalCalendarList=null;BeforeRefresh=null;}
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
                _accessTokens[access] = grant;
                AccessTokensIssued.Add(access);
                return Json(new { access_token = access, refresh_token = OmitRefreshToken?null:refresh, expires_in = 3600, scope = grant.Scope, token_type = "Bearer" });
            }
            if (form.GetValueOrDefault("grant_type") == "refresh_token")
            {
                BeforeRefresh?.Invoke();
                if (!_refreshTokens.TryGetValue(form.GetValueOrDefault("refresh_token") ?? "", out var grant)) return Json(new { error = "invalid_grant" }, HttpStatusCode.BadRequest);
                var access = "at_" + Convert.ToHexString(RandomNumberGenerator.GetBytes(8));
                _accessTokens[access] = grant;
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
            if(UserInfoFails)return Json(new{error="unavailable"},HttpStatusCode.ServiceUnavailable);
            var auth = request.Headers.Authorization?.Parameter ?? "";
            _accessTokens.TryGetValue(auth, out var grant);
            return Json(new { email = grant?.Email ?? "owner@example.com" });
        }
        if(u.Host=="gmail.googleapis.com"&&request.Method==HttpMethod.Get&&path.StartsWith("/gmail/v1/users/me/")){
            var token=request.Headers.Authorization?.Parameter??"";
            if(!_accessTokens.TryGetValue(token,out var grant)||!grant.Scope.Split(' ').Contains("https://www.googleapis.com/auth/gmail.readonly"))return Json(new{error="permission"},HttpStatusCode.Forbidden);
            return Inbox.Read(request,grant.Email,true);
        }
        if(path=="/calendar/v3/calendars/primary/events"&&request.Method==HttpMethod.Get&&u.Query.Contains("singleEvents=true")){
            BeforePersonalCalendarList?.Invoke();
            if(PersonalCalendarPaged)return Json(new{items=Array.Empty<object>(),nextPageToken="more"});
            return Json(new{items=PersonalCalendarBlocked?new object[]{new{status="confirmed",transparency="opaque"}}:Array.Empty<object>()});
        }
        if(path=="/calendar/v3/calendars/primary/events"&&request.Method==HttpMethod.Post){
            using var proposed=JsonDocument.Parse(await request.Content!.ReadAsStringAsync(ct));
            if(proposed.RootElement.TryGetProperty("id",out var given)&&given.GetString() is {} id&&id.StartsWith("pt")){
                var token=request.Headers.Authorization?.Parameter??"";
                if(!_accessTokens.TryGetValue(token,out var grant))return Json(new{error="invalid_grant"},HttpStatusCode.Unauthorized);
                var fields=JsonSerializer.Deserialize<Dictionary<string,JsonElement>>(proposed.RootElement.GetRawText())!;
                fields["status"]=JsonSerializer.SerializeToElement("confirmed");
                var result=JsonSerializer.SerializeToElement(fields);
                if(!_personalCalendarEvents.TryAdd(grant.Email+":"+id,result))return Json(new{error="duplicate"},HttpStatusCode.Conflict);
                PersonalCalendarCreates.Add(id);
                if(PersonalCalendarResponseLost)throw new HttpRequestException("Fake Calendar response lost");
                return Json(result);
            }
        }
        if(path.StartsWith("/calendar/v3/calendars/primary/events/pt")&&request.Method==HttpMethod.Get){
            var token=request.Headers.Authorization?.Parameter??"";
            if(!_accessTokens.TryGetValue(token,out var grant))return Json(new{error="invalid_grant"},HttpStatusCode.Unauthorized);
            var id=path.Split('/').Last();
            if(!_personalCalendarEvents.TryGetValue(grant.Email+":"+id,out var saved))return Json(new{error="missing"},HttpStatusCode.NotFound);
            if(PersonalCalendarReadMismatch){var fields=JsonSerializer.Deserialize<Dictionary<string,JsonElement>>(saved.GetRawText())!;fields["summary"]=JsonSerializer.SerializeToElement("Changed outside the application");return Json(fields);}
            return Json(saved);
        }
        if(path=="/gmail/v1/users/me/messages/send"&&request.Method==HttpMethod.Post){
            var auth=request.Headers.Authorization?.Parameter??"";
            if(!_accessTokens.TryGetValue(auth,out var mailGrant)||!mailGrant.Scope.Split(' ').Contains("https://www.googleapis.com/auth/gmail.send"))
                return Json(new{error="missing_scope"},HttpStatusCode.Forbidden);
            using var payload=JsonDocument.Parse(await request.Content!.ReadAsStringAsync(ct));
            var raw=payload.RootElement.GetProperty("raw").GetString()!.Replace('-','+').Replace('_','/');
            SentMail.Add(System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(raw.PadRight((raw.Length+3)/4*4,'='))));
            if(MailOutcomeUnknown)throw new HttpRequestException("Simulated response lost after provider acceptance");
            return Json(new{id="mail_"+Convert.ToHexString(RandomNumberGenerator.GetBytes(6))});
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
            if (request.Method == HttpMethod.Get)
            {
                if (!_events.TryGetValue(id, out var existing)) return Json(new { error = new { message = "Not Found" } }, HttpStatusCode.NotFound);
                return Json(existing);
            }
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

    /// <summary>A test stands in for "the attendee responded on Google's side" - our own app never sets this, so the only way to put a
    /// responseStatus on a stored event is this direct, out-of-band mutation, the same way a real person clicking a link in their inbox would.</summary>
    public void SetResponseStatus(string eventId, string email, string status)
    {
        if (!_events.TryGetValue(eventId, out var existing)) return;
        var attendees = new List<object>();
        if (existing.TryGetProperty("attendees", out var list))
            foreach (var a in list.EnumerateArray())
            {
                var aEmail = a.GetProperty("email").GetString();
                var aStatus = string.Equals(aEmail, email, StringComparison.OrdinalIgnoreCase) ? status : (a.TryGetProperty("responseStatus", out var r) ? r.GetString() : "needsAction");
                attendees.Add(new { email = aEmail, responseStatus = aStatus });
            }
        using var doc = JsonDocument.Parse(JsonSerializer.Serialize(new { attendees }));
        _events[eventId] = Merge(eventId, doc.RootElement, existing);
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
            attendees = req.TryGetProperty("attendees", out var at) ? at : (existing?.TryGetProperty("attendees", out var ea) == true ? ea : (object?)null),
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
