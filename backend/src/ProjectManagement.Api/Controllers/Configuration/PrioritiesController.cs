using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Configuration;
using ProjectManagement.Application.Features.Tasks;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Configuration;

/// <summary>Workspace names and colours for the four priority levels.</summary>
[Route("api/v1/priorities"), RequireWorkspace]
public class PrioritiesController(PriorityService priorities) : ApiControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken ct) => Ok(await priorities.GetAsync(ct));

    [HttpPut]
    public async Task<IActionResult> Set([FromBody] SetPrioritiesRequest req, CancellationToken ct) => Ok(await priorities.SetAsync(req, ct));

    [HttpDelete]
    public async Task<IActionResult> Reset(CancellationToken ct) => Ok(await priorities.ResetAsync(ct));
}
