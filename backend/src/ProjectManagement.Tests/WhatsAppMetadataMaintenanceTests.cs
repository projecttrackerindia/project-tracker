using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Features.Integrations;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Infrastructure.Persistence;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

[Collection("api")]
public class WhatsAppMetadataMaintenanceTests(ApiFactory factory)
{
    private async Task<TestClient> Org()
    {
        var u = await TestClient.RegisterAsync(factory, "Retention fixture");
        await u.CreateOrgAsync();
        factory.WithDb(db => {
            db.WhatsAppConnections.Add(new(){TenantId=u.WorkspaceId,AppId="retention-fixture",BusinessAccountId=Guid.NewGuid().ToString("N"),
                PhoneNumberId=Guid.NewGuid().ToString("N"),AccessTokenProtected="protected-fixture",DisplayName="Idle installation",
                InstalledBy=u.UserId,ConnectedAt=DateTime.UtcNow.AddDays(-60),Active=false});db.SaveChanges();return 0;
        });
        return u;
    }
    private WhatsAppDelivery Seed(TestClient u, string state="unknown", int age=40)
    {
        return factory.WithDb(db => {
            var c=db.WhatsAppConnections.IgnoreQueryFilters().Single(x=>x.TenantId==u.WorkspaceId);
            var row=new WhatsAppDelivery{TenantId=u.WorkspaceId,UserId=u.UserId,NotificationId=Guid.NewGuid(),ConnectionId=c.Id,
                ConnectionConnectedAt=c.ConnectedAt,CallbackTag=Guid.NewGuid().ToString("N"),State=state,
                CreatedAt=DateTime.UtcNow.AddDays(-age),AvailableAt=DateTime.UtcNow,ExpiresAt=DateTime.UtcNow.AddHours(1)};
            db.WhatsAppDeliveries.Add(row);db.SaveChanges();return row;
        });
    }
    private async Task<int> Maintain(TestClient u, DateTime? at=null)
    {
        using var scope=factory.Services.CreateScope();var sp=scope.ServiceProvider;
        sp.GetRequiredService<CurrentContext>().TenantId=u.WorkspaceId;
        var db=sp.GetRequiredService<IAppDbContext>();await using var tx=await db.Database.BeginTransactionAsync();
        await db.LockTenantLedgerAsync(u.WorkspaceId,default);
        var changed=await WhatsAppMetadataMaintenance.MaintainTenantAsync(db,u.WorkspaceId,at??DateTime.UtcNow);
        await tx.CommitAsync();return changed;
    }
    private WhatsAppDelivery? Row(Guid id)=>factory.WithDb(db=>db.WhatsAppDeliveries.IgnoreQueryFilters().AsNoTracking().SingleOrDefault(x=>x.Id==id));
    private void Set(Guid id, Action<WhatsAppDelivery> change)=>factory.WithDb(db=>{var row=db.WhatsAppDeliveries.IgnoreQueryFilters().Single(x=>x.Id==id);change(row);db.SaveChanges();return 0;});

    [Fact]
    public async Task Disabled_inactive_installations_are_cleaned_without_provider_calls_or_token_changes()
    {
        var u=await Org();var old=Seed(u);var recent=Seed(u,age:1);var untouched=await Org();var foreign=Seed(untouched,age:1);
        factory.WithDb(db=>{db.WhatsAppInboundReceipts.Add(new(){TenantId=u.WorkspaceId,AppId="retention-fixture",PhoneNumberId="fixture-phone",
            ProviderMessageId=Guid.NewGuid().ToString("N"),MessageType="text",ProviderCreatedAt=DateTime.UtcNow.AddDays(-40),ReceivedAt=DateTime.UtcNow.AddDays(-40)});db.SaveChanges();return 0;});
        var requests=factory.WhatsApp.RequestPaths.Count;var sends=factory.WhatsApp.Sends.Count;
        Assert.False(factory.Services.GetRequiredService<IOptions<WhatsAppOptions>>().Value.DeliveryEnabled);
        await factory.Services.GetRequiredService<WhatsAppMetadataMaintenance>().RunAsync();
        Assert.Null(Row(old.Id));Assert.NotNull(Row(recent.Id));Assert.NotNull(Row(foreign.Id));
        var installation=factory.WithDb(db=>db.WhatsAppConnections.IgnoreQueryFilters().AsNoTracking().Single(x=>x.TenantId==u.WorkspaceId));
        Assert.False(installation.Active);Assert.Equal("protected-fixture",installation.AccessTokenProtected);Assert.NotNull(installation.RetentionPolledAt);
        Assert.False(factory.WithDb(db=>db.WhatsAppInboundReceipts.IgnoreQueryFilters().Any(x=>x.TenantId==u.WorkspaceId)));
        Assert.Equal(requests,factory.WhatsApp.RequestPaths.Count);Assert.Equal(sends,factory.WhatsApp.Sends.Count);
    }

