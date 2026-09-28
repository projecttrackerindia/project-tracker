using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers;

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

/// <summary>Feeds the Project Status presentation page.</summary>
[Route("api/v1/project-status"), RequireWorkspace, RequireModule(Modules.Projects)]
public class ProjectStatusController(ProjectStatusService status) : ApiControllerBase
{
    /// <summary>The projects organized by group, for the page's sidebar.</summary>
    [HttpGet("groups")]
    public async Task<IActionResult> Groups(CancellationToken ct) => Ok(await status.GroupsAsync(ct));

    /// <summary>One project's status: its tasks, the history of its delivery dates and what is blocking work.</summary>
    [HttpGet("projects/{id:guid}")]
    public async Task<IActionResult> Report(Guid id, CancellationToken ct) => Ok(await status.ReportAsync(id, ct));
}

/// <summary>Action items of a project: follow-ups with an owner, a due date and a priority, shown on the Project Status page.</summary>
[Route("api/v1/projects/{projectId:guid}/action-items"), RequireWorkspace, RequireModule(Modules.Projects)]
public class ActionItemsController(ActionItemService items) : ApiControllerBase
{
    [HttpGet]
    public async Task<IActionResult> List(Guid projectId, CancellationToken ct) => Ok(await items.ListAsync(projectId, ct));

    [HttpPost]
    public async Task<IActionResult> Create(Guid projectId, [FromBody] CreateActionItemRequest req, CancellationToken ct) => Created(await items.CreateAsync(projectId, req, ct));

    [HttpPut("{id:guid}")]
    public async Task<IActionResult> Update(Guid projectId, Guid id, [FromBody] UpdateActionItemRequest req, CancellationToken ct) => Ok(await items.UpdateAsync(projectId, id, req, ct));

    /// <summary>Quick status change (tick it off, reopen it).</summary>
    [HttpPut("{id:guid}/status")]
    public async Task<IActionResult> SetStatus(Guid projectId, Guid id, [FromBody] SetActionItemStatusRequest req, CancellationToken ct) => Ok(await items.SetStatusAsync(projectId, id, req, ct));

    [HttpDelete("{id:guid}")]
    public async Task<IActionResult> Delete(Guid projectId, Guid id, CancellationToken ct)
    {
        await items.DeleteAsync(projectId, id, ct);
        return NoContent();
    }
}
