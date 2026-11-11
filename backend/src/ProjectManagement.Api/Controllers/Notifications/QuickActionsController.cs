using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Application.Features.Notifications;

namespace ProjectManagement.Api.Controllers.Notifications;

/// <summary>Quick actions for the signed-in app: a key for a notice the desktop or phone app shows natively, and acting from an in-app banner.</summary>
[Route("api/v1/notifications")]
public class QuickActionsController(QuickActionService quick) : ApiControllerBase
{
    [HttpPost("{id:guid}/quick-key")]
    public async Task<IActionResult> Key(Guid id, CancellationToken ct) => Ok(await quick.IssueAsync(id, ct));

    [HttpPost("{id:guid}/quick")]
    public async Task<IActionResult> Act(Guid id, [FromBody] QuickActionRequest req, CancellationToken ct) => Ok(await quick.ActForMeAsync(id, req, ct));
}

