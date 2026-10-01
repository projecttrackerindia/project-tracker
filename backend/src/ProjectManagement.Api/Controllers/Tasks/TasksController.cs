using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Insights;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.Tasks;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Tasks;

[Route("api/v1"), RequireWorkspace, RequireModule(Modules.Tasks)]
public class TasksController(TaskService tasks) : ApiControllerBase
{
    [HttpGet("tasks/{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct) => Ok(await tasks.GetAsync(id, ct));

    [HttpPut("tasks/{id:guid}")]
    public async Task<IActionResult> Update(Guid id, [FromBody] UpdateTaskRequest req, CancellationToken ct) => Ok(await tasks.UpdateAsync(id, req, ct));

    [HttpPatch("tasks/{id:guid}/move")]
    public async Task<IActionResult> Move(Guid id, [FromBody] MoveTaskRequest req, CancellationToken ct) => Ok(await tasks.MoveAsync(id, req, ct));

    [HttpDelete("tasks/{id:guid}")]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
    {
        await tasks.DeleteAsync(id, ct);
        return NoContent();
    }

    [HttpGet("tasks/{id:guid}/comments")]
    public async Task<IActionResult> Comments(Guid id, CancellationToken ct) => Ok(await tasks.GetCommentsAsync(id, ct));

    [HttpPost("tasks/{id:guid}/comments")]
    public async Task<IActionResult> AddComment(Guid id, [FromBody] CreateCommentRequest req, CancellationToken ct) =>
        Created(await tasks.AddCommentAsync(id, req, ct));

    [HttpPut("comments/{id:guid}")]
    public async Task<IActionResult> UpdateComment(Guid id, [FromBody] UpdateCommentRequest req, CancellationToken ct) =>
        Ok(await tasks.UpdateCommentAsync(id, req, ct));

    [HttpDelete("comments/{id:guid}")]
    public async Task<IActionResult> DeleteComment(Guid id, CancellationToken ct)
    {
        await tasks.DeleteCommentAsync(id, ct);
        return NoContent();
    }
}
