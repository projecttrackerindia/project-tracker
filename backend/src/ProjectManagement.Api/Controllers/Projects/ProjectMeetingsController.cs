using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.ProjectMeetings;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Projects;

/// <summary>Google Meet meetings of a project: who may be invited, starting one now, scheduling one, and the project's meeting list.</summary>
[Route("api/v1/projects/{projectId:guid}/meetings"), RequireWorkspace, RequireModule(Modules.Projects)]
public class ProjectMeetingsController(MeetingService meetings) : ApiControllerBase
{
    [HttpGet]
    public async Task<IActionResult> List(Guid projectId, CancellationToken ct) => Ok(await meetings.ListAsync(projectId, ct));

    [HttpGet("participants")]
    public async Task<IActionResult> Participants(Guid projectId, CancellationToken ct) => Ok(await meetings.EligibleParticipantsAsync(projectId, ct));

    [HttpPost("start")]
    public async Task<IActionResult> Start(Guid projectId, [FromBody] StartMeetingRequest req, CancellationToken ct) => Created(await meetings.StartNowAsync(projectId, req, ct));

    [HttpPost("schedule")]
    public async Task<IActionResult> Schedule(Guid projectId, [FromBody] ScheduleMeetingRequest req, CancellationToken ct) => Created(await meetings.ScheduleAsync(projectId, req, ct));
}

/// <summary>Meetings that belong to the workspace rather than a project - "Schedule a scrum call" with no project chosen. Calendar-module gated,
/// since that is where the entry point lives; who may be invited is the workspace's active, non-guest members.</summary>
[Route("api/v1/meetings"), RequireWorkspace, RequireModule(Modules.Calendar)]
public class WorkspaceMeetingsController(MeetingService meetings) : ApiControllerBase
{
    [HttpGet("participants")]
    public async Task<IActionResult> Participants(CancellationToken ct) => Ok(await meetings.WorkspaceParticipantsAsync(ct));

    [HttpPost("schedule")]
    public async Task<IActionResult> Schedule([FromBody] ScheduleMeetingRequest req, CancellationToken ct) => Created(await meetings.ScheduleForWorkspaceAsync(req, ct));

    [HttpGet("workspace/{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct) => Ok(await meetings.GetWorkspaceMeetingAsync(id, ct));

    [HttpPost("workspace/{id:guid}/cancel")]
    public async Task<IActionResult> Cancel(Guid id, CancellationToken ct)
    {
        await meetings.CancelWorkspaceMeetingAsync(id, ct);
        return NoContent();
    }

    [HttpPost("workspace/{id:guid}/reschedule")]
    public async Task<IActionResult> Reschedule(Guid id, [FromBody] RescheduleMeetingRequest req, CancellationToken ct) => Ok(await meetings.RescheduleWorkspaceMeetingAsync(id, req, ct));
}

/// <summary>A single meeting, once you have its id (not nested under its project - the id alone is enough, same as a task).</summary>
[Route("api/v1/meetings/{id:guid}"), RequireWorkspace]
public class MeetingsController(MeetingService meetings, StandupSummaryService standups) : ApiControllerBase
{
    /// <summary>Posts the stand-up summary for this meeting's project to its chat now (the organizer, or anyone who may edit projects).</summary>
    [HttpPost("standup-summary")]
    public async Task<IActionResult> StandupSummary(Guid id, CancellationToken ct) => Ok(await standups.PostNowAsync(id, ct));

    [HttpGet]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct) => Ok(await meetings.GetAsync(id, ct));

    [HttpPost("cancel")]
    public async Task<IActionResult> Cancel(Guid id, CancellationToken ct)
    {
        await meetings.CancelAsync(id, ct);
        return NoContent();
    }

    [HttpPost("reschedule")]
    public async Task<IActionResult> Reschedule(Guid id, [FromBody] RescheduleMeetingRequest req, CancellationToken ct) => Ok(await meetings.RescheduleAsync(id, req, ct));

    [HttpPost("participants")]
    public async Task<IActionResult> AddParticipant(Guid id, [FromBody] AddMeetingParticipantRequest req, CancellationToken ct) => Ok(await meetings.AddParticipantAsync(id, req, ct));

    [HttpDelete("participants/{userId:guid}")]
    public async Task<IActionResult> RemoveParticipant(Guid id, Guid userId, CancellationToken ct) => Ok(await meetings.RemoveParticipantAsync(id, userId, ct));
}
