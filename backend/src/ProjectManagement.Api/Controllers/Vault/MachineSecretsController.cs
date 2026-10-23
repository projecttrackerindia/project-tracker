using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Vault;

namespace ProjectManagement.Api.Controllers.Vault;

/// <summary>
/// Where a GitHub Actions run reads a guarded collection, with the OpenID Connect token GitHub mints for that run (no stored credential).
/// The answer is never cached and never kept by the idempotency layer.
/// </summary>
[Route("api/v1/machine"), AllowAnonymous, SecretResponse]
public class MachineSecretsController(MachineAccess machines) : ApiControllerBase
{
    [HttpPost("github/{id:guid}/secrets")]
    public async Task<IActionResult> GitHub(Guid id, CancellationToken ct)
    {
        Response.Headers.CacheControl = "no-store, max-age=0";
        Response.Headers.Pragma = "no-cache";
        return Ok(await machines.ReadAsync(id, Request.Headers.Authorization.ToString(), ct));
    }
}
