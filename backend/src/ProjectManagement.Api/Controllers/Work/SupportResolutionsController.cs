using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Common;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Work;

namespace ProjectManagement.Api.Controllers.Work;

[Route("api/v1/work-tasks/{id:guid}/resolution"), RequireWorkspace]
public class SupportResolutionsController(SupportResolutionService service) : ApiControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct) => Ok(await service.GetAsync(id, ct));
    [HttpPut]
    public async Task<IActionResult> Propose(Guid id, ProposeSupportResolutionRequest req, CancellationToken ct) => Ok(await service.ProposeAsync(id, req, ct));
    [HttpPost("accept")]
    public async Task<IActionResult> Accept(Guid id, AcceptSupportResolutionRequest req, CancellationToken ct) => Ok(await service.AcceptAsync(id, req, ct));
}
