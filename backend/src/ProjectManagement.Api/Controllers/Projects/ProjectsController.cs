using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Insights;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.Tasks;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Projects;

[Route("api/v1/projects"), RequireWorkspace, RequireModule(Modules.Projects)]
public class ProjectsController(ProjectService projects, TaskService tasks, ActivityService activity, TimelineTemplateService timelineTemplates) : ApiControllerBase
{
    [HttpGet]
    public async Task<IActionResult> List([FromQuery] ProjectQuery query, CancellationToken ct) => Ok(await projects.ListAsync(query, ct));

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] CreateProjectRequest req, CancellationToken ct) => Created(await projects.CreateAsync(req, ct));

    // ---- timeline templates: the built-in timelines plus the workspace's own
    [HttpGet("timeline-templates")]
    public async Task<IActionResult> TimelineTemplateList(CancellationToken ct) => Ok(await timelineTemplates.ListAsync(ct));

    [HttpPost("timeline-templates")]
    public async Task<IActionResult> CreateTimelineTemplate([FromBody] UpsertTimelineTemplateRequest req, CancellationToken ct) =>
        Created(await timelineTemplates.CreateAsync(req, ct));

    [HttpPut("timeline-templates/{templateId:guid}")]
    public async Task<IActionResult> UpdateTimelineTemplate(Guid templateId, [FromBody] UpsertTimelineTemplateRequest req, CancellationToken ct) =>
        Ok(await timelineTemplates.UpdateAsync(templateId, req, ct));

    [HttpDelete("timeline-templates/{templateId:guid}")]
    public async Task<IActionResult> DeleteTimelineTemplate(Guid templateId, CancellationToken ct)
    {
        await timelineTemplates.DeleteAsync(templateId, ct);
        return NoContent();
    }

    /// <summary>Saves this project's stages, in order, as a template of the workspace.</summary>
    [HttpPost("{id:guid}/timeline-templates")]
    public async Task<IActionResult> SaveTimelineTemplate(Guid id, [FromBody] SaveProjectTimelineRequest req, CancellationToken ct) =>
        Created(await timelineTemplates.CreateFromProjectAsync(id, req, ct));

    [HttpGet("{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct) => Ok(await projects.GetAsync(id, ct));

    [HttpPut("{id:guid}")]
    public async Task<IActionResult> Update(Guid id, [FromBody] UpdateProjectRequest req, CancellationToken ct) => Ok(await projects.UpdateAsync(id, req, ct));

    [HttpPatch("{id:guid}/move")]
    public async Task<IActionResult> Move(Guid id, [FromBody] MoveProjectRequest req, CancellationToken ct) => Ok(await projects.MoveAsync(id, req, ct));

    [HttpDelete("{id:guid}")]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
    {
        await projects.DeleteAsync(id, ct);
        return NoContent();
    }

    // ---- members
    [HttpGet("{id:guid}/members")]
    public async Task<IActionResult> Members(Guid id, CancellationToken ct)
    {
        await projects.GetAsync(id, ct); // visibility check (404 for guests without access)
        return Ok(await projects.GetMembersAsync(id, ct));
    }

    [HttpPost("{id:guid}/members")]
    public async Task<IActionResult> AddMember(Guid id, [FromBody] AddProjectMemberRequest req, CancellationToken ct) =>
        Ok(await projects.AddMemberAsync(id, req, ct));

    [HttpDelete("{id:guid}/members/{userId:guid}")]
    public async Task<IActionResult> RemoveMember(Guid id, Guid userId, CancellationToken ct)
    {
        await projects.RemoveMemberAsync(id, userId, ct);
        return NoContent();
    }

    // ---- workflow statuses
    [HttpGet("{id:guid}/statuses")]
    public async Task<IActionResult> Statuses(Guid id, CancellationToken ct)
    {
        await projects.GetAsync(id, ct);
        return Ok(await projects.GetStatusesAsync(id, ct));
    }

    [HttpPost("{id:guid}/statuses")]
    public async Task<IActionResult> CreateStatus(Guid id, [FromBody] UpsertStatusRequest req, CancellationToken ct) =>
        Created(await projects.CreateStatusAsync(id, req, ct));

    [HttpPut("{id:guid}/statuses/order")]
    public async Task<IActionResult> ReorderStatuses(Guid id, [FromBody] ReorderStatusesRequest req, CancellationToken ct) =>
        Ok(await projects.ReorderStatusesAsync(id, req, ct));

    [HttpPut("{id:guid}/statuses/{statusId:guid}")]
    public async Task<IActionResult> UpdateStatus(Guid id, Guid statusId, [FromBody] UpsertStatusRequest req, CancellationToken ct) =>
        Ok(await projects.UpdateStatusAsync(id, statusId, req, ct));

    [HttpDelete("{id:guid}/statuses/{statusId:guid}")]
    public async Task<IActionResult> DeleteStatus(Guid id, Guid statusId, CancellationToken ct) =>
        Ok(await projects.DeleteStatusAsync(id, statusId, ct));

    // ---- timeline stages
    [HttpGet("{id:guid}/stages")]
    public async Task<IActionResult> Stages(Guid id, CancellationToken ct)
    {
        await projects.GetAsync(id, ct);
        return Ok(await projects.GetStagesAsync(id, ct));
    }

    [HttpPost("{id:guid}/stages")]
    public async Task<IActionResult> CreateStage(Guid id, [FromBody] UpsertStageRequest req, CancellationToken ct) =>
        Created(await projects.CreateStageAsync(id, req, ct));

    [HttpPut("{id:guid}/stages/order")]
    public async Task<IActionResult> ReorderStages(Guid id, [FromBody] ReorderStagesRequest req, CancellationToken ct) =>
        Ok(await projects.ReorderStagesAsync(id, req, ct));

    [HttpPut("{id:guid}/stages/{stageId:guid}")]
    public async Task<IActionResult> UpdateStage(Guid id, Guid stageId, [FromBody] UpsertStageRequest req, CancellationToken ct) =>
        Ok(await projects.UpdateStageAsync(id, stageId, req, ct));

    [HttpDelete("{id:guid}/stages/{stageId:guid}")]
    public async Task<IActionResult> DeleteStage(Guid id, Guid stageId, CancellationToken ct) =>
        Ok(await projects.DeleteStageAsync(id, stageId, ct));

    // ---- activity & tasks
    [HttpGet("{id:guid}/activity"), RequireModule(Modules.Activity)]
    public async Task<IActionResult> Activity(Guid id, [FromQuery] int page = 1, [FromQuery] int pageSize = 25, CancellationToken ct = default) =>
        Ok(await activity.ListAsync(id, page, pageSize, ct));

    [HttpGet("{id:guid}/tasks"), RequireModule(Modules.Tasks)]
    public async Task<IActionResult> Tasks(Guid id, [FromQuery] TaskQuery query, CancellationToken ct) =>
        Ok(await tasks.ListAsync(query with { ProjectId = id }, ct));

    [HttpPost("{id:guid}/tasks"), RequireModule(Modules.Tasks)]
    public async Task<IActionResult> CreateTask(Guid id, [FromBody] CreateTaskRequest req, CancellationToken ct) =>
        Created(await tasks.CreateAsync(id, req, ct));
}
