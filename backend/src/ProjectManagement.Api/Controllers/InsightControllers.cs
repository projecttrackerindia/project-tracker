using System.Text;
using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Insights;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers;

[Route("api/v1"), RequireWorkspace]
public class InsightsController(DashboardService dashboard, CalendarService calendar, SearchService search, ActivityService activity,
    ReportService reports) : ApiControllerBase
{
    [HttpGet("dashboard")]
    public async Task<IActionResult> Dashboard(CancellationToken ct) => Ok(await dashboard.GetAsync(ct));

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

    [HttpGet("reports/summary"), RequireModule(Modules.Reports)]
    public async Task<IActionResult> ReportSummary([FromQuery] int days = 7, CancellationToken ct = default) => Ok(await reports.GetSummaryAsync(days, ct));

    [HttpGet("reports/tasks.csv"), RequireModule(Modules.Reports)]
    public async Task<IActionResult> ExportTasks(CancellationToken ct)
    {
        var csv = await reports.ExportTasksCsvAsync(ct);
        return File(new UTF8Encoding(true).GetPreamble().Concat(Encoding.UTF8.GetBytes(csv)).ToArray(), "text/csv", $"tasks-{DateTime.UtcNow:yyyyMMdd}.csv");
    }

    // ---- generated reports (built in the background)

    [HttpGet("reports/exports"), RequireModule(Modules.Reports)]
    public async Task<IActionResult> Exports([FromServices] ProjectManagement.Application.Features.Reports.ReportExportService exports, CancellationToken ct) => Ok(await exports.ListAsync(ct));

    [HttpPost("reports/exports"), RequireModule(Modules.Reports)]
    public async Task<IActionResult> RequestExport([FromBody] ProjectManagement.Application.Features.Reports.RequestExportRequest req, [FromServices] ProjectManagement.Application.Features.Reports.ReportExportService exports, CancellationToken ct) =>
        StatusCode(StatusCodes.Status202Accepted, await exports.RequestAsync(req, ct));

    [HttpGet("reports/exports/{id:guid}"), RequireModule(Modules.Reports)]
    public async Task<IActionResult> ExportStatus(Guid id, [FromServices] ProjectManagement.Application.Features.Reports.ReportExportService exports, CancellationToken ct) => Ok(await exports.GetAsync(id, ct));

    [HttpGet("reports/exports/{id:guid}/file"), RequireModule(Modules.Reports)]
    public async Task<IActionResult> ExportFile(Guid id, [FromServices] ProjectManagement.Application.Features.Reports.ReportExportService exports, CancellationToken ct)
    {
        var (content, name, type) = await exports.OpenAsync(id, ct);
        return File(content, type, name);
    }

    [HttpDelete("reports/exports/{id:guid}"), RequireModule(Modules.Reports)]
    public async Task<IActionResult> DeleteExport(Guid id, [FromServices] ProjectManagement.Application.Features.Reports.ReportExportService exports, CancellationToken ct)
    {
        await exports.DeleteAsync(id, ct);
        return NoContent();
    }
}

[Route("api/v1/notifications")]
public class NotificationsController(NotificationService notifications) : ApiControllerBase
{
    [HttpGet]
    public async Task<IActionResult> List([FromQuery] bool unreadOnly = false, [FromQuery] int page = 1, [FromQuery] int pageSize = 25, CancellationToken ct = default) =>
        Ok(await notifications.ListAsync(unreadOnly, page, pageSize, ct));

    [HttpGet("unread-count")]
    public async Task<IActionResult> UnreadCount(CancellationToken ct) => Ok(await notifications.UnreadCountAsync(ct));

    [HttpPost("{id:guid}/read")]
    public async Task<IActionResult> MarkRead(Guid id, CancellationToken ct)
    {
        await notifications.MarkReadAsync(id, ct);
        return NoContent();
    }

    [HttpPost("read-all")]
    public async Task<IActionResult> MarkAllRead(CancellationToken ct)
    {
        await notifications.MarkAllReadAsync(ct);
        return NoContent();
    }
}
