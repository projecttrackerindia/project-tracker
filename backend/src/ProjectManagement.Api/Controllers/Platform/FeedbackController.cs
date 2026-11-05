using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Platform;

namespace ProjectManagement.Api.Controllers.Platform;

/// <summary>"Report a problem": anyone in the workspace sends one; owners and admins read them. See <see cref="ProblemReportService"/>.</summary>
[Route("api/v1/problem-reports"), RequireWorkspace]
public class ProblemReportsController(ProblemReportService reports) : ApiControllerBase
{
    [HttpPost, RequestSizeLimit(8 * 1024 * 1024)]
    public async Task<IActionResult> Submit([FromBody] ProblemReportRequest req, CancellationToken ct) => Created(await reports.SubmitAsync(req, ct));

    [HttpGet]
    public async Task<IActionResult> List(CancellationToken ct) => Ok(await reports.ListAsync(ct));

    [HttpGet("{id:guid}/screenshot")]
    public async Task<IActionResult> Screenshot(Guid id, CancellationToken ct)
    {
        var (content, type) = await reports.ScreenshotAsync(id, ct);
        return File(content, type);
    }

    public record StatusRequest(string Status);

    [HttpPost("{id:guid}/status")]
    public async Task<IActionResult> SetStatus(Guid id, [FromBody] StatusRequest req, CancellationToken ct) { await reports.SetStatusAsync(id, req.Status, ct); return NoContent(); }
}

/// <summary>Feature flags: what the signed-in person gets, and (owners and admins) the switches per workspace, team and person.</summary>
[Route("api/v1/feature-flags"), RequireWorkspace]
public class FeatureFlagsController(FeatureFlagService flags) : ApiControllerBase
{
    [HttpGet("mine")]
    public async Task<IActionResult> Mine(CancellationToken ct) => Ok(new { flags = await flags.MineAsync(ct) });

    [HttpGet]
    public async Task<IActionResult> List(CancellationToken ct) => Ok(await flags.ListAsync(ct));

    [HttpPut("{key}")]
    public async Task<IActionResult> Set(string key, [FromBody] SetFeatureFlagRequest req, CancellationToken ct) => Ok(await flags.SetAsync(key, req, ct));
}
