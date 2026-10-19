using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Agent;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Projects;

/// <summary>
/// The agent as a project delegate: the Command Center ("what needs me today"), commitments and check-ins, sending the agent to a meeting
/// in my place, the brief before a meeting, what a date change would move (and "what if"), the decision registry and the audit trail.
/// </summary>
[Route("api/v1/agent"), RequireWorkspace, RequireModule(Modules.Projects)]
public class AgentCommandCenterController(AgentCommandCenterService center, AgentFollowUpService followUps, AgentDelegationService delegations,
    AgentBriefService briefs, AgentImpactService impact) : ApiControllerBase
{
    [HttpGet("command-center")]
    public async Task<IActionResult> CommandCenter(CancellationToken ct) => Ok(await center.GetAsync(ct));

    [HttpGet("me/settings")]
    public async Task<IActionResult> MySettings(CancellationToken ct) => Ok(await center.GetSettingsAsync(ct));

    [HttpPut("me/settings")]
    public async Task<IActionResult> SaveMySettings([FromBody] SaveAgentPersonalSettingsRequest req, CancellationToken ct) => Ok(await center.SaveSettingsAsync(req, ct));

    // ---------------------------------------------------------------- commitments

    [HttpGet("commitments/mine")]
    public async Task<IActionResult> MyCommitments(CancellationToken ct) => Ok(await followUps.MineAsync(ct));

    [HttpGet("commitments/{id:guid}")]
    public async Task<IActionResult> Commitment(Guid id, CancellationToken ct) => Ok(await followUps.GetAsync(id, ct));

    /// <summary>The owner's answer to a check-in: on_track, done, more_time (newDate + note) or blocked (note).</summary>
    [HttpPost("commitments/{id:guid}/check-in")]
    public async Task<IActionResult> CheckIn(Guid id, [FromBody] AgentCheckInRequest req, CancellationToken ct) => Ok(await followUps.AnswerAsync(id, req, ct));

    // ---------------------------------------------------------------- meetings

    /// <summary>My meeting sessions (default: the next 7 days), each with the ones it overlaps and whether the agent is going.</summary>
    [HttpGet("meetings")]
    public async Task<IActionResult> Meetings([FromQuery] int? hours, CancellationToken ct) =>
        Ok(await delegations.MyMeetingsAsync(DateTime.UtcNow.AddHours(-1), hours ?? 24 * 7, ct));

    [HttpGet("delegations")]
    public async Task<IActionResult> Delegations(CancellationToken ct) => Ok(await delegations.MineAsync(ct));

    [HttpGet("delegations/{id:guid}")]
    public async Task<IActionResult> Delegation(Guid id, CancellationToken ct) => Ok(await delegations.GetAsync(id, ct));

    /// <summary>Send the agent to a session of a meeting in my place.</summary>
    [HttpPost("delegations")]
    public async Task<IActionResult> Delegate([FromBody] DelegateRequest req, CancellationToken ct) => Created(await delegations.DelegateAsync(req, ct));

    [HttpPost("delegations/{id:guid}/cancel")]
    public async Task<IActionResult> CancelDelegation(Guid id, CancellationToken ct) => Ok(await delegations.CancelAsync(id, ct));

    [HttpGet("meetings/{meetingId:guid}/brief")]
    public async Task<IActionResult> Brief(Guid meetingId, [FromQuery] DateTime? at, CancellationToken ct) =>
        Ok(await briefs.GetAsync(meetingId, at is { } a ? DateTime.SpecifyKind(a.ToUniversalTime(), DateTimeKind.Utc) : null, ct));

    // ---------------------------------------------------------------- impact

    [HttpGet("findings/{id:guid}/impact")]
    public async Task<IActionResult> FindingImpact(Guid id, CancellationToken ct) => Ok(await impact.ForFindingAsync(id, ct));

    [HttpPost("what-if")]
    public async Task<IActionResult> WhatIf([FromBody] WhatIfRequest req, CancellationToken ct) => Ok(await impact.WhatIfAsync(req, ct));

    [HttpGet("what-if/projects/{projectId:guid}/tasks")]
    public async Task<IActionResult> WhatIfTasks(Guid projectId, CancellationToken ct) => Ok(await impact.TasksAsync(projectId, ct));

    // ---------------------------------------------------------------- registry and audit

    [HttpGet("decisions")]
    public async Task<IActionResult> Decisions([FromQuery] Guid? projectId, [FromQuery] string? q, CancellationToken ct) => Ok(await center.DecisionsAsync(projectId, q, ct));

    [HttpGet("audit")]
    public async Task<IActionResult> Audit([FromQuery] Guid? projectId, CancellationToken ct) => Ok(await center.AuditAsync(projectId, ct));
}
