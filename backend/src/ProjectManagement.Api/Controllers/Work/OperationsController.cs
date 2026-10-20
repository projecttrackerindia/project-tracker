using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Work;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Work;

/// <summary>Operations as a tool: business hours and escalation, routing rules, smart triage, changing many work tasks at once, and analytics.</summary>
[Route("api/v1/operations"), RequireWorkspace, RequireModule(Modules.Work)]
public class OperationsController(OperationsService ops) : ApiControllerBase
{
    [HttpGet("settings")]
    public async Task<IActionResult> Settings(CancellationToken ct) => Ok(await ops.GetSettingsAsync(ct));

    [HttpPut("settings")]
    public async Task<IActionResult> SaveSettings([FromBody] SaveOperationsSettingsRequest req, CancellationToken ct) => Ok(await ops.SaveSettingsAsync(req, ct));

    [HttpPost("routing")]
    public async Task<IActionResult> AddRule([FromBody] SaveRoutingRuleRequest req, CancellationToken ct) => Ok(await ops.SaveRuleAsync(null, req, ct));

    [HttpPut("routing/{id:guid}")]
    public async Task<IActionResult> SaveRule(Guid id, [FromBody] SaveRoutingRuleRequest req, CancellationToken ct) => Ok(await ops.SaveRuleAsync(id, req, ct));

    [HttpDelete("routing/{id:guid}")]
    public async Task<IActionResult> DeleteRule(Guid id, CancellationToken ct) => Ok(await ops.DeleteRuleAsync(id, ct));

    /// <summary>Suggestions for new work: type, priority, who usually handles it, and open work that looks the same.</summary>
    [HttpPost("triage")]
    public async Task<IActionResult> Triage([FromBody] TriageRequest req, CancellationToken ct) => Ok(await ops.TriageAsync(req, ct));

    [HttpPost("bulk"), RequireModule(Modules.Work, AccessLevel.Edit)]
    public async Task<IActionResult> Bulk([FromBody] BulkWorkRequest req, CancellationToken ct) => Ok(await ops.BulkAsync(req, ct));

    [HttpGet("insights")]
    public async Task<IActionResult> Insights([FromQuery] int days = 90, CancellationToken ct = default) => Ok(await ops.InsightsAsync(days, ct));
}
