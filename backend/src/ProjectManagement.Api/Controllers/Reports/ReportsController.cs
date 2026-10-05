using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Insights;
using ProjectManagement.Application.Features.Reports;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Reports;

/// <summary>
/// The report summary and generated report files (built in the background, downloaded when ready). This is the one export
/// path: every report kind, project tasks and work tasks included, is produced by the same builder and writer.
/// </summary>
[Route("api/v1/reports"), RequireWorkspace, RequireModule(Modules.Reports)]
public class ReportsController(ReportService reports, ReportExportService exports) : ApiControllerBase
{
    [HttpGet("summary")]
    public async Task<IActionResult> Summary([FromQuery] int days = 7, [FromQuery] Guid? teamId = null, CancellationToken ct = default) => Ok(await reports.GetSummaryAsync(days, teamId, ct));

    [HttpGet("exports")]
    public async Task<IActionResult> Exports(CancellationToken ct) => Ok(await exports.ListAsync(ct));

    [HttpPost("exports")]
    public async Task<IActionResult> RequestExport([FromBody] RequestExportRequest req, CancellationToken ct) =>
        StatusCode(StatusCodes.Status202Accepted, await exports.RequestAsync(req, ct));

    [HttpGet("exports/{id:guid}")]
    public async Task<IActionResult> ExportStatus(Guid id, CancellationToken ct) => Ok(await exports.GetAsync(id, ct));

    [HttpGet("exports/{id:guid}/file")]
    public async Task<IActionResult> ExportFile(Guid id, CancellationToken ct)
    {
        var (content, name, type) = await exports.OpenAsync(id, ct);
        return File(content, type, name);
    }

    [HttpDelete("exports/{id:guid}")]
    public async Task<IActionResult> DeleteExport(Guid id, CancellationToken ct)
    {
        await exports.DeleteAsync(id, ct);
        return NoContent();
    }
}
