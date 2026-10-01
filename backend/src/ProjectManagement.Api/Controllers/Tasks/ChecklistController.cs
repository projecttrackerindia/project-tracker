using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.Tasks;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Tasks;

/// <summary>The checklist of a task.</summary>
[Route("api/v1/tasks/{taskId:guid}/checklist"), RequireWorkspace]
public class ChecklistController(ChecklistService checklist) : ApiControllerBase
{
    [HttpGet, RequireModule(Modules.Tasks)]
    public async Task<IActionResult> Get(Guid taskId, CancellationToken ct) => Ok(await checklist.GetAsync(taskId, ct));

    [HttpPost, RequireModule(Modules.Tasks, AccessLevel.Edit)]
    public async Task<IActionResult> Add(Guid taskId, [FromBody] AddChecklistItemRequest req, CancellationToken ct) => Created(await checklist.AddAsync(taskId, req, ct));

    [HttpPut("{itemId:guid}"), RequireModule(Modules.Tasks, AccessLevel.Edit)]
    public async Task<IActionResult> Update(Guid taskId, Guid itemId, [FromBody] UpdateChecklistItemRequest req, CancellationToken ct) => Ok(await checklist.UpdateAsync(taskId, itemId, req, ct));

    [HttpDelete("{itemId:guid}"), RequireModule(Modules.Tasks, AccessLevel.Edit)]
    public async Task<IActionResult> Delete(Guid taskId, Guid itemId, CancellationToken ct) => Ok(await checklist.DeleteAsync(taskId, itemId, ct));

    [HttpPut("order"), RequireModule(Modules.Tasks, AccessLevel.Edit)]
    public async Task<IActionResult> Reorder(Guid taskId, [FromBody] ReorderChecklistRequest req, CancellationToken ct) => Ok(await checklist.ReorderAsync(taskId, req, ct));
}