    [Theory][InlineData("attempt")][InlineData("acceptance")][InlineData("status")][InlineData("decision")]
    public async Task Old_rows_with_recent_evidence_survive_and_expire_only_after_its_full_window(string evidence)
    {
        var u=await Org();var row=Seed(u);var now=DateTime.UtcNow;
        // ExecuteUpdate deliberately sets the persisted historical timestamps without audit-stamping another change.
        factory.WithDb(db=>{var q=db.WhatsAppDeliveries.IgnoreQueryFilters().Where(x=>x.Id==row.Id);
            if(evidence=="attempt")q.ExecuteUpdate(s=>s.SetProperty(x=>x.AttemptedAt,now));
            if(evidence=="acceptance")q.ExecuteUpdate(s=>s.SetProperty(x=>x.AcceptedAt,now));
            if(evidence=="status")q.ExecuteUpdate(s=>s.SetProperty(x=>x.ProviderStatusAt,now));
            if(evidence=="decision")q.ExecuteUpdate(s=>s.SetProperty(x=>x.UpdatedAt,now));return 0;});
        await Maintain(u,now);Assert.NotNull(Row(row.Id));
        await Maintain(u,now.AddDays(30));Assert.NotNull(Row(row.Id));
        await Maintain(u,now.AddDays(30).AddSeconds(1));Assert.Null(Row(row.Id));
    }

    [Fact]
    public async Task Abandoned_reads_recover_expired_notifications_stop_and_persisted_sends_never_replay()
    {
        var u=await Org();var reading=Seed(u,"preparing");var expiredRead=Seed(u,"preparing");var sending=Seed(u,"sending");
        var live=Seed(u,"sending");var queued=Seed(u,"queued");var ambiguous=Seed(u,"preparing");
        foreach(var r in new[]{reading,expiredRead,sending,live,ambiguous})Set(r.Id,x=>{x.LeaseId=Guid.NewGuid();x.LeaseUntil=DateTime.UtcNow.AddMinutes(-1);});
        Set(expiredRead.Id,x=>x.ExpiresAt=DateTime.UtcNow.AddMinutes(-1));Set(queued.Id,x=>x.ExpiresAt=DateTime.UtcNow.AddMinutes(-1));
        Set(sending.Id,x=>x.AttemptedAt=DateTime.UtcNow.AddDays(-40));Set(live.Id,x=>{x.AttemptedAt=DateTime.UtcNow;x.LeaseUntil=DateTime.UtcNow.AddMinutes(5);});
        Set(ambiguous.Id,x=>x.AttemptedAt=DateTime.UtcNow);
        await Maintain(u);
        Assert.Equal("queued",Row(reading.Id)!.State);Assert.Null(Row(reading.Id)!.LeaseId);
        Assert.Equal("suppressed",Row(expiredRead.Id)!.State);Assert.Equal("NOTIFICATION_EXPIRED",Row(queued.Id)!.Reason);
        Assert.Equal("unknown",Row(sending.Id)!.State);Assert.Equal("PROVIDER_OUTCOME_UNKNOWN",Row(sending.Id)!.Reason);
        Assert.NotNull(Row(sending.Id)!.UpdatedAt);Assert.NotNull(Row(sending.Id)!.AttemptedAt);Assert.NotNull(Row(sending.Id)!.LeaseId);
        Assert.Equal("sending",Row(live.Id)!.State);Assert.Equal("preparing",Row(ambiguous.Id)!.State);
        await Maintain(u);Assert.Equal("unknown",Row(sending.Id)!.State);
    }

    [Fact]
    public async Task Tenant_batches_are_bounded_repeatable_and_do_not_remove_foreign_or_inflight_rows()
    {
        var u=await Org();var other=await Org();var foreign=Seed(other);var live=Seed(u,"sending");
        factory.WithDb(db=>{db.WhatsAppDeliveries.AddRange(Enumerable.Range(0,205).Select(_=>new WhatsAppDelivery{TenantId=u.WorkspaceId,
            UserId=u.UserId,NotificationId=Guid.NewGuid(),CallbackTag=Guid.NewGuid().ToString("N"),State="read",CreatedAt=DateTime.UtcNow.AddDays(-40)}));db.SaveChanges();return 0;});
        Assert.Equal(100,await Maintain(u));Assert.NotNull(Row(foreign.Id));Assert.NotNull(Row(live.Id));
        Assert.Equal(100,await Maintain(u));Assert.Equal(5,await Maintain(u));Assert.Equal(0,await Maintain(u));
    }

