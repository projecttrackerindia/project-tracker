using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Features.Integrations;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;
namespace ProjectManagement.Tests;
[Collection("api")]
public class MicrosoftProductivityTests(ApiFactory factory)
{
    private MicrosoftProductivityOptions Options=>factory.Services.GetRequiredService<IOptions<MicrosoftProductivityOptions>>().Value;
    private void Enable(){
        Options.Enabled=true;Options.ClientId="12345678-1234-1234-1234-123456789012";Options.ClientSecret="fake-secret";
        Options.RedirectUri="https://testhost/api/v1/integrations/microsoft/callback";Options.AuthorityTenant="organizations";
    }
    private void Reset(){Options.Enabled=false;Options.ClientId=null;Options.ClientSecret=null;Options.RedirectUri=null;factory.MicrosoftProductivity.Reset();}
    private static Dictionary<string,string> Query(ApiResult start)=>new Uri(start.Data!["url"]!.GetValue<string>()).Query.TrimStart('?').Split('&').Select(p=>p.Split('=',2)).ToDictionary(p=>p[0],p=>Uri.UnescapeDataString(p[1]));
    private HttpClient Browser(ApiResult? start=null){
        var browser=factory.CreateClient(new WebApplicationFactoryClientOptions{AllowAutoRedirect=false});
        if(start!=null)browser.DefaultRequestHeaders.Add("Cookie",start.Headers["Set-Cookie"].Split(';')[0]);return browser;
    }
    private async Task<ApiResult> Start(TestClient owner){var start=await owner.Get("/api/v1/integrations/microsoft/connect");Assert.True(start.Ok,start.ToString());return start;}
    private async Task Connect(TestClient owner,string email="outlook@example.com"){
        var start=await Start(owner);using var browser=Browser(start);
        using var result=await browser.GetAsync("/api/v1/integrations/microsoft/callback?state="+Query(start)["state"]+"&code="+factory.MicrosoftProductivity.IssueCode(email));
        Assert.EndsWith("microsoft=connected",result.Headers.Location!.ToString());
    }
    private static async Task<(Guid Id,int Version)> Draft(TestClient user,string provider="microsoft"){
        var saved=await user.Post("/api/v1/me/email-drafts",new{recipient="recipient@example.com",subject="Outlook draft",body="Reviewed message.",provider});
        Assert.True(saved.Ok,saved.ToString());return(saved.Data!["id"]!.GetValue<Guid>(),saved.Data["version"]!.GetValue<int>());
    }
    [Fact]
    public async Task Microsoft_is_disabled_without_setup_but_manual_drafts_still_work(){
        var owner=await TestClient.RegisterAsync(factory,"Microsoft disabled");await owner.CreateOrgAsync();Reset();
        var status=await owner.Get("/api/v1/integrations/microsoft/status");Assert.False(status.Data!["enabled"]!.GetValue<bool>());
        Assert.Equal("MICROSOFT_DISABLED",(await owner.Get("/api/v1/integrations/microsoft/connect")).ErrorCode);
        var draft=await Draft(owner);
        Assert.Equal("MICROSOFT_DISABLED",(await owner.Post($"/api/v1/me/email-drafts/{draft.Id}/send",new{version=draft.Version,confirmed=true,senderEmail="outlook@example.com"})).ErrorCode);
    }
    [Fact]
    public async Task OAuth_is_browser_bound_single_use_PKCE_and_reconnects_without_duplicate_credentials(){
        var owner=await TestClient.RegisterAsync(factory,"Microsoft OAuth");await owner.CreateOrgAsync();Enable();
        try{
            var start=await Start(owner);var query=Query(start);
            Assert.Equal("S256",query["code_challenge_method"]);Assert.DoesNotContain("Mail.Read",query["scope"]);Assert.DoesNotContain("Calendars",query["scope"]);
            Assert.Contains("httponly",start.Headers["Set-Cookie"].ToLowerInvariant());
            var attempt=factory.WithDb(db=>db.ProviderOAuthAttempts.Single(a=>a.Provider=="microsoft"&&a.UserId==owner.UserId));
            Assert.NotEqual(query["state"],attempt.StateHash);Assert.NotNull(attempt.VerifierProtected);Assert.NotEqual(64,attempt.VerifierProtected!.Length);
            var code=factory.MicrosoftProductivity.IssueCode();var url="/api/v1/integrations/microsoft/callback?state="+query["state"]+"&code="+code;
            using var missing=Browser();Assert.Equal(HttpStatusCode.Unauthorized,(await missing.GetAsync(url)).StatusCode);
            using var browser=Browser(start);var results=await Task.WhenAll(browser.GetAsync(url),browser.GetAsync(url));
            Assert.Single(results,r=>r.StatusCode==HttpStatusCode.Redirect);Assert.Single(results,r=>r.StatusCode==HttpStatusCode.Unauthorized);foreach(var r in results)r.Dispose();
            Assert.Contains(factory.MicrosoftProductivity.CodeVerifiers,v=>Convert.ToBase64String(System.Security.Cryptography.SHA256.HashData(Encoding.ASCII.GetBytes(v))).TrimEnd('=').Replace('+','-').Replace('/','_')==query["code_challenge"]);
            var original=factory.WithDb(db=>db.MicrosoftConnections.IgnoreQueryFilters().Single(c=>c.UserId==owner.UserId));
            Assert.DoesNotContain("ms_rt_",original.RefreshTokenProtected);Assert.DoesNotContain("ms_at_",original.AccessTokenProtected);
            await Connect(owner,"changed@example.com");
            var current=factory.WithDb(db=>db.MicrosoftConnections.IgnoreQueryFilters().Where(c=>c.UserId==owner.UserId).ToArray());
            Assert.Single(current);Assert.Equal(original.Id,current[0].Id);Assert.Equal("changed@example.com",current[0].Email);
        }finally{Reset();}
    }
    [Fact]
    public async Task Partial_grants_invalid_profiles_and_missing_refresh_do_not_replace_a_valid_connection(){
        var owner=await TestClient.RegisterAsync(factory,"Microsoft grant");await owner.CreateOrgAsync();Enable();
        try{
            await Connect(owner);var original=factory.WithDb(db=>db.MicrosoftConnections.IgnoreQueryFilters().Single(c=>c.UserId==owner.UserId));
            foreach(var mode in new[]{"scope","profile","refresh"}){
                factory.MicrosoftProductivity.Reset();factory.MicrosoftProductivity.MissingScope=mode=="scope";factory.MicrosoftProductivity.InvalidProfile=mode=="profile";factory.MicrosoftProductivity.MissingRefresh=mode=="refresh";
                var start=await Start(owner);using var browser=Browser(start);
                using var result=await browser.GetAsync("/api/v1/integrations/microsoft/callback?state="+Query(start)["state"]+"&code="+factory.MicrosoftProductivity.IssueCode("new@example.com"));
                Assert.DoesNotContain("microsoft=connected",result.Headers.Location!.ToString());
                var current=factory.WithDb(db=>db.MicrosoftConnections.IgnoreQueryFilters().Single(c=>c.UserId==owner.UserId));
                Assert.Equal(original.RefreshTokenProtected,current.RefreshTokenProtected);Assert.Equal(original.Email,current.Email);
            }
        }finally{Reset();}
    }
    [Fact]
    public async Task Callback_rechecks_membership_and_organization_connections_are_isolated(){
        var owner=await TestClient.RegisterAsync(factory,"Microsoft tenant");await owner.CreateOrgAsync();await owner.UpgradeAsync("BUSINESS");
        var member=await owner.AddMemberAsync(factory,TenantRole.Member,"Removed Outlook member");
        var other=await TestClient.RegisterAsync(factory,"Microsoft foreign");await other.CreateOrgAsync();Enable();
        try{
            var start=await Start(member);
            factory.WithDb(db=>{db.TenantMembers.Remove(db.TenantMembers.Single(m=>m.TenantId==owner.WorkspaceId&&m.UserId==member.UserId));db.SaveChanges();return 0;});
            using var browser=Browser(start);Assert.Equal(HttpStatusCode.Forbidden,(await browser.GetAsync("/api/v1/integrations/microsoft/callback?state="+Query(start)["state"]+"&code="+factory.MicrosoftProductivity.IssueCode())).StatusCode);
            await Connect(owner);Assert.False((await other.Get("/api/v1/integrations/microsoft/status")).Data!["connected"]!.GetValue<bool>());
            await Connect(other,"foreign@example.com");
            Assert.Equal("outlook@example.com",(await owner.Get("/api/v1/integrations/microsoft/status")).Data!["email"]!.GetValue<string>());
            Assert.Equal("foreign@example.com",(await other.Get("/api/v1/integrations/microsoft/status")).Data!["email"]!.GetValue<string>());
            Assert.True((await owner.Post("/api/v1/integrations/microsoft/disconnect")).Ok);
            Assert.True((await other.Get("/api/v1/integrations/microsoft/status")).Data!["connected"]!.GetValue<bool>());
        }finally{Reset();}
    }
    [Fact]
    public async Task Confirmed_Outlook_send_acceptance_is_durable_does_not_invent_a_message_id_and_dispatches_once(){
        var owner=await TestClient.RegisterAsync(factory,"Microsoft send");await owner.CreateOrgAsync();Enable();
        try{
            await Connect(owner);var draft=await Draft(owner);var before=factory.MicrosoftProductivity.SentMessages.Count;
            var route=$"/api/v1/me/email-drafts/{draft.Id}/send";var req=new{version=draft.Version,confirmed=true,senderEmail="outlook@example.com"};
            Assert.Equal("EMAIL_SENDER_CHANGED",(await owner.Post(route,new{version=draft.Version,confirmed=true,senderEmail="old@example.com"})).ErrorCode);
            var results=await Task.WhenAll(owner.Post(route,req),owner.Post(route,req));Assert.Contains(results,r=>r.Ok);
            Assert.All(results,r=>Assert.True(r.Ok||r.Status==HttpStatusCode.Conflict,r.ToString()));Assert.Equal(before+1,factory.MicrosoftProductivity.SentMessages.Count);
            var replay=await owner.Post(route,req);Assert.True(replay.Ok,replay.ToString());Assert.Equal("accepted",replay.Data!["status"]!.GetValue<string>());
            Assert.Equal("outlook@example.com",replay.Data["confirmedSenderEmail"]!.GetValue<string>());
            await Connect(owner,"new-sender@example.com");
            Assert.Equal("outlook@example.com",(await owner.Get($"/api/v1/me/email-drafts/{draft.Id}")).Data!["confirmedSenderEmail"]!.GetValue<string>());
            Assert.Null(replay.Data["providerMessageId"]);Assert.NotNull(replay.Data["providerRequestId"]);
            Assert.Equal("microsoft",replay.Data["provider"]!.GetValue<string>());Assert.Equal(before+1,factory.MicrosoftProductivity.SentMessages.Count);
            using var sent=JsonDocument.Parse(factory.MicrosoftProductivity.SentMessages.Last());
            Assert.True(sent.RootElement.GetProperty("saveToSentItems").GetBoolean());
            Assert.Equal("Text",sent.RootElement.GetProperty("message").GetProperty("body").GetProperty("contentType").GetString());
        }finally{Reset();}
    }
    [Fact]
    public async Task Lost_Outlook_response_blocks_resend_and_expired_tokens_refresh_before_confirmation(){
        var owner=await TestClient.RegisterAsync(factory,"Microsoft recovery");await owner.CreateOrgAsync();Enable();
        try{
            await Connect(owner);var old=factory.WithDb(db=>{var c=db.MicrosoftConnections.IgnoreQueryFilters().Single(c=>c.UserId==owner.UserId);c.AccessTokenExpiresAt=DateTime.UtcNow.AddDays(-1);db.SaveChanges();return c.RefreshTokenProtected;});
            var draft=await Draft(owner);factory.MicrosoftProductivity.ResponseLost=true;var before=factory.MicrosoftProductivity.SentMessages.Count;
            var route=$"/api/v1/me/email-drafts/{draft.Id}/send";var req=new{version=draft.Version,confirmed=true,senderEmail="outlook@example.com"};
            var result=await owner.Post(route,req);Assert.True(result.Ok,result.ToString());Assert.Equal("unknown",result.Data!["status"]!.GetValue<string>());
            Assert.NotEqual(old,factory.WithDb(db=>db.MicrosoftConnections.IgnoreQueryFilters().Single(c=>c.UserId==owner.UserId).RefreshTokenProtected));
            Assert.Equal("EMAIL_OUTCOME_UNKNOWN",(await owner.Post(route,req)).ErrorCode);Assert.Equal(before+1,factory.MicrosoftProductivity.SentMessages.Count);
        }finally{Reset();}
    }
    [Fact]
    public async Task Membership_revocation_during_refresh_prevents_dispatch(){
        var owner=await TestClient.RegisterAsync(factory,"Revoked email");await owner.CreateOrgAsync();Enable();
        try{
            await Connect(owner);var draft=await Draft(owner);var before=factory.MicrosoftProductivity.SentMessages.Count;
            factory.WithDb(db=>{db.MicrosoftConnections.IgnoreQueryFilters().Single(c=>c.UserId==owner.UserId).AccessTokenExpiresAt=DateTime.UtcNow.AddDays(-1);db.SaveChanges();return 0;});
            factory.MicrosoftProductivity.BeforeRefresh=()=>factory.WithDb(db=>{db.TenantMembers.Remove(db.TenantMembers.Single(m=>m.TenantId==owner.WorkspaceId&&m.UserId==owner.UserId));db.SaveChanges();return 0;});
            var result=await owner.Post($"/api/v1/me/email-drafts/{draft.Id}/send",new{version=draft.Version,confirmed=true,senderEmail="outlook@example.com"});
            Assert.Equal(HttpStatusCode.Forbidden,result.Status);Assert.Equal(before,factory.MicrosoftProductivity.SentMessages.Count);
            Assert.Equal("draft",factory.WithDb(db=>db.PersonalEmailDrafts.IgnoreQueryFilters().Single(d=>d.Id==draft.Id).Status));
        }finally{Reset();}
    }}
