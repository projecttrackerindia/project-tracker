using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Insights;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Insights;

/// <summary>Cross-cutting read views: the dashboard, the calendar, global search, the activity feed and the audit log.</summary>
[Route("api/v1"), RequireWorkspace]
public class InsightsController(DashboardService dashboard, CalendarService calendar, SearchService search, ActivityService activity) : ApiControllerBase
{
    [HttpGet("dashboard")]
    public async Task<IActionResult> Dashboard([FromQuery] Guid? teamId, CancellationToken ct) => Ok(await dashboard.GetAsync(teamId, ct));

    /// <summary>The teams this person may look at as a whole (empty for guests, and when the workspace has no teams).</summary>
    [HttpGet("lens/teams")]
    public async Task<IActionResult> LensTeams([FromServices] ProjectManagement.Application.Services.ProjectAccess access, CancellationToken ct) => Ok(await access.LensTeamsAsync(ct));

    [HttpGet("calendar"), RequireModule(Modules.Calendar)]
    public async Task<IActionResult> Calendar([FromQuery] DateOnly from, [FromQuery] DateOnly to, [FromQuery] Guid? projectId,
        [FromQuery] bool mine = false, [FromQuery] Guid? userId = null, CancellationToken ct = default) =>
        Ok(await calendar.GetAsync(from, to, projectId, mine, userId, ct));

    [HttpGet("search")]
    public async Task<IActionResult> Search([FromQuery] string q, CancellationToken ct) => Ok(await search.SearchAsync(q ?? "", ct));

    [HttpGet("activity"), RequireModule(Modules.Activity)]
    public async Task<IActionResult> Activity([FromQuery] int page = 1, [FromQuery] int pageSize = 25, CancellationToken ct = default) =>
        Ok(await activity.ListAsync(null, page, pageSize, ct));

    [HttpGet("audit-logs"), RequireModule(Modules.Audit)]
    public async Task<IActionResult> Audit([FromQuery] string? action, [FromQuery] int page = 1, [FromQuery] int pageSize = 25, CancellationToken ct = default) =>
        Ok(await activity.ListAuditAsync(action, page, pageSize, ct));
}
