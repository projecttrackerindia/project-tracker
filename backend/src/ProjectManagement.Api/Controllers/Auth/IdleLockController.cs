using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Auth;

namespace ProjectManagement.Api.Controllers.Auth;

/// <summary>Unlock with a password, or with a passkey (the challenge id from unlock/passkey-options and the device's signed answer).</summary>
public record UnlockRequest(string? Password = null, Guid? ChallengeId = null, JsonElement? Response = null, string? RefreshToken = null);
/// <summary>For API clients that keep the refresh token themselves (X-Token-Delivery: body); browsers send the cookie.</summary>
public record LockTokenRequest(string? RefreshToken = null);

/// <summary>
/// "Sign out after inactivity": the app's activity ping, locking at the timeout, and unlocking with a passkey or the password. The lock-screen calls work
/// from the refresh cookie (sent only to /api/v1/auth), because a locked session's access token is refused everywhere else.
/// </summary>
[Route("api/v1/auth")]
public class IdleLockController(AuthService auth, PasskeyService passkeys) : ApiControllerBase
{
    private bool BodyDelivery => Request.Headers["X-Token-Delivery"] == "body";

    /// <summary>The refresh token from the body (API clients), else the cookie, which needs the custom header so a cross-site form cannot use it.</summary>
    private string? TokenFrom(string? bodyToken)
    {
        if (!string.IsNullOrWhiteSpace(bodyToken)) return bodyToken;
        if (Request.Headers["X-Requested-With"] != "XMLHttpRequest")
            throw new ForbiddenException("Missing X-Requested-With header.", "CSRF_CHECK_FAILED");
        return Request.Cookies[AuthCookies.Refresh];
    }

    private void ClearCookie() => Response.Cookies.Delete(AuthCookies.Refresh, new CookieOptions { Path = "/api/v1/auth", Secure = AuthCookies.IsSecure(Request), SameSite = SameSiteMode.Strict });

    /// <summary>Real use of the app (keyboard, pointer, touch), at most about once a minute: keeps the session from locking.</summary>
    [HttpPost("activity")]
    public async Task<IActionResult> Activity(CancellationToken ct) => Ok(await auth.ActivityAsync(ct));

    /// <summary>The app's timer ran out: lock the session now, on the server too.</summary>
    [HttpPost("lock"), AllowAnonymous]
    public async Task<IActionResult> Lock([FromBody(EmptyBodyBehavior = Microsoft.AspNetCore.Mvc.ModelBinding.EmptyBodyBehavior.Allow)] LockTokenRequest? req, CancellationToken ct)
    {
        await auth.LockAsync(User.Identity?.IsAuthenticated == true ? req?.RefreshToken : TokenFrom(req?.RefreshToken), ct);
        return NoContent();
    }

    /// <summary>What the lock screen shows: whose session this is, and which ways of unlocking it has.</summary>
    [HttpPost("unlock/state"), AllowAnonymous]
    public async Task<IActionResult> State([FromBody(EmptyBodyBehavior = Microsoft.AspNetCore.Mvc.ModelBinding.EmptyBodyBehavior.Allow)] LockTokenRequest? req, CancellationToken ct) =>
        Ok(await auth.LockStateAsync(TokenFrom(req?.RefreshToken), ct));

    [HttpPost("unlock/passkey-options"), AllowAnonymous, EnableRateLimiting("auth")]
    public async Task<IActionResult> PasskeyOptions([FromBody(EmptyBodyBehavior = Microsoft.AspNetCore.Mvc.ModelBinding.EmptyBodyBehavior.Allow)] LockTokenRequest? req, CancellationToken ct) =>
        Ok(await passkeys.BeginUnlockAsync(await auth.LockedUserIdAsync(TokenFrom(req?.RefreshToken), ct), ct));

    /// <summary>Unlocks with the password or a passkey and hands back fresh tokens. Five wrong tries in a row sign the session out.</summary>
    [HttpPost("unlock"), AllowAnonymous, EnableRateLimiting("auth")]
    public async Task<IActionResult> Unlock([FromBody] UnlockRequest req, CancellationToken ct)
    {
        var token = TokenFrom(req.RefreshToken);
        Guid? workspace = Guid.TryParse(Request.Headers["X-Workspace-Id"].ToString(), out var w) ? w : null;
        Func<ProjectManagement.Domain.Entities.User, Task<bool>> verify;
        string method;
        if (req.ChallengeId is { } challengeId && req.Response is { } answer)
        {
            method = "passkey";
            verify = u => passkeys.VerifyUnlockAsync(u.Id, new PasskeyFinishRequest(challengeId, answer), ct);
        }
        else if (!string.IsNullOrEmpty(req.Password))
        {
            method = "password";
            var password = req.Password;
            verify = u => Task.FromResult(auth.PasswordMatches(u, password));
        }
        else throw new ValidationException("password", "Enter your password, or use your passkey.");

        try
        {
            var r = await auth.UnlockAsync(token, method, verify, workspace, ct);
            AuthCookies.WriteRefresh(Response, AuthCookies.IsSecure(Request), r);
            return Ok(new AuthResponse(r.AccessToken, r.ExpiresAt, r.User, BodyDelivery ? r.RefreshToken : null));
        }
        catch (UnauthorizedException ex) when (ex.Code is "SESSION_UNLOCK_SIGNED_OUT" or "SESSION_EXPIRED" or "SESSION_REPLACED" or "ACCOUNT_DISABLED" or "INVALID_REFRESH_TOKEN")
        {
            ClearCookie();
            throw;
        }
    }
}

/// <summary>The workspace's "Sign out after inactivity" time: everyone reads it (the app's timer), owners and admins change it.</summary>
[Route("api/v1/workspace/idle-policy"), RequireWorkspace]
public class WorkspaceIdlePolicyController(AuthService auth) : ApiControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken ct) => Ok(await auth.IdlePolicyAsync(ct));

    [HttpPut]
    public async Task<IActionResult> Set([FromBody] SetIdlePolicyRequest req, CancellationToken ct) => Ok(await auth.SetIdlePolicyAsync(req, ct));
}
