using System.Net;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Features.Integrations;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Tests.Infrastructure;
namespace ProjectManagement.Tests;

[Collection("api")]
public class PersonalEmailRecoveryTests(ApiFactory factory)
{
    private GoogleCalendarOptions Google=>factory.Services.GetRequiredService<IOptions<GoogleCalendarOptions>>().Value;
    private MicrosoftProductivityOptions Microsoft=>factory.Services.GetRequiredService<IOptions<MicrosoftProductivityOptions>>().Value;
    private FakeSentMailbox Sent(string provider)=>provider=="google"?factory.GoogleCalendar.Sent:factory.MicrosoftProductivity.Sent;
    private int Sends(string provider)=>provider=="google"?factory.GoogleCalendar.SentMail.Count:factory.MicrosoftProductivity.SentMessages.Count;
    private const string Path="/api/v1/me/email-drafts/";
    private void Reset(){Google.MailEnabled=false;Google.InboxEnabled=false;Microsoft.Enabled=false;Microsoft.InboxEnabled=false;Microsoft.ClientId=null;Microsoft.ClientSecret=null;Microsoft.RedirectUri=null;factory.GoogleCalendar.MailOutcomeUnknown=false;factory.GoogleCalendar.Sent.Reset();factory.MicrosoftProductivity.Reset();factory.MicrosoftProductivity.Sent.Reset();factory.Ai.Reset();}
    private async Task<(TestClient Owner,Guid Draft,int Version,int Credits)> Setup(string provider="google",bool ai=true){
        var owner=await TestClient.RegisterAsync(factory,"Recovery owner");await owner.CreateOrgAsync();await owner.UpgradeAsync("BUSINESS");
        var draft=await owner.Post(Path.TrimEnd('/'),new{recipient="recipient@example.test",subject="Reviewed subject",body="Reviewed private message.",provider});Assert.True(draft.Ok,draft.ToString());
        factory.Ai.Configured=ai;factory.Ai.Answer=(_,_)=>"""{"subject":"Clear subject","body":"Clear private message."}""";
        var credits=(await owner.Get(Path+"options")).Data!["credits"]!.GetValue<int>();return(owner,draft.Data!["id"]!.GetValue<Guid>(),draft.Data["version"]!.GetValue<int>(),credits);
    }
    private async Task Connect(TestClient owner,string provider,bool read=true,string? email=null){
        Google.MailEnabled=true;Google.InboxEnabled=true;Microsoft.Enabled=true;Microsoft.InboxEnabled=true;
        Microsoft.ClientId="12345678-1234-1234-1234-123456789012";Microsoft.ClientSecret="synthetic-secret";Microsoft.RedirectUri="https://testhost/api/v1/integrations/microsoft/callback";
        async Task Install(bool inbox){
            var start=await owner.Get($"/api/v1/integrations/{provider}/connect"+(inbox?"?inbox=true":provider=="google"?"?mail=true":""));Assert.True(start.Ok,start.ToString());
            var state=new Uri(start.Data!["url"]!.GetValue<string>()).Query.TrimStart('?').Split('&').Select(p=>p.Split('=',2)).Single(p=>p[0]=="state")[1];
            using var browser=factory.CreateClient(new WebApplicationFactoryClientOptions{AllowAutoRedirect=false});browser.DefaultRequestHeaders.Add("Cookie",start.Headers!["Set-Cookie"].Split(';')[0]);
            var scopes=provider=="google"?GoogleCalendarAuthService.MailScope+(inbox?" "+GoogleCalendarAuthService.InboxScope:""):"User.Read Mail.Send"+(inbox?" Mail.Read":"");
            var account=email??owner.UserId.ToString("N")+"@example.test";
            var code=provider=="google"?factory.GoogleCalendar.IssueCode(account,scopes):factory.MicrosoftProductivity.IssueCode(account,scopes);
            using var callback=await browser.GetAsync($"/api/v1/integrations/{provider}/callback?state={state}&code={code}");Assert.EndsWith(provider+"=connected",callback.Headers.Location!.ToString());
        }
        await Install(false);if(read)await Install(true);
    }
    private void Balance(TestClient owner,int cost){var a=factory.WithDb(db=>db.AiCreditAccounts.IgnoreQueryFilters().Single(a=>a.TenantId==owner.WorkspaceId));Assert.Equal(cost,a.Spent);Assert.Equal(0,a.Reserved);}
    [Theory][InlineData("copied")][InlineData("malformed")]
    public async Task Invalid_or_substituted_encrypted_result_cannot_be_read_or_regenerated(string corruption){
        try{
            var (owner,id,version,cost)=await Setup();var first=new EmailAiRequest(Guid.NewGuid(),version,"formal",true,cost);var route=Path+id+"/rewrites";
            var one=await owner.Post(route,first);Assert.True(one.Ok,one.ToString());
            var second=new EmailAiRequest(Guid.NewGuid(),one.Data!["draft"]!["version"]!.GetValue<int>(),"formal",true,cost);Assert.True((await owner.Post(route,second)).Ok);
            factory.WithDb(db=>{var rows=db.PersonalEmailRewrites.IgnoreQueryFilters().Where(r=>r.DraftId==id).ToArray();rows.Single(r=>r.OperationId==second.OperationId).ResultProtected=corruption=="copied"?rows.Single(r=>r.OperationId==first.OperationId).ResultProtected:"invalid-encrypted-payload";return db.SaveChanges();});
            Assert.Equal("AI_EMAIL_RECEIPT_UNAVAILABLE",(await owner.Get(route+"/"+second.OperationId)).ErrorCode);
            Assert.Equal("AI_EMAIL_RECEIPT_UNAVAILABLE",(await owner.Post(route,second)).ErrorCode);Assert.Equal(2,factory.Ai.Prompts.Count);Balance(owner,cost*2);
        }finally{Reset();}
    }
    [Fact]
    public async Task Saved_rewrite_is_owner_scoped_encrypted_replayable_and_never_overwrites_newer_edits(){
        try{
            var (owner,id,version,cost)=await Setup();var peer=await owner.AddMemberAsync(factory,TenantRole.Member,"Private peer");var outsider=await TestClient.RegisterAsync(factory,"Other org");await outsider.CreateOrgAsync();
            var op=Guid.NewGuid();var req=new EmailAiRequest(op,version,"formal",true,cost);var route=Path+id+"/rewrites";
            var result=await owner.Post(route,req);Assert.True(result.Ok,result.ToString());Assert.Equal("completed",result.Data!["status"]!.GetValue<string>());
            var receipt=factory.WithDb(db=>db.PersonalEmailRewrites.IgnoreQueryFilters().Single(r=>r.OperationId==op));Assert.DoesNotContain("Clear private message.",receipt.ResultProtected!);
            factory.Ai.Configured=false;var replay=await owner.Post(route,req);Assert.True(replay.Ok,replay.ToString());
            // PostgreSQL persists microseconds, while the initial CLR value has
            // 100-nanosecond ticks. All content/identity/cost fields must replay
            // exactly; only persisted timestamps permit sub-microsecond loss.
            var replayData=replay.Data!.DeepClone();
            foreach(var field in new[]{"createdAt","expiresAt"}){
                var original=result.Data[field]!.GetValue<DateTime>();var persisted=replayData[field]!.GetValue<DateTime>();
                Assert.InRange(Math.Abs((original-persisted).Ticks),0L,9L);
                replayData[field]=result.Data[field]!.DeepClone();
            }
            Assert.Equal(result.Data.ToJsonString(),replayData.ToJsonString());
            Assert.Equal("AI_EMAIL_KEY_MISMATCH",(await owner.Post(route,req with{Style="friendly"})).ErrorCode);
            foreach(var other in new[]{peer,outsider}){Assert.Equal(HttpStatusCode.NotFound,(await other.Get(route+"/"+op)).Status);Assert.Equal(HttpStatusCode.NotFound,(await other.Get(route)).Status);}
            var current=result.Data["draft"]!;Assert.True((await owner.Put(Path+id,new{recipient="recipient@example.test",subject="Newer subject",body="Manual newer content.",version=current["version"]!.GetValue<int>()})).Ok);
            var earlier=await owner.Get(route+"/"+op);Assert.True(earlier.Ok,earlier.ToString());Assert.True(earlier.Data!["draftChanged"]!.GetValue<bool>());Assert.Equal("Clear private message.",earlier.Data["draft"]!["body"]!.GetValue<string>());
            Assert.Equal("Manual newer content.",(await owner.Get(Path+id)).Data!["body"]!.GetValue<string>());Assert.Single(factory.Ai.Prompts);Balance(owner,cost);
        }finally{Reset();}
    }
    [Theory][InlineData("source")][InlineData("expired")][InlineData("removed")][InlineData("invalid")][InlineData("membership")]
    public async Task Failed_publication_refunds_and_cannot_flush_a_rolled_back_suggestion(string cause){
        try{
            var (owner,id,version,cost)=await Setup();var op=Guid.NewGuid();
            factory.Ai.Answer=(_,_)=>{
                factory.WithDb(db=>{
                    if(cause=="source")db.PersonalEmailDrafts.IgnoreQueryFilters().Where(d=>d.Id==id).ExecuteUpdate(s=>s.SetProperty(d=>d.Body,"Newer external edit.").SetProperty(d=>d.Version,d=>d.Version+1));
                    if(cause=="expired")db.PersonalEmailRewrites.IgnoreQueryFilters().Where(r=>r.OperationId==op).ExecuteUpdate(s=>s.SetProperty(r=>r.Deadline,DateTime.UtcNow.AddMinutes(-1)));
                    if(cause=="removed")db.PersonalEmailRewrites.IgnoreQueryFilters().Where(r=>r.OperationId==op).ExecuteDelete();
                    if(cause=="membership")db.TenantMembers.IgnoreQueryFilters().Where(m=>m.TenantId==owner.WorkspaceId&&m.UserId==owner.UserId).ExecuteDelete();return 0;
                });return cause=="invalid"?"""{"subject":"Invented","body":"Invented 999 rupees."}""":"""{"subject":"Clear subject","body":"Clear private message."}""";
            };
            var result=await owner.Post(Path+id+"/rewrites",new EmailAiRequest(op,version,"concise",true,cost));Assert.False(result.Ok,result.ToString());
            var saved=factory.WithDb(db=>db.PersonalEmailDrafts.IgnoreQueryFilters().Single(d=>d.Id==id));Assert.Equal("Reviewed subject",saved.Subject);Assert.Equal(cause=="source"?"Newer external edit.":"Reviewed private message.",saved.Body);Balance(owner,0);Assert.Single(factory.Ai.Prompts);
        }finally{Reset();}
    }
    [Fact]
    public async Task Parallel_replays_read_pending_claim_without_a_second_model_call(){
        using var release=new ManualResetEventSlim();var entered=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        try{
            var (owner,id,version,cost)=await Setup();var req=new EmailAiRequest(Guid.NewGuid(),version,"concise",true,cost);
            factory.Ai.Answer=(_,_)=>{entered.SetResult();if(!release.Wait(TimeSpan.FromSeconds(20)))throw new TimeoutException();return """{"subject":"Clear subject","body":"Clear private message."}""";};
            var first=owner.Post(Path+id+"/rewrites",req);await entered.Task.WaitAsync(TimeSpan.FromSeconds(20));
            var replay=await owner.Post(Path+id+"/rewrites",req);Assert.True(replay.Ok,replay.ToString());Assert.Equal("pending",replay.Data!["status"]!.GetValue<string>());Assert.Single(factory.Ai.Prompts);
            release.Set();var complete=await first;Assert.True(complete.Ok,complete.ToString());Balance(owner,cost);
        }finally{release.Set();Reset();}
    }
    [Fact]
    public async Task Expired_pending_receipt_releases_shared_hold_without_inference(){
        try{
            var (owner,id,version,cost)=await Setup();var op=Guid.NewGuid();
            using(var scope=factory.Services.CreateScope()){var ctx=scope.ServiceProvider.GetRequiredService<CurrentContext>();ctx.UserId=owner.UserId;ctx.TenantId=owner.WorkspaceId;ctx.Role=TenantRole.Owner;_=await scope.ServiceProvider.GetRequiredService<AiCreditService>().ReserveAsync(op,cost,"email-rewrite");}
            factory.WithDb(db=>{db.PersonalEmailRewrites.Add(new(){TenantId=owner.WorkspaceId,UserId=owner.UserId,DraftId=id,OperationId=op,SourceVersion=version,SourceHash=new string('a',64),Style="formal",Credits=cost,Deadline=DateTime.UtcNow.AddMinutes(-1),ExpiresAt=DateTime.UtcNow.AddHours(24)});db.AiCreditReservations.IgnoreQueryFilters().Where(r=>r.OperationId==op).ExecuteUpdate(s=>s.SetProperty(r=>r.ExpiresAt,DateTime.UtcNow.AddMinutes(-1)));return db.SaveChanges();});
            var result=await owner.Post(Path+id+"/rewrites",new EmailAiRequest(op,version,"formal",true,cost));Assert.True(result.Ok,result.ToString());Assert.Equal("expired",result.Data!["status"]!.GetValue<string>());
            using(var scope=factory.Services.CreateScope()){var ctx=scope.ServiceProvider.GetRequiredService<CurrentContext>();ctx.UserId=owner.UserId;ctx.TenantId=owner.WorkspaceId;ctx.Role=TenantRole.Owner;await scope.ServiceProvider.GetRequiredService<AiCreditService>().RecoverExpiredAsync(CancellationToken.None);}
            Balance(owner,0);Assert.Empty(factory.Ai.Prompts);
        }finally{Reset();}
    }
    [Theory][InlineData("google")][InlineData("microsoft")]
    public async Task Unknown_send_can_be_verified_from_matching_Sent_metadata_without_redispatch(string provider){
        try{
            var (owner,id,version,_)=await Setup(provider,false);await Connect(owner,provider);var before=Sends(provider);
            if(provider=="microsoft")Sent(provider).AddMicrosoftHistory(owner.UserId.ToString("N")+"@example.test");
            if(provider=="google")factory.GoogleCalendar.MailOutcomeUnknown=true;else factory.MicrosoftProductivity.ResponseLost=true;
            var send=await owner.Post(Path+id+"/send",new{version,confirmed=true,senderEmail=owner.UserId.ToString("N")+"@example.test"});Assert.True(send.Ok,send.ToString());Assert.Equal("unknown",send.Data!["status"]!.GetValue<string>());
            var row=factory.WithDb(db=>db.PersonalEmailDrafts.IgnoreQueryFilters().Single(d=>d.Id==id));Assert.NotNull(row.DispatchKey);Assert.True(send.Data["canReconcile"]!.GetValue<bool>());Assert.Null(send.Data["dispatchKey"]);
            var result=await owner.Post(Path+id+"/reconcile",new{});Assert.True(result.Ok,result.ToString());Assert.Equal("accepted",result.Data!["status"]!.GetValue<string>());Assert.NotNull(result.Data["reconciledAt"]);Assert.NotNull(result.Data["providerMessageId"]);
            var reads=Sent(provider).Reads.Count;Assert.True((await owner.Post(Path+id+"/reconcile",new{})).Ok);Assert.Equal(reads,Sent(provider).Reads.Count);Assert.Equal(before+1,Sends(provider));Assert.Empty(factory.Ai.Prompts);
        }finally{Reset();}
    }
    [Theory][InlineData("google","empty")][InlineData("google","mismatch")][InlineData("google","paged")][InlineData("google","duplicate")][InlineData("google","failure")][InlineData("microsoft","empty")][InlineData("microsoft","mismatch")][InlineData("microsoft","paged")][InlineData("microsoft","duplicate")][InlineData("microsoft","failure")]
    public async Task Missing_or_ambiguous_Sent_evidence_never_unblocks_retry(string provider,string evidence){
        try{
            var (owner,id,version,_)=await Setup(provider,false);await Connect(owner,provider);
            if(provider=="google")factory.GoogleCalendar.MailOutcomeUnknown=true;else factory.MicrosoftProductivity.ResponseLost=true;
            var req=new{version,confirmed=true,senderEmail=owner.UserId.ToString("N")+"@example.test"};Assert.True((await owner.Post(Path+id+"/send",req)).Ok);var before=Sends(provider);var mailbox=Sent(provider);
            mailbox.Empty=evidence=="empty";mailbox.Mismatch=evidence=="mismatch";mailbox.Paged=evidence=="paged";mailbox.Duplicate=evidence=="duplicate";mailbox.Failure=evidence=="failure";
            var checkedResult=await owner.Post(Path+id+"/reconcile",new{});if(evidence=="failure")Assert.Equal("EMAIL_SENT_UNAVAILABLE",checkedResult.ErrorCode);else{Assert.True(checkedResult.Ok,checkedResult.ToString());Assert.Equal("unknown",checkedResult.Data!["status"]!.GetValue<string>());}
            Assert.Equal("EMAIL_OUTCOME_UNKNOWN",(await owner.Post(Path+id+"/send",req)).ErrorCode);Assert.Equal(before,Sends(provider));Assert.Null(factory.WithDb(db=>db.PersonalEmailDrafts.IgnoreQueryFilters().Single(d=>d.Id==id).ReconciledAt));
        }finally{Reset();}
    }
    [Theory][InlineData("google")][InlineData("microsoft")]
    public async Task Sent_checks_require_separate_read_consent_owner_and_original_sender(string provider){
        try{
            var (owner,id,version,_)=await Setup(provider,false);await Connect(owner,provider,false);var peer=await owner.AddMemberAsync(factory,TenantRole.Member,"Receipt peer");
            if(provider=="google")factory.GoogleCalendar.MailOutcomeUnknown=true;else factory.MicrosoftProductivity.ResponseLost=true;
            Assert.True((await owner.Post(Path+id+"/send",new{version,confirmed=true,senderEmail=owner.UserId.ToString("N")+"@example.test"})).Ok);
            Assert.Equal(HttpStatusCode.NotFound,(await peer.Post(Path+id+"/reconcile",new{})).Status);
            Assert.Equal(HttpStatusCode.Conflict,(await owner.Post(Path+id+"/reconcile",new{})).Status);
            await Connect(owner,provider,true,"different@example.test");Assert.Equal("EMAIL_SENDER_CHANGED",(await owner.Post(Path+id+"/reconcile",new{})).ErrorCode);
        }finally{Reset();}
    }
    [Theory][InlineData("google")][InlineData("microsoft")]
    public async Task Revocation_during_Sent_read_cannot_publish_an_acceptance_receipt(string provider){
        try{
            var (owner,id,version,_)=await Setup(provider,false);await Connect(owner,provider);
            if(provider=="google")factory.GoogleCalendar.MailOutcomeUnknown=true;else factory.MicrosoftProductivity.ResponseLost=true;
            Assert.True((await owner.Post(Path+id+"/send",new{version,confirmed=true,senderEmail=owner.UserId.ToString("N")+"@example.test"})).Ok);var before=Sends(provider);
            Sent(provider).BeforeRead=()=>factory.WithDb(db=>{if(provider=="google")db.GoogleConnections.IgnoreQueryFilters().Where(c=>c.UserId==owner.UserId).ExecuteDelete();else db.MicrosoftConnections.IgnoreQueryFilters().Where(c=>c.UserId==owner.UserId).ExecuteDelete();return 0;});
            Assert.Equal("EMAIL_CONNECTION_CHANGED",(await owner.Post(Path+id+"/reconcile",new{})).ErrorCode);Assert.Equal(before,Sends(provider));Assert.Equal("unknown",factory.WithDb(db=>db.PersonalEmailDrafts.IgnoreQueryFilters().Single(d=>d.Id==id).Status));
        }finally{Reset();}
    }
}
