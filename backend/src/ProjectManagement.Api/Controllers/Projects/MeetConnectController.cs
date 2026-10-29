using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.ProjectMeetings;

namespace ProjectManagement.Api.Controllers.Projects;

/// <summary>
/// Meetings connected everywhere: a meeting's sessions (expanded on the server) and changing one of them, this and following, or all;
/// free/busy for the schedule form; the "Log 45m to …?" prompts after a session; action items captured in a meeting; and reviewing a
/// series' action items (decisions, undo, minutes, nudges, the owner's own updates). Meetings are named "p:{id}" or "w:{id}".
/// </summary>
[Route("api/v1/meet"), RequireWorkspace]
public class MeetConnectController(MeetConnectService connect, MeetReviewService review, MeetingService meetings) : ApiControllerBase
{
    // ------------------------------------------------------------------ sessions

    [HttpGet("{kind}/{id:guid}/sessions")]
    public async Task<IActionResult> Sessions(string kind, Guid id, [FromQuery] DateTimeOffset? from, [FromQuery] DateTimeOffset? to, CancellationToken ct) =>
        Ok(await connect.SessionsAsync(Ref(kind, id), from, to, ct));

    /// <summary>Changes one session ("this"), it and the later ones ("following") or the whole series ("all"): a new time, a new title, or cancelled.</summary>
    [HttpPost("{kind}/{id:guid}/occurrence")]
    public async Task<IActionResult> ChangeOccurrence(string kind, Guid id, [FromBody] ChangeOccurrenceRequest req, CancellationToken ct) =>
        Ok(await meetings.ChangeOccurrenceAsync(Ref(kind, id)[0] == 'w', id, req, ct));

    /// <summary>"p:{id}" or "w:{id}" from the route ("p" for a project meeting, "w" for a workspace meeting).</summary>
    private static string Ref(string kind, Guid id) => kind is "p" or "w" ? $"{kind}:{id}"
        : throw new ProjectManagement.Application.Exceptions.NotFoundException("Meeting not found.");

    // ------------------------------------------------------------------ free / busy

    /// <summary>Busy times of these people (comma-separated ids) and teams between two instants; with slotStart/slotEnd, whether everyone is free then.</summary>
    [HttpGet("free-busy")]
    public async Task<IActionResult> FreeBusy([FromQuery] string? userIds, [FromQuery] string? teamIds, [FromQuery] DateTimeOffset from, [FromQuery] DateTimeOffset to,
        [FromQuery] DateTimeOffset? slotStart, [FromQuery] DateTimeOffset? slotEnd, [FromQuery] string? ignore, CancellationToken ct) =>
        Ok(await connect.FreeBusyAsync(Ids(userIds), Ids(teamIds), from, to, slotStart, slotEnd, ignore, ct));

    private static List<Guid> Ids(string? csv) => (csv ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
        .Select(s => Guid.TryParse(s, out var g) ? g : Guid.Empty).Where(g => g != Guid.Empty).ToList();

    // ------------------------------------------------------------------ time spent in meetings

    [HttpGet("time-proposals")]
    public async Task<IActionResult> Proposals(CancellationToken ct) => Ok(await connect.ProposalsAsync(ct));

    [HttpPost("time-proposals/{id:guid}/log")]
    public async Task<IActionResult> Log(Guid id, [FromBody] LogProposalRequest req, CancellationToken ct) => Ok(await connect.LogAsync(id, req, ct));

    [HttpPost("time-proposals/{id:guid}/later")]
    public async Task<IActionResult> Later(Guid id, CancellationToken ct) { await connect.LaterAsync(id, ct); return NoContent(); }

    [HttpPost("time-proposals/{id:guid}/dismiss")]
    public async Task<IActionResult> Dismiss(Guid id, [FromBody] DismissProposalRequest? req, CancellationToken ct) { await connect.DismissAsync(id, req ?? new DismissProposalRequest(null), ct); return NoContent(); }

    // ------------------------------------------------------------------ action items from a meeting

    [HttpPost("{kind}/{id:guid}/capture/preview")]
    public async Task<IActionResult> Preview(string kind, Guid id, [FromBody] CaptureActionItemRequest req, CancellationToken ct) => Ok(await connect.PreviewAsync(Ref(kind, id), req, ct));

    [HttpPost("{kind}/{id:guid}/capture")]
    public async Task<IActionResult> Capture(string kind, Guid id, [FromBody] CaptureActionItemRequest req, CancellationToken ct) => Created(await connect.CaptureAsync(Ref(kind, id), req, ct));

    [HttpGet("{kind}/{id:guid}/items")]
    public async Task<IActionResult> Items(string kind, Guid id, [FromQuery] DateTimeOffset? occurrence, CancellationToken ct) => Ok(await connect.ItemsAsync(Ref(kind, id), occurrence, ct));

    // ------------------------------------------------------------------ review

    /// <summary>Opens (or joins) the review of a series' session, or of all projects' / my open action items.</summary>
    [HttpPost("review")]
    public async Task<IActionResult> OpenReview([FromBody] ReviewOpenRequest req, CancellationToken ct) => Ok(await review.OpenAsync(req, ct));

    [HttpPost("review/{sessionId:guid}/decide")]
    public async Task<IActionResult> Decide(Guid sessionId, [FromBody] ReviewDecideRequest req, CancellationToken ct) => Ok(await review.DecideAsync(sessionId, req, ct));

    [HttpPost("review/{sessionId:guid}/undo")]
    public async Task<IActionResult> Undo(Guid sessionId, [FromBody] ReviewUndoRequest? req, CancellationToken ct) => Ok(await review.UndoAsync(sessionId, req ?? new ReviewUndoRequest(), ct));

    [HttpPost("review/{sessionId:guid}/finish")]
    public async Task<IActionResult> Finish(Guid sessionId, CancellationToken ct) => Ok(await review.FinishAsync(sessionId, ct));

    [HttpPost("review/{sessionId:guid}/send")]
    public async Task<IActionResult> Send(Guid sessionId, [FromBody] SendMinutesRequest req, CancellationToken ct) => Ok(await review.SendAsync(sessionId, req, ct));

    [HttpPost("action-items/{id:guid}/nudge")]
    public async Task<IActionResult> Nudge(Guid id, CancellationToken ct) { await review.NudgeAsync(id, ct); return NoContent(); }

    [HttpPost("action-items/{id:guid}/update")]
    public async Task<IActionResult> OwnerUpdate(Guid id, [FromBody] OwnerUpdateRequest req, CancellationToken ct) => Ok(await review.OwnerUpdateAsync(id, req, ct));

    [HttpGet("my-action-items")]
    public async Task<IActionResult> MyActionItems(CancellationToken ct) => Ok(await review.MineAsync(ct));
}
