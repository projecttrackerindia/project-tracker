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

/// <summary>A single meeting, once you have its id (not nested under its project - the id alone is enough, same as a task).</summary>
[Route("api/v1/meetings/{id:guid}"), RequireWorkspace]
public class MeetingsController(MeetingService meetings) : ApiControllerBase
{
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
