using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Organization;
using ProjectManagement.Application.Features.Teams;
using ProjectManagement.Application.Features.Workspaces;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Teams;

[Route("api/v1/teams"), RequireWorkspace, RequireModule(Modules.Teams)]
public class TeamsController(TeamService teams) : ApiControllerBase
{
    [HttpGet]
    public async Task<IActionResult> List(CancellationToken ct) => Ok(await teams.ListAsync(ct));

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] UpsertTeamRequest req, CancellationToken ct) => Created(await teams.CreateAsync(req, ct));

    [HttpGet("{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct) => Ok(await teams.GetAsync(id, ct));

    [HttpPut("{id:guid}")]
    public async Task<IActionResult> Update(Guid id, [FromBody] UpsertTeamRequest req, CancellationToken ct) => Ok(await teams.UpdateAsync(id, req, ct));

    [HttpDelete("{id:guid}")]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
    {
        await teams.DeleteAsync(id, ct);
        return NoContent();
    }

    [HttpPost("{id:guid}/members")]
    public async Task<IActionResult> AddMember(Guid id, [FromBody] AddTeamMemberRequest req, CancellationToken ct) =>
        Ok(await teams.AddMemberAsync(id, req, ct));

    [HttpDelete("{id:guid}/members/{userId:guid}")]
    public async Task<IActionResult> RemoveMember(Guid id, Guid userId, CancellationToken ct) =>
        Ok(await teams.RemoveMemberAsync(id, userId, ct));
}
