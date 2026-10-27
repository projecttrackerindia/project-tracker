using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Ai;

namespace ProjectManagement.Api.Controllers.Workspaces;

/// <summary>An agent's "Ask first" rows in the Home inbox: approve (carry it out, as you) or dismiss. Only the person a row is for decides it.</summary>
[Route("api/v1/ai/actions"), RequireWorkspace]
public sealed class AiActionsController(AiActionService actions) : ApiControllerBase
{
    [HttpPost("{id:guid}/approve")]
    public async Task<IActionResult> Approve(Guid id, CancellationToken ct) => Ok(await actions.ApproveAsync(id, ct));

    [HttpPost("{id:guid}/dismiss")]
    public async Task<IActionResult> Dismiss(Guid id, CancellationToken ct) => Ok(await actions.DismissAsync(id, ct));
}
