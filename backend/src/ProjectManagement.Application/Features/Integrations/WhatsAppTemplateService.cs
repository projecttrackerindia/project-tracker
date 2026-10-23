using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
namespace ProjectManagement.Application.Features.Integrations;

public record WhatsAppTemplateDefinition(string Key, string Name, string Language, string Category, string Body);
public record WhatsAppTemplateItem(string Key, string Name, string Language, string Category, string Body, string State);
public record WhatsAppTemplateStatus(bool CheckEnabled, string State, DateTimeOffset? CheckedAt,
    IReadOnlyList<WhatsAppTemplateItem> Templates, string Policy = "approved_utility_templates_only", bool MessagingEnabled = false);
public record WhatsAppProviderTemplates(string TaskAssignment, string Overdue, string SupportUpdate, string Reminder = "unavailable", string Approval = "unavailable")
{
    public static WhatsAppProviderTemplates Unavailable { get; } = new("unavailable", "unavailable", "unavailable", "unavailable", "unavailable");
    /// <summary>In the order of <see cref="WhatsAppTemplateService.Definitions"/>.</summary>
    public string[] All => [TaskAssignment, Overdue, SupportUpdate, Reminder, Approval];
    /// <summary>verified when every template is approved, attention when some are not (the approved ones still deliver), unavailable when Meta could not be asked.</summary>
    public string Overall => All.Any(x => x == "unavailable") ? "unavailable" : All.All(x => x == "approved") ? "verified" : "attention";
    public string? Of(string category) => category switch
    {
        "task_assignment" => TaskAssignment, "overdue" => Overdue, "support_update" => SupportUpdate, "reminder" => Reminder, "approval" => Approval, _ => null,
    };
    /// <summary>What a connection last saw for one category.</summary>
    public static string? StateOf(ProjectManagement.Domain.Entities.WhatsAppConnection c, string category) => category switch
    {
        "task_assignment" => c.TaskAssignmentTemplateState, "overdue" => c.OverdueTemplateState, "support_update" => c.SupportUpdateTemplateState,
        "reminder" => c.ReminderTemplateState, "approval" => c.ApprovalTemplateState, _ => null,
    };
    public void ApplyTo(ProjectManagement.Domain.Entities.WhatsAppConnection c)
    {
        c.TaskAssignmentTemplateState = TaskAssignment; c.OverdueTemplateState = Overdue; c.SupportUpdateTemplateState = SupportUpdate;
        c.ReminderTemplateState = Reminder; c.ApprovalTemplateState = Approval;
    }
}
public interface IWhatsAppTemplateProvider
{
    Task<WhatsAppProviderTemplates> InspectTemplatesAsync(string token, string businessAccountId, CancellationToken ct);
}

