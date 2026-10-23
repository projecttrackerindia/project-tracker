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

    /// <summary>The event explorer: every event with its group and a sample payload.</summary>
    [HttpGet("catalogue")]
    public IActionResult Catalogue() => Ok(hooks.Explorer());

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

    /// <summary>A ping, or a sample of one event ({"event":"task.created"}) marked as a test.</summary>
    [HttpPost("{id:guid}/test")]
    public async Task<IActionResult> Test(Guid id, [FromBody(EmptyBodyBehavior = Microsoft.AspNetCore.Mvc.ModelBinding.EmptyBodyBehavior.Allow)] ProjectManagement.Application.Features.Integrations.WebhookTestRequest? req, CancellationToken ct) =>
        StatusCode(StatusCodes.Status202Accepted, await hooks.SendTestAsync(id, ct, string.IsNullOrWhiteSpace(req?.Event) ? null : req.Event.Trim()));

    /// <summary>The whole history (30 days), a page at a time.</summary>
    [HttpGet("{id:guid}/history")]
    public async Task<IActionResult> History(Guid id, [FromQuery] int page = 1, [FromQuery] int pageSize = 50, [FromQuery] string? status = null, [FromQuery(Name = "event")] string? eventType = null,
        [FromQuery] DateTime? from = null, [FromQuery] DateTime? to = null, CancellationToken ct = default) =>
        Ok(await hooks.HistoryAsync(id, page, pageSize, status, eventType, from?.ToUniversalTime(), to?.ToUniversalTime(), ct));

    [HttpGet("{id:guid}/deliveries/{deliveryId:guid}")]
    public async Task<IActionResult> Delivery(Guid id, Guid deliveryId, CancellationToken ct) => Ok(await hooks.DeliveryAsync(id, deliveryId, ct));

    [HttpPost("{id:guid}/deliveries/{deliveryId:guid}/replay")]
    public async Task<IActionResult> Replay(Guid id, Guid deliveryId, CancellationToken ct) => StatusCode(StatusCodes.Status202Accepted, await hooks.ReplayAsync(id, deliveryId, ct));

    /// <summary>Every failed (or every) delivery in a time window, sent again.</summary>
    [HttpPost("{id:guid}/replay")]
    public async Task<IActionResult> ReplayMany(Guid id, [FromBody] ProjectManagement.Application.Features.Integrations.WebhookReplayRequest req, CancellationToken ct) =>
        StatusCode(StatusCodes.Status202Accepted, new { queued = await hooks.ReplayManyAsync(id, req with { From = req.From?.ToUniversalTime(), To = req.To?.ToUniversalTime() }, ct) });

    [HttpGet("{id:guid}/health")]
    public async Task<IActionResult> Health(Guid id, [FromQuery] int days = 7, CancellationToken ct = default) => Ok(await hooks.HealthAsync(id, days, ct));

    [HttpPost("{id:guid}/deliveries/{deliveryId:guid}/retry")]
    public async Task<IActionResult> Retry(Guid id, Guid deliveryId, CancellationToken ct)
    {
        await hooks.RetryAsync(id, deliveryId, ct);
        return NoContent();
    }
}
