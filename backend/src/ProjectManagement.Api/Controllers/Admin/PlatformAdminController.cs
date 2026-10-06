using ProjectManagement.Application.Features.Billing;
using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Application.Features.Admin;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Application.Features.Auth;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Api.Controllers.Admin;

/// <summary>
/// Platform administration: the people who run the product, not a workspace. Organizations, users, plans and the platform
/// audit log; money, usage, exceptions to plans, platform switches and system health. Authorisation is enforced in the
/// services from the server-resolved user, never from anything the client sends.
/// </summary>
[Route("api/v1/admin")]
public class PlatformAdminController(AdminService admin, PlatformService platform, GoLiveService goLive, AiUsageService aiUsage, ProjectManagement.Application.Features.Notifications.EmailAdminService emailAdmin, InvoiceService invoices) : ApiControllerBase
{
    // ---------------------------------------------------------------- organizations, users, plans, audit
    [HttpGet("stats")]
    public async Task<IActionResult> Stats(CancellationToken ct) => Ok(await admin.GetStatsAsync(ct));

    [HttpGet("tenants")]
    public async Task<IActionResult> Tenants([FromQuery] string? q, [FromQuery] WorkspaceType? type, [FromQuery] string? status, [FromQuery] int page = 1, [FromQuery] int pageSize = 25, CancellationToken ct = default) =>
        Ok(await admin.ListTenantsAsync(q, type, status, page, pageSize, ct));

    [HttpGet("tenants/{id:guid}")]
    public async Task<IActionResult> TenantDetail(Guid id, CancellationToken ct) => Ok(await admin.GetTenantAsync(id, ct));

    [HttpPost("tenants")]
    public async Task<IActionResult> CreateTenant([FromBody] CreateTenantRequest req, CancellationToken ct) => Created(await admin.CreateTenantAsync(req, ct));

    [HttpPut("tenants/{id:guid}")]
    public async Task<IActionResult> UpdateTenant(Guid id, [FromBody] UpdateTenantRequest req, CancellationToken ct) => Ok(await admin.UpdateTenantAsync(id, req, ct));

    /// <summary>Soft delete: members lose access, all data is kept, and the organization can be restored.</summary>
    [HttpDelete("tenants/{id:guid}")]
    public async Task<IActionResult> DeleteTenant(Guid id, CancellationToken ct)
    {
        await admin.DeleteTenantAsync(id, ct);
        return NoContent();
    }

    [HttpPost("tenants/{id:guid}/restore")]
    public async Task<IActionResult> RestoreTenant(Guid id, CancellationToken ct) => Ok(await admin.RestoreTenantAsync(id, ct));

    [HttpPut("tenants/{id:guid}/status")]
    public async Task<IActionResult> TenantStatus(Guid id, [FromBody] SetTenantStatusRequest req, CancellationToken ct)
    {
        await admin.SetTenantStatusAsync(id, req, ct);
        return NoContent();
    }

    [HttpPut("tenants/{id:guid}/subscription")]
    public async Task<IActionResult> TenantSubscription(Guid id, [FromBody] SetTenantSubscriptionRequest req, CancellationToken ct)
    {
        await admin.SetTenantSubscriptionAsync(id, req, ct);
        return NoContent();
    }

    [HttpGet("users")]
    public async Task<IActionResult> Users([FromQuery] string? q, [FromQuery] int page = 1, [FromQuery] int pageSize = 25, CancellationToken ct = default) =>
        Ok(await admin.ListUsersAsync(q, page, pageSize, ct));

    [HttpGet("users/{id:guid}")]
    public async Task<IActionResult> UserDetail(Guid id, CancellationToken ct) => Ok(await admin.GetUserAsync(id, ct));

    [HttpPost("users/{id:guid}/sign-out")]
    public async Task<IActionResult> SignOutUser(Guid id, CancellationToken ct)
    {
        await admin.SignOutUserAsync(id, ct);
        return NoContent();
    }

    /// <summary>For someone who lost their phone and recovery codes: switches two-step verification off (audited) and signs them out.</summary>
    [HttpPost("users/{id:guid}/mfa-reset")]
    public async Task<IActionResult> ResetMfa(Guid id, CancellationToken ct)
    {
        await admin.ResetMfaAsync(id, ct);
        return NoContent();
    }

    [HttpPut("users/{id:guid}/status")]
    public async Task<IActionResult> UserStatus(Guid id, [FromBody] SetUserStatusRequest req, CancellationToken ct)
    {
        await admin.SetUserStatusAsync(id, req, ct);
        return NoContent();
    }

    [HttpPut("users/{id:guid}/platform-admin")]
    public async Task<IActionResult> PlatformAdmin(Guid id, [FromBody] SetPlatformAdminRequest req, CancellationToken ct)
    {
        await admin.SetPlatformAdminAsync(id, req, ct);
        return NoContent();
    }

    [HttpGet("plans")]
    public async Task<IActionResult> Plans(CancellationToken ct) => Ok(await admin.ListPlansAsync(ct));

    [HttpPut("plans/{id:guid}")]
    public async Task<IActionResult> UpdatePlan(Guid id, [FromBody] UpdatePlanRequest req, CancellationToken ct) => Ok(await admin.UpdatePlanAsync(id, req, ct));

    [HttpGet("audit-logs")]
    public async Task<IActionResult> Audit([FromQuery] string? action, [FromQuery] Guid? tenantId, [FromQuery] int page = 1, [FromQuery] int pageSize = 25, CancellationToken ct = default) =>
        Ok(await admin.ListAuditAsync(action, tenantId, page, pageSize, ct));

