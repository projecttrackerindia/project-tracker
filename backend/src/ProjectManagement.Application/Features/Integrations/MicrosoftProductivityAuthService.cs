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
    public string? ClientId { get; set; }
    public string? ClientSecret { get; set; }
    public string? RedirectUri { get; set; }
    public string AuthorityTenant { get; set; } = "organizations";
    public bool Configured => Guid.TryParse(ClientId,out _) && !string.IsNullOrWhiteSpace(ClientSecret)
        && Uri.TryCreate(RedirectUri,UriKind.Absolute,out var uri) && uri.Scheme=="https"
        && uri.AbsolutePath=="/api/v1/integrations/microsoft/callback"
        && (AuthorityTenant is "common" or "organizations" or "consumers" || Guid.TryParse(AuthorityTenant,out _));
}
public record MicrosoftStatusDto(bool Enabled,bool Configured,bool Connected,string? Email,bool MailSendAccess);
public record MicrosoftConnectStart(string Url,string BrowserProof);
public record MicrosoftMailGrant(string Email,string AccessToken);

public class MicrosoftProductivityAuthService(IAppDbContext db,ICurrentContext ctx,AppClock clock,
    Recorder recorder,IServiceProvider services,IOptions<MicrosoftProductivityOptions> options,
    IHttpClientFactory http,ISecretProtector secrets)
{
    private MicrosoftProductivityOptions Options=>options.Value;
    public const string Scopes="offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.Send";
    private string Authority=>"https://login.microsoftonline.com/"+Options.AuthorityTenant+"/oauth2/v2.0/";
    private static string Random()=>Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
    private static string Hash(string value)=>Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
    private static bool HasScope(string scopes,string name)=>scopes.Split(' ',StringSplitOptions.RemoveEmptyEntries)
        .Any(s=>s.Split('/').Last().Equals(name,StringComparison.OrdinalIgnoreCase));
    private static string Landing(string state)=>"/account/integrations?microsoft="+state;
    private void RequireEnabled(){
        if(!Options.Enabled||!Options.Configured)throw new ConflictException("Microsoft integration is awaiting administrator setup.","MICROSOFT_DISABLED");
    }
    public async Task<MicrosoftStatusDto> StatusAsync(CancellationToken ct){
        ctx.RequireTenantId();var uid=ctx.RequireUserId();
        var c=await db.MicrosoftConnections.AsNoTracking().SingleOrDefaultAsync(c=>c.UserId==uid,ct);
        return new(Options.Enabled,Options.Configured,c!=null,c?.Email,c!=null&&HasScope(c.Scopes,"Mail.Send"));
    }
    public async Task<MicrosoftConnectStart> StartAsync(CancellationToken ct){
        RequireEnabled();var uid=ctx.RequireUserId();var tid=ctx.RequireTenantId();
        var state=Random();var proof=Random();var verifier=Random();
        await using(var tx=await db.Database.BeginOwnedTransactionAsync(ct)){
            if(await db.Users.Where(u=>u.Id==uid&&u.IsActive).ExecuteUpdateAsync(s=>s.SetProperty(u=>u.IsActive,u=>u.IsActive),ct)!=1)
                throw new ForbiddenException("Your account is unavailable.");
            await db.ProviderOAuthAttempts.Where(a=>a.ExpiresAt<clock.Now).Take(100).ExecuteDeleteAsync(ct);
            if(await db.ProviderOAuthAttempts.CountAsync(a=>a.Provider=="microsoft"&&a.UserId==uid&&a.ConsumedAt==null&&a.ExpiresAt>clock.Now,ct)>=5)
                throw new ConflictException("Finish an existing Microsoft connection or wait ten minutes.");
            db.ProviderOAuthAttempts.Add(new(){Provider="microsoft",TenantId=tid,UserId=uid,StateHash=Hash(state),BrowserHash=Hash(proof),
                VerifierProtected=secrets.Protect(verifier),ReturnPath="/account/integrations",ExpiresAt=clock.Now.AddMinutes(10)});
            await db.SaveChangesAsync(ct);await tx.CommitIfOwnedAsync(ct);
        }
        var challenge=Convert.ToBase64String(SHA256.HashData(Encoding.ASCII.GetBytes(verifier))).TrimEnd('=').Replace('+','-').Replace('/','_');
        var query=new Dictionary<string,string>{
            ["client_id"]=Options.ClientId!,["redirect_uri"]=Options.RedirectUri!,["response_type"]="code",["response_mode"]="query",
            ["scope"]=Scopes,["state"]=state,["code_challenge"]=challenge,["code_challenge_method"]="S256",["prompt"]="consent"};
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
        if(!string.IsNullOrEmpty(error)||string.IsNullOrWhiteSpace(code))return Landing("declined");
        try{
            using var tokenRequest=new HttpRequestMessage(HttpMethod.Post,Authority+"token"){
                Content=new FormUrlEncodedContent(new Dictionary<string,string>{["client_id"]=Options.ClientId!,["client_secret"]=Options.ClientSecret!,
                    ["grant_type"]="authorization_code",["code"]=code,["redirect_uri"]=Options.RedirectUri!,["scope"]=Scopes,
                    ["code_verifier"]=secrets.Unprotect(attempt.VerifierProtected??throw new ConflictException("Restart Microsoft connection."))})};
            using var token=await JsonAsync(tokenRequest,64000,ct);
            var access=Field(token.RootElement,"access_token",10000);var refresh=Field(token.RootElement,"refresh_token",10000);
            var granted=Field(token.RootElement,"scope",2000);var expiry=Expiry(token.RootElement);
            if(!HasScope(granted,"Mail.Send")||!HasScope(granted,"User.Read"))return Landing("permission");
            using var profileRequest=new HttpRequestMessage(HttpMethod.Get,"https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName");
            profileRequest.Headers.Authorization=new AuthenticationHeaderValue("Bearer",access);
            using var profile=await JsonAsync(profileRequest,8192,ct);
            var providerUser=Field(profile.RootElement,"id",200);
            var email=profile.RootElement.TryGetProperty("mail",out var mail)&&mail.ValueKind==JsonValueKind.String&&!string.IsNullOrWhiteSpace(mail.GetString())
                ?mail.GetString()!:Field(profile.RootElement,"userPrincipalName",254);
            if(email.Length>254||email.Any(char.IsControl)||!MailAddress.TryCreate(email,out var address)||address.Address!=email)return Landing("error");
            await WorkspaceExecutionPrincipal.ConfigureAsync(services,attempt.UserId,attempt.TenantId,null,ct);
            await using var tx=await db.Database.BeginOwnedTransactionAsync(ct);
            if(await db.Users.Where(u=>u.Id==attempt.UserId&&u.IsActive).ExecuteUpdateAsync(s=>s.SetProperty(u=>u.IsActive,u=>u.IsActive),ct)!=1)
                throw new ForbiddenException("Your account is unavailable.");
            var row=await db.MicrosoftConnections.SingleOrDefaultAsync(c=>c.UserId==attempt.UserId,ct);
            if(row==null){row=new(){TenantId=attempt.TenantId,UserId=attempt.UserId};db.MicrosoftConnections.Add(row);}
            row.ProviderUserId=providerUser;row.Email=email;row.Scopes=granted;row.ConnectedAt=clock.Now;
            row.AccessTokenProtected=secrets.Protect(access);row.RefreshTokenProtected=secrets.Protect(refresh);row.AccessTokenExpiresAt=expiry;
            recorder.Audit("microsoft_connection.connected","MicrosoftConnection",row.Id);
            await db.SaveChangesAsync(ct);await tx.CommitIfOwnedAsync(ct);return Landing("connected");
        }catch(ConflictException){return Landing("error");}
        catch(HttpRequestException){return Landing("error");}
        catch(OperationCanceledException)when(!ct.IsCancellationRequested){return Landing("error");}
    }
    public async Task<MicrosoftMailGrant> GetMailGrantAsync(CancellationToken ct){
        RequireEnabled();ctx.RequireTenantId();var uid=ctx.RequireUserId();
        var row=await db.MicrosoftConnections.AsNoTracking().SingleOrDefaultAsync(c=>c.UserId==uid,ct)
            ??throw new ConflictException("Connect your Microsoft account first.","MICROSOFT_NOT_CONNECTED");
        if(!HasScope(row.Scopes,"Mail.Send"))throw new ConflictException("Reconnect and grant Microsoft email sending permission.","MICROSOFT_SCOPE_REQUIRED");
        if(row.AccessTokenExpiresAt>clock.Now)return new(row.Email,secrets.Unprotect(row.AccessTokenProtected));
        using var request=new HttpRequestMessage(HttpMethod.Post,Authority+"token"){Content=new FormUrlEncodedContent(new Dictionary<string,string>{
            ["client_id"]=Options.ClientId!,["client_secret"]=Options.ClientSecret!,["grant_type"]="refresh_token",
            ["refresh_token"]=secrets.Unprotect(row.RefreshTokenProtected),["scope"]=Scopes})};
        using var payload=await JsonAsync(request,64000,ct);
        var access=Field(payload.RootElement,"access_token",10000);var expiry=Expiry(payload.RootElement);
        var granted=payload.RootElement.TryGetProperty("scope",out var scope)&&scope.ValueKind==JsonValueKind.String?Field(payload.RootElement,"scope",2000):row.Scopes;
        if(!HasScope(granted,"Mail.Send"))throw new ConflictException("Reconnect and grant email sending permission.","MICROSOFT_SCOPE_REQUIRED");
        var refresh=payload.RootElement.TryGetProperty("refresh_token",out var rt)&&rt.ValueKind==JsonValueKind.String?Field(payload.RootElement,"refresh_token",10000):secrets.Unprotect(row.RefreshTokenProtected);
        var encryptedAccess=secrets.Protect(access);var encryptedRefresh=secrets.Protect(refresh);
        var won=await db.MicrosoftConnections.Where(c=>c.Id==row.Id&&c.RefreshTokenProtected==row.RefreshTokenProtected)
            .ExecuteUpdateAsync(s=>s.SetProperty(c=>c.AccessTokenProtected,encryptedAccess).SetProperty(c=>c.RefreshTokenProtected,encryptedRefresh)
                .SetProperty(c=>c.AccessTokenExpiresAt,expiry).SetProperty(c=>c.Scopes,granted),ct);
        if(won!=1)throw new ConflictException("Your Microsoft connection changed. Reload before sending.","MICROSOFT_CONNECTION_CHANGED");
        return new(row.Email,access);
    }
    public async Task DisconnectAsync(CancellationToken ct){
        ctx.RequireTenantId();var uid=ctx.RequireUserId();
        var row=await db.MicrosoftConnections.SingleOrDefaultAsync(c=>c.UserId==uid,ct);
        if(row==null)return;
        db.MicrosoftConnections.Remove(row);recorder.Audit("microsoft_connection.disconnected","MicrosoftConnection",row.Id);
        await db.SaveChangesAsync(ct);
    }
}
