using System.Net;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Integrations;
using ProjectManagement.Tests.Infrastructure;
namespace ProjectManagement.Tests;
[Collection("api")]
public class PersonalInboxAttachmentTests(ApiFactory factory)
{
    private const string Route="/api/v1/me/inbox/attachments";
    private PersonalInboxAttachmentOptions Options=>factory.Services.GetRequiredService<IOptions<PersonalInboxAttachmentOptions>>().Value;
    private GoogleCalendarOptions Google=>factory.Services.GetRequiredService<IOptions<GoogleCalendarOptions>>().Value;
    private MicrosoftProductivityOptions Microsoft=>factory.Services.GetRequiredService<IOptions<MicrosoftProductivityOptions>>().Value;
    private FakeInboxMailbox Mailbox(string provider)=>provider=="google"?factory.GoogleCalendar.Inbox:factory.MicrosoftProductivity.Inbox;
    private static string Message(string provider)=>provider=="google"?"1001":"message1";
    private static string List(string provider)=>Route+"?provider="+provider+"&messageId="+Message(provider);
    private static string Download(string token)=>Route+"/download?token="+Uri.EscapeDataString(token);
    private async Task Connect(TestClient owner,string provider){
        var start=await owner.Get($"/api/v1/integrations/{provider}/connect?inbox=true");Assert.True(start.Ok,start.ToString());
        var state=new Uri(start.Data!["url"]!.GetValue<string>()).Query.TrimStart('?').Split('&').Select(p=>p.Split('=',2)).Single(p=>p[0]=="state")[1];
        using var browser=factory.CreateClient(new WebApplicationFactoryClientOptions{AllowAutoRedirect=false});browser.DefaultRequestHeaders.Add("Cookie",start.Headers["Set-Cookie"].Split(';')[0]);
        var code=provider=="google"?factory.GoogleCalendar.IssueCode("private@example.test",GoogleCalendarAuthService.InboxScope):factory.MicrosoftProductivity.IssueCode("private@example.test","User.Read Mail.Send Mail.Read");
        using var callback=await browser.GetAsync($"/api/v1/integrations/{provider}/callback?state={state}&code={code}");Assert.EndsWith(provider+"=connected",callback.Headers.Location!.ToString());
    }
    private async Task<TestClient> Setup(string provider){
        Options.Enabled=true;Google.InboxEnabled=true;Microsoft.Enabled=true;Microsoft.InboxEnabled=true;Microsoft.ClientId="12345678-1234-1234-1234-123456789012";Microsoft.ClientSecret="fixture-secret";Microsoft.RedirectUri="https://testhost/api/v1/integrations/microsoft/callback";
        Mailbox(provider).HasAttachment=true;
        var owner=await TestClient.RegisterAsync(factory,"Private file owner");await owner.CreateOrgAsync();await Connect(owner,provider);return owner;
    }
    private void Reset(){Options.Enabled=false;Google.InboxEnabled=false;factory.GoogleCalendar.Inbox.Reset();Microsoft.Enabled=false;Microsoft.InboxEnabled=false;Microsoft.ClientId=null;Microsoft.ClientSecret=null;Microsoft.RedirectUri=null;factory.MicrosoftProductivity.Reset();}
    private async Task<string> Token(TestClient owner,string provider){var result=await owner.Get(List(provider));Assert.True(result.Ok,result.ToString());return result.Data!["files"]![0]!["downloadToken"]!.GetValue<string>();}
    [Theory][InlineData("google")][InlineData("microsoft")]
    public async Task Listing_is_metadata_only_and_explicit_downloads_are_owner_bound_opaque_safe_files(string provider){
        try{
            var owner=await Setup(provider);var googleSends=factory.GoogleCalendar.SentMail.Count;var microsoftSends=factory.MicrosoftProductivity.SentMessages.Count;var aiCalls=factory.Ai.Prompts.Count;
            Mailbox(provider).AttachmentName="../private\r\n<script>.txt";var token=await Token(owner,provider);
            Assert.DoesNotContain("Private file content",(await owner.Get(List(provider))).ToString());Assert.DoesNotContain("private",token,StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain(Mailbox(provider).Requests,u=>u.Contains("/attachments/file1"));
            using var file=await owner.Raw(Download(token));Assert.Equal(HttpStatusCode.OK,file.StatusCode);Assert.Equal(Mailbox(provider).AttachmentBytes,await file.Content.ReadAsByteArrayAsync());
            Assert.Equal("application/octet-stream",file.Content.Headers.ContentType!.MediaType);Assert.Equal("attachment",file.Content.Headers.ContentDisposition!.DispositionType);Assert.Contains("nosniff",file.Headers.GetValues("X-Content-Type-Options"));
            Assert.DoesNotContain('/',file.Content.Headers.ContentDisposition.FileName!);Assert.DoesNotContain('\r',file.Content.Headers.ContentDisposition.FileName!);
            var other=await TestClient.RegisterAsync(factory,"Foreign file reader");await other.CreateOrgAsync();await Connect(other,provider);
            var before=Mailbox(provider).Requests.Count;Assert.Equal(HttpStatusCode.UnprocessableEntity,(await other.Get(Download(token))).Status);Assert.Equal(before,Mailbox(provider).Requests.Count);
            Assert.Equal(aiCalls,factory.Ai.Prompts.Count);Assert.Equal(googleSends,factory.GoogleCalendar.SentMail.Count);Assert.Equal(microsoftSends,factory.MicrosoftProductivity.SentMessages.Count);
        }finally{Reset();}
    }
    [Theory][InlineData("google")][InlineData("microsoft")]
    public async Task Reconnect_forgery_expiry_and_changed_file_metadata_prevent_download(string provider){
        try{
            var owner=await Setup(provider);var token=await Token(owner,provider);
            var secrets=factory.Services.GetRequiredService<ISecretProtector>();var payload=JsonNode.Parse(secrets.Unprotect(token))!;payload["ExpiresAt"]=DateTime.UtcNow.AddMinutes(-1);
            Assert.Equal(HttpStatusCode.UnprocessableEntity,(await owner.Get(Download(secrets.Protect(payload.ToJsonString())))).Status);
            Assert.Equal(HttpStatusCode.UnprocessableEntity,(await owner.Get(Download("forged"))).Status);Assert.Equal(HttpStatusCode.UnprocessableEntity,(await owner.Get(Route+"/download")).Status);
            Mailbox(provider).AttachmentName="changed.txt";Assert.Equal("INBOX_ATTACHMENT_CHANGED",(await owner.Get(Download(token))).ErrorCode);
            Mailbox(provider).AttachmentName="review.txt";await Connect(owner,provider);Assert.Equal("INBOX_CONNECTION_CHANGED",(await owner.Get(Download(token))).ErrorCode);
            Assert.DoesNotContain(Mailbox(provider).Requests,u=>u.Contains("/attachments/file1"));
        }finally{Reset();}
    }
    [Theory][InlineData("google")][InlineData("microsoft")]
    public async Task Revocation_during_binary_retrieval_never_returns_file_content(string provider){
        try{
            var owner=await Setup(provider);var token=await Token(owner,provider);
            Mailbox(provider).BeforeDownload=()=>factory.WithDb(db=>db.TenantMembers.Where(m=>m.TenantId==owner.WorkspaceId&&m.UserId==owner.UserId).ExecuteDelete());
            using var file=await owner.Raw(Download(token));Assert.Equal(HttpStatusCode.Forbidden,file.StatusCode);Assert.DoesNotContain("Private file content",await file.Content.ReadAsStringAsync());
        }finally{Reset();}
    }
    [Theory][InlineData("google")][InlineData("microsoft")]
    public async Task Oversize_metadata_is_not_downloadable_and_lying_content_size_is_rejected(string provider){
        try{
            var owner=await Setup(provider);Mailbox(provider).AttachmentSize=2097153;var list=await owner.Get(List(provider));Assert.True(list.Ok,list.ToString());Assert.Null(list.Data!["files"]![0]!["downloadToken"]);Assert.NotNull(list.Data["files"]![0]!["unavailableReason"]);
            Mailbox(provider).AttachmentSize=4;var token=await Token(owner,provider);Assert.Equal("INBOX_PROVIDER_ERROR",(await owner.Get(Download(token))).ErrorCode);
            Options.Enabled=false;Assert.Equal("INBOX_ATTACHMENTS_DISABLED",(await owner.Get(List(provider))).ErrorCode);Assert.Equal("INBOX_ATTACHMENTS_DISABLED",(await owner.Get(Download(token))).ErrorCode);
        }finally{Reset();}
    }
    [Fact]
    public async Task Cloud_references_and_attached_messages_are_never_followed(){
        try{
            var owner=await Setup("microsoft");
            foreach(var type in new[]{"#microsoft.graph.referenceAttachment","#microsoft.graph.itemAttachment"}){
                Mailbox("microsoft").AttachmentType=type;var list=await owner.Get(List("microsoft"));Assert.True(list.Ok,list.ToString());Assert.Null(list.Data!["files"]![0]!["downloadToken"]);
            }
            Assert.All(Mailbox("microsoft").Requests,u=>Assert.StartsWith("https://graph.microsoft.com/v1.0/me/messages/message1/attachments",u));
        }finally{Reset();}
    }
}