/// <summary>Read-only fixed notification contract. No free-form/window bypass or provider template mutation.</summary>
public class WhatsAppTemplateService(IAppDbContext db, CurrentContext ctx, AppClock clock, Recorder recorder,
    WhatsAppGatewayService gateway, ISecretProtector secrets, IOptions<WhatsAppOptions> options, IWhatsAppTemplateProvider provider)
{
    public static IReadOnlyList<WhatsAppTemplateDefinition> Definitions { get; } = Array.AsReadOnly(new[] {
        new WhatsAppTemplateDefinition("task_assignment", "project_tracker_task_assignment_v1", "en_US", "UTILITY",
            "You have a new task assignment in Project Tracker. Open your Project Tracker workspace to review it."),
        new WhatsAppTemplateDefinition("overdue", "project_tracker_overdue_v1", "en_US", "UTILITY",
            "A task assigned to you is overdue in Project Tracker. Open your Project Tracker workspace to review it."),
        new WhatsAppTemplateDefinition("support_update", "project_tracker_support_update_v1", "en_US", "UTILITY",
            "A support ticket you follow has an update in Project Tracker. Open your Project Tracker workspace to review it."),
        new WhatsAppTemplateDefinition("reminder", "project_tracker_reminder_v1", "en_US", "UTILITY",
            "A reminder you set in Project Tracker is due. Open your Project Tracker workspace to see it."),
        new WhatsAppTemplateDefinition("approval", "project_tracker_approval_v1", "en_US", "UTILITY",
            "Something is waiting for your approval in Project Tracker. Open your Project Tracker workspace to review it.")
    });
    private WhatsAppOptions O => options.Value;
    private bool Enabled => O.TemplateChecksEnabled && O.HealthChecksEnabled && O.InstallationConfigured;
    internal static string ConfigurationFingerprint(WhatsAppOptions o) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
        WhatsAppHealthService.ConfigurationFingerprint(o) + "|" + string.Join("|", Definitions.Select(x => string.Join("|", x.Key, x.Name, x.Language, x.Category, x.Body))))));
    private string ConfigurationHash => ConfigurationFingerprint(O);
    private bool Current(WhatsAppConnection? row) => row is { Active: true, AccessTokenProtected.Length: > 0 }
        && row.AppId == O.AppId && (row.TokenExpiresAt == null || row.TokenExpiresAt > clock.Now);
    private bool Healthy(WhatsAppConnection? row) => Current(row) && row!.HealthState == "verified"
        && row.HealthCheckedAt > clock.Now.AddMinutes(-5) && row.HealthCheckedAt <= clock.Now
        && row.HealthConfigurationHash == WhatsAppHealthService.ConfigurationFingerprint(O)
        && row.HealthTokenValid == true && row.HealthScopesPresent == true && row.HealthAssetsVerified == true
        && row.HealthAppSubscribed == true && row.HealthPhoneVerified == true;
    public static void Clear(WhatsAppConnection row)
    {
        // Preserve attempts across disconnect/reconnect to prevent cooldown bypass.
        row.TemplatesCheckedAt = null; row.TemplatesLeaseId = null; row.TemplatesLeaseUntil = null;
        row.TemplatesConfigurationHash = null; row.TemplatesState = "unchecked";
        row.TaskAssignmentTemplateState = "unchecked"; row.OverdueTemplateState = "unchecked"; row.SupportUpdateTemplateState = "unchecked";
        row.ReminderTemplateState = "unchecked"; row.ApprovalTemplateState = "unchecked";
    }
    private WhatsAppTemplateStatus Status(WhatsAppConnection? row, bool eligible)
    {
        var state = row?.TemplatesState ?? "unchecked";
        if (state == "checking" && (row!.TemplatesLeaseUntil == null || row.TemplatesLeaseUntil <= clock.Now)) state = "unavailable";
        else if (row?.TemplatesCheckedAt != null && (!Healthy(row) || row.TemplatesConfigurationHash != ConfigurationHash
            || row.TemplatesCheckedAt <= clock.Now.AddMinutes(-5) || row.TemplatesCheckedAt > clock.Now || !eligible)) state = "stale";
        var show = state is "verified" or "attention";
        var observations = new[] { row?.TaskAssignmentTemplateState, row?.OverdueTemplateState, row?.SupportUpdateTemplateState, row?.ReminderTemplateState, row?.ApprovalTemplateState };
        return new(Enabled && eligible && Healthy(row), state,
            row?.TemplatesCheckedAt is { } at ? new DateTimeOffset(DateTime.SpecifyKind(at, DateTimeKind.Utc)) : null,
            Definitions.Select((d, i) => new WhatsAppTemplateItem(d.Key, d.Name, d.Language, d.Category, d.Body,
                show ? observations[i] ?? "unavailable" : state)).ToArray(),
            MessagingEnabled: WhatsAppDeliveryService.Enabled(O)&&eligible&&Current(row));
    }
    public async Task<WhatsAppTemplateStatus> StatusAsync(CancellationToken ct)
    {
        await gateway.RequireAdminAsync(ct);
        return Status(await db.WhatsAppConnections.AsNoTracking().SingleOrDefaultAsync(x => x.TenantId == ctx.TenantId, ct),
            await gateway.EligibleAsync(ctx.RequireTenantId(), ct));
    }
    private async Task RequireAccess(CancellationToken ct)
    {
        await gateway.RequireAdminAsync(ct);
        if (!await gateway.EligibleAsync(ctx.RequireTenantId(), ct))
            throw new ForbiddenException("An eligible active subscription is required.", "WHATSAPP_PLAN_REQUIRED");
        if (!Enabled) throw new ConflictException("Template checks are awaiting platform setup.", "WHATSAPP_TEMPLATES_DISABLED");
    }
    public async Task<WhatsAppTemplateStatus> CheckAsync(CancellationToken ct)
    {
        await RequireAccess(ct); var tenant = ctx.RequireTenantId(); var lease = Guid.NewGuid(); var configuration = ConfigurationHash;
        WhatsAppConnection before;
        await using (var claim = await db.Database.BeginTransactionAsync(ct))
        {
            await db.LockTenantLedgerAsync(tenant, ct); await RequireAccess(ct);
            before = await db.WhatsAppConnections.AsNoTracking().SingleOrDefaultAsync(x => x.TenantId == tenant, ct)
                ?? throw new ConflictException("Connect your business account first.", "WHATSAPP_NOT_CONNECTED");
            if (!Healthy(before)) throw new ConflictException("Run a successful current provider health check first.", "WHATSAPP_HEALTH_REQUIRED");
            if (before.TemplatesLeaseUntil > clock.Now) throw new ConflictException("A template check is already running.", "WHATSAPP_TEMPLATES_CHECKING");
            if (before.TemplatesAttemptedAt > clock.Now.AddMinutes(-1)) throw new TooManyRequestsException("Wait a minute between template checks.");
            await db.WhatsAppConnections.Where(x => x.Id == before.Id && x.TenantId == tenant).ExecuteUpdateAsync(s => s
                .SetProperty(x => x.TemplatesAttemptedAt, clock.Now).SetProperty(x => x.TemplatesLeaseId, lease)
                .SetProperty(x => x.TemplatesLeaseUntil, clock.Now.AddSeconds(30)).SetProperty(x => x.TemplatesState, "checking")
                .SetProperty(x => x.TemplatesCheckedAt, (DateTime?)null).SetProperty(x => x.TemplatesConfigurationHash, (string?)null)
                .SetProperty(x => x.TaskAssignmentTemplateState, "unchecked").SetProperty(x => x.OverdueTemplateState, "unchecked")
                .SetProperty(x => x.SupportUpdateTemplateState, "unchecked").SetProperty(x => x.ReminderTemplateState, "unchecked")
                .SetProperty(x => x.ApprovalTemplateState, "unchecked"), ct);
            await claim.CommitAsync(ct);
        }
        WhatsAppProviderTemplates result;
        try { result = await provider.InspectTemplatesAsync(secrets.Unprotect(before.AccessTokenProtected), before.BusinessAccountId, ct); }
        catch (ConflictException) { result = WhatsAppProviderTemplates.Unavailable; }
        catch (CryptographicException) { result = WhatsAppProviderTemplates.Unavailable; }
        await using var finish = await db.Database.BeginTransactionAsync(ct);
        await db.LockTenantLedgerAsync(tenant, ct); await RequireAccess(ct);
        var row = await db.WhatsAppConnections.SingleOrDefaultAsync(x => x.Id == before.Id && x.TenantId == tenant, ct)
            ?? throw new ConflictException("The connection was removed.", "WHATSAPP_TEMPLATES_STALE");
        if (!Healthy(row) || row.ConnectedAt != before.ConnectedAt || row.AccessTokenProtected != before.AccessTokenProtected
            || row.TokenExpiresAt != before.TokenExpiresAt || row.BusinessAccountId != before.BusinessAccountId || row.PhoneNumberId != before.PhoneNumberId
            || row.HealthCheckedAt != before.HealthCheckedAt || row.TemplatesLeaseId != lease || row.TemplatesLeaseUntil <= clock.Now
            || ConfigurationHash != configuration)
            throw new ConflictException("The connection or provider health changed. Review integration status.", "WHATSAPP_TEMPLATES_STALE");
        result.ApplyTo(row); row.TemplatesCheckedAt = clock.Now; row.TemplatesConfigurationHash = configuration;
        row.TemplatesState = result.Overall;
        row.TemplatesLeaseId = null; row.TemplatesLeaseUntil = null;
        recorder.Audit("whatsapp.templates.checked", "WhatsAppConnection", row.Id);
        await db.SaveChangesAsync(ct); await finish.CommitAsync(ct); return Status(row, true);
    }
}
