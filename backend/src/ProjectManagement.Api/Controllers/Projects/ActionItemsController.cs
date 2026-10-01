using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Projects;

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
