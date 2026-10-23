using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Api.Controllers.Workspaces;

/// <summary>The portfolio board for leaders: decisions with options, money, capacity, the timeline, a summary and an export (projects the person may open).</summary>
[Route("api/v1/portfolio"), RequireWorkspace, RequireModule(Modules.Projects)]
public class PortfolioController(PortfolioBoardService board) : ApiControllerBase
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
}
