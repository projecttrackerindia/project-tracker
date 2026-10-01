using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Auth;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Workspaces;

namespace ProjectManagement.Api.Controllers.Auth;

[Route("api/v1/me")]
public class MeController(AuthService auth, WorkspaceService workspaces, NotificationPreferenceService preferences, MfaService mfa) : ApiControllerBase
{
    /// <summary>User, all workspaces, and the current workspace with role, permissions and entitlements.</summary>
    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken ct) => Ok(await workspaces.GetContextAsync(ct));

    /// <summary>A cheap "has my access changed?" check the app polls, so menus follow role, permission and plan changes without a reload.</summary>
    [HttpGet("fingerprint")]
    public async Task<IActionResult> Fingerprint(CancellationToken ct) => Ok(new FingerprintDto((await workspaces.GetContextAsync(ct)).Fingerprint));

    [HttpPut]
    public async Task<IActionResult> UpdateProfile([FromBody] UpdateProfileRequest req, CancellationToken ct) =>
        Ok(await auth.UpdateProfileAsync(req, ct));

    [HttpPost("password")]
    public async Task<IActionResult> ChangePassword([FromBody] ChangePasswordRequest req, CancellationToken ct)
    {
        await auth.ChangePasswordAsync(req, ct);
        return NoContent();
    }

    [HttpGet("mfa")]
    public async Task<IActionResult> MfaStatus(CancellationToken ct) => Ok(await mfa.GetStatusAsync(ct));

    [HttpPost("mfa/setup"), EnableRateLimiting("auth")]
    public async Task<IActionResult> MfaSetup([FromBody] MfaSetupRequest req, CancellationToken ct) => Ok(await mfa.BeginSetupAsync(req, ct));

    [HttpPost("mfa/enable"), EnableRateLimiting("auth")]
    public async Task<IActionResult> MfaEnable([FromBody] MfaEnableRequest req, CancellationToken ct) => Ok(await mfa.EnableAsync(req, ct));

    [HttpPost("mfa/disable"), EnableRateLimiting("auth")]
    public async Task<IActionResult> MfaDisable([FromBody] MfaConfirmRequest req, CancellationToken ct)
    {
        await mfa.DisableAsync(req, ct);
        return NoContent();
    }

    [HttpPost("mfa/recovery-codes"), EnableRateLimiting("auth")]
    public async Task<IActionResult> MfaRecoveryCodes([FromBody] MfaConfirmRequest req, CancellationToken ct) => Ok(await mfa.RegenerateRecoveryCodesAsync(req, ct));

    /// <summary>Which notifications reach me, and through which channel (in the app, e-mail, desktop).</summary>
    [HttpGet("notification-preferences")]
    public async Task<IActionResult> NotificationPreferences(CancellationToken ct) => Ok(await preferences.GetAsync(ct));

    [HttpPut("notification-preferences")]
    public async Task<IActionResult> SetNotificationPreferences([FromBody] SetPreferencesRequest req, CancellationToken ct) => Ok(await preferences.SetAsync(req, ct));

    /// <summary>Sends an e-mail to me right now so I can check delivery works.</summary>
    [HttpPost("notification-preferences/test-email")]
    public async Task<IActionResult> TestEmail(CancellationToken ct) => Ok(await preferences.SendTestEmailAsync(ct));

    [HttpGet("sessions")]
    public async Task<IActionResult> Sessions(CancellationToken ct) => Ok(await auth.GetSessionsAsync(ct));

    [HttpDelete("sessions/{id:guid}")]
    public async Task<IActionResult> RevokeSession(Guid id, CancellationToken ct)
    {
        await auth.RevokeSessionAsync(id, ct);
        return NoContent();
    }
}
