using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.Tasks;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers;

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

/// <summary>Workspace names and colours for the four priority levels.</summary>
[Route("api/v1/priorities"), RequireWorkspace]
public class PrioritiesController(PriorityService priorities) : ApiControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken ct) => Ok(await priorities.GetAsync(ct));

    [HttpPut]
    public async Task<IActionResult> Set([FromBody] SetPrioritiesRequest req, CancellationToken ct) => Ok(await priorities.SetAsync(req, ct));

    [HttpDelete]
    public async Task<IActionResult> Reset(CancellationToken ct) => Ok(await priorities.ResetAsync(ct));
}

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

/// <summary>API keys of the workspace (owners and admins).</summary>
[Route("api/v1/api-keys"), RequireWorkspace]
public class ApiKeysController(ProjectManagement.Application.Features.Integrations.ApiKeyService keys) : ApiControllerBase
{
    [HttpGet]
    public async Task<IActionResult> List(CancellationToken ct) => Ok(await keys.ListAsync(ct));

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] ProjectManagement.Application.Features.Integrations.CreateApiKeyRequest req, CancellationToken ct) => Created(await keys.CreateAsync(req, ct));

    [HttpDelete("{id:guid}")]
    public async Task<IActionResult> Revoke(Guid id, CancellationToken ct)
    {
        await keys.RevokeAsync(id, ct);
        return NoContent();
    }
}

/// <summary>Webhooks of the workspace (owners and admins).</summary>
[Route("api/v1/webhooks"), RequireWorkspace]
public class WebhooksController(ProjectManagement.Application.Features.Integrations.WebhookService hooks) : ApiControllerBase
{
    [HttpGet]
    public async Task<IActionResult> List(CancellationToken ct) => Ok(await hooks.ListAsync(ct));

    [HttpGet("events")]
    public IActionResult Events() => Ok(hooks.Catalogue());

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] ProjectManagement.Application.Features.Integrations.UpsertWebhookRequest req, CancellationToken ct) => Created(await hooks.CreateAsync(req, ct));

    [HttpPut("{id:guid}")]
    public async Task<IActionResult> Update(Guid id, [FromBody] ProjectManagement.Application.Features.Integrations.UpsertWebhookRequest req, CancellationToken ct) => Ok(await hooks.UpdateAsync(id, req, ct));

    [HttpPost("{id:guid}/rotate-secret")]
    public async Task<IActionResult> Rotate(Guid id, CancellationToken ct) => Ok(await hooks.RotateSecretAsync(id, ct));

    [HttpDelete("{id:guid}")]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
    {
        await hooks.DeleteAsync(id, ct);
        return NoContent();
    }

    [HttpGet("{id:guid}/deliveries")]
    public async Task<IActionResult> Deliveries(Guid id, CancellationToken ct) => Ok(await hooks.DeliveriesAsync(id, ct));

    [HttpPost("{id:guid}/test")]
    public async Task<IActionResult> Test(Guid id, CancellationToken ct) => StatusCode(StatusCodes.Status202Accepted, await hooks.SendTestAsync(id, ct));

    [HttpPost("{id:guid}/deliveries/{deliveryId:guid}/retry")]
    public async Task<IActionResult> Retry(Guid id, Guid deliveryId, CancellationToken ct)
    {
        await hooks.RetryAsync(id, deliveryId, ct);
        return NoContent();
    }
}

/// <summary>The people who report to me in the organization chart, and how their work is going (read-only).</summary>
[Route("api/v1/my-team"), RequireWorkspace]
public class MyTeamController(ProjectManagement.Application.Features.Organization.ReportingService reporting) : ApiControllerBase
{
    [HttpGet, RequireModule(Modules.Tasks)]
    public async Task<IActionResult> Get(CancellationToken ct) => Ok(await reporting.GetMyTeamAsync(ct));

    [HttpGet("{userId:guid}"), RequireModule(Modules.Tasks)]
    public async Task<IActionResult> Person(Guid userId, CancellationToken ct) => Ok(await reporting.GetPersonAsync(userId, ct));
}