    // ---------------------------------------------------------------- money, usage, plan exceptions, switches, health
    /// <summary>Is this deployment safe to open to real people? Inspects configuration and data; never returns a secret.</summary>
    [HttpGet("go-live")]
    public async Task<IActionResult> GoLive(CancellationToken ct) => Ok(await goLive.CheckAsync(ct));

    // ---- e-mail: what was sent and what went wrong, who is blocked, whether the sending domain is set up
    [HttpGet("email")]
    public async Task<IActionResult> EmailOverview([FromQuery] string? status, CancellationToken ct) => Ok(await emailAdmin.OverviewAsync(status, ct));

    [HttpGet("email/suppressions")]
    public async Task<IActionResult> EmailSuppressions(CancellationToken ct) => Ok(await emailAdmin.SuppressionsAsync(ct));

    [HttpDelete("email/suppressions/{id:guid}")]
    public async Task<IActionResult> EmailUnblock(Guid id, CancellationToken ct) { await emailAdmin.RemoveSuppressionAsync(id, ct); return NoContent(); }

    [HttpGet("email/domain-check")]
    public async Task<IActionResult> EmailDomain([FromQuery] string? domain, CancellationToken ct) => Ok(await emailAdmin.CheckDomainAsync(domain, ct));

    /// <summary>Sends a real test message to the signed-in administrator.</summary>
    [HttpPost("test-email")]
    public async Task<IActionResult> TestEmail(CancellationToken ct) => Ok(await goLive.SendTestEmailAsync(ct));

    [HttpGet("billing")]
    public async Task<IActionResult> Billing(CancellationToken ct) => Ok(await platform.BillingAsync(ct));

    [HttpGet("usage")]
    public async Task<IActionResult> Usage([FromQuery] string? q, [FromQuery] WorkspaceType? type, [FromQuery] string? sort, [FromQuery] bool warningsOnly = false, [FromQuery] int page = 1, [FromQuery] int pageSize = 25, CancellationToken ct = default) =>
        Ok(await platform.UsageAsync(q, type, sort, warningsOnly, page, pageSize, ct));

    /// <summary>The AI workspace's use per organization for a month, with an estimate of its cost at the providers' prices. Counts only.</summary>
    [HttpGet("ai-usage")]
    public async Task<IActionResult> AiUsage([FromQuery] string? month, CancellationToken ct) => Ok(await aiUsage.PlatformAsync(month, ct));

    [HttpGet("health")]
    public async Task<IActionResult> Health(CancellationToken ct) => Ok(await platform.HealthAsync(ct));

    [HttpGet("password-policy")]
    public async Task<IActionResult> PasswordPolicy(CancellationToken ct) => Ok(await platform.GetPasswordPolicyAsync(ct));

    [HttpPut("password-policy")]
    public async Task<IActionResult> SetPasswordPolicy([FromBody] PasswordPolicyDto req, CancellationToken ct) => Ok(await platform.SetPasswordPolicyAsync(req, ct));

    /// <summary>The currency every plan is priced in (INR unless changed) and the currencies it can be switched to.</summary>
    /// <summary>Who issues invoices (name, address, tax id, a note under the total).</summary>
    [HttpGet("invoice-seller")]
    public async Task<IActionResult> InvoiceSeller(CancellationToken ct) => Ok(await invoices.GetSellerAsync(ct));

    [HttpPut("invoice-seller")]
    public async Task<IActionResult> SetInvoiceSeller([FromBody] InvoiceSellerDto req, CancellationToken ct) => Ok(await invoices.SetSellerAsync(req, ct));

    [HttpGet("billing-settings")]
    public async Task<IActionResult> BillingSettings(CancellationToken ct) => Ok(await platform.GetBillingSettingsAsync(ct));

    [HttpPut("billing-settings")]
    public async Task<IActionResult> SetBillingSettings([FromBody] SetBillingSettingsRequest req, CancellationToken ct) =>
        Ok(await platform.SetBillingSettingsAsync(req, ct));

    [HttpGet("settings")]
    public async Task<IActionResult> Settings(CancellationToken ct) => Ok(await platform.GetSettingsAsync(ct));

    [HttpPut("settings")]
    public async Task<IActionResult> SetSettings([FromBody] PlatformSettingsDto req, CancellationToken ct) => Ok(await platform.SetSettingsAsync(req, ct));

    [HttpGet("tenants/{id:guid}/overrides")]
    public async Task<IActionResult> Overrides(Guid id, CancellationToken ct) => Ok(await platform.OverridesAsync(id, ct));

    [HttpPut("tenants/{id:guid}/overrides/{key}")]
    public async Task<IActionResult> SetOverride(Guid id, string key, [FromBody] SetOverrideRequest req, CancellationToken ct) => Ok(await platform.SetOverrideAsync(id, key, req, ct));

    [HttpDelete("tenants/{id:guid}/overrides/{key}")]
    public async Task<IActionResult> RemoveOverride(Guid id, string key, CancellationToken ct) => Ok(await platform.RemoveOverrideAsync(id, key, ct));

    [HttpGet("consent")]
    public async Task<IActionResult> ConsentDocuments(CancellationToken ct) => Ok(await platform.GetConsentDocumentsForAdminAsync(ct));

    [HttpPut("consent")]
    public async Task<IActionResult> PublishConsentDocument([FromBody] SetConsentDocumentRequest req, CancellationToken ct) => Ok(await platform.PublishConsentDocumentAsync(req, ct));
}
