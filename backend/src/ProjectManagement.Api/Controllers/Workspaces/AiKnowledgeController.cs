using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Common;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Ai;

namespace ProjectManagement.Api.Controllers.Workspaces;

[Route("api/v1/ai/knowledge"), RequireWorkspace]
public class AiKnowledgeController(AiKnowledgeService service) : ApiControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Search([FromQuery] string query, CancellationToken ct) => Ok(await service.SearchAsync(query, ct));
    [HttpGet("{kind}/{id:guid}")]
    public async Task<IActionResult> Read(string kind, Guid id, [FromQuery] string? key, [FromQuery] string? expectedVersion, [FromQuery] int offset, CancellationToken ct)
        => Ok(await service.ReadAsync(kind, id, key, expectedVersion, offset, ct));
}
