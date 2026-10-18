using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Auth;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Workspaces;

namespace ProjectManagement.Api.Controllers.Auth;

/// <summary>The cookies of sign-in: the refresh token (HttpOnly, only sent to /api/v1/auth) and, during a redirect sign-in, the browser binding.</summary>
public static class AuthCookies
{
    public const string Refresh = "pm_refresh";
    public const string Binding = "pm_signin";

    /// <summary>
    /// Whether cookies must be Secure: the request came over https, or the app is published on an https address (behind a proxy that
    /// terminates TLS without forwarding the scheme, Request.IsHttps is false even though the browser is on https).
    /// </summary>
    public static bool IsSecure(HttpRequest request) =>
        request.IsHttps
        || (request.HttpContext.RequestServices.GetService<IOptions<AppOptions>>()?.Value.WebBaseUrl ?? "").StartsWith("https://", StringComparison.OrdinalIgnoreCase);

    /// <summary>Sets the refresh cookie; a result without a new refresh token (a second tab within the grace window) leaves the cookie as it is.</summary>
    public static void WriteRefresh(HttpResponse response, bool https, AuthResult r)
    {
        if (r.RefreshToken is null) return;
        WriteRefresh(response, https, r.RefreshToken, r.RefreshExpiresAt);
    }

    public static void WriteRefresh(HttpResponse response, bool https, string refreshToken, DateTime expiresAt) =>
        response.Cookies.Append(Refresh, refreshToken, new CookieOptions
        {
            HttpOnly = true, Secure = https, SameSite = SameSiteMode.Strict, Path = "/api/v1/auth",
            Expires = expiresAt, IsEssential = true,
        });
}

[Route("api/v1/auth")]
public class AuthController(AuthService auth, PasswordPolicyService passwordPolicy) : ApiControllerBase
{
    /// <summary>The rules a new password must meet (anyone may read them: the sign-up form shows them).</summary>
    [HttpGet("password-policy"), AllowAnonymous]
    public async Task<IActionResult> PasswordPolicy(CancellationToken ct) => Ok(await passwordPolicy.GetAsync(ct));

    private const string CookieName = AuthCookies.Refresh;

    /// <summary>The refresh token lives in an HttpOnly cookie for browsers; API clients can opt in to receiving it in the body.</summary>
    private bool BodyDelivery => Request.Headers["X-Token-Delivery"] == "body";

    private AuthResponse Deliver(AuthResult r)
    {
        AuthCookies.WriteRefresh(Response, AuthCookies.IsSecure(Request), r);
        return new AuthResponse(r.AccessToken, r.ExpiresAt, r.User, BodyDelivery ? r.RefreshToken : null);
    }

    private void ClearCookie() => Response.Cookies.Delete(CookieName, new CookieOptions { Path = "/api/v1/auth", Secure = AuthCookies.IsSecure(Request), SameSite = SameSiteMode.Strict });

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
        // The tab's own workspace (the app sends it), so a switch in one tab does not move every other tab on their next refresh.
        Guid? workspace = Guid.TryParse(Request.Headers["X-Workspace-Id"].ToString(), out var w) ? w : null;
        // Only a session that is really over loses its cookie; a token another tab just rotated must not sign this browser out.
        try { return Ok(Deliver(await auth.RefreshAsync(token, workspace, ct))); }
        catch (UnauthorizedException ex) when (ex.Code is "INVALID_REFRESH_TOKEN" or "SESSION_EXPIRED" or "ACCOUNT_DISABLED") { ClearCookie(); throw; }
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
