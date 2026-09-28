using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Auth;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Workspaces;

namespace ProjectManagement.Api.Controllers;

[ApiController, Authorize]
public abstract class ApiControllerBase : ControllerBase
{
    protected IActionResult Created<T>(T data) => StatusCode(StatusCodes.Status201Created, data);
}

public record AuthResponse(string AccessToken, DateTime ExpiresAt, UserDto User, string? RefreshToken);

[Route("api/v1/auth")]
public class AuthController(AuthService auth, PasswordPolicyService passwordPolicy) : ApiControllerBase
{
    /// <summary>The rules a new password must meet (anyone may read them: the sign-up form shows them).</summary>
    [HttpGet("password-policy"), AllowAnonymous]
    public async Task<IActionResult> PasswordPolicy(CancellationToken ct) => Ok(await passwordPolicy.GetAsync(ct));

    private const string CookieName = "pm_refresh";

    /// <summary>The refresh token lives in an HttpOnly cookie for browsers; API clients can opt in to receiving it in the body.</summary>
    private bool BodyDelivery => Request.Headers["X-Token-Delivery"] == "body";

    private AuthResponse Deliver(AuthResult r)
    {
        Response.Cookies.Append(CookieName, r.RefreshToken, new CookieOptions
        {
            HttpOnly = true, Secure = Request.IsHttps, SameSite = SameSiteMode.Strict, Path = "/api/v1/auth",
            Expires = r.RefreshExpiresAt, IsEssential = true,
        });
        return new AuthResponse(r.AccessToken, r.ExpiresAt, r.User, BodyDelivery ? r.RefreshToken : null);
    }

    private void ClearCookie() => Response.Cookies.Delete(CookieName, new CookieOptions { Path = "/api/v1/auth" });

    [HttpPost("register"), AllowAnonymous, EnableRateLimiting("auth")]
    public async Task<IActionResult> Register([FromBody] RegisterRequest req, CancellationToken ct) =>
        Created(await auth.RegisterAsync(req, ct));

    [HttpPost("verify-email"), AllowAnonymous, EnableRateLimiting("auth")]
    public async Task<IActionResult> VerifyEmail([FromBody] VerifyEmailRequest req, CancellationToken ct)
    {
        await auth.VerifyEmailAsync(req, ct);
        return NoContent();
    }

    [HttpPost("resend-verification"), AllowAnonymous, EnableRateLimiting("auth")]
    public async Task<IActionResult> ResendVerification([FromBody] ResendVerificationRequest req, CancellationToken ct)
    {
        await auth.ResendVerificationAsync(req, ct);
        return Accepted();
    }

    [HttpPost("login"), AllowAnonymous, EnableRateLimiting("auth")]
    public async Task<IActionResult> Login([FromBody] LoginRequest req, CancellationToken ct)
    {
        var outcome = await auth.LoginAsync(req, ct);
        return outcome.Session is { } session ? Ok(Deliver(session)) : Ok(new MfaChallengeDto(true, outcome.MfaChallenge!));
    }

    /// <summary>Second step when two-step verification is on: the challenge from login plus an authenticator or recovery code.</summary>
    [HttpPost("login/mfa"), AllowAnonymous, EnableRateLimiting("auth")]
    public async Task<IActionResult> LoginMfa([FromBody] MfaLoginRequest req, CancellationToken ct) =>
        Ok(Deliver(await auth.CompleteMfaLoginAsync(req, ct)));

    [HttpPost("refresh"), AllowAnonymous]
    public async Task<IActionResult> Refresh([FromBody(EmptyBodyBehavior = Microsoft.AspNetCore.Mvc.ModelBinding.EmptyBodyBehavior.Allow)] RefreshRequest? req, CancellationToken ct)
    {
        var token = req?.RefreshToken;
        if (string.IsNullOrWhiteSpace(token))
        {
            // Cookie-based refresh: require a custom header so a cross-site form post cannot trigger it (CSRF defence).
            if (Request.Headers["X-Requested-With"] != "XMLHttpRequest")
                throw new ForbiddenException("Missing X-Requested-With header.", "CSRF_CHECK_FAILED");
            token = Request.Cookies[CookieName];
        }
        try { return Ok(Deliver(await auth.RefreshAsync(token, ct))); }
        catch (UnauthorizedException) { ClearCookie(); throw; }
    }

    [HttpPost("logout"), AllowAnonymous]
    public async Task<IActionResult> Logout(CancellationToken ct)
    {
        await auth.LogoutAsync(Request.Cookies[CookieName], ct);
        ClearCookie();
        return NoContent();
    }

    [HttpPost("logout-all")]
    public async Task<IActionResult> LogoutAll(CancellationToken ct)
    {
        await auth.LogoutAllAsync(ct);
        ClearCookie();
        return NoContent();
    }

    [HttpPost("forgot-password"), AllowAnonymous, EnableRateLimiting("auth")]
    public async Task<IActionResult> ForgotPassword([FromBody] ForgotPasswordRequest req, CancellationToken ct)
    {
        await auth.ForgotPasswordAsync(req, ct);
        return Accepted(); // identical response whether or not the account exists
    }

    [HttpPost("reset-password"), AllowAnonymous, EnableRateLimiting("auth")]
    public async Task<IActionResult> ResetPassword([FromBody] ResetPasswordRequest req, CancellationToken ct)
    {
        await auth.ResetPasswordAsync(req, ct);
        return NoContent();
    }
}

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

/// <summary>The current Terms of Service / Privacy Policy, and accepting them. The public GET is read by the sign-up page.</summary>
[Route("api/v1/consent")]
public class ConsentController(ProjectManagement.Application.Features.Consent.ConsentService consent) : ApiControllerBase
{
    [HttpGet("documents"), AllowAnonymous]
    public async Task<IActionResult> Documents(CancellationToken ct) => Ok(await consent.GetCurrentAsync(ct));

    [HttpGet("status")]
    public async Task<IActionResult> Status(CancellationToken ct) => Ok(await consent.GetMyStatusAsync(ct));

    [HttpPost("accept")]
    public async Task<IActionResult> Accept([FromBody] ProjectManagement.Application.Features.Consent.AcceptConsentRequest req, CancellationToken ct) => Ok(await consent.AcceptAsync(req, ct));
}
