using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Automation;
using ProjectManagement.Application.Features.Time;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Time;

/// <summary>Time entries, the start/stop timer, timesheets and project time summaries.</summary>
[Route("api/v1"), RequireWorkspace]
public class TimeController(TimeService time) : ApiControllerBase
{
    [HttpGet("tasks/{taskId:guid}/time"), RequireModule(Modules.Tasks)]
    public async Task<IActionResult> ForTask(Guid taskId, CancellationToken ct) => Ok(await time.GetForTaskAsync(taskId, ct));

    [HttpPost("tasks/{taskId:guid}/time"), RequireModule(Modules.Tasks, AccessLevel.Edit)]
    public async Task<IActionResult> Log(Guid taskId, [FromBody] LogTimeRequest req, CancellationToken ct) => Created(await time.LogAsync(taskId, req, ct));

    [HttpPost("tasks/{taskId:guid}/timer/start"), RequireModule(Modules.Tasks, AccessLevel.Edit)]
    public async Task<IActionResult> Start(Guid taskId, CancellationToken ct) => Ok(await time.StartTimerAsync(taskId, ct));

    [HttpPost("timer/stop"), RequireModule(Modules.Tasks, AccessLevel.Edit)]
    public async Task<IActionResult> Stop(CancellationToken ct) => Ok(await time.StopTimerAsync(ct));

    /// <summary>My running timer, or null.</summary>
    [HttpGet("timer"), RequireModule(Modules.Tasks)]
    public async Task<IActionResult> Running(CancellationToken ct) => Ok(await time.GetRunningAsync(ct));

    [HttpPut("time/{id:guid}"), RequireModule(Modules.Tasks, AccessLevel.Edit)]
    public async Task<IActionResult> Update(Guid id, [FromBody] UpdateTimeRequest req, CancellationToken ct) => Ok(await time.UpdateAsync(id, req, ct));

    [HttpDelete("time/{id:guid}"), RequireModule(Modules.Tasks, AccessLevel.Edit)]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
    {
        await time.DeleteAsync(id, ct);
        return NoContent();
    }

    [HttpGet("time"), RequireModule(Modules.Tasks)]
    public async Task<IActionResult> Timesheet([FromQuery] DateOnly? from, [FromQuery] DateOnly? to, [FromQuery] Guid? userId, CancellationToken ct) =>
        Ok(await time.TimesheetAsync(from, to, userId, ct));

    [HttpGet("projects/{projectId:guid}/time"), RequireModule(Modules.Projects)]
    public async Task<IActionResult> ProjectSummary(Guid projectId, CancellationToken ct) => Ok(await time.ProjectSummaryAsync(projectId, ct));
}
