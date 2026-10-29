using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Quality;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Work;

/// <summary>
/// Quality (testers): test cases, runs, the cases-by-runs matrix, results, readiness and filing a bug from a failed result. Behind the Work
/// module like the rest of operational work: reading needs View, every change needs Edit. See <see cref="QualityService"/>.
/// </summary>
[Route("api/v1/quality"), RequireWorkspace, RequireModule(Modules.Work)]
public class QualityController(QualityService quality) : ApiControllerBase
{
    [HttpGet("cases")]
    public async Task<IActionResult> Cases([FromQuery] Guid? projectId, CancellationToken ct) => Ok(await quality.ListCasesAsync(projectId, ct));

    [HttpPost("cases"), RequireModule(Modules.Work, AccessLevel.Edit)]
    public async Task<IActionResult> CreateCase([FromBody] UpsertTestCaseRequest req, CancellationToken ct) => Created(await quality.CreateCaseAsync(req, ct));

    [HttpPut("cases/{id:guid}"), RequireModule(Modules.Work, AccessLevel.Edit)]
    public async Task<IActionResult> UpdateCase(Guid id, [FromBody] UpsertTestCaseRequest req, CancellationToken ct) => Ok(await quality.UpdateCaseAsync(id, req, ct));

    [HttpGet("runs")]
    public async Task<IActionResult> Runs([FromQuery] Guid? projectId, CancellationToken ct) => Ok(await quality.ListRunsAsync(projectId, ct));

    [HttpPost("runs"), RequireModule(Modules.Work, AccessLevel.Edit)]
    public async Task<IActionResult> CreateRun([FromBody] CreateTestRunRequest req, CancellationToken ct) => Created(await quality.CreateRunAsync(req, ct));

    public record RunStatusRequest(string? Status);

    [HttpPut("runs/{id:guid}/status"), RequireModule(Modules.Work, AccessLevel.Edit)]
    public async Task<IActionResult> SetRunStatus(Guid id, [FromBody] RunStatusRequest req, CancellationToken ct) => Ok(await quality.SetRunStatusAsync(id, req.Status, ct));

    /// <summary>Cases (rows) by the most recent runs (columns, oldest first) with every result among them.</summary>
    [HttpGet("matrix")]
    public async Task<IActionResult> Matrix([FromQuery] Guid? projectId, [FromQuery] int runs = 4, CancellationToken ct = default) => Ok(await quality.MatrixAsync(projectId, runs, ct));

    [HttpPut("runs/{runId:guid}/results/{caseId:guid}"), RequireModule(Modules.Work, AccessLevel.Edit)]
    public async Task<IActionResult> SetResult(Guid runId, Guid caseId, [FromBody] SetTestResultRequest req, CancellationToken ct) => Ok(await quality.SetResultAsync(runId, caseId, req, ct));

    /// <summary>Pass rate and blockers of a run (the latest when none is named).</summary>
    [HttpGet("readiness")]
    public async Task<IActionResult> Readiness([FromQuery] Guid? runId, [FromQuery] Guid? projectId, CancellationToken ct) => Ok(await quality.ReadinessAsync(runId, projectId, ct));

    /// <summary>An API endpoint's "Tests": linked cases, the latest run per environment, coverage, and the "Add test case" prefill.</summary>
    [HttpGet("endpoints/{endpointId:guid}/tests")]
    public async Task<IActionResult> EndpointTests([FromServices] QualityLinksService links, Guid endpointId, [FromQuery] int days = QualityLinksService.DefaultDays, CancellationToken ct = default) =>
        Ok(await links.EndpointAsync(endpointId, days, ct));

    /// <summary>Aura's proposed test cases for an endpoint (happy path, 400, 401/403, timeout, idempotency, masked logs). Nothing is saved.</summary>
    [HttpGet("endpoints/{endpointId:guid}/suggestions")]
    public async Task<IActionResult> EndpointSuggestions([FromServices] QualityLinksService links, Guid endpointId, CancellationToken ct) => Ok(await links.SuggestAsync(endpointId, ct));

    /// <summary>API test coverage per project: endpoints with a passing run in the last <c>days</c> days.</summary>
    [HttpGet("coverage")]
    public async Task<IActionResult> Coverage([FromServices] QualityLinksService links, [FromQuery] Guid? projectId, [FromQuery] int days = QualityLinksService.DefaultDays, CancellationToken ct = default) =>
        Ok(await links.CoverageAsync(projectId, days, ct));

    /// <summary>Creates a ticket from a failed result, linked to it.</summary>
    [HttpPost("results/{id:guid}/bug"), RequireModule(Modules.Work, AccessLevel.Edit)]
    public async Task<IActionResult> FileBug(Guid id, [FromBody] FileBugRequest? req, CancellationToken ct) => Created(await quality.FileBugAsync(id, req ?? new FileBugRequest(), ct));
}
