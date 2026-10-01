using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.Tasks;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Integrations;

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
