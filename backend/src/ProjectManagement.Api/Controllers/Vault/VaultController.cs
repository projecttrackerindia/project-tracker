using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Application.Features.Vault;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Api.Controllers.Vault;

/// <summary>
/// The team password vault. Lists and item pages carry names, hints and the shape of each item, never a secret value: a value leaves the server
/// only through <c>reveal</c> (one field), <c>totp</c> (the current code, not the seed) or an attachment download, each checked, rate-limited
/// and written to the audit trail. No vault response is ever cached.
/// </summary>
[Route("api/v1/vault"), RequireWorkspace, SecretResponse]
public class VaultController(VaultService vault, StepUpService stepUp) : ApiControllerBase
{
    private const long UploadCeiling = VaultService.MaxAttachmentBytes + 256 * 1024;

    private void NoStore()
    {
        Response.Headers.CacheControl = "no-store, max-age=0";
        Response.Headers.Pragma = "no-cache";
    }

    [HttpGet("overview")]
    public async Task<IActionResult> Overview(CancellationToken ct) { NoStore(); return Ok(await vault.OverviewAsync(ct)); }

    [HttpPost("step-up")]
    public async Task<IActionResult> StepUp([FromBody] StepUpRequest req, CancellationToken ct) { NoStore(); return Ok(await stepUp.VerifyAsync(req, ct)); }

    // ------------------------------------------------------------- collections

    [HttpPost("collections")]
    public async Task<IActionResult> CreateCollection([FromBody] SaveVaultCollectionRequest req, CancellationToken ct) { NoStore(); return Created(await vault.CreateCollectionAsync(req, ct)); }

    [HttpGet("collections/{id:guid}")]
    public async Task<IActionResult> Collection(Guid id, CancellationToken ct) { NoStore(); return Ok(await vault.CollectionDtoAsync(id, ct)); }

    [HttpPut("collections/{id:guid}")]
    public async Task<IActionResult> UpdateCollection(Guid id, [FromBody] SaveVaultCollectionRequest req, CancellationToken ct) { NoStore(); return Ok(await vault.UpdateCollectionAsync(id, req, ct)); }

    [HttpDelete("collections/{id:guid}")]
    public async Task<IActionResult> DeleteCollection(Guid id, CancellationToken ct) { await vault.DeleteCollectionAsync(id, ct); return NoContent(); }

    [HttpPut("collections/{id:guid}/shares")]
    public async Task<IActionResult> Shares(Guid id, [FromBody] SaveVaultSharesRequest req, CancellationToken ct) { NoStore(); return Ok(await vault.SaveSharesAsync(id, req, ct)); }

    [HttpPost("collections/{id:guid}/admin-access")]
    public async Task<IActionResult> AdminAccess(Guid id, [FromBody] VaultAdminAccessRequest req, CancellationToken ct) { NoStore(); return Ok(await vault.AdminAccessAsync(id, req, ct)); }

    // ------------------------------------------------------------- items

    [HttpGet("items")]
    public async Task<IActionResult> Items([FromQuery] Guid? collectionId, [FromQuery] string? q, [FromQuery] VaultItemKind? kind, [FromQuery] string? health, [FromQuery] bool bin, CancellationToken ct)
    { NoStore(); return Ok(await vault.ItemsAsync(collectionId, q, kind, health, bin, ct)); }

    [HttpGet("items/{id:guid}")]
    public async Task<IActionResult> Item(Guid id, CancellationToken ct) { NoStore(); return Ok(await vault.GetAsync(id, ct)); }

    [HttpPost("items")]
    public async Task<IActionResult> CreateItem([FromBody] SaveVaultItemRequest req, CancellationToken ct) { NoStore(); return Created(await vault.CreateItemAsync(req, ct)); }

    [HttpPut("items/{id:guid}")]
    public async Task<IActionResult> UpdateItem(Guid id, [FromBody] SaveVaultItemRequest req, CancellationToken ct) { NoStore(); return Ok(await vault.UpdateItemAsync(id, req, ct)); }

