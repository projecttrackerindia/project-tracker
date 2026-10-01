using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Workspaces;

public record SetAiAllowedRequest(bool Allowed);

/// <summary>The AI assistant (Claude). Every answer is built only from what the caller may already see.</summary>
[Route("api/v1/ai"), RequireWorkspace]
public class AiController(AiAssistant assistant) : ApiControllerBase
{
    /// <summary>Whether the assistant can be used here, and why not.</summary>
    [HttpGet("status")]
    public async Task<IActionResult> Status(CancellationToken ct) => Ok(await assistant.StatusAsync(ct));

    /// <summary>Owners and Admins switch the assistant on or off for the whole workspace.</summary>
    [HttpPut("status")]
    public async Task<IActionResult> SetAllowed([FromBody] SetAiAllowedRequest req, CancellationToken ct) => Ok(await assistant.SetAllowedAsync(req.Allowed, ct));

    [HttpPost("portfolio-summary"), RequireModule(Modules.Projects)]
    public async Task<IActionResult> Portfolio(CancellationToken ct) => Ok(await assistant.PortfolioSummaryAsync(ct));

    [HttpPost("projects/{projectId:guid}/risk"), RequireModule(Modules.Projects)]
    public async Task<IActionResult> Risk(Guid projectId, CancellationToken ct) => Ok(await assistant.ProjectRiskAsync(projectId, ct));

    [HttpPost("search")]
    public async Task<IActionResult> Search([FromBody] AiSearchRequest req, CancellationToken ct) => Ok(await assistant.SearchAsync(req, ct));

    [HttpPost("triage"), RequireModule(Modules.Work, AccessLevel.Edit)]
    public async Task<IActionResult> Triage([FromBody] AiTriageRequest req, CancellationToken ct) => Ok(await assistant.TriageAsync(req, ct));

    [HttpPost("projects/{projectId:guid}/action-items"), RequireModule(Modules.Projects)]
    public async Task<IActionResult> ActionItems(Guid projectId, [FromBody] AiNotesRequest req, CancellationToken ct) => Ok(await assistant.ActionItemsFromNotesAsync(projectId, req, ct));
}
