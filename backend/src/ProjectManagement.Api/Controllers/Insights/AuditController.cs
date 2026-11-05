using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Insights;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Insights;

/// <summary>The admin's audit-log viewer: filtered pages, the filters' choices, and a CSV of what the filters show.</summary>
[Route("api/v1/audit"), RequireWorkspace, RequireModule(Modules.Audit)]
public class AuditController(AuditViewerService audit) : ApiControllerBase
{
    [HttpGet]
    public async Task<IActionResult> List([FromQuery] string? kind, [FromQuery] Guid? userId, [FromQuery] string? entityType, [FromQuery] string? action,
        [FromQuery] DateOnly? from, [FromQuery] DateOnly? to, [FromQuery] string? q, [FromQuery] int page = 1, [FromQuery] int pageSize = 50, CancellationToken ct = default) =>
        Ok(await audit.ListAsync(new AuditQuery(kind, userId, entityType, action, from, to, q, page, pageSize), ct));

    [HttpGet("facets")]
    public async Task<IActionResult> Facets(CancellationToken ct) => Ok(await audit.FacetsAsync(ct));

    [HttpGet("export"), Microsoft.AspNetCore.RateLimiting.EnableRateLimiting("sensitive")]
    public async Task<IActionResult> Export([FromQuery] string? kind, [FromQuery] Guid? userId, [FromQuery] string? entityType, [FromQuery] string? action,
        [FromQuery] DateOnly? from, [FromQuery] DateOnly? to, [FromQuery] string? q, CancellationToken ct = default)
    {
        var csv = await audit.ExportCsvAsync(new AuditQuery(kind, userId, entityType, action, from, to, q), ct);
        Response.Headers.CacheControl = "no-store";
        return File(csv.Content, "text/csv; charset=utf-8", csv.FileName);
    }
}
