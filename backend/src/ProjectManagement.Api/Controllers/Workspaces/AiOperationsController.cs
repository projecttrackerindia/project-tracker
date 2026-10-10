using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Common;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Ai;

namespace ProjectManagement.Api.Controllers.Workspaces;

[Route("api/v1/ai/operations"), RequireWorkspace]
public class AiOperationsController(AiOperationsService service, AiForecastService forecasts) : ApiControllerBase
{
    [HttpGet("forecasts")]
    public async Task<IActionResult> Forecasts(CancellationToken ct) => Ok(await forecasts.EvaluateAsync(ct));
    [HttpGet("jobs")]
    public async Task<IActionResult> List(CancellationToken ct) => Ok(await service.ListAsync(ct));
    [HttpGet("jobs/{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct) => Ok(await service.GetAsync(id, ct));
    [HttpPost("jobs")]
    public async Task<IActionResult> Submit(SubmitAiJobRequest req, CancellationToken ct) => Ok(await service.SubmitAsync(req, ct));
    [HttpPost("jobs/{id:guid}/cancel")]
    public async Task<IActionResult> Cancel(Guid id, CancellationToken ct) => Ok(await service.CancelAsync(id, ct));
    [HttpGet("schedules")]
    public async Task<IActionResult> Schedules(CancellationToken ct) => Ok(await service.SchedulesAsync(ct));
    [HttpPost("schedules")]
    public async Task<IActionResult> Schedule(AiScheduleRequest req, CancellationToken ct) => Ok(await service.ScheduleAsync(req, ct));
    [HttpDelete("schedules/{id:guid}")]
    public async Task<IActionResult> Remove(Guid id, CancellationToken ct) { await service.RemoveScheduleAsync(id, ct); return NoContent(); }
}
