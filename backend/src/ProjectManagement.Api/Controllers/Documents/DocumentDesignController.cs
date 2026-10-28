using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Documents;

/// <summary>
/// How Library pages look and move: a page's style (preset, its own CSS, motion), and the workspace's switches for custom CSS and interactive
/// embeds. The CSS is checked on the server whatever the browser did; changes are audited.
/// </summary>
[Route("api/v1"), RequireWorkspace, RequireModule(Modules.Documents)]
public class DocumentDesignController(DocumentService documents, LibraryDesignService design) : ApiControllerBase
{
    [HttpPut("documents/{id:guid}/style")]
    public async Task<IActionResult> SaveStyle(Guid id, [FromBody] SavePageStyleRequest req, CancellationToken ct) => Ok(await documents.SaveStyleAsync(id, req, ct));

    [HttpGet("documents/library-design")]
    public async Task<IActionResult> Get(CancellationToken ct) => Ok(await design.GetAsync(ct));

    [HttpPut("documents/library-design")]
    public async Task<IActionResult> Save([FromBody] SaveLibraryDesignRequest req, CancellationToken ct) => Ok(await design.SaveAsync(req, ct));
}
