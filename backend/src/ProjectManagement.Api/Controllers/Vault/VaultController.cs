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
public class VaultController(VaultService vault, StepUpService stepUp, ProjectManagement.Application.Features.Auth.PasskeyService passkeys) : ApiControllerBase
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

    // ------------------------------------------------------------- sealed (zero-knowledge): keys made and used in the browser

    [HttpGet("keys/me")]
    public async Task<IActionResult> KeysMe(CancellationToken ct) { NoStore(); return Ok(await vault.KeysMeAsync(ct)); }

    [HttpPost("keys/setup")]
    public async Task<IActionResult> SetupKeys([FromBody] VaultSetupRequest req, CancellationToken ct) { NoStore(); return Ok(await vault.SetupKeysAsync(req, ct)); }

    [HttpPost("keys/unlocks")]
    public async Task<IActionResult> AddUnlock([FromBody] VaultUnlockInput req, CancellationToken ct) { NoStore(); return Ok(await vault.AddUnlockAsync(req, ct)); }

    [HttpDelete("keys/unlocks/{id:guid}")]
    public async Task<IActionResult> RemoveUnlock(Guid id, CancellationToken ct) { NoStore(); return Ok(await vault.RemoveUnlockAsync(id, ct)); }

    [HttpPost("keys/unlocks/{id:guid}/used")]
    public async Task<IActionResult> Unlocked(Guid id, CancellationToken ct) { await vault.UnlockedAsync(id, ct); return NoContent(); }

    [HttpPost("keys/directory")]
    public async Task<IActionResult> Directory([FromBody] VaultDirectoryRequest req, CancellationToken ct) { NoStore(); return Ok(await vault.DirectoryAsync(req.UserIds, ct)); }

    [HttpGet("collections/{id:guid}/keys")]
    public async Task<IActionResult> CollectionKeys(Guid id, CancellationToken ct) { NoStore(); return Ok(await vault.CollectionKeysAsync(id, ct)); }

    [HttpPost("collections/{id:guid}/keys")]
    public async Task<IActionResult> SaveEnvelopes(Guid id, [FromBody] VaultEnvelopesRequest req, CancellationToken ct) { NoStore(); return Ok(await vault.SaveEnvelopesAsync(id, req.Envelopes, ct)); }

    [HttpPost("collections/{id:guid}/rekey")]
    [RequestSizeLimit(64 * 1024 * 1024)]
    public async Task<IActionResult> Rekey(Guid id, [FromBody] VaultRekeyRequest req, CancellationToken ct) { NoStore(); return Ok(await vault.RekeyAsync(id, req, ct)); }

    [HttpPost("collections/{id:guid}/export-for-sealing")]
    public async Task<IActionResult> ExportForSealing(Guid id, [FromBody] VaultStepUpRequest req, CancellationToken ct) { NoStore(); return Ok(await vault.ExportForSealingAsync(id, req.StepUp, ct)); }

    [HttpPost("collections/{id:guid}/seal")]
    [RequestSizeLimit(64 * 1024 * 1024)]
    public async Task<IActionResult> Seal(Guid id, [FromBody] VaultSealRequest req, CancellationToken ct) { NoStore(); return Ok(await vault.SealCollectionAsync(id, req, ct)); }

    [HttpGet("collections/{id:guid}/sealed-items")]
    public async Task<IActionResult> SealedItems(Guid id, [FromQuery] bool bin, CancellationToken ct) { NoStore(); return Ok(await vault.SealedItemsAsync(id, bin, ct)); }

    [HttpPost("sealed-items")]
    [RequestSizeLimit(2 * 1024 * 1024)]
    public async Task<IActionResult> CreateSealed([FromBody] SaveSealedItemRequest req, CancellationToken ct) { NoStore(); return Created(await vault.CreateSealedItemAsync(req, ct)); }

    [HttpPut("sealed-items/{id:guid}")]
    [RequestSizeLimit(2 * 1024 * 1024)]
    public async Task<IActionResult> UpdateSealed(Guid id, [FromBody] SaveSealedItemRequest req, CancellationToken ct) { NoStore(); return Ok(await vault.UpdateSealedItemAsync(id, req, ct)); }

    [HttpGet("sealed-items/{id:guid}/versions")]
    public async Task<IActionResult> SealedVersions(Guid id, CancellationToken ct) { NoStore(); return Ok(await vault.SealedVersionsAsync(id, ct)); }

    [HttpPost("sealed-items/{id:guid}/events")]
    public async Task<IActionResult> SealedEvent(Guid id, [FromBody] VaultItemEventRequest req, CancellationToken ct) { await vault.SealedEventAsync(id, req, ct); return NoContent(); }

    [HttpPost("sealed-items/{id:guid}/files")]
    [RequestSizeLimit(UploadCeiling), RequestFormLimits(MultipartBodyLengthLimit = UploadCeiling)]
    public async Task<IActionResult> AddSealedFile(Guid id, IFormFile file, [FromForm] string wrapped, CancellationToken ct)
    {
        NoStore();
        await using var stream = file.OpenReadStream();
        return Created(await vault.AddSealedFileAsync(id, wrapped, stream, file.Length, ct));
    }

    [HttpPost("sealed-files/{attachmentId:guid}")]
    public async Task<IActionResult> SealedFile(Guid attachmentId, CancellationToken ct)
    {
        NoStore();
        Response.Headers["X-Content-Type-Options"] = "nosniff";
        return File(await vault.SealedFileAsync(attachmentId, ct), "application/octet-stream");
    }

    /// <summary>The breached-password range for a hash prefix; the browser matches the rest, so the password never leaves it.</summary>
    [HttpGet("breach-range/{prefix}")]
    public async Task<IActionResult> BreachRange(string prefix, CancellationToken ct) { NoStore(); return Ok(new { body = await vault.BreachRangeAsync(prefix, ct) }); }

    [HttpPost("devices")]
    public async Task<IActionResult> RequestDevice([FromBody] VaultDeviceLinkRequest req, CancellationToken ct) { NoStore(); return Ok(await vault.RequestDeviceLinkAsync(req, ct)); }

    [HttpGet("devices/pending")]
    public async Task<IActionResult> PendingDevices(CancellationToken ct) { NoStore(); return Ok(await vault.PendingDeviceLinksAsync(ct)); }

    [HttpPost("devices/{id:guid}/approve")]
    public async Task<IActionResult> ApproveDevice(Guid id, [FromBody] VaultDeviceApproveRequest req, CancellationToken ct) { await vault.ApproveDeviceLinkAsync(id, req, true, ct); return NoContent(); }

    [HttpPost("devices/{id:guid}/refuse")]
    public async Task<IActionResult> RefuseDevice(Guid id, CancellationToken ct) { await vault.ApproveDeviceLinkAsync(id, new VaultDeviceApproveRequest(null, null), false, ct); return NoContent(); }

    [HttpGet("devices/{id:guid}")]
    public async Task<IActionResult> DeviceStatus(Guid id, CancellationToken ct) { NoStore(); return Ok(await vault.DeviceLinkStatusAsync(id, ct)); }

    // ------------------------------------------------------------- self-destructing links

    [HttpPost("links")]
    public async Task<IActionResult> CreateLink([FromBody] CreateSecretLinkRequest req, CancellationToken ct) { NoStore(); return Ok(await vault.CreateSecretLinkAsync(req, ct)); }

    [HttpGet("links")]
    public async Task<IActionResult> Links(CancellationToken ct) { NoStore(); return Ok(await vault.MySecretLinksAsync(ct)); }

    [HttpDelete("links/{id:guid}")]
    public async Task<IActionResult> RevokeLink(Guid id, CancellationToken ct) { await vault.RevokeSecretLinkAsync(id, ct); return NoContent(); }

    // ------------------------------------------------------------- machines (GitHub Actions) that may read a guarded collection

    [HttpGet("collections/{id:guid}/machines")]
    public async Task<IActionResult> Machines(Guid id, CancellationToken ct) { NoStore(); return Ok(await vault.MachinesAsync(id, ct)); }

    [HttpPost("collections/{id:guid}/machines")]
    public async Task<IActionResult> AddMachine(Guid id, [FromBody] SaveMachineRequest req, CancellationToken ct) { NoStore(); return Ok(await vault.AddMachineAsync(id, req, ct)); }

    [HttpDelete("machines/{id:guid}")]
    public async Task<IActionResult> RemoveMachine(Guid id, CancellationToken ct) { await vault.RemoveMachineAsync(id, ct); return NoContent(); }

    // ------------------------------------------------------------- the recovery circle

    [HttpGet("keys/circle")]
    public async Task<IActionResult> Circle(CancellationToken ct) { NoStore(); return Ok(new { circle = await vault.RecoveryCircleAsync(ct) }); }

    [HttpPut("keys/circle")]
    public async Task<IActionResult> SetCircle([FromBody] VaultRecoveryCircleRequest req, CancellationToken ct) { NoStore(); return Ok(await vault.SetRecoveryCircleAsync(req, ct)); }

    [HttpDelete("keys/circle")]
    public async Task<IActionResult> ClearCircle(CancellationToken ct) { await vault.ClearRecoveryCircleAsync(ct); return NoContent(); }

    [HttpPost("recovery")]
    public async Task<IActionResult> StartRecovery([FromBody] VaultDeviceLinkRequest req, CancellationToken ct) { NoStore(); return Ok(await vault.StartRecoveryAsync(req, ct)); }

    [HttpGet("recovery/to-help")]
    public async Task<IActionResult> RecoveryToHelp(CancellationToken ct) { NoStore(); return Ok(await vault.RecoveryToHelpAsync(ct)); }

    [HttpGet("recovery/{id:guid}")]
    public async Task<IActionResult> RecoveryStatus(Guid id, CancellationToken ct) { NoStore(); return Ok(await vault.RecoveryStatusAsync(id, ct)); }

    [HttpPost("recovery/{id:guid}/finish")]
    public async Task<IActionResult> FinishRecovery(Guid id, [FromQuery] bool recovered, CancellationToken ct) { await vault.FinishRecoveryAsync(id, recovered, ct); return NoContent(); }

    [HttpPost("recovery/{id:guid}/help")]
    public async Task<IActionResult> HelpRecovery(Guid id, [FromBody] VaultDeviceApproveRequest req, CancellationToken ct) { await vault.AnswerRecoveryAsync(id, req, true, ct); return NoContent(); }

    [HttpPost("recovery/{id:guid}/refuse")]
    public async Task<IActionResult> RefuseRecovery(Guid id, CancellationToken ct) { await vault.AnswerRecoveryAsync(id, new VaultDeviceApproveRequest(null, null), false, ct); return NoContent(); }

    // ------------------------------------------------------------- controls: decoys, the two-person rule, just-in-time access, passkey step-up

    [HttpPost("step-up/passkey/options")]
    public async Task<IActionResult> StepUpPasskeyOptions(CancellationToken ct) { NoStore(); return Ok(await passkeys.BeginStepUpAsync(ct)); }

    [HttpPost("step-up/passkey")]
    public async Task<IActionResult> StepUpPasskey([FromBody] ProjectManagement.Application.Features.Auth.PasskeyFinishRequest req, CancellationToken ct)
    {
        NoStore();
        await passkeys.FinishStepUpAsync(req, ct);
        return Ok(await stepUp.IssueAsync("passkey", ct));
    }

    [HttpPost("items/{id:guid}/requests")]
    public async Task<IActionResult> RequestReveal(Guid id, [FromBody] VaultRequestInput req, CancellationToken ct) { NoStore(); return Ok(await vault.RequestRevealAsync(id, req, ct)); }

    [HttpGet("requestable")]
    public async Task<IActionResult> Requestable(CancellationToken ct) { NoStore(); return Ok(await vault.RequestableAsync(ct)); }

    [HttpPost("collections/{id:guid}/requests")]
    public async Task<IActionResult> RequestCollection(Guid id, [FromBody] VaultRequestInput req, CancellationToken ct) { NoStore(); return Ok(await vault.RequestCollectionAsync(id, req, ct)); }

    [HttpGet("requests")]
    public async Task<IActionResult> Requests(CancellationToken ct) { NoStore(); return Ok(await vault.RequestsAsync(ct)); }

    [HttpPost("requests/{id:guid}/approve")]
    public async Task<IActionResult> Approve(Guid id, [FromBody] VaultDecisionInput req, CancellationToken ct) { NoStore(); return Ok(await vault.DecideAsync(id, true, req, ct)); }

    [HttpPost("requests/{id:guid}/deny")]
    public async Task<IActionResult> Deny(Guid id, [FromBody] VaultDecisionInput req, CancellationToken ct) { NoStore(); return Ok(await vault.DecideAsync(id, false, req, ct)); }

    [HttpPost("requests/{id:guid}/cancel")]
    public async Task<IActionResult> CancelRequest(Guid id, CancellationToken ct) { await vault.CancelRequestAsync(id, ct); return NoContent(); }

    [HttpPut("items/{id:guid}/decoy")]
    public async Task<IActionResult> Decoy(Guid id, [FromBody] VaultDecoyInput req, CancellationToken ct) { NoStore(); return Ok(await vault.SetDecoyAsync(id, req, ct)); }

    [HttpGet("decoys")]
    public async Task<IActionResult> Decoys(CancellationToken ct) { NoStore(); return Ok(await vault.DecoysAsync(ct)); }
}

public record VaultDirectoryRequest(IReadOnlyList<Guid>? UserIds);
public record VaultEnvelopesRequest(IReadOnlyList<VaultEnvelopeInput>? Envelopes);
