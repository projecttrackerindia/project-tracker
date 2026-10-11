using System.Security.Cryptography;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
namespace ProjectManagement.Application.Features.Integrations;

/// <summary>Bounded organization-fair polling. Read preparation is replayable; a persisted send attempt is never automatically repeated.</summary>
public class WhatsAppDeliveryProcessor(IServiceScopeFactory scopes, IOptions<WhatsAppOptions> options, TimeProvider time)
{
    private DateTime Now => time.GetUtcNow().UtcDateTime;
    public async Task<int> ProcessAsync(CancellationToken ct = default)
    {
        if (!WhatsAppDeliveryService.Enabled(options.Value)) return 0;
        List<Guid> tenants;
        using (var scan = scopes.CreateScope())
        {
            var db = scan.ServiceProvider.GetRequiredService<IAppDbContext>(); var now = Now;
            // Cross-tenant scheduling returns only installation tenant IDs. Predicates examine routing/consent metadata, never message contents.
            tenants = await db.WhatsAppConnections.IgnoreQueryFilters().AsNoTracking()
                .Where(x => x.AppId == options.Value.AppId && (
                    db.WhatsAppDeliveries.IgnoreQueryFilters().Any(d=>d.TenantId==x.TenantId&&
                        ((d.State=="queued"&&d.AvailableAt<=now)||(d.State=="preparing"||d.State=="sending")&&d.LeaseUntil<=now))
                    ||x.Active&&db.Notifications.IgnoreQueryFilters().Any(n=>n.TenantId==x.TenantId&&n.CreatedAt>=now.AddHours(-24)
                        &&(n.Type==NotificationType.TaskAssigned||n.Type==NotificationType.Overdue||n.Type==NotificationType.TaskUpdated&&n.Link!=null&&n.Link.StartsWith("/support?ticket="))
                        &&!db.WhatsAppDeliveries.IgnoreQueryFilters().Any(d=>d.TenantId==n.TenantId&&d.NotificationId==n.Id)
                        &&db.WhatsAppContactLinks.IgnoreQueryFilters().Any(r=>r.TenantId==n.TenantId&&r.UserId==n.UserId
                            &&r.NotificationConsentAt<=n.CreatedAt&&r.NotificationConsentExpiresAt>now))))
                // Explicitly put never-polled organizations first on both PostgreSQL and SQLite.
                .OrderBy(x => x.DeliveryPolledAt != null).ThenBy(x => x.DeliveryPolledAt).ThenBy(x => x.TenantId).Select(x => x.TenantId).Take(10).ToListAsync(ct);
        }
        var decisions = 0;
        await Parallel.ForEachAsync(tenants, new ParallelOptions { MaxDegreeOfParallelism = 4, CancellationToken = ct }, async (tenant, cancellation) =>
        {
            var ids = await PollAsync(tenant, cancellation);
            foreach (var id in ids) { await DispatchAsync(tenant, id, cancellation); Interlocked.Increment(ref decisions); }
        });
        return decisions;
    }
    private async Task<List<Guid>> PollAsync(Guid tenant, CancellationToken ct)
    {
        using var scope = scopes.CreateScope(); var sp = scope.ServiceProvider;
        sp.GetRequiredService<CurrentContext>().TenantId = tenant; var db = sp.GetRequiredService<IAppDbContext>(); var now = Now;
        await using (var tx = await db.Database.BeginTransactionAsync(ct))
        {
            await db.LockTenantLedgerAsync(tenant, ct);
            await db.WhatsAppConnections.Where(x => x.TenantId == tenant).ExecuteUpdateAsync(s => s.SetProperty(x => x.DeliveryPolledAt, now), ct);
            await db.WhatsAppDeliveries.Where(x => x.State == "preparing" && x.LeaseUntil <= now && x.AttemptedAt == null)
                .ExecuteUpdateAsync(s => s.SetProperty(x => x.State, "queued").SetProperty(x => x.AvailableAt, now)
                    .SetProperty(x => x.LeaseId, (Guid?)null).SetProperty(x => x.LeaseUntil, (DateTime?)null), ct);
            await db.WhatsAppDeliveries.Where(x => x.State == "sending" && x.LeaseUntil <= now)
                .ExecuteUpdateAsync(s => s.SetProperty(x => x.State, "unknown").SetProperty(x => x.Reason, "PROVIDER_OUTCOME_UNKNOWN")
                    .SetProperty(x => x.LeaseUntil, (DateTime?)null), ct);
            await db.WhatsAppDeliveries.Where(x => x.State == "queued" && x.ExpiresAt <= now)
                .ExecuteUpdateAsync(s => s.SetProperty(x => x.State, "suppressed").SetProperty(x => x.Reason, "NOTIFICATION_EXPIRED"), ct);
            // Bounded retention; unresolved recent attempts survive restarts and are never replayed.
            await db.WhatsAppDeliveries.Where(x => x.CreatedAt < now.AddDays(-30) && x.State != "sending" && x.State != "preparing")
                .OrderBy(x => x.CreatedAt).Take(100).ExecuteDeleteAsync(ct);
            await tx.CommitAsync(ct);
        }
        var notifications = await (from n in db.Notifications.AsNoTracking()
            join r in db.WhatsAppContactLinks.AsNoTracking() on new { n.TenantId, n.UserId } equals new { r.TenantId, r.UserId }
            where n.CreatedAt >= now.AddHours(-24) && n.CreatedAt >= r.NotificationConsentAt && r.NotificationConsentExpiresAt > now
                && (n.Type == NotificationType.TaskAssigned && r.NotifyTaskAssignments || n.Type == NotificationType.Overdue && r.NotifyOverdue
                    || n.Type == NotificationType.TaskUpdated && r.NotifySupportUpdates && n.Link != null && n.Link.StartsWith("/support?ticket="))
                && !db.WhatsAppDeliveries.Any(x => x.NotificationId == n.Id)
            orderby n.CreatedAt, n.Id select n).Take(25).ToListAsync(ct);
        var service = sp.GetRequiredService<WhatsAppDeliveryService>();
        foreach (var notification in notifications) await service.QueueAsync(notification, ct);
        return await db.WhatsAppDeliveries.AsNoTracking().Where(x => x.State == "queued" && x.AvailableAt <= Now)
            .OrderBy(x => x.AvailableAt).ThenBy(x => x.CreatedAt).Select(x => x.Id).Take(5).ToListAsync(ct);
    }
    private static async Task Decision(IAppDbContext db, WhatsAppDelivery row, string state, string reason, DateTime? next, CancellationToken ct)
    {
        row.State = state; row.Reason = reason; row.LeaseId = null; row.LeaseUntil = null;
        if (next != null) row.AvailableAt = next.Value;
        await db.SaveChangesAsync(ct);
    }
    private static bool CachedReady(WhatsAppConnection c,WhatsAppOptions o,string category,DateTime now) => c.HealthState=="verified"
        &&c.HealthCheckedAt>now.AddMinutes(-5)&&c.HealthCheckedAt<=now&&c.HealthConfigurationHash==WhatsAppDeliveryService.Fingerprint(o)
        &&c.HealthTokenValid==true&&c.HealthScopesPresent==true&&c.HealthAssetsVerified==true&&c.HealthAppSubscribed==true&&c.HealthPhoneVerified==true
        &&c.TemplatesCheckedAt>now.AddMinutes(-5)&&c.TemplatesCheckedAt<=now&&c.TemplatesConfigurationHash==WhatsAppTemplateService.ConfigurationFingerprint(o)
        &&(c.TemplatesState is "verified" or "attention")
        &&(category switch {"task_assignment"=>c.TaskAssignmentTemplateState,"overdue"=>c.OverdueTemplateState,"support_update"=>c.SupportUpdateTemplateState,_=>null})=="approved";
    private async Task<bool> DeferAsync(IAppDbContext db,WhatsAppDelivery row,WhatsAppContactLink contact,CancellationToken ct)
    {
        DateTime? quiet;
        try{quiet=WhatsAppDeliveryService.QuietUntil(contact,Now);}
        catch(AppException){await Decision(db,row,"suppressed","QUIET_HOURS_INVALID",null,ct);return true;}
        if(quiet!=null){await Decision(db,row,"queued","QUIET_HOURS",quiet,ct);return true;}
        var since=Now.AddDays(-1);var attempts=db.WhatsAppDeliveries.AsNoTracking().Where(x=>x.AttemptedAt>=since);
        var userAttempts=attempts.Where(x=>x.UserId==row.UserId);
        var userFull=await userAttempts.CountAsync(ct)>=Math.Clamp(options.Value.DeliveryUserDailyCap,1,100);
        var orgFull=await attempts.CountAsync(ct)>=Math.Clamp(options.Value.DeliveryOrganizationDailyCap,1,10000);
        if(userFull||orgFull)
        {
            var oldest=await (userFull?userAttempts:attempts).MinAsync(x=>x.AttemptedAt,ct);
            await Decision(db,row,"queued","DAILY_DELIVERY_CAP",oldest!.Value.AddDays(1).AddSeconds(1),ct);return true;
        }
        var last=await userAttempts.MaxAsync(x=>x.AttemptedAt,ct);
        if(last>Now.AddMinutes(-1)){await Decision(db,row,"queued","RECIPIENT_COOLDOWN",last.Value.AddMinutes(1),ct);return true;}
        return false;
    }
    private async Task DispatchAsync(Guid tenant, Guid id, CancellationToken ct)
    {
        var lease = Guid.NewGuid(); WhatsAppDelivery snapshot; WhatsAppDeliveryRecipient before; bool cachedReady;
        using (var claimScope = scopes.CreateScope())
        {
            var sp = claimScope.ServiceProvider; var context = sp.GetRequiredService<CurrentContext>(); context.TenantId = tenant;
            var db = sp.GetRequiredService<IAppDbContext>(); await using var tx = await db.Database.BeginTransactionAsync(ct);
            await db.LockTenantLedgerAsync(tenant, ct);
            var row = await db.WhatsAppDeliveries.SingleOrDefaultAsync(x => x.Id == id && x.State == "queued" && x.AvailableAt <= Now, ct);
            if (row == null) return;
            try
            {
                await WorkspaceExecutionPrincipal.ConfigureAsync(sp, row.UserId, tenant, null, ct);
                before = await sp.GetRequiredService<WhatsAppDeliveryService>().RecipientAsync(row, ct)
                    ?? throw new ForbiddenException("Notification recipient access or consent changed.");
            }
            catch (AppException) { await Decision(db,row,"suppressed","RECIPIENT_NOT_AUTHORIZED",null,ct);await tx.CommitAsync(ct);return; }
            catch (CryptographicException) { await Decision(db,row,"suppressed","RECIPIENT_NOT_AUTHORIZED",null,ct);await tx.CommitAsync(ct);return; }
            if(await DeferAsync(db,row,before.Contact,ct)){await tx.CommitAsync(ct);return;}
            if (row.PreparationAttempts >= 5) { await Decision(db,row,"suppressed","PROVIDER_READINESS_FAILED",null,ct);await tx.CommitAsync(ct);return; }
            cachedReady=CachedReady(before.Connection,options.Value,row.Category,Now);
            if(!cachedReady)
            {
                var c=await db.WhatsAppConnections.SingleAsync(x=>x.Id==before.Connection.Id,ct);
                var wait=c.HealthLeaseUntil>Now||c.TemplatesLeaseUntil>Now;
                if(wait||c.HealthAttemptedAt>Now.AddMinutes(-1)||c.TemplatesAttemptedAt>Now.AddMinutes(-1))
                {await Decision(db,row,"queued","PROVIDER_CHECK_COOLDOWN",Now.AddSeconds(15),ct);await tx.CommitAsync(ct);return;}
                c.HealthLeaseId=lease;c.TemplatesLeaseId=lease;c.HealthLeaseUntil=Now.AddSeconds(90);c.TemplatesLeaseUntil=Now.AddSeconds(90);
                c.HealthAttemptedAt=Now;c.TemplatesAttemptedAt=Now;c.HealthState="checking";c.TemplatesState="checking";
            }
            row.State = "preparing"; row.LeaseId = lease; row.LeaseUntil = Now.AddSeconds(90); row.PreparationAttempts++;
            await db.SaveChangesAsync(ct); await tx.CommitAsync(ct); snapshot = row;
        }
        bool ready = cachedReady; WhatsAppProviderHealth? healthResult=null; WhatsAppProviderTemplates? templateResult=null;
        try
        {
            if(!cachedReady)
            {
            using var preflight = scopes.CreateScope(); var sp = preflight.ServiceProvider;
            var token = sp.GetRequiredService<ISecretProtector>().Unprotect(before.Connection.AccessTokenProtected);
            var health = healthResult = await sp.GetRequiredService<IWhatsAppHealthProvider>().InspectAsync(token,before.Connection.BusinessAccountId,before.Connection.PhoneNumberId,ct);
            if (health.TokenValid == true && health.ScopesPresent == true && health.AssetsVerified == true && health.AppSubscribed == true
                && health.PhoneVerified == true && (health.TokenExpiresAt == null || health.TokenExpiresAt > Now))
            {
                var templates = templateResult = await sp.GetRequiredService<IWhatsAppTemplateProvider>().InspectTemplatesAsync(token,before.Connection.BusinessAccountId,ct);
                ready = (snapshot.Category switch { "task_assignment" => templates.TaskAssignment, "overdue" => templates.Overdue, "support_update" => templates.SupportUpdate, _ => null }) == "approved";
            }
            }
        }
        catch (AppException) { }
        catch (CryptographicException) { }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { return; } // Read-only claim can safely expire back to queued.
        WhatsAppDeliveryRecipient recipient;
        using (var finalScope = scopes.CreateScope())
        {
            var sp = finalScope.ServiceProvider; sp.GetRequiredService<CurrentContext>().TenantId = tenant;
            var db = sp.GetRequiredService<IAppDbContext>(); await using var tx = await db.Database.BeginTransactionAsync(ct);
            await db.LockTenantLedgerAsync(tenant,ct);
            var row = await db.WhatsAppDeliveries.SingleOrDefaultAsync(x=>x.Id==id&&x.State=="preparing"&&x.LeaseId==lease&&x.LeaseUntil>Now,ct);
            if(row==null)return;
            try
            {
                await WorkspaceExecutionPrincipal.ConfigureAsync(sp,row.UserId,tenant,null,ct);
                recipient=await sp.GetRequiredService<WhatsAppDeliveryService>().RecipientAsync(row,ct)
                    ?? throw new ForbiddenException("Notification recipient access or consent changed.");
                if(recipient.Connection.AccessTokenProtected!=before.Connection.AccessTokenProtected||recipient.Phone!=before.Phone)
                    throw new ForbiddenException("The connection or recipient changed.");
            }
            catch(AppException){await Decision(db,row,"suppressed","RECIPIENT_NOT_AUTHORIZED",null,ct);await tx.CommitAsync(ct);return;}
            var currentConnection=await db.WhatsAppConnections.SingleAsync(x=>x.Id==row.ConnectionId,ct);
            if(cachedReady)
            {
                if(!CachedReady(currentConnection,options.Value,row.Category,Now))
                {await Decision(db,row,"queued","PROVIDER_CHECK_CHANGED",Now.AddSeconds(15),ct);await tx.CommitAsync(ct);return;}
            }
            else
            {
                if(currentConnection.HealthLeaseId!=lease||currentConnection.TemplatesLeaseId!=lease
                    ||currentConnection.HealthLeaseUntil<=Now||currentConnection.TemplatesLeaseUntil<=Now)
                {await Decision(db,row,"queued","PROVIDER_CHECK_CHANGED",Now.AddSeconds(15),ct);await tx.CommitAsync(ct);return;}
                currentConnection.HealthCheckedAt=Now;currentConnection.HealthConfigurationHash=WhatsAppDeliveryService.Fingerprint(options.Value);
                currentConnection.HealthTokenValid=healthResult?.TokenValid;currentConnection.HealthScopesPresent=healthResult?.ScopesPresent;
                currentConnection.HealthAssetsVerified=healthResult?.AssetsVerified;currentConnection.HealthAppSubscribed=healthResult?.AppSubscribed;
                currentConnection.HealthPhoneVerified=healthResult?.PhoneVerified;
                currentConnection.HealthState=healthResult?.TokenValid==null?"unavailable":healthResult.TokenValid==true&&healthResult.ScopesPresent==true
                    &&healthResult.AssetsVerified==true&&healthResult.AppSubscribed==true&&healthResult.PhoneVerified==true?"verified":"attention";
                currentConnection.TemplatesCheckedAt=Now;currentConnection.TemplatesConfigurationHash=WhatsAppTemplateService.ConfigurationFingerprint(options.Value);
                currentConnection.TaskAssignmentTemplateState=templateResult?.TaskAssignment??"unavailable";
                currentConnection.OverdueTemplateState=templateResult?.Overdue??"unavailable";currentConnection.SupportUpdateTemplateState=templateResult?.SupportUpdate??"unavailable";
                currentConnection.TemplatesState=templateResult==null?"unavailable":templateResult.TaskAssignment=="approved"&&templateResult.Overdue=="approved"&&templateResult.SupportUpdate=="approved"?"verified":"attention";
                currentConnection.HealthLeaseId=null;currentConnection.HealthLeaseUntil=null;currentConnection.TemplatesLeaseId=null;currentConnection.TemplatesLeaseUntil=null;
                if(healthResult?.TokenValid==true&&healthResult.TokenExpiresAt is {} expiry&&(currentConnection.TokenExpiresAt==null||expiry<currentConnection.TokenExpiresAt))currentConnection.TokenExpiresAt=expiry;
            }
            if(!ready){await Decision(db,row,"queued","PROVIDER_NOT_READY",Now.AddMinutes(Math.Min(15,row.PreparationAttempts*2)),ct);await tx.CommitAsync(ct);return;}
            if(await DeferAsync(db,row,recipient.Contact,ct)){row.PreparationAttempts--;await db.SaveChangesAsync(ct);await tx.CommitAsync(ct);return;}
            // Commit the single send attempt before HTTP. Crashed/uncertain attempts can only reconcile, never auto-retry.
            row.State="sending";row.Reason=null;row.AttemptedAt=Now;row.LeaseUntil=Now.AddSeconds(90);row.RecipientHash=recipient.Contact.PhoneHash;
            sp.GetRequiredService<Recorder>().Audit("whatsapp.delivery.attempted","WhatsAppDelivery",row.Id);
            await db.SaveChangesAsync(ct);await tx.CommitAsync(ct);
        }
        WhatsAppSendResult result;
        try
        {
            using var sending=scopes.CreateScope();var sp=sending.ServiceProvider;
            result=await sp.GetRequiredService<IWhatsAppDeliveryProvider>().SendTemplateAsync(
                sp.GetRequiredService<ISecretProtector>().Unprotect(recipient.Connection.AccessTokenProtected),recipient.Connection.PhoneNumberId,
                recipient.Phone,snapshot.Category,snapshot.CallbackTag,ct);
        }
        catch(Exception ex)when(ex is not OutOfMemoryException){result=new("unknown");}
        // Record evidence even when the caller cancelled after HTTP; a restart can also recover this persisted attempt.
        using var finishTimeout=new CancellationTokenSource(TimeSpan.FromSeconds(5));var finishCt=finishTimeout.Token;
        using var finishScope=scopes.CreateScope();var finishSp=finishScope.ServiceProvider;finishSp.GetRequiredService<CurrentContext>().TenantId=tenant;
        var finishDb=finishSp.GetRequiredService<IAppDbContext>();await using var finish=await finishDb.Database.BeginTransactionAsync(finishCt);
        await finishDb.LockTenantLedgerAsync(tenant,finishCt);
        var current=await finishDb.WhatsAppDeliveries.SingleOrDefaultAsync(x=>x.Id==id&&x.LeaseId==lease&&x.AttemptedAt!=null,finishCt);
        if(current==null)return;
        if(result.State=="accepted"&&result.MessageId!=null)
        {
            if(current.ProviderMessageId==null||current.ProviderMessageId==result.MessageId)
            {
                current.ProviderMessageId=result.MessageId;current.AcceptedAt??=Now;
                if(current.State is "sending" or "unknown") {current.State="accepted";current.Reason=null;}
            }
            else current.Reason="PROVIDER_ACK_MISMATCH";
        }
        else if(current.State=="sending"){current.State=result.State=="rejected"?"rejected":"unknown";current.Reason=current.State=="rejected"?"PROVIDER_REJECTED":"PROVIDER_OUTCOME_UNKNOWN";}
        current.LeaseUntil=null;
        finishSp.GetRequiredService<Recorder>().Audit("whatsapp.delivery.recorded","WhatsAppDelivery",current.Id,null,new{current.State});
        await finishDb.SaveChangesAsync(finishCt);await finish.CommitAsync(finishCt);
    }
}
