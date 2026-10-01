using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.Tasks;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Integrations;

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
