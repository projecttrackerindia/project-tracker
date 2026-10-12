using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Application.Features.Billing;
using ProjectManagement.Application.Features.Integrations;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;
namespace ProjectManagement.Tests;

[Collection("api")]
public class PersonalInboxSummaryTests(ApiFactory factory)
{
    private const string Route="/api/v1/me/inbox/summaries";
    private GoogleCalendarOptions Google=>factory.Services.GetRequiredService<IOptions<GoogleCalendarOptions>>().Value;
    private MicrosoftProductivityOptions Microsoft=>factory.Services.GetRequiredService<IOptions<MicrosoftProductivityOptions>>().Value;
    private PersonalInboxSummaryOptions Options=>factory.Services.GetRequiredService<IOptions<PersonalInboxSummaryOptions>>().Value;
    private FakeInboxMailbox Mailbox(string provider)=>provider=="google"?factory.GoogleCalendar.Inbox:factory.MicrosoftProductivity.Inbox;
    private static string Id(string provider)=>provider=="google"?"1001":"message1";
    private async Task Connect(TestClient owner,string provider){
        var start=await owner.Get($"/api/v1/integrations/{provider}/connect?inbox=true");Assert.True(start.Ok,start.ToString());
        var state=new Uri(start.Data!["url"]!.GetValue<string>()).Query.TrimStart('?').Split('&').Select(p=>p.Split('=',2)).Single(p=>p[0]=="state")[1];
        using var browser=factory.CreateClient(new WebApplicationFactoryClientOptions{AllowAutoRedirect=false});
        browser.DefaultRequestHeaders.Add("Cookie",start.Headers["Set-Cookie"].Split(';')[0]);
        var code=provider=="google"?factory.GoogleCalendar.IssueCode("private@example.test",GoogleCalendarAuthService.InboxScope)
            :factory.MicrosoftProductivity.IssueCode("private@example.test","User.Read Mail.Send Mail.Read");
        using var callback=await browser.GetAsync($"/api/v1/integrations/{provider}/callback?state={state}&code={code}");
        Assert.EndsWith(provider+"=connected",callback.Headers.Location!.ToString());
    }
    private async Task<TestClient> Setup(string provider){
        Google.InboxEnabled=true;Microsoft.Enabled=true;Microsoft.InboxEnabled=true;
        Microsoft.ClientId="12345678-1234-1234-1234-123456789012";Microsoft.ClientSecret="fixture-secret";Microsoft.RedirectUri="https://testhost/api/v1/integrations/microsoft/callback";
        Options.Enabled=true;factory.Ai.Configured=true;
        factory.Ai.Answer=(_,_)=>JsonSerializer.Serialize(new{points=new[]{new{text="Private content for private@example.test",messageId=Id(provider),quote="Private content for private@example.test"}}});
        var owner=await TestClient.RegisterAsync(factory,"Inbox summary owner");await owner.CreateOrgAsync();await owner.UpgradeAsync("BUSINESS");await Connect(owner,provider);return owner;
    }
    private void Reset(){
        Options.Enabled=false;Google.InboxEnabled=false;factory.GoogleCalendar.Inbox.Reset();Microsoft.Enabled=false;Microsoft.InboxEnabled=false;
        Microsoft.ClientId=null;Microsoft.ClientSecret=null;Microsoft.RedirectUri=null;factory.MicrosoftProductivity.Reset();factory.Ai.Reset();
    }
    private async Task<JsonNode> Thread(TestClient owner,string provider){
        var result=await owner.Get($"/api/v1/me/inbox/thread?provider={provider}&messageId={Id(provider)}");Assert.True(result.Ok,result.ToString());return result.Data!;
    }
    private async Task<SummarizeInboxRequest> Request(TestClient owner,string provider){
        var source=await Thread(owner,provider);var options=await owner.Get(Route+"/options");Assert.True(options.Data!["available"]!.GetValue<bool>());
        return new(Guid.NewGuid(),provider,Id(provider),source["sourceHash"]!.GetValue<string>(),options.Data["credits"]!.GetValue<int>(),true);
    }
    private void Balance(TestClient owner,int spent){
        var account=factory.WithDb(db=>db.AiCreditAccounts.IgnoreQueryFilters().Single(a=>a.TenantId==owner.WorkspaceId));Assert.Equal(spent,account.Spent);Assert.Equal(0,account.Reserved);
    }
    [Theory][InlineData("google")][InlineData("microsoft")]
    public async Task Summaries_are_explicit_private_encrypted_cited_and_replay_without_another_call_or_charge(string provider){
        try{
            var owner=await Setup(provider);var req=await Request(owner,provider);
            var googleSends=factory.GoogleCalendar.SentMail.Count;var microsoftSends=factory.MicrosoftProductivity.SentMessages.Count;
            Assert.Equal(HttpStatusCode.UnprocessableEntity,(await owner.Post(Route,req with{Confirmed=false})).Status);Assert.Empty(factory.Ai.Prompts);
            Assert.Equal("INBOX_SUMMARY_PRICE_CHANGED",(await owner.Post(Route,req with{Credits=req.Credits+1})).ErrorCode);Assert.Empty(factory.Ai.Prompts);
            var result=await owner.Post(Route,req);Assert.True(result.Ok,result.ToString());Assert.Equal("completed",result.Data!["status"]!.GetValue<string>());
            Assert.Equal(Id(provider),result.Data["points"]![0]!["messageId"]!.GetValue<string>());Assert.Single(factory.Ai.Prompts);Balance(owner,req.Credits);
            var row=factory.WithDb(db=>db.PersonalInboxSummaries.IgnoreQueryFilters().Single(s=>s.OperationId==req.OperationId));
            Assert.DoesNotContain("Private content",row.ResultProtected!);Assert.DoesNotContain("private@example.test",row.ResultProtected!);
            Assert.True((await owner.Post(Route,req)).Ok);Assert.True((await owner.Get(Route+"/"+req.OperationId)).Ok);Assert.Single(factory.Ai.Prompts);Balance(owner,req.Credits);
            var colleague=await owner.AddMemberAsync(factory,TenantRole.Member,"Summary colleague");var foreign=await TestClient.RegisterAsync(factory,"Summary foreign");await foreign.CreateOrgAsync();
            foreach(var stranger in new[]{colleague,foreign}){
                Assert.Equal(HttpStatusCode.NotFound,(await stranger.Get(Route+"/"+req.OperationId)).Status);
                Assert.Empty((await stranger.Get(Route)).Data!.AsArray());Assert.True((await stranger.Delete(Route+"/"+req.OperationId)).Ok);
            }
            Assert.True((await owner.Get(Route+"/"+req.OperationId)).Ok);Assert.Equal(googleSends,factory.GoogleCalendar.SentMail.Count);Assert.Equal(microsoftSends,factory.MicrosoftProductivity.SentMessages.Count);
            await owner.Delete(Route+"/"+req.OperationId);Assert.Equal("AI_OPERATION_ALREADY_ADMITTED",(await owner.Post(Route,req)).ErrorCode);Assert.Single(factory.Ai.Prompts);Balance(owner,req.Credits);
        }finally{Reset();}
    }
    [Theory][InlineData("google")][InlineData("microsoft")]
    public async Task Invalid_quotes_ids_and_fabricated_numbers_release_all_credits(string provider){
        try{
            var owner=await Setup(provider);
            foreach(var point in new[]{new{text="Reviewed",messageId="unrelated",quote="Private content"},new{text="Reviewed",messageId=Id(provider),quote="Invented source"},new{text="Earned 999 rupees",messageId=Id(provider),quote="Private content"}}){
                var req=await Request(owner,provider);factory.Ai.Answer=(_,_)=>JsonSerializer.Serialize(new{points=new[]{point}});
                Assert.Equal("AI_INBOX_SUMMARY_INVALID",(await owner.Post(Route,req)).ErrorCode);Balance(owner,0);
                Assert.Equal("failed",(await owner.Get(Route+"/"+req.OperationId)).Data!["status"]!.GetValue<string>());
            }
        }finally{Reset();}
    }
    [Theory][InlineData("google")][InlineData("microsoft")]
    public async Task Source_changes_during_generation_prevent_publication_and_stale_reviews_do_not_call_AI(string provider){
        try{
            var owner=await Setup(provider);var req=await Request(owner,provider);var answer=factory.Ai.Answer;
            factory.Ai.Answer=(s,u)=>{Mailbox(provider).Body="Changed private content";return answer(s,u);};
            Assert.Equal("INBOX_SUMMARY_SOURCE_CHANGED",(await owner.Post(Route,req)).ErrorCode);Balance(owner,0);
            Assert.Equal("INBOX_SUMMARY_SOURCE_CHANGED",(await owner.Post(Route,req with{OperationId=Guid.NewGuid()})).ErrorCode);Assert.Single(factory.Ai.Prompts);
        }finally{Reset();}
    }
    [Theory][InlineData("google")][InlineData("microsoft")]
    public async Task Revoked_membership_during_generation_prevents_publication_and_releases_the_hold(string provider){
        try{
            var owner=await Setup(provider);var req=await Request(owner,provider);var answer=factory.Ai.Answer;
            factory.Ai.Answer=(s,u)=>{factory.WithDb(db=>db.TenantMembers.Where(m=>m.TenantId==owner.WorkspaceId&&m.UserId==owner.UserId).ExecuteDelete());return answer(s,u);};
            Assert.Equal(HttpStatusCode.Forbidden,(await owner.Post(Route,req)).Status);Balance(owner,0);
            Assert.Null(factory.WithDb(db=>db.PersonalInboxSummaries.IgnoreQueryFilters().Single(s=>s.OperationId==req.OperationId)).ResultProtected);
        }finally{Reset();}
    }
    [Theory][InlineData("google")][InlineData("microsoft")]
    public async Task Refresh_preserves_review_fingerprints_and_reconnection_invalidates_saved_access(string provider){
        try{
            var owner=await Setup(provider);var req=await Request(owner,provider);Assert.True((await owner.Post(Route,req)).Ok);
            factory.WithDb(db=>{
                if(provider=="google")db.GoogleConnections.IgnoreQueryFilters().Where(c=>c.UserId==owner.UserId&&c.TenantId==owner.WorkspaceId).ExecuteUpdate(s=>s.SetProperty(c=>c.AccessTokenExpiresAt,DateTime.UtcNow.AddMinutes(-5)));
                else db.MicrosoftConnections.IgnoreQueryFilters().Where(c=>c.UserId==owner.UserId&&c.TenantId==owner.WorkspaceId).ExecuteUpdate(s=>s.SetProperty(c=>c.AccessTokenExpiresAt,DateTime.UtcNow.AddMinutes(-5)));return 0;
            });
            Assert.Equal(req.SourceHash,(await Thread(owner,provider))["sourceHash"]!.GetValue<string>());
            Assert.True((await owner.Get(Route+"/"+req.OperationId)).Ok);
            Mailbox(provider).Body="Newer source content";var stale=await owner.Get(Route+"/"+req.OperationId);Assert.True(stale.Ok,stale.ToString());Assert.True(stale.Data!["sourceChanged"]!.GetValue<bool>());
            await Connect(owner,provider);Assert.Equal("INBOX_SUMMARY_SOURCE_CHANGED",(await owner.Get(Route+"/"+req.OperationId)).ErrorCode);Assert.Single(factory.Ai.Prompts);Balance(owner,req.Credits);
        }finally{Reset();}
    }
    [Theory][InlineData("google")][InlineData("microsoft")]
    public async Task Copied_encrypted_receipts_are_not_readable_by_another_owner(string provider){
        try{
            var one=await Setup(provider);var request=await Request(one,provider);Assert.True((await one.Post(Route,request)).Ok);
            var two=await Setup(provider);var second=await Request(two,provider);Assert.True((await two.Post(Route,second)).Ok);
            factory.WithDb(db=>{var rows=db.PersonalInboxSummaries.IgnoreQueryFilters().Where(s=>s.OperationId==request.OperationId||s.OperationId==second.OperationId).ToArray();rows.Single(s=>s.OperationId==second.OperationId).ResultProtected=rows.Single(s=>s.OperationId==request.OperationId).ResultProtected;return db.SaveChanges();});
            Assert.Equal("INBOX_SUMMARY_UNAVAILABLE",(await two.Get(Route+"/"+second.OperationId)).ErrorCode);Assert.Equal(2,factory.Ai.Prompts.Count);Balance(two,second.Credits);
        }finally{Reset();}
    }
    [Theory][InlineData("google")][InlineData("microsoft")]
    public async Task Removed_or_expired_claim_cannot_publish_after_generation(string provider){
        try{
            var owner=await Setup(provider);var req=await Request(owner,provider);var answer=factory.Ai.Answer;
            factory.Ai.Answer=(s,u)=>{factory.WithDb(db=>db.PersonalInboxSummaries.IgnoreQueryFilters().Where(r=>r.OperationId==req.OperationId).ExecuteDelete());return answer(s,u);};
            Assert.Equal("INBOX_SUMMARY_EXPIRED",(await owner.Post(Route,req)).ErrorCode);Balance(owner,0);
            req=await Request(owner,provider);
            factory.Ai.Answer=(s,u)=>{factory.WithDb(db=>db.PersonalInboxSummaries.IgnoreQueryFilters().Where(r=>r.OperationId==req.OperationId).ExecuteUpdate(x=>x.SetProperty(r=>r.Deadline,DateTime.UtcNow.AddMinutes(-1))));return answer(s,u);};
            Assert.Equal("INBOX_SUMMARY_EXPIRED",(await owner.Post(Route,req)).ErrorCode);Balance(owner,0);
        }finally{Reset();}
    }
    [Fact]
    public async Task Persisted_pending_claim_recovers_through_shared_credit_expiry_without_rerunning_AI(){
        try{
            var owner=await Setup("google");var req=await Request(owner,"google");var source=await Thread(owner,"google");
            using(var scope=factory.Services.CreateScope()){
                var ctx=scope.ServiceProvider.GetRequiredService<CurrentContext>();ctx.UserId=owner.UserId;ctx.TenantId=owner.WorkspaceId;ctx.Role=TenantRole.Owner;
                _=await scope.ServiceProvider.GetRequiredService<AiCreditService>().ReserveAsync(req.OperationId,req.Credits,"inbox-summary"); // Simulate process loss: no lease disposal.
            }
            factory.WithDb(db=>{
                db.PersonalInboxSummaries.Add(new PersonalInboxSummary{TenantId=owner.WorkspaceId,UserId=owner.UserId,OperationId=req.OperationId,Provider="google",MessageId="1001",SourceHash=req.SourceHash,AccessContext=source["accessContext"]!.GetValue<string>(),Credits=req.Credits,Deadline=DateTime.UtcNow.AddMinutes(-1),ExpiresAt=DateTime.UtcNow.AddHours(24)});
                db.AiCreditReservations.IgnoreQueryFilters().Where(r=>r.OperationId==req.OperationId).ExecuteUpdate(s=>s.SetProperty(r=>r.ExpiresAt,DateTime.UtcNow.AddMinutes(-1)));return db.SaveChanges();
            });
            Assert.Equal("expired",(await owner.Post(Route,req)).Data!["status"]!.GetValue<string>());Assert.Empty(factory.Ai.Prompts);
            using(var scope=factory.Services.CreateScope()){
                var ctx=scope.ServiceProvider.GetRequiredService<CurrentContext>();ctx.UserId=owner.UserId;ctx.TenantId=owner.WorkspaceId;ctx.Role=TenantRole.Owner;
                await scope.ServiceProvider.GetRequiredService<AiCreditService>().RecoverExpiredAsync(CancellationToken.None);
            }
            Balance(owner,0);Assert.Empty(factory.Ai.Prompts);
        }finally{Reset();}
    }
    [Fact]
    public async Task Disabled_and_truncated_sources_cannot_generate_or_spend(){
        try{
            var owner=await Setup("google");var req=await Request(owner,"google");Options.Enabled=false;
            Assert.Equal("AI_DISABLED",(await owner.Post(Route,req)).ErrorCode);Options.Enabled=true;factory.GoogleCalendar.Inbox.HtmlOnly=true;
            var source=await Thread(owner,"google");Assert.Equal(HttpStatusCode.UnprocessableEntity,(await owner.Post(Route,req with{SourceHash=source["sourceHash"]!.GetValue<string>()})).Status);
            Assert.Empty(factory.Ai.Prompts);Assert.Empty(factory.WithDb(db=>db.PersonalInboxSummaries.IgnoreQueryFilters().Where(s=>s.UserId==owner.UserId).ToArray()));
        }finally{Reset();}
    }
    [Fact]
    public async Task Idempotency_middleware_cannot_hold_a_transaction_across_AI_generation(){
        try{
            var owner=await Setup("google");var req=await Request(owner,"google");owner.Extra["Idempotency-Key"]=Guid.NewGuid().ToString();
            Assert.Equal("IDEMPOTENCY_UNSUPPORTED",(await owner.Post(Route,req)).ErrorCode);Assert.Empty(factory.Ai.Prompts);
            owner.Extra.Remove("Idempotency-Key");
            // A second database scope can write while the fake provider is running: the reservation transaction was committed already.
            var answer=factory.Ai.Answer;
            factory.Ai.Answer=(s,u)=>{factory.WithDb(db=>db.Tenants.Where(t=>t.Id==owner.WorkspaceId).ExecuteUpdate(x=>x.SetProperty(t=>t.AiDisabled,t=>t.AiDisabled)));return answer(s,u);};
            var result=await owner.Post(Route,req);Assert.True(result.Ok,result.ToString());Balance(owner,req.Credits);
        }finally{Reset();}
    }
    [Fact]
    public async Task Expiry_cleanup_deletes_only_expired_private_results_and_preserves_financial_receipts(){
        try{
            var owner=await Setup("google");var req=await Request(owner,"google");Assert.True((await owner.Post(Route,req)).Ok);
            var other=await Setup("google");var recent=await Request(other,"google");Assert.True((await other.Post(Route,recent)).Ok);
            factory.WithDb(db=>db.PersonalInboxSummaries.IgnoreQueryFilters().Where(s=>s.OperationId==req.OperationId).ExecuteUpdate(x=>x.SetProperty(s=>s.ExpiresAt,DateTime.UtcNow.AddMinutes(-1))));
            using(var scope=factory.Services.CreateScope())await scope.ServiceProvider.GetRequiredService<MaintenanceService>().PurgeInboxSummariesAsync();
            Assert.False(factory.WithDb(db=>db.PersonalInboxSummaries.IgnoreQueryFilters().Any(s=>s.OperationId==req.OperationId)));
            Assert.True((await other.Get(Route+"/"+recent.OperationId)).Ok);Balance(owner,req.Credits);
            Assert.True(factory.WithDb(db=>db.AiCreditReservations.IgnoreQueryFilters().Any(r=>r.OperationId==req.OperationId)));
        }finally{Reset();}
    }
}
