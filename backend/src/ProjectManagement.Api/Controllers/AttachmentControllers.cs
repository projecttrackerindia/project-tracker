using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Files;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers;

/// <summary>Files on projects and tasks. The bytes go to file storage; see <see cref="AttachmentService"/> for the rules.</summary>
[Route("api/v1"), RequireWorkspace]
public class AttachmentsController(AttachmentService files) : ApiControllerBase
{
    private const long RequestCeiling = FileRules.AbsoluteMaxBytes + 4 * FileRules.Mb; // the file plus form overhead

    /// <summary>Allowed file types plus the plan's file-size and storage limits and current usage.</summary>
    [HttpGet("attachments/limits")]
    public async Task<IActionResult> Limits(CancellationToken ct) => Ok(await files.LimitsAsync(ct));

    [HttpGet("projects/{projectId:guid}/attachments"), RequireModule(Modules.Projects)]
    public async Task<IActionResult> ForProject(Guid projectId, CancellationToken ct) => Ok(await files.ListAsync(projectId, null, null, ct));

    [HttpGet("projects/{projectId:guid}/tasks/{taskId:guid}/attachments"), RequireModule(Modules.Projects), RequireModule(Modules.Tasks)]
    public async Task<IActionResult> ForTask(Guid projectId, Guid taskId, CancellationToken ct) => Ok(await files.ListAsync(projectId, taskId, null, ct));

    [HttpPost("projects/{projectId:guid}/attachments"), RequireModule(Modules.Projects, AccessLevel.Edit)]
    [RequestSizeLimit(RequestCeiling), RequestFormLimits(MultipartBodyLengthLimit = RequestCeiling)]
    public async Task<IActionResult> UploadToProject(Guid projectId, IFormFile file, CancellationToken ct)
    {
        await using var stream = file.OpenReadStream();
        return Created(await files.UploadAsync(projectId, null, file.FileName, stream, file.Length, ct));
    }

    [HttpPost("projects/{projectId:guid}/tasks/{taskId:guid}/attachments"), RequireModule(Modules.Projects), RequireModule(Modules.Tasks, AccessLevel.Edit)]
    [RequestSizeLimit(RequestCeiling), RequestFormLimits(MultipartBodyLengthLimit = RequestCeiling)]
    public async Task<IActionResult> UploadToTask(Guid projectId, Guid taskId, IFormFile file, CancellationToken ct)
    {
        await using var stream = file.OpenReadStream();
        return Created(await files.UploadAsync(projectId, taskId, file.FileName, stream, file.Length, ct));
    }

    /// <summary>Supporting documents of a test issue (screenshots, logs, test evidence).</summary>
    [HttpGet("projects/{projectId:guid}/issues/{issueId:guid}/attachments"), RequireModule(Modules.Projects), RequireModule(Modules.Tasks)]
    public async Task<IActionResult> ForIssue(Guid projectId, Guid issueId, CancellationToken ct) => Ok(await files.ListAsync(projectId, null, issueId, ct));

    [HttpPost("projects/{projectId:guid}/issues/{issueId:guid}/attachments"), RequireModule(Modules.Projects), RequireModule(Modules.Tasks)]
    [RequestSizeLimit(RequestCeiling), RequestFormLimits(MultipartBodyLengthLimit = RequestCeiling)]
    public async Task<IActionResult> UploadToIssue(Guid projectId, Guid issueId, IFormFile file, CancellationToken ct)
    {
        await using var stream = file.OpenReadStream();
        return Created(await files.UploadAsync(projectId, null, file.FileName, stream, file.Length, ct, issueId));
    }

    /// <summary>Downloads the file. Images can be shown inline (<c>?inline=true</c>); everything else is always a download.</summary>
    [HttpGet("attachments/{id:guid}/download")]
    public async Task<IActionResult> Download(Guid id, [FromQuery] bool inline, CancellationToken ct)
    {
        var (file, content) = await files.OpenAsync(id, ct);
        Response.Headers.CacheControl = "private, no-store";
        Response.Headers["X-Content-Type-Options"] = "nosniff";
        Response.Headers.ContentSecurityPolicy = "default-src 'none'; sandbox";
        return inline && FileRules.IsImage(file.ContentType)
            ? File(content, file.ContentType)
            : File(content, file.ContentType, file.FileName);
    }

    [HttpDelete("attachments/{id:guid}")]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
    {
        await files.DeleteAsync(id, ct);
        return NoContent();
    }
}
