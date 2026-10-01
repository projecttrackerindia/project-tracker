using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Application.Features.Notifications;

namespace ProjectManagement.Api.Controllers.Auth;

public record PushEndpointRequest(string? Endpoint);

/// <summary>Push notifications on the signed-in person's devices (they apply in every workspace).</summary>
[Route("api/v1/push")]
public class PushController(PushService push) : ApiControllerBase
{
    /// <summary>The server's public VAPID key (for subscribing) and how many devices the person has.</summary>
    [HttpGet]
    public async Task<IActionResult> Status(CancellationToken ct) => Ok(await push.StatusAsync(ct));

    [HttpPost("subscriptions")]
    public async Task<IActionResult> Subscribe([FromBody] PushSubscribeRequest req, CancellationToken ct) =>
        Ok(await push.SubscribeAsync(req, Request.Headers.UserAgent.ToString(), ct));

    [HttpPost("unsubscribe")]
    public async Task<IActionResult> Unsubscribe([FromBody] PushEndpointRequest req, CancellationToken ct) => Ok(await push.UnsubscribeAsync(req.Endpoint, ct));
}
