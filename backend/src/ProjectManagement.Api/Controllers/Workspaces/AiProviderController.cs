using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Ai;

namespace ProjectManagement.Api.Controllers.Workspaces;

/// <summary>
/// The workspace's own Claude or ChatGPT key (owners and admins: check it, choose models, switch it on or off, remove it) and each person's
/// one-time agreement to have their questions answered on it.
/// </summary>
[Route("api/v1"), RequireWorkspace]
public sealed class AiProviderController(WorkspaceAiService service) : ApiControllerBase
{
    [HttpGet("workspace/ai-provider")]
    public async Task<IActionResult> Get(CancellationToken ct) => Ok(await service.GetAsync(ct));

    /// <summary>Asks the provider which models the key may use - the check that the key works. Nothing is saved.</summary>
    [HttpPost("workspace/ai-provider/check")]
    public async Task<IActionResult> Check([FromBody] CheckAiKeyRequest req, CancellationToken ct) => Ok(await service.CheckAsync(req, ct));

    [HttpPut("workspace/ai-provider")]
    public async Task<IActionResult> Save([FromBody] SaveAiProviderRequest req, CancellationToken ct) => Ok(await service.SaveAsync(req, ct));

    [HttpDelete("workspace/ai-provider")]
    public async Task<IActionResult> Remove(CancellationToken ct) { await service.RemoveAsync(ct); return NoContent(); }

    [HttpGet("ai/provider-status")]
    public async Task<IActionResult> Status(CancellationToken ct) => Ok(await service.StatusAsync(ct));

    [HttpPost("ai/provider-consent")]
    public async Task<IActionResult> Agree(CancellationToken ct) => Ok(await service.AgreeAsync(ct));

    [HttpDelete("ai/provider-consent")]
    public async Task<IActionResult> Withdraw(CancellationToken ct) => Ok(await service.WithdrawAsync(ct));
}