    [Fact]
    public async Task Concurrent_scopes_share_the_tenant_lock_and_old_delivery_metadata_is_removed_once()
    {
        var u=await Org();var row=Seed(u);var maintenance=factory.Services.GetRequiredService<WhatsAppMetadataMaintenance>();
        await Task.WhenAll(maintenance.RunAsync(),maintenance.RunAsync());Assert.Null(Row(row.Id));
        Assert.NotNull(factory.WithDb(db=>db.WhatsAppConnections.IgnoreQueryFilters().Single(x=>x.TenantId==u.WorkspaceId).RetentionPolledAt));
    }

    [Fact]
    public async Task Pending_rows_and_recent_receipts_survive_bounded_inbound_cleanup()
    {
        var u=await Org();var queued=Seed(u,"queued");var preparing=Seed(u,"preparing");var unrecognized=Seed(u,"future-state");
        var recentId=Guid.NewGuid();
        factory.WithDb(db=>{
            db.WhatsAppInboundReceipts.AddRange(Enumerable.Range(0,205).Select(_=>new WhatsAppInboundReceipt{
                TenantId=u.WorkspaceId,AppId="retention-fixture",PhoneNumberId="fixture-phone",ProviderMessageId=Guid.NewGuid().ToString("N"),
                MessageType="text",ProviderCreatedAt=DateTime.UtcNow.AddDays(-40),ReceivedAt=DateTime.UtcNow.AddDays(-40)}));
            db.WhatsAppInboundReceipts.Add(new(){Id=recentId,TenantId=u.WorkspaceId,AppId="retention-fixture",PhoneNumberId="fixture-phone",
                ProviderMessageId=Guid.NewGuid().ToString("N"),MessageType="text",ProviderCreatedAt=DateTime.UtcNow,ReceivedAt=DateTime.UtcNow});
            db.SaveChanges();return 0;
        });
        Assert.Equal(100,await Maintain(u));Assert.Equal(100,await Maintain(u));Assert.Equal(5,await Maintain(u));
        Assert.NotNull(Row(queued.Id));Assert.NotNull(Row(preparing.Id));Assert.NotNull(Row(unrecognized.Id));
        Assert.True(factory.WithDb(db=>db.WhatsAppInboundReceipts.IgnoreQueryFilters().Any(x=>x.Id==recentId)));
    }

    [Fact]
    public async Task Never_polled_installation_gets_a_turn_and_a_backlog_rotates_between_tenants()
    {
        var organizations=new List<TestClient>();
        for(var i=0;i<11;i++){
            var u=await Org();organizations.Add(u);
            factory.WithDb(db=>{
                db.WhatsAppDeliveries.AddRange(Enumerable.Range(0,105).Select(_=>new WhatsAppDelivery{TenantId=u.WorkspaceId,
                    UserId=u.UserId,NotificationId=Guid.NewGuid(),CallbackTag=Guid.NewGuid().ToString("N"),State="read",CreatedAt=DateTime.UtcNow.AddDays(-40)}));
                db.SaveChanges();return 0;
            });
        }
        var ids=organizations.Take(10).Select(x=>x.WorkspaceId).ToArray();var newcomer=organizations[^1];
        factory.WithDb(db=>{db.WhatsAppConnections.IgnoreQueryFilters().Where(x=>ids.Contains(x.TenantId))
            .ExecuteUpdate(s=>s.SetProperty(x=>x.RetentionPolledAt,DateTime.UtcNow.AddDays(-1)));return 0;});
        var maintenance=factory.Services.GetRequiredService<WhatsAppMetadataMaintenance>();
        await maintenance.RunAsync();
        Assert.NotNull(factory.WithDb(db=>db.WhatsAppConnections.IgnoreQueryFilters().Single(x=>x.TenantId==newcomer.WorkspaceId).RetentionPolledAt));
        // Later passes continue through the remaining installation rather than continually restarting at the first batch.
        await maintenance.RunAsync();await maintenance.RunAsync();
        var all=organizations.Select(x=>x.WorkspaceId).ToArray();
        Assert.False(factory.WithDb(db=>db.WhatsAppDeliveries.IgnoreQueryFilters().Any(x=>all.Contains(x.TenantId))));
    }

    [Fact]
    public async Task Maintenance_requires_a_transaction()
    {
        using var scope=factory.Services.CreateScope();
        await Assert.ThrowsAsync<InvalidOperationException>(()=>WhatsAppMetadataMaintenance.MaintainTenantAsync(
            scope.ServiceProvider.GetRequiredService<IAppDbContext>(),Guid.NewGuid(),DateTime.UtcNow));
    }
}
