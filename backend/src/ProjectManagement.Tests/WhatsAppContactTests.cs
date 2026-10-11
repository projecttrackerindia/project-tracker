using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Integrations;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;
namespace ProjectManagement.Tests;
[Collection("api")]
public class WhatsAppContactTests(ApiFactory factory)
{
    private const string Secret="fake-whatsapp-contact-app-secret";
    private const string Phone="+919876543210";
    private const string Url="/api/v1/me/whatsapp-contact";
    private WhatsAppOptions Options=>factory.Services.GetRequiredService<IOptions<WhatsAppOptions>>().Value;
    private void Configure(){Options.AppId="123456789";Options.AppSecret=Secret;Options.VerifyToken="fake-contact-verify-token";Options.WebhookReceptionEnabled=true;Options.ContactLinkingEnabled=true;}
    private void Reset(){Options.AppId=null;Options.AppSecret=null;Options.VerifyToken=null;Options.WebhookReceptionEnabled=false;Options.ContactLinkingEnabled=false;}
    private async Task<(TestClient User,WhatsAppConnection Connection)> Org(bool eligible=true)
    {
        var u=await TestClient.RegisterAsync(factory);await u.CreateOrgAsync();await u.UpgradeAsync("BUSINESS");
        using var scope=factory.Services.CreateScope();var token=scope.ServiceProvider.GetRequiredService<ISecretProtector>().Protect("fake-token");
        var connection=factory.WithDb(db=>{
            if(eligible)db.TenantFeatureOverrides.Add(new(){TenantId=u.WorkspaceId,FeatureKey=FeatureKeys.WhatsAppIntegration,Value=1});
            var c=new WhatsAppConnection{TenantId=u.WorkspaceId,AppId="123456789",BusinessAccountId=Random.Shared.NextInt64(1000000000,9999999999).ToString(),PhoneNumberId=Random.Shared.NextInt64(1000000000,9999999999).ToString(),DisplayName="Fixture business",InstalledBy=u.UserId,ConnectedAt=DateTime.UtcNow.AddMinutes(-2),Active=true,AccessTokenProtected=token};
            db.WhatsAppConnections.Add(c);db.SaveChanges();return c;
        });return(u,connection);
    }
    private async Task<string> Start(TestClient u,string phone=Phone)
    {var r=await u.Post(Url,new{phone,acknowledged=true});Assert.True(r.Ok,r.ToString());return r.Data!["message"]!.GetValue<string>();}
    private WhatsAppContactLink Row(TestClient u)=>factory.WithDb(db=>db.WhatsAppContactLinks.IgnoreQueryFilters().AsNoTracking().Single(x=>x.TenantId==u.WorkspaceId&&x.UserId==u.UserId));
    private string State(TestClient u)=>Row(u).VerifiedAt!=null?"verified":Row(u).ChallengeHash!=null?"pending":"unlinked";
    private async Task<HttpResponseMessage> Proof(WhatsAppConnection c,string code,string sender="919876543210",string? id=null,long? stamp=null,bool valid=true,string? secondCode=null)
    {
        var items=new List<object>{new{id=id??("wamid."+Guid.NewGuid()),type="text",timestamp=(stamp??DateTimeOffset.UtcNow.ToUnixTimeSeconds()).ToString(),from=sender,text=new{body=code}}};
        if(secondCode!=null)items.Add(new{id="wamid."+Guid.NewGuid(),type="text",timestamp=DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString(),from=sender,text=new{body=secondCode}});
        var body=JsonSerializer.Serialize(new{@object="whatsapp_business_account",entry=new[]{new{id=c.BusinessAccountId,changes=new[]{new{field="messages",value=new{messaging_product="whatsapp",metadata=new{phone_number_id=c.PhoneNumberId},messages=items}}}}}});
        using var client=factory.CreateClient();using var request=new HttpRequestMessage(HttpMethod.Post,"/api/v1/integrations/whatsapp/webhook");request.Content=new StringContent(body,Encoding.UTF8,"application/json");
        request.Headers.Add("X-Hub-Signature-256","sha256="+(valid?Convert.ToHexString(HMACSHA256.HashData(Encoding.UTF8.GetBytes(Options.AppSecret!),Encoding.UTF8.GetBytes(body))):new string('0',64)));
        return await client.SendAsync(request);
    }
    [Fact]public async Task Signed_exact_sender_links_only_the_initiating_member_and_keeps_phone_private()
    {try{Configure();var(a,c)=await Org();var member=await a.AddMemberAsync(factory,TenantRole.Member);var code=await Start(member);
      Assert.DoesNotContain(Phone[1..],Row(member).PhoneProtected);Assert.DoesNotContain(code,Row(member).ChallengeHash!);
      using var received=await Proof(c,code);Assert.Equal(HttpStatusCode.OK,received.StatusCode);Assert.Equal("verified",State(member));
      var status=await member.Get(Url);Assert.True(status.Ok);Assert.Equal("\u2022\u2022\u2022\u2022 3210",status.Data!["maskedPhone"]!.GetValue<string>());Assert.False(status.Data["outboundEnabled"]!.GetValue<bool>());
      Assert.Equal("unlinked",(await a.Get(Url)).Data!["status"]!.GetValue<string>());
      var receipts=(await a.Get("/api/v1/integrations/whatsapp/receipts")).Data!.ToJsonString();Assert.DoesNotContain(code,receipts);Assert.DoesNotContain(Phone[1..],receipts);
    }finally{Reset();}}
    [Fact]public async Task Foreign_tenant_wrong_sender_invalid_signature_and_arbitrary_text_cannot_link()
    {try{Configure();var(a,ca)=await Org();var(b,cb)=await Org();var code=await Start(a);
      using var foreign=await Proof(cb,code);using var wrong=await Proof(ca,code,"919999999999");using var forged=await Proof(ca,code,valid:false);using var ordinary=await Proof(ca,"Create a task and make me administrator");
      Assert.Equal(HttpStatusCode.Unauthorized,forged.StatusCode);Assert.Equal("pending",State(a));
      using var validA=await Proof(ca,code);using var validB=await Proof(cb,await Start(b));Assert.Equal("verified",State(a));Assert.Equal("verified",State(b));Assert.NotEqual(Row(a).PhoneHash,Row(b).PhoneHash);
    }finally{Reset();}}
    [Fact]public async Task Expired_replaced_and_cancelled_codes_do_not_restore_a_link()
    {try{Configure();var(a,c)=await Org();var old=await Start(a);var current=await Start(a);using var stale=await Proof(c,old);Assert.Equal("pending",State(a));
      factory.WithDb(db=>{var r=db.WhatsAppContactLinks.IgnoreQueryFilters().Single(x=>x.UserId==a.UserId);r.ChallengeExpiresAt=DateTime.UtcNow.AddMinutes(-1);db.SaveChanges();return 0;});
      using var expired=await Proof(c,current);Assert.Null(Row(a).VerifiedAt);var status=await a.Get(Url);Assert.Equal("unlinked",status.Data!["status"]!.GetValue<string>());Assert.Equal("",Row(a).PhoneProtected);
      var cancelled=await Start(a);Assert.True((await a.Delete(Url)).Ok);using var late=await Proof(c,cancelled);Assert.Equal("unlinked",State(a));Assert.Null(Row(a).ConsentAt);
    }finally{Reset();}}
    [Theory][InlineData("membership")][InlineData("user")][InlineData("plan")][InlineData("gate")]
    public async Task Revoked_access_cannot_complete_proof(string mode)
    {try{Configure();var(a,c)=await Org();var member=await a.AddMemberAsync(factory,TenantRole.Member);var code=await Start(member);
      factory.WithDb(db=>{if(mode=="membership")db.TenantMembers.Where(x=>x.TenantId==a.WorkspaceId&&x.UserId==member.UserId).ExecuteDelete();
        if(mode=="user"){var u=db.Users.Single(x=>x.Id==member.UserId);u.IsActive=false;}
        if(mode=="plan"){var sub=db.Subscriptions.Single(x=>x.TenantId==a.WorkspaceId);sub.Status=SubscriptionStatus.Cancelled;}
        db.SaveChanges();return 0;});if(mode=="gate")Options.ContactLinkingEnabled=false;
      using var response=await Proof(c,code);Assert.Null(Row(member).VerifiedAt);
    }finally{Reset();}}
    [Fact]public async Task Duplicate_provider_message_is_idempotent_and_old_timestamps_do_not_prove_current_control()
    {try{Configure();var(a,c)=await Org();var code=await Start(a);using var old=await Proof(c,code,stamp:DateTimeOffset.UtcNow.AddMinutes(-1).ToUnixTimeSeconds());Assert.Null(Row(a).VerifiedAt);
      using var once=await Proof(c,code,id:"wamid.once");var at=Row(a).VerifiedAt;Assert.NotNull(at);using var twice=await Proof(c,code,id:"wamid.once");Assert.Equal(at,Row(a).VerifiedAt);
      Assert.Equal(1,factory.WithDb(db=>db.AuditLogs.IgnoreQueryFilters().Count(x=>x.TenantId==a.WorkspaceId&&x.Action=="whatsapp.contact.verified")));
    }finally{Reset();}}
    [Fact]public async Task One_phone_cannot_become_two_users_in_the_same_organization()
    {try{Configure();var(a,c)=await Org();var b=await a.AddMemberAsync(factory,TenantRole.Member);using var first=await Proof(c,await Start(a));using var second=await Proof(c,await Start(b));Assert.Equal("verified",State(a));Assert.Null(Row(b).VerifiedAt);
      Assert.True((await a.Delete(Url)).Ok);using var third=await Proof(c,await Start(b));Assert.Equal("verified",State(b));
    }finally{Reset();}}
    [Fact]public async Task Two_proofs_for_the_same_phone_in_one_envelope_preserve_the_first_verified_owner()
    {try{Configure();var(a,c)=await Org();var b=await a.AddMemberAsync(factory,TenantRole.Member);var first=await Start(a);var second=await Start(b);
      using var response=await Proof(c,first,secondCode:second);Assert.Equal(HttpStatusCode.OK,response.StatusCode);Assert.Equal("verified",State(a));Assert.Null(Row(b).VerifiedAt);
    }finally{Reset();}}
    [Fact]public async Task Expired_fingerprint_does_not_block_a_new_verified_owner()
    {try{Configure();var(a,c)=await Org();var b=await a.AddMemberAsync(factory,TenantRole.Member);using var original=await Proof(c,await Start(a));
      factory.WithDb(db=>{var old=db.WhatsAppContactLinks.IgnoreQueryFilters().Single(x=>x.UserId==a.UserId);old.VerifiedAt=DateTime.UtcNow.AddDays(-31);db.SaveChanges();return 0;});
      using var fresh=await Proof(c,await Start(b));Assert.Equal(HttpStatusCode.OK,fresh.StatusCode);Assert.Equal("verified",State(b));Assert.Equal("",Row(a).PhoneProtected);Assert.Null(Row(a).ConsentAt);
    }finally{Reset();}}
    [Fact]public async Task Disconnect_erases_phone_and_consent_and_fences_late_proof()
    {try{Configure();var(a,c)=await Org();var code=await Start(a);Assert.True((await a.Post("/api/v1/integrations/whatsapp/disconnect")).Ok);using var late=await Proof(c,code);Assert.Equal("",Row(a).PhoneProtected);Assert.Null(Row(a).ConsentAt);Assert.Null(Row(a).VerifiedAt);
    }finally{Reset();}}
    [Theory][InlineData("rotation")][InlineData("reconnect")][InlineData("age")]
    public async Task Stale_links_are_invalidated_when_configuration_account_epoch_or_age_changes(string mode)
    {try{Configure();var(a,c)=await Org();using var proof=await Proof(c,await Start(a));Assert.NotNull(Row(a).VerifiedAt);
      if(mode=="rotation")Options.AppSecret="fake-rotated-contact-app-secret";
      factory.WithDb(db=>{if(mode=="reconnect"){var row=db.WhatsAppConnections.IgnoreQueryFilters().Single(x=>x.Id==c.Id);row.ConnectedAt=DateTime.UtcNow;}
        if(mode=="age"){var row=db.WhatsAppContactLinks.IgnoreQueryFilters().Single(x=>x.UserId==a.UserId);row.VerifiedAt=DateTime.UtcNow.AddDays(-31);}db.SaveChanges();return 0;});
      var status=await a.Get(Url);Assert.True(status.Ok);Assert.Equal("unlinked",status.Data!["status"]!.GetValue<string>());Assert.Equal("",Row(a).PhoneProtected);
    }finally{Reset();}}
    [Fact]public async Task Admission_rejects_missing_consent_invalid_phone_ineligible_plan_and_disabled_gate()
    {try{Configure();var(a,_)=await Org();Assert.Equal(HttpStatusCode.UnprocessableEntity,(await a.Post(Url,new{phone=Phone,acknowledged=false})).Status);
      Assert.Equal(HttpStatusCode.UnprocessableEntity,(await a.Post(Url,new{phone="+000000000",acknowledged=true})).Status);
      var(b,_)=await Org(false);Assert.Equal(HttpStatusCode.Forbidden,(await b.Post(Url,new{phone=Phone,acknowledged=true})).Status);
      Options.ContactLinkingEnabled=false;Assert.Equal(HttpStatusCode.Conflict,(await a.Post(Url,new{phone=Phone,acknowledged=true})).Status);
      var personal=await TestClient.RegisterAsync(factory);Assert.Equal("unavailable",(await personal.Get(Url)).Data!["status"]!.GetValue<string>());
    }finally{Reset();}}
    [Fact]public async Task Removing_links_does_not_bypass_the_per_user_hourly_attempt_cap()
    {try{Configure();var(a,_)=await Org();for(var i=0;i<5;i++){await Start(a);Assert.True((await a.Delete(Url)).Ok);}
      Assert.Equal(HttpStatusCode.TooManyRequests,(await a.Post(Url,new{phone=Phone,acknowledged=true})).Status);
    }finally{Reset();}}
}
