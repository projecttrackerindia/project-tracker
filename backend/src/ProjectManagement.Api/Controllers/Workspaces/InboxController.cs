using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Inbox;

namespace ProjectManagement.Api.Controllers.Workspaces;

/// <summary>Home's inbox: what waits on the signed-in person, gathered from the places it already lives, and the briefing above it.</summary>
[Route("api/v1/inbox"), RequireWorkspace]
public class InboxController(InboxService inbox) : ApiControllerBase
{
    /// <summary>Rows for all, assigned, decisions or mentions; each carries one primary action (done in place, or a link to open).</summary>
    [HttpGet]
    public async Task<IActionResult> List([FromQuery] string? filter, CancellationToken ct) => Ok(await inbox.GetAsync(filter, ct));

    /// <summary>Counts and plain reasons found by rules - no model call, so it works with AI switched off.</summary>
    [HttpGet("briefing")]
    public async Task<IActionResult> Briefing(CancellationToken ct) => Ok(await inbox.BriefingAsync(ct));

    /// <summary>Hides one row for this person until tomorrow morning.</summary>
    [HttpPost("{id}/later")]
    public async Task<IActionResult> Later(string id, CancellationToken ct)
    {
        await inbox.LaterAsync(id, ct);
        return NoContent();
    }
}
