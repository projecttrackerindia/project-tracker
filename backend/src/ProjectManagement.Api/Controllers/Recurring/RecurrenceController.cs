using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Recurring;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Recurring;

/// <summary>How a task repeats: the rule, "this one / all following" edits, skipping one occurrence and stopping the series.</summary>
[Route("api/v1/tasks/{taskId:guid}/recurrence"), RequireWorkspace]
public class RecurrenceController(RecurrenceService recurrence) : ApiControllerBase
{
    [HttpGet, RequireModule(Modules.Tasks)]
    public async Task<IActionResult> Get(Guid taskId, CancellationToken ct) => Ok(await recurrence.GetAsync(taskId, ct));

    [HttpPut, RequireModule(Modules.Tasks, AccessLevel.Edit)]
    public async Task<IActionResult> Set(Guid taskId, [FromBody] SetRecurrenceRequest req, CancellationToken ct) => Ok(await recurrence.SetAsync(taskId, req, ct));

    [HttpPatch, RequireModule(Modules.Tasks, AccessLevel.Edit)]
    public async Task<IActionResult> Edit(Guid taskId, [FromBody] EditOccurrenceRequest req, CancellationToken ct) => Ok(await recurrence.EditAsync(taskId, req, ct));

    [HttpPost("skip"), RequireModule(Modules.Tasks, AccessLevel.Edit)]
    public async Task<IActionResult> Skip(Guid taskId, CancellationToken ct) => Ok(await recurrence.SkipAsync(taskId, ct));

    [HttpDelete, RequireModule(Modules.Tasks, AccessLevel.Edit)]
    public async Task<IActionResult> Stop(Guid taskId, CancellationToken ct) => Ok(await recurrence.StopAsync(taskId, ct));
}
