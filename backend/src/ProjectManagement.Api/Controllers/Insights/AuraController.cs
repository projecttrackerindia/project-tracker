using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Insights;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Insights;

/// <summary>
/// Aura tells people what to do: the morning briefing (what needs you, what is at risk and why, today's meetings), the review of what a meeting
/// produced (approve all, or edit), the Friday status report (preview, edit, send) and "why is X late?" answered with the records it used.
/// </summary>
[Route("api/v1/aura"), RequireWorkspace]
public class AuraController : ApiControllerBase
{
    [HttpGet("briefing")]
    public async Task<IActionResult> Briefing([FromServices] AuraBriefingService briefing, CancellationToken ct) => Ok(await briefing.GetAsync(ct));

    [HttpPost("ask")]
    public async Task<IActionResult> Ask([FromServices] AuraWhyService why, [FromBody] AuraAskRequest req, CancellationToken ct) => Ok(await why.AskAsync(req, ct));

    /// <summary>The newest meeting waiting for my review (204 when there is none).</summary>
    [HttpGet("meetings/review"), RequireModule(Modules.Projects)]
    public async Task<IActionResult> LatestReview([FromServices] AuraMeetingReviewService review, CancellationToken ct) =>
        await review.LatestAsync(ct) is { } r ? (IActionResult)Ok(r) : NoContent();

    [HttpGet("meetings/{runId:guid}/review"), RequireModule(Modules.Projects)]
    public async Task<IActionResult> Review([FromServices] AuraMeetingReviewService review, Guid runId, CancellationToken ct) => Ok(await review.GetAsync(runId, ct));

    [HttpPost("meetings/{runId:guid}/review"), RequireModule(Modules.Projects)]
    public async Task<IActionResult> Decide([FromServices] AuraMeetingReviewService review, Guid runId, [FromBody] AuraReviewRequest req, CancellationToken ct) =>
        Ok(await review.DecideAsync(runId, req, ct));

    [HttpGet("friday"), RequireModule(Modules.Projects)]
    public async Task<IActionResult> Friday([FromServices] AuraFridayService friday, CancellationToken ct) => Ok(await friday.DraftAsync(ct));

    [HttpPost("friday/send"), RequireModule(Modules.Projects)]
    public async Task<IActionResult> SendFriday([FromServices] AuraFridayService friday, [FromBody] AuraFridaySendRequest req, CancellationToken ct) => Ok(await friday.SendAsync(req, ct));
}
