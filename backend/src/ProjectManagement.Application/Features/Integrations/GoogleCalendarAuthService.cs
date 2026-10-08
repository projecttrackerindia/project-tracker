using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Distributed;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Integrations;

/// <summary>
/// A separate OAuth client from "Sign in with Google" (<see cref="Sso.ExternalAuthOptions"/>): that one only authenticates a browser
/// session and never keeps a token. This one asks for Calendar/Meet scopes and keeps a refresh token, because creating a meeting later
/// (possibly from a background job, never while the person is watching) needs to call Google without them being present.
/// </summary>
public class GoogleCalendarOptions
{
    public const string Section = "GoogleCalendar";
    public string? ClientId { get; set; }
    public string? ClientSecret { get; set; }
    public string? RedirectUri { get; set; }
    public bool Configured => !string.IsNullOrWhiteSpace(ClientId) && !string.IsNullOrWhiteSpace(ClientSecret) && !string.IsNullOrWhiteSpace(RedirectUri);
}

public record GoogleConnectionStatusDto(bool Connected, string? GoogleEmail, DateTime? ConnectedAt, string? LastError);

/// <summary>
/// Connecting a person's own Google account (Settings &gt; Integrations &gt; Google Workspace), and keeping a usable access token for it.
/// A meeting is organized as the actual Project Tracker person who scheduled it, so the grant is per-person, never a shared workspace
/// credential (see spec: "the organizer must only be able to select users ... never bypass existing Project Tracker authorization" - that
/// authorization starts with each organizer acting through their own Google identity). The refresh token is the only long-lived secret;
/// it is encrypted at rest with <see cref="ISecretProtector"/> and is never sent to the browser or logged.
/// </summary>
public class GoogleCalendarAuthService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, IDistributedCache cache,
    IOptions<GoogleCalendarOptions> options, IHttpClientFactory http, ISecretProtector secrets, ILogger<GoogleCalendarAuthService> log)
{
    private readonly GoogleCalendarOptions _o = options.Value;
    private static readonly TimeSpan StateLife = TimeSpan.FromMinutes(10);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    /// <summary>calendar.events: create/update/cancel events and invite attendees. meetings.space.created: give the event a Meet conference.
    /// userinfo.email: the one thing shown back to the person in Settings ("Connected account: name@work.com") - without it, the userinfo
    /// endpoint FetchEmailAsync calls returns no email field at all, and the connection would show no address, not an error. Deliberately
    /// not the broader "calendar" scope (full read/write of every calendar), "profile", or anything touching Drive/Gmail.</summary>
    public const string Scopes = "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/meetings.space.created https://www.googleapis.com/auth/userinfo.email";

    private sealed record Pending(Guid TenantId, Guid UserId, string ReturnUrl);

    public bool Configured => _o.Configured;

    public async Task<GoogleConnectionStatusDto> StatusAsync(CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var c = await db.GoogleConnections.AsNoTracking().FirstOrDefaultAsync(x => x.UserId == uid, ct);
        return c is null ? new GoogleConnectionStatusDto(false, null, null, null) : new GoogleConnectionStatusDto(true, c.GoogleEmail, c.ConnectedAt, c.LastError);
    }

    /// <summary>Where to send the browser so the person can grant Project Tracker Calendar/Meet access.</summary>
    public async Task<string> StartConnectAsync(string? returnUrl, CancellationToken ct = default)
    {
        if (!Configured) throw new ConflictException("Google Calendar is not set up for this installation.", "GOOGLE_NOT_CONFIGURED");
        var tid = ctx.RequireTenantId(); var uid = ctx.RequireUserId();
        var id = Random(24);
        await cache.SetStringAsync($"google-cal:{id}", JsonSerializer.Serialize(new Pending(tid, uid, SafeReturnUrl(returnUrl)), Json),
            new DistributedCacheEntryOptions { AbsoluteExpirationRelativeToNow = StateLife }, ct);
        return Query("https://accounts.google.com/o/oauth2/v2/auth", new Dictionary<string, string?>
        {
            ["client_id"] = _o.ClientId, ["redirect_uri"] = _o.RedirectUri, ["response_type"] = "code", ["scope"] = Scopes,
            // offline + consent: Google only hands back a refresh token when consent is actually (re-)shown, which this guarantees every time.
            ["access_type"] = "offline", ["prompt"] = "consent", ["include_granted_scopes"] = "true", ["state"] = id,
        });
    }

    /// <summary>The redirect back from Google: exchanges the code for tokens, stores the connection, and says where the browser should land.</summary>
    public async Task<string> CompleteConnectAsync(string? code, string? state, string? error, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(state) || state.Length > 100) throw new UnauthorizedException("This connection attempt is not valid. Start again.", "GOOGLE_STATE_INVALID");
        var key = $"google-cal:{state}";
        var json = await cache.GetStringAsync(key, ct);
        if (json is null) throw new UnauthorizedException("This connection attempt has expired. Start again.", "GOOGLE_STATE_EXPIRED");
        await cache.RemoveAsync(key, ct);
        var p = JsonSerializer.Deserialize<Pending>(json, Json)!;
        if (!string.IsNullOrEmpty(error) || string.IsNullOrWhiteSpace(code))
        {
            log.LogInformation("Google Calendar connection was not completed: {Error}", error ?? "no code returned");
            return $"{p.ReturnUrl}?google=declined";
        }

        var form = new Dictionary<string, string>
        {
            ["grant_type"] = "authorization_code", ["code"] = code!, ["redirect_uri"] = _o.RedirectUri!,
            ["client_id"] = _o.ClientId!, ["client_secret"] = _o.ClientSecret!,
        };
        using var tokenResponse = await http.CreateClient("google-calendar").PostAsync("https://oauth2.googleapis.com/token", new FormUrlEncodedContent(form), ct);
        var body = await tokenResponse.Content.ReadAsStringAsync(ct);
        if (!tokenResponse.IsSuccessStatusCode)
        {
            log.LogWarning("Google's token endpoint answered {Status}: {Body}", (int)tokenResponse.StatusCode, body.Length > 300 ? body[..300] : body);
            return $"{p.ReturnUrl}?google=error";
        }
        var doc = JsonDocument.Parse(body).RootElement;
        var accessToken = doc.GetProperty("access_token").GetString()!;
        var expiresIn = doc.TryGetProperty("expires_in", out var e) ? e.GetInt32() : 3600;
        var grantedScopes = doc.TryGetProperty("scope", out var s) ? s.GetString() ?? "" : "";
        // Google returns a refresh token only the first time a person consents - prompt=consent above forces that every time we ask.
        var refreshToken = doc.TryGetProperty("refresh_token", out var r) ? r.GetString() : null;
        var email = await FetchEmailAsync(accessToken, ct);

        var existing = await db.GoogleConnections.FirstOrDefaultAsync(x => x.TenantId == p.TenantId && x.UserId == p.UserId, ct);
        if (existing is null)
        {
            if (refreshToken is null)
            {
                log.LogWarning("Google did not return a refresh token on first consent for user {User}", p.UserId);
                return $"{p.ReturnUrl}?google=error";
            }
            existing = new GoogleConnection { TenantId = p.TenantId, UserId = p.UserId, CreatedAt = clock.Now, CreatedBy = p.UserId };
            db.GoogleConnections.Add(existing);
        }
        existing.GoogleEmail = email ?? existing.GoogleEmail;
        if (refreshToken is not null) existing.RefreshTokenProtected = secrets.Protect(refreshToken);
        existing.AccessTokenProtected = secrets.Protect(accessToken);
        existing.AccessTokenExpiresAt = clock.Now.AddSeconds(expiresIn - 60);
        existing.Scopes = grantedScopes;
        existing.ConnectedAt = clock.Now;
        existing.LastError = null;
        recorder.Audit("google_connection.connected", "GoogleConnection", existing.Id, tenantId: p.TenantId, userId: p.UserId);
        await db.SaveChangesAsync(ct);
        return $"{p.ReturnUrl}?google=connected";
    }

    public async Task DisconnectAsync(CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var c = await db.GoogleConnections.FirstOrDefaultAsync(x => x.UserId == uid, ct);
        if (c is null) return;
        // Best effort: tell Google the grant is no longer wanted. This must never block removing our own record even if it fails.
        try
        {
            using var revoke = new FormUrlEncodedContent(new Dictionary<string, string> { ["token"] = secrets.Unprotect(c.RefreshTokenProtected) });
            await http.CreateClient("google-calendar").PostAsync("https://oauth2.googleapis.com/revoke", revoke, ct);
        }
        catch (Exception ex) { log.LogWarning(ex, "Could not revoke the Google grant for user {User}; removing the local connection anyway", uid); }
        db.GoogleConnections.Remove(c);
        recorder.Audit("google_connection.disconnected", "GoogleConnection", c.Id);
        await db.SaveChangesAsync(ct);
    }

    /// <summary>A valid access token for this user's Google account, refreshing it first when it has expired or is about to. Used by
    /// <see cref="GoogleMeetingClient"/>; never returned to the browser.</summary>
    public async Task<string> GetAccessTokenAsync(Guid userId, CancellationToken ct = default)
    {
        var c = await db.GoogleConnections.FirstOrDefaultAsync(x => x.UserId == userId, ct)
            ?? throw new ConflictException("Connect your Google account to schedule Google Meet meetings.", "GOOGLE_NOT_CONNECTED");
        if (c.AccessTokenProtected is not null && c.AccessTokenExpiresAt > clock.Now) return secrets.Unprotect(c.AccessTokenProtected);

        var form = new Dictionary<string, string>
        {
            ["grant_type"] = "refresh_token", ["refresh_token"] = secrets.Unprotect(c.RefreshTokenProtected),
            ["client_id"] = _o.ClientId!, ["client_secret"] = _o.ClientSecret!,
        };
        using var tokenResponse = await http.CreateClient("google-calendar").PostAsync("https://oauth2.googleapis.com/token", new FormUrlEncodedContent(form), ct);
        var body = await tokenResponse.Content.ReadAsStringAsync(ct);
        if (!tokenResponse.IsSuccessStatusCode)
        {
            c.LastError = "Your Google connection needs to be renewed.";
            await db.SaveChangesAsync(ct);
            log.LogWarning("Google token refresh failed for user {User}: {Status} {Body}", userId, (int)tokenResponse.StatusCode, body.Length > 300 ? body[..300] : body);
            throw new ConflictException("Your Google connection needs to be renewed.", "GOOGLE_TOKEN_EXPIRED");
        }
        var doc = JsonDocument.Parse(body).RootElement;
        var accessToken = doc.GetProperty("access_token").GetString()!;
        var expiresIn = doc.TryGetProperty("expires_in", out var e) ? e.GetInt32() : 3600;
        c.AccessTokenProtected = secrets.Protect(accessToken);
        c.AccessTokenExpiresAt = clock.Now.AddSeconds(expiresIn - 60);
        c.LastSyncAt = clock.Now;
        c.LastError = null;
        await db.SaveChangesAsync(ct);
        return accessToken;
    }

    private async Task<string?> FetchEmailAsync(string accessToken, CancellationToken ct)
    {
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, "https://www.googleapis.com/oauth2/v2/userinfo");
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
            using var res = await http.CreateClient("google-calendar").SendAsync(req, ct);
            if (!res.IsSuccessStatusCode) return null;
            var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync(ct)).RootElement;
            return doc.TryGetProperty("email", out var e) ? e.GetString() : null;
        }
        catch { return null; }   // the connection still succeeds without a display email; it is only shown as "Google connected"
    }

    private static string Random(int bytes) => Convert.ToBase64String(RandomNumberGenerator.GetBytes(bytes)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    private static string SafeReturnUrl(string? url) =>
        !string.IsNullOrWhiteSpace(url) && url.StartsWith('/') && !url.StartsWith("//") && !url.Contains("://") ? url : "/settings/google-workspace";
    private static string Query(string endpoint, IEnumerable<KeyValuePair<string, string?>> values) =>
        endpoint + (endpoint.Contains('?') ? "&" : "?") + string.Join('&', values.Where(v => v.Value is not null).Select(v => $"{Uri.EscapeDataString(v.Key)}={Uri.EscapeDataString(v.Value!)}"));
}
