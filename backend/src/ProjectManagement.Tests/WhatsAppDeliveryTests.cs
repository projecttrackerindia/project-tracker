using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Features.Integrations;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;
namespace ProjectManagement.Tests;
[Collection("api")]
public class WhatsAppDeliveryTests(ApiFactory factory)
{
    private readonly HashSet<Guid> ownedTenants=[];
    private const string Secret="fake-whatsapp-app-secret-only";
    private const string Phone="919876543210";
    private WhatsAppOptions O=>factory.Services.GetRequiredService<IOptions<WhatsAppOptions>>().Value;
    private WhatsAppDeliveryProcessor Processor=>factory.Services.GetRequiredService<WhatsAppDeliveryProcessor>();
    private void Configure()
    {
        O.AppId="123456789";O.AppSecret=Secret;O.VerifyToken="fake-whatsapp-verification-only";O.ApiVersion="v24.0";O.SignupVersion="v4";O.EmbeddedSignupConfigId="987654321";
        O.InstallationEnabled=true;O.HealthChecksEnabled=true;O.TemplateChecksEnabled=true;O.ContactLinkingEnabled=true;O.WebhookReceptionEnabled=true;O.DeliveryEnabled=true;
        O.DeliveryUserDailyCap=10;O.DeliveryOrganizationDailyCap=1000;factory.WhatsApp.Reset();
        // Prefer this test's newly installed tenants; keep earlier fixture organizations/data intact.
        factory.WithDb(db=>{db.WhatsAppConnections.IgnoreQueryFilters().ExecuteUpdate(s=>s.SetProperty(x=>x.DeliveryPolledAt,DateTime.UtcNow.AddDays(1)));return 0;});
    }
    private void Reset()
    {
        // A default-off fixture legitimately leaves a recent notification unqueued. Retire this test's installations
        // so a later test enabling the shared worker cannot deliver its earlier fixture notification.
        factory.WithDb(db=>{db.WhatsAppConnections.IgnoreQueryFilters().Where(x=>ownedTenants.Contains(x.TenantId))
            .ExecuteUpdate(s=>s.SetProperty(x=>x.Active,false));return 0;});
        O.DeliveryEnabled=false;O.InstallationEnabled=false;O.HealthChecksEnabled=false;O.TemplateChecksEnabled=false;O.ContactLinkingEnabled=false;O.WebhookReceptionEnabled=false;
        O.AppId=null;O.AppSecret=null;O.VerifyToken=null;O.ApiVersion=null;O.SignupVersion=null;O.EmbeddedSignupConfigId=null;O.DeliveryUserDailyCap=10;O.DeliveryOrganizationDailyCap=1000;factory.WhatsApp.Reset();
    }
    private async Task<TestClient> Org()
    {
        var u=await TestClient.RegisterAsync(factory);await u.CreateOrgAsync();await u.UpgradeAsync("BUSINESS");ownedTenants.Add(u.WorkspaceId);
        factory.WithDb(db=>{db.TenantFeatureOverrides.Add(new(){TenantId=u.WorkspaceId,FeatureKey=FeatureKeys.WhatsAppIntegration,Value=1});db.SaveChanges();return 0;});
        var business=Random.Shared.NextInt64(1000000000000,9999999999999).ToString();var phone=Random.Shared.NextInt64(1000000000000,9999999999999).ToString();
        var start=await u.Post("/api/v1/integrations/whatsapp/connect");Assert.True(start.Ok,start.ToString());u.Extra["Cookie"]=start.Headers!["Set-Cookie"].Split(';')[0];
        Assert.True((await u.Post("/api/v1/integrations/whatsapp/complete",new{state=start.Data!["state"]!.GetValue<string>(),code=factory.WhatsApp.IssueCode(business,phone),businessAccountId=business,phoneNumberId=phone})).Ok);
        var code=await u.Post("/api/v1/me/whatsapp-contact",new{phone="+"+Phone,acknowledged=true});Assert.True(code.Ok,code.ToString());
        var c=Connection(u);var body=ProofBody(c,Phone,code.Data!["message"]!.GetValue<string>());
        using var proof=await Webhook(body);Assert.Equal(HttpStatusCode.OK,proof.StatusCode);
        var version=(await u.Get("/api/v1/me/whatsapp-contact/notification-preferences")).Data!["version"]!.GetValue<int>();
        var minute=DateTime.UtcNow.Hour*60+DateTime.UtcNow.Minute;
        var prefs=await u.Put("/api/v1/me/whatsapp-contact/notification-preferences",new{version,optIn=true,acceptedConsentVersion=WhatsAppContactService.NotificationConsent,
            taskAssignments=true,overdue=true,supportUpdates=true,timeZone="UTC",quietStartMinutes=(minute+60)%1440,quietEndMinutes=(minute+120)%1440});Assert.True(prefs.Ok,prefs.ToString());
        factory.WhatsApp.RequestPaths.Clear();return u;
    }
    private WhatsAppConnection Connection(TestClient u)=>factory.WithDb(db=>db.WhatsAppConnections.IgnoreQueryFilters().AsNoTracking().Single(x=>x.TenantId==u.WorkspaceId));
    private List<WhatsAppDelivery> Rows(TestClient u)=>factory.WithDb(db=>db.WhatsAppDeliveries.IgnoreQueryFilters().AsNoTracking().Where(x=>x.TenantId==u.WorkspaceId).OrderBy(x=>x.CreatedAt).ToList());
    private async Task<Guid> Notify(TestClient u,Guid? foreignTask=null)
    {
        Guid task,project;
        if(foreignTask!=null){task=foreignTask.Value;project=factory.WithDb(db=>db.Tasks.IgnoreQueryFilters().Single(x=>x.Id==task).ProjectId);}
        else{project=await u.CreateProjectAsync();task=(await u.CreateTaskAsync(project,"Confidential fixture task",new{title="Confidential fixture task",priority="Medium",assigneeId=u.UserId}))["id"]!.GetValue<Guid>();}
        var n=factory.WithDb(db=>{var n=new Notification{TenantId=u.WorkspaceId,UserId=u.UserId,Type=NotificationType.TaskAssigned,Title="Private title",Body="Private body",Link=$"/projects/{project}?task={task}",CreatedAt=DateTime.UtcNow};db.Notifications.Add(n);db.SaveChanges();return n;});
        return n.Id;
    }
    private async Task Queue(TestClient u,Guid notification)
    {
        using var scope=factory.Services.CreateScope();var sp=scope.ServiceProvider;sp.GetRequiredService<CurrentContext>().TenantId=u.WorkspaceId;
        var n=await sp.GetRequiredService<IAppDbContext>().Notifications.AsNoTracking().SingleAsync(x=>x.Id==notification);
        await sp.GetRequiredService<WhatsAppDeliveryService>().QueueAsync(n,CancellationToken.None);
    }
    private static string ProofBody(WhatsAppConnection c,string phone,string code)
    {
        var message=new{id="wamid.proof."+Guid.NewGuid(),type="text",from=phone,timestamp=DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString(),text=new{body=code}};
        var value=new{messaging_product="whatsapp",metadata=new{phone_number_id=c.PhoneNumberId},messages=new[]{message}};
        var entry=new{id=c.BusinessAccountId,changes=new[]{new{field="messages",value}}};
        return JsonSerializer.Serialize(new{@object="whatsapp_business_account",entry=new[]{entry}});
    }
    private async Task<HttpResponseMessage> Webhook(string body,bool signed=true)
    {
        using var client=factory.CreateClient();using var request=new HttpRequestMessage(HttpMethod.Post,"/api/v1/integrations/whatsapp/webhook");request.Content=new StringContent(body,Encoding.UTF8,"application/json");
        request.Headers.Add("X-Hub-Signature-256","sha256="+(signed?Convert.ToHexString(HMACSHA256.HashData(Encoding.UTF8.GetBytes(Secret),Encoding.UTF8.GetBytes(body))):new string('0',64)));
        return await client.SendAsync(request);
    }
    private Task<HttpResponseMessage> Status(FakeWhatsAppInstallation.Sent sent,string state="delivered",bool signed=true,string? recipient=null,string? tag=null,string? id=null,long? timestamp=null)
    {
        var body=JsonSerializer.Serialize(new{@object="whatsapp_business_account",entry=new[]{new{id=sent.Business,changes=new[]{new{field="messages",value=new{messaging_product="whatsapp",metadata=new{phone_number_id=sent.Phone},statuses=new[]{new{id=id??sent.MessageId,status=state,recipient_id=recipient??sent.Recipient,biz_opaque_callback_data=tag??sent.CallbackTag,timestamp=(timestamp??DateTimeOffset.UtcNow.ToUnixTimeSeconds()).ToString()}}}}}}}});
        return Webhook(body,signed);
    }
    [Fact]
    public async Task Default_off_does_not_queue_read_provider_or_send_and_read_history_is_private()
    {
        try{Configure();var a=await Org();var n=await Notify(a);O.DeliveryEnabled=false;factory.WhatsApp.RequestPaths.Clear();await Queue(a,n);
            Assert.Equal(0,await Processor.ProcessAsync());Assert.Empty(Rows(a));Assert.Empty(factory.WhatsApp.RequestPaths);Assert.Empty(factory.WhatsApp.Sends);
        }finally{Reset();}
    }
    [Fact]
    public async Task Never_polled_organization_is_not_starved_by_a_full_batch_of_previously_polled_organizations()
    {
        try
        {
            Configure();var organizations=new List<TestClient>();
            for(var i=0;i<11;i++){var organization=await Org();organizations.Add(organization);await Notify(organization);}
            var previouslyPolled=DateTime.UtcNow.Date.AddDays(-1);var newcomer=organizations[^1];
            factory.WithDb(db=>
            {
                db.WhatsAppConnections.IgnoreQueryFilters().Where(x=>ownedTenants.Contains(x.TenantId))
                    .ExecuteUpdate(s=>s.SetProperty(x=>x.DeliveryPolledAt,previouslyPolled));
                db.WhatsAppConnections.IgnoreQueryFilters().Where(x=>x.TenantId==newcomer.WorkspaceId)
                    .ExecuteUpdate(s=>s.SetProperty(x=>x.DeliveryPolledAt,(DateTime?)null));return 0;
            });
            await Processor.ProcessAsync();
            Assert.NotNull(Connection(newcomer).DeliveryPolledAt);Assert.Equal("accepted",Assert.Single(Rows(newcomer)).State);
            Assert.Equal(10,factory.WhatsApp.Sends.Count);
            Assert.Single(organizations.Take(10),x=>Connection(x).DeliveryPolledAt==previouslyPolled);
            await Processor.ProcessAsync();Assert.Equal(11,factory.WhatsApp.Sends.Count);
            Assert.All(organizations,x=>Assert.Equal("accepted",Assert.Single(Rows(x)).State));
        }
        finally{Reset();}
    }
    [Fact]
    public async Task Persisted_notifications_send_once_through_exact_tenant_token_and_generic_template()
    {
        try{Configure();var a=await Org();var n=await Notify(a);await Queue(a,n);await Queue(a,n);
            Assert.Single(Rows(a));await Processor.ProcessAsync();Assert.Equal("accepted",Assert.Single(Rows(a)).State);Assert.Single(factory.WhatsApp.Sends);
            Assert.Equal(8,factory.WhatsApp.RequestPaths.Count);await Processor.ProcessAsync();Assert.Single(factory.WhatsApp.Sends);
            var me=await a.Get("/api/v1/me/whatsapp-contact/deliveries");Assert.True(me.Ok);Assert.Single(me.Data!.AsArray());
            Assert.DoesNotContain(Phone,me.Data.ToJsonString());Assert.DoesNotContain("Private title",me.Data.ToJsonString());Assert.DoesNotContain("fake_meta_",me.Data.ToJsonString());
        }finally{Reset();}
    }
    [Fact]
    public async Task Two_organizations_do_not_share_tokens_receipts_or_business_resources()
    {
        try{Configure();var a=await Org();var b=await Org();var na=await Notify(a);var nb=await Notify(b);await Queue(a,na);await Queue(b,nb);
            await Processor.ProcessAsync();Assert.Equal(2,factory.WhatsApp.Sends.Count);Assert.NotEqual(Connection(a).PhoneNumberId,Connection(b).PhoneNumberId);
            var owned=await a.Get("/api/v1/me/whatsapp-contact/deliveries");Assert.Single(owned.Data!.AsArray());Assert.DoesNotContain(Rows(b)[0].Id.ToString(),owned.Data.ToJsonString());
            var foreign=factory.WithDb(db=>db.Tasks.IgnoreQueryFilters().First(x=>x.TenantId==b.WorkspaceId).Id);var bad=await Notify(a,foreign);await Queue(a,bad);
            factory.WithDb(db=>{db.WhatsAppDeliveries.IgnoreQueryFilters().Where(x=>x.TenantId==a.WorkspaceId&&x.AttemptedAt!=null).ExecuteUpdate(s=>s.SetProperty(x=>x.AttemptedAt,DateTime.UtcNow.AddMinutes(-2)));return 0;});
            await Processor.ProcessAsync();Assert.Equal("suppressed",Rows(a).Single(x=>x.NotificationId==bad).State);Assert.Equal(2,factory.WhatsApp.Sends.Count);
        }finally{Reset();}
    }
    [Theory][InlineData("lost","unknown")][InlineData("malformed","unknown")][InlineData("recipient","unknown")][InlineData("rejected","rejected")][InlineData("held","accepted")]
    public async Task Lost_or_uncertain_acceptance_is_persistent_and_never_automatically_retried(string problem,string expected)
    {
        try{Configure();var a=await Org();await Queue(a,await Notify(a));factory.WhatsApp.SendProblem=problem;await Processor.ProcessAsync();
            Assert.Equal(expected,Assert.Single(Rows(a)).State);Assert.Single(factory.WhatsApp.Sends);await Processor.ProcessAsync();Assert.Single(factory.WhatsApp.Sends);
            if(expected=="unknown"){using var callback=await Status(factory.WhatsApp.Sends.Single());Assert.Equal(HttpStatusCode.OK,callback.StatusCode);Assert.Equal("delivered",Rows(a)[0].State);}
        }finally{Reset();}
    }
    [Fact]
    public async Task Early_signed_callback_survives_late_http_ack_and_statuses_never_regress()
    {
        try{Configure();var a=await Org();await Queue(a,await Notify(a));factory.WhatsApp.BeforeSendResponse=async sent=>{using var callback=await Status(sent,"read");Assert.Equal(HttpStatusCode.OK,callback.StatusCode);};
            await Processor.ProcessAsync();Assert.Equal("read",Rows(a)[0].State);var sent=factory.WhatsApp.Sends.Single();
            using var delivered=await Status(sent);using var failed=await Status(sent,"failed");using var replay=await Status(sent,"read");Assert.Equal("read",Rows(a)[0].State);Assert.Single(factory.WhatsApp.Sends);
        }finally{Reset();}
    }
    [Theory][InlineData("signature")][InlineData("recipient")][InlineData("tag")][InlineData("message")][InlineData("old")][InlineData("future")]
    public async Task Forged_or_unmatched_status_cannot_change_delivery(string mode)
    {
        try{Configure();var a=await Org();await Queue(a,await Notify(a));await Processor.ProcessAsync();var sent=factory.WhatsApp.Sends.Single();
            using var result=await Status(sent,signed:mode!="signature",recipient:mode=="recipient"?"919999999999":null,tag:mode=="tag"?new string('A',74):null,
                id:mode=="message"?"wamid.another":null,timestamp:mode=="old"?DateTimeOffset.UtcNow.AddHours(-1).ToUnixTimeSeconds():mode=="future"?DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeSeconds():null);
            if(mode=="signature")Assert.Equal(HttpStatusCode.Unauthorized,result.StatusCode);else Assert.Equal(HttpStatusCode.OK,result.StatusCode);
            Assert.Equal("accepted",Rows(a)[0].State);
        }finally{Reset();}
    }
    [Theory][InlineData("consent")][InlineData("unlink")][InlineData("disconnect")][InlineData("membership")][InlineData("plan")][InlineData("reassigned")][InlineData("deleted")][InlineData("configuration")][InlineData("gate")]
    public async Task Changes_during_read_preparation_suppress_before_send(string mode)
    {
        try{Configure();var a=await Org();var notification=await Notify(a);await Queue(a,notification);var once=false;
            factory.WhatsApp.BeforeTemplateResponse=async()=>{if(once)return;once=true;
                if(mode=="unlink")Assert.True((await a.Delete("/api/v1/me/whatsapp-contact")).Ok);
                if(mode=="disconnect")Assert.True((await a.Post("/api/v1/integrations/whatsapp/disconnect")).Ok);
                if(mode=="configuration")O.SignupVersion="v3";
                if(mode=="gate")O.DeliveryEnabled=false;
                factory.WithDb(db=>{
                    if(mode=="consent")db.WhatsAppContactLinks.IgnoreQueryFilters().Single(x=>x.TenantId==a.WorkspaceId).NotificationConsentAt=null;
                    if(mode=="membership")db.TenantMembers.Where(x=>x.TenantId==a.WorkspaceId&&x.UserId==a.UserId).ExecuteDelete();
                    if(mode=="plan")db.Subscriptions.Single(x=>x.TenantId==a.WorkspaceId).Status=SubscriptionStatus.Cancelled;
                    var t=db.Tasks.IgnoreQueryFilters().First(x=>x.TenantId==a.WorkspaceId);
                    if(mode=="reassigned")t.AssigneeId=null;if(mode=="deleted")t.IsDeleted=true;db.SaveChanges();return 0;
                });
            };
            await Processor.ProcessAsync();Assert.Empty(factory.WhatsApp.Sends);Assert.Equal("suppressed",Assert.Single(Rows(a)).State);
        }finally{Reset();}
    }
    [Fact]
    public async Task Quiet_hours_and_daily_caps_defer_without_spending_provider_requests()
    {
        try{Configure();var a=await Org();var n=await Notify(a);await Queue(a,n);var minute=DateTime.UtcNow.Hour*60+DateTime.UtcNow.Minute;
            factory.WithDb(db=>{var r=db.WhatsAppContactLinks.IgnoreQueryFilters().Single(x=>x.TenantId==a.WorkspaceId);r.NotificationQuietStartMinutes=minute;r.NotificationQuietEndMinutes=(minute+60)%1440;db.SaveChanges();return 0;});
            factory.WhatsApp.RequestPaths.Clear();await Processor.ProcessAsync();Assert.Empty(factory.WhatsApp.RequestPaths);Assert.Empty(factory.WhatsApp.Sends);Assert.Equal("QUIET_HOURS",Rows(a)[0].Reason);
            factory.WithDb(db=>{var r=db.WhatsAppContactLinks.IgnoreQueryFilters().Single(x=>x.TenantId==a.WorkspaceId);r.NotificationQuietStartMinutes=(minute+60)%1440;r.NotificationQuietEndMinutes=(minute+120)%1440;
                db.WhatsAppDeliveries.IgnoreQueryFilters().Single(x=>x.NotificationId==n).AvailableAt=DateTime.UtcNow.AddSeconds(-1);db.SaveChanges();return 0;});
            await Processor.ProcessAsync();Assert.Single(factory.WhatsApp.Sends);var requests=factory.WhatsApp.RequestPaths.Count;O.DeliveryUserDailyCap=1;var next=await Notify(a);await Queue(a,next);await Processor.ProcessAsync();
            Assert.Single(factory.WhatsApp.Sends);Assert.Equal(requests,factory.WhatsApp.RequestPaths.Count);Assert.Equal("DAILY_DELIVERY_CAP",Rows(a).Single(x=>x.NotificationId==next).Reason);
        }finally{Reset();}
    }
    [Fact]
    public async Task Parallel_processors_and_restart_recovery_preserve_single_send_attempt()
    {
        try{Configure();var a=await Org();var n=await Notify(a);await Queue(a,n);
            factory.WithDb(db=>{var r=db.WhatsAppDeliveries.IgnoreQueryFilters().Single(x=>x.NotificationId==n);r.State="preparing";r.LeaseId=Guid.NewGuid();r.LeaseUntil=DateTime.UtcNow.AddMinutes(-1);db.SaveChanges();return 0;});
            await Task.WhenAll(Processor.ProcessAsync(),Processor.ProcessAsync());Assert.Single(factory.WhatsApp.Sends);Assert.Equal("accepted",Rows(a)[0].State);
            factory.WithDb(db=>{var r=db.WhatsAppDeliveries.IgnoreQueryFilters().Single(x=>x.NotificationId==n);r.State="sending";r.LeaseUntil=DateTime.UtcNow.AddMinutes(-1);db.SaveChanges();return 0;});
            await Processor.ProcessAsync();Assert.Equal("unknown",Rows(a)[0].State);Assert.Single(factory.WhatsApp.Sends);
        }finally{Reset();}
    }
    [Fact]
    public async Task Another_recipient_reuses_current_verified_readiness_in_the_same_organization()
    {
        try{Configure();var a=await Org();var b=await a.AddMemberAsync(factory,TenantRole.Admin);var c=Connection(a);
            var code=await b.Post("/api/v1/me/whatsapp-contact",new{phone="+919876543211",acknowledged=true});Assert.True(code.Ok);
            var body=ProofBody(c,"919876543211",code.Data!["message"]!.GetValue<string>());using var proof=await Webhook(body);Assert.Equal(HttpStatusCode.OK,proof.StatusCode);
            var v=(await b.Get("/api/v1/me/whatsapp-contact/notification-preferences")).Data!["version"]!.GetValue<int>();var minute=DateTime.UtcNow.Hour*60+DateTime.UtcNow.Minute;
            Assert.True((await b.Put("/api/v1/me/whatsapp-contact/notification-preferences",new{version=v,optIn=true,acceptedConsentVersion=WhatsAppContactService.NotificationConsent,taskAssignments=true,overdue=false,supportUpdates=false,timeZone="UTC",quietStartMinutes=(minute+60)%1440,quietEndMinutes=(minute+120)%1440})).Ok);
            await Queue(a,await Notify(a));await Queue(b,await Notify(b));factory.WhatsApp.RequestPaths.Clear();await Processor.ProcessAsync();Assert.Equal(2,factory.WhatsApp.Sends.Count);Assert.Equal(9,factory.WhatsApp.RequestPaths.Count);
        }finally{Reset();}
    }
    [Theory][InlineData("Asia/Kolkata","2026-10-11T17:00:00Z",1320,480,"2026-10-12T02:30:00Z")]
    [InlineData("America/New_York","2026-03-08T06:30:00Z",60,150,"2026-03-08T07:30:00Z")]
    [InlineData("UTC","2026-10-11T13:00:00Z",1320,480,null)]
    public void Quiet_hour_boundaries_follow_iana_time_and_dst(string zone,string now,int start,int end,string? expected)
    {
        var row=new WhatsAppContactLink{NotificationTimeZone=zone,NotificationQuietStartMinutes=start,NotificationQuietEndMinutes=end};
        var result=WhatsAppDeliveryService.QuietUntil(row,DateTime.Parse(now).ToUniversalTime());
        Assert.Equal(expected==null?(DateTime?)null:DateTime.Parse(expected).ToUniversalTime(),result);
    }
    [Fact]
    public async Task Signed_evidence_reconciles_existing_attempt_after_plan_and_token_expiry()
    {
        try{Configure();var a=await Org();await Queue(a,await Notify(a));factory.WhatsApp.SendProblem="lost";await Processor.ProcessAsync();Assert.Equal("unknown",Rows(a)[0].State);
            factory.WithDb(db=>{db.Subscriptions.Single(x=>x.TenantId==a.WorkspaceId).Status=SubscriptionStatus.Cancelled;
                db.WhatsAppConnections.IgnoreQueryFilters().Single(x=>x.TenantId==a.WorkspaceId).TokenExpiresAt=DateTime.UtcNow.AddSeconds(-1);db.SaveChanges();return 0;});
            using var callback=await Status(factory.WhatsApp.Sends.Single());Assert.Equal(HttpStatusCode.OK,callback.StatusCode);Assert.Equal("delivered",Rows(a)[0].State);Assert.Single(factory.WhatsApp.Sends);
        }finally{Reset();}
    }
    [Fact]
    public async Task Cross_workspace_status_tag_is_ignored_even_with_a_valid_app_signature()
    {
        try{Configure();var a=await Org();var b=await Org();await Queue(a,await Notify(a));await Queue(b,await Notify(b));await Processor.ProcessAsync();
            var first=factory.WhatsApp.Sends.Single(x=>x.Business==Connection(a).BusinessAccountId);var other=factory.WhatsApp.Sends.Single(x=>x.Business==Connection(b).BusinessAccountId);
            using var wrong=await Status(other,tag:first.CallbackTag,id:first.MessageId);Assert.Equal(HttpStatusCode.OK,wrong.StatusCode);Assert.Equal("accepted",Rows(a)[0].State);Assert.Equal("accepted",Rows(b)[0].State);
        }finally{Reset();}
    }
    [Fact]
    public async Task Public_support_replies_notify_requesters_once_and_private_notes_do_not()
    {
        try{Configure();var a=await Org();var staff=await a.AddMemberAsync(factory,TenantRole.Admin);
            var type=(await a.Get("/api/v1/work-types")).Data!.AsArray().First()!["id"]!.GetValue<Guid>();
            var ticket=await a.Post("/api/v1/support/tickets",new{title="Private support title",workTypeId=type,priority="Medium",category="IT"});Assert.True(ticket.Ok,ticket.ToString());var id=ticket.Data!["id"]!.GetValue<Guid>();
            Assert.True((await staff.Post($"/api/v1/support/tickets/{id}/messages",new{body="Internal note",visibility="internal",requestKey="internal-fixture"})).Ok);
            await Processor.ProcessAsync();Assert.Empty(factory.WhatsApp.Sends);
            var request=new{body="Reviewed public update",visibility="public",requestKey="public-fixture"};
            Assert.True((await staff.Post($"/api/v1/support/tickets/{id}/messages",request)).Ok);Assert.True((await staff.Post($"/api/v1/support/tickets/{id}/messages",request)).Ok);
            await Processor.ProcessAsync();Assert.Single(factory.WhatsApp.Sends);Assert.Equal("support_update",Assert.Single(Rows(a)).Category);
        }finally{Reset();}
    }
    [Fact]
    public async Task WhatsApp_opt_in_can_keep_a_notification_when_other_channels_are_disabled()
    {
        try{Configure();var a=await Org();var staff=await a.AddMemberAsync(factory,TenantRole.Admin);
            factory.WithDb(db=>{db.NotificationPreferences.Add(new(){UserId=a.UserId,Type=NotificationType.TaskAssigned,InApp=false,Email=false,Browser=false});db.SaveChanges();return 0;});
            var project=await a.CreateProjectAsync();var task=await staff.CreateTaskAsync(project,extra:new{title="Private assignment",priority="Medium",assigneeId=a.UserId});
            await Processor.ProcessAsync();Assert.Single(factory.WhatsApp.Sends);
            var n=factory.WithDb(db=>db.Notifications.IgnoreQueryFilters().Single(x=>x.Id==Rows(a)[0].NotificationId));Assert.False(n.InApp);Assert.False(n.EmailPending);Assert.False(n.Browser);
        }finally{Reset();}
    }
    [Theory][InlineData(false)][InlineData(true)]
    public async Task Current_overdue_task_or_durable_reminder_uses_the_authorized_overdue_template(bool reminder)
    {
        try{Configure();var a=await Org();var n=await Notify(a);
            factory.WithDb(db=>{var t=db.Tasks.IgnoreQueryFilters().Single(x=>x.TenantId==a.WorkspaceId);t.DueDate=DateOnly.FromDateTime(DateTime.UtcNow.AddDays(-2));
                var notification=db.Notifications.IgnoreQueryFilters().Single(x=>x.Id==n);notification.Type=NotificationType.Overdue;
                if(reminder){var r=new Reminder{TenantId=a.WorkspaceId,UserId=a.UserId,Source=ReminderSource.Overdue,State=ReminderState.Fired,TargetType=ReminderTarget.Task,TargetId=t.Id,TargetProjectId=t.ProjectId,TimeZone="UTC"};db.Reminders.Add(r);notification.DedupeKey=$"rem:{r.Id:N}:1";notification.Link="/r/synthetic-link";}
                db.SaveChanges();return 0;});await Queue(a,n);await Processor.ProcessAsync();Assert.Single(factory.WhatsApp.Sends);Assert.Equal("overdue",Rows(a)[0].Category);
        }finally{Reset();}
    }

}
