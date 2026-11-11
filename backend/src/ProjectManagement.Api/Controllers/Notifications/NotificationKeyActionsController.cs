using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Application.Features.Notifications;

namespace ProjectManagement.Api.Controllers.Notifications;

/// <summary>
/// A button pressed on a notification outside the app (Web Push, the desktop app, the phone apps): the signed, short-lived, single-use key stands
/// in for signing in. CurrentContextMiddleware has already signed the request in as the key's person in the key's workspace.
/// </summary>
[Route("api/v1/notification-actions"), AllowAnonymous]
public class NotificationKeyActionsController(QuickActionService quick) : ApiControllerBase
{
    [HttpPost("{token}")]
    public async Task<IActionResult> Act(string token, [FromBody] QuickActionRequest req, CancellationToken ct) => Ok(await quick.RedeemAsync(token, req, ct));
}
