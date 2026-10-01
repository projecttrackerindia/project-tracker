using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Organization;

namespace ProjectManagement.Api.Controllers.Organization;

/// <summary>
/// The people who report to me in the organization chart, and how their work is going across every kind of work (read-only). The app's
/// Workload page uses <c>/api/v1/workload</c>, which includes this as its "Direct reports" view; <c>/api/v1/my-team</c> is the original
/// address, kept so existing API-key integrations keep working.
/// </summary>
[Route("api/v1/direct-reports"), Route("api/v1/my-team"), RequireWorkspace]
public class DirectReportsController(ReportingLineService reporting) : ApiControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken ct) => Ok(await reporting.GetMyTeamAsync(ct));

    [HttpGet("{userId:guid}")]
    public async Task<IActionResult> Person(Guid userId, CancellationToken ct) => Ok(await reporting.GetPersonAsync(userId, ct));
}
