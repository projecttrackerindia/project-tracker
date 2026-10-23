using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using NodaTime;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
namespace ProjectManagement.Application.Features.Integrations;

public record WhatsAppSendResult(string State, string? MessageId = null);
public interface IWhatsAppDeliveryProvider
{
    Task<WhatsAppSendResult> SendTemplateAsync(string token, string phoneNumberId, string recipient,
        string category, string callbackTag, CancellationToken ct);
}
public record WhatsAppDeliveryDto(Guid Id, string Category, string State, string? Reason, DateTime CreatedAt,
    DateTime AvailableAt, DateTime? AcceptedAt, DateTime? ProviderStatusAt);
public record WhatsAppDeliverySource(string Category, string Kind, Guid Id, Guid? ProjectId);
public record WhatsAppDeliveryRecipient(WhatsAppConnection Connection, WhatsAppContactLink Contact, string Phone);

/// <summary>Tenant-local admission and fresh recipient authorization. Only fixed template contracts can leave the service.</summary>
public class WhatsAppDeliveryService(IAppDbContext db, CurrentContext ctx, AppClock clock, WhatsAppContactService contacts,
    IOptions<WhatsAppOptions> options, ISecretProtector secrets, PermissionService permissions)
{
    public static bool Enabled(WhatsAppOptions o) => o.DeliveryEnabled && o.InstallationConfigured
        && o.ContactLinkingEnabled && o.WebhookReceptionEnabled && o.HealthChecksEnabled && o.TemplateChecksEnabled;
    public static string Fingerprint(WhatsAppOptions o) => WhatsAppHealthService.ConfigurationFingerprint(o);
    public static string RecipientHash(WhatsAppOptions o, Guid tenant, string phone) => Convert.ToHexString(HMACSHA256.HashData(
        Encoding.UTF8.GetBytes(o.AppSecret!), Encoding.UTF8.GetBytes("contact:v1:" + tenant + ":" + phone)));
    public static WhatsAppDeliverySource? Source(Notification n)
    {
        var category = n.Type switch { NotificationType.TaskAssigned => "task_assignment", NotificationType.Overdue => "overdue", NotificationType.TaskUpdated => "support_update",
            NotificationType.Reminder => "reminder", NotificationType.Approval => "approval", _ => null };
        if (category == null || n.Link is not { Length: > 0 and <= 400 }) return null;
        if (category == "reminder")
        {
            // One person's own reminder that went off (a group of several at once has no single source and is not sent).
            var own = n.DedupeKey is { } k ? Regex.Match(k, @"^rem:([0-9a-fA-F]{32}):[0-9]{1,9}$", RegexOptions.CultureInvariant) : Match.Empty;
            return own.Success && Guid.TryParseExact(own.Groups[1].Value, "N", out var reminder) ? new(category, "personal", reminder, null) : null;
        }
        if (category == "approval")
        {
            var doc = Regex.Match(n.Link, @"^/documents/([0-9a-fA-F-]{36})$", RegexOptions.CultureInvariant);
            if (doc.Success && Guid.TryParseExact(doc.Groups[1].Value, "D", out var document)) return new(category, "document", document, null);
            var week = Regex.Match(n.Link, @"^/timesheet/approvals\?week=\d{4}-\d{2}-\d{2}&review=([0-9a-fA-F-]{36})$", RegexOptions.CultureInvariant);
            if (week.Success && Guid.TryParseExact(week.Groups[1].Value, "D", out var timesheet)) return new(category, "timesheet", timesheet, null);
            return null;
        }
        if (category == "overdue" && n.DedupeKey is { } key)
        {
            var m = Regex.Match(key, @"^rem:([0-9a-fA-F]{32}):[0-9]{1,9}$", RegexOptions.CultureInvariant);
            if (m.Success && Guid.TryParseExact(m.Groups[1].Value, "N", out var rid)) return new(category,"reminder",rid,null);
        }
        var match = Regex.Match(n.Link, @"^/projects/([0-9a-fA-F-]{36})\?task=([0-9a-fA-F-]{36})$", RegexOptions.CultureInvariant);
        if (category != "support_update" && match.Success && Guid.TryParseExact(match.Groups[1].Value,"D",out var project)
            && Guid.TryParseExact(match.Groups[2].Value,"D",out var task)) return new(category,"task",task,project);
        match = Regex.Match(n.Link, @"^/operations\?task=([0-9a-fA-F-]{36})$", RegexOptions.CultureInvariant);
        if (category != "support_update" && match.Success && Guid.TryParseExact(match.Groups[1].Value,"D",out var work)) return new(category,"work",work,null);

        return null;
    }
    private bool Consent(WhatsAppContactLink? r, WhatsAppConnection? c, string category) => r is { VerifiedAt: not null, PhoneHash: not null, PhoneProtected.Length: > 0 }
        && c is { Active: true, AccessTokenProtected.Length: > 0 } && c.AppId == options.Value.AppId
        && (c.TokenExpiresAt == null || c.TokenExpiresAt > clock.Now)
        && r.ConnectionId == c.Id && r.ConnectionConnectedAt == c.ConnectedAt
        && r.ConfigurationHash == Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(options.Value.AppId + "|" + options.Value.AppSecret)))
        && r.VerifiedAt > clock.Now.AddDays(-30) && r.VerifiedAt <= clock.Now && r.ConsentVersion == WhatsAppContactService.Consent && r.ConsentAt != null
        && r.NotificationConsentVersion == WhatsAppContactService.NotificationConsent && r.NotificationConsentAt <= clock.Now
        && r.NotificationConsentExpiresAt > clock.Now && r.NotificationConsentExpiresAt <= r.VerifiedAt.Value.AddDays(30)
        && (category switch { "task_assignment" => r.NotifyTaskAssignments, "overdue" => r.NotifyOverdue, "support_update" => r.NotifySupportUpdates,
            "reminder" => r.NotifyReminders, "approval" => r.NotifyApprovals, _ => false });
    public async Task<bool> HasIntentAsync(Notification n, CancellationToken ct)
    {
        if (!Enabled(options.Value) || Source(n) is not { } source) return false;
        var r = await db.WhatsAppContactLinks.AsNoTracking().SingleOrDefaultAsync(x=>x.TenantId==n.TenantId&&x.UserId==n.UserId,ct);
        var c = await db.WhatsAppConnections.AsNoTracking().SingleOrDefaultAsync(x=>x.TenantId==n.TenantId,ct);
        return Consent(r,c,source.Category) && await contacts.EligibleAsync(n.TenantId,ct);
    }
    public async Task QueueAsync(Notification n, CancellationToken ct)
    {
        if (!Enabled(options.Value) || Source(n) is not { } source) return;
        var tenant = ctx.RequireTenantId(); if (n.TenantId!=tenant) return;
        await using var tx = await db.Database.BeginTransactionAsync(ct); await db.LockTenantLedgerAsync(tenant,ct);
        if (await db.WhatsAppDeliveries.AnyAsync(x=>x.NotificationId==n.Id,ct)) return;
        var c = await db.WhatsAppConnections.AsNoTracking().SingleOrDefaultAsync(x=>x.TenantId==tenant,ct);
        var r = await db.WhatsAppContactLinks.AsNoTracking().SingleOrDefaultAsync(x=>x.UserId==n.UserId,ct);
        if (!Consent(r,c,source.Category) || n.CreatedAt < r!.NotificationConsentAt || n.CreatedAt < c!.ConnectedAt
            || n.CreatedAt < clock.Now.AddHours(-24) || n.CreatedAt > clock.Now || !await contacts.EligibleAsync(tenant,ct)) return;
        if (await db.WhatsAppDeliveries.CountAsync(ct)>=10000) return;
        var delivery = new WhatsAppDelivery { TenantId=tenant,UserId=n.UserId,NotificationId=n.Id,ConnectionId=c.Id,
            ConnectionConnectedAt=c.ConnectedAt,ContactId=r.Id,PreferencesVersion=r.NotificationPreferencesVersion,
            ConfigurationHash=Fingerprint(options.Value),Category=source.Category,ResourceKind=source.Kind,ResourceId=source.Id,
            ResourceProjectId=source.ProjectId,AvailableAt=clock.Now,ExpiresAt=n.CreatedAt.AddHours(24),CreatedAt=clock.Now };
        delivery.CallbackTag = "pt-wa-v1:" + delivery.Id.ToString("N") + ":" + Convert.ToHexString(RandomNumberGenerator.GetBytes(16));
        db.WhatsAppDeliveries.Add(delivery);await db.SaveChangesAsync(ct);await tx.CommitAsync(ct);
    }
    public async Task<WhatsAppDeliveryRecipient?> RecipientAsync(WhatsAppDelivery row, CancellationToken ct)
    {
        if (!Enabled(options.Value) || row.TenantId!=ctx.TenantId || row.UserId!=ctx.UserId || row.ConfigurationHash!=Fingerprint(options.Value)
            || row.ExpiresAt<=clock.Now || !await contacts.EligibleAsync(row.TenantId,ct)
            || !await db.Users.AnyAsync(x=>x.Id==row.UserId&&x.IsActive&&!x.MustChangePassword,ct)
            || !await db.TenantMembers.AnyAsync(x=>x.TenantId==row.TenantId&&x.UserId==row.UserId,ct)
            || !await db.Tenants.AnyAsync(x=>x.Id==row.TenantId&&x.Type==WorkspaceType.Organization&&x.Status==TenantStatus.Active,ct)) return null;
        var n=await db.Notifications.AsNoTracking().SingleOrDefaultAsync(x=>x.Id==row.NotificationId&&x.UserId==row.UserId,ct);
        if(n==null || Source(n)!=new WhatsAppDeliverySource(row.Category,row.ResourceKind,row.ResourceId,row.ResourceProjectId)) return null;
        var c=await db.WhatsAppConnections.AsNoTracking().SingleOrDefaultAsync(x=>x.Id==row.ConnectionId,ct);
        var r=await db.WhatsAppContactLinks.AsNoTracking().SingleOrDefaultAsync(x=>x.Id==row.ContactId&&x.UserId==row.UserId,ct);
        if(!Consent(r,c,row.Category)||r!.NotificationPreferencesVersion!=row.PreferencesVersion||c!.ConnectedAt!=row.ConnectionConnectedAt
            ||n.CreatedAt<r.NotificationConsentAt||n.CreatedAt<c.ConnectedAt) return null;
        if(!await ResourceAsync(row.ResourceKind,row.ResourceId,row.ResourceProjectId,row.Category,r.NotificationTimeZone,ct)) return null;
        string phone;
        try {phone=secrets.Unprotect(r.PhoneProtected);}catch(CryptographicException){return null;}
        if(!WhatsAppContactService.PhoneDigits(phone)||RecipientHash(options.Value,row.TenantId,phone)!=r.PhoneHash) return null;
        return new(c,r,phone);
    }
    private async Task<bool> ResourceAsync(string kind,Guid id,Guid? project,string category,string? zoneId,CancellationToken ct)
    {
        var uid=ctx.RequireUserId();var zone=DateTimeZoneProviders.Tzdb.GetZoneOrNull(zoneId??"");if(zone==null)return false;
        var today=DateOnly.FromDateTime(Instant.FromDateTimeUtc(DateTime.SpecifyKind(clock.Now,DateTimeKind.Utc)).InZone(zone).LocalDateTime.ToDateTimeUnspecified());
        if(kind=="personal")
        {
            // Still the person's own reminder, and it is the one that went off (not done, dismissed or moved since).
            var mine=await db.Reminders.AsNoTracking().SingleOrDefaultAsync(x=>x.Id==id&&x.UserId==uid,ct);
            return mine is {Source:ReminderSource.Personal,State:ReminderState.Fired};
        }
        if(kind=="document")
        {
            // Only while the person still has a decision to make on it.
            var a=await db.DocumentApprovals.AsNoTracking().FirstOrDefaultAsync(x=>x.DocumentId==id&&x.State==ApprovalState.Pending,ct);
            if(a is null||a.SubmittedBy==uid)return false;
            var steps=ProjectManagement.Application.Features.Documents.DocumentWorkflowService.Approvers(a);
            return a.CurrentStep<steps.Count&&steps[a.CurrentStep].Contains(uid)
                &&!await db.ApprovalDecisions.AnyAsync(x=>x.ApprovalId==a.Id&&x.StepIndex==a.CurrentStep&&x.UserId==uid,ct);
        }
        if(kind=="timesheet")
        {
            var w=await db.TimesheetApprovals.AsNoTracking().SingleOrDefaultAsync(x=>x.Id==id,ct);
            return w is {Status:TimesheetStatus.Submitted}&&w.UserId!=uid;
        }
        if(kind=="reminder")
        {
            var r=await db.Reminders.AsNoTracking().SingleOrDefaultAsync(x=>x.Id==id&&x.UserId==uid,ct);
            if(r?.TargetId is not {} target||r.Source!=ReminderSource.Overdue||r.State!=ReminderState.Fired)return false;
            return r.TargetType switch {ReminderTarget.Task=>await ResourceAsync("task",target,r.TargetProjectId,category,zoneId,ct),
                ReminderTarget.Operational=>await ResourceAsync("work",target,null,category,zoneId,ct),_=>false};
        }
        if(kind=="task")
        {
            await permissions.RequireModuleAsync(Modules.Tasks,AccessLevel.View,ct);
            var t=await db.Tasks.AsNoTracking().Include(x=>x.Status).SingleOrDefaultAsync(x=>x.Id==id&&x.ProjectId==project,ct);
            return t!=null&&await db.Projects.AnyAsync(x=>x.Id==t.ProjectId,ct)&&t.AssigneeId==uid&&t.Status!=null&&t.Status.Category is not (StatusCategory.Done or StatusCategory.Cancelled)
                && (category!="overdue"||t.DueDate<today);
        }
        await permissions.RequireModuleAsync(Modules.Work,AccessLevel.View,ct);
        if(kind=="work")
        {
            var w=await db.WorkTasks.AsNoTracking().SingleOrDefaultAsync(x=>x.Id==id&&x.Kind==WorkTaskKind.Operational,ct);
            return w!=null&&w.AssigneeId==uid&&w.Status is not (WorkTaskStatus.Completed or WorkTaskStatus.Cancelled)
                && (category!="overdue"||w.DueDate<today);
        }
        return false;
    }
    public static DateTime? QuietUntil(WhatsAppContactLink r,DateTime utc)
    {
        var zone=DateTimeZoneProviders.Tzdb.GetZoneOrNull(r.NotificationTimeZone??"");
        if(zone==null||r.NotificationQuietStartMinutes is <0 or >1439||r.NotificationQuietEndMinutes is <0 or >1439
            ||r.NotificationQuietStartMinutes==r.NotificationQuietEndMinutes) throw new ConflictException("Quiet-hour settings need review.","WHATSAPP_QUIET_INVALID");
        var local=Instant.FromDateTimeUtc(DateTime.SpecifyKind(utc,DateTimeKind.Utc)).InZone(zone);var minute=local.Hour*60+local.Minute;
        var start=r.NotificationQuietStartMinutes;var end=r.NotificationQuietEndMinutes;
        if(!(start<end ? minute>=start&&minute<end : minute>=start||minute<end))return null;
        var date=local.Date.PlusDays(start>end&&minute>=start?1:0);
        var result=zone.AtLeniently(date.At(new LocalTime(end/60,end%60))).ToInstant().ToDateTimeUtc();
        return result>utc?result:utc.AddMinutes(1); // Conservative handling of a repeated DST boundary.
    }
    public async Task<IReadOnlyList<WhatsAppDeliveryDto>> ListAsync(bool administrator,CancellationToken ct)
    {
        if(administrator)
        {
            var u=ctx.RequireUserId();var t=ctx.RequireTenantId();
            if(!await db.TenantMembers.AnyAsync(x=>x.TenantId==t&&x.UserId==u&&(x.Role==TenantRole.Admin||x.Role==TenantRole.Owner),ct)
                ||!await db.Users.AnyAsync(x=>x.Id==u&&x.IsActive&&!x.MustChangePassword,ct))throw new ForbiddenException("Only an organization administrator can review delivery.");
        }
        else if(!await db.TenantMembers.AnyAsync(x=>x.TenantId==ctx.TenantId&&x.UserId==ctx.UserId,ct))throw new ForbiddenException("Organization membership is required.");
        return await db.WhatsAppDeliveries.AsNoTracking().Where(x=>(administrator||x.UserId==ctx.UserId)&&x.CreatedAt>=clock.Now.AddDays(-30))
            .OrderByDescending(x=>x.CreatedAt).ThenByDescending(x=>x.Id).Take(50)
            .Select(x=>new WhatsAppDeliveryDto(x.Id,x.Category,x.State,x.Reason,x.CreatedAt,x.AvailableAt,x.AcceptedAt,x.ProviderStatusAt)).ToListAsync(ct);
    }
}
