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
public class WhatsAppTemplateTests(ApiFactory factory)
{
    private const string Url = "/api/v1/integrations/whatsapp/templates";
    private WhatsAppOptions Options => factory.Services.GetRequiredService<IOptions<WhatsAppOptions>>().Value;
    private void Configure()
    {
        Options.AppId="123456789"; Options.AppSecret="fake-whatsapp-app-secret-only"; Options.VerifyToken="fake-whatsapp-verification-only";
        Options.ApiVersion="v24.0"; Options.SignupVersion="v4"; Options.EmbeddedSignupConfigId="987654321";
        Options.InstallationEnabled=true; Options.HealthChecksEnabled=true; Options.TemplateChecksEnabled=true;
    }
    private void Reset()
    {
        Options.InstallationEnabled=false; Options.HealthChecksEnabled=false; Options.TemplateChecksEnabled=false;
        Options.AppId=null; Options.AppSecret=null; Options.VerifyToken=null; Options.ApiVersion=null;
        Options.SignupVersion=null; Options.EmbeddedSignupConfigId=null; factory.WhatsApp.Reset();
    }
    private async Task<TestClient> Org(bool healthy=true, bool eligible=true)
    {
        var u=await TestClient.RegisterAsync(factory); await u.CreateOrgAsync(); await u.UpgradeAsync("BUSINESS");
        if(eligible) factory.WithDb(db=>{db.TenantFeatureOverrides.Add(new(){TenantId=u.WorkspaceId,FeatureKey=FeatureKeys.WhatsAppIntegration,Value=1});db.SaveChanges();return 0;});
        if(eligible)
        {
            var business=Random.Shared.NextInt64(1000000000000,9999999999999).ToString();var phone=Random.Shared.NextInt64(1000000000000,9999999999999).ToString();
            var start=await u.Post("/api/v1/integrations/whatsapp/connect");Assert.True(start.Ok,start.ToString());
            u.Extra["Cookie"]=start.Headers!["Set-Cookie"].Split(';')[0];
            Assert.True((await u.Post("/api/v1/integrations/whatsapp/complete",new{state=start.Data!["state"]!.GetValue<string>(),code=factory.WhatsApp.IssueCode(business,phone),businessAccountId=business,phoneNumberId=phone})).Ok);
            if(healthy) Assert.True((await u.Post("/api/v1/integrations/whatsapp/health/check")).Ok);
        }
        factory.WhatsApp.RequestPaths.Clear();return u;
    }
    private WhatsAppConnection Row(TestClient u)=>factory.WithDb(db=>db.WhatsAppConnections.IgnoreQueryFilters().AsNoTracking().Single(x=>x.TenantId==u.WorkspaceId));
    [Fact]
    public async Task Read_is_local_and_checks_are_default_off_even_after_health_success()
    {
        try { Configure();var a=await Org();Options.TemplateChecksEnabled=false;
            var status=await a.Get(Url);Assert.True(status.Ok);Assert.False(status.Data!["checkEnabled"]!.GetValue<bool>());
            Assert.Equal("unchecked",status.Data["state"]!.GetValue<string>());Assert.Empty(factory.WhatsApp.RequestPaths);
            Assert.Equal(HttpStatusCode.Conflict,(await a.Post(Url+"/check")).Status);Assert.Empty(factory.WhatsApp.RequestPaths);
            Options.TemplateChecksEnabled=true;var checkedResult=await a.Post(Url+"/check");Assert.True(checkedResult.Ok,checkedResult.ToString());
            Assert.Equal("verified",checkedResult.Data!["state"]!.GetValue<string>());Assert.False(checkedResult.Data["messagingEnabled"]!.GetValue<bool>());
            Assert.Equal("approved_utility_templates_only",checkedResult.Data["policy"]!.GetValue<string>());
            Assert.Equal(3,factory.WhatsApp.RequestPaths.Count);Assert.All(factory.WhatsApp.RequestPaths,path=>Assert.EndsWith("/message_templates",path));
            Assert.All(checkedResult.Data["templates"]!.AsArray(),x=>Assert.Equal("approved",x!["state"]!.GetValue<string>()));
            Assert.DoesNotContain("accessToken",checkedResult.Data.ToJsonString(),StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("fake_meta_",checkedResult.Data.ToJsonString());
            Assert.Equal(HttpStatusCode.TooManyRequests,(await a.Post(Url+"/check")).Status);
        } finally { Reset(); }
    }
    [Theory]
    [InlineData("missing","missing")][InlineData("name","missing")][InlineData("language","missing")]
    [InlineData("pending","pending")][InlineData("paused","unapproved")][InlineData("rejected","unapproved")]
    [InlineData("marketing","incompatible")][InlineData("text","incompatible")][InlineData("variable","incompatible")][InlineData("buttons","incompatible")]
    public async Task Approval_locale_category_and_exact_static_body_are_required(string problem,string expected)
    {
        try { Configure();var a=await Org();factory.WhatsApp.TemplateProblem=problem;var result=await a.Post(Url+"/check");Assert.True(result.Ok,result.ToString());
            Assert.Equal("attention",result.Data!["state"]!.GetValue<string>());Assert.False(result.Data["messagingEnabled"]!.GetValue<bool>());
            Assert.All(result.Data["templates"]!.AsArray(),x=>Assert.Equal(expected,x!["state"]!.GetValue<string>()));
        } finally { Reset(); }
    }
    [Theory][InlineData("duplicate")][InlineData("many")][InlineData("paging")][InlineData("oversized")][InlineData("malformed")][InlineData("redirect")][InlineData("unavailable")]
    public async Task Uncertain_or_unbounded_provider_results_never_show_approval(string problem)
    {
        try { Configure();var a=await Org();factory.WhatsApp.TemplateProblem=problem;var result=await a.Post(Url+"/check");Assert.True(result.Ok,result.ToString());
            Assert.Equal("unavailable",result.Data!["state"]!.GetValue<string>());
            Assert.All(result.Data["templates"]!.AsArray(),x=>Assert.Equal("unavailable",x!["state"]!.GetValue<string>()));
            Assert.Single(factory.WhatsApp.RequestPaths);Assert.DoesNotContain("fake token",result.ToString());
        } finally { Reset(); }
    }
    [Fact]
    public async Task Member_personal_plan_and_health_gates_precede_provider_reads()
    {
        try { Configure();var a=await Org(false);var member=await a.AddMemberAsync(factory,TenantRole.Member);var b=await Org(false,false);var personal=await TestClient.RegisterAsync(factory);
            Assert.Equal(HttpStatusCode.Forbidden,(await member.Get(Url)).Status);Assert.Equal(HttpStatusCode.Forbidden,(await member.Post(Url+"/check")).Status);
            Assert.Equal(HttpStatusCode.Forbidden,(await b.Post(Url+"/check")).Status);Assert.Equal(HttpStatusCode.Forbidden,(await personal.Get(Url)).Status);
            var missingHealth=await a.Post(Url+"/check");Assert.Equal("WHATSAPP_HEALTH_REQUIRED",missingHealth.ErrorCode);Assert.Empty(factory.WhatsApp.RequestPaths);
            Assert.Null(Row(a).TemplatesAttemptedAt);
        } finally { Reset(); }
    }
    [Fact]
    public async Task Two_organizations_have_independent_templates_and_credentials()
    {
        try { Configure();var a=await Org();var b=await Org();Assert.True((await a.Post(Url+"/check")).Ok);
            Assert.Equal("unchecked",(await b.Get(Url)).Data!["state"]!.GetValue<string>());Assert.Null(Row(b).TemplatesCheckedAt);
            factory.WhatsApp.TemplateProblem="missing";Assert.True((await b.Post(Url+"/check")).Ok);
            Assert.Equal("verified",(await a.Get(Url)).Data!["state"]!.GetValue<string>());Assert.Equal("attention",Row(b).TemplatesState);
        } finally { Reset(); }
    }
    [Theory][InlineData("disconnect")][InlineData("epoch")][InlineData("configuration")][InlineData("membership")][InlineData("plan")][InlineData("health")][InlineData("gate")][InlineData("lease")]
    public async Task Changes_during_provider_read_cannot_commit_approval(string mode)
    {
        try { Configure();var a=await Org();var once=false;factory.WhatsApp.BeforeTemplateResponse=async()=>{
                if(once)return;once=true;
                if(mode=="disconnect")Assert.True((await a.Post("/api/v1/integrations/whatsapp/disconnect")).Ok);
                // Rotate a non-secret configuration field so later fake requests remain authenticated.
                if(mode=="configuration")Options.SignupVersion="v3";
                if(mode=="gate")Options.TemplateChecksEnabled=false;
                factory.WithDb(db=>{
                    var row=db.WhatsAppConnections.IgnoreQueryFilters().Single(x=>x.TenantId==a.WorkspaceId);
                    if(mode=="epoch")row.ConnectedAt=DateTime.UtcNow;
                    if(mode=="membership")db.TenantMembers.Where(x=>x.TenantId==a.WorkspaceId&&x.UserId==a.UserId).ExecuteDelete();
                    if(mode=="plan")db.Subscriptions.Single(x=>x.TenantId==a.WorkspaceId).Status=SubscriptionStatus.Cancelled;
                    if(mode=="health")row.HealthState="attention";
                    if(mode=="lease")row.TemplatesLeaseUntil=DateTime.UtcNow.AddMinutes(-1);
                    db.SaveChanges();return 0;
                });
            };
            Assert.False((await a.Post(Url+"/check")).Ok);Assert.Null(Row(a).TemplatesCheckedAt);Assert.NotEqual("approved",Row(a).TaskAssignmentTemplateState);
            if(mode=="disconnect"){Assert.Equal("unchecked",Row(a).TemplatesState);Assert.Equal("",Row(a).AccessTokenProtected);}
        } finally { Reset(); }
    }
    [Fact]
    public async Task Parallel_checks_claim_once_and_disconnect_keeps_cooldown()
    {
        try { Configure();var a=await Org();var entered=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);var release=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var once=false;factory.WhatsApp.BeforeTemplateResponse=async()=>{if(once)return;once=true;entered.SetResult();await release.Task.WaitAsync(TimeSpan.FromSeconds(5));};
            var first=a.Post(Url+"/check");await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            try {Assert.Equal(HttpStatusCode.Conflict,(await a.Post(Url+"/check")).Status);} finally {release.TrySetResult();}
            Assert.True((await first).Ok);Assert.Equal(3,factory.WhatsApp.RequestPaths.Count);var attempted=Row(a).TemplatesAttemptedAt;
            Assert.True((await a.Post("/api/v1/integrations/whatsapp/disconnect")).Ok);Assert.Equal(attempted,Row(a).TemplatesAttemptedAt);Assert.Null(Row(a).TemplatesCheckedAt);
        } finally { Reset(); }
    }
    [Theory][InlineData("templates")][InlineData("health")][InlineData("configuration")][InlineData("plan")]
    public async Task Stale_results_hide_per_template_approval(string mode)
    {
        try { Configure();var a=await Org();Assert.True((await a.Post(Url+"/check")).Ok);
            factory.WithDb(db=>{var row=db.WhatsAppConnections.IgnoreQueryFilters().Single(x=>x.TenantId==a.WorkspaceId);
                if(mode=="templates")row.TemplatesCheckedAt=DateTime.UtcNow.AddMinutes(-6);
                if(mode=="health")row.HealthCheckedAt=DateTime.UtcNow.AddMinutes(-6);
                if(mode=="plan")db.Subscriptions.Single(x=>x.TenantId==a.WorkspaceId).Status=SubscriptionStatus.Cancelled;
                db.SaveChanges();return 0;});if(mode=="configuration")Options.SignupVersion="v3";
            var stale=await a.Get(Url);Assert.Equal("stale",stale.Data!["state"]!.GetValue<string>());
            Assert.All(stale.Data["templates"]!.AsArray(),x=>Assert.Equal("stale",x!["state"]!.GetValue<string>()));
            if(mode!="templates")Assert.False(stale.Data["checkEnabled"]!.GetValue<bool>());
        } finally { Reset(); }
    }
    [Fact]
    public async Task Abandoned_claim_expires_and_a_fresh_claim_can_recover()
    {
        try { Configure();var a=await Org();factory.WithDb(db=>{var row=db.WhatsAppConnections.IgnoreQueryFilters().Single(x=>x.TenantId==a.WorkspaceId);
                row.TemplatesState="checking";row.TemplatesLeaseId=Guid.NewGuid();row.TemplatesLeaseUntil=DateTime.UtcNow.AddMinutes(-1);row.TemplatesAttemptedAt=DateTime.UtcNow.AddMinutes(-2);db.SaveChanges();return 0;});
            Assert.Equal("unavailable",(await a.Get(Url)).Data!["state"]!.GetValue<string>());Assert.True((await a.Post(Url+"/check")).Ok);Assert.Equal("verified",Row(a).TemplatesState);
        } finally { Reset(); }
    }
}
