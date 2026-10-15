using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Documents;

/// <summary>
/// Build artifacts: the one file carried by each version of a Build Artifact document. Versioning, publishing and comparing all go through the same
/// Documents permission tiers as every other document (view = download, create/edit = upload a new build) - see <see cref="ArtifactVersionService"/>.
/// </summary>
[Route("api/v1"), RequireWorkspace, RequireModule(Modules.Documents)]
public class DocumentArtifactsController(ArtifactVersionService artifacts) : ApiControllerBase
{
    private const long RequestCeiling = ProjectManagement.Application.Features.Files.FileRules.AbsoluteMaxBytes + 1024 * 1024;

    [HttpGet("documents/{id:guid}/artifact/versions")]
    public async Task<IActionResult> Versions(Guid id, CancellationToken ct) => Ok(await artifacts.ListAsync(id, ct));

    [HttpPost("documents/{id:guid}/artifact/draft"), RequireModule(Modules.Documents, AccessLevel.Edit)]
    [RequestSizeLimit(RequestCeiling), RequestFormLimits(MultipartBodyLengthLimit = RequestCeiling)]
    public async Task<IActionResult> UploadDraft(Guid id, IFormFile file, CancellationToken ct)
    {
        await using var stream = file.OpenReadStream();
        return Created(await artifacts.UploadDraftAsync(id, file.FileName, stream, file.Length, ct));
    }

    [HttpPost("documents/{id:guid}/artifact/publish"), RequireModule(Modules.Documents, AccessLevel.Edit)]
    public async Task<IActionResult> Publish(Guid id, [FromBody] PublishArtifactRequest req, CancellationToken ct) => Ok(await artifacts.PublishAsync(id, req, ct));

    /// <summary>Always a download (never shown inline): a build file has no safe in-browser rendering.</summary>
    [HttpGet("documents/{id:guid}/artifact/versions/{versionId:guid}/download")]
    public async Task<IActionResult> Download(Guid id, Guid versionId, CancellationToken ct)
    {
        var (file, content) = await artifacts.OpenAsync(id, versionId, ct);
        Response.Headers.CacheControl = "private, no-store";
        Response.Headers["X-Content-Type-Options"] = "nosniff";
        Response.Headers.ContentSecurityPolicy = "default-src 'none'; sandbox";
        return File(content, string.IsNullOrEmpty(file.ContentType) ? "application/octet-stream" : file.ContentType, file.FileName);
    }

    [HttpGet("documents/{id:guid}/artifact/compare")]
    public async Task<IActionResult> Compare(Guid id, [FromQuery] Guid from, [FromQuery] Guid to, CancellationToken ct) => Ok(await artifacts.CompareAsync(id, from, to, ct));
}
