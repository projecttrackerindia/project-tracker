using System.Net;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Features.Integrations;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;
namespace ProjectManagement.Tests;
[Collection("api")]
public class PersonalEmailTests(ApiFactory factory)
{
    private GoogleCalendarOptions Options=>factory.Services.GetRequiredService<IOptions<GoogleCalendarOptions>>().Value;
    private async Task Connect(TestClient owner,bool mail=true){
        var start=await owner.Get("/api/v1/integrations/google/connect"+(mail?"?mail=true":""));
        Assert.True(start.Ok,start.ToString());
        var query=new Uri(start.Data!["url"]!.GetValue<string>()).Query.TrimStart('?').Split('&').Select(p=>p.Split('=',2)).ToDictionary(p=>p[0],p=>Uri.UnescapeDataString(p[1]));
        Assert.Equal(mail,query["scope"].Contains(GoogleCalendarAuthService.MailScope));Assert.DoesNotContain("gmail.readonly",query["scope"]);
        if(mail)Assert.DoesNotContain("calendar.events",query["scope"]);
        var code=factory.GoogleCalendar.IssueCode("sender@example.com",GoogleCalendarAuthService.Scopes+(mail?" "+GoogleCalendarAuthService.MailScope:""));
        using var browser=factory.CreateClient(new WebApplicationFactoryClientOptions{AllowAutoRedirect=false});
        browser.DefaultRequestHeaders.Add("Cookie",start.Headers["Set-Cookie"].Split(';')[0]);
        using var callback=await browser.GetAsync("/api/v1/integrations/google/callback?state="+query["state"]+"&code="+code);
        Assert.Equal(HttpStatusCode.Redirect,callback.StatusCode);
    }
    private static async Task<(Guid Id,int Version)> Draft(TestClient owner,string subject="Private subject",string provider="google"){
        var created=await owner.Post("/api/v1/me/email-drafts",new{recipient="recipient@example.com",subject,body="Private message.",provider});
        Assert.True(created.Ok,created.ToString());return(created.Data!["id"]!.GetValue<Guid>(),created.Data["version"]!.GetValue<int>());
    }
    [Fact]
    public async Task Drafts_are_private_and_reject_header_injection_and_stale_edits(){
        var owner=await TestClient.RegisterAsync(factory,"Private email");await owner.CreateOrgAsync();await owner.UpgradeAsync("BUSINESS");
        var member=await owner.AddMemberAsync(factory,TenantRole.Member,"Email peer");
        var stranger=await TestClient.RegisterAsync(factory,"Other workspace");await stranger.CreateOrgAsync();var draft=await Draft(owner);
        Assert.Equal("",(await owner.Get("/api/v1/me/email-drafts")).Data!.AsArray().Single()!["body"]!.GetValue<string>());
        Assert.Equal("Private message.",(await owner.Get($"/api/v1/me/email-drafts/{draft.Id}")).Data!["body"]!.GetValue<string>());
        foreach(var other in new[]{member,stranger}){
            Assert.Equal(HttpStatusCode.NotFound,(await other.Get($"/api/v1/me/email-drafts/{draft.Id}")).Status);
            Assert.Empty((await other.Get("/api/v1/me/email-drafts")).Data!.AsArray());
            Assert.Equal(HttpStatusCode.NotFound,(await other.Put($"/api/v1/me/email-drafts/{draft.Id}",new{recipient="a@example.com",subject="Change",body="Bad",version=draft.Version})).Status);
            Assert.Equal(HttpStatusCode.NotFound,(await other.Delete($"/api/v1/me/email-drafts/{draft.Id}")).Status);
            Assert.Equal(HttpStatusCode.NotFound,(await other.Post($"/api/v1/me/email-drafts/{draft.Id}/send",new{version=draft.Version,confirmed=true,senderEmail="sender@example.com"})).Status);
        }
        Assert.Equal(HttpStatusCode.UnprocessableEntity,(await owner.Post("/api/v1/me/email-drafts",new{recipient="a@example.com\r\nBcc: other@example.com",subject="test",body="text"})).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity,(await owner.Post("/api/v1/me/email-drafts",new{recipient="a@example.com",subject="Subject\r\nBcc: other@example.com",body="text"})).Status);
        Assert.Equal(HttpStatusCode.Conflict,(await owner.Put($"/api/v1/me/email-drafts/{draft.Id}",new{recipient="a@example.com",subject="test",body="text",version=99})).Status);
    }
    [Fact]
    public async Task Sending_requires_gate_scope_sender_and_confirmation(){
        var owner=await TestClient.RegisterAsync(factory,"Email safeguards");await owner.CreateOrgAsync();var draft=await Draft(owner);var route=$"/api/v1/me/email-drafts/{draft.Id}/send";
        var previous=Options.MailEnabled;Options.MailEnabled=false;
        try{
            Assert.Equal("GMAIL_DISABLED",(await owner.Get("/api/v1/integrations/google/connect?mail=true")).ErrorCode);
            Assert.Equal("GMAIL_DISABLED",(await owner.Post(route,new{version=draft.Version,confirmed=true,senderEmail="sender@example.com"})).ErrorCode);
            await Connect(owner,false);Options.MailEnabled=true;
            Assert.Equal("GOOGLE_SCOPE_REQUIRED",(await owner.Post(route,new{version=draft.Version,confirmed=true,senderEmail="sender@example.com"})).ErrorCode);
            await Connect(owner);
            Assert.Equal(HttpStatusCode.UnprocessableEntity,(await owner.Post(route,new{version=draft.Version,confirmed=false,senderEmail="sender@example.com"})).Status);
            Assert.Equal("EMAIL_SENDER_CHANGED",(await owner.Post(route,new{version=draft.Version,confirmed=true,senderEmail="other@example.com"})).ErrorCode);
            Assert.Equal(HttpStatusCode.Conflict,(await owner.Post(route,new{version=99,confirmed=true,senderEmail="sender@example.com"})).Status);
            Assert.Equal("draft",factory.WithDb(db=>db.PersonalEmailDrafts.IgnoreQueryFilters().Single(d=>d.Id==draft.Id).Status));
        }finally{Options.MailEnabled=previous;}
    }
    [Fact]
    public async Task Concurrent_confirmations_dispatch_once_with_durable_receipt_and_valid_unicode_mime(){
        var owner=await TestClient.RegisterAsync(factory,"Once email");await owner.CreateOrgAsync();var previous=Options.MailEnabled;Options.MailEnabled=true;
        try{
            await Connect(owner);var subject=new string('é',200);var draft=await Draft(owner,subject);var before=factory.GoogleCalendar.SentMail.Count;
            var route=$"/api/v1/me/email-drafts/{draft.Id}/send";var req=new{version=draft.Version,confirmed=true,senderEmail="sender@example.com"};
            var results=await Task.WhenAll(owner.Post(route,req),owner.Post(route,req));
            Assert.Contains(results,r=>r.Ok);Assert.All(results,r=>Assert.True(r.Ok||r.Status==HttpStatusCode.Conflict,r.ToString()));
            Assert.Equal(before+1,factory.GoogleCalendar.SentMail.Count);
            var replay=await owner.Post(route,req);Assert.True(replay.Ok,replay.ToString());Assert.Equal("accepted",replay.Data!["status"]!.GetValue<string>());
            Assert.StartsWith("mail_",replay.Data["providerMessageId"]!.GetValue<string>());Assert.Equal(before+1,factory.GoogleCalendar.SentMail.Count);
            var mime=factory.GoogleCalendar.SentMail.Single(m=>m.Contains("Subject: =?UTF-8?B?w6n"));
            Assert.Contains("From: sender@example.com\r\nTo: recipient@example.com\r\n",mime);
            var words=mime.Split("\r\n").Where(s=>s.StartsWith("Subject: ")||s.StartsWith(" =?UTF-8?B?")).Select(s=>s.StartsWith("Subject: ")?s[9..]:s.Trim()).ToArray();
            Assert.All(words,w=>Assert.True(w.Length<=75));
            Assert.Equal(subject,string.Concat(words.Select(w=>System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(w[10..^2])))));
            Assert.True((await owner.Delete($"/api/v1/me/email-drafts/{draft.Id}")).Ok);
            var saved=factory.WithDb(db=>db.PersonalEmailDrafts.IgnoreQueryFilters().Single(d=>d.Id==draft.Id));
            Assert.Equal("deleted",saved.Status);Assert.Equal("",saved.Body);Assert.NotNull(saved.ProviderMessageId);
            var audits=factory.WithDb(db=>db.AuditLogs.Where(a=>a.EntityId==draft.Id).Select(a=>a.NewValue??"").ToArray());
            Assert.All(audits,a=>{Assert.DoesNotContain("recipient@example.com",a);Assert.DoesNotContain("Private message.",a);Assert.DoesNotContain(subject,a);});
        }finally{Options.MailEnabled=previous;}
    }
    [Fact]
    public async Task Lost_response_blocks_retry_and_delete(){
        var owner=await TestClient.RegisterAsync(factory,"Unknown email");await owner.CreateOrgAsync();var previous=Options.MailEnabled;Options.MailEnabled=true;
        try{
            await Connect(owner);var draft=await Draft(owner);var before=factory.GoogleCalendar.SentMail.Count;factory.GoogleCalendar.MailOutcomeUnknown=true;
            var route=$"/api/v1/me/email-drafts/{draft.Id}/send";var req=new{version=draft.Version,confirmed=true,senderEmail="sender@example.com"};
            var outcome=await owner.Post(route,req);Assert.True(outcome.Ok,outcome.ToString());Assert.Equal("unknown",outcome.Data!["status"]!.GetValue<string>());
            Assert.Equal("EMAIL_OUTCOME_UNKNOWN",(await owner.Post(route,req)).ErrorCode);
            Assert.Equal(HttpStatusCode.Conflict,(await owner.Delete($"/api/v1/me/email-drafts/{draft.Id}")).Status);
            Assert.Equal(before+1,factory.GoogleCalendar.SentMail.Count);
        }finally{factory.GoogleCalendar.MailOutcomeUnknown=false;Options.MailEnabled=previous;}
    }
    [Fact]
    public async Task Removing_receipts_does_not_reset_the_hourly_cap(){
        var owner=await TestClient.RegisterAsync(factory,"Email cap");await owner.CreateOrgAsync();var previous=Options.MailEnabled;Options.MailEnabled=true;
        try{
            await Connect(owner);var draft=await Draft(owner);var before=factory.GoogleCalendar.SentMail.Count;
            factory.WithDb(db=>{
                for(var i=0;i<10;i++)db.PersonalEmailDrafts.Add(new(){TenantId=owner.WorkspaceId,UserId=owner.UserId,Status="deleted",ConfirmedAt=DateTime.UtcNow});
                db.SaveChanges();return 0;
            });
            var denied=await owner.Post($"/api/v1/me/email-drafts/{draft.Id}/send",new{version=draft.Version,confirmed=true,senderEmail="sender@example.com"});
            Assert.Equal(HttpStatusCode.Conflict,denied.Status);Assert.Equal(before,factory.GoogleCalendar.SentMail.Count);
            Assert.Equal("draft",factory.WithDb(db=>db.PersonalEmailDrafts.IgnoreQueryFilters().Single(d=>d.Id==draft.Id).Status));
        }finally{Options.MailEnabled=previous;}
    }    [Fact]
    public async Task Mail_reconnection_cannot_reuse_a_stale_sender_identity(){
        var owner=await TestClient.RegisterAsync(factory,"Email identity");await owner.CreateOrgAsync();var previous=Options.MailEnabled;Options.MailEnabled=true;
        try{
            await Connect(owner,false);var existing=factory.WithDb(db=>db.GoogleConnections.IgnoreQueryFilters().Single(g=>g.UserId==owner.UserId));
            var start=await owner.Get("/api/v1/integrations/google/connect?mail=true");
            var query=new Uri(start.Data!["url"]!.GetValue<string>()).Query.TrimStart('?').Split('&').Select(p=>p.Split('=',2)).ToDictionary(p=>p[0],p=>Uri.UnescapeDataString(p[1]));
            using var browser=factory.CreateClient(new WebApplicationFactoryClientOptions{AllowAutoRedirect=false});
            browser.DefaultRequestHeaders.Add("Cookie",start.Headers["Set-Cookie"].Split(';')[0]);
            var code=factory.GoogleCalendar.IssueCode("different@example.com",GoogleCalendarAuthService.Scopes+" "+GoogleCalendarAuthService.MailScope);
            factory.GoogleCalendar.UserInfoFails=true;
            using var callback=await browser.GetAsync("/api/v1/integrations/google/callback?state="+query["state"]+"&code="+code);
            Assert.EndsWith("google=error",callback.Headers.Location!.ToString());
            var current=factory.WithDb(db=>db.GoogleConnections.IgnoreQueryFilters().Single(g=>g.UserId==owner.UserId));
            Assert.Equal(existing.GoogleEmail,current.GoogleEmail);Assert.Equal(existing.AccessTokenProtected,current.AccessTokenProtected);
            Assert.DoesNotContain(GoogleCalendarAuthService.MailScope,current.Scopes);
            factory.GoogleCalendar.UserInfoFails=false;factory.GoogleCalendar.OmitRefreshToken=true;
            var next=await owner.Get("/api/v1/integrations/google/connect?mail=true");
            var nextState=new Uri(next.Data!["url"]!.GetValue<string>()).Query.TrimStart('?').Split('&').Select(p=>p.Split('=',2)).Single(p=>p[0]=="state")[1];
            using var second=factory.CreateClient(new WebApplicationFactoryClientOptions{AllowAutoRedirect=false});
            second.DefaultRequestHeaders.Add("Cookie",next.Headers["Set-Cookie"].Split(';')[0]);
            var nextCode=factory.GoogleCalendar.IssueCode("different@example.com",GoogleCalendarAuthService.Scopes+" "+GoogleCalendarAuthService.MailScope);
            using var missingRefresh=await second.GetAsync("/api/v1/integrations/google/callback?state="+nextState+"&code="+nextCode);
            Assert.EndsWith("google=error",missingRefresh.Headers.Location!.ToString());
            var unchanged=factory.WithDb(db=>db.GoogleConnections.IgnoreQueryFilters().Single(g=>g.UserId==owner.UserId));
            Assert.Equal(existing.RefreshTokenProtected,unchanged.RefreshTokenProtected);Assert.Equal(existing.GoogleEmail,unchanged.GoogleEmail);
        }finally{factory.GoogleCalendar.UserInfoFails=false;factory.GoogleCalendar.OmitRefreshToken=false;Options.MailEnabled=previous;}
    }    [Theory]
    [InlineData("google")]
    [InlineData("microsoft")]
    public async Task AI_rewriting_uses_shared_credits_and_never_sends_or_changes_the_recipient(string provider){
        var owner=await TestClient.RegisterAsync(factory,"AI email");await owner.CreateOrgAsync();await owner.UpgradeAsync("BUSINESS");var draft=await Draft(owner,provider:provider);
        factory.Ai.Configured=true;
        try{
            var opts=await owner.Get("/api/v1/me/email-drafts/options");Assert.True(opts.Data!["available"]!.GetValue<bool>());
            var microsoftCalls=factory.MicrosoftProductivity.SentMessages.Count;var cost=opts.Data["credits"]!.GetValue<int>();var operation=Guid.NewGuid();var calls=factory.GoogleCalendar.SentMail.Count;
            factory.Ai.Answer=(_,_)=>"""{"subject":"Clear subject","body":"Clear private message."}""";
            var route=$"/api/v1/me/email-drafts/{draft.Id}/improve";
            Assert.Equal(HttpStatusCode.UnprocessableEntity,(await owner.Post(route,new{operationId=operation,version=draft.Version,style="formal",confirmed=false})).Status);
            Assert.Empty(factory.Ai.Prompts);
            var result=await owner.Post(route,new{operationId=operation,version=draft.Version,style="formal",confirmed=true});
            Assert.True(result.Ok,result.ToString());Assert.Equal("draft",result.Data!["status"]!.GetValue<string>());
            Assert.Equal("recipient@example.com",result.Data["recipient"]!.GetValue<string>());Assert.Null(result.Data["providerMessageId"]);
            Assert.Equal(calls,factory.GoogleCalendar.SentMail.Count);Assert.Equal(microsoftCalls,factory.MicrosoftProductivity.SentMessages.Count);Assert.Equal(provider,result.Data["provider"]!.GetValue<string>());
            var version=result.Data["version"]!.GetValue<int>();
            var replay=await owner.Post(route,new{operationId=operation,version,style="formal",confirmed=true});
            Assert.Equal("AI_OPERATION_ALREADY_ADMITTED",replay.ErrorCode);Assert.Single(factory.Ai.Prompts);
            var account=factory.WithDb(db=>db.AiCreditAccounts.IgnoreQueryFilters().Single(a=>a.TenantId==owner.WorkspaceId));
            Assert.Equal(cost,account.Spent);Assert.Equal(0,account.Reserved);
        }finally{factory.Ai.Reset();}
    }
    [Fact]
    public async Task Invalid_AI_suggestions_release_credits_and_preserve_the_saved_draft(){
        var owner=await TestClient.RegisterAsync(factory,"Invalid AI email");await owner.CreateOrgAsync();await owner.UpgradeAsync("BUSINESS");var draft=await Draft(owner);
        factory.Ai.Configured=true;
        try{
            factory.Ai.Answer=(_,_)=>"""{"subject":"Invented results","body":"Earned 999 rupees."}""";
            var result=await owner.Post($"/api/v1/me/email-drafts/{draft.Id}/improve",new{operationId=Guid.NewGuid(),version=draft.Version,style="concise",confirmed=true});
            Assert.Equal("AI_EMAIL_INVALID",result.ErrorCode);
            var row=factory.WithDb(db=>db.PersonalEmailDrafts.IgnoreQueryFilters().Single(d=>d.Id==draft.Id));Assert.Equal(draft.Version,row.Version);Assert.Equal("Private message.",row.Body);
            var account=factory.WithDb(db=>db.AiCreditAccounts.IgnoreQueryFilters().Single(a=>a.TenantId==owner.WorkspaceId));
            Assert.Equal(0,account.Spent);Assert.Equal(0,account.Reserved);
        }finally{factory.Ai.Reset();}
    }}
