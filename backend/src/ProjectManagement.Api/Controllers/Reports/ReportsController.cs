using System.Text;
using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Insights;
using ProjectManagement.Application.Features.Reports;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Reports;

/// <summary>The report summary and generated report files (built in the background, downloaded when ready).</summary>
[Route("api/v1/reports"), RequireWorkspace, RequireModule(Modules.Reports)]
public class ReportsController(ReportService reports, ReportExportService exports) : ApiControllerBase
{
    [HttpGet("summary")]
    public async Task<IActionResult> Summary([FromQuery] int days = 7, CancellationToken ct = default) => Ok(await reports.GetSummaryAsync(days, ct));

    [HttpGet("tasks.csv")]
    public async Task<IActionResult> ExportTasks(CancellationToken ct)
    {
        var csv = await reports.ExportTasksCsvAsync(ct);
        return File(new UTF8Encoding(true).GetPreamble().Concat(Encoding.UTF8.GetBytes(csv)).ToArray(), "text/csv", $"tasks-{DateTime.UtcNow:yyyyMMdd}.csv");
    }

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
