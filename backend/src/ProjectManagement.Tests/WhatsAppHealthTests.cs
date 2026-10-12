using System.Net;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Features.Integrations;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;
namespace ProjectManagement.Tests;
[Collection("api")]
public class WhatsAppHealthTests(ApiFactory factory)
{
    private const string Url = "/api/v1/integrations/whatsapp/health";
    private WhatsAppOptions Options => factory.Services.GetRequiredService<IOptions<WhatsAppOptions>>().Value;
    private void Configure()
    {
        Options.AppId="123456789"; Options.AppSecret="fake-whatsapp-app-secret-only"; Options.VerifyToken="fake-whatsapp-verification-only";
        Options.ApiVersion="v24.0"; Options.SignupVersion="v4"; Options.EmbeddedSignupConfigId="987654321";
        Options.InstallationEnabled=true; Options.HealthChecksEnabled=true; Options.WebhookReceptionEnabled=false;
    }
    private void Reset()
    {
        Options.InstallationEnabled=false; Options.HealthChecksEnabled=false; Options.WebhookReceptionEnabled=false;
        Options.AppId=null; Options.AppSecret=null; Options.VerifyToken=null; Options.ApiVersion=null;
        Options.SignupVersion=null; Options.EmbeddedSignupConfigId=null; factory.WhatsApp.Reset();
    }
    private async Task<TestClient> Org(bool eligible=true, bool connect=true)
    {
        var u=await TestClient.RegisterAsync(factory); await u.CreateOrgAsync(); await u.UpgradeAsync("BUSINESS");
        if(eligible) factory.WithDb(db=>{ db.TenantFeatureOverrides.Add(new(){TenantId=u.WorkspaceId,FeatureKey=FeatureKeys.WhatsAppIntegration,Value=1});db.SaveChanges();return 0; });
        if(connect)
        {
            var business=Random.Shared.NextInt64(1000000000000,9999999999999).ToString();var phone=Random.Shared.NextInt64(1000000000000,9999999999999).ToString();
            var start=await u.Post("/api/v1/integrations/whatsapp/connect");Assert.True(start.Ok,start.ToString());
            u.Extra["Cookie"]=start.Headers!["Set-Cookie"].Split(';')[0];
            var installed=await u.Post("/api/v1/integrations/whatsapp/complete",new{state=start.Data!["state"]!.GetValue<string>(),code=factory.WhatsApp.IssueCode(business,phone),businessAccountId=business,phoneNumberId=phone});
            Assert.True(installed.Ok,installed.ToString());
        }
        return u;
    }
    private WhatsAppConnection Row(TestClient u)=>factory.WithDb(db=>db.WhatsAppConnections.IgnoreQueryFilters().AsNoTracking().Single(x=>x.TenantId==u.WorkspaceId));
    [Fact]
    public async Task Healthy_read_checks_remain_default_gated_never_send_and_hide_credentials()
    {
        try {
            Configure();var a=await Org();var oldExpiry=Row(a).TokenExpiresAt;
            factory.WhatsApp.RequestPaths.Clear(); Options.HealthChecksEnabled=false;
            Assert.False((await a.Get(Url)).Data!["checkEnabled"]!.GetValue<bool>());
            Assert.Equal(HttpStatusCode.Conflict,(await a.Post(Url+"/check")).Status);Assert.Empty(factory.WhatsApp.RequestPaths);
            Options.HealthChecksEnabled=true;var health=await a.Post(Url+"/check");Assert.True(health.Ok,health.ToString());
            Assert.Equal("verified",health.Data!["state"]!.GetValue<string>());Assert.False(health.Data["messagingEnabled"]!.GetValue<bool>());
            Assert.All(new[]{"tokenValid","scopesPresent","assetsVerified","appSubscribed","phoneVerified"},key=>Assert.True(health.Data[key]!.GetValue<bool>()));
            Assert.DoesNotContain("fake_meta_",health.Json!.ToJsonString());Assert.DoesNotContain("fake-whatsapp-app-secret",health.Json.ToJsonString());
            Assert.Equal(4,factory.WhatsApp.RequestPaths.Count);Assert.Contains(factory.WhatsApp.RequestPaths,p=>p.EndsWith("/debug_token"));
            Assert.DoesNotContain(factory.WhatsApp.RequestPaths,p=>p.EndsWith("/messages")||p.EndsWith("/register"));
            Assert.True(Row(a).TokenExpiresAt<oldExpiry);Assert.Null(Row(a).HealthLeaseId);
            Assert.Equal(HttpStatusCode.TooManyRequests,(await a.Post(Url+"/check")).Status);
        } finally { Reset(); }
    }
    [Theory][InlineData("revoked","tokenValid")][InlineData("app","tokenValid")][InlineData("expired","tokenValid")]
    [InlineData("data_expired","tokenValid")][InlineData("scope","scopesPresent")][InlineData("asset_scope","scopesPresent")]
    [InlineData("unsubscribed","appSubscribed")]
    public async Task Provider_failures_report_attention_without_claiming_ready(string problem,string key)
    {
        try { Configure();var a=await Org();factory.WhatsApp.HealthProblem=problem;
            var health=await a.Post(Url+"/check");Assert.True(health.Ok,health.ToString());Assert.Equal("attention",health.Data!["state"]!.GetValue<string>());
            Assert.False(health.Data[key]!.GetValue<bool>());Assert.False(health.Data["messagingEnabled"]!.GetValue<bool>());
        } finally { Reset(); }
    }
    [Theory][InlineData("unavailable")][InlineData("redirect")][InlineData("oversized")][InlineData("malformed")][InlineData("paging")]
    public async Task Uncertain_or_unbounded_provider_responses_are_unknown_and_never_expose_raw_errors(string problem)
    {
        try { Configure();var a=await Org();factory.WhatsApp.HealthProblem=problem;
            var health=await a.Post(Url+"/check");Assert.True(health.Ok,health.ToString());Assert.Equal("unavailable",health.Data!["state"]!.GetValue<string>());
            Assert.Null(health.Data["tokenValid"]);Assert.DoesNotContain("fake secret",health.Json!.ToJsonString());Assert.DoesNotContain("attacker",health.Json.ToJsonString());
            Assert.Null(Row(a).HealthLeaseId);Assert.Null(Row(a).HealthTokenValid);
        } finally { Reset(); }
    }
    [Theory][InlineData(true)][InlineData(false)]
    public async Task Wrong_phone_or_unverified_ownership_does_not_pass_read_checks(bool wrong)
    {
        try { Configure();var a=await Org();factory.WhatsApp.WrongPhone=wrong;factory.WhatsApp.UnverifiedPhone=!wrong;
            var health=await a.Post(Url+"/check");Assert.True(health.Ok);Assert.Equal("attention",health.Data!["state"]!.GetValue<string>());
            Assert.False(health.Data[wrong?"assetsVerified":"phoneVerified"]!.GetValue<bool>());
        } finally { Reset(); }
    }
    [Fact]
    public async Task Organization_admin_and_subscription_checks_precede_every_provider_request()
    {
        try { Configure();var a=await Org();var member=await a.AddMemberAsync(factory,TenantRole.Member);var b=await Org(false,false);
            var personal=await TestClient.RegisterAsync(factory);factory.WhatsApp.RequestPaths.Clear();
            Assert.Equal(HttpStatusCode.Forbidden,(await member.Get(Url)).Status);Assert.Equal(HttpStatusCode.Forbidden,(await member.Post(Url+"/check")).Status);
            Assert.Equal(HttpStatusCode.Forbidden,(await b.Post(Url+"/check")).Status);Assert.Equal(HttpStatusCode.Forbidden,(await personal.Get(Url)).Status);
            Assert.Empty(factory.WhatsApp.RequestPaths);
        } finally { Reset(); }
    }
    [Fact]
    public async Task Two_organizations_keep_independent_health_and_token_checks()
    {
        try { Configure();var a=await Org();var b=await Org();Assert.True((await a.Post(Url+"/check")).Ok);
            Assert.Equal("unchecked",(await b.Get(Url)).Data!["state"]!.GetValue<string>());Assert.Null(Row(b).HealthCheckedAt);
            factory.WhatsApp.HealthProblem="revoked";Assert.True((await b.Post(Url+"/check")).Ok);
            Assert.Equal("verified",(await a.Get(Url)).Data!["state"]!.GetValue<string>());Assert.Equal("attention",Row(b).HealthState);
        } finally { Reset(); }
    }
    [Theory][InlineData("disconnect")][InlineData("epoch")][InlineData("configuration")][InlineData("membership")][InlineData("plan")]
    public async Task Changed_access_or_connection_during_provider_read_cannot_persist_a_healthy_result(string mode)
    {
        try { Configure();var a=await Org();factory.WhatsApp.BeforeHealthResponse=async()=>{
                if(mode=="disconnect")Assert.True((await a.Post("/api/v1/integrations/whatsapp/disconnect")).Ok);
                if(mode=="configuration")Options.AppSecret="fake-rotated-whatsapp-app-secret";
                factory.WithDb(db=>{
                    if(mode=="epoch")db.WhatsAppConnections.IgnoreQueryFilters().Single(x=>x.TenantId==a.WorkspaceId).ConnectedAt=DateTime.UtcNow;
                    if(mode=="membership")db.TenantMembers.Where(x=>x.TenantId==a.WorkspaceId&&x.UserId==a.UserId).ExecuteDelete();
                    if(mode=="plan")db.Subscriptions.Single(x=>x.TenantId==a.WorkspaceId).Status=SubscriptionStatus.Cancelled;
                    db.SaveChanges();return 0;
                });
            };
            var health=await a.Post(Url+"/check");Assert.False(health.Ok);Assert.Null(Row(a).HealthCheckedAt);Assert.Null(Row(a).HealthTokenValid);
            if(mode=="disconnect"){Assert.Equal("unchecked",Row(a).HealthState);Assert.Equal("",Row(a).AccessTokenProtected);}
        } finally { Reset(); }
    }
    [Fact]
    public async Task Expired_claims_can_recover_and_old_checks_are_never_displayed_as_current()
    {
        try { Configure();var a=await Org();Assert.True((await a.Post(Url+"/check")).Ok);
            factory.WithDb(db=>{var r=db.WhatsAppConnections.IgnoreQueryFilters().Single(x=>x.TenantId==a.WorkspaceId);r.HealthCheckedAt=DateTime.UtcNow.AddMinutes(-6);db.SaveChanges();return 0;});
            var stale=await a.Get(Url);Assert.Equal("stale",stale.Data!["state"]!.GetValue<string>());Assert.Null(stale.Data["tokenValid"]);
            factory.WithDb(db=>{var r=db.WhatsAppConnections.IgnoreQueryFilters().Single(x=>x.TenantId==a.WorkspaceId);r.HealthState="checking";r.HealthLeaseId=Guid.NewGuid();r.HealthLeaseUntil=DateTime.UtcNow.AddMinutes(-1);r.HealthAttemptedAt=DateTime.UtcNow.AddMinutes(-2);db.SaveChanges();return 0;});
            Assert.Equal("unavailable",(await a.Get(Url)).Data!["state"]!.GetValue<string>());
            Assert.True((await a.Post(Url+"/check")).Ok);Assert.Equal("verified",Row(a).HealthState);
        } finally { Reset(); }
    }
    [Fact]
    public async Task Parallel_checks_admit_only_one_and_disconnect_preserves_cooldown()
    {
        try { Configure();var a=await Org();var entered=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var release=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            factory.WhatsApp.BeforeHealthResponse=async()=>{entered.SetResult();await release.Task.WaitAsync(TimeSpan.FromSeconds(5));};
            var first=a.Post(Url+"/check");await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            try { Assert.Equal(HttpStatusCode.Conflict,(await a.Post(Url+"/check")).Status); }
            finally { release.TrySetResult(); }
            Assert.True((await first).Ok);var attempted=Row(a).HealthAttemptedAt;
            Assert.True((await a.Post("/api/v1/integrations/whatsapp/disconnect")).Ok);
            Assert.Equal(attempted,Row(a).HealthAttemptedAt);Assert.Null(Row(a).HealthCheckedAt);
        } finally { Reset(); }
    }
    [Fact]
    public async Task No_scheduled_provider_expiry_cannot_erase_an_existing_known_token_deadline()
    {
        try { Configure();var a=await Org();var expiry=Row(a).TokenExpiresAt;factory.WhatsApp.HealthProblem="nonexpiring";
            var health=await a.Post(Url+"/check");Assert.True(health.Ok,health.ToString());Assert.Equal("verified",health.Data!["state"]!.GetValue<string>());
            Assert.Equal(expiry,Row(a).TokenExpiresAt);Assert.False(health.Data["messagingEnabled"]!.GetValue<bool>());
        } finally { Reset(); }
    }

}
