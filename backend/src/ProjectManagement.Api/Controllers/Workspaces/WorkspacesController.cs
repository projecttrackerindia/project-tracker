using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Organization;
using ProjectManagement.Application.Features.Teams;
using ProjectManagement.Application.Features.Workspaces;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Workspaces;

/// <summary>Workspaces the signed-in user belongs to; switching is validated against membership server-side.</summary>
[Route("api/v1/workspaces")]
public class WorkspacesController(WorkspaceService workspaces) : ApiControllerBase
{
    [HttpGet]
    public async Task<IActionResult> List(CancellationToken ct) => Ok(await workspaces.ListAsync(ct));

    [HttpPost]
    public async Task<IActionResult> CreateOrganization([FromBody] CreateWorkspaceRequest req, CancellationToken ct) =>
        Created(await workspaces.CreateOrganizationAsync(req, ct));

    [HttpPost("{id:guid}/switch")]
    public async Task<IActionResult> Switch(Guid id, CancellationToken ct) => Ok(await workspaces.SwitchAsync(id, ct));
}
