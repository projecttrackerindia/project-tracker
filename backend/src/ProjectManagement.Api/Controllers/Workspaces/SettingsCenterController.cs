using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Workspaces;

namespace ProjectManagement.Api.Controllers.Workspaces;

/// <summary>
/// Workspace settings as one place: setup health with fixes, who changed each setting (with undo of the last change), what a risky switch
/// would affect before it is saved, and the workspace's notification defaults.
/// </summary>
[Route("api/v1/settings"), RequireWorkspace]
public class SettingsCenterController(SettingsHistoryService history, SettingsImpactService impact, SetupHealthService health, NotificationDefaultsService defaults) : ApiControllerBase
{
    [HttpGet("health")]
    public async Task<IActionResult> Health(CancellationToken ct) => Ok(await health.GetAsync(ct));

    /// <summary>Marks a check as not needed in this workspace (it stops counting against the score).</summary>
    [HttpPost("health/{id}/dismiss")]
    public async Task<IActionResult> Dismiss(string id, [FromBody] DismissCheckRequest? req, CancellationToken ct) => Ok(await health.DismissAsync(id, req ?? new DismissCheckRequest(null), ct));

    [HttpDelete("health/{id}/dismiss")]
    public async Task<IActionResult> Restore(string id, CancellationToken ct) => Ok(await health.RestoreAsync(id, ct));

    /// <summary>Reminds every member without two-step sign-in to turn it on.</summary>
    [HttpPost("health/two-step/remind")]
    public async Task<IActionResult> RemindTwoStep(CancellationToken ct) => Ok(new { sent = await health.RemindTwoStepAsync(ct) });

    /// <summary>The last change of each setting in a section (or every section), with who made it.</summary>
    [HttpGet("changes")]
    public async Task<IActionResult> Changes([FromQuery] string? section, CancellationToken ct) => Ok(await history.SectionAsync(section, ct));

    [HttpGet("changes/recent")]
    public async Task<IActionResult> Recent([FromQuery] int take = 12, CancellationToken ct = default) => Ok(await history.RecentAsync(take, ct));

    /// <summary>Puts a setting back to what it was before its last change.</summary>
    [HttpPost("changes/{auditId:guid}/undo")]
    public async Task<IActionResult> Undo(Guid auditId, [FromBody] UndoSettingRequest req, CancellationToken ct) => Ok(await history.UndoAsync(auditId, req, ct));

    /// <summary>Who a stricter sign-in rule or a shorter retention would affect. Changes nothing.</summary>
    [HttpPost("impact")]
    public async Task<IActionResult> Impact([FromBody] SettingImpactRequest req, CancellationToken ct) => Ok(await impact.ImpactAsync(req, ct));

    [HttpGet("notification-defaults")]
    public async Task<IActionResult> NotificationDefaults(CancellationToken ct) => Ok(await defaults.GetAsync(ct));

    [HttpPut("notification-defaults")]
    public async Task<IActionResult> SaveNotificationDefaults([FromBody] SaveNotificationDefaultsRequest req, CancellationToken ct) => Ok(await defaults.SaveAsync(req, ct));
}
