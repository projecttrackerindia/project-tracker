using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.Tasks;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Organization;

/// <summary>The people who report to me in the organization chart, and how their work is going (read-only).</summary>
[Route("api/v1/my-team"), RequireWorkspace]
public class MyTeamController(ProjectManagement.Application.Features.Organization.ReportingLineService reporting) : ApiControllerBase
{
    [HttpGet, RequireModule(Modules.Tasks)]
    public async Task<IActionResult> Get(CancellationToken ct) => Ok(await reporting.GetMyTeamAsync(ct));

    [HttpGet("{userId:guid}"), RequireModule(Modules.Tasks)]
    public async Task<IActionResult> Person(Guid userId, CancellationToken ct) => Ok(await reporting.GetPersonAsync(userId, ct));
}
