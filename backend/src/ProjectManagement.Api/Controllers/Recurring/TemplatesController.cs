using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Recurring;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Recurring;

/// <summary>Project and task templates: list, save from a project or task, edit, delete, and create from one with a start date.</summary>
[Route("api/v1/templates"), RequireWorkspace, RequireModule(Modules.Projects)]
public class TemplatesController(TemplateService templates) : ApiControllerBase
{
    [HttpGet]
    public async Task<IActionResult> List([FromQuery] string? kind, [FromQuery] string? q, CancellationToken ct) => Ok(await templates.ListAsync(kind, q, ct));

    [HttpGet("{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct) => Ok(await templates.GetAsync(id, ct));

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] UpsertWorkTemplateRequest req, CancellationToken ct) => Created(await templates.CreateAsync(req, ct));

    [HttpPut("{id:guid}")]
    public async Task<IActionResult> Update(Guid id, [FromBody] UpsertWorkTemplateRequest req, CancellationToken ct) => Ok(await templates.UpdateAsync(id, req, ct));

    [HttpDelete("{id:guid}")]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
    {
        await templates.DeleteAsync(id, ct);
        return NoContent();
    }

    [HttpPost("from-project/{projectId:guid}")]
    public async Task<IActionResult> SaveProject(Guid projectId, [FromBody] SaveAsTemplateRequest req, CancellationToken ct) => Created(await templates.SaveProjectAsync(projectId, req, ct));

    [HttpPost("from-task/{taskId:guid}")]
    public async Task<IActionResult> SaveTask(Guid taskId, [FromBody] SaveAsTemplateRequest req, CancellationToken ct) => Created(await templates.SaveTaskAsync(taskId, req, ct));

    [HttpPost("{id:guid}/create-project")]
    public async Task<IActionResult> CreateProject(Guid id, [FromBody] CreateProjectFromTemplateRequest req, CancellationToken ct) => Created(await templates.CreateProjectAsync(id, req, ct));

    [HttpPost("{id:guid}/create-task")]
    public async Task<IActionResult> CreateTask(Guid id, [FromBody] CreateTaskFromTemplateRequest req, CancellationToken ct) => Created(await templates.CreateTaskAsync(id, req, ct));
}
