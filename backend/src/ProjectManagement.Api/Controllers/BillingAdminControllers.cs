using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Admin;
using ProjectManagement.Application.Features.Billing;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Infrastructure.Services;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers;

[Route("api/v1/billing"), RequireWorkspace, RequireModule(Modules.Billing)]
public class BillingController(BillingService billing) : ApiControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Overview(CancellationToken ct) => Ok(await billing.GetOverviewAsync(ct));

    [HttpPost("checkout")]
    public async Task<IActionResult> Checkout([FromBody] CheckoutRequest req, CancellationToken ct) => Ok(await billing.CheckoutAsync(req, ct));

    [HttpPost("cancel")]
    public async Task<IActionResult> Cancel(CancellationToken ct) => Ok(await billing.CancelAsync(ct));

    [HttpPost("resume")]
    public async Task<IActionResult> Resume(CancellationToken ct) => Ok(await billing.ResumeAsync(ct));
}

/// <summary>Platform administration. Authorisation is enforced in <see cref="AdminService"/> from the server-resolved user.</summary>
[Route("api/v1/admin")]
public class AdminController(AdminService admin) : ApiControllerBase
{
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
}

/// <summary>Development-only helpers. Not registered outside Development / when Dev:Mailbox is off.</summary>
[Route("api/v1/dev"), AllowAnonymous]
public class DevController(DevMailbox mailbox, IWebHostEnvironment env, IConfiguration config) : ApiControllerBase
{
    [HttpGet("emails")]
    public IActionResult Emails() =>
        env.IsDevelopment() || config.GetValue("Dev:Mailbox", false) ? Ok(mailbox.Recent()) : NotFound();
}

/// <summary>Platform administration: money, usage, exceptions to plans, platform switches and system health.</summary>
[Route("api/v1/admin")]
public class PlatformAdminController(ProjectManagement.Application.Features.Admin.PlatformService platform, ProjectManagement.Application.Features.Admin.GoLiveService goLive) : ApiControllerBase
{
    /// <summary>Is this deployment safe to open to real people? Inspects configuration and data; never returns a secret.</summary>
    [HttpGet("go-live")]
    public async Task<IActionResult> GoLive(CancellationToken ct) => Ok(await goLive.CheckAsync(ct));

    /// <summary>Sends a real test message to the signed-in administrator.</summary>
    [HttpPost("test-email")]
    public async Task<IActionResult> TestEmail(CancellationToken ct) => Ok(await goLive.SendTestEmailAsync(ct));

    [HttpGet("billing")]
    public async Task<IActionResult> Billing(CancellationToken ct) => Ok(await platform.BillingAsync(ct));

    [HttpGet("usage")]
    public async Task<IActionResult> Usage([FromQuery] string? q, [FromQuery] WorkspaceType? type, [FromQuery] string? sort, [FromQuery] bool warningsOnly = false, [FromQuery] int page = 1, [FromQuery] int pageSize = 25, CancellationToken ct = default) =>
        Ok(await platform.UsageAsync(q, type, sort, warningsOnly, page, pageSize, ct));

    [HttpGet("health")]
    public async Task<IActionResult> Health(CancellationToken ct) => Ok(await platform.HealthAsync(ct));

    [HttpGet("password-policy")]
    public async Task<IActionResult> PasswordPolicy(CancellationToken ct) => Ok(await platform.GetPasswordPolicyAsync(ct));

    [HttpPut("password-policy")]
    public async Task<IActionResult> SetPasswordPolicy([FromBody] ProjectManagement.Application.Features.Auth.PasswordPolicyDto req, CancellationToken ct) => Ok(await platform.SetPasswordPolicyAsync(req, ct));

    /// <summary>The currency every plan is priced in (INR unless changed) and the currencies it can be switched to.</summary>
    [HttpGet("billing-settings")]
    public async Task<IActionResult> BillingSettings(CancellationToken ct) => Ok(await platform.GetBillingSettingsAsync(ct));

    [HttpPut("billing-settings")]
    public async Task<IActionResult> SetBillingSettings([FromBody] ProjectManagement.Application.Features.Admin.SetBillingSettingsRequest req, CancellationToken ct) =>
        Ok(await platform.SetBillingSettingsAsync(req, ct));

    [HttpGet("settings")]
    public async Task<IActionResult> Settings(CancellationToken ct) => Ok(await platform.GetSettingsAsync(ct));

    [HttpPut("settings")]
    public async Task<IActionResult> SetSettings([FromBody] ProjectManagement.Application.Features.Admin.PlatformSettingsDto req, CancellationToken ct) => Ok(await platform.SetSettingsAsync(req, ct));

    [HttpGet("tenants/{id:guid}/overrides")]
    public async Task<IActionResult> Overrides(Guid id, CancellationToken ct) => Ok(await platform.OverridesAsync(id, ct));

    [HttpPut("tenants/{id:guid}/overrides/{key}")]
    public async Task<IActionResult> SetOverride(Guid id, string key, [FromBody] ProjectManagement.Application.Features.Admin.SetOverrideRequest req, CancellationToken ct) => Ok(await platform.SetOverrideAsync(id, key, req, ct));

    [HttpDelete("tenants/{id:guid}/overrides/{key}")]
    public async Task<IActionResult> RemoveOverride(Guid id, string key, CancellationToken ct) => Ok(await platform.RemoveOverrideAsync(id, key, ct));

    [HttpGet("consent")]
    public async Task<IActionResult> ConsentDocuments(CancellationToken ct) => Ok(await platform.GetConsentDocumentsForAdminAsync(ct));

    [HttpPut("consent")]
    public async Task<IActionResult> PublishConsentDocument([FromBody] ProjectManagement.Application.Features.Admin.SetConsentDocumentRequest req, CancellationToken ct) => Ok(await platform.PublishConsentDocumentAsync(req, ct));
}

/// <summary>What every visitor may know about the platform right now (announcement, maintenance).</summary>
[Route("api/v1/platform"), AllowAnonymous]
public class PlatformStatusController(ProjectManagement.Application.Features.Admin.PlatformService platform) : ApiControllerBase
{
    [HttpGet("status")]
    public async Task<IActionResult> Status(CancellationToken ct) => Ok(await platform.StatusAsync(ct));
}
