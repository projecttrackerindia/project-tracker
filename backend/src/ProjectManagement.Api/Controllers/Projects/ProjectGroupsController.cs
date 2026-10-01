using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Projects;

/// <summary>The workspace's master list of project groups. Reading needs access to Projects; changing it needs the "manage project groups" permission.</summary>
[Route("api/v1/project-groups"), RequireWorkspace, RequireModule(Modules.Projects)]
public class ProjectGroupsController(ProjectGroupService groups) : ApiControllerBase
{
    [HttpGet]
    public async Task<IActionResult> List([FromQuery] bool activeOnly, CancellationToken ct) => Ok(await groups.ListAsync(activeOnly, ct));

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] UpsertProjectGroupRequest req, CancellationToken ct) => Created(await groups.CreateAsync(req, ct));

    [HttpPut("{id:guid}")]
    public async Task<IActionResult> Update(Guid id, [FromBody] UpsertProjectGroupRequest req, CancellationToken ct) => Ok(await groups.UpdateAsync(id, req, ct));

    /// <summary>The whole list in its new order (every group once).</summary>
    [HttpPut("order")]
    public async Task<IActionResult> Reorder([FromBody] ReorderProjectGroupsRequest req, CancellationToken ct) => Ok(await groups.ReorderAsync(req, ct));

    /// <summary>Deletes a group. When it still has projects, <c>moveTo</c> names the active group they are moved to first.</summary>
    [HttpDelete("{id:guid}")]
    public async Task<IActionResult> Delete(Guid id, [FromQuery] Guid? moveTo, CancellationToken ct)
    {
        await groups.DeleteAsync(id, moveTo, ct);
        return NoContent();
    }
}
