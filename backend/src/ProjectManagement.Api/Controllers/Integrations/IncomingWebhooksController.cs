using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Integrations;

namespace ProjectManagement.Api.Controllers.Integrations;

/// <summary>Incoming webhooks of the workspace: addresses other systems post to, turned into tickets, tasks or reminders (owners and admins).</summary>
[Route("api/v1/incoming-webhooks"), RequireWorkspace]
public class IncomingWebhooksController(IncomingWebhookService hooks) : ApiControllerBase
{
    [HttpGet]
    public async Task<IActionResult> List(CancellationToken ct) => Ok(await hooks.ListAsync(ct));

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] SaveIncomingWebhookRequest req, CancellationToken ct) => Created(await hooks.CreateAsync(req, ct));

    [HttpPut("{id:guid}")]
    public async Task<IActionResult> Update(Guid id, [FromBody] SaveIncomingWebhookRequest req, CancellationToken ct) => Ok(await hooks.UpdateAsync(id, req, ct));

    [HttpPost("{id:guid}/rotate")]
    public async Task<IActionResult> Rotate(Guid id, CancellationToken ct) => Ok(await hooks.RotateAsync(id, ct));

    [HttpDelete("{id:guid}")]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
    {
        await hooks.DeleteAsync(id, ct);
        return NoContent();
    }

    /// <summary>The last request received, to set the mapping by example.</summary>
    [HttpGet("{id:guid}/sample")]
    public async Task<IActionResult> Sample(Guid id, CancellationToken ct) => Ok(new { sample = await hooks.SampleAsync(id, ct) });

    [HttpGet("{id:guid}/events")]
    public async Task<IActionResult> Events(Guid id, [FromQuery] int page = 1, [FromQuery] int pageSize = 50, [FromQuery] string? status = null, CancellationToken ct = default) =>
        Ok(await hooks.EventsAsync(id, page, pageSize, status, ct));

    /// <summary>What a mapping makes of an example request.</summary>
    [HttpPost("preview")]
    public IActionResult Preview([FromBody] IncomingPreviewRequest req) => Ok(hooks.Preview(req));

    /// <summary>A first mapping guessed from an example request.</summary>
    [HttpPost("suggest")]
    public IActionResult Suggest([FromBody] IncomingPreviewRequest req) => Ok(hooks.Suggest(req.Sample));
}
