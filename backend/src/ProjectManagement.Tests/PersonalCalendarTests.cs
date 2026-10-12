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
public class PersonalCalendarTests(ApiFactory factory)
{
    private GoogleCalendarOptions Options=>factory.Services.GetRequiredService<IOptions<GoogleCalendarOptions>>().Value;
    private async Task Connect(TestClient owner,string? email=null){
        var start=await owner.Get("/api/v1/integrations/google/connect");
        var query=new Uri(start.Data!["url"]!.GetValue<string>()).Query.TrimStart('?').Split('&').Select(p=>p.Split('=',2)).ToDictionary(p=>p[0],p=>Uri.UnescapeDataString(p[1]));
        using var browser=factory.CreateClient(new WebApplicationFactoryClientOptions{AllowAutoRedirect=false});browser.DefaultRequestHeaders.Add("Cookie",start.Headers["Set-Cookie"].Split(';')[0]);
        using var result=await browser.GetAsync("/api/v1/integrations/google/callback?state="+query["state"]+"&code="+factory.GoogleCalendar.IssueCode(email??owner.Email));
        Assert.EndsWith("google=connected",result.Headers.Location!.ToString());
    }
    private static async Task<(Guid Id,int Version)> Draft(TestClient owner,DateTimeOffset? time=null){
        var start=time??DateTimeOffset.UtcNow.AddDays(3);
        var result=await owner.Post("/api/v1/me/calendar-proposals",new{title="Private focus block",description="Private calendar notes",start,end=start.AddMinutes(30),timeZone="Asia/Kolkata"});
        Assert.True(result.Ok,result.ToString());return(result.Data!["id"]!.GetValue<Guid>(),result.Data["version"]!.GetValue<int>());
    }
    private void Reset(){Options.PersonalCalendarEnabled=false;factory.GoogleCalendar.ResetPersonalCalendar();}
    [Fact]
    public async Task Private_proposals_are_editable_without_activation_and_never_leak_notes_to_other_members(){
        Reset();var owner=await TestClient.RegisterAsync(factory,"Calendar owner");await owner.CreateOrgAsync();await owner.UpgradeAsync("BUSINESS");
        var member=await owner.AddMemberAsync(factory,TenantRole.Member,"Calendar peer");var foreign=await TestClient.RegisterAsync(factory);await foreign.CreateOrgAsync();
        var draft=await Draft(owner);Assert.Equal("",(await owner.Get("/api/v1/me/calendar-proposals")).Data!.AsArray().Single()!["description"]!.GetValue<string>());
        Assert.Equal("Private calendar notes",(await owner.Get($"/api/v1/me/calendar-proposals/{draft.Id}")).Data!["description"]!.GetValue<string>());
        foreach(var other in new[]{member,foreign}){
            Assert.Empty((await other.Get("/api/v1/me/calendar-proposals")).Data!.AsArray());
            Assert.Equal(HttpStatusCode.NotFound,(await other.Get($"/api/v1/me/calendar-proposals/{draft.Id}")).Status);
            Assert.Equal(HttpStatusCode.NotFound,(await other.Post($"/api/v1/me/calendar-proposals/{draft.Id}/reconcile")).Status);
            Assert.Equal(HttpStatusCode.NotFound,(await other.Delete($"/api/v1/me/calendar-proposals/{draft.Id}")).Status);
        }
        Assert.Equal("PERSONAL_CALENDAR_DISABLED",(await owner.Post($"/api/v1/me/calendar-proposals/{draft.Id}/confirm",new{version=1,confirmed=true,account=owner.Email})).ErrorCode);
        Assert.True((await owner.Delete($"/api/v1/me/calendar-proposals/{draft.Id}")).Ok);
    }
    [Fact]
    public async Task Missing_confirmation_account_conflicts_and_incomplete_availability_never_dispatch(){
        var owner=await TestClient.RegisterAsync(factory);await owner.CreateOrgAsync();Options.PersonalCalendarEnabled=true;
        try{
            await Connect(owner);var draft=await Draft(owner);var before=factory.GoogleCalendar.PersonalCalendarCreates.Count;var route=$"/api/v1/me/calendar-proposals/{draft.Id}/confirm";
            Assert.Equal(HttpStatusCode.UnprocessableEntity,(await owner.Post(route,new{version=1,confirmed=false,account=owner.Email})).Status);
            Assert.Equal("CALENDAR_ACCOUNT_CHANGED",(await owner.Post(route,new{version=1,confirmed=true,account="other@example.com"})).ErrorCode);
            factory.GoogleCalendar.PersonalCalendarBlocked=true;
            Assert.Equal("CALENDAR_CONFLICT",(await owner.Post(route,new{version=1,confirmed=true,account=owner.Email})).ErrorCode);
            factory.GoogleCalendar.PersonalCalendarBlocked=false;factory.GoogleCalendar.PersonalCalendarPaged=true;
            Assert.Equal("CALENDAR_AVAILABILITY_INCOMPLETE",(await owner.Post(route,new{version=1,confirmed=true,account=owner.Email})).ErrorCode);
            Assert.Equal(before,factory.GoogleCalendar.PersonalCalendarCreates.Count);
        }finally{Reset();}
    }
    [Fact]
    public async Task Concurrent_confirmation_creates_once_and_provider_read_back_is_required(){
        var owner=await TestClient.RegisterAsync(factory);await owner.CreateOrgAsync();Options.PersonalCalendarEnabled=true;
        try{
            await Connect(owner);var draft=await Draft(owner);var before=factory.GoogleCalendar.PersonalCalendarCreates.Count;var route=$"/api/v1/me/calendar-proposals/{draft.Id}/confirm";
            var req=new{version=1,confirmed=true,account=owner.Email};
            var results=await Task.WhenAll(owner.Post(route,req),owner.Post(route,req));Assert.Contains(results,r=>r.Ok);
            Assert.All(results,r=>Assert.True(r.Ok||r.Status==HttpStatusCode.Conflict,r.ToString()));
            var replay=await owner.Post(route,req);Assert.True(replay.Ok,replay.ToString());Assert.Equal("verified",replay.Data!["status"]!.GetValue<string>());
            Assert.NotNull(replay.Data["verifiedAt"]);Assert.Equal(owner.Email,replay.Data["confirmedAccount"]!.GetValue<string>());
            Assert.Equal(before+1,factory.GoogleCalendar.PersonalCalendarCreates.Count);
            Assert.True((await owner.Delete($"/api/v1/me/calendar-proposals/{draft.Id}")).Ok);
            var erased=factory.WithDb(db=>db.PersonalCalendarProposals.IgnoreQueryFilters().Single(p=>p.Id==draft.Id));
            Assert.Equal("deleted",erased.Status);Assert.Equal("",erased.Title);Assert.Equal("",erased.Description);
            Assert.Null(erased.ConfirmedAccount);Assert.Equal(DateTime.UnixEpoch,erased.StartUtc);
            Assert.NotNull(erased.ConfirmedAt);Assert.NotNull(erased.ProviderEventId);
        }finally{Reset();}
    }
    [Fact]
    public async Task Lost_response_is_recovered_by_read_only_reconciliation_without_another_write(){
        var owner=await TestClient.RegisterAsync(factory);await owner.CreateOrgAsync();Options.PersonalCalendarEnabled=true;
        try{
            await Connect(owner);var draft=await Draft(owner);var before=factory.GoogleCalendar.PersonalCalendarCreates.Count;
            factory.GoogleCalendar.PersonalCalendarResponseLost=true;var route=$"/api/v1/me/calendar-proposals/{draft.Id}";
            var req=new{version=1,confirmed=true,account=owner.Email};var result=await owner.Post(route+"/confirm",req);
            Assert.True(result.Ok,result.ToString());Assert.Equal("unknown",result.Data!["status"]!.GetValue<string>());
            Assert.Equal("CALENDAR_OUTCOME_UNKNOWN",(await owner.Post(route+"/confirm",req)).ErrorCode);Assert.Equal(HttpStatusCode.Conflict,(await owner.Delete(route)).Status);
            var recovered=await owner.Post(route+"/reconcile");Assert.True(recovered.Ok,recovered.ToString());Assert.Equal("verified",recovered.Data!["status"]!.GetValue<string>());
            Assert.Equal(before+1,factory.GoogleCalendar.PersonalCalendarCreates.Count);
        }finally{Reset();}
    }
    [Fact]
    public async Task Changed_provider_data_and_changed_accounts_cannot_be_marked_verified(){
        var owner=await TestClient.RegisterAsync(factory);await owner.CreateOrgAsync();Options.PersonalCalendarEnabled=true;
        try{
            await Connect(owner);var draft=await Draft(owner);factory.GoogleCalendar.PersonalCalendarReadMismatch=true;
            var route=$"/api/v1/me/calendar-proposals/{draft.Id}";var result=await owner.Post(route+"/confirm",new{version=1,confirmed=true,account=owner.Email});
            Assert.Equal("unknown",result.Data!["status"]!.GetValue<string>());
            Assert.Equal("unknown",(await owner.Post(route+"/reconcile")).Data!["status"]!.GetValue<string>());
            await Connect(owner,"changed@example.com");Assert.Equal("CALENDAR_ACCOUNT_CHANGED",(await owner.Post(route+"/reconcile")).ErrorCode);
        }finally{Reset();}
    }
    [Fact]
    public async Task Different_overlapping_proposals_cannot_race_into_two_provider_writes(){
        var owner=await TestClient.RegisterAsync(factory);await owner.CreateOrgAsync();Options.PersonalCalendarEnabled=true;
        try{
            await Connect(owner);var time=DateTimeOffset.UtcNow.AddDays(2);var first=await Draft(owner,time);var second=await Draft(owner,time);var before=factory.GoogleCalendar.PersonalCalendarCreates.Count;
            var req=new{version=1,confirmed=true,account=owner.Email};
            var results=await Task.WhenAll(owner.Post($"/api/v1/me/calendar-proposals/{first.Id}/confirm",req),owner.Post($"/api/v1/me/calendar-proposals/{second.Id}/confirm",req));
            Assert.Single(results,r=>r.Ok);Assert.Single(results,r=>!r.Ok&&r.ErrorCode=="CALENDAR_CONFLICT");Assert.Equal(before+1,factory.GoogleCalendar.PersonalCalendarCreates.Count);
        }finally{Reset();}
    }
    [Fact]
    public async Task Membership_revoked_during_availability_check_prevents_a_calendar_write(){
        var owner=await TestClient.RegisterAsync(factory);await owner.CreateOrgAsync();Options.PersonalCalendarEnabled=true;
        try{
            await Connect(owner);var draft=await Draft(owner);var before=factory.GoogleCalendar.PersonalCalendarCreates.Count;
            factory.GoogleCalendar.BeforePersonalCalendarList=()=>factory.WithDb(db=>{db.TenantMembers.Remove(db.TenantMembers.Single(m=>m.TenantId==owner.WorkspaceId&&m.UserId==owner.UserId));db.SaveChanges();return 0;});
            var result=await owner.Post($"/api/v1/me/calendar-proposals/{draft.Id}/confirm",new{version=1,confirmed=true,account=owner.Email});
            Assert.Equal(HttpStatusCode.Forbidden,result.Status);Assert.Equal(before,factory.GoogleCalendar.PersonalCalendarCreates.Count);
        }finally{Reset();}
    }
    [Fact]
    public async Task Reconnect_during_token_refresh_cannot_overwrite_the_new_calendar_identity(){
        var owner=await TestClient.RegisterAsync(factory);await owner.CreateOrgAsync();Options.PersonalCalendarEnabled=true;
        try{
            await Connect(owner);var draft=await Draft(owner);var before=factory.GoogleCalendar.PersonalCalendarCreates.Count;
            factory.WithDb(db=>{db.GoogleConnections.IgnoreQueryFilters().Single(c=>c.UserId==owner.UserId).AccessTokenExpiresAt=DateTime.UtcNow.AddDays(-1);db.SaveChanges();return 0;});
            var protector=factory.Services.GetRequiredService<ProjectManagement.Application.Abstractions.ISecretProtector>();
            factory.GoogleCalendar.BeforeRefresh=()=>factory.WithDb(db=>{
                var row=db.GoogleConnections.IgnoreQueryFilters().Single(c=>c.UserId==owner.UserId);
                row.GoogleEmail="replacement@example.com";row.RefreshTokenProtected=protector.Protect("replacement-fake-refresh");
                db.SaveChanges();return 0;
            });
            var result=await owner.Post($"/api/v1/me/calendar-proposals/{draft.Id}/confirm",new{version=1,confirmed=true,account=owner.Email});
            Assert.Equal("GOOGLE_CONNECTION_CHANGED",result.ErrorCode);Assert.Equal(before,factory.GoogleCalendar.PersonalCalendarCreates.Count);
            Assert.Equal("replacement@example.com",factory.WithDb(db=>db.GoogleConnections.IgnoreQueryFilters().Single(c=>c.UserId==owner.UserId).GoogleEmail));
        }finally{Reset();}
    }
    [Fact]
    public async Task Invalid_zones_times_and_offsetless_instants_are_rejected_before_saving(){
        var owner=await TestClient.RegisterAsync(factory);await owner.CreateOrgAsync();
        var start=DateTimeOffset.UtcNow.AddDays(2);
        var invalidZone=await owner.Post("/api/v1/me/calendar-proposals",new{title="Test",start,end=start.AddMinutes(30),timeZone="Unknown/Zone"});
        Assert.Equal(HttpStatusCode.UnprocessableEntity,invalidZone.Status);
        var invalidDuration=await owner.Post("/api/v1/me/calendar-proposals",new{title="Test",start,end=start.AddHours(25),timeZone="UTC"});
        Assert.Equal(HttpStatusCode.UnprocessableEntity,invalidDuration.Status);
        var missingOffset=await owner.Post("/api/v1/me/calendar-proposals",new{title="Test",start=start.ToString("yyyy-MM-ddTHH:mm:ss"),end=start.AddMinutes(30).ToString("yyyy-MM-ddTHH:mm:ss"),timeZone="UTC"});
        Assert.False(missingOffset.Ok);Assert.True(missingOffset.Status is HttpStatusCode.BadRequest or HttpStatusCode.UnprocessableEntity,missingOffset.ToString());
        Assert.Empty((await owner.Get("/api/v1/me/calendar-proposals")).Data!.AsArray());
    }
    [Theory]
    [InlineData("epoch",false)] [InlineData("scope",false)] [InlineData("account",false)] [InlineData("disabled",false)]
    [InlineData("epoch",true)] [InlineData("scope",true)] [InlineData("account",true)] [InlineData("disabled",true)]
    public async Task Connection_changes_during_availability_never_release_results_or_dispatch(string change,bool confirm){
        Reset();var owner=await TestClient.RegisterAsync(factory);await owner.CreateOrgAsync();Options.PersonalCalendarEnabled=true;
        try{
            await Connect(owner);var draft=await Draft(owner);var before=factory.GoogleCalendar.PersonalCalendarCreates.Count;
            factory.GoogleCalendar.BeforePersonalCalendarList=()=>{
                if(change=="disabled"){Options.PersonalCalendarEnabled=false;return;}
                factory.WithDb(db=>{var c=db.GoogleConnections.IgnoreQueryFilters().Single(c=>c.UserId==owner.UserId);
                    if(change=="epoch")c.ConsentEpoch=Guid.NewGuid();
                    if(change=="scope")c.Scopes="openid email";
                    if(change=="account")c.GoogleEmail="changed@example.com";
                    db.SaveChanges();return 0;});
            };
            var route=$"/api/v1/me/calendar-proposals/{draft.Id}";
            var result=confirm?await owner.Post(route+"/confirm",new{version=draft.Version,confirmed=true,account=owner.Email}):await owner.Get(route+"/availability?version="+draft.Version);
            Assert.Equal(change=="disabled"?"PERSONAL_CALENDAR_DISABLED":"CALENDAR_CONNECTION_CHANGED",result.ErrorCode);
            Assert.Equal(before,factory.GoogleCalendar.PersonalCalendarCreates.Count);
            Assert.Equal("draft",factory.WithDb(db=>db.PersonalCalendarProposals.IgnoreQueryFilters().Single(p=>p.Id==draft.Id).Status));
        }finally{Reset();}
    }
    [Fact]
    public async Task Membership_revocation_during_a_read_never_releases_private_availability(){
        Reset();var owner=await TestClient.RegisterAsync(factory);await owner.CreateOrgAsync();Options.PersonalCalendarEnabled=true;
        try{
            await Connect(owner);var draft=await Draft(owner);
            factory.GoogleCalendar.BeforePersonalCalendarList=()=>factory.WithDb(db=>{db.TenantMembers.Remove(db.TenantMembers.Single(m=>m.TenantId==owner.WorkspaceId&&m.UserId==owner.UserId));db.SaveChanges();return 0;});
            Assert.Equal(HttpStatusCode.Forbidden,(await owner.Get($"/api/v1/me/calendar-proposals/{draft.Id}/availability?version={draft.Version}")).Status);
        }finally{Reset();}
    }
    [Fact]
    public async Task Revocation_after_provider_dispatch_retains_an_uncertain_receipt_without_private_response_or_replay(){
        Reset();var owner=await TestClient.RegisterAsync(factory);await owner.CreateOrgAsync();Options.PersonalCalendarEnabled=true;
        try{
            await Connect(owner);var draft=await Draft(owner);var before=factory.GoogleCalendar.PersonalCalendarCreates.Count;
            var member=factory.WithDb(db=>db.TenantMembers.AsNoTracking().Single(m=>m.TenantId==owner.WorkspaceId&&m.UserId==owner.UserId));
            factory.GoogleCalendar.BeforePersonalCalendarCreateResponse=()=>factory.WithDb(db=>{db.TenantMembers.Remove(db.TenantMembers.Single(m=>m.Id==member.Id));db.SaveChanges();return 0;});
            var route=$"/api/v1/me/calendar-proposals/{draft.Id}";var req=new{version=draft.Version,confirmed=true,account=owner.Email};
            Assert.Equal(HttpStatusCode.Forbidden,(await owner.Post(route+"/confirm",req)).Status);
            var receipt=factory.WithDb(db=>db.PersonalCalendarProposals.IgnoreQueryFilters().Single(p=>p.Id==draft.Id));
            Assert.Equal("unknown",receipt.Status);Assert.Null(receipt.VerifiedAt);Assert.NotNull(receipt.ProviderEventId);
            factory.GoogleCalendar.BeforePersonalCalendarCreateResponse=null;
            factory.WithDb(db=>{db.TenantMembers.Add(member);db.SaveChanges();return 0;});
            Assert.Equal("CALENDAR_OUTCOME_UNKNOWN",(await owner.Post(route+"/confirm",req)).ErrorCode);
            Assert.Equal("verified",(await owner.Post(route+"/reconcile")).Data!["status"]!.GetValue<string>());
            Assert.Equal(before+1,factory.GoogleCalendar.PersonalCalendarCreates.Count);
        }finally{Reset();}
    }
    [Fact]
    public async Task Changed_consent_during_provider_readback_cannot_publish_a_verified_receipt(){
        Reset();var owner=await TestClient.RegisterAsync(factory);await owner.CreateOrgAsync();Options.PersonalCalendarEnabled=true;
        try{
            await Connect(owner);var draft=await Draft(owner);var before=factory.GoogleCalendar.PersonalCalendarCreates.Count;
            factory.GoogleCalendar.BeforePersonalCalendarVerify=()=>factory.WithDb(db=>{db.GoogleConnections.IgnoreQueryFilters().Single(c=>c.UserId==owner.UserId).ConsentEpoch=Guid.NewGuid();db.SaveChanges();return 0;});
            var route=$"/api/v1/me/calendar-proposals/{draft.Id}";
            Assert.Equal("unknown",(await owner.Post(route+"/confirm",new{version=draft.Version,confirmed=true,account=owner.Email})).Data!["status"]!.GetValue<string>());
            Assert.Equal("CALENDAR_CONNECTION_CHANGED",(await owner.Post(route+"/reconcile")).ErrorCode);
            Assert.Equal("unknown",factory.WithDb(db=>db.PersonalCalendarProposals.IgnoreQueryFilters().Single(p=>p.Id==draft.Id).Status));
            factory.GoogleCalendar.BeforePersonalCalendarVerify=null;
            Assert.Equal("verified",(await owner.Post(route+"/reconcile")).Data!["status"]!.GetValue<string>());
            Assert.Equal(before+1,factory.GoogleCalendar.PersonalCalendarCreates.Count);
        }finally{Reset();}
    }
    [Theory]
    [InlineData("calendar-proposals","confirm")] [InlineData("calendar-proposals","reconcile")]
    [InlineData("email-drafts","send")] [InlineData("email-drafts","improve")]
    public async Task Generic_retry_headers_cannot_wrap_provider_operations_or_ai_in_database_transactions(string resource,string action){
        var owner=await TestClient.RegisterAsync(factory);await owner.CreateOrgAsync();
        owner.Extra["Idempotency-Key"]="private-operation-"+Guid.NewGuid().ToString("N");
        var before=factory.GoogleCalendar.PersonalCalendarCreates.Count;var mailBefore=factory.GoogleCalendar.SentMail.Count;
        var result=await owner.Post($"/api/v1/me/{resource}/{Guid.NewGuid()}/{action}",new{});
        Assert.Equal(HttpStatusCode.UnprocessableEntity,result.Status);Assert.Equal("IDEMPOTENCY_UNSUPPORTED",result.ErrorCode);
        Assert.Equal(before,factory.GoogleCalendar.PersonalCalendarCreates.Count);Assert.Equal(mailBefore,factory.GoogleCalendar.SentMail.Count);
        Assert.False(factory.WithDb(db=>db.IdempotencyRecords.Any(r=>r.UserId==owner.UserId)));
    }

}
