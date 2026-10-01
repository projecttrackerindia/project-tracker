using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Files;
using ProjectManagement.Application.Features.Work;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Work;

/// <summary>The workspace's list of kinds of work (Bug Fix, Data Preparation ...): everyone with Work management can read it; managing it is a permission.</summary>
[Route("api/v1/work-types"), RequireWorkspace, RequireModule(Modules.Work)]
public class WorkTypesController(WorkTypeService types) : ApiControllerBase
{
    [HttpGet]
    public async Task<IActionResult> List([FromQuery] bool includeInactive, CancellationToken ct) => Ok(await types.ListAsync(includeInactive, ct));

    [HttpPost, RequireModule(Modules.Work, AccessLevel.Edit)]
    public async Task<IActionResult> Create([FromBody] UpsertWorkTypeRequest req, CancellationToken ct) => Created(await types.CreateAsync(req, ct));

    [HttpPut("{id:guid}"), RequireModule(Modules.Work, AccessLevel.Edit)]
    public async Task<IActionResult> Update(Guid id, [FromBody] UpsertWorkTypeRequest req, CancellationToken ct) => Ok(await types.UpdateAsync(id, req, ct));

    [HttpPut("order"), RequireModule(Modules.Work, AccessLevel.Edit)]
    public async Task<IActionResult> Reorder([FromBody] ReorderWorkTypesRequest req, CancellationToken ct)
    {
        await types.ReorderAsync(req, ct);
        return NoContent();
    }

    [HttpDelete("{id:guid}"), RequireModule(Modules.Work, AccessLevel.Edit)]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
    {
        await types.DeleteAsync(id, ct);
        return NoContent();
    }
}
