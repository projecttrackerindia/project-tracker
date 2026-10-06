using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Application.Features.Notifications;

namespace ProjectManagement.Api.Controllers.Auth;

public record PushEndpointRequest(string? Endpoint);
public record SignInDeviceRequest(string? Endpoint, bool Enabled);

/// <summary>Push notifications on the signed-in person's devices (they apply in every workspace).</summary>
[Route("api/v1/push")]
public class PushController(PushService push, ProjectManagement.Application.Features.Auth.DeviceLoginService deviceLogin) : ApiControllerBase
{
    /// <summary>The server's public VAPID key (for subscribing) and how many devices the person has.</summary>
    [HttpGet]
    public async Task<IActionResult> Status(CancellationToken ct) => Ok(await push.StatusAsync(ct));

    [HttpPost("subscriptions")]
    public async Task<IActionResult> Subscribe([FromBody] PushSubscribeRequest req, CancellationToken ct) =>
        Ok(await push.SubscribeAsync(req, Request.Headers.UserAgent.ToString(), ct));

    /// <summary>The Android app's device token (Firebase Cloud Messaging).</summary>
    [HttpPost("native")]
    public async Task<IActionResult> SubscribeNative([FromBody] NativePushRequest req, CancellationToken ct) =>
        Ok(await push.SubscribeNativeAsync(req, Request.Headers.UserAgent.ToString(), ct));

    [HttpPost("unsubscribe")]
    public async Task<IActionResult> Unsubscribe([FromBody] PushEndpointRequest req, CancellationToken ct) => Ok(await push.UnsubscribeAsync(req.Endpoint, ct));

    /// <summary>Whether this device approves sign-ins on other screens, and whether the plan allows it.</summary>
    [HttpGet("sign-in")]
    public async Task<IActionResult> SignInStatus([FromQuery] string? endpoint, CancellationToken ct) => Ok(await deviceLogin.StatusAsync(endpoint, ct));

    /// <summary>Chooses (or stops using) this device to approve sign-ins. A plan feature: Free workspaces are refused.</summary>
    [HttpPut("sign-in")]
    public async Task<IActionResult> SetSignIn([FromBody] SignInDeviceRequest req, CancellationToken ct) => Ok(await deviceLogin.SetDeviceAsync(req.Endpoint, req.Enabled, ct));
}
