using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Agent;
namespace ProjectManagement.Api.Controllers.Workspaces;

/// <summary>The signed-in person's notetaker: settings, sending it to a call, its sessions and the minutes it writes.</summary>
[Route("api/v1/me/notetaker"), RequireWorkspace, ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
public class NotetakerController(NotetakerService notetaker) : ApiControllerBase
{
    [HttpGet] public async Task<IActionResult> Overview(CancellationToken ct) => Ok(await notetaker.OverviewAsync(ct));
    [HttpPut("settings")] public async Task<IActionResult> Settings([FromBody] NotetakerSettingsDto req, CancellationToken ct) => Ok(await notetaker.SaveSettingsAsync(req, ct));
    [HttpPost("join")] public async Task<IActionResult> Join([FromBody] NotetakerJoinRequest req, CancellationToken ct) => Created(await notetaker.JoinAsync(req, ct));
    [HttpPost("sessions/{id:guid}/stop")] public async Task<IActionResult> Stop(Guid id, CancellationToken ct) { await notetaker.StopAsync(id, ct); return NoContent(); }
    [HttpGet("sessions/{id:guid}/minutes")] public async Task<IActionResult> Minutes(Guid id, CancellationToken ct) => Ok(await notetaker.MinutesAsync(id, ct));
    [HttpPost("sessions/{id:guid}/minutes"), AiRequestLimit] public async Task<IActionResult> WriteMinutes(Guid id, CancellationToken ct) => Ok(await notetaker.GenerateMinutesAsync(id, ct));
    [HttpPost("sessions/{id:guid}/minutes/send"), ExternalOperation] public async Task<IActionResult> SendMinutes(Guid id, [FromBody] SendMinutesRequest req, CancellationToken ct) => Ok(await notetaker.SendMinutesAsync(id, req, ct));
}
