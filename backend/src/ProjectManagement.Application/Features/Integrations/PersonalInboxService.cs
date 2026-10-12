using System.Globalization;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;

namespace ProjectManagement.Application.Features.Integrations;

public record InboxMessageDto(string Id,string ThreadId,string Subject,string Sender,DateTimeOffset? ReceivedAt,bool Unread,bool HasAttachments,string? Body=null,bool BodyTruncated=false);
public record InboxPageDto(string Provider,string Account,IReadOnlyList<InboxMessageDto> Messages,string? Cursor);
public record InboxThreadDto(string Provider,string Account,string ThreadId,IReadOnlyList<InboxMessageDto> Messages,bool Truncated,string SourceHash="",string AccessContext="");

// Own-mailbox reads only. Mail content stays in the request, never in logs, audit payloads or shared caches.
public class PersonalInboxService(IAppDbContext db,ICurrentContext ctx,GoogleCalendarAuthService google,
    MicrosoftProductivityAuthService microsoft,IOptions<GoogleCalendarOptions> googleOptions,
    IOptions<MicrosoftProductivityOptions> microsoftOptions,IHttpClientFactory http,ISecretProtector secrets,
    IServiceProvider services,AppClock clock)
{
    private const string Graph="https://graph.microsoft.com/v1.0/me";
    private const string Gmail="https://gmail.googleapis.com/gmail/v1/users/me";
    private const string Metadata="id,conversationId,subject,from,receivedDateTime,isRead,hasAttachments";
    private record Grant(string Provider,Guid User,Guid Tenant,Guid Connection,string Fingerprint,string Account,string Token,Guid ConsentEpoch);
    private record PageToken(string Purpose,string Provider,Guid User,Guid Tenant,Guid Connection,string Fingerprint,string Next,DateTime ExpiresAt);
    private static ConflictException Changed()=>new("Your mailbox connection changed. Reload the inbox.","INBOX_CONNECTION_CHANGED");
    private static ConflictException Invalid()=>new("The mail provider returned an invalid response.","INBOX_PROVIDER_ERROR");
    private static string Fingerprint(string token)=>Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));
    private async Task<Grant> GrantAsync(string provider,CancellationToken ct)
    {
        var uid=ctx.RequireUserId();var tid=ctx.RequireTenantId();
        await WorkspaceExecutionPrincipal.ConfigureAsync(services,uid,tid,null,ct);
        if(provider=="google"){
            if(!googleOptions.Value.InboxEnabled||!google.Configured)throw new ConflictException("Gmail inbox access is awaiting administrator setup.","INBOX_DISABLED");
            var access=await google.GetAccessGrantAsync(uid,ct,GoogleCalendarAuthService.InboxScope);
            var grant=new Grant(provider,uid,tid,access.ConnectionId,access.RefreshFingerprint,access.Account,access.AccessToken,access.ConsentEpoch);
            await RecheckAsync(grant,ct);return grant;
        }
        if(provider=="microsoft"){
            if(!microsoftOptions.Value.InboxEnabled)throw new ConflictException("Microsoft inbox access is awaiting administrator setup.","INBOX_DISABLED");
            var access=await microsoft.GetInboxGrantAsync(ct);
            var grant=new Grant(provider,uid,tid,access.ConnectionId,access.RefreshFingerprint,access.Email,access.AccessToken,access.ConsentEpoch);
            await RecheckAsync(grant,ct);return grant;
        }
        throw new ValidationException("provider","Choose Google or Microsoft.");
    }
    private async Task RecheckAsync(Grant grant,CancellationToken ct)
    {
        await WorkspaceExecutionPrincipal.ConfigureAsync(services,grant.User,grant.Tenant,null,ct);
        if(grant.Provider=="google"){
            var row=await db.GoogleConnections.AsNoTracking().SingleOrDefaultAsync(c=>c.UserId==grant.User,ct);
            if(!googleOptions.Value.InboxEnabled||row==null||row.Id!=grant.Connection||row.ConsentEpoch!=grant.ConsentEpoch||Fingerprint(row.RefreshTokenProtected)!=grant.Fingerprint||row.GoogleEmail!=grant.Account||!row.Scopes.Split(' ').Contains(GoogleCalendarAuthService.InboxScope))throw Changed();
        }else{
            var row=await db.MicrosoftConnections.AsNoTracking().SingleOrDefaultAsync(c=>c.UserId==grant.User,ct);
            if(!microsoftOptions.Value.Enabled||!microsoftOptions.Value.InboxEnabled||row==null||row.Id!=grant.Connection||row.ConsentEpoch!=grant.ConsentEpoch||Fingerprint(row.RefreshTokenProtected)!=grant.Fingerprint||row.Email!=grant.Account||!row.Scopes.Split(' ').Any(s=>s.Split('/').Last().Equals("Mail.Read",StringComparison.OrdinalIgnoreCase)))throw Changed();
        }
    }
    private async Task<JsonDocument> ReadAsync(Grant grant,string url,CancellationToken ct,int maximum=65536)
    {
        using var request=new HttpRequestMessage(HttpMethod.Get,url);
        request.Headers.Authorization=new AuthenticationHeaderValue("Bearer",grant.Token);
        if(grant.Provider=="microsoft")request.Headers.Add("Prefer","outlook.body-content-type=\"text\"");
        using var response=await http.CreateClient(grant.Provider=="google"?"google-calendar":"microsoft-productivity")
            .SendAsync(request,HttpCompletionOption.ResponseHeadersRead,ct);
        if(!response.IsSuccessStatusCode)throw new ConflictException("The mailbox could not be read. Reconnect or try again.","INBOX_PROVIDER_ERROR");
        await using var stream=await response.Content.ReadAsStreamAsync(ct);
        var buffer=new byte[maximum+1];var size=0;int count;
        while(size<buffer.Length&&(count=await stream.ReadAsync(buffer.AsMemory(size),ct))>0)size+=count;
        if(size>maximum)throw Invalid();
        try{
            var doc=JsonDocument.Parse(buffer.AsMemory(0,size));
            if(doc.RootElement.ValueKind!=JsonValueKind.Object){doc.Dispose();throw Invalid();}return doc;
        }catch(JsonException){throw Invalid();}
    }
    private static string Text(JsonElement root,string name,int limit=500)
    {
        if(!root.TryGetProperty(name,out var value)||value.ValueKind!=JsonValueKind.String)return "";
        var text=value.GetString()??"";return text.Length>limit?text[..limit]:text;
    }
    private static string Id(string? id,string provider)
    {
        if(string.IsNullOrWhiteSpace(id)||id.Length>500||id.Any(c=>!char.IsAsciiLetterOrDigit(c)&&!"_-+/=".Contains(c))||
           provider=="google"&&id.Any(c=>!Uri.IsHexDigit(c)))throw new ValidationException("messageId","Invalid mailbox message reference.");
        return Uri.EscapeDataString(id);
    }
    private static JsonElement[] Array(JsonElement root,string name,int maximum)
    {
        if(!root.TryGetProperty(name,out var array)||array.ValueKind!=JsonValueKind.Array||array.GetArrayLength()>maximum)throw Invalid();
        var items=array.EnumerateArray().ToArray();if(items.Any(i=>i.ValueKind!=JsonValueKind.Object))throw Invalid();return items;
    }
    private static DateTimeOffset? Date(string text)=>DateTimeOffset.TryParse(text,CultureInfo.InvariantCulture,DateTimeStyles.AssumeUniversal,out var date)?date:null;
    private static InboxMessageDto Outlook(JsonElement value,bool body=false)
    {
        var id=Text(value,"id");Id(id,"microsoft");var thread=Text(value,"conversationId");
        var sender=value.TryGetProperty("from",out var from)&&from.ValueKind==JsonValueKind.Object&&from.TryGetProperty("emailAddress",out var email)&&email.ValueKind==JsonValueKind.Object?Text(email,"address",254):"";
        string? content=null;var truncated=false;
        if(body&&value.TryGetProperty("body",out var b)&&b.ValueKind==JsonValueKind.Object){
            // Never deliver provider HTML to the browser. A provider ignoring Prefer fails closed to a plain-text notice.
            if(Text(b,"contentType").Equals("text",StringComparison.OrdinalIgnoreCase)){
                content=Text(b,"content",20001);truncated=content.Length>20000;if(truncated)content=content[..20000];
            }else{content="This message has no available plain-text body.";truncated=true;}
        }
        return new(id,thread,Text(value,"subject",500),sender,Date(Text(value,"receivedDateTime")),value.TryGetProperty("isRead",out var read)&&read.ValueKind==JsonValueKind.False,
            value.TryGetProperty("hasAttachments",out var attachments)&&attachments.ValueKind==JsonValueKind.True,content,truncated);
    }
    private static InboxMessageDto Google(JsonElement value,bool body=false)
    {
        var id=Text(value,"id");Id(id,"google");var thread=Text(value,"threadId");Id(thread,"google");
        var headers=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
        var hasPayload=value.TryGetProperty("payload",out var payload)&&payload.ValueKind==JsonValueKind.Object;
        if(hasPayload&&payload.TryGetProperty("headers",out var headerArray)&&headerArray.ValueKind==JsonValueKind.Array){
            foreach(var header in headerArray.EnumerateArray().Take(100))if(header.ValueKind==JsonValueKind.Object)headers[Text(header,"name",100)]=Text(header,"value",1000);
        }
        var unread=value.TryGetProperty("labelIds",out var labels)&&labels.ValueKind==JsonValueKind.Array&&labels.EnumerateArray().Any(l=>l.ValueKind==JsonValueKind.String&&l.GetString()=="UNREAD");
        var content=new StringBuilder();var truncated=false;var attachments=false;var parts=0;
        void Part(JsonElement part,int depth){
            if(depth>8||++parts>50){truncated=true;return;}
            if(Text(part,"filename").Length>0){attachments=true;return;}
            if(body&&Text(part,"mimeType")=="text/plain"&&part.TryGetProperty("body",out var pbody)&&pbody.ValueKind==JsonValueKind.Object){
                var data=Text(pbody,"data",30001);
                if(data.Length>30000){truncated=true;data="";}
                if(data.Length>0){
                    try{
                        var raw=data.Replace('-','+').Replace('_','/');raw=raw.PadRight((raw.Length+3)/4*4,'=');
                        var decoded=new UTF8Encoding(false,true).GetString(Convert.FromBase64String(raw));
                        var remaining=20000-content.Length;if(decoded.Length>remaining){decoded=decoded[..remaining];truncated=true;}
                        content.Append(decoded);
                    }catch(Exception e)when(e is FormatException or DecoderFallbackException){throw Invalid();}
                }
            }
            if(part.TryGetProperty("parts",out var children)&&children.ValueKind==JsonValueKind.Array){
                foreach(var child in children.EnumerateArray().Take(51))if(child.ValueKind==JsonValueKind.Object)Part(child,depth+1);
                if(children.GetArrayLength()>50)truncated=true;
            }
        }
        if(hasPayload)Part(payload,0);
        if(body&&content.Length==0){content.Append("This message has no available plain-text body.");truncated=true;}
        var date=value.TryGetProperty("internalDate",out var ms)&&ms.ValueKind==JsonValueKind.String&&long.TryParse(ms.GetString(),out var epoch)&&epoch>=0&&epoch<=253402300799999?DateTimeOffset.FromUnixTimeMilliseconds(epoch):Date(headers.GetValueOrDefault("Date",""));
        return new(id,thread,headers.GetValueOrDefault("Subject",""),headers.GetValueOrDefault("From",""),date,unread,attachments,body?content.ToString():null,truncated);
    }
    private static string GraphNext(string next)
    {
        // Preserve the provider cursor verbatim, but never turn a returned URL into arbitrary authenticated fetches.
        if(next.Length>6000||!Uri.TryCreate(next,UriKind.Absolute,out var uri)||uri.Scheme!="https"||uri.Host!="graph.microsoft.com"||!uri.IsDefaultPort||uri.UserInfo.Length!=0||uri.Fragment.Length!=0||uri.AbsolutePath!="/v1.0/me/mailFolders/inbox/messages")throw Invalid();
        return next;
    }
    private string? Cursor(Grant grant,string next)
    {
        if(next.Length==0)return null;
        if(grant.Provider=="microsoft")GraphNext(next);else if(next.Length>2000||next.Any(char.IsControl))throw Invalid();
        return secrets.Protect(JsonSerializer.Serialize(new PageToken("private-inbox-v1",grant.Provider,grant.User,grant.Tenant,grant.Connection,grant.Fingerprint,next,clock.Now.AddMinutes(10))));
    }
    private string Decode(Grant grant,string cursor)
    {
        try{
            if(cursor.Length>12000)throw new JsonException();
            var token=JsonSerializer.Deserialize<PageToken>(secrets.Unprotect(cursor))??throw new JsonException();
            if(token.Purpose!="private-inbox-v1"||token.Provider!=grant.Provider||token.User!=grant.User||token.Tenant!=grant.Tenant||token.Connection!=grant.Connection||token.Fingerprint!=grant.Fingerprint||token.ExpiresAt<=clock.Now)throw new JsonException();
            return grant.Provider=="microsoft"?GraphNext(token.Next):token.Next;
        }catch(Exception e)when(e is JsonException or CryptographicException or FormatException){throw new ValidationException("cursor","This inbox page expired or belongs to a different connection. Reload the inbox.");}
    }
    public async Task<InboxPageDto> ListAsync(string provider,string? cursor,CancellationToken ct)
    {
        using var deadline=CancellationTokenSource.CreateLinkedTokenSource(ct);deadline.CancelAfter(TimeSpan.FromSeconds(20));
        try{
            var grant=await GrantAsync(provider,deadline.Token);var next=string.IsNullOrEmpty(cursor)?"":Decode(grant,cursor);
            IReadOnlyList<InboxMessageDto> items;string continuation;
            if(provider=="google"){
                using var page=await ReadAsync(grant,Gmail+"/messages?maxResults=20&labelIds=INBOX"+(next.Length>0?"&pageToken="+Uri.EscapeDataString(next):""),deadline.Token);
                var messages=page.RootElement.TryGetProperty("messages",out _)?Array(page.RootElement,"messages",20):[];
                var found=new List<InboxMessageDto>();
                // Four bounded metadata reads at a time, no DbContext calls run concurrently.
                for(var offset=0;offset<messages.Length;offset+=4){
                    var batch=await Task.WhenAll(messages.Skip(offset).Take(4).Select(async m=>{
                        using var detail=await ReadAsync(grant,Gmail+"/messages/"+Id(Text(m,"id"),provider)+"?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date",deadline.Token);
                        var result=Google(detail.RootElement);if(result.Id!=Text(m,"id"))throw Invalid();return result;
                    }));found.AddRange(batch);
                }
                items=found;continuation=Text(page.RootElement,"nextPageToken",2001);
            }else{
                using var page=await ReadAsync(grant,next.Length>0?next:Graph+"/mailFolders/inbox/messages?$top=20&$orderby=receivedDateTime%20desc&$select="+Metadata,deadline.Token);
                items=Array(page.RootElement,"value",20).Select(m=>Outlook(m)).ToArray();continuation=Text(page.RootElement,"@odata.nextLink",6001);
            }
            if(items.Select(m=>m.Id).Distinct().Count()!=items.Count)throw Invalid();
            await RecheckAsync(grant,deadline.Token);
            return new(provider,grant.Account,items,Cursor(grant,continuation));
        }catch(OperationCanceledException)when(!ct.IsCancellationRequested){throw new AppException(504,"INBOX_TIMEOUT","The mailbox took too long to respond. Try again.");}
        catch(HttpRequestException){throw new AppException(502,"INBOX_PROVIDER_ERROR","The mailbox could not be reached. Try again.");}
    }
    public async Task<InboxThreadDto> ThreadAsync(string provider,string messageId,CancellationToken ct)
    {
        var encoded=Id(messageId,provider);
        using var deadline=CancellationTokenSource.CreateLinkedTokenSource(ct);deadline.CancelAfter(TimeSpan.FromSeconds(20));
        try{
            var grant=await GrantAsync(provider,deadline.Token);InboxMessageDto[] messages;string thread;bool truncated;
            if(provider=="google"){
                using var selected=await ReadAsync(grant,Gmail+"/messages/"+encoded+"?format=metadata",deadline.Token);
                if(Text(selected.RootElement,"id")!=messageId)throw Invalid();
                thread=Text(selected.RootElement,"threadId");
                using var detail=await ReadAsync(grant,Gmail+"/threads/"+Id(thread,provider)+"?format=full",deadline.Token,1048576);
                if(Text(detail.RootElement,"id")!=thread)throw Invalid();
                var source=Array(detail.RootElement,"messages",100);truncated=source.Length>10;
                messages=source.TakeLast(10).Select(m=>Google(m,true)).ToArray();
                if(messages.Any(m=>m.ThreadId!=thread))throw Invalid();
            }else{
                using var selected=await ReadAsync(grant,Graph+"/messages/"+encoded+"?$select="+Metadata+",body",deadline.Token,1048576);
                var root=Outlook(selected.RootElement,true);thread=root.ThreadId;if(root.Id!=messageId)throw Invalid();
                if(thread.Length==0)throw Invalid();
                var filter=Uri.EscapeDataString("conversationId eq '"+thread.Replace("'","''")+"'");
                using var detail=await ReadAsync(grant,Graph+"/messages?$top=10&$filter="+filter+"&$select="+Metadata+",body",deadline.Token,1048576);
                messages=Array(detail.RootElement,"value",10).Select(m=>Outlook(m,true)).ToArray();
                if(messages.Any(m=>m.ThreadId!=thread))throw Invalid();
                var missing=!messages.Any(m=>m.Id==root.Id);
                truncated=Text(detail.RootElement,"@odata.nextLink",6001).Length>0||missing&&messages.Length==10;
                if(missing)messages=messages.Take(9).Append(root).ToArray();
            }
            if(messages.Select(m=>m.Id).Distinct().Count()!=messages.Length)throw Invalid();
            // Shorten aggregate body size as well as individual bodies, and tell the reader about omissions.
            var remaining=60000;
            messages=messages.OrderBy(m=>m.ReceivedAt).Select(m=>{
                var b=m.Body??"";var cut=b.Length>remaining;var result=m with{Body=cut?b[..remaining]:b,BodyTruncated=m.BodyTruncated||cut};remaining-=result.Body!.Length;return result;
            }).ToArray();
            await RecheckAsync(grant,deadline.Token);
            var limited=truncated||messages.Any(m=>m.BodyTruncated);
            var accessContext=Fingerprint(JsonSerializer.Serialize(new{grant.Provider,grant.User,grant.Tenant,grant.Connection,grant.ConsentEpoch,grant.Account}));
            var sourceHash=Fingerprint(JsonSerializer.Serialize(new{accessContext,thread,limited,messages=messages.Select(m=>new{m.Id,m.Subject,m.Sender,m.ReceivedAt,m.Body,m.BodyTruncated,m.HasAttachments})}));
            return new(provider,grant.Account,thread,messages,limited,sourceHash,accessContext);
        }catch(OperationCanceledException)when(!ct.IsCancellationRequested){throw new AppException(504,"INBOX_TIMEOUT","The mailbox took too long to respond. Try again.");}
        catch(HttpRequestException){throw new AppException(502,"INBOX_PROVIDER_ERROR","The mailbox could not be reached. Try again.");}
    }
}
