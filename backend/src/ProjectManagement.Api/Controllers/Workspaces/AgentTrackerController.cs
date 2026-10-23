using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Common;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Agent;
using ProjectManagement.Application.Features.Ai;

namespace ProjectManagement.Api.Controllers.Workspaces;

[Route("api/v1/ai/tracker"), RequireWorkspace]
public sealed class AgentTrackerController(AgentTrackerService tracker, IAiDiagnostics diagnostics, AiAssistant assistant, AgentCostService costs,
    AgentAlertService alerts, AgentDigestService digest, AgentAutonomyHintService hints, AiQualityService quality) : ApiControllerBase
{
    /// <summary>How well the assistant is landing: not-helpful answers, questions asked again, cards dismissed or undone, tool failures, by week and area, and scenario gradings.</summary>
    [HttpGet("quality")]
    public async Task<IActionResult> Quality([FromQuery] DateTime? from, [FromQuery] DateTime? to, CancellationToken ct) => Ok(await quality.GetAsync(from, to, ct));

    /// <summary>Records a scenario grading (numbers only), sent by tools/ai-evaluation/run-scenarios.mjs when asked to.</summary>
    [HttpPost("evaluations")]
    public async Task<IActionResult> ReportEvaluation([FromBody] ReportEvaluationRequest req, CancellationToken ct) => Created(await quality.ReportAsync(req, ct));

    /// <summary>AI credits this month by agent and project, the last two weeks, and when they run out at the current pace.</summary>
    [HttpGet("cost")]
    public async Task<IActionResult> Cost(CancellationToken ct) => Ok(await costs.GetAsync(ct));

    /// <summary>What needs attention now, and the alert thresholds.</summary>
    [HttpGet("alerts")]
    public async Task<IActionResult> Alerts(CancellationToken ct) => Ok(await alerts.GetAsync(ct));

    [HttpPut("alerts")]
    public async Task<IActionResult> SaveAlerts([FromBody] AgentAlertSettingsDto req, CancellationToken ct) => Ok(await alerts.SaveAsync(req, ct));

    /// <summary>The weekly agent summary as it would read now (preview).</summary>
    [HttpGet("digest")]
    public async Task<IActionResult> Digest([FromServices] ProjectManagement.Application.Services.AppClock clock, CancellationToken ct)
    { tracker.AuthorizeDiagnostics(); return Ok(await digest.BuildAsync(clock.Now, ct)); }

    /// <summary>Sends the weekly summary to me now (by my notification settings).</summary>
    [HttpPost("digest/send")]
    public async Task<IActionResult> SendDigest(CancellationToken ct)
    { tracker.AuthorizeDiagnostics(); return Ok(new { sent = await digest.SendDueAsync(ct, force: true) }); }

    /// <summary>Projects whose agent has earned more autonomy for a kind of proposal.</summary>
    [HttpGet("autonomy-hints")]
    public async Task<IActionResult> AutonomyHints(CancellationToken ct) => Ok(await hints.WorkspaceAsync(ct));

    [HttpGet]
    public async Task<IActionResult> List([FromQuery] DateTime? from, [FromQuery] DateTime? to, [FromQuery] string? status,
        [FromQuery] string? model, [FromQuery] int page = 1, [FromQuery] int pageSize = 25, CancellationToken ct = default, [FromQuery] string? intent = null)
        => Ok(await tracker.ListAsync(from, to, status, model, page, pageSize, ct, intent));

    /// <summary>Every agent in the workspace over a period: project agent readings and decisions, meeting bot sessions, follow-ups.</summary>
    [HttpGet("fleet")]
    public async Task<IActionResult> Fleet([FromQuery] DateTime? from, [FromQuery] DateTime? to, CancellationToken ct) => Ok(await tracker.FleetAsync(from, to, ct));

    [HttpGet("health")]
    public async Task<IActionResult> Health(CancellationToken ct)
    { tracker.AuthorizeDiagnostics(); return Ok(await diagnostics.CheckAsync(ct)); }

    public record SwitchRequest(bool Enabled);
    [HttpPut("agent")]
    public async Task<IActionResult> Switch([FromBody] SwitchRequest request, CancellationToken ct)
        => Ok(await assistant.SetAllowedAsync(request.Enabled, ct));
}
