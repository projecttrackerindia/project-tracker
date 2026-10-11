using System.Net;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Integrations;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;
namespace ProjectManagement.Tests;
[Collection("api")]
public class PersonalInboxTests(ApiFactory factory)
{
    private GoogleCalendarOptions Google=>factory.Services.GetRequiredService<IOptions<GoogleCalendarOptions>>().Value;
    private MicrosoftProductivityOptions Microsoft=>factory.Services.GetRequiredService<IOptions<MicrosoftProductivityOptions>>().Value;
    private void Enable(){
        Google.InboxEnabled=true;
        Microsoft.Enabled=true;Microsoft.InboxEnabled=true;Microsoft.ClientId="12345678-1234-1234-1234-123456789012";
        Microsoft.ClientSecret="fixture-secret";Microsoft.RedirectUri="https://testhost/api/v1/integrations/microsoft/callback";
    }
    private void Reset(){
        Google.InboxEnabled=false;factory.GoogleCalendar.Inbox.Reset();Microsoft.Enabled=false;Microsoft.InboxEnabled=false;
        Microsoft.ClientId=null;Microsoft.ClientSecret=null;Microsoft.RedirectUri=null;factory.MicrosoftProductivity.Reset();
    }
    private FakeInboxMailbox Mailbox(string provider)=>provider=="google"?factory.GoogleCalendar.Inbox:factory.MicrosoftProductivity.Inbox;
    private static string Message(string provider)=>provider=="google"?"1001":"message1";
    private static string Query(ApiResult start,string key)=>new Uri(start.Data!["url"]!.GetValue<string>()).Query.TrimStart('?').Split('&').Select(p=>p.Split('=',2)).Where(p=>p[0]==key).Select(p=>Uri.UnescapeDataString(p[1])).Single();
    private async Task<ApiResult> Start(TestClient owner,string provider,bool inbox=true)=>await owner.Get($"/api/v1/integrations/{provider}/connect"+(inbox?"?inbox=true":""));
    private async Task<string> Complete(ApiResult start,string provider,string email,bool read=true){
        using var browser=factory.CreateClient(new WebApplicationFactoryClientOptions{AllowAutoRedirect=false});
        browser.DefaultRequestHeaders.Add("Cookie",start.Headers["Set-Cookie"].Split(';')[0]);
        var code=provider=="google"?factory.GoogleCalendar.IssueCode(email,read?GoogleCalendarAuthService.InboxScope:GoogleCalendarAuthService.Scopes)
            :factory.MicrosoftProductivity.IssueCode(email,"User.Read Mail.Send"+(read?" Mail.Read":""));
        using var response=await browser.GetAsync($"/api/v1/integrations/{provider}/callback?state="+Query(start,"state")+"&code="+code);
        Assert.Equal(HttpStatusCode.Redirect,response.StatusCode);return response.Headers.Location!.ToString();
    }
    private async Task Connect(TestClient owner,string provider,string email="private@example.test",bool read=true){
        var start=await Start(owner,provider,read);Assert.True(start.Ok,start.ToString());
        Assert.EndsWith(provider+"=connected",await Complete(start,provider,email,read));
    }
    private static string List(string provider,string? cursor=null)=>"/api/v1/me/inbox?provider="+provider+(cursor==null?"":"&cursor="+Uri.EscapeDataString(cursor));
    private static string Thread(string provider,string? id=null)=>"/api/v1/me/inbox/thread?provider="+provider+"&messageId="+Uri.EscapeDataString(id??Message(provider));
    [Theory][InlineData("google")][InlineData("microsoft")]
    public async Task Inbox_is_disabled_by_default_and_requires_separate_read_consent(string provider){
        var owner=await TestClient.RegisterAsync(factory,"Inbox consent");await owner.CreateOrgAsync();Enable();
        try{
            await Connect(owner,provider,read:false);
            var start=await Start(owner,provider,false);Assert.True(start.Ok,start.ToString());
            Assert.DoesNotContain(provider=="google"?"gmail.readonly":"Mail.Read",Query(start,"scope"));
            Assert.Equal(provider=="google"?"GOOGLE_SCOPE_REQUIRED":"MICROSOFT_SCOPE_REQUIRED",(await owner.Get(List(provider))).ErrorCode);
            if(provider=="google")Google.InboxEnabled=false;else Microsoft.InboxEnabled=false;
            Assert.Equal("INBOX_DISABLED",(await owner.Get(List(provider))).ErrorCode);
            Assert.Equal("INBOX_DISABLED",(await Start(owner,provider)).ErrorCode);
            Assert.Empty(Mailbox(provider).Requests);
        }finally{Reset();}
    }
    [Theory][InlineData("google")][InlineData("microsoft")]
    public async Task Broader_provider_tokens_do_not_silently_enable_inbox_access_without_requested_consent(string provider){
        var owner=await TestClient.RegisterAsync(factory,"Unexpected inbox grant");await owner.CreateOrgAsync();Enable();
        try{
            var start=await Start(owner,provider,false);Assert.True(start.Ok,start.ToString());
            Assert.EndsWith(provider+"=connected",await Complete(start,provider,"private@example.test",true));
            var status=await owner.Get($"/api/v1/integrations/{provider}/status");Assert.False(status.Data!["inboxAccess"]!.GetValue<bool>());
            Assert.Equal(provider=="google"?"GOOGLE_SCOPE_REQUIRED":"MICROSOFT_SCOPE_REQUIRED",(await owner.Get(List(provider))).ErrorCode);
            Assert.Empty(Mailbox(provider).Requests);
        }finally{Reset();}
    }
    [Theory][InlineData("google")][InlineData("microsoft")]
    public async Task Incomplete_or_disabled_consent_cannot_replace_an_existing_connection(string provider){
        var owner=await TestClient.RegisterAsync(factory,"Inbox grant");await owner.CreateOrgAsync();Enable();
        try{
            await Connect(owner,provider,read:false);
            var start=await Start(owner,provider);Assert.Contains(provider=="google"?"gmail.readonly":"Mail.Read",Query(start,"scope"));
            var attempt=factory.WithDb(db=>db.ProviderOAuthAttempts.Single(a=>a.UserId==owner.UserId&&a.ConsumedAt==null&&a.RequestedScopes.Contains(provider=="google"?"gmail.readonly":"Mail.Read")));
            Assert.Equal(Query(start,"scope"),attempt.RequestedScopes);
            Assert.DoesNotContain("=connected",await Complete(start,provider,"replacement@example.test",false));
            var status=await owner.Get($"/api/v1/integrations/{provider}/status");Assert.False(status.Data!["inboxAccess"]!.GetValue<bool>());
            var enabled=await Start(owner,provider);if(provider=="google")Google.InboxEnabled=false;else Microsoft.InboxEnabled=false;
            Assert.DoesNotContain("=connected",await Complete(enabled,provider,"replacement@example.test"));
        }finally{Reset();}
    }
    [Theory][InlineData("google")][InlineData("microsoft")]
    public async Task Metadata_and_threads_are_private_to_the_requesting_person_and_workspace(string provider){
        var owner=await TestClient.RegisterAsync(factory,"Inbox owner");await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");var colleague=await owner.AddMemberAsync(factory,TenantRole.Member,"Unconnected inbox colleague");
        var other=await TestClient.RegisterAsync(factory,"Foreign inbox");await other.CreateOrgAsync();Enable();
        try{
            await Connect(owner,provider,"first@example.test");await Connect(other,provider,"second@example.test");
            foreach(var pair in new[]{(owner,"first@example.test"),(other,"second@example.test")}){
                var page=await pair.Item1.Get(List(provider));Assert.True(page.Ok,page.ToString());
                Assert.Equal(pair.Item2,page.Data!["account"]!.GetValue<string>());var metadata=page.Data["messages"]![0]!;
                Assert.Null(metadata["body"]);Assert.Equal(pair.Item2,metadata["sender"]!.GetValue<string>());
                Assert.Contains("no-store",page.Headers["Cache-Control"]);
                var thread=await pair.Item1.Get(Thread(provider));Assert.True(thread.Ok,thread.ToString());
                Assert.Equal("Private content for "+pair.Item2,thread.Data!["messages"]![0]!["body"]!.GetValue<string>());
                Assert.DoesNotContain("AccessToken",thread.ToString());
            }
            var stranger=await TestClient.RegisterAsync(factory,"Unconnected colleague");await stranger.CreateOrgAsync();
            Assert.False((await stranger.Get(List(provider))).Ok);
            Assert.False((await colleague.Get(List(provider)+"&userId="+owner.UserId)).Ok);
            Assert.All(Mailbox(provider).Requests,url=>Assert.DoesNotContain("/users/",url.Replace("/users/me/","/me/")));
        }finally{Reset();}
    }
    [Theory][InlineData("google")][InlineData("microsoft")]
    public async Task Continuations_are_encrypted_owner_bound_expiring_and_invalid_after_reconnect(string provider){
        var owner=await TestClient.RegisterAsync(factory,"Inbox cursor");await owner.CreateOrgAsync();
        var other=await TestClient.RegisterAsync(factory,"Inbox cursor foreign");await other.CreateOrgAsync();Enable();
        try{
            await Connect(owner,provider);await Connect(other,provider,"other@example.test");Mailbox(provider).Paged=true;
            var first=await owner.Get(List(provider));Assert.True(first.Ok,first.ToString());var cursor=first.Data!["cursor"]!.GetValue<string>();
            Assert.DoesNotContain("private-provider-page",cursor);Assert.DoesNotContain("graph.microsoft.com",cursor);
            Assert.True((await owner.Get(List(provider,cursor))).Ok);
            Assert.Equal(HttpStatusCode.UnprocessableEntity,(await other.Get(List(provider,cursor))).Status);
            Assert.Equal(HttpStatusCode.UnprocessableEntity,(await owner.Get(List(provider,"forged-cursor"))).Status);
            var protector=factory.Services.GetRequiredService<ISecretProtector>();
            var expired=JsonNode.Parse(protector.Unprotect(cursor))!;expired["ExpiresAt"]=DateTime.UtcNow.AddDays(-1);
            Assert.Equal(HttpStatusCode.UnprocessableEntity,(await owner.Get(List(provider,protector.Protect(expired.ToJsonString())))).Status);
            if(provider=="microsoft"){
                var reconnect=await Start(owner,provider,false);
                Assert.Contains("Mail.Read",Query(reconnect,"scope"));
            }
            await Connect(owner,provider);
            Assert.Equal(HttpStatusCode.UnprocessableEntity,(await owner.Get(List(provider,cursor))).Status);
        }finally{Reset();}
    }
    [Theory][InlineData("google")][InlineData("microsoft")]
    public async Task Disconnect_during_a_provider_read_prevents_returning_mail_content(string provider){
        var owner=await TestClient.RegisterAsync(factory,"Inbox disconnected");await owner.CreateOrgAsync();Enable();
        try{
            await Connect(owner,provider);
            Mailbox(provider).BeforeRead=()=>factory.WithDb(db=>{
                if(provider=="google")db.GoogleConnections.IgnoreQueryFilters().Where(c=>c.UserId==owner.UserId).ExecuteDelete();
                else db.MicrosoftConnections.IgnoreQueryFilters().Where(c=>c.UserId==owner.UserId).ExecuteDelete();return 0;
            });
            var result=await owner.Get(Thread(provider));Assert.Equal("INBOX_CONNECTION_CHANGED",result.ErrorCode);
            Assert.DoesNotContain("Private content",result.ToString());
        }finally{Reset();}
    }
    [Theory][InlineData("google")][InlineData("microsoft")]
    public async Task Revoked_membership_during_a_provider_read_prevents_returning_mail_content(string provider){
        var owner=await TestClient.RegisterAsync(factory,"Inbox revoked");await owner.CreateOrgAsync();Enable();
        try{
            await Connect(owner,provider);
            Mailbox(provider).BeforeRead=()=>factory.WithDb(db=>{db.TenantMembers.Where(m=>m.TenantId==owner.WorkspaceId&&m.UserId==owner.UserId).ExecuteDelete();return 0;});
            var result=await owner.Get(Thread(provider));Assert.Equal(HttpStatusCode.Forbidden,result.Status);
            Assert.DoesNotContain("Private content",result.ToString());
        }finally{Reset();}
    }
    [Theory][InlineData("google")][InlineData("microsoft")]
    public async Task Provider_HTML_is_never_sent_to_the_browser_and_oversized_responses_are_rejected(string provider){
        var owner=await TestClient.RegisterAsync(factory,"Inbox bounded");await owner.CreateOrgAsync();Enable();
        try{
            await Connect(owner,provider);Mailbox(provider).HtmlOnly=true;
            var thread=await owner.Get(Thread(provider));Assert.True(thread.Ok,thread.ToString());Assert.True(thread.Data!["truncated"]!.GetValue<bool>());
            Assert.DoesNotContain("<script>",thread.ToString());Mailbox(provider).Oversized=true;
            var result=await owner.Get(List(provider));Assert.Equal("INBOX_PROVIDER_ERROR",result.ErrorCode);Assert.DoesNotContain(new string('x',100),result.ToString());
        }finally{Reset();}
    }
    [Theory][InlineData("google")][InlineData("microsoft")]
    public async Task Invalid_message_references_do_not_issue_provider_requests(string provider){
        var owner=await TestClient.RegisterAsync(factory,"Inbox path");await owner.CreateOrgAsync();Enable();
        try{
            await Connect(owner,provider);Assert.Equal(HttpStatusCode.UnprocessableEntity,(await owner.Get(Thread(provider,"../other-mailbox?token=secret"))).Status);
            Assert.Equal(HttpStatusCode.UnprocessableEntity,(await owner.Get("/api/v1/me/inbox/thread?provider="+provider)).Status);
            Assert.Equal(HttpStatusCode.UnprocessableEntity,(await owner.Get("/api/v1/me/inbox/thread")).Status);
            Assert.Empty(Mailbox(provider).Requests);
        }finally{Reset();}
    }
    [Fact]
    public async Task Graph_continuation_cannot_change_host_mailbox_path_or_attach_credentials(){
        var owner=await TestClient.RegisterAsync(factory,"Inbox continuation");await owner.CreateOrgAsync();Enable();
        try{
            await Connect(owner,"microsoft");
            foreach(var next in new[]{"https://attacker.example.test/me/messages","https://graph.microsoft.com/v1.0/users/other/messages","https://user@graph.microsoft.com/v1.0/me/mailFolders/inbox/messages","https://graph.microsoft.com:444/v1.0/me/mailFolders/inbox/messages"}){
                factory.MicrosoftProductivity.Inbox.NextLink=next;
                Assert.Equal("INBOX_PROVIDER_ERROR",(await owner.Get(List("microsoft"))).ErrorCode);
            }
            Assert.Equal(4,factory.MicrosoftProductivity.Inbox.Requests.Count);
            Assert.All(factory.MicrosoftProductivity.Inbox.Requests,url=>Assert.StartsWith("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages",url));
        }finally{Reset();}
    }
    [Fact]
    public async Task Provider_thread_mismatch_is_rejected_instead_of_combining_unrelated_messages(){
        var owner=await TestClient.RegisterAsync(factory,"Inbox thread boundary");await owner.CreateOrgAsync();Enable();
        try{
            await Connect(owner,"microsoft");factory.MicrosoftProductivity.Inbox.WrongThread=true;
            Assert.Equal("INBOX_PROVIDER_ERROR",(await owner.Get(Thread("microsoft"))).ErrorCode);
        }finally{Reset();}
    }
}
