using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.ProjectMeetings;

namespace ProjectManagement.Api.Controllers.Projects;

/// <summary>
/// Meet, the one place for meetings and calls: the sessions in a window (upcoming or past), the repeating series, whether the notetaker can
/// come to a project's meetings, and replies to invitations to Project Tracker calls. Creating, moving and cancelling meetings use the
/// meeting routes (api/v1/projects/{id}/meetings, api/v1/meetings).
/// </summary>
[Route("api/v1/meet"), RequireWorkspace]
public class MeetController(MeetFeedService feed, MeetingService meetings, MeetNotetaker notetaker) : ApiControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Feed([FromQuery] DateTimeOffset? from, [FromQuery] DateTimeOffset? to, [FromQuery] Guid? projectId, CancellationToken ct) =>
        Ok(await feed.FeedAsync(from, to, projectId, ct));

    [HttpGet("series")]
    public async Task<IActionResult> Series([FromQuery] Guid? projectId, CancellationToken ct) => Ok(await feed.SeriesAsync(projectId, ct));

    [HttpGet("notetaker")]
    public async Task<IActionResult> Notetaker([FromQuery] Guid projectId, CancellationToken ct) => Ok(await notetaker.ReadinessAsync(projectId, ct));

    [HttpPost("p/{id:guid}/rsvp")]
    public async Task<IActionResult> Rsvp(Guid id, [FromBody] MeetingRsvpRequest req, CancellationToken ct) => Ok(new { rsvp = await meetings.RespondAsync(id, req, ct) });

    [HttpPost("w/{id:guid}/rsvp")]
    public async Task<IActionResult> RsvpWorkspace(Guid id, [FromBody] MeetingRsvpRequest req, CancellationToken ct) => Ok(new { rsvp = await meetings.RespondWorkspaceAsync(id, req, ct) });
}
