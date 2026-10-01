using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Time;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Time;

/// <summary>
/// Time entries on project tasks and on work tasks, the start/stop timer, timesheets and project time summaries. The timer, your own
/// entries and your timesheet are not tied to one module: someone who only does operational work tracks their time the same way.
/// </summary>
[Route("api/v1"), RequireWorkspace]
public class TimeController(TimeService time, TimesheetApprovalService approvals) : ApiControllerBase
{
    // ---- on a project task
    [HttpGet("tasks/{taskId:guid}/time"), RequireModule(Modules.Tasks)]
    public async Task<IActionResult> ForTask(Guid taskId, CancellationToken ct) => Ok(await time.GetForTaskAsync(taskId, ct));

    [HttpPost("tasks/{taskId:guid}/time"), RequireModule(Modules.Tasks, AccessLevel.Edit)]
    public async Task<IActionResult> Log(Guid taskId, [FromBody] LogTimeRequest req, CancellationToken ct) => Created(await time.LogAsync(taskId, req, ct));

    [HttpPost("tasks/{taskId:guid}/timer/start"), RequireModule(Modules.Tasks, AccessLevel.Edit)]
    public async Task<IActionResult> Start(Guid taskId, CancellationToken ct) => Ok(await time.StartTimerAsync(taskId, ct));

    // ---- on a work task
    [HttpGet("work-tasks/{workTaskId:guid}/time"), RequireModule(Modules.Work)]
    public async Task<IActionResult> ForWorkTask(Guid workTaskId, CancellationToken ct) => Ok(await time.GetForWorkTaskAsync(workTaskId, ct));

    [HttpPost("work-tasks/{workTaskId:guid}/time"), RequireModule(Modules.Work, AccessLevel.Edit)]
    public async Task<IActionResult> LogOnWorkTask(Guid workTaskId, [FromBody] LogTimeRequest req, CancellationToken ct) => Created(await time.LogOnWorkTaskAsync(workTaskId, req, ct));

    [HttpPost("work-tasks/{workTaskId:guid}/timer/start"), RequireModule(Modules.Work, AccessLevel.Edit)]
    public async Task<IActionResult> StartOnWorkTask(Guid workTaskId, CancellationToken ct) => Ok(await time.StartWorkTimerAsync(workTaskId, ct));

    // ---- my timer, my entries, timesheets
    [HttpPost("timer/stop")]
    public async Task<IActionResult> Stop(CancellationToken ct) => Ok(await time.StopTimerAsync(ct));

    /// <summary>My running timer, or null.</summary>
    [HttpGet("timer")]
    public async Task<IActionResult> Running(CancellationToken ct) => Ok(await time.GetRunningAsync(ct));

    [HttpPut("time/{id:guid}")]
    public async Task<IActionResult> Update(Guid id, [FromBody] UpdateTimeRequest req, CancellationToken ct) => Ok(await time.UpdateAsync(id, req, ct));

    [HttpDelete("time/{id:guid}")]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
    {
        await time.DeleteAsync(id, ct);
        return NoContent();
    }

    [HttpGet("time")]
    public async Task<IActionResult> Timesheet([FromQuery] DateOnly? from, [FromQuery] DateOnly? to, [FromQuery] Guid? userId, CancellationToken ct) =>
        Ok(await time.TimesheetAsync(from, to, userId, ct));

    [HttpGet("projects/{projectId:guid}/time"), RequireModule(Modules.Projects)]
    public async Task<IActionResult> ProjectSummary(Guid projectId, CancellationToken ct) => Ok(await time.ProjectSummaryAsync(projectId, ct));

    // ---- weekly approval
    /// <summary>A person's week (mine when no user is given) and where it stands.</summary>
    [HttpGet("time/week")]
    public async Task<IActionResult> Week([FromQuery] DateOnly? weekStart, [FromQuery] Guid? userId, CancellationToken ct) => Ok(await approvals.WeekAsync(weekStart, userId, ct));

    [HttpPost("time/week/submit")]
    public async Task<IActionResult> Submit([FromBody] SubmitTimesheetRequest req, CancellationToken ct) => Ok(await approvals.SubmitAsync(req, ct));

    [HttpPost("time/week/withdraw")]
    public async Task<IActionResult> Withdraw([FromBody] SubmitTimesheetRequest req, CancellationToken ct) => Ok(await approvals.WithdrawAsync(req.WeekStart, ct));

    /// <summary>The weeks the caller reviews: everyone's status for one week, and everything still waiting.</summary>
    [HttpGet("time/approvals")]
    public async Task<IActionResult> Approvals([FromQuery] DateOnly? weekStart, CancellationToken ct) => Ok(await approvals.ApprovalsAsync(weekStart, ct));

    [HttpPost("time/approvals/{id:guid}/approve")]
    public async Task<IActionResult> Approve(Guid id, [FromBody] ReviewTimesheetRequest req, CancellationToken ct) => Ok(await approvals.ApproveAsync(id, req, ct));

    [HttpPost("time/approvals/{id:guid}/reject")]
    public async Task<IActionResult> Reject(Guid id, [FromBody] ReviewTimesheetRequest req, CancellationToken ct) => Ok(await approvals.RejectAsync(id, req, ct));
}
