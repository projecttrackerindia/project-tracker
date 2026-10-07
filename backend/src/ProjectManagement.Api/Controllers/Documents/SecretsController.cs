using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Documents;

/// <summary>
/// Secrets kept with a document, and the workspace's controls for them. Lists carry names only; the value leaves the server solely through a reveal, which
/// is permission-checked, rate-limited and audited whether it succeeds or not. Responses are never cached.
/// </summary>
[Route("api/v1"), RequireWorkspace, RequireModule(Modules.Documents)]
public class SecretsController(SecretService secrets, StepUpService stepUp, DocumentSecurityService security) : ApiControllerBase
{
    [HttpGet("documents/{id:guid}/secrets")]
    public async Task<IActionResult> List(Guid id, CancellationToken ct) => Ok(await secrets.ListAsync(id, ct));

    [HttpPost("documents/{id:guid}/secrets")]
    public async Task<IActionResult> Add(Guid id, [FromBody] SaveSecretRequest req, CancellationToken ct) => Created(await secrets.SaveAsync(id, null, req, ct));

    [HttpPut("documents/{id:guid}/secrets/{secretId:guid}")]
    public async Task<IActionResult> Update(Guid id, Guid secretId, [FromBody] SaveSecretRequest req, CancellationToken ct) => Ok(await secrets.SaveAsync(id, secretId, req, ct));

    [HttpDelete("documents/{id:guid}/secrets/{secretId:guid}")]
    public async Task<IActionResult> Delete(Guid id, Guid secretId, CancellationToken ct) => Ok(await secrets.DeleteAsync(id, secretId, ct));

    [HttpPost("documents/{id:guid}/secrets/{secretId:guid}/reveal")]
    public async Task<IActionResult> Reveal(Guid id, Guid secretId, [FromBody] RevealRequest req, CancellationToken ct)
    {
        Response.Headers.CacheControl = "no-store";
        return Ok(await secrets.RevealAsync(id, secretId, req, ct));
    }

    [HttpPost("documents/step-up")]
    public async Task<IActionResult> StepUp([FromBody] StepUpRequest req, CancellationToken ct)
    {
        Response.Headers.CacheControl = "no-store";
        return Ok(await stepUp.VerifyAsync(req, ct));
    }

    [HttpGet("document-security")]
    public async Task<IActionResult> Security(CancellationToken ct) => Ok(await security.GetAsync(ct));

    [HttpPut("document-security/reveal-duration")]
    public async Task<IActionResult> SetReveal([FromBody] SetRevealRequest req, CancellationToken ct) => Ok(await security.SetRevealAsync(req, ct));

    [HttpPost("document-security/rotate-key")]
    public async Task<IActionResult> Rotate(CancellationToken ct) => Ok(await security.RotateAsync(ct));

    [HttpPost("document-security/verify-audit")]
    public async Task<IActionResult> VerifyAudit(CancellationToken ct) => Ok(await security.VerifyChainAsync(ct));
}
