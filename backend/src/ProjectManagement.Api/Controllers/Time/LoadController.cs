using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Load;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Time;

/// <summary>Load: who can take more over the next two weeks (assigned work, meetings and leave), rebalance suggestions, the load-aware picker and bulk reassign.</summary>
[Route("api/v1/load"), RequireWorkspace]
public class LoadController(LoadService load) : ApiControllerBase
{
    /// <summary>Rows (people, teams or projects) with a day-by-day strip, state and reason, most loaded first.</summary>
    [HttpGet]
    public async Task<IActionResult> Get([FromQuery] string? scope, [FromQuery] DateOnly? from, [FromQuery] int? days, CancellationToken ct) =>
        Ok(await load.GetAsync(scope, from, days, ct));

    /// <summary>The items and meetings filling one person's day.</summary>
    [HttpGet("{userId:guid}/day/{date}")]
    public async Task<IActionResult> Day(Guid userId, DateOnly date, CancellationToken ct) => Ok(await load.DayAsync(userId, date, ct));

    /// <summary>Rebalance: move an item from someone overloaded to someone it fits.</summary>
    [HttpGet("suggestions")]
    public async Task<IActionResult> Suggestions(CancellationToken ct) => Ok(await load.SuggestionsAsync(ct));

    /// <summary>For a picker: each person's state and a short reason for an item of this size and these dates, the best fit first; teams with free people.</summary>
    [HttpGet("fit")]
    public async Task<IActionResult> Fit([FromQuery] DateOnly? start, [FromQuery] DateOnly? due, [FromQuery] int? minutes, [FromQuery] string? size, [FromQuery] Guid? current, CancellationToken ct) =>
        Ok(await load.FitAsync(start, due, minutes, size, current, ct));

    /// <summary>Move tasks and action items to someone (one item, a list, or a person's open tasks in a stage), with notifications and activity. dryRun lists them only.</summary>
    [HttpPost("reassign"), RequireModule(Modules.Tasks, AccessLevel.Edit)]
    public async Task<IActionResult> Reassign([FromBody] LoadReassignRequest req, CancellationToken ct) => Ok(await load.ReassignAsync(req, ct));

    /// <summary>"I'm swamped" / "I have room" for a week; empty clears it.</summary>
    [HttpPut("signal")]
    public async Task<IActionResult> Signal([FromBody] LoadSignalRequest req, CancellationToken ct) => Ok(new { signal = await load.SetSignalAsync(req, ct) });

    /// <summary>A task's rough size: S, M, L or XL (empty clears it).</summary>
    [HttpPut("~/api/v1/tasks/{taskId:guid}/size"), RequireModule(Modules.Tasks, AccessLevel.Edit)]
    public async Task<IActionResult> Size(Guid taskId, [FromBody] LoadSizeRequest req, CancellationToken ct) => Ok(await load.SetSizeAsync(taskId, req.Size, ct));
}
