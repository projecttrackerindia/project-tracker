using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Planning;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers;

/// <summary>Milestones of a project and dependencies between its tasks.</summary>
[Route("api/v1"), RequireWorkspace]
public class PlanningController(PlanningService planning) : ApiControllerBase
{
    [HttpGet("projects/{projectId:guid}/milestones"), RequireModule(Modules.Projects)]
    public async Task<IActionResult> Milestones(Guid projectId, CancellationToken ct) => Ok(await planning.ListMilestonesAsync(projectId, ct));

    [HttpPost("projects/{projectId:guid}/milestones"), RequireModule(Modules.Projects, AccessLevel.Edit)]
    public async Task<IActionResult> CreateMilestone(Guid projectId, [FromBody] UpsertMilestoneRequest req, CancellationToken ct) =>
        Created(await planning.CreateMilestoneAsync(projectId, req, ct));

    [HttpPut("projects/{projectId:guid}/milestones/{id:guid}"), RequireModule(Modules.Projects, AccessLevel.Edit)]
    public async Task<IActionResult> UpdateMilestone(Guid projectId, Guid id, [FromBody] UpsertMilestoneRequest req, CancellationToken ct) =>
        Ok(await planning.UpdateMilestoneAsync(projectId, id, req, ct));

    [HttpDelete("projects/{projectId:guid}/milestones/{id:guid}"), RequireModule(Modules.Projects, AccessLevel.Edit)]
    public async Task<IActionResult> DeleteMilestone(Guid projectId, Guid id, CancellationToken ct) => Ok(await planning.DeleteMilestoneAsync(projectId, id, ct));

    [HttpGet("tasks/{taskId:guid}/dependencies"), RequireModule(Modules.Tasks)]
    public async Task<IActionResult> Dependencies(Guid taskId, CancellationToken ct) => Ok(await planning.GetDependenciesAsync(taskId, ct));

    [HttpPost("tasks/{taskId:guid}/dependencies"), RequireModule(Modules.Tasks, AccessLevel.Edit)]
    public async Task<IActionResult> AddDependency(Guid taskId, [FromBody] AddDependencyRequest req, CancellationToken ct) =>
        Created(await planning.AddDependencyAsync(taskId, req, ct));

    [HttpDelete("tasks/{taskId:guid}/dependencies/{dependencyId:guid}"), RequireModule(Modules.Tasks, AccessLevel.Edit)]
    public async Task<IActionResult> RemoveDependency(Guid taskId, Guid dependencyId, CancellationToken ct) =>
        Ok(await planning.RemoveDependencyAsync(taskId, dependencyId, ct));

    // ---- sprints

    [HttpGet("projects/{projectId:guid}/sprints"), RequireModule(Modules.Projects)]
    public async Task<IActionResult> Sprints(Guid projectId, [FromServices] SprintService sprints, CancellationToken ct) => Ok(await sprints.ListAsync(projectId, ct));

    [HttpGet("projects/{projectId:guid}/sprints/{id:guid}"), RequireModule(Modules.Projects)]
    public async Task<IActionResult> Sprint(Guid projectId, Guid id, [FromServices] SprintService sprints, CancellationToken ct) => Ok(await sprints.GetAsync(projectId, id, ct));

    [HttpPost("projects/{projectId:guid}/sprints"), RequireModule(Modules.Projects, AccessLevel.Edit)]
    public async Task<IActionResult> CreateSprint(Guid projectId, [FromBody] UpsertSprintRequest req, [FromServices] SprintService sprints, CancellationToken ct) =>
        Created(await sprints.CreateAsync(projectId, req, ct));

    [HttpPut("projects/{projectId:guid}/sprints/{id:guid}"), RequireModule(Modules.Projects, AccessLevel.Edit)]
    public async Task<IActionResult> UpdateSprint(Guid projectId, Guid id, [FromBody] UpsertSprintRequest req, [FromServices] SprintService sprints, CancellationToken ct) =>
        Ok(await sprints.UpdateAsync(projectId, id, req, ct));

    [HttpDelete("projects/{projectId:guid}/sprints/{id:guid}"), RequireModule(Modules.Projects, AccessLevel.Edit)]
    public async Task<IActionResult> DeleteSprint(Guid projectId, Guid id, [FromServices] SprintService sprints, CancellationToken ct)
    {
        await sprints.DeleteAsync(projectId, id, ct);
        return NoContent();
    }

    [HttpPost("projects/{projectId:guid}/sprints/{id:guid}/start"), RequireModule(Modules.Projects, AccessLevel.Edit)]
    public async Task<IActionResult> StartSprint(Guid projectId, Guid id, [FromServices] SprintService sprints, CancellationToken ct) => Ok(await sprints.StartAsync(projectId, id, ct));

    [HttpPost("projects/{projectId:guid}/sprints/{id:guid}/complete"), RequireModule(Modules.Projects, AccessLevel.Edit)]
    public async Task<IActionResult> CompleteSprint(Guid projectId, Guid id, [FromBody] CompleteSprintRequest req, [FromServices] SprintService sprints, CancellationToken ct) =>
        Ok(await sprints.CompleteAsync(projectId, id, req, ct));

    /// <summary>Plan tasks into a sprint.</summary>
    [HttpPost("projects/{projectId:guid}/sprints/{id:guid}/tasks"), RequireModule(Modules.Tasks, AccessLevel.Edit)]
    public async Task<IActionResult> AddToSprint(Guid projectId, Guid id, [FromBody] SprintTasksRequest req, [FromServices] SprintService sprints, CancellationToken ct)
    {
        await sprints.AssignAsync(projectId, id, req.TaskIds, ct);
        return NoContent();
    }

    /// <summary>Send tasks back to the backlog.</summary>
    [HttpPost("projects/{projectId:guid}/backlog"), RequireModule(Modules.Tasks, AccessLevel.Edit)]
    public async Task<IActionResult> ToBacklog(Guid projectId, [FromBody] SprintTasksRequest req, [FromServices] SprintService sprints, CancellationToken ct)
    {
        await sprints.AssignAsync(projectId, null, req.TaskIds, ct);
        return NoContent();
    }

    [HttpPut("tasks/{taskId:guid}/sprint"), RequireModule(Modules.Tasks, AccessLevel.Edit)]
    public async Task<IActionResult> SetTaskSprint(Guid taskId, [FromBody] AssignSprintRequest req, [FromServices] SprintService sprints, CancellationToken ct)
    {
        await sprints.AssignTaskAsync(taskId, req.SprintId, ct);
        return NoContent();
    }
}
