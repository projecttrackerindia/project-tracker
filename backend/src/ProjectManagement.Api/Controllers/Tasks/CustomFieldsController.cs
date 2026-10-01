using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.Tasks;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Tasks;

/// <summary>Workspace-defined extra fields and their values on tasks.</summary>
[Route("api/v1"), RequireWorkspace]
public class CustomFieldsController(CustomFieldService fields) : ApiControllerBase
{
    [HttpGet("custom-fields")]
    public async Task<IActionResult> List(CancellationToken ct) => Ok(await fields.ListAsync(ct));

    [HttpPost("custom-fields")]
    public async Task<IActionResult> Create([FromBody] UpsertCustomFieldRequest req, CancellationToken ct) => Created(await fields.CreateAsync(req, ct));

    [HttpPut("custom-fields/order")]
    public async Task<IActionResult> Order([FromBody] OrderCustomFieldsRequest req, CancellationToken ct) => Ok(await fields.ReorderAsync(req, ct));

    [HttpPut("custom-fields/{id:guid}")]
    public async Task<IActionResult> Update(Guid id, [FromBody] UpsertCustomFieldRequest req, CancellationToken ct) => Ok(await fields.UpdateAsync(id, req, ct));

    [HttpDelete("custom-fields/{id:guid}")]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
    {
        await fields.DeleteAsync(id, ct);
        return NoContent();
    }

    [HttpGet("tasks/{taskId:guid}/custom-fields"), RequireModule(Modules.Tasks)]
    public async Task<IActionResult> Values(Guid taskId, CancellationToken ct) => Ok(await fields.GetValuesAsync(taskId, ct));

    [HttpPut("tasks/{taskId:guid}/custom-fields"), RequireModule(Modules.Tasks, AccessLevel.Edit)]
    public async Task<IActionResult> SetValues(Guid taskId, [FromBody] SetCustomFieldValuesRequest req, CancellationToken ct) => Ok(await fields.SetValuesAsync(taskId, req, ct));
}
