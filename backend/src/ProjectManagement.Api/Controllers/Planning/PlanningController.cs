using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Planning;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Planning;

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
}
