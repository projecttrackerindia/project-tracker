using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
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

    public static void WriteRefresh(HttpResponse response, bool https, AuthResult r) =>
        response.Cookies.Append(Refresh, r.RefreshToken, new CookieOptions
        {
            HttpOnly = true, Secure = https, SameSite = SameSiteMode.Strict, Path = "/api/v1/auth",
            Expires = r.RefreshExpiresAt, IsEssential = true,
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
        AuthCookies.WriteRefresh(Response, Request.IsHttps, r);
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