    [HttpDelete("items/{id:guid}")]
    public async Task<IActionResult> DeleteItem(Guid id, CancellationToken ct) { await vault.DeleteItemAsync(id, ct); return NoContent(); }

    [HttpPost("items/{id:guid}/restore")]
    public async Task<IActionResult> RestoreItem(Guid id, CancellationToken ct) { NoStore(); return Ok(await vault.RestoreItemAsync(id, ct)); }

    [HttpPost("items/{id:guid}/reveal")]
    public async Task<IActionResult> Reveal(Guid id, [FromBody] VaultRevealRequest req, CancellationToken ct) { NoStore(); return Ok(await vault.RevealAsync(id, req, ct)); }

    [HttpPost("items/{id:guid}/totp")]
    public async Task<IActionResult> Totp(Guid id, [FromBody] VaultStepUpRequest req, CancellationToken ct) { NoStore(); return Ok(await vault.TotpAsync(id, req, ct)); }

    [HttpPost("items/{id:guid}/versions/{versionId:guid}/reveal")]
    public async Task<IActionResult> RevealVersion(Guid id, Guid versionId, [FromBody] VaultRevealRequest req, CancellationToken ct)
    { NoStore(); return Ok(await vault.RevealVersionAsync(id, versionId, req, ct)); }

    [HttpGet("items/{id:guid}/activity")]
    public async Task<IActionResult> Activity(Guid id, CancellationToken ct) { NoStore(); return Ok(await vault.ActivityAsync(id, ct)); }

    // ------------------------------------------------------------- files

    [HttpPost("items/{id:guid}/attachments")]
    [RequestSizeLimit(UploadCeiling), RequestFormLimits(MultipartBodyLengthLimit = UploadCeiling)]
    public async Task<IActionResult> Upload(Guid id, IFormFile file, CancellationToken ct)
    {
        NoStore();
        await using var stream = file.OpenReadStream();
        return Created(await vault.AddAttachmentAsync(id, file.FileName, file.ContentType, stream, file.Length, ct));
    }

    /// <summary>A POST so the two-step token travels in the body, never in an address that could be logged.</summary>
    [HttpPost("attachments/{attachmentId:guid}/download")]
    public async Task<IActionResult> Download(Guid attachmentId, [FromBody] VaultStepUpRequest req, CancellationToken ct)
    {
        NoStore();
        var (name, type, bytes) = await vault.DownloadAttachmentAsync(attachmentId, req.StepUp, ct);
        Response.Headers["X-Content-Type-Options"] = "nosniff";
        return File(bytes, "application/octet-stream", name);   // always a download, never rendered in the page
    }

    [HttpDelete("attachments/{attachmentId:guid}")]
    public async Task<IActionResult> DeleteAttachment(Guid attachmentId, CancellationToken ct) { await vault.DeleteAttachmentAsync(attachmentId, ct); return NoContent(); }

    // ------------------------------------------------------------- tools and administration

    [HttpPost("import")]
    [RequestSizeLimit(4 * 1024 * 1024)]
    public async Task<IActionResult> Import([FromBody] VaultImportRequest req, CancellationToken ct) { NoStore(); return Ok(await vault.ImportAsync(req, ct)); }

    [HttpPost("check")]
    public async Task<IActionResult> Check([FromBody] VaultCheckRequest req, CancellationToken ct) { NoStore(); return Ok(await vault.CheckAsync(req, ct)); }

    [HttpPut("policy")]
    public async Task<IActionResult> Policy([FromBody] VaultPolicyRequest req, CancellationToken ct) { NoStore(); return Ok(await vault.SavePolicyAsync(req, ct)); }

    [HttpGet("access-review/{userId:guid}")]
    public async Task<IActionResult> AccessReview(Guid userId, CancellationToken ct) { NoStore(); return Ok(await vault.AccessReviewAsync(userId, ct)); }
}
