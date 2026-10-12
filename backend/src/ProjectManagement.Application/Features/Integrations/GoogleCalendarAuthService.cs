using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using System.Text;
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
    public bool MailEnabled {get;set;}
    public bool InboxEnabled {get;set;}
    public bool PersonalCalendarEnabled {get;set;} // New personal calendar operations default off.
    public bool Configured => !string.IsNullOrWhiteSpace(ClientId) && !string.IsNullOrWhiteSpace(ClientSecret) && !string.IsNullOrWhiteSpace(RedirectUri);
}

public record GoogleConnectionStatusDto(bool Connected, string? GoogleEmail, DateTime? ConnectedAt, string? LastError, bool CalendarAccess=false,bool MailEnabled=false,bool MailSendAccess=false,bool InboxEnabled=false,bool InboxAccess=false);
public record GoogleAccessGrant(Guid ConnectionId,string RefreshFingerprint,string Account,string AccessToken,Guid ConsentEpoch=default);

/// <summary>
/// Connecting a person's own Google account (Settings &gt; Integrations &gt; Google Workspace), and keeping a usable access token for it.
/// A meeting is organized as the actual Project Tracker person who scheduled it, so the grant is per-person, never a shared workspace
/// credential (see spec: "the organizer must only be able to select users ... never bypass existing Project Tracker authorization" - that
/// authorization starts with each organizer acting through their own Google identity). The refresh token is the only long-lived secret;
/// it is encrypted at rest with <see cref="ISecretProtector"/> and is never sent to the browser or logged.
/// </summary>
public class GoogleCalendarAuthService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, IServiceProvider services,
    IOptions<GoogleCalendarOptions> options, IHttpClientFactory http, ISecretProtector secrets, ILogger<GoogleCalendarAuthService> log)
{
    private readonly GoogleCalendarOptions _o = options.Value;
    private static readonly TimeSpan StateLife = TimeSpan.FromMinutes(10);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    /// <summary>calendar.events: create/update/cancel events and invite attendees. meetings.space.created: give the event a Meet conference.
    /// userinfo.email: the one thing shown back to the person in Settings ("Connected account: name@work.com") - without it, the userinfo
    /// endpoint FetchEmailAsync calls returns no email field at all, and the connection would show no address, not an error. Deliberately
    /// not the broader "calendar" scope (full read/write of every calendar), "profile", or anything touching Drive. Optional Gmail sending is requested separately.</summary>
    public const string MailScope="https://www.googleapis.com/auth/gmail.send";
    public const string InboxScope="https://www.googleapis.com/auth/gmail.readonly";
    public const string Scopes = "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/meetings.space.created https://www.googleapis.com/auth/userinfo.email";

    private static string Hash(string value)=>Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    private static bool HasCalendarScope(string scopes)=>scopes.Split((char)32,StringSplitOptions.RemoveEmptyEntries).Contains("https://www.googleapis.com/auth/calendar.events");
    public bool Configured => _o.Configured;

    public async Task<GoogleConnectionStatusDto> StatusAsync(CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var c = await db.GoogleConnections.AsNoTracking().FirstOrDefaultAsync(x => x.UserId == uid, ct);
        return c is null ? new GoogleConnectionStatusDto(false, null, null, null,false,_o.MailEnabled&&Configured,false,_o.InboxEnabled&&Configured,false) : new GoogleConnectionStatusDto(true, c.GoogleEmail, c.ConnectedAt, c.LastError, HasCalendarScope(c.Scopes),_o.MailEnabled&&Configured,c.Scopes.Split((char)32).Contains(MailScope),_o.InboxEnabled&&Configured,c.Scopes.Split((char)32).Contains(InboxScope));
    }

    /// <summary>Where to send the browser so the person can grant Project Tracker Calendar/Meet access.</summary>
    public async Task<string> StartConnectAsync(string? returnUrl, string browserProof, CancellationToken ct = default,bool mail=false,bool inbox=false)
    {
        if (!Configured) throw new ConflictException("Google Calendar is not set up for this installation.", "GOOGLE_NOT_CONFIGURED");
        if(mail&&!_o.MailEnabled)throw new ConflictException("Gmail sending is not enabled for this installation.","GMAIL_DISABLED");
        if(inbox&&!_o.InboxEnabled)throw new ConflictException("Gmail inbox access is not enabled for this installation.","INBOX_DISABLED");
        if(mail&&inbox)throw new ValidationException("inbox","Grant sending and inbox reading in their separate consent steps.");
        var requested=inbox?InboxScope+" https://www.googleapis.com/auth/userinfo.email":mail?MailScope+" https://www.googleapis.com/auth/userinfo.email":Scopes;
        var tid = ctx.RequireTenantId(); var uid = ctx.RequireUserId();
        if(string.IsNullOrWhiteSpace(browserProof)||browserProof.Length>100)throw new UnauthorizedException("Start the connection from this browser.","GOOGLE_BROWSER_INVALID");
        var id=Random(32);
        await using(var tx=await db.Database.BeginOwnedTransactionAsync(ct)){
            var locked=await db.Users.Where(u=>u.Id==uid&&u.IsActive).ExecuteUpdateAsync(s=>s.SetProperty(u=>u.IsActive,u=>u.IsActive),ct);
            if(locked!=1)throw new ForbiddenException("Your account is unavailable.");
            await db.ProviderOAuthAttempts.Where(x=>x.ExpiresAt<clock.Now).Take(100).ExecuteDeleteAsync(ct);
            if(await db.ProviderOAuthAttempts.CountAsync(x=>x.UserId==uid&&x.Provider=="google"&&x.ExpiresAt>clock.Now&&x.ConsumedAt==null,ct)>=5)
                throw new ConflictException("Finish an existing Google connection attempt or wait ten minutes.");
            db.ProviderOAuthAttempts.Add(new ProviderOAuthAttempt{Provider="google",TenantId=tid,UserId=uid,StateHash=Hash(id),BrowserHash=Hash(browserProof),ReturnPath=SafeReturnUrl(returnUrl),RequestedScopes=requested,ExpiresAt=clock.Now.Add(StateLife)});
            await db.SaveChangesAsync(ct);
            await tx.CommitIfOwnedAsync(ct);
        }

        return Query("https://accounts.google.com/o/oauth2/v2/auth", new Dictionary<string, string?>
        {
            ["client_id"] = _o.ClientId, ["redirect_uri"] = _o.RedirectUri, ["response_type"] = "code", ["scope"] = requested,
            // offline + consent: Google only hands back a refresh token when consent is actually (re-)shown, which this guarantees every time.
            ["access_type"] = "offline", ["prompt"] = "consent", ["include_granted_scopes"] = "true", ["state"] = id,
        });
    }

    /// <summary>The redirect back from Google: exchanges the code for tokens, stores the connection, and says where the browser should land.</summary>
    public async Task<string> CompleteConnectAsync(string? code, string? state, string? error, string? browserProof, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(state) || state.Length > 100) throw new UnauthorizedException("This connection attempt is not valid. Start again.", "GOOGLE_STATE_INVALID");
        if(string.IsNullOrWhiteSpace(browserProof)||browserProof.Length>100)throw new UnauthorizedException("Start the connection in this browser.","GOOGLE_BROWSER_INVALID");
        var hash=Hash(state);var browser=Hash(browserProof);
        var p=await db.ProviderOAuthAttempts.AsNoTracking().SingleOrDefaultAsync(x=>x.Provider=="google"&&x.StateHash==hash&&x.BrowserHash==browser&&x.ExpiresAt>clock.Now&&x.ConsumedAt==null,ct)
            ??throw new UnauthorizedException("This connection attempt expired or belongs to another browser.","GOOGLE_STATE_INVALID");
        var consumed=await db.ProviderOAuthAttempts.Where(x=>x.Id==p.Id&&x.ConsumedAt==null&&x.ExpiresAt>clock.Now)
            .ExecuteUpdateAsync(s=>s.SetProperty(x=>x.ConsumedAt,clock.Now),ct);
        if(consumed!=1)throw new UnauthorizedException("This connection attempt was already used.","GOOGLE_STATE_INVALID");
        await WorkspaceExecutionPrincipal.ConfigureAsync(services,p.UserId,p.TenantId,null,ct);
        if (!string.IsNullOrEmpty(error) || string.IsNullOrWhiteSpace(code))
        {
            log.LogInformation("Google Calendar connection was declined.");
            return Landing(p.ReturnPath,"declined");
        }

        var form = new Dictionary<string, string>
        {
            ["grant_type"] = "authorization_code", ["code"] = code!, ["redirect_uri"] = _o.RedirectUri!,
            ["client_id"] = _o.ClientId!, ["client_secret"] = _o.ClientSecret!,
        };
        using var tokenRequest=new HttpRequestMessage(HttpMethod.Post,"https://oauth2.googleapis.com/token"){Content=new FormUrlEncodedContent(form)};
        using var payload=await OAuthJsonAsync(tokenRequest,65536,ct);
        if(payload==null)return Landing(p.ReturnPath,"error");
        var doc=payload.RootElement;
        string? Field(string name,int max)=>doc.TryGetProperty(name,out var value)&&value.ValueKind==JsonValueKind.String&&value.GetString() is {Length:>0} text&&text.Length<=max&&!text.Any(char.IsControl)?text:null;
        var accessToken=Field("access_token",2000);var grantedScopes=Field("scope",500)??"";var expiresIn=3600;
        if(accessToken==null||doc.TryGetProperty("expires_in",out var e)&&(e.ValueKind!=JsonValueKind.Number||!e.TryGetInt32(out expiresIn)||expiresIn<120||expiresIn>86400))return Landing(p.ReturnPath,"error");
        if(p.RequestedScopes.Contains(InboxScope) && (!_o.InboxEnabled || !grantedScopes.Split(' ').Contains(InboxScope)))return Landing(p.ReturnPath,"error");
        // Google returns a refresh token only the first time a person consents - prompt=consent above forces that every time we ask.
        var refreshToken = Field("refresh_token",2000);
        var email = await FetchEmailAsync(accessToken, ct);
        // Never attach a new mail grant to an identity retained from an older connection.
        if(grantedScopes.Split((char)32,StringSplitOptions.RemoveEmptyEntries).Any(s=>s==MailScope||s==InboxScope)&&(string.IsNullOrWhiteSpace(email)||string.IsNullOrWhiteSpace(refreshToken))) return Landing(p.ReturnPath,"error");

        await WorkspaceExecutionPrincipal.ConfigureAsync(services,p.UserId,p.TenantId,null,ct);
        await using var connectionTx=await db.Database.BeginOwnedTransactionAsync(ct);
        var accountLocked=await db.Users.Where(u=>u.Id==p.UserId&&u.IsActive).ExecuteUpdateAsync(s=>s.SetProperty(u=>u.IsActive,u=>u.IsActive),ct);
        if(accountLocked!=1)throw new ForbiddenException("Your account is unavailable.");
        var existing = await db.GoogleConnections.FirstOrDefaultAsync(x => x.TenantId == p.TenantId && x.UserId == p.UserId, ct);
        // A broad provider token is not evidence that this connection requested inbox consent.
        var inboxConsented=p.RequestedScopes.Split(' ').Contains(InboxScope)||existing!=null&&existing.GoogleEmail==email&&existing.Scopes.Split(' ').Contains(InboxScope);
        if(!inboxConsented)grantedScopes=string.Join(' ',grantedScopes.Split(' ',StringSplitOptions.RemoveEmptyEntries).Where(s=>s!=InboxScope));
        if (existing is null)
        {
            if (refreshToken is null)
            {
                log.LogWarning("Google did not return a refresh token on first consent for user {User}", p.UserId);
                return Landing(p.ReturnPath,"error");
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
        existing.ConsentEpoch=Guid.NewGuid();
        existing.LastError = null;
        recorder.Audit("google_connection.connected", "GoogleConnection", existing.Id, tenantId: p.TenantId, userId: p.UserId);
        await db.SaveChangesAsync(ct);
        await connectionTx.CommitIfOwnedAsync(ct);
        return Landing(p.ReturnPath,"connected");
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
    public async Task<string> GetAccessTokenAsync(Guid userId,CancellationToken ct=default,string? requiredScope=null)
        =>(await GetAccessGrantAsync(userId,ct,requiredScope)).AccessToken;
    public async Task<GoogleAccessGrant> GetAccessGrantAsync(Guid userId,CancellationToken ct=default,string? requiredScope=null)
    {
        var c=await db.GoogleConnections.AsNoTracking().FirstOrDefaultAsync(x=>x.UserId==userId,ct)
            ??throw new ConflictException("Connect your Google account first.","GOOGLE_NOT_CONNECTED");
        var scope=requiredScope??"https://www.googleapis.com/auth/calendar.events";
        if(!c.Scopes.Split(' ',StringSplitOptions.RemoveEmptyEntries).Contains(scope))
            throw new ConflictException("Reconnect Google and grant the permission required for this action.","GOOGLE_SCOPE_REQUIRED");
        if(c.AccessTokenProtected!=null&&c.AccessTokenExpiresAt>clock.Now)return new(c.Id,Hash(c.RefreshTokenProtected),c.GoogleEmail??"",secrets.Unprotect(c.AccessTokenProtected),c.ConsentEpoch);
        using var deadline=CancellationTokenSource.CreateLinkedTokenSource(ct);deadline.CancelAfter(TimeSpan.FromSeconds(20));
        using var request=new HttpRequestMessage(HttpMethod.Post,"https://oauth2.googleapis.com/token"){
            Content=new FormUrlEncodedContent(new Dictionary<string,string>{
                ["grant_type"]="refresh_token",["refresh_token"]=secrets.Unprotect(c.RefreshTokenProtected),
                ["client_id"]=_o.ClientId!,["client_secret"]=_o.ClientSecret!
            })
        };
        using var response=await http.CreateClient("google-calendar").SendAsync(request,HttpCompletionOption.ResponseHeadersRead,deadline.Token);
        if(!response.IsSuccessStatusCode){
            await db.GoogleConnections.Where(x=>x.Id==c.Id&&x.RefreshTokenProtected==c.RefreshTokenProtected)
                .ExecuteUpdateAsync(s=>s.SetProperty(x=>x.LastError,"Your Google connection needs to be renewed."),ct);
            log.LogWarning("Google token refresh failed for user {User}: {Status}",userId,(int)response.StatusCode);
            throw new ConflictException("Your Google connection needs to be renewed.","GOOGLE_TOKEN_EXPIRED");
        }
        await using var stream=await response.Content.ReadAsStreamAsync(deadline.Token);
        var buffer=new byte[65537];var length=0;int count;
        while(length<buffer.Length&&(count=await stream.ReadAsync(buffer.AsMemory(length),deadline.Token))>0)length+=count;
        if(length>65536)throw new ConflictException("Google returned an invalid token response.","GOOGLE_TOKEN_EXPIRED");
        JsonDocument doc;
        try{doc=JsonDocument.Parse(buffer.AsMemory(0,length));}catch(JsonException){throw new ConflictException("Google returned an invalid token response.","GOOGLE_TOKEN_EXPIRED");}
        using(doc){
            var root=doc.RootElement;
            string Field(string name,int maximum){
                if(root.ValueKind==JsonValueKind.Object&&root.TryGetProperty(name,out var value)&&value.ValueKind==JsonValueKind.String&&value.GetString() is {Length:>0} text&&text.Length<=maximum&&!text.Any(char.IsControl))return text;
                throw new ConflictException("Google returned an invalid token response.","GOOGLE_TOKEN_EXPIRED");
            }
            var access=Field("access_token",10000);var seconds=3600;
            if(root.TryGetProperty("expires_in",out var expires)&&(expires.ValueKind!=JsonValueKind.Number||!expires.TryGetInt32(out seconds)||seconds<120||seconds>86400))
                throw new ConflictException("Google returned an invalid token lifetime.","GOOGLE_TOKEN_EXPIRED");
            var scopes=root.TryGetProperty("scope",out _)?Field("scope",2000):c.Scopes;
            scopes=string.Join(' ',scopes.Split(' ',StringSplitOptions.RemoveEmptyEntries).Where(s=>c.Scopes.Split(' ',StringSplitOptions.RemoveEmptyEntries).Contains(s)));
            if(!scopes.Split(' ',StringSplitOptions.RemoveEmptyEntries).Contains(scope))
                throw new ConflictException("Reconnect Google and grant the required permission.","GOOGLE_SCOPE_REQUIRED");
            var refresh=root.TryGetProperty("refresh_token",out _)?secrets.Protect(Field("refresh_token",10000)):c.RefreshTokenProtected;
            var protectedAccess=secrets.Protect(access);var expiry=clock.Now.AddSeconds(seconds-60);
            var won=await db.GoogleConnections.Where(x=>x.Id==c.Id&&x.RefreshTokenProtected==c.RefreshTokenProtected)
                .ExecuteUpdateAsync(s=>s.SetProperty(x=>x.AccessTokenProtected,protectedAccess).SetProperty(x=>x.RefreshTokenProtected,refresh)
                    .SetProperty(x=>x.AccessTokenExpiresAt,expiry).SetProperty(x=>x.Scopes,scopes).SetProperty(x=>x.LastSyncAt,clock.Now)
                    .SetProperty(x=>x.LastError,(string?)null),ct);
            if(won!=1)throw new ConflictException("Your Google connection changed. Reload before confirming.","GOOGLE_CONNECTION_CHANGED");
            return new(c.Id,Hash(refresh),c.GoogleEmail??"",access,c.ConsentEpoch);
        }
    }
    private async Task<string?> FetchEmailAsync(string accessToken, CancellationToken ct)
    {
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, "https://www.googleapis.com/oauth2/v2/userinfo");
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
            using var payload=await OAuthJsonAsync(req,8192,ct);
            if(payload==null)return null;
            var doc=payload.RootElement;
            return doc.TryGetProperty("email",out var e)&&e.ValueKind==JsonValueKind.String&&e.GetString() is {Length:>0 and <=320} email&&!email.Any(char.IsControl)?email:null;
        }
        catch(OperationCanceledException)when(ct.IsCancellationRequested){throw;}
        catch { return null; }   // Calendar can work without a display email; mail capabilities require one.
    }
    private async Task<JsonDocument?> OAuthJsonAsync(HttpRequestMessage request,int maximum,CancellationToken ct)
    {
        using var deadline=CancellationTokenSource.CreateLinkedTokenSource(ct);deadline.CancelAfter(TimeSpan.FromSeconds(20));
        try{
            using var response=await http.CreateClient("google-calendar").SendAsync(request,HttpCompletionOption.ResponseHeadersRead,deadline.Token);
            if(!response.IsSuccessStatusCode)return null;
            await using var stream=await response.Content.ReadAsStreamAsync(deadline.Token);
            var buffer=new byte[maximum+1];var length=0;int read;
            while(length<buffer.Length&&(read=await stream.ReadAsync(buffer.AsMemory(length),deadline.Token))>0)length+=read;
            if(length>maximum)return null;
            var json=JsonDocument.Parse(buffer.AsMemory(0,length));
            if(json.RootElement.ValueKind==JsonValueKind.Object)return json;
            json.Dispose();return null;
        }catch(JsonException){return null;}
        catch(HttpRequestException){return null;}
        catch(OperationCanceledException)when(!ct.IsCancellationRequested){return null;}
    }

    private static string Random(int bytes) => Convert.ToBase64String(RandomNumberGenerator.GetBytes(bytes)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    private static string Landing(string path,string status)=>path+(path.Contains('?')?"&":"?")+"google="+status;
    private static string SafeReturnUrl(string? url) =>
        !string.IsNullOrWhiteSpace(url)&&url.Length<=200&&url.StartsWith('/')&&!url.StartsWith("//")
        &&!url.Contains((char)92)&&!url.Any(char.IsControl)&&!url.Contains('#')&&!url.Contains("://")?url:"/settings/google-workspace";
    private static string Query(string endpoint, IEnumerable<KeyValuePair<string, string?>> values) =>
        endpoint + (endpoint.Contains('?') ? "&" : "?") + string.Join('&', values.Where(v => v.Value is not null).Select(v => $"{Uri.EscapeDataString(v.Key)}={Uri.EscapeDataString(v.Value!)}"));
}
