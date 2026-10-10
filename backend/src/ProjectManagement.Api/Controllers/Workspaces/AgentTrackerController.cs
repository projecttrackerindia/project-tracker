using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Common;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Ai;

namespace ProjectManagement.Api.Controllers.Workspaces;

[Route("api/v1/ai/tracker"), RequireWorkspace]
public sealed class AgentTrackerController(AgentTrackerService tracker, IAiDiagnostics diagnostics, AiAssistant assistant) : ApiControllerBase
{
    [HttpGet]
    public async Task<IActionResult> List([FromQuery] DateTime? from, [FromQuery] DateTime? to, [FromQuery] string? status,
        [FromQuery] string? model, [FromQuery] int page = 1, [FromQuery] int pageSize = 25, CancellationToken ct = default, [FromQuery] string? intent = null)
        => Ok(await tracker.ListAsync(from, to, status, model, page, pageSize, ct, intent));

    [HttpGet("health")]
    public async Task<IActionResult> Health(CancellationToken ct)
    { tracker.AuthorizeDiagnostics(); return Ok(await diagnostics.CheckAsync(ct)); }

    public record SwitchRequest(bool Enabled);
    [HttpPut("agent")]
    public async Task<IActionResult> Switch([FromBody] SwitchRequest request, CancellationToken ct)
        => Ok(await assistant.SetAllowedAsync(request.Enabled, ct));
}
