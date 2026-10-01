using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Organization;
using ProjectManagement.Application.Features.Teams;
using ProjectManagement.Application.Features.Workspaces;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Workspaces;

[Route("api/v1/invitations")]
public class InvitationsController(WorkspaceService workspaces) : ApiControllerBase
{
    /// <summary>Lets the invitation page show workspace name and invited email before sign-in.</summary>
    [HttpGet("lookup"), AllowAnonymous]
    public async Task<IActionResult> Lookup([FromQuery] string token, CancellationToken ct) =>
        Ok(await workspaces.LookupInvitationAsync(token, ct));

    [HttpPost("accept")]
    public async Task<IActionResult> Accept([FromBody] AcceptInvitationRequest req, CancellationToken ct) =>
        Ok(await workspaces.AcceptInvitationAsync(req, ct));
}
