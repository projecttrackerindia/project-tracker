using System.Net.Http.Headers;
using System.Net.Mail;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Integrations;

public class MicrosoftProductivityOptions
{
    public const string Section = "MicrosoftProductivity";
    public bool Enabled { get; set; }
    public bool InboxEnabled { get; set; }
    public bool CalendarsEnabled {get;set;}
    /// <summary>Outlook calendar events with a Teams meeting, created as the person (Calendars.ReadWrite). On unless switched off.</summary>
    public bool MeetingsEnabled {get;set;}=true;
    public string? ClientId { get; set; }
    public string? ClientSecret { get; set; }
    public string? RedirectUri { get; set; }
    public string AuthorityTenant { get; set; } = "organizations";
    public bool Configured => Guid.TryParse(ClientId,out _) && !string.IsNullOrWhiteSpace(ClientSecret)
        && Uri.TryCreate(RedirectUri,UriKind.Absolute,out var uri) && uri.Scheme=="https"
        && uri.AbsolutePath=="/api/v1/integrations/microsoft/callback"
        && (AuthorityTenant is "common" or "organizations" or "consumers" || Guid.TryParse(AuthorityTenant,out _));
}
public record MicrosoftStatusDto(bool Enabled,bool Configured,bool Connected,string? Email,bool MailSendAccess,bool InboxEnabled=false,bool InboxAccess=false,bool CalendarsEnabled=false,bool CalendarAccess=false,DateTime? ConnectedAt=null,
    bool MeetingsEnabled=false,bool MeetingsAccess=false);
public record MicrosoftConnectStart(string Url,string BrowserProof);
public record MicrosoftMailGrant(string Email,string AccessToken,Guid ConnectionId=default,string RefreshFingerprint="",Guid ConsentEpoch=default);

