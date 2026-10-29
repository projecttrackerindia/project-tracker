using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Api.Controllers.Workspaces;

/// <summary>The portfolio board for leaders: decisions with options, money, capacity, the timeline, a summary and an export (projects the person may open).</summary>
[Route("api/v1/portfolio"), RequireWorkspace, RequireModule(Modules.Projects)]
public class PortfolioController(PortfolioBoardService board, PlanSheetService sheet) : ApiControllerBase
{
    private static PortfolioFilter Filter(Guid? teamId, Guid? ownerId, Guid? groupId, string? health, DateOnly? dueFrom, DateOnly? dueTo) =>
        new(teamId, ownerId, groupId, string.IsNullOrWhiteSpace(health) ? null : health, dueFrom, dueTo);

    [HttpGet("board")]
    public async Task<IActionResult> Board([FromQuery] Guid? teamId, [FromQuery] Guid? ownerId, [FromQuery] Guid? groupId, [FromQuery] string? health,
        [FromQuery] DateOnly? dueFrom, [FromQuery] DateOnly? dueTo, CancellationToken ct) => Ok(await board.BoardAsync(Filter(teamId, ownerId, groupId, health, dueFrom, dueTo), ct));

    [HttpGet("timeline")]
    public async Task<IActionResult> Timeline([FromQuery] Guid? teamId, [FromQuery] Guid? ownerId, [FromQuery] Guid? groupId, [FromQuery] string? health,
        [FromQuery] DateOnly? dueFrom, [FromQuery] DateOnly? dueTo, CancellationToken ct) => Ok(await board.TimelineAsync(Filter(teamId, ownerId, groupId, health, dueFrom, dueTo), ct));

    /// <summary>Turns a decision's option into proposals waiting in the project's Agent tab.</summary>
    [HttpPost("decisions/{projectId:guid}/apply")]
    public async Task<IActionResult> Apply(Guid projectId, [FromBody] ApplyDecisionRequest req, CancellationToken ct) => Ok(await board.ApplyAsync(projectId, req, ct));

    /// <summary>An executive summary written by the AI from the board's numbers.</summary>
    [HttpPost("summary"), AiRequestLimit]
    public async Task<IActionResult> Summary([FromQuery] Guid? teamId, [FromQuery] Guid? ownerId, [FromQuery] Guid? groupId, [FromQuery] string? health,
        [FromQuery] DateOnly? dueFrom, [FromQuery] DateOnly? dueTo, [FromQuery] bool fresh = false, CancellationToken ct = default) =>
        Ok(await board.AiSummaryAsync(Filter(teamId, ownerId, groupId, health, dueFrom, dueTo), fresh, ct));

    /// <summary>The board as Excel or PDF for the board meeting.</summary>
    [HttpGet("export")]
    public async Task<IActionResult> Export([FromQuery] string format, [FromQuery] Guid? teamId, [FromQuery] Guid? ownerId, [FromQuery] Guid? groupId, [FromQuery] string? health,
        [FromQuery] DateOnly? dueFrom, [FromQuery] DateOnly? dueTo, CancellationToken ct)
    {
        var f = string.Equals(format, "pdf", StringComparison.OrdinalIgnoreCase) ? ReportFormat.Pdf : string.Equals(format, "xlsx", StringComparison.OrdinalIgnoreCase) ? ReportFormat.Xlsx : ReportFormat.Csv;
        var file = await board.ExportAsync(Filter(teamId, ownerId, groupId, health, dueFrom, dueTo), f, ct);
        return File(file.Content, file.ContentType, $"portfolio-{DateTime.UtcNow:yyyy-MM-dd}.{file.Extension.TrimStart('.')}");
    }
    // ---------------------------------------------------------------- Plan sheet

    /// <summary>Portfolio › Plan sheet: projects, their tasks and sub-items, and meetings with their cadence, under the same filters as the board. mine: only my work.</summary>
    [HttpGet("sheet")]
    public async Task<IActionResult> Sheet([FromQuery] Guid? teamId, [FromQuery] Guid? ownerId, [FromQuery] Guid? groupId, [FromQuery] string? health,
        [FromQuery] DateOnly? dueFrom, [FromQuery] DateOnly? dueTo, [FromQuery] bool mine = false, CancellationToken ct = default) =>
        Ok(await sheet.GetAsync(Filter(teamId, ownerId, groupId, health, dueFrom, dueTo), mine, ct));

    /// <summary>Many rows at once (owner, dates, status); one reason covers every due date that moves later. Results per row.</summary>
    [HttpPost("sheet/bulk")]
    public async Task<IActionResult> SheetBulk([FromBody] PlanSheetBulkRequest req, CancellationToken ct) => Ok(await sheet.BulkAsync(req, ct));

    /// <summary>A row dragged to a new place in its project, or into another project (next number there, column of the same name).</summary>
    [HttpPost("sheet/move")]
    public async Task<IActionResult> SheetMove([FromBody] PlanSheetMoveRequest req, CancellationToken ct) => Ok(await sheet.MoveAsync(req, ct));

    /// <summary>Rows pasted from Excel: commit=false is a dry run (what each row would do), commit=true saves the chosen ready rows.</summary>
    [HttpPost("sheet/paste")]
    public async Task<IActionResult> SheetPaste([FromBody] PlanSheetPasteRequest req, CancellationToken ct) => Ok(await sheet.PasteAsync(req, ct));

    /// <summary>The sheet as .xlsx (outline levels per project) or .csv; columns: comma-separated visible columns; ids: only these rows.</summary>
    [HttpGet("sheet/export")]
    public async Task<IActionResult> SheetExport([FromQuery] string format, [FromQuery] Guid? teamId, [FromQuery] Guid? ownerId, [FromQuery] Guid? groupId, [FromQuery] string? health,
        [FromQuery] DateOnly? dueFrom, [FromQuery] DateOnly? dueTo, [FromQuery] string? columns, [FromQuery] bool mine = false, [FromQuery] bool meetings = true,
        [FromQuery] string? ids = null, CancellationToken ct = default)
    {
        var f = string.Equals(format, "xlsx", StringComparison.OrdinalIgnoreCase) ? ReportFormat.Xlsx : string.Equals(format, "csv", StringComparison.OrdinalIgnoreCase) ? ReportFormat.Csv : ReportFormat.Pdf;
        var cols = string.IsNullOrWhiteSpace(columns) ? null : columns.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var only = string.IsNullOrWhiteSpace(ids) ? null : ids.Split(',', StringSplitOptions.RemoveEmptyEntries).Select(x => Guid.TryParse(x, out var g) ? g : Guid.Empty).Where(g => g != Guid.Empty).ToList();
        var file = await sheet.ExportAsync(Filter(teamId, ownerId, groupId, health, dueFrom, dueTo), f, cols, mine, meetings, only, ct);
        return File(file.Content, file.ContentType, $"plan-sheet-{DateTime.UtcNow:yyyy-MM-dd}.{file.Extension.TrimStart('.')}");
    }
}
