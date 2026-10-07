using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Api.Controllers.Documents;

/// <summary>Documents (BRDs, API documentation, test plans ...). Who may open a document is decided in the data layer; see <see cref="DocumentService"/>.</summary>
[Route("api/v1"), RequireWorkspace, RequireModule(Modules.Documents)]
public class DocumentsController(DocumentService documents, DocumentLinkService links) : ApiControllerBase
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
}
