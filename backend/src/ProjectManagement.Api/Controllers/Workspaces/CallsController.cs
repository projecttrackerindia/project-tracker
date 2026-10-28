using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Common;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Calls;

namespace ProjectManagement.Api.Controllers.Workspaces;

/// <summary>Our own video calls: start one (in a project, a chat or on its own), join with a short-lived pass, end it for everyone.</summary>
[Route("api/v1/calls"), RequireWorkspace]
public sealed class CallsController(CallService calls, ProjectManagement.Application.Features.Notifications.NotificationService notifications) : ApiControllerBase
{
    [HttpGet("status")]
    public IActionResult Status() => Ok(calls.Status());

    [HttpGet("live")]
    public async Task<IActionResult> Live(CancellationToken ct) => Ok(await calls.LiveAsync(ct));

    [HttpPost]
    public async Task<IActionResult> Start([FromBody] StartCallRequest req, CancellationToken ct) => Created(await calls.StartAsync(req, ct));

    /// <summary>The call for a project meeting held as a Project Tracker call: joins it, or starts it when nobody has yet.</summary>
    [HttpPost("meeting/{meetingId:guid}")]
    public async Task<IActionResult> OpenMeeting(Guid meetingId, CancellationToken ct)
    {
        var call = await calls.OpenMeetingAsync(meetingId, false, ct);
        await notifications.MarkSeenAsync(ProjectManagement.Application.Features.Notifications.NotificationTargets.Meeting, meetingId, ct);   // joined: its reminders are read
        return Ok(call);
    }

    /// <summary>The same, for a workspace meeting (no project).</summary>
    [HttpPost("meeting/w/{meetingId:guid}")]
    public async Task<IActionResult> OpenWorkspaceMeeting(Guid meetingId, CancellationToken ct)
    {
        var call = await calls.OpenMeetingAsync(meetingId, true, ct);
        await notifications.MarkSeenAsync(ProjectManagement.Application.Features.Notifications.NotificationTargets.Meeting, meetingId, ct);
        return Ok(call);
    }

    [HttpGet("{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct) => Ok(await calls.GetAsync(id, ct));

    [HttpPost("{id:guid}/join")]
    public async Task<IActionResult> Join(Guid id, CancellationToken ct)
    {
        var pass = await calls.JoinAsync(id, ct);
        await notifications.MarkSeenAsync(ProjectManagement.Application.Features.Notifications.NotificationTargets.Call, id, ct);   // joined: the ringing / invitation notices are read
        return Ok(pass);
    }

    /// <summary>Turns down a call that is ringing for you: it stops ringing on your other devices and the caller is told.</summary>
    [HttpPost("{id:guid}/decline")]
    public async Task<IActionResult> Decline(Guid id, CancellationToken ct) { await calls.DeclineAsync(id, ct); await notifications.MarkSeenAsync(ProjectManagement.Application.Features.Notifications.NotificationTargets.Call, id, ct); return NoContent(); }

    [HttpPost("{id:guid}/end")]
    public async Task<IActionResult> End(Guid id, CancellationToken ct)
    {
        var ended = await calls.EndAsync(id, ct);
        await notifications.MarkSeenAsync(ProjectManagement.Application.Features.Notifications.NotificationTargets.Call, id, ct);
        return Ok(ended);
    }
}
