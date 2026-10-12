using System.Net;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Features.Integrations;
using ProjectManagement.Tests.Infrastructure;
namespace ProjectManagement.Tests;
[Collection("api")]
public class PersonalEmailAuthorizationTests(ApiFactory factory)
{
    private GoogleCalendarOptions Google=>factory.Services.GetRequiredService<IOptions<GoogleCalendarOptions>>().Value;
    private MicrosoftProductivityOptions Microsoft=>factory.Services.GetRequiredService<IOptions<MicrosoftProductivityOptions>>().Value;
    private async Task Connect(TestClient owner,string provider){
        var route="/api/v1/integrations/"+provider;var start=await owner.Get(route+"/connect"+(provider=="google"?"?mail=true":""));Assert.True(start.Ok,start.ToString());
        var state=new Uri(start.Data!["url"]!.GetValue<string>()).Query.TrimStart('?').Split('&').Select(p=>p.Split('=',2)).Single(p=>p[0]=="state")[1];
        using var browser=factory.CreateClient(new WebApplicationFactoryClientOptions{AllowAutoRedirect=false});browser.DefaultRequestHeaders.Add("Cookie",start.Headers["Set-Cookie"].Split(';')[0]);
        var code=provider=="google"?factory.GoogleCalendar.IssueCode(owner.Email,GoogleCalendarAuthService.MailScope+" https://www.googleapis.com/auth/userinfo.email"):factory.MicrosoftProductivity.IssueCode(owner.Email);
        using var result=await browser.GetAsync(route+"/callback?state="+state+"&code="+code);Assert.EndsWith(provider+"=connected",result.Headers.Location!.ToString());
    }
    private void Enable(){Google.MailEnabled=true;Microsoft.Enabled=true;Microsoft.ClientId="12345678-1234-1234-1234-123456789012";Microsoft.ClientSecret="fake-secret";Microsoft.RedirectUri="https://testhost/api/v1/integrations/microsoft/callback";Microsoft.AuthorityTenant="organizations";}
    private void Reset(){Google.MailEnabled=false;Microsoft.Enabled=false;Microsoft.ClientId=null;Microsoft.ClientSecret=null;Microsoft.RedirectUri=null;factory.GoogleCalendar.BeforeRefresh=null;factory.GoogleCalendar.BeforeMailSendResponse=null;factory.MicrosoftProductivity.Reset();factory.Ai.Reset();}
    private static async Task<(Guid Id,int Version)> Draft(TestClient owner,string provider){
        var result=await owner.Post("/api/v1/me/email-drafts",new{recipient="recipient@example.com",subject="Private review",body="Reviewed private text.",provider});Assert.True(result.Ok,result.ToString());
        return(result.Data!["id"]!.GetValue<Guid>(),result.Data["version"]!.GetValue<int>());
    }
    private int Sends(string provider)=>provider=="google"?factory.GoogleCalendar.SentMail.Count:factory.MicrosoftProductivity.SentMessages.Count;
    private void Change(TestClient owner,string provider,string change)=>factory.WithDb(db=>{
        if(provider=="google"){
            var row=db.GoogleConnections.IgnoreQueryFilters().Single(c=>c.UserId==owner.UserId);
            if(change=="epoch")row.ConsentEpoch=Guid.NewGuid();if(change=="scope")row.Scopes="openid email";if(change=="account")row.GoogleEmail="replacement@example.com";
        }else{
            var row=db.MicrosoftConnections.IgnoreQueryFilters().Single(c=>c.UserId==owner.UserId);
            if(change=="epoch")row.ConsentEpoch=Guid.NewGuid();if(change=="scope")row.Scopes="User.Read";if(change=="account")row.Email="replacement@example.com";
        }
        db.SaveChanges();return 0;
    });
    [Theory]
    [InlineData("google","epoch")] [InlineData("google","scope")] [InlineData("google","account")]
    [InlineData("microsoft","epoch")] [InlineData("microsoft","scope")] [InlineData("microsoft","account")]
    public async Task Refresh_cannot_restore_revoked_scopes_or_overwrite_changed_consent_and_sender(string provider,string change){
        Enable();var owner=await TestClient.RegisterAsync(factory);await owner.CreateOrgAsync();
        try{
            await Connect(owner,provider);var draft=await Draft(owner,provider);var before=Sends(provider);
            factory.WithDb(db=>{if(provider=="google")db.GoogleConnections.IgnoreQueryFilters().Single(c=>c.UserId==owner.UserId).AccessTokenExpiresAt=DateTime.UtcNow.AddDays(-1);else db.MicrosoftConnections.IgnoreQueryFilters().Single(c=>c.UserId==owner.UserId).AccessTokenExpiresAt=DateTime.UtcNow.AddDays(-1);db.SaveChanges();return 0;});
            if(provider=="google")factory.GoogleCalendar.BeforeRefresh=()=>Change(owner,provider,change);else factory.MicrosoftProductivity.BeforeRefresh=()=>Change(owner,provider,change);
            var result=await owner.Post($"/api/v1/me/email-drafts/{draft.Id}/send",new{version=draft.Version,confirmed=true,senderEmail=owner.Email});
            Assert.Equal(provider=="google"?"GOOGLE_CONNECTION_CHANGED":"MICROSOFT_CONNECTION_CHANGED",result.ErrorCode);Assert.Equal(before,Sends(provider));
            Assert.Equal("draft",factory.WithDb(db=>db.PersonalEmailDrafts.IgnoreQueryFilters().Single(d=>d.Id==draft.Id).Status));
            if(change=="scope")Assert.DoesNotContain(provider=="google"?GoogleCalendarAuthService.MailScope:"Mail.Send",factory.WithDb(db=>provider=="google"?db.GoogleConnections.IgnoreQueryFilters().Single(c=>c.UserId==owner.UserId).Scopes:db.MicrosoftConnections.IgnoreQueryFilters().Single(c=>c.UserId==owner.UserId).Scopes));
        }finally{Reset();}
    }
    [Theory]
    [InlineData("google","epoch")] [InlineData("google","scope")] [InlineData("google","disabled")]
    [InlineData("microsoft","epoch")] [InlineData("microsoft","scope")] [InlineData("microsoft","disabled")]
    public async Task Access_changes_after_dispatch_keep_unknown_evidence_and_never_resend(string provider,string change){
        Enable();var owner=await TestClient.RegisterAsync(factory);await owner.CreateOrgAsync();
        try{
            await Connect(owner,provider);var draft=await Draft(owner,provider);var before=Sends(provider);
            void Changed(){if(change=="disabled"){if(provider=="google")Google.MailEnabled=false;else Microsoft.Enabled=false;}else Change(owner,provider,change);}
            if(provider=="google")factory.GoogleCalendar.BeforeMailSendResponse=Changed;else factory.MicrosoftProductivity.BeforeMailSendResponse=Changed;
            var route=$"/api/v1/me/email-drafts/{draft.Id}/send";var req=new{version=draft.Version,confirmed=true,senderEmail=owner.Email};
            var result=await owner.Post(route,req);Assert.True(result.Ok,result.ToString());Assert.Equal("unknown",result.Data!["status"]!.GetValue<string>());Assert.Null(result.Data["acceptedAt"]);Assert.Null(result.Data["providerMessageId"]);
            Enable();var replay=await owner.Post(route,req);Assert.Equal("EMAIL_OUTCOME_UNKNOWN",replay.ErrorCode);Assert.Equal(before+1,Sends(provider));
        }finally{Reset();}
    }
    [Theory] [InlineData("google")] [InlineData("microsoft")]
    public async Task Revoked_members_receive_no_private_content_after_dispatch_and_restoring_access_does_not_resend(string provider){
        Enable();var owner=await TestClient.RegisterAsync(factory);await owner.CreateOrgAsync();
        try{
            await Connect(owner,provider);var draft=await Draft(owner,provider);var before=Sends(provider);
            var member=factory.WithDb(db=>db.TenantMembers.AsNoTracking().Single(m=>m.UserId==owner.UserId&&m.TenantId==owner.WorkspaceId));
            void Revoke()=>factory.WithDb(db=>{db.TenantMembers.Remove(db.TenantMembers.Single(m=>m.Id==member.Id));db.SaveChanges();return 0;});
            if(provider=="google")factory.GoogleCalendar.BeforeMailSendResponse=Revoke;else factory.MicrosoftProductivity.BeforeMailSendResponse=Revoke;
            var route=$"/api/v1/me/email-drafts/{draft.Id}/send";var req=new{version=draft.Version,confirmed=true,senderEmail=owner.Email};
            var result=await owner.Post(route,req);Assert.Equal(HttpStatusCode.Forbidden,result.Status);Assert.Null(result.Data);
            Assert.Equal("unknown",factory.WithDb(db=>db.PersonalEmailDrafts.IgnoreQueryFilters().Single(d=>d.Id==draft.Id).Status));
            factory.WithDb(db=>{db.TenantMembers.Add(member);db.SaveChanges();return 0;});
            Assert.Equal("EMAIL_OUTCOME_UNKNOWN",(await owner.Post(route,req)).ErrorCode);Assert.Equal(before+1,Sends(provider));
        }finally{Reset();}
    }
    [Fact]
    public async Task Revocation_during_ai_rewriting_refunds_the_reservation_without_changing_or_sharing_the_draft(){
        Enable();var owner=await TestClient.RegisterAsync(factory);await owner.CreateOrgAsync();await owner.UpgradeAsync("BUSINESS");
        try{
            var draft=await Draft(owner,"google");var before=Sends("google");factory.Ai.Configured=true;
            factory.Ai.Answer=(_,_)=>{factory.WithDb(db=>{db.TenantMembers.Remove(db.TenantMembers.Single(m=>m.UserId==owner.UserId&&m.TenantId==owner.WorkspaceId));db.SaveChanges();return 0;});return "{\"subject\":\"Clear subject\",\"body\":\"Clear private message.\"}";};
            var result=await owner.Post($"/api/v1/me/email-drafts/{draft.Id}/improve",new{operationId=Guid.NewGuid(),version=draft.Version,style="formal",confirmed=true});Assert.Equal(HttpStatusCode.Forbidden,result.Status);
            var row=factory.WithDb(db=>db.PersonalEmailDrafts.IgnoreQueryFilters().Single(d=>d.Id==draft.Id));Assert.Equal("Reviewed private text.",row.Body);Assert.Equal(draft.Version,row.Version);Assert.Equal(before,Sends("google"));
            var credits=factory.WithDb(db=>db.AiCreditAccounts.IgnoreQueryFilters().Single(a=>a.TenantId==owner.WorkspaceId));Assert.Equal(0,credits.Spent);Assert.Equal(0,credits.Reserved);
        }finally{Reset();}
    }
}
