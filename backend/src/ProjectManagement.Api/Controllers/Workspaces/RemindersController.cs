using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Api.Controllers.Workspaces;

/// <summary>The signed-in person's reminders in the current workspace, their settings, and the workspace's escalation policy.</summary>
[Route("api/v1/reminders"), RequireWorkspace]
public class RemindersController(ReminderService reminders) : ApiControllerBase
{
    /// <summary>Open (waiting and needing attention), finished in the last 30 days, and sent to others; with counts and plan allowances.</summary>
    [HttpGet]
    public async Task<IActionResult> List(CancellationToken ct) => Ok(await reminders.ListAsync(ct));

    /// <summary>For the sidebar badge: how many need attention now, and how many are still to come today.</summary>
    [HttpGet("counts")]
    public async Task<IActionResult> Counts(CancellationToken ct) => Ok(await reminders.CountsAsync(ct));

    [HttpGet("for/{type}/{id:guid}")]
    public async Task<IActionResult> ForTarget(ReminderTarget type, Guid id, CancellationToken ct) => Ok(await reminders.ForTargetAsync(type, id, ct));

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] SaveReminderRequest req, CancellationToken ct) => Ok(await reminders.CreateAsync(req, ct));

    [HttpPut("{id:guid}")]
    public async Task<IActionResult> Update(Guid id, [FromBody] SaveReminderRequest req, CancellationToken ct) => Ok(await reminders.UpdateAsync(id, req, ct));

    [HttpPost("{id:guid}/snooze")]
    public async Task<IActionResult> Snooze(Guid id, [FromBody] SnoozeRequest req, CancellationToken ct) => Ok(await reminders.SnoozeAsync(id, req, ct));

    [HttpPost("{id:guid}/done")]
    public async Task<IActionResult> Done(Guid id, CancellationToken ct) => Ok(await reminders.CompleteAsync(id, ct));

    [HttpPost("{id:guid}/reopen")]
    public async Task<IActionResult> Reopen(Guid id, CancellationToken ct) => Ok(await reminders.ReopenAsync(id, ct));

    [HttpDelete("{id:guid}")]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
    {
        await reminders.DeleteAsync(id, ct);
        return NoContent();
    }

    [HttpGet("settings")]
    public async Task<IActionResult> Settings(CancellationToken ct) => Ok(await reminders.GetSettingsAsync(ct));

    [HttpPut("settings")]
    public async Task<IActionResult> SaveSettings([FromBody] ReminderSettingsDto req, CancellationToken ct) => Ok(await reminders.SaveSettingsAsync(req, ct));

    /// <summary>The device's time zone, so automatic reminders follow the person when they travel (if they keep that setting on).</summary>
    [HttpPut("time-zone")]
    public async Task<IActionResult> TimeZone([FromBody] TimeZoneRequest req, CancellationToken ct) => Ok(await reminders.SetTimeZoneAsync(req, ct));

    [HttpGet("insights")]
    public async Task<IActionResult> Insights(CancellationToken ct) => Ok(await reminders.InsightsAsync(ct));

    [HttpGet("policy")]
    public async Task<IActionResult> Policy(CancellationToken ct) => Ok(await reminders.GetPolicyAsync(ct));

    [HttpPut("policy")]
    public async Task<IActionResult> SavePolicy([FromBody] SavePolicyRequest req, CancellationToken ct) => Ok(await reminders.SavePolicyAsync(req, ct));
}

/// <summary>Done and snooze from an e-mail or a push notification: the link's one-time key stands in for signing in.</summary>
[Route("api/v1/reminder-actions"), AllowAnonymous]
public class ReminderActionsController(ReminderActionService actions) : ApiControllerBase
{
    [HttpGet("{token}")]
    public async Task<IActionResult> Info(string token, CancellationToken ct) => Ok(await actions.InfoAsync(token, ct));

    [HttpPost("{token}")]
    public async Task<IActionResult> Act(string token, [FromBody] ReminderActionRequest req, CancellationToken ct) => Ok(await actions.ActAsync(token, req, ct));
}
