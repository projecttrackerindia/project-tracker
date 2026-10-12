using System.Net.Http.Headers;
using System.Net.Mail;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Integrations;

// Only provider GETs are allowed here. Absence from a bounded search is never evidence of failure.
public class PersonalEmailReconciliationService(IAppDbContext db,ICurrentContext ctx,GoogleCalendarAuthService google,
    MicrosoftProductivityAuthService microsoft,IOptions<GoogleCalendarOptions> googleOptions,
    IOptions<MicrosoftProductivityOptions> microsoftOptions,IHttpClientFactory http,AppClock clock,Recorder recorder,IServiceProvider services)
{
    private record Grant(Guid Connection,Guid Epoch,string Fingerprint,string Account,string Token);
    private IQueryable<PersonalEmailDraft> Mine=>db.PersonalEmailDrafts.Where(d=>d.UserId==ctx.RequireUserId()&&d.Status!="deleted");
    private static PersonalEmailDto Dto(PersonalEmailDraft d)=>new(d.Id,d.Recipient,d.Subject,d.Body,d.Status,d.Version,d.ProviderMessageId,d.AcceptedAt,d.Provider,d.ProviderRequestId,d.ConfirmedSenderEmail,d.ReconciledAt,d.DispatchKey!=null);
    private async Task<Grant> Access(string provider,CancellationToken ct){
        if(provider=="google"){
            if(!googleOptions.Value.InboxEnabled||!google.Configured)throw new ConflictException("Enable optional Gmail read access before checking Sent.","INBOX_DISABLED");
            var g=await google.GetAccessGrantAsync(ctx.RequireUserId(),ct,GoogleCalendarAuthService.InboxScope);
            return new(g.ConnectionId,g.ConsentEpoch,g.RefreshFingerprint,g.Account,g.AccessToken);
        }
        if(provider!="microsoft")throw new ConflictException("The saved provider is unavailable.","EMAIL_PROVIDER_INVALID");
        var m=await microsoft.GetInboxGrantAsync(ct);return new(m.ConnectionId,m.ConsentEpoch,m.RefreshFingerprint,m.Email,m.AccessToken);
    }
    private async Task Recheck(string provider,Grant g,CancellationToken ct,bool locked=false){
        await WorkspaceExecutionPrincipal.ConfigureAsync(services,ctx.RequireUserId(),ctx.RequireTenantId(),null,ct);
        bool valid;
        if(provider=="google"){
            var query=db.GoogleConnections.Where(c=>c.UserId==ctx.RequireUserId()&&c.Id==g.Connection&&c.ConsentEpoch==g.Epoch&&c.GoogleEmail==g.Account);
            if(locked&&await query.ExecuteUpdateAsync(s=>s.SetProperty(c=>c.ConsentEpoch,c=>c.ConsentEpoch),ct)!=1)throw Changed();
            var r=await query.AsNoTracking().SingleOrDefaultAsync(ct);
            valid=googleOptions.Value.InboxEnabled&&google.Configured&&r!=null&&r.Scopes.Split(' ').Contains(GoogleCalendarAuthService.InboxScope)&&Fingerprint(r.RefreshTokenProtected)==g.Fingerprint;
        }else{
            var query=db.MicrosoftConnections.Where(c=>c.UserId==ctx.RequireUserId()&&c.Id==g.Connection&&c.ConsentEpoch==g.Epoch&&c.Email==g.Account);
            if(locked&&await query.ExecuteUpdateAsync(s=>s.SetProperty(c=>c.ConsentEpoch,c=>c.ConsentEpoch),ct)!=1)throw Changed();
            var r=await query.AsNoTracking().SingleOrDefaultAsync(ct);
            valid=microsoftOptions.Value.Enabled&&microsoftOptions.Value.Configured&&microsoftOptions.Value.InboxEnabled&&r!=null&&r.Scopes.Split(' ').Any(s=>s.Split('/').Last().Equals("Mail.Read",StringComparison.OrdinalIgnoreCase))&&Fingerprint(r.RefreshTokenProtected)==g.Fingerprint;
        }
        if(!valid)throw Changed();
    }
    private static ConflictException Changed()=>new("Your mailbox connection changed. Reload before checking again.","EMAIL_CONNECTION_CHANGED");
    private static string Fingerprint(string value)=>Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
    private async Task<JsonDocument> Read(string url,string provider,Grant g,CancellationToken ct){
        using var request=new HttpRequestMessage(HttpMethod.Get,url);request.Headers.Authorization=new AuthenticationHeaderValue("Bearer",g.Token);
        using var response=await http.CreateClient(provider=="google"?"google-calendar":"microsoft-productivity").SendAsync(request,HttpCompletionOption.ResponseHeadersRead,ct);
        if(!response.IsSuccessStatusCode)throw new AppException(503,"EMAIL_SENT_UNAVAILABLE","The provider Sent folder could not be checked. The send outcome remains uncertain; do not resend.");
        await using var stream=await response.Content.ReadAsStreamAsync(ct);var buffer=new byte[65537];var length=0;int read;
        while(length<buffer.Length&&(read=await stream.ReadAsync(buffer.AsMemory(length),ct))>0)length+=read;
        if(length>65536)throw new JsonException();var parsed=JsonDocument.Parse(buffer.AsMemory(0,length));
        if(parsed.RootElement.ValueKind!=JsonValueKind.Object){parsed.Dispose();throw new JsonException();}return parsed;
    }
    private static string? Text(JsonElement e,string key)=>e.ValueKind==JsonValueKind.Object&&e.TryGetProperty(key,out var v)&&v.ValueKind==JsonValueKind.String?v.GetString():null;
    private static string? Header(JsonElement headers,string name){
        if(headers.ValueKind!=JsonValueKind.Array)return null;
        var matches=headers.EnumerateArray().Where(h=>string.Equals(Text(h,"name"),name,StringComparison.OrdinalIgnoreCase)).ToArray();
        return matches.Length==1?Text(matches[0],"value"):null;
    }
    private static bool Address(string? raw,string expected)=>raw!=null&&!raw.Any(c=>c=='\r'||c=='\n')&&MailAddress.TryCreate(raw,out var address)&&address.Address.Equals(expected,StringComparison.OrdinalIgnoreCase);
    private static string Subject(string raw){
        // RFC 2047 whitespace between adjacent encoded words is not part of the subject.
        var unfolded=Regex.Replace(raw,@"(?<=\?=)[ \t\r\n]+(?==\?UTF-8\?B\?)","",RegexOptions.IgnoreCase);
        return Regex.Replace(unfolded,@"=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=",m=>Encoding.UTF8.GetString(Convert.FromBase64String(m.Groups[1].Value)),RegexOptions.IgnoreCase);
    }
    private bool Time(DateTimeOffset timestamp,PersonalEmailDraft d)=>d.ConfirmedAt!=null&&timestamp>=new DateTimeOffset(DateTime.SpecifyKind(d.ConfirmedAt.Value,DateTimeKind.Utc)).AddMinutes(-5)&&timestamp<=new DateTimeOffset(clock.Now,TimeSpan.Zero).AddMinutes(5);
    private async Task<string?> Google(PersonalEmailDraft d,Grant g,CancellationToken ct){
        var marker="<pt-"+d.DispatchKey!.Value.ToString("N")+"@projecttracker.in>";
        using var list=await Read("https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=SENT&maxResults=2&q="+Uri.EscapeDataString("rfc822msgid:"+marker),"google",g,ct);
        var root=list.RootElement;
        if(root.TryGetProperty("nextPageToken",out _))return null;
        if(!root.TryGetProperty("messages",out var messages))return null;
        if(messages.ValueKind!=JsonValueKind.Array||messages.GetArrayLength()!=1)return null;
        var id=Text(messages[0],"id");if(id is not {Length:>0 and <=200}||id.Any(char.IsControl))return null;
        using var result=await Read("https://gmail.googleapis.com/gmail/v1/users/me/messages/"+Uri.EscapeDataString(id)+"?format=METADATA&metadataHeaders=Message-ID&metadataHeaders=X-ProjectTracker-Operation&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject","google",g,ct);
        var message=result.RootElement;
        if(Text(message,"id")!=id||!message.TryGetProperty("labelIds",out var labels)||labels.ValueKind!=JsonValueKind.Array||!labels.EnumerateArray().Any(l=>l.ValueKind==JsonValueKind.String&&l.GetString()=="SENT")||!message.TryGetProperty("payload",out var payload)||!payload.TryGetProperty("headers",out var headers))return null;
        if(!long.TryParse(Text(message,"internalDate"),out var millis)||!Time(DateTimeOffset.FromUnixTimeMilliseconds(millis),d))return null;
        return Header(headers,"Message-ID")==marker&&Header(headers,"X-ProjectTracker-Operation")==d.DispatchKey.Value.ToString("N")&&Address(Header(headers,"From"),g.Account)&&Address(Header(headers,"To"),d.Recipient)&&Subject(Header(headers,"Subject")??"")==d.Subject?id:null;
    }
    private static bool MicrosoftFields(JsonElement message,PersonalEmailDraft d,Grant g){
        if(Text(message,"subject")!=d.Subject||!message.TryGetProperty("from",out var from)||!from.TryGetProperty("emailAddress",out var sender)||!Address(Text(sender,"address"),g.Account)||!message.TryGetProperty("toRecipients",out var recipients)||recipients.ValueKind!=JsonValueKind.Array||recipients.GetArrayLength()!=1||!recipients[0].TryGetProperty("emailAddress",out var recipient)||!Address(Text(recipient,"address"),d.Recipient))return false;
        return message.TryGetProperty("isDraft",out var draft)&&draft.ValueKind==JsonValueKind.False;
    }
    private async Task<string?> Microsoft(PersonalEmailDraft d,Grant g,CancellationToken ct){
        // Bound the search to the confirmation window, rather than every historical Sent item.
        var start=d.ConfirmedAt!.Value.AddMinutes(-5);var end=d.ConfirmedAt.Value.AddMinutes(30);
        if(end>clock.Now.AddMinutes(5))end=clock.Now.AddMinutes(5);
        const string format="yyyy-MM-dd'T'HH:mm:ss.fff'Z'";
        var filter="sentDateTime ge "+start.ToString(format,CultureInfo.InvariantCulture)+" and sentDateTime le "+end.ToString(format,CultureInfo.InvariantCulture);
        // At most 20 entries and matching-message metadata. Never follow a provider nextLink.
        using var list=await Read("https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages?$top=20&$orderby=sentDateTime%20desc&$filter="+Uri.EscapeDataString(filter)+"&$select=id,subject,from,toRecipients,sentDateTime,isDraft","microsoft",g,ct);
        if(!list.RootElement.TryGetProperty("value",out var messages)||messages.ValueKind!=JsonValueKind.Array||messages.GetArrayLength()>20)throw new JsonException();
        string? found=null;
        foreach(var message in messages.EnumerateArray()){
            if(!MicrosoftFields(message,d,g)||!DateTimeOffset.TryParse(Text(message,"sentDateTime"),out var time)||!Time(time,d))continue;
            var id=Text(message,"id");if(id is not {Length:>0 and <=200}||id.Any(char.IsControl))continue;
            using var full=await Read("https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages/"+Uri.EscapeDataString(id)+"?$select=id,subject,from,toRecipients,sentDateTime,isDraft,internetMessageHeaders","microsoft",g,ct);
            var e=full.RootElement;
            if(Text(e,"id")!=id||!MicrosoftFields(e,d,g)||!DateTimeOffset.TryParse(Text(e,"sentDateTime"),out time)||!Time(time,d)||!e.TryGetProperty("internetMessageHeaders",out var headers)||Header(headers,"x-projecttracker-operation")!=d.DispatchKey!.Value.ToString("N"))continue;
            if(found!=null)return null;found=id;
        }
        // A partial page could hide another match, so do not promote even a candidate to verified.
        return list.RootElement.TryGetProperty("@odata.nextLink",out _)?null:found;
    }
    public async Task<PersonalEmailDto> CheckAsync(Guid id,CancellationToken ct){
        var uid=ctx.RequireUserId();var tid=ctx.RequireTenantId();
        if(db.Database.CurrentTransaction!=null)throw new ConflictException("Check Sent separately from a data update.","EMAIL_TRANSACTION");
        await WorkspaceExecutionPrincipal.ConfigureAsync(services,uid,tid,null,ct);
        var d=await Mine.AsNoTracking().SingleOrDefaultAsync(d=>d.Id==id,ct)??throw new NotFoundException("Email receipt not found.");
        if(d.Status=="accepted")return Dto(d);
        if(d.Status is not ("unknown" or "sending"))throw new ConflictException("Only an uncertain send can be checked.");
        if(d.DispatchKey==null||d.ConfirmedAt==null||string.IsNullOrWhiteSpace(d.ConfirmedSenderEmail))throw new ConflictException("This older receipt has no correlation marker. Check your provider Sent folder manually; do not resend.","EMAIL_SENT_LEGACY");
        if(d.Status=="sending"&&d.ConfirmedAt>clock.Now.AddMinutes(-2))throw new ConflictException("The send is still processing. Reload its saved record shortly.","EMAIL_STILL_PROCESSING");
        var grant=await Access(d.Provider,ct);await Recheck(d.Provider,grant,ct);
        if(!grant.Account.Equals(d.ConfirmedSenderEmail,StringComparison.OrdinalIgnoreCase))throw new ConflictException("Connect the original confirmed sender before checking this receipt.","EMAIL_SENDER_CHANGED");
        string? match;
        try{
            using var bounded=CancellationTokenSource.CreateLinkedTokenSource(ct);bounded.CancelAfter(TimeSpan.FromSeconds(20));
            match=d.Provider=="google"?await Google(d,grant,bounded.Token):await Microsoft(d,grant,bounded.Token);
        }catch(Exception e)when(e is HttpRequestException or IOException or JsonException or FormatException or ArgumentOutOfRangeException or InvalidOperationException or OperationCanceledException){
            throw new AppException(503,"EMAIL_SENT_UNAVAILABLE","The provider Sent check was interrupted or unreadable. The outcome remains uncertain; do not resend.");
        }
        await Recheck(d.Provider,grant,ct);
        if(match==null)return Dto(d);
        await using var tx=await db.Database.BeginOwnedTransactionAsync(ct);
        if(await db.Users.Where(u=>u.Id==uid&&u.IsActive).ExecuteUpdateAsync(s=>s.SetProperty(u=>u.IsActive,u=>u.IsActive),ct)!=1||await db.TenantMembers.Where(m=>m.UserId==uid&&m.TenantId==tid).ExecuteUpdateAsync(s=>s.SetProperty(m=>m.Role,m=>m.Role),ct)!=1)throw new ForbiddenException("Your workspace membership is unavailable.");
        await Recheck(d.Provider,grant,ct,true);
        var won=await Mine.Where(r=>r.Id==id&&r.Version==d.Version&&r.DispatchKey==d.DispatchKey&&(r.Status=="unknown"||r.Status=="sending"))
            .ExecuteUpdateAsync(s=>s.SetProperty(r=>r.Status,"accepted").SetProperty(r=>r.ProviderMessageId,match).SetProperty(r=>r.ReconciledAt,clock.Now).SetProperty(r=>r.AcceptedAt,clock.Now).SetProperty(r=>r.Version,r=>r.Version+1),ct);
        if(won==1){recorder.Audit("personal_email.sent_copy_verified","PersonalEmailDraft",id,null,new{provider=d.Provider,status="accepted"});await db.SaveChangesAsync(ct);}
        await tx.CommitIfOwnedAsync(ct);
        return Dto(await Mine.AsNoTracking().SingleAsync(r=>r.Id==id,ct));
    }
}
