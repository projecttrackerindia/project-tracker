using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Api.Controllers.Documents;

/// <summary>Documents (BRDs, API documentation, test plans ...). Who may open a document is decided in the data layer; see <see cref="DocumentService"/>.</summary>
[Route("api/v1"), RequireWorkspace, RequireModule(Modules.Documents)]
public class DocumentsController(DocumentService documents, DocumentLinkService links, DocumentVersionService versions, DocumentAccessService access, DocumentFileService files,
    DocumentWorkflowService workflows, DocumentAccessRequestService requests, DocumentTraceService trace, DocumentAuditService audit, DocumentInboxService inbox, DocumentExportService exports, DocumentDashboardService dashboard) : ApiControllerBase
{
    /// <summary>Asks for a PDF of the document (of one published version, or as the person sees it now). The file is built in the background; the person is notified.</summary>
    [HttpPost("documents/{id:guid}/export")]
    public async Task<IActionResult> Export(Guid id, [FromBody] ExportDocumentRequest req, CancellationToken ct) => Created(await exports.RequestAsync(id, req.VersionId, ct));

    [HttpGet("documents/{id:guid}/exports/{exportId:guid}")]
    public async Task<IActionResult> ExportStatus(Guid id, Guid exportId, CancellationToken ct) => Ok(await exports.GetAsync(id, exportId, ct));

    [HttpGet("documents/{id:guid}/exports/{exportId:guid}/file")]
    public async Task<IActionResult> ExportFile(Guid id, Guid exportId, CancellationToken ct)
    {
        var (content, name, type) = await exports.OpenAsync(id, exportId, ct);
        return File(content, type, name);
    }

    [HttpGet("documents/dashboard")]
    public async Task<IActionResult> Dashboard(CancellationToken ct) => Ok(await dashboard.GetAsync(ct));

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

    // ---- approval workflow
    [HttpGet("document-workflows")]
    public async Task<IActionResult> Workflows(CancellationToken ct) => Ok(await workflows.ListAsync(ct));

    [HttpPost("document-workflows")]
    public async Task<IActionResult> CreateWorkflow([FromBody] SaveWorkflowRequest req, CancellationToken ct) => Created(await workflows.SaveAsync(null, req, ct));

    [HttpPut("document-workflows/{id:guid}")]
    public async Task<IActionResult> UpdateWorkflow(Guid id, [FromBody] SaveWorkflowRequest req, CancellationToken ct) => Ok(await workflows.SaveAsync(id, req, ct));

    [HttpDelete("document-workflows/{id:guid}")]
    public async Task<IActionResult> DeleteWorkflow(Guid id, CancellationToken ct)
    {
        await workflows.DeleteAsync(id, ct);
        return NoContent();
    }

    [HttpGet("documents/{id:guid}/review")]
    public async Task<IActionResult> Review(Guid id, CancellationToken ct) => Ok(await workflows.ReviewAsync(id, ct));

    [HttpPost("documents/{id:guid}/submit")]
    public async Task<IActionResult> Submit(Guid id, [FromBody] SubmitRequest req, CancellationToken ct) => Ok(await workflows.SubmitAsync(id, req, ct));

    [HttpPost("documents/{id:guid}/approve")]
    public async Task<IActionResult> Approve(Guid id, [FromBody] DecideRequest req, CancellationToken ct) => Ok(await workflows.ApproveAsync(id, req, ct));

    [HttpPost("documents/{id:guid}/request-changes")]
    public async Task<IActionResult> RequestChanges(Guid id, [FromBody] DecideRequest req, CancellationToken ct) => Ok(await workflows.RequestChangesAsync(id, req, ct));

    [HttpPost("documents/{id:guid}/withdraw")]
    public async Task<IActionResult> Withdraw(Guid id, [FromBody] DecideRequest req, CancellationToken ct) => Ok(await workflows.WithdrawAsync(id, req, ct));

    /// <summary>Everything waiting on the signed-in person: reviews to decide, their submissions, access requests.</summary>
    [HttpGet("documents/inbox")]
    public async Task<IActionResult> Inbox(CancellationToken ct) => Ok(await inbox.GetAsync(ct));

    // ---- asking for access
    [HttpGet("documents/{id:guid}/gate")]
    public async Task<IActionResult> Gate(Guid id, CancellationToken ct) => Ok(await requests.GateAsync(id, ct));

    [HttpPost("documents/{id:guid}/access-requests")]
    public async Task<IActionResult> RequestAccess(Guid id, [FromBody] RequestAccessRequest req, CancellationToken ct) => Created(await requests.RequestAsync(id, req, ct));

    [HttpGet("documents/{id:guid}/access-requests")]
    public async Task<IActionResult> AccessRequests(Guid id, CancellationToken ct) => Ok(await requests.ForDocumentAsync(id, ct));

    [HttpPost("access-requests/{requestId:guid}/decide")]
    public async Task<IActionResult> DecideAccess(Guid requestId, [FromBody] DecideAccessRequest req, CancellationToken ct) => Ok(await requests.DecideAsync(requestId, req, ct));

    [HttpPost("access-requests/{requestId:guid}/cancel")]
    public async Task<IActionResult> CancelAccess(Guid requestId, CancellationToken ct) => Ok(await requests.CancelAsync(requestId, ct));

    // ---- requirements and coverage
    [HttpGet("documents/{id:guid}/requirements")]
    public async Task<IActionResult> Requirements(Guid id, CancellationToken ct) => Ok(await trace.ListAsync(id, ct));

    [HttpPost("documents/{id:guid}/requirements")]
    public async Task<IActionResult> AddRequirements(Guid id, [FromBody] AddRequirementsRequest req, CancellationToken ct) => Created(await trace.AddAsync(id, req, ct));

    [HttpPut("documents/{id:guid}/requirements/{requirementId:guid}")]
    public async Task<IActionResult> UpdateRequirement(Guid id, Guid requirementId, [FromBody] SaveRequirementRequest req, CancellationToken ct) => Ok(await trace.UpdateAsync(id, requirementId, req, ct));

    [HttpDelete("documents/{id:guid}/requirements/{requirementId:guid}")]
    public async Task<IActionResult> DeleteRequirement(Guid id, Guid requirementId, CancellationToken ct) => Ok(await trace.DeleteAsync(id, requirementId, ct));

    [HttpGet("documents/{id:guid}/coverage")]
    public async Task<IActionResult> Coverage(Guid id, CancellationToken ct) => Ok(await trace.CoverageAsync(id, ct));

    // ---- activity and audit
    [HttpGet("documents/{id:guid}/activity")]
    public async Task<IActionResult> Activity(Guid id, CancellationToken ct) => Ok(await audit.ActivityAsync(id, ct));

    [HttpGet("documents/{id:guid}/audit")]
    public async Task<IActionResult> Audit(Guid id, [FromQuery] string? action, [FromQuery] string? cursor, CancellationToken ct) => Ok(await audit.AuditAsync(id, action, cursor, ct));

    [HttpGet("documents/{id:guid}/audit/export")]
    public async Task<IActionResult> ExportAudit(Guid id, CancellationToken ct)
    {
        var csv = await audit.ExportCsvAsync(id, ct);
        Response.Headers.CacheControl = "private, no-store";
        return File(System.Text.Encoding.UTF8.GetBytes("\uFEFF" + csv), "text/csv; charset=utf-8", $"document-audit-{DateTime.UtcNow:yyyyMMdd}.csv");
    }
}
