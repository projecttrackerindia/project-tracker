using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Api.Controllers.Documents;

/// <summary>Documents (BRDs, API documentation, test plans ...). Who may open a document is decided in the data layer; see <see cref="DocumentService"/>.</summary>
[Route("api/v1"), RequireWorkspace, RequireModule(Modules.Documents)]
public class DocumentsController(DocumentService documents, DocumentLinkService links, DocumentVersionService versions, DocumentAccessService access, DocumentFileService files) : ApiControllerBase
{
    [HttpGet("document-types")]
    public async Task<IActionResult> Types(CancellationToken ct) => Ok(await documents.ListTypesAsync(ct));

    [HttpGet("documents")]
    public async Task<IActionResult> List([FromQuery] Guid? projectId, [FromQuery] Guid? teamId, [FromQuery] Guid? typeId, [FromQuery] DocumentStatus? status,
        [FromQuery] Guid? ownerId, [FromQuery] string? tag, [FromQuery] string? q, [FromQuery] bool? general, [FromQuery] string? cursor, [FromQuery] int? limit, CancellationToken ct) =>
        Ok(await documents.ListAsync(new DocumentFilter(projectId, teamId, typeId, status, ownerId, tag, q, general), cursor, limit, ct));

    [HttpPost("documents")]
    public async Task<IActionResult> Create([FromBody] CreateDocumentRequest req, CancellationToken ct) => Created(await documents.CreateAsync(req, ct));

    [HttpGet("documents/{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct) => Ok(await documents.GetAsync(id, ct));

    [HttpPut("documents/{id:guid}")]
    public async Task<IActionResult> Update(Guid id, [FromBody] UpdateDocumentRequest req, CancellationToken ct) => Ok(await documents.UpdateAsync(id, req, ct));

    [HttpPut("documents/{id:guid}/sections")]
    public async Task<IActionResult> Save(Guid id, [FromBody] SaveSectionsRequest req, CancellationToken ct) => Ok(await documents.SaveSectionsAsync(id, req, ct));

    [HttpPost("documents/{id:guid}/archive")]
    public async Task<IActionResult> Archive(Guid id, CancellationToken ct) => Ok(await documents.SetArchivedAsync(id, true, ct));

    [HttpPost("documents/{id:guid}/reopen")]
    public async Task<IActionResult> Reopen(Guid id, CancellationToken ct) => Ok(await documents.SetArchivedAsync(id, false, ct));

    [HttpPost("documents/{id:guid}/restore")]
    public async Task<IActionResult> Restore(Guid id, CancellationToken ct) => Ok(await documents.RestoreAsync(id, ct));

    [HttpDelete("documents/{id:guid}")]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
    {
        await documents.DeleteAsync(id, ct);
        return NoContent();
    }

    // ---- links (both directions)
    [HttpGet("documents/{id:guid}/links")]
    public async Task<IActionResult> Links(Guid id, CancellationToken ct) => Ok(await links.ForDocumentAsync(id, ct));

    [HttpPost("documents/{id:guid}/links")]
    public async Task<IActionResult> AddLink(Guid id, [FromBody] AddLinkRequest req, CancellationToken ct) => Created(await links.AddAsync(id, req, ct));

    [HttpDelete("documents/{id:guid}/links/{linkId:guid}")]
    public async Task<IActionResult> RemoveLink(Guid id, Guid linkId, CancellationToken ct)
    {
        await links.RemoveAsync(id, linkId, ct);
        return NoContent();
    }

    /// <summary>The documents linked to a task, issue, work item, sprint or project (the ones this person may open, plus how many they may not).</summary>
    [HttpGet("linked-documents")]
    public async Task<IActionResult> ForTarget([FromQuery] LinkTarget targetType, [FromQuery] Guid targetId, CancellationToken ct) => Ok(await links.ForTargetAsync(targetType, targetId, ct));

    // ---- versions
    [HttpGet("documents/{id:guid}/versions")]
    public async Task<IActionResult> Versions(Guid id, CancellationToken ct) => Ok(await versions.ListAsync(id, ct));

    [HttpGet("documents/{id:guid}/versions/{versionId:guid}")]
    public async Task<IActionResult> Version(Guid id, Guid versionId, CancellationToken ct) => Ok(await versions.GetAsync(id, versionId, ct));

    [HttpGet("documents/{id:guid}/compare")]
    public async Task<IActionResult> Compare(Guid id, [FromQuery] Guid from, [FromQuery] Guid to, CancellationToken ct) => Ok(await versions.CompareAsync(id, from, to, ct));

    [HttpPost("documents/{id:guid}/publish")]
    public async Task<IActionResult> Publish(Guid id, [FromBody] PublishRequest req, CancellationToken ct) => Ok(await versions.PublishAsync(id, req, ct));

    [HttpPost("documents/{id:guid}/versions/{versionId:guid}/restore")]
    public async Task<IActionResult> RestoreVersion(Guid id, Guid versionId, [FromBody] RestoreRequest req, CancellationToken ct) => Ok(await versions.RestoreAsync(id, versionId, req, ct));

    // ---- who can open it
    [HttpGet("documents/{id:guid}/access")]
    public async Task<IActionResult> Access(Guid id, CancellationToken ct) => Ok(await access.GetAsync(id, ct));

    [HttpPost("documents/{id:guid}/grants")]
    public async Task<IActionResult> AddGrant(Guid id, [FromBody] AddGrantRequest req, CancellationToken ct) => Ok(await access.AddGrantAsync(id, req, ct));

    [HttpDelete("documents/{id:guid}/grants/{grantId:guid}")]
    public async Task<IActionResult> RemoveGrant(Guid id, Guid grantId, CancellationToken ct) => Ok(await access.RemoveGrantAsync(id, grantId, ct));

    // ---- files
    private const long RequestCeiling = ProjectManagement.Application.Features.Files.FileRules.AbsoluteMaxBytes + 1024 * 1024;

    [HttpGet("documents/{id:guid}/files")]
    public async Task<IActionResult> Files(Guid id, CancellationToken ct) => Ok(await files.ListAsync(id, ct));

    [HttpPost("documents/{id:guid}/files"), RequireModule(Modules.Documents, AccessLevel.Edit)]
    [RequestSizeLimit(RequestCeiling), RequestFormLimits(MultipartBodyLengthLimit = RequestCeiling)]
    public async Task<IActionResult> UploadFile(Guid id, IFormFile file, CancellationToken ct)
    {
        await using var stream = file.OpenReadStream();
        return Created(await files.UploadAsync(id, file.FileName, stream, file.Length, ct));
    }

    /// <summary>Images can be shown inline (<c>?inline=true</c>); everything else is always a download.</summary>
    [HttpGet("documents/{id:guid}/files/{fileId:guid}/download")]
    public async Task<IActionResult> DownloadFile(Guid id, Guid fileId, [FromQuery] bool inline, CancellationToken ct)
    {
        var (file, content) = await files.OpenAsync(id, fileId, ct);
        Response.Headers.CacheControl = "private, no-store";
        Response.Headers["X-Content-Type-Options"] = "nosniff";
        Response.Headers.ContentSecurityPolicy = "default-src 'none'; sandbox";
        return inline && ProjectManagement.Application.Features.Files.FileRules.IsImage(file.ContentType) ? File(content, file.ContentType) : File(content, file.ContentType, file.FileName);
    }

    [HttpDelete("documents/{id:guid}/files/{fileId:guid}")]
    public async Task<IActionResult> DeleteFile(Guid id, Guid fileId, CancellationToken ct)
    {
        await files.DeleteAsync(id, fileId, ct);
        return NoContent();
    }
}
