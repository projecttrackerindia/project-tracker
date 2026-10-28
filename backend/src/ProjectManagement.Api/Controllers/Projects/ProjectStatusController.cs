using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Projects;

/// <summary>Feeds the Project Status presentation page.</summary>
[Route("api/v1/project-status"), RequireWorkspace, RequireModule(Modules.Projects)]
public class ProjectStatusController(ProjectStatusService status, WeeklyReportService weekly) : ApiControllerBase
{
    /// <summary>The projects organized by group, for the page's sidebar.</summary>
    [HttpGet("groups")]
    public async Task<IActionResult> Groups([FromQuery] Guid? teamId, CancellationToken ct) => Ok(await status.GroupsAsync(teamId, ct));

    /// <summary>One project's status: its tasks, the history of its delivery dates and what is blocking work.</summary>
    [HttpGet("projects/{id:guid}")]
    public async Task<IActionResult> Report(Guid id, CancellationToken ct) => Ok(await status.ReportAsync(id, ct));

    /// <summary>This week's status report of a project, written from its data: what moved, what slipped and why, risks, next week.</summary>
    [HttpGet("projects/{id:guid}/weekly")]
    public async Task<IActionResult> Weekly(Guid id, CancellationToken ct) => Ok(await weekly.DraftAsync(id, ct));

    /// <summary>Posts the (edited) weekly report in the project chat.</summary>
    [HttpPost("projects/{id:guid}/weekly/send")]
    public async Task<IActionResult> SendWeekly(Guid id, [FromBody] SendWeeklyReportRequest req, CancellationToken ct) { await weekly.SendAsync(id, req, ct); return Ok(new { sent = true }); }

    /// <summary>"Every Friday 5 PM · you approve first": a repeating reminder for me that opens the report page.</summary>
    [HttpPost("projects/{id:guid}/weekly/schedule")]
    public async Task<IActionResult> ScheduleWeekly(Guid id, [FromBody] ScheduleWeeklyReportRequest req, CancellationToken ct) => Ok(await weekly.ScheduleAsync(id, req, ct));

    /// <summary>Stops my Friday reminder for this project's report.</summary>
    [HttpDelete("projects/{id:guid}/weekly/schedule")]
    public async Task<IActionResult> UnscheduleWeekly(Guid id, CancellationToken ct) { await weekly.UnscheduleAsync(id, ct); return Ok(new { scheduled = false }); }
}
