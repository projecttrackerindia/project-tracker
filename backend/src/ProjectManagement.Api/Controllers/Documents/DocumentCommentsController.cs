using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Documents;

/// <summary>Comments on a document: a running conversation anyone who may open it can read and add to. See <see cref="DocumentCommentService"/>.</summary>
[Route("api/v1"), RequireWorkspace, RequireModule(Modules.Documents)]
public class DocumentCommentsController(DocumentCommentService comments) : ApiControllerBase
{
    [HttpGet("documents/{id:guid}/comments")]
    public async Task<IActionResult> List(Guid id, CancellationToken ct) => Ok(await comments.ListAsync(id, ct));

    [HttpPost("documents/{id:guid}/comments")]
    public async Task<IActionResult> Add(Guid id, [FromBody] AddCommentRequest req, CancellationToken ct) => Created(await comments.AddAsync(id, req, ct));
}
