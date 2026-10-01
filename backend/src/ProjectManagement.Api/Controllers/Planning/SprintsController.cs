using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Planning;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Planning;

/// <summary>Sprints of a project, and planning tasks into a sprint or back to the backlog.</summary>
[Route("api/v1"), RequireWorkspace]
public class SprintsController(SprintService sprints) : ApiControllerBase
{
    [HttpGet("projects/{projectId:guid}/sprints"), RequireModule(Modules.Projects)]
    public async Task<IActionResult> List(Guid projectId, CancellationToken ct) => Ok(await sprints.ListAsync(projectId, ct));

    [HttpGet("projects/{projectId:guid}/sprints/{id:guid}"), RequireModule(Modules.Projects)]
    public async Task<IActionResult> Get(Guid projectId, Guid id, CancellationToken ct) => Ok(await sprints.GetAsync(projectId, id, ct));

    [HttpPost("projects/{projectId:guid}/sprints"), RequireModule(Modules.Projects, AccessLevel.Edit)]
    public async Task<IActionResult> Create(Guid projectId, [FromBody] UpsertSprintRequest req, CancellationToken ct) =>
        Created(await sprints.CreateAsync(projectId, req, ct));

    [HttpPut("projects/{projectId:guid}/sprints/{id:guid}"), RequireModule(Modules.Projects, AccessLevel.Edit)]
    public async Task<IActionResult> Update(Guid projectId, Guid id, [FromBody] UpsertSprintRequest req, CancellationToken ct) =>
        Ok(await sprints.UpdateAsync(projectId, id, req, ct));

    [HttpDelete("projects/{projectId:guid}/sprints/{id:guid}"), RequireModule(Modules.Projects, AccessLevel.Edit)]
    public async Task<IActionResult> Delete(Guid projectId, Guid id, CancellationToken ct)
    {
        await sprints.DeleteAsync(projectId, id, ct);
        return NoContent();
    }

    [HttpPost("projects/{projectId:guid}/sprints/{id:guid}/start"), RequireModule(Modules.Projects, AccessLevel.Edit)]
    public async Task<IActionResult> Start(Guid projectId, Guid id, CancellationToken ct) => Ok(await sprints.StartAsync(projectId, id, ct));

    [HttpPost("projects/{projectId:guid}/sprints/{id:guid}/complete"), RequireModule(Modules.Projects, AccessLevel.Edit)]
    public async Task<IActionResult> Complete(Guid projectId, Guid id, [FromBody] CompleteSprintRequest req, CancellationToken ct) =>
        Ok(await sprints.CompleteAsync(projectId, id, req, ct));

    /// <summary>Plan tasks into a sprint.</summary>
    [HttpPost("projects/{projectId:guid}/sprints/{id:guid}/tasks"), RequireModule(Modules.Tasks, AccessLevel.Edit)]
    public async Task<IActionResult> AddTasks(Guid projectId, Guid id, [FromBody] SprintTasksRequest req, CancellationToken ct)
    {
        await sprints.AssignAsync(projectId, id, req.TaskIds, ct);
        return NoContent();
    }

    /// <summary>Send tasks back to the backlog.</summary>
    [HttpPost("projects/{projectId:guid}/backlog"), RequireModule(Modules.Tasks, AccessLevel.Edit)]
    public async Task<IActionResult> ToBacklog(Guid projectId, [FromBody] SprintTasksRequest req, CancellationToken ct)
    {
        await sprints.AssignAsync(projectId, null, req.TaskIds, ct);
        return NoContent();
    }

    [HttpPut("tasks/{taskId:guid}/sprint"), RequireModule(Modules.Tasks, AccessLevel.Edit)]
    public async Task<IActionResult> SetTaskSprint(Guid taskId, [FromBody] AssignSprintRequest req, CancellationToken ct)
    {
        await sprints.AssignTaskAsync(taskId, req.SprintId, ct);
        return NoContent();
    }
}