public class MicrosoftProductivityAuthService(IAppDbContext db,ICurrentContext ctx,AppClock clock,
    Recorder recorder,IServiceProvider services,IOptions<MicrosoftProductivityOptions> options,
    IHttpClientFactory http,ISecretProtector secrets)
{
    private MicrosoftProductivityOptions Options=>options.Value;
    public const string Scopes="offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.Send";
    public const string CalendarScope="https://graph.microsoft.com/Calendars.ReadBasic";
    public const string InboxScope="https://graph.microsoft.com/Mail.Read";
    /// <summary>Create, move and cancel Outlook events (with a Teams meeting) as the person; also covers reading the calendar.</summary>
    public const string MeetingsScope="https://graph.microsoft.com/Calendars.ReadWrite";
    /// <summary>The features a person can switch off one at a time, and the permission each one uses.</summary>
    public static readonly IReadOnlyDictionary<string,string> FeatureScopes=new Dictionary<string,string>{
        ["mail"]="Mail.Send",["inbox"]="Mail.Read",["calendar"]="Calendars.ReadBasic",["meetings"]="Calendars.ReadWrite"};
    private string Authority=>"https://login.microsoftonline.com/"+Options.AuthorityTenant+"/oauth2/v2.0/";
    private static string Random()=>Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
    private static string Hash(string value)=>Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
    private static bool HasScope(string scopes,string name)=>scopes.Split(' ',StringSplitOptions.RemoveEmptyEntries)
        .Any(s=>s.Split('/').Last().Equals(name,StringComparison.OrdinalIgnoreCase))
        // Writing a calendar includes reading it.
        ||name.Equals("Calendars.ReadBasic",StringComparison.OrdinalIgnoreCase)&&scopes.Split(' ',StringSplitOptions.RemoveEmptyEntries).Any(s=>s.Split('/').Last().Equals("Calendars.ReadWrite",StringComparison.OrdinalIgnoreCase));
    private static bool HasExact(string scopes,string name)=>scopes.Split(' ',StringSplitOptions.RemoveEmptyEntries).Any(s=>s.Split('/').Last().Equals(name,StringComparison.OrdinalIgnoreCase));
    public bool MeetingsReady=>Options.Enabled&&Options.Configured&&Options.MeetingsEnabled;
    private static string Landing(string path,string state)=>path+(path.Contains('?')?"&":"?")+"microsoft="+state;
    private static string SafeReturn(string? url)=>!string.IsNullOrWhiteSpace(url)&&url.Length<=200&&url.StartsWith('/')&&!url.StartsWith("//")
        &&!url.Contains('\\')&&!url.Any(char.IsControl)&&!url.Contains('#')&&!url.Contains("://")?url:"/account/integrations";
    private void RequireEnabled(){
        if(!Options.Enabled||!Options.Configured)throw new ConflictException("Microsoft integration is awaiting administrator setup.","MICROSOFT_DISABLED");
    }
    public async Task<MicrosoftStatusDto> StatusAsync(CancellationToken ct){
        ctx.RequireTenantId();var uid=ctx.RequireUserId();
        var c=await db.MicrosoftConnections.AsNoTracking().SingleOrDefaultAsync(c=>c.UserId==uid,ct);
        return new(Options.Enabled,Options.Configured,c!=null,c?.Email,c!=null&&HasScope(c.Scopes,"Mail.Send"),Options.Enabled&&Options.Configured&&Options.InboxEnabled,c!=null&&HasScope(c.Scopes,"Mail.Read"),Options.Enabled&&Options.Configured&&Options.CalendarsEnabled,c!=null&&HasScope(c.Scopes,"Calendars.ReadBasic"),c?.ConnectedAt,
            MeetingsReady,c!=null&&HasExact(c.Scopes,"Calendars.ReadWrite"));
    }
    public async Task<MicrosoftConnectStart> StartAsync(CancellationToken ct,bool inbox=false,bool calendars=false,bool meetings=false,string? returnPath=null){
        RequireEnabled();var uid=ctx.RequireUserId();var tid=ctx.RequireTenantId();
        if(meetings&&!Options.MeetingsEnabled)throw new ConflictException("Teams meetings from Project Tracker are switched off for this installation.","MICROSOFT_MEETINGS_DISABLED");
        if(inbox&&!Options.InboxEnabled)throw new ConflictException("Microsoft inbox access is not enabled.","INBOX_DISABLED");
        if(calendars&&!Options.CalendarsEnabled)throw new ConflictException("Microsoft calendar reading is not enabled.","MICROSOFT_CALENDARS_DISABLED");
        var existing=await db.MicrosoftConnections.AsNoTracking().SingleOrDefaultAsync(c=>c.UserId==uid,ct);
        var keepInbox=Options.InboxEnabled&&existing!=null&&HasScope(existing.Scopes,"Mail.Read");
        var keepCalendars=Options.CalendarsEnabled&&existing!=null&&HasExact(existing.Scopes,"Calendars.ReadBasic");
        var keepMeetings=Options.MeetingsEnabled&&existing!=null&&HasExact(existing.Scopes,"Calendars.ReadWrite");
        var requested=Scopes+(inbox||keepInbox?" "+InboxScope:"")+(calendars||keepCalendars?" "+CalendarScope:"")+(meetings||keepMeetings?" "+MeetingsScope:"");
        var state=Random();var proof=Random();var verifier=Random();
        await using(var tx=await db.Database.BeginOwnedTransactionAsync(ct)){
            if(await db.Users.Where(u=>u.Id==uid&&u.IsActive).ExecuteUpdateAsync(s=>s.SetProperty(u=>u.IsActive,u=>u.IsActive),ct)!=1)
                throw new ForbiddenException("Your account is unavailable.");
            await db.ProviderOAuthAttempts.Where(a=>a.ExpiresAt<clock.Now).Take(100).ExecuteDeleteAsync(ct);
            if(await db.ProviderOAuthAttempts.CountAsync(a=>a.Provider=="microsoft"&&a.UserId==uid&&a.ConsumedAt==null&&a.ExpiresAt>clock.Now,ct)>=5)
                throw new ConflictException("Finish an existing Microsoft connection or wait ten minutes.");
            db.ProviderOAuthAttempts.Add(new(){Provider="microsoft",TenantId=tid,UserId=uid,StateHash=Hash(state),BrowserHash=Hash(proof),
                VerifierProtected=secrets.Protect(verifier),RequestedScopes=requested,ReturnPath=SafeReturn(returnPath),ExpiresAt=clock.Now.AddMinutes(10)});
            await db.SaveChangesAsync(ct);await tx.CommitIfOwnedAsync(ct);
        }
        var challenge=Convert.ToBase64String(SHA256.HashData(Encoding.ASCII.GetBytes(verifier))).TrimEnd('=').Replace('+','-').Replace('/','_');
        var query=new Dictionary<string,string>{
            ["client_id"]=Options.ClientId!,["redirect_uri"]=Options.RedirectUri!,["response_type"]="code",["response_mode"]="query",
            ["scope"]=requested,["state"]=state,["code_challenge"]=challenge,["code_challenge_method"]="S256",["prompt"]="consent"};
        return new(Authority+"authorize?"+string.Join("&",query.Select(p=>Uri.EscapeDataString(p.Key)+"="+Uri.EscapeDataString(p.Value))),proof);
    }
    // Bounded transport: no token, profile, provider response or email text is logged.
    private async Task<JsonDocument> JsonAsync(HttpRequestMessage request,int maximum,CancellationToken ct){
        using var deadline=CancellationTokenSource.CreateLinkedTokenSource(ct);deadline.CancelAfter(TimeSpan.FromSeconds(20));
        using var response=await http.CreateClient("microsoft-productivity").SendAsync(request,HttpCompletionOption.ResponseHeadersRead,deadline.Token);
        if(!response.IsSuccessStatusCode)throw new ConflictException("Microsoft did not complete the request. Reconnect or try again.","MICROSOFT_PROVIDER_ERROR");
        await using var stream=await response.Content.ReadAsStreamAsync(deadline.Token);
        var buffer=new byte[maximum+1];var length=0;int n;
        while(length<buffer.Length&&(n=await stream.ReadAsync(buffer.AsMemory(length),deadline.Token))>0)length+=n;
        if(length>maximum)throw new ConflictException("Microsoft returned an invalid response.","MICROSOFT_PROVIDER_ERROR");
        try{var doc=JsonDocument.Parse(buffer.AsMemory(0,length));if(doc.RootElement.ValueKind!=JsonValueKind.Object){doc.Dispose();throw new JsonException();}return doc;}
        catch(JsonException){throw new ConflictException("Microsoft returned an invalid response.","MICROSOFT_PROVIDER_ERROR");}
    }
    private static string Field(JsonElement doc,string name,int max){
        if(doc.TryGetProperty(name,out var field)&&field.ValueKind==JsonValueKind.String&&field.GetString() is {Length:>0} value&&value.Length<=max&&!value.Any(char.IsControl))return value;
        throw new ConflictException("Microsoft did not return the required connection information.","MICROSOFT_PROVIDER_ERROR");
    }
    private DateTime Expiry(JsonElement root){
        if(!root.TryGetProperty("expires_in",out var value)||value.ValueKind!=JsonValueKind.Number||!value.TryGetInt32(out var seconds)||seconds<120||seconds>86400)
            throw new ConflictException("Microsoft returned an invalid token lifetime.","MICROSOFT_PROVIDER_ERROR");
        return clock.Now.AddSeconds(seconds-60);
    }
    public async Task<string> CompleteAsync(string? state,string? proof,string? code,string? error,CancellationToken ct){
        RequireEnabled();
        if(state?.Length!=64||proof?.Length!=64)throw new UnauthorizedException("Restart Microsoft connection in the same browser.","MICROSOFT_STATE_INVALID");
        var hash=Hash(state);var browser=Hash(proof);
        var attempt=await db.ProviderOAuthAttempts.AsNoTracking().SingleOrDefaultAsync(a=>a.Provider=="microsoft"&&a.StateHash==hash&&a.BrowserHash==browser&&a.ConsumedAt==null&&a.ExpiresAt>clock.Now,ct)
            ??throw new UnauthorizedException("Microsoft connection expired or was already used.","MICROSOFT_STATE_INVALID");
        if(await db.ProviderOAuthAttempts.Where(a=>a.Id==attempt.Id&&a.ConsumedAt==null&&a.ExpiresAt>clock.Now)
            .ExecuteUpdateAsync(s=>s.SetProperty(a=>a.ConsumedAt,clock.Now),ct)!=1)
            throw new UnauthorizedException("Microsoft connection was already used.","MICROSOFT_STATE_INVALID");
        await WorkspaceExecutionPrincipal.ConfigureAsync(services,attempt.UserId,attempt.TenantId,null,ct);
        if(!string.IsNullOrEmpty(error)||string.IsNullOrWhiteSpace(code))return Landing(attempt.ReturnPath,"declined");
        try{
            using var tokenRequest=new HttpRequestMessage(HttpMethod.Post,Authority+"token"){
                Content=new FormUrlEncodedContent(new Dictionary<string,string>{["client_id"]=Options.ClientId!,["client_secret"]=Options.ClientSecret!,
                    ["grant_type"]="authorization_code",["code"]=code,["redirect_uri"]=Options.RedirectUri!,["scope"]=string.IsNullOrEmpty(attempt.RequestedScopes)?Scopes:attempt.RequestedScopes,
                    ["code_verifier"]=secrets.Unprotect(attempt.VerifierProtected??throw new ConflictException("Restart Microsoft connection."))})};
            using var token=await JsonAsync(tokenRequest,64000,ct);
            var access=Field(token.RootElement,"access_token",10000);var refresh=Field(token.RootElement,"refresh_token",10000);
            var granted=Field(token.RootElement,"scope",2000);var expiry=Expiry(token.RootElement);
            var requested=string.IsNullOrEmpty(attempt.RequestedScopes)?Scopes:attempt.RequestedScopes;
            granted=string.Join(' ',granted.Split(' ',StringSplitOptions.RemoveEmptyEntries).Where(s=>HasScope(requested,s.Split('/').Last())));
            if(!HasScope(granted,"Mail.Send")||!HasScope(granted,"User.Read"))return Landing(attempt.ReturnPath,"permission");
            if(attempt.RequestedScopes.Contains(InboxScope)&&(!Options.InboxEnabled||!HasScope(granted,"Mail.Read")))return Landing(attempt.ReturnPath,"permission");
            if(attempt.RequestedScopes.Contains(CalendarScope)&&(!Options.CalendarsEnabled||!HasScope(granted,"Calendars.ReadBasic")))return Landing(attempt.ReturnPath,"permission");
            if(attempt.RequestedScopes.Contains(MeetingsScope)&&(!Options.MeetingsEnabled||!HasExact(granted,"Calendars.ReadWrite")))return Landing(attempt.ReturnPath,"permission");
            using var profileRequest=new HttpRequestMessage(HttpMethod.Get,"https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName");
            profileRequest.Headers.Authorization=new AuthenticationHeaderValue("Bearer",access);
            using var profile=await JsonAsync(profileRequest,8192,ct);
            var providerUser=Field(profile.RootElement,"id",200);
            var email=profile.RootElement.TryGetProperty("mail",out var mail)&&mail.ValueKind==JsonValueKind.String&&!string.IsNullOrWhiteSpace(mail.GetString())
                ?mail.GetString()!:Field(profile.RootElement,"userPrincipalName",254);
            if(email.Length>254||email.Any(char.IsControl)||!MailAddress.TryCreate(email,out var address)||address.Address!=email)return Landing(attempt.ReturnPath,"error");
            await WorkspaceExecutionPrincipal.ConfigureAsync(services,attempt.UserId,attempt.TenantId,null,ct);
            await using var tx=await db.Database.BeginOwnedTransactionAsync(ct);
            if(await db.Users.Where(u=>u.Id==attempt.UserId&&u.IsActive).ExecuteUpdateAsync(s=>s.SetProperty(u=>u.IsActive,u=>u.IsActive),ct)!=1)
                throw new ForbiddenException("Your account is unavailable.");
            var row=await db.MicrosoftConnections.SingleOrDefaultAsync(c=>c.UserId==attempt.UserId,ct);
            if(row==null){row=new(){TenantId=attempt.TenantId,UserId=attempt.UserId};db.MicrosoftConnections.Add(row);}
            row.ProviderUserId=providerUser;row.Email=email;row.Scopes=granted;row.ConnectedAt=clock.Now;
            row.ConsentEpoch=Guid.NewGuid();
            row.AccessTokenProtected=secrets.Protect(access);row.RefreshTokenProtected=secrets.Protect(refresh);row.AccessTokenExpiresAt=expiry;
            recorder.Audit("microsoft_connection.connected","MicrosoftConnection",row.Id);
            await db.SaveChangesAsync(ct);await tx.CommitIfOwnedAsync(ct);return Landing(attempt.ReturnPath,"connected");
        }catch(ConflictException){return Landing(attempt.ReturnPath,"error");}
        catch(HttpRequestException){return Landing(attempt.ReturnPath,"error");}
        catch(OperationCanceledException)when(!ct.IsCancellationRequested){return Landing(attempt.ReturnPath,"error");}
    }
    public Task<MicrosoftMailGrant> GetMailGrantAsync(CancellationToken ct)=>GetGrantAsync("Mail.Send",ct);
    public Task<MicrosoftMailGrant> GetInboxGrantAsync(CancellationToken ct){
        if(!Options.InboxEnabled)throw new ConflictException("Microsoft inbox access is not enabled.","INBOX_DISABLED");
        return GetGrantAsync("Mail.Read",ct);
    }
    public Task<MicrosoftMailGrant> GetCalendarGrantAsync(CancellationToken ct){
        if(!Options.CalendarsEnabled)throw new ConflictException("Microsoft calendar reading is not enabled.","MICROSOFT_CALENDARS_DISABLED");
        return GetGrantAsync("Calendars.ReadBasic",ct);
    }
    private async Task<MicrosoftMailGrant> GetGrantAsync(string requiredScope,CancellationToken ct){
        RequireEnabled();ctx.RequireTenantId();var uid=ctx.RequireUserId();
        return await GrantForAsync(uid,requiredScope,exact:false,ct);
    }
    private async Task<MicrosoftMailGrant> GrantForAsync(Guid uid,string requiredScope,bool exact,CancellationToken ct){
        var row=await db.MicrosoftConnections.AsNoTracking().SingleOrDefaultAsync(c=>c.UserId==uid,ct)
            ??throw new ConflictException("Connect your Microsoft account first.","MICROSOFT_NOT_CONNECTED");
        if(exact?!HasExact(row.Scopes,requiredScope):!HasScope(row.Scopes,requiredScope))throw new ConflictException("Reconnect and grant the required Microsoft permission.","MICROSOFT_SCOPE_REQUIRED");
        if(row.AccessTokenExpiresAt>clock.Now)return new(row.Email,secrets.Unprotect(row.AccessTokenProtected),row.Id,Hash(row.RefreshTokenProtected),row.ConsentEpoch);
        using var request=new HttpRequestMessage(HttpMethod.Post,Authority+"token"){Content=new FormUrlEncodedContent(new Dictionary<string,string>{
            ["client_id"]=Options.ClientId!,["client_secret"]=Options.ClientSecret!,["grant_type"]="refresh_token",
            ["refresh_token"]=secrets.Unprotect(row.RefreshTokenProtected),["scope"]=row.Scopes+" offline_access"})};
        using var payload=await JsonAsync(request,64000,ct);
        var access=Field(payload.RootElement,"access_token",10000);var expiry=Expiry(payload.RootElement);
        var granted=payload.RootElement.TryGetProperty("scope",out var scope)&&scope.ValueKind==JsonValueKind.String?Field(payload.RootElement,"scope",2000):row.Scopes;
        granted=string.Join(' ',granted.Split(' ',StringSplitOptions.RemoveEmptyEntries).Where(s=>HasScope(row.Scopes,s.Split('/').Last())));
        if(!HasScope(granted,requiredScope))throw new ConflictException("Reconnect and grant the required Microsoft permission.","MICROSOFT_SCOPE_REQUIRED");
        var refresh=payload.RootElement.TryGetProperty("refresh_token",out var rt)&&rt.ValueKind==JsonValueKind.String?Field(payload.RootElement,"refresh_token",10000):secrets.Unprotect(row.RefreshTokenProtected);
        var encryptedAccess=secrets.Protect(access);var encryptedRefresh=secrets.Protect(refresh);
        var won=await db.MicrosoftConnections.Where(c=>c.Id==row.Id&&c.RefreshTokenProtected==row.RefreshTokenProtected&&c.ConsentEpoch==row.ConsentEpoch&&c.Email==row.Email&&c.ProviderUserId==row.ProviderUserId&&c.Scopes==row.Scopes)
            .ExecuteUpdateAsync(s=>s.SetProperty(c=>c.AccessTokenProtected,encryptedAccess).SetProperty(c=>c.RefreshTokenProtected,encryptedRefresh)
                .SetProperty(c=>c.AccessTokenExpiresAt,expiry).SetProperty(c=>c.Scopes,granted),ct);
        if(won!=1)throw new ConflictException("Your Microsoft connection changed. Reload before sending.","MICROSOFT_CONNECTION_CHANGED");
        return new(row.Email,access,row.Id,Hash(encryptedRefresh),row.ConsentEpoch);
    }
    /// <summary>
    /// The organizer's Outlook calendar, for creating, moving and cancelling meetings as them - also from background work (a reschedule by an
    /// admin, the RSVP sync), so it is looked up by person rather than by whoever is signed in. Never returned to the browser.
    /// </summary>
    public async Task<MicrosoftMailGrant> GetMeetingsGrantAsync(Guid userId,CancellationToken ct){
        RequireEnabled();
        if(!Options.MeetingsEnabled)throw new ConflictException("Teams meetings from Project Tracker are switched off for this installation.","MICROSOFT_MEETINGS_DISABLED");
        return await GrantForAsync(userId,"Calendars.ReadWrite",exact:true,ct);
    }
    /// <summary>Has this person given Project Tracker their Outlook calendar for meetings (no token is fetched)?</summary>
    public async Task<bool> CanCreateMeetingsAsync(Guid userId,CancellationToken ct)=>MeetingsReady
        &&await db.MicrosoftConnections.AsNoTracking().Where(c=>c.UserId==userId).Select(c=>c.Scopes).FirstOrDefaultAsync(ct) is {} s&&HasExact(s,"Calendars.ReadWrite");

    /// <summary>
    /// Stops one feature (mail, inbox, calendar, meetings) without touching the others: the permission is dropped here, so nothing uses it any
    /// more. Microsoft keeps the grant itself until the whole account is disconnected (or removed at myapps.microsoft.com).
    /// </summary>
    public async Task<MicrosoftStatusDto> TurnOffAsync(string feature,CancellationToken ct){
        ctx.RequireTenantId();var uid=ctx.RequireUserId();
        if(!FeatureScopes.TryGetValue(feature,out var scope))throw new ValidationException("feature","Choose mail, inbox, calendar or meetings.");
        var row=await db.MicrosoftConnections.SingleOrDefaultAsync(c=>c.UserId==uid,ct);
        if(row==null)return await StatusAsync(ct);
        var left=row.Scopes.Split(' ',StringSplitOptions.RemoveEmptyEntries).Where(s=>!s.Split('/').Last().Equals(scope,StringComparison.OrdinalIgnoreCase)).ToList();
        // Sending mail is what the connection was first made for; without it and everything else there is nothing left to keep.
        if(!left.Any(s=>FeatureScopes.Values.Any(f=>s.Split('/').Last().Equals(f,StringComparison.OrdinalIgnoreCase)))){await DisconnectAsync(ct);return await StatusAsync(ct);}
        row.Scopes=string.Join(' ',left);row.ConsentEpoch=Guid.NewGuid();
        recorder.Audit("microsoft_connection.feature_off","MicrosoftConnection",row.Id,newValue:new{Feature=feature});
        await db.SaveChangesAsync(ct);
        return await StatusAsync(ct);
    }

    public async Task DisconnectAsync(CancellationToken ct){
        ctx.RequireTenantId();var uid=ctx.RequireUserId();
        var row=await db.MicrosoftConnections.SingleOrDefaultAsync(c=>c.UserId==uid,ct);
        if(row==null)return;
        db.MicrosoftConnections.Remove(row);recorder.Audit("microsoft_connection.disconnected","MicrosoftConnection",row.Id);
        await db.SaveChangesAsync(ct);
    }
}
