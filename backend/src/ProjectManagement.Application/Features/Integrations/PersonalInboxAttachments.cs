using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.Json;
using ProjectManagement.Application.Exceptions;
namespace ProjectManagement.Application.Features.Integrations;

public class PersonalInboxAttachmentOptions { public bool Enabled {get;set;} }
public record InboxAttachmentDto(string Name,int Size,string MediaType,bool Inline,string? DownloadToken,string? UnavailableReason);
public record InboxAttachmentsDto(IReadOnlyList<InboxAttachmentDto> Files,bool Truncated,int MaxDownloadBytes=2097152);
public record InboxAttachmentFile(byte[] Bytes,string Name);
public partial class PersonalInboxService
{
    private const int FileMaximum=2097152;
    private record Attachment(string Reference,string Name,int Size,string MediaType,bool Inline,bool File);
    private record AttachmentToken(string Purpose,string Provider,Guid User,Guid Tenant,Guid Connection,Guid ConsentEpoch,string Message,string Reference,string MetadataHash,DateTime ExpiresAt);
    private static string MetadataHash(Attachment file)=>Fingerprint(JsonSerializer.Serialize(file));
    private void AttachmentsEnabled(){if(!attachmentOptions.Value.Enabled)throw new ConflictException("Inbox attachment downloads are awaiting administrator setup.","INBOX_ATTACHMENTS_DISABLED");}
    private static string SafeName(string name){
        // A provider filename is display data, never a path, URL or executable rendering instruction.
        var safe=new string(name.Where(c=>!char.IsControl(c)&&!"/\\<>:\"|?*".Contains(c)&&c is not '\u202a' and not '\u202b' and not '\u202c' and not '\u202d' and not '\u202e' and not '\u2066' and not '\u2067' and not '\u2068' and not '\u2069').ToArray()).Trim().Trim('.');
        if(safe.Length>160)safe=safe[..160];return safe.Length==0?"attachment.bin":safe;
    }
    private static int Size(JsonElement value){
        if(!value.TryGetProperty("size",out var size)||size.ValueKind!=JsonValueKind.Number||!size.TryGetInt32(out var number)||number<0)throw Invalid();return number;
    }
    private async Task<(IReadOnlyList<Attachment> Files,bool Truncated)> AttachmentMetadataAsync(Grant grant,string message,CancellationToken ct){
        var path=Id(message,grant.Provider);var found=new List<Attachment>();var truncated=false;
        if(grant.Provider=="google"){
            var partFields="filename,mimeType,partId,body(size,attachmentId)";var fields=partFields;
            for(var depth=0;depth<8;depth++)fields=partFields+",parts("+fields+")";
            using var doc=await ReadAsync(grant,Gmail+"/messages/"+path+"?format=full&fields="+Uri.EscapeDataString("id,payload("+fields+")"),ct,131072);
            if(Text(doc.RootElement,"id")!=message||!doc.RootElement.TryGetProperty("payload",out var payload)||payload.ValueKind!=JsonValueKind.Object)throw Invalid();
            var seen=0;
            void Visit(JsonElement part,int depth){
                if(++seen>100||depth>8)throw Invalid();
                var name=Text(part,"filename",501);if(name.Length>500)throw Invalid();
                if(name.Length>0){
                    if(!part.TryGetProperty("body",out var body)||body.ValueKind!=JsonValueKind.Object)throw Invalid();
                    var reference=Text(body,"attachmentId",501);if(reference.Length>500)throw Invalid();
                    if(reference.Length>0)Id(reference,"microsoft");
                    found.Add(new(reference,SafeName(name),Size(body),Text(part,"mimeType",100),false,reference.Length>0));
                    if(found.Count>20)throw Invalid();
                }
                if(depth==8){truncated=true;return;}
                if(part.TryGetProperty("parts",out _))foreach(var child in Array(part,"parts",100))Visit(child,depth+1);
            }
            Visit(payload,0);
        }else{
            using var doc=await ReadAsync(grant,Graph+"/messages/"+path+"/attachments?$top=20&$select=id,name,size,contentType,isInline",ct,131072);
            foreach(var value in Array(doc.RootElement,"value",20)){
                var reference=Text(value,"id",501);Id(reference,"microsoft");
                var name=Text(value,"name",501);if(name.Length>500)throw Invalid();
                found.Add(new(reference,SafeName(name),Size(value),Text(value,"contentType",100),value.TryGetProperty("isInline",out var inline)&&inline.ValueKind==JsonValueKind.True,
                    Text(value,"@odata.type")=="#microsoft.graph.fileAttachment"));
            }
            // Cloud references and attached messages are not followed or recursively expanded.
            truncated=Text(doc.RootElement,"@odata.nextLink",6001).Length>0;
        }
        var ids=found.Where(f=>f.Reference.Length>0).Select(f=>f.Reference);if(ids.Distinct().Count()!=ids.Count())throw Invalid();
        return(found,truncated);
    }
    public async Task<InboxAttachmentsDto> AttachmentsAsync(string provider,string messageId,CancellationToken ct){
        AttachmentsEnabled();Id(messageId,provider);
        using var deadline=CancellationTokenSource.CreateLinkedTokenSource(ct);deadline.CancelAfter(TimeSpan.FromSeconds(20));
        try{
            var grant=await GrantAsync(provider,deadline.Token);var metadata=await AttachmentMetadataAsync(grant,messageId,deadline.Token);await RecheckAsync(grant,deadline.Token);AttachmentsEnabled();
            return new(metadata.Files.Select(file=>{
                var reason=!file.File?"Open this attachment in your mail provider.":file.Size>FileMaximum?"This file exceeds the 2 MiB download limit. Open it in your mail provider.":null;
                var token=reason==null?secrets.Protect(JsonSerializer.Serialize(new AttachmentToken("private-inbox-file-v1",provider,grant.User,grant.Tenant,grant.Connection,grant.ConsentEpoch,messageId,file.Reference,MetadataHash(file),clock.Now.AddMinutes(10)))):null;
                return new InboxAttachmentDto(file.Name,file.Size,file.MediaType,file.Inline,token,reason);
            }).ToArray(),metadata.Truncated);
        }catch(OperationCanceledException)when(!ct.IsCancellationRequested){throw new AppException(504,"INBOX_TIMEOUT","The attachment list took too long to respond.");}
        catch(HttpRequestException){throw new AppException(502,"INBOX_PROVIDER_ERROR","The attachment list could not be reached.");}
    }
    private AttachmentToken DecodeAttachment(string? encrypted){
        try{
            if(string.IsNullOrWhiteSpace(encrypted)||encrypted.Length>12000)throw new JsonException();
            var token=JsonSerializer.Deserialize<AttachmentToken>(secrets.Unprotect(encrypted))??throw new JsonException();
            if(token.Purpose!="private-inbox-file-v1"||token.User!=ctx.RequireUserId()||token.Tenant!=ctx.RequireTenantId()||token.ExpiresAt<=clock.Now||token.Provider is not ("google" or "microsoft"))throw new JsonException();
            Id(token.Message,token.Provider);Id(token.Reference,"microsoft");return token;
        }catch(Exception e)when(e is JsonException or CryptographicException or FormatException){throw new ValidationException("token","This download expired or belongs to a different account. Reload its attachment list.");}
    }
    public async Task<InboxAttachmentFile> DownloadAttachmentAsync(string? encrypted,CancellationToken ct){
        AttachmentsEnabled();var token=DecodeAttachment(encrypted);
        using var deadline=CancellationTokenSource.CreateLinkedTokenSource(ct);deadline.CancelAfter(TimeSpan.FromSeconds(20));
        try{
            var grant=await GrantAsync(token.Provider,deadline.Token);
            if(grant.Connection!=token.Connection||grant.ConsentEpoch!=token.ConsentEpoch)throw Changed();
            var metadata=await AttachmentMetadataAsync(grant,token.Message,deadline.Token);
            var file=metadata.Files.SingleOrDefault(f=>f.Reference==token.Reference)??throw new NotFoundException("Attachment not found.");
            if(!file.File||file.Size>FileMaximum||MetadataHash(file)!=token.MetadataHash)throw new ConflictException("The attachment changed. Reload its list.","INBOX_ATTACHMENT_CHANGED");
            byte[] bytes;
            if(grant.Provider=="google"){
                using var doc=await ReadAsync(grant,Gmail+"/messages/"+Id(token.Message,"google")+"/attachments/"+Id(token.Reference,"microsoft"),deadline.Token,FileMaximum*4/3+1024);
                if(Size(doc.RootElement)!=file.Size)throw Invalid();var data=Text(doc.RootElement,"data",FileMaximum*4/3+8);
                try{var encoded=data.Replace('-','+').Replace('_','/');bytes=Convert.FromBase64String(encoded.PadRight((encoded.Length+3)/4*4,'='));}catch(FormatException){throw Invalid();}
            }else{
                using var request=new HttpRequestMessage(HttpMethod.Get,Graph+"/messages/"+Id(token.Message,"microsoft")+"/attachments/"+Id(token.Reference,"microsoft")+"/$value");
                request.Headers.Authorization=new AuthenticationHeaderValue("Bearer",grant.Token);
                using var response=await http.CreateClient("microsoft-productivity").SendAsync(request,HttpCompletionOption.ResponseHeadersRead,deadline.Token);
                if(!response.IsSuccessStatusCode||response.Content.Headers.ContentLength>FileMaximum)throw Invalid();
                await using var stream=await response.Content.ReadAsStreamAsync(deadline.Token);var buffer=new byte[FileMaximum+1];var size=0;int read;
                while(size<buffer.Length&&(read=await stream.ReadAsync(buffer.AsMemory(size),deadline.Token))>0)size+=read;
                if(size>FileMaximum)throw Invalid();bytes=buffer[..size];
            }
            if(bytes.Length!=file.Size||bytes.Length>FileMaximum)throw Invalid();
            await RecheckAsync(grant,deadline.Token);AttachmentsEnabled();return new(bytes,file.Name);
        }catch(OperationCanceledException)when(!ct.IsCancellationRequested){throw new AppException(504,"INBOX_TIMEOUT","The attachment took too long to respond.");}
        catch(HttpRequestException){throw new AppException(502,"INBOX_PROVIDER_ERROR","The attachment could not be reached.");}
    }
}
