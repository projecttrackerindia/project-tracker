using System.Net.Http.Headers;
using System.Net.Mail;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
namespace ProjectManagement.Application.Features.Integrations;
public record SavePersonalEmailRequest(string Recipient,string Subject,string Body,int Version=0,string Provider="google");
public record SendPersonalEmailRequest(int Version,bool Confirmed,string SenderEmail);
public record EmailAiRequest(Guid OperationId,int Version,string Style,bool Confirmed,int Credits=0);
public record EmailAiOptions(bool Available,int Credits,int MaxBodyCharacters=6000);
public record PersonalEmailDto(Guid Id,string Recipient,string Subject,string Body,string Status,int Version,string? ProviderMessageId,DateTime? AcceptedAt,string Provider="google",string? ProviderRequestId=null,string? ConfirmedSenderEmail=null,DateTime? ReconciledAt=null,bool CanReconcile=false);
public class PersonalEmailService(IAppDbContext db,ICurrentContext ctx,GoogleCalendarAuthService google,
    IOptions<GoogleCalendarOptions> options,IHttpClientFactory http,AppClock clock,Recorder recorder,
    IAiClient ai,EntitlementService entitlements,IOptions<AiOptions> aiOptions,MicrosoftProductivityAuthService microsoft,IServiceProvider services,IOptions<MicrosoftProductivityOptions> microsoftOptions)
{
    private IQueryable<PersonalEmailDraft> Mine=>db.PersonalEmailDrafts.Where(d=>d.UserId==ctx.RequireUserId()&&d.Status!="deleted");
    private static PersonalEmailDto Dto(PersonalEmailDraft d)=>new(d.Id,d.Recipient,d.Subject,d.Body,d.Status,d.Version,d.ProviderMessageId,d.AcceptedAt,d.Provider,d.ProviderRequestId,d.ConfirmedSenderEmail,d.ReconciledAt,d.DispatchKey!=null);
    private async Task<PersonalEmailDraft> RequireAsync(Guid id,CancellationToken ct){
        ctx.RequireTenantId();return await Mine.FirstOrDefaultAsync(d=>d.Id==id,ct)??throw new NotFoundException("Email draft not found.");
    }
    private record SendGrant(string Provider,Guid User,Guid Tenant,Guid Connection,Guid ConsentEpoch,string Fingerprint,string Account,string Token);
    private void SeparateOperation(){
        if(db.Database.CurrentTransaction!=null)throw new ConflictException("Send or improve this draft separately from a data update.","EMAIL_TRANSACTION");
    }
    private async Task<SendGrant> Grant(string provider,CancellationToken ct){
        var uid=ctx.RequireUserId();var tid=ctx.RequireTenantId();
        await WorkspaceExecutionPrincipal.ConfigureAsync(services,uid,tid,null,ct);
        SendGrant grant;
        if(provider=="microsoft"){
            var access=await microsoft.GetMailGrantAsync(ct);
            grant=new(provider,uid,tid,access.ConnectionId,access.ConsentEpoch,access.RefreshFingerprint,access.Email,access.AccessToken);
        }else{
            var access=await google.GetAccessGrantAsync(uid,ct,GoogleCalendarAuthService.MailScope);
            grant=new(provider,uid,tid,access.ConnectionId,access.ConsentEpoch,access.RefreshFingerprint,access.Account,access.AccessToken);
        }
        await Recheck(grant,ct);return grant;
    }
    private async Task Recheck(SendGrant grant,CancellationToken ct){
        await WorkspaceExecutionPrincipal.ConfigureAsync(services,grant.User,grant.Tenant,null,ct);
        bool valid;
        if(grant.Provider=="microsoft"){
            var row=await db.MicrosoftConnections.AsNoTracking().SingleOrDefaultAsync(c=>c.UserId==grant.User,ct);
            valid=microsoftOptions.Value.Enabled&&microsoftOptions.Value.Configured&&row!=null&&row.Id==grant.Connection&&row.ConsentEpoch==grant.ConsentEpoch&&row.Email==grant.Account&&
                Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(row.RefreshTokenProtected)))==grant.Fingerprint&&row.Scopes.Split(' ').Any(s=>s.Split('/').Last().Equals("Mail.Send",StringComparison.OrdinalIgnoreCase));
        }else{
            var row=await db.GoogleConnections.AsNoTracking().SingleOrDefaultAsync(c=>c.UserId==grant.User,ct);
            valid=options.Value.MailEnabled&&google.Configured&&row!=null&&row.Id==grant.Connection&&row.ConsentEpoch==grant.ConsentEpoch&&row.GoogleEmail==grant.Account&&
                Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(row.RefreshTokenProtected)))==grant.Fingerprint&&row.Scopes.Split(' ').Contains(GoogleCalendarAuthService.MailScope);
        }
        if(!valid)throw new ConflictException("Your email connection changed. Reload before continuing.","EMAIL_CONNECTION_CHANGED");
    }
    private static (string Recipient,string Subject,string Body) Validate(SavePersonalEmailRequest req){
        if(req.Provider is not ("google" or "microsoft"))throw new ValidationException("provider","Choose Google or Microsoft.");
        var recipient=(req.Recipient??"").Trim();var subject=(req.Subject??"").Trim();var body=(req.Body??"").Trim();
        if(recipient.Length>254||recipient.Any(char.IsControl)||!MailAddress.TryCreate(recipient,out var parsed)||parsed.Address!=recipient)
            throw new ValidationException("recipient","Enter one valid email address, without a display name.");
        if(subject.Length is <1 or >200||subject.Any(char.IsControl))throw new ValidationException("subject","Use a subject of 1–200 characters without line breaks.");
        if(body.Length is <1 or >20000||body.Contains((char)0))throw new ValidationException("body","Use a message of 1–20,000 characters.");
        return(recipient,subject,body);
    }
    // Each RFC 2047 encoded word stays below 75 characters and never splits a UTF-8 rune.
    private static string EncodeSubject(string subject){
        var words=new List<string>();var chunk=new StringBuilder();var bytes=0;
        foreach(var rune in subject.EnumerateRunes()){
            if(bytes+rune.Utf8SequenceLength>42){words.Add("=?UTF-8?B?"+Convert.ToBase64String(Encoding.UTF8.GetBytes(chunk.ToString()))+"?=");chunk.Clear();bytes=0;}
            chunk.Append(rune.ToString());bytes+=rune.Utf8SequenceLength;
        }
        if(chunk.Length>0)words.Add("=?UTF-8?B?"+Convert.ToBase64String(Encoding.UTF8.GetBytes(chunk.ToString()))+"?=");
        return string.Join("\r\n ",words);
    }
    public async Task<IReadOnlyList<PersonalEmailDto>> ListAsync(CancellationToken ct){
        ctx.RequireTenantId();return await Mine.AsNoTracking().OrderByDescending(d=>d.CreatedAt).Take(100).Select(d=>new PersonalEmailDto(d.Id,d.Recipient,d.Subject,"",d.Status,d.Version,d.ProviderMessageId,d.AcceptedAt,d.Provider,d.ProviderRequestId,d.ConfirmedSenderEmail,d.ReconciledAt,d.DispatchKey!=null)).ToArrayAsync(ct);
    }
    public async Task<PersonalEmailDto> GetAsync(Guid id,CancellationToken ct)=>Dto(await RequireAsync(id,ct));
    public async Task<PersonalEmailDto> SaveAsync(Guid? id,SavePersonalEmailRequest req,CancellationToken ct){
        var tid=ctx.RequireTenantId();var uid=ctx.RequireUserId();var fields=Validate(req);
        await using var tx=await db.Database.BeginOwnedTransactionAsync(ct);
        if(await db.Users.Where(u=>u.Id==uid&&u.IsActive).ExecuteUpdateAsync(s=>s.SetProperty(u=>u.IsActive,u=>u.IsActive),ct)!=1)throw new ForbiddenException("Your account is unavailable.");
        PersonalEmailDraft row;
        if(id is {} existing){
            row=await RequireAsync(existing,ct);
            if(row.Status!="draft")throw new ConflictException("Only an unsent draft can be edited.");
            if(row.Version!=req.Version)throw new ConflictException("This draft changed. Reload before saving.");
            row.Version++;
        }else{
            if(await Mine.CountAsync(ct)>=100)throw new ConflictException("Remove old drafts before creating more.");
            row=new(){TenantId=tid,UserId=uid};db.PersonalEmailDrafts.Add(row);
        }
        row.Recipient=fields.Recipient;row.Subject=fields.Subject;row.Body=fields.Body;row.Provider=req.Provider;
        recorder.Audit("personal_email.draft_saved","PersonalEmailDraft",row.Id,null,new{row.Version});
        await db.SaveChangesAsync(ct);await tx.CommitIfOwnedAsync(ct);return Dto(row);
    }
    public async Task DeleteAsync(Guid id,CancellationToken ct){
        await using var tx=await db.Database.BeginOwnedTransactionAsync(ct);
        var row=await RequireAsync(id,ct);
        if(row.Status is "sending" or "unknown")throw new ConflictException("Check your mail provider for the delivery outcome before removing this receipt.");
        var unchanged=Mine.Where(d=>d.Id==id&&d.Version==row.Version&&d.Status==row.Status);
        var removed=row.Status=="draft"
            ?await unchanged.ExecuteDeleteAsync(ct)
            :await unchanged.ExecuteUpdateAsync(s=>s.SetProperty(d=>d.Status,"deleted")
                .SetProperty(d=>d.Recipient,"").SetProperty(d=>d.Subject,"").SetProperty(d=>d.Body,"")
                .SetProperty(d=>d.ConfirmedSenderEmail,(string?)null).SetProperty(d=>d.Version,d=>d.Version+1),ct);
        if(removed!=1)throw new ConflictException("This draft changed. Reload before removing it.");
        // Accepted receipts retain send evidence; their private AI results must disappear immediately.
        await db.PersonalEmailRewrites.Where(r=>r.DraftId==id&&r.UserId==row.UserId).ExecuteDeleteAsync(ct);
        recorder.Audit("personal_email.deleted","PersonalEmailDraft",id);await db.SaveChangesAsync(ct);
        await tx.CommitIfOwnedAsync(ct);
    }
    public async Task<EmailAiOptions> AiOptionsAsync(CancellationToken ct){
        ctx.RequireTenantId();
        var available=ai.Configured&&await entitlements.GetValueAsync(FeatureKeys.AiAssistant,ct)!=0
            &&!await db.Tenants.Where(t=>t.Id==ctx.TenantId).Select(t=>t.AiDisabled).FirstOrDefaultAsync(ct);
        return new(available,Math.Clamp(aiOptions.Value.Chat.Quick.Credits,1,10000));
    }
    public async Task<PersonalEmailDto> SendAsync(Guid id,SendPersonalEmailRequest req,CancellationToken ct){
        SeparateOperation();var row=await RequireAsync(id,ct);
        if(row.Provider is not ("google" or "microsoft"))throw new ConflictException("The saved provider is unavailable.","EMAIL_PROVIDER_INVALID");
        if(row.Provider=="google"&&(!options.Value.MailEnabled||!google.Configured))throw new ConflictException("Gmail sending is not enabled. Your private draft can still be edited.","GMAIL_DISABLED");
        if(!req.Confirmed)throw new ValidationException("confirmed","Review the sender, recipient and saved message before confirming.");
        if(row.Status=="accepted")return Dto(row);
        if(row.Status!="draft")throw new ConflictException("The previous send may have reached your provider. Check your Sent folder; do not resend.","EMAIL_OUTCOME_UNKNOWN");
        if(row.Version!=req.Version)throw new ConflictException("This draft changed. Reload before confirming.");
        var uid=ctx.RequireUserId();
        var grant=await Grant(row.Provider,ct);var senderEmail=grant.Account;var token=grant.Token;
        if(!MailAddress.TryCreate(senderEmail,out var sender)||sender.Address!=senderEmail||!string.Equals(senderEmail,req.SenderEmail,StringComparison.OrdinalIgnoreCase))
            throw new ConflictException("The connected sender changed or is unavailable. Reconnect and review again.","EMAIL_SENDER_CHANGED");
        // Provider identity and permission resolve before claiming: no email has been dispatched yet.
        var dispatchKey=Guid.NewGuid();
        var mime="From: "+sender.Address+"\r\nTo: "+row.Recipient+"\r\nSubject: "+EncodeSubject(row.Subject)+"\r\n"+
            "Message-ID: <pt-"+dispatchKey.ToString("N")+"@projecttracker.in>\r\nX-ProjectTracker-Operation: "+dispatchKey.ToString("N")+"\r\n"+
            "MIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n"+
            Convert.ToBase64String(Encoding.UTF8.GetBytes(row.Body),Base64FormattingOptions.InsertLineBreaks);
        await WorkspaceExecutionPrincipal.ConfigureAsync(services,uid,ctx.RequireTenantId(),null,ct);
        await using(var tx=await db.Database.BeginOwnedTransactionAsync(ct)){
            if(await db.Users.Where(u=>u.Id==uid&&u.IsActive).ExecuteUpdateAsync(s=>s.SetProperty(u=>u.IsActive,u=>u.IsActive),ct)!=1)throw new ForbiddenException("Your account is unavailable.");
            if(await db.PersonalEmailDrafts.CountAsync(d=>d.UserId==uid&&d.ConfirmedAt>=clock.Now.AddHours(-1),ct)>=10)throw new ConflictException("Ten email sends were confirmed in this workspace during the last hour. Try later.");
            var won=await Mine.Where(d=>d.Id==id&&d.Version==req.Version&&d.Status=="draft")
                .ExecuteUpdateAsync(s=>s.SetProperty(d=>d.Status,"sending").SetProperty(d=>d.DispatchKey,dispatchKey).SetProperty(d=>d.ConfirmedSenderEmail,senderEmail).SetProperty(d=>d.ConfirmedAt,clock.Now).SetProperty(d=>d.Version,d=>d.Version+1),ct);
            if(won!=1)throw new ConflictException("This draft changed or was already confirmed. Reload it.");
            recorder.Audit("personal_email.send_confirmed","PersonalEmailDraft",id,null,new{version=req.Version});
            await db.SaveChangesAsync(ct);await tx.CommitIfOwnedAsync(ct);
        }
        // There is no automatic HTTP retry. Gmail send has no documented idempotency key.
        string? providerId=null;string? providerRequestId=null;var accepted=false;
        try{
            await Recheck(grant,ct);
            using var dispatch=CancellationTokenSource.CreateLinkedTokenSource(ct);dispatch.CancelAfter(TimeSpan.FromSeconds(20));
            var isMicrosoft=row.Provider=="microsoft";
            using var request=new HttpRequestMessage(HttpMethod.Post,isMicrosoft?"https://graph.microsoft.com/v1.0/me/sendMail":"https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
            request.Headers.Authorization=new AuthenticationHeaderValue("Bearer",token);
            if(isMicrosoft){
                request.Headers.Add("client-request-id",Guid.NewGuid().ToString());
                request.Content=new StringContent(JsonSerializer.Serialize(new{
                    message=new{subject=row.Subject,body=new{contentType="Text",content=row.Body},
                        toRecipients=new[]{new{emailAddress=new{address=row.Recipient}}},
                        internetMessageHeaders=new[]{new{name="x-projecttracker-operation",value=dispatchKey.ToString("N")}}},
                    saveToSentItems=true}),Encoding.UTF8,"application/json");
            }else{
                var raw=Convert.ToBase64String(Encoding.UTF8.GetBytes(mime)).TrimEnd('=').Replace('+','-').Replace('/','_');
                request.Content=new StringContent(JsonSerializer.Serialize(new{raw}),Encoding.UTF8,"application/json");
            }
            using var response=await http.CreateClient(isMicrosoft?"microsoft-productivity":"google-calendar")
                .SendAsync(request,HttpCompletionOption.ResponseHeadersRead,dispatch.Token);
            if(isMicrosoft){
                // Graph 202 is acceptance only. It returns no message ID; never invent one or claim delivery.
                accepted=response.StatusCode==System.Net.HttpStatusCode.Accepted;
                if(accepted&&response.Headers.TryGetValues("request-id",out var ids)){
                    var receipt=ids.FirstOrDefault();
                    if(receipt is {Length:>0 and <=200}&&!receipt.Any(char.IsControl))providerRequestId=receipt;
                }
            }else if(response.IsSuccessStatusCode){
                await using var stream=await response.Content.ReadAsStreamAsync(dispatch.Token);
                var buffer=new byte[8193];var length=0;int read;
                while(length<buffer.Length&&(read=await stream.ReadAsync(buffer.AsMemory(length),dispatch.Token))>0)length+=read;
                if(length>8192)throw new JsonException("Oversized provider receipt");
                using var payload=JsonDocument.Parse(buffer.AsMemory(0,length));
                if(payload.RootElement.ValueKind==JsonValueKind.Object&&payload.RootElement.TryGetProperty("id",out var value)&&value.ValueKind==JsonValueKind.String&&value.GetString() is {Length:>0 and <=200} returned){
                    providerId=returned;accepted=true;
                }
            }
            await Recheck(grant,ct);
        }catch(Exception e)when(e is HttpRequestException or OperationCanceledException or JsonException or IOException or ConflictException or ForbiddenException){accepted=false;providerId=null;providerRequestId=null;}
        // Persist independently of a closed browser. A process crash leaves "sending", which also blocks retries.
        var finalStatus=accepted?"accepted":"unknown";var acceptedAt=accepted?(DateTime?)clock.Now:null;
        await Mine.Where(d=>d.Id==id&&d.Status=="sending")
            .ExecuteUpdateAsync(s=>s.SetProperty(d=>d.Status,finalStatus).SetProperty(d=>d.ProviderMessageId,providerId)
                .SetProperty(d=>d.ProviderRequestId,providerRequestId).SetProperty(d=>d.AcceptedAt,acceptedAt).SetProperty(d=>d.Version,d=>d.Version+1),CancellationToken.None);
        recorder.Audit("personal_email.send_outcome","PersonalEmailDraft",id,null,new{status=finalStatus});
        await db.SaveChangesAsync(CancellationToken.None);
        await WorkspaceExecutionPrincipal.ConfigureAsync(services,row.UserId,row.TenantId,null,CancellationToken.None);
        var final=await Mine.AsNoTracking().SingleAsync(d=>d.Id==id,CancellationToken.None);
        return Dto(final);
    }
}
