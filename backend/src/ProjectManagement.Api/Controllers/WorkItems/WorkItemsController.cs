using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.WorkItems;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Api.Controllers.WorkItems;

/// <summary>
/// Every kind of work together: My work (everything assigned to me) and Workload (per person). Each kind keeps its own visibility rules,
/// see <see cref="WorkItemService"/>; there is no module requirement here because the result only ever contains kinds the caller may open.
/// </summary>
[Route("api/v1"), RequireWorkspace]
public class WorkItemsController(WorkItemService items, WorkloadService workload, WorkItemApiService work) : ApiControllerBase
{
    // ------------------------------------------------------------------ the one Work API (v2): every kind of work through one shape

    /// <summary>
    /// The Work list. kind: comma-separated task, issue, action, ticket. mine: assigned to me. team: a team id, or "mine" (my teams).
    /// status: open (default), closed, all, todo, active, done, cancelled. Paged with offset and limit (up to 200 a page).
    /// </summary>
    [HttpGet("work-items")]
    public async Task<IActionResult> List([FromQuery] string? kind, [FromQuery] bool mine = false, [FromQuery] string? team = null, [FromQuery] Guid? assigneeId = null,
        [FromQuery] Guid? projectId = null, [FromQuery] string? status = null, [FromQuery] bool overdue = false, [FromQuery] string? q = null,
        [FromQuery] int offset = 0, [FromQuery] int limit = 50, CancellationToken ct = default) =>
        Ok(await work.ListAsync(kind, mine, team, assigneeId, projectId, status, overdue, q, offset, limit, ct));

    /// <summary>One item with its activity stream (comments, time, files, changes, the agent's changes).</summary>
    [HttpGet("work-items/{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct) => Ok(await work.GetAsync(id, ct));

    [HttpPost("work-items")]
    public async Task<IActionResult> Create([FromBody] CreateWorkItemRequest req, CancellationToken ct) => Created(await work.CreateAsync(req, ct));

    /// <summary>Changes the fields sent; <c>version</c> (the one last read) is required. See <see cref="WorkItemApiService.PatchAsync"/>.</summary>
    [HttpPatch("work-items/{id:guid}")]
    public async Task<IActionResult> Patch(Guid id, [FromBody] System.Text.Json.JsonElement body, CancellationToken ct) => Ok(await work.PatchAsync(id, body, ct));

    /// <summary>A comment; "log 2h …" also logs the time.</summary>
    [HttpPost("work-items/{id:guid}/comments")]
    public async Task<IActionResult> Comment(Guid id, [FromBody] WorkItemCommentRequest req, CancellationToken ct) => Created(await work.CommentAsync(id, req, ct));

    [HttpDelete("work-items/{id:guid}")]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
    {
        await work.DeleteAsync(id, ct);
        return NoContent();
    }

    // ------------------------------------------------------------------ cross-kind views

    /// <summary>
    /// Everything assigned to me. <paramref name="kinds"/> is a comma-separated list (Task, Issue, ActionItem, Operational); open items
    /// only unless <paramref name="open"/> is false.
    /// </summary>
    [HttpGet("my-work")]
    public async Task<IActionResult> MyWork([FromQuery] string? kinds, [FromQuery] bool open = true, [FromQuery] Guid? projectId = null, [FromQuery] DateOnly? dueFrom = null,
        [FromQuery] DateOnly? dueTo = null, [FromQuery] bool overdue = false, [FromQuery] string? q = null, [FromQuery] int limit = 200, CancellationToken ct = default) =>
        Ok(await items.ListAsync(new WorkItemQuery(ParseKinds(kinds), Mine: true, OpenOnly: open, ProjectId: projectId, DueFrom: dueFrom, DueTo: dueTo, Overdue: overdue, Q: q, Limit: limit), ct: ct));

    /// <summary>Every open (or, with open=false, every) action item of the projects the caller can see, for the Portfolio. Follows the team being looked at.</summary>
    [HttpGet("action-items")]
    public async Task<IActionResult> ActionItems([FromQuery] bool open = true, [FromQuery] int limit = 300, CancellationToken ct = default) =>
        Ok(await items.ListAsync(new WorkItemQuery([WorkItemKind.ActionItem], OpenOnly: open, Limit: limit), ct: ct));

    [HttpGet("workload")]
    public async Task<IActionResult> Workload([FromQuery] WorkloadScope? scope, CancellationToken ct) => Ok(await workload.GetAsync(scope, ct));

    [HttpGet("workload/{userId:guid}")]
    public async Task<IActionResult> Person(Guid userId, [FromQuery] WorkloadScope? scope, CancellationToken ct) => Ok(await workload.PersonAsync(userId, scope, ct));

    private static IReadOnlyList<WorkItemKind>? ParseKinds(string? kinds)
    {
        if (string.IsNullOrWhiteSpace(kinds)) return null;
        var list = new List<WorkItemKind>();
        foreach (var part in kinds.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (!Enum.TryParse<WorkItemKind>(part, ignoreCase: true, out var kind)) throw new ValidationException("kinds", $"Unknown kind “{part}”.");
            list.Add(kind);
        }
        return list;
    }
}
