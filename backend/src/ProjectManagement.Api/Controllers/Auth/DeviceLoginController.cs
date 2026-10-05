using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using ProjectManagement.Application.Features.Auth;

namespace ProjectManagement.Api.Controllers.Auth;

/// <summary>The computer's side of signing in by approving on a phone: ask, then watch until the phone answers. No account is revealed by the answers.</summary>
[Route("api/v1/auth/device-login")]
public class DeviceLoginController(DeviceLoginService login) : ApiControllerBase
{
    [HttpPost, AllowAnonymous, EnableRateLimiting("auth")]
    public async Task<IActionResult> Start([FromBody] DeviceLoginStartRequest req, CancellationToken ct) => Ok(await login.StartAsync(req, ct));

    /// <summary>Polled every second or two by the browser that asked; the approved answer opens the session exactly like a password sign-in does.</summary>
    [HttpPost("{id:guid}/poll"), AllowAnonymous]
    public async Task<IActionResult> Poll(Guid id, [FromBody] DeviceLoginPollRequest req, CancellationToken ct)
    {
        var r = await login.PollAsync(id, req, ct);
        if (r.Session is null) return Ok(new { status = r.Status });
        AuthCookies.WriteRefresh(Response, Request.IsHttps, r.Session);
        var body = Request.Headers["X-Token-Delivery"] == "body";
        return Ok(new { status = r.Status, auth = new AuthResponse(r.Session.AccessToken, r.Session.ExpiresAt, r.Session.User, body ? r.Session.RefreshToken : null) });
    }
}

/// <summary>The phone's side: what is waiting for me, approve (by choosing the number) or deny. Only for the signed-in person, only their own requests.</summary>
[Route("api/v1/me/device-login")]
public class MyDeviceLoginController(DeviceLoginService login) : ApiControllerBase
{
    [HttpGet("pending")]
    public async Task<IActionResult> Pending(CancellationToken ct) => Ok(await login.PendingAsync(ct));

    [HttpGet("{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct) => Ok(await login.GetAsync(id, ct));

    [HttpPost("{id:guid}/approve")]
    public async Task<IActionResult> Approve(Guid id, [FromBody] DeviceLoginApproveRequest req, CancellationToken ct) { await login.ApproveAsync(id, req, ct); return NoContent(); }

    [HttpPost("{id:guid}/deny")]
    public async Task<IActionResult> Deny(Guid id, CancellationToken ct) { await login.DenyAsync(id, ct); return NoContent(); }
}
