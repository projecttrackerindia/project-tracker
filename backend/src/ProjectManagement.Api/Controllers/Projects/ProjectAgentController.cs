using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Agent;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Projects;

/// <summary>
/// The project agent: its settings and mailbox, giving it a transcript, running it now, and the review queue of what it proposed (approve,
/// edit and approve, dismiss). The workspace's meeting-bot key and a person's own inbox opt-in live here too.
/// </summary>
[Route("api/v1"), RequireWorkspace, RequireModule(Modules.Projects)]
public class ProjectAgentController(AgentSettingsService settings, AgentSignalService signals, AgentAnalysisService analysis, AgentReviewService review,
    AgentMinutesService minutes, AgentAutonomyHintService hints, AgentMeetingService meetings) : ApiControllerBase
{
    /// <summary>Sends the agent's meeting bot to a Google Meet or Microsoft Teams call now, by its link.</summary>
    [HttpPost("projects/{projectId:guid}/agent/join-link")]
    public async Task<IActionResult> JoinLink(Guid projectId, [FromBody] AgentJoinLinkRequest req, CancellationToken ct) =>
        Ok(await meetings.JoinLinkAsync(projectId, req.Url, req.Title, req.Minutes, ct));

    /// <summary>How the team decided on each kind of proposal, and the kinds the agent has earned the right to carry out by itself.</summary>
    [HttpGet("projects/{projectId:guid}/agent/autonomy")]
    public async Task<IActionResult> Autonomy(Guid projectId, CancellationToken ct) => Ok(await hints.ProjectAsync(projectId, ct));

    [HttpPost("projects/{projectId:guid}/agent/autonomy/{kind}/accept")]
    public async Task<IActionResult> AcceptAutonomy(Guid projectId, string kind, CancellationToken ct) => Ok(await hints.AcceptAsync(projectId, kind, ct));

    [HttpPost("projects/{projectId:guid}/agent/autonomy/{kind}/dismiss")]
    public async Task<IActionResult> DismissAutonomy(Guid projectId, string kind, CancellationToken ct) => Ok(await hints.DismissAsync(projectId, kind, ct));

    /// <summary>E-mails the minutes of a meeting the agent read (MOM with the transcript) to the people in it, in the caller's name.</summary>
    [HttpPost("projects/{projectId:guid}/agent/runs/{runId:guid}/minutes")]
    public async Task<IActionResult> SendMinutes(Guid projectId, Guid runId, CancellationToken ct) => Ok(new { sent = await minutes.SendNowAsync(projectId, runId, ct) });

    [HttpGet("projects/{projectId:guid}/agent")]
    public async Task<IActionResult> Get(Guid projectId, CancellationToken ct) => Ok(await settings.GetAsync(projectId, ct));

    [HttpPut("projects/{projectId:guid}/agent")]
    public async Task<IActionResult> Save(Guid projectId, [FromBody] SaveProjectAgentRequest req, CancellationToken ct) => Ok(await settings.SaveAsync(projectId, req, ct));

    [HttpPost("projects/{projectId:guid}/agent/mailbox/reset")]
    public async Task<IActionResult> ResetMailbox(Guid projectId, CancellationToken ct) => Ok(await settings.ResetMailboxAsync(projectId, ct));

    [HttpPost("projects/{projectId:guid}/agent/run"), AiRequestLimit]
    public async Task<IActionResult> Run(Guid projectId, CancellationToken ct)
    {
        var run = await analysis.RunNowAsync(projectId, ct);
        if (run is { Status: "done" }) await review.AutoApplyRunAsync(projectId, run.Id, ct);
        return Ok(run);
    }

    /// <summary>A transcript or meeting notes, read straight away.</summary>
    [HttpPost("projects/{projectId:guid}/agent/transcript"), AiRequestLimit]
    [RequestSizeLimit(2 * 1024 * 1024)]
    public async Task<IActionResult> Transcript(Guid projectId, [FromBody] AgentTranscriptRequest req, CancellationToken ct)
    {
        var signal = await signals.AddTranscriptAsync(projectId, req, ct);
        AgentRunDto? run = null;
        // Read at once when the agent is on; otherwise it waits until someone switches it on.
        try { if (await settings.AiAvailableAsync(ct)) run = await analysis.RunNowAsync(projectId, ct); }
        catch (ProjectManagement.Application.Exceptions.ConflictException ex) when (ex.Code is "AGENT_DISABLED" or "AGENT_NOTHING_NEW") { }
        if (run is { Status: "done" }) await review.AutoApplyRunAsync(projectId, run.Id, ct);
        return Created(new { signalId = signal.Id, run });
    }

    [HttpGet("projects/{projectId:guid}/agent/findings")]
    public async Task<IActionResult> Findings(Guid projectId, [FromQuery] string? status, CancellationToken ct) => Ok(await review.ListAsync(projectId, status, ct));

    [HttpPost("projects/{projectId:guid}/agent/findings/approve-all")]
    public async Task<IActionResult> ApproveAll(Guid projectId, CancellationToken ct) => Ok(await review.ApproveAllAsync(projectId, ct));

    /// <summary>Everything waiting for this person's decision across the workspace.</summary>
    [HttpGet("agent/inbox")]
    public async Task<IActionResult> Inbox(CancellationToken ct) => Ok(await review.InboxAsync(ct));

    [HttpPost("agent/findings/{id:guid}/approve")]
    public async Task<IActionResult> Approve(Guid id, [FromBody(EmptyBodyBehavior = EmptyBodyBehavior.Allow)] ApproveFindingRequest? req, CancellationToken ct) =>
        Ok(await review.ApproveAsync(id, req, ct));

    [HttpPost("agent/findings/{id:guid}/dismiss")]
    public async Task<IActionResult> Dismiss(Guid id, [FromBody(EmptyBodyBehavior = EmptyBodyBehavior.Allow)] DismissFindingRequest? req, CancellationToken ct) =>
        Ok(await review.DismissAsync(id, ct, req?.Reason));

    /// <summary>Work the agent gave me (approved by someone else), to accept or to say it is not mine.</summary>
    [HttpGet("agent/assigned")]
    public async Task<IActionResult> Assigned(CancellationToken ct) => Ok(await review.AssignedAsync(ct));

    [HttpPost("agent/findings/{id:guid}/respond")]
    public async Task<IActionResult> Respond(Guid id, [FromBody] AgentOwnerResponseRequest req, CancellationToken ct) => Ok(await review.RespondAsync(id, req, ct));

    [HttpGet("agent/workspace")]
    public async Task<IActionResult> Workspace(CancellationToken ct) => Ok(await settings.GetWorkspaceAsync(ct));

    [HttpPut("agent/workspace")]
    public async Task<IActionResult> SaveWorkspace([FromBody] SaveAgentWorkspaceRequest req, CancellationToken ct) => Ok(await settings.SaveWorkspaceAsync(req, ct));

    [HttpGet("agent/my-inbox")]
    public async Task<IActionResult> MyInbox(CancellationToken ct) => Ok(await settings.GetInboxAsync(ct));

    [HttpPut("agent/my-inbox")]
    public async Task<IActionResult> SaveMyInbox([FromBody] SaveAgentInboxOptInRequest req, CancellationToken ct) => Ok(await settings.SaveInboxAsync(req, ct));
}
