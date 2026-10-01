using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Files;
using ProjectManagement.Application.Features.Work;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Work;

/// <summary>Work tasks: operational work (bug fixes, support, analysis ...) kept apart from project tasks. See <see cref="WorkTaskService"/> for the rules.</summary>
[Route("api/v1"), RequireWorkspace, RequireModule(Modules.Work)]
public class WorkTasksController(WorkTaskService work) : ApiControllerBase
{
    private const long RequestCeiling = FileRules.AbsoluteMaxBytes + 4 * FileRules.Mb;

    [HttpGet("work-tasks")]
    public async Task<IActionResult> List([FromQuery] WorkTaskQuery query, CancellationToken ct) => Ok(await work.ListAsync(query, ct));

    /// <summary>Counts for the Work reports page and the dashboard: open, overdue, by type / person / project, and a daily trend.</summary>
    [HttpGet("work-tasks/summary")]
    public async Task<IActionResult> Summary([FromQuery] DateOnly? from, [FromQuery] DateOnly? to, CancellationToken ct) => Ok(await work.SummaryAsync(from, to, ct));

    /// <summary>The filtered list as a CSV file.</summary>
    [HttpGet("work-tasks/export")]
    public async Task<IActionResult> Export([FromQuery] WorkTaskQuery query, CancellationToken ct)
    {
        var bytes = await work.ExportAsync(query, ct);
        Response.Headers.CacheControl = "private, no-store";
        return File(bytes, "text/csv; charset=utf-8", $"work-tasks-{DateTime.UtcNow:yyyyMMdd}.csv");
    }

    [HttpGet("work-tasks/{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct) => Ok(await work.GetAsync(id, ct));

    [HttpPost("work-tasks"), RequireModule(Modules.Work, AccessLevel.Edit)]
    public async Task<IActionResult> Create([FromBody] CreateWorkTaskRequest req, CancellationToken ct) => Created(await work.CreateAsync(req, ct));

    [HttpPut("work-tasks/{id:guid}"), RequireModule(Modules.Work, AccessLevel.Edit)]
    public async Task<IActionResult> Update(Guid id, [FromBody] UpdateWorkTaskRequest req, CancellationToken ct) => Ok(await work.UpdateAsync(id, req, ct));

    [HttpPut("work-tasks/{id:guid}/status"), RequireModule(Modules.Work, AccessLevel.Edit)]
    public async Task<IActionResult> SetStatus(Guid id, [FromBody] SetWorkTaskStatusRequest req, CancellationToken ct) => Ok(await work.SetStatusAsync(id, req, ct));

    [HttpDelete("work-tasks/{id:guid}"), RequireModule(Modules.Work, AccessLevel.Edit)]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
    {
        await work.DeleteAsync(id, ct);
        return NoContent();
    }

    // ---- conversation, history, files

    [HttpGet("work-tasks/{id:guid}/comments")]
    public async Task<IActionResult> Comments(Guid id, CancellationToken ct) => Ok(await work.CommentsAsync(id, ct));

    [HttpPost("work-tasks/{id:guid}/comments"), RequireModule(Modules.Work, AccessLevel.Edit)]
    public async Task<IActionResult> AddComment(Guid id, [FromBody] WorkCommentRequest req, CancellationToken ct) => Created(await work.AddCommentAsync(id, req, ct));

    [HttpPut("work-tasks/{id:guid}/comments/{commentId:guid}"), RequireModule(Modules.Work, AccessLevel.Edit)]
    public async Task<IActionResult> EditComment(Guid id, Guid commentId, [FromBody] WorkCommentRequest req, CancellationToken ct) => Ok(await work.EditCommentAsync(id, commentId, req, ct));

    [HttpDelete("work-tasks/{id:guid}/comments/{commentId:guid}"), RequireModule(Modules.Work, AccessLevel.Edit)]
    public async Task<IActionResult> DeleteComment(Guid id, Guid commentId, CancellationToken ct)
    {
        await work.DeleteCommentAsync(id, commentId, ct);
        return NoContent();
    }

    [HttpGet("work-tasks/{id:guid}/history")]
    public async Task<IActionResult> History(Guid id, CancellationToken ct) => Ok(await work.HistoryAsync(id, ct));

    [HttpGet("work-tasks/{id:guid}/attachments")]
    public async Task<IActionResult> Files(Guid id, CancellationToken ct) => Ok(await work.AttachmentsAsync(id, ct));

    [HttpPost("work-tasks/{id:guid}/attachments"), RequireModule(Modules.Work, AccessLevel.Edit)]
    [RequestSizeLimit(RequestCeiling), RequestFormLimits(MultipartBodyLengthLimit = RequestCeiling)]
    public async Task<IActionResult> Upload(Guid id, IFormFile file, CancellationToken ct)
    {
        await using var stream = file.OpenReadStream();
        return Created(await work.UploadAsync(id, file.FileName, stream, file.Length, ct));
    }

    [HttpGet("work-attachments/{fileId:guid}/download")]
    public async Task<IActionResult> Download(Guid fileId, [FromQuery] bool inline, CancellationToken ct)
    {
        var (file, content) = await work.OpenAsync(fileId, ct);
        Response.Headers.CacheControl = "private, no-store";
        Response.Headers["X-Content-Type-Options"] = "nosniff";
        Response.Headers.ContentSecurityPolicy = "default-src 'none'; sandbox";
        return inline && FileRules.IsImage(file.ContentType) ? File(content, file.ContentType) : File(content, file.ContentType, file.FileName);
    }

    [HttpDelete("work-attachments/{fileId:guid}"), RequireModule(Modules.Work, AccessLevel.Edit)]
    public async Task<IActionResult> DeleteFile(Guid fileId, CancellationToken ct)
    {
        await work.DeleteFileAsync(fileId, ct);
        return NoContent();
    }
}
