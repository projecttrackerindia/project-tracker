using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Automation;
using ProjectManagement.Application.Features.Time;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Automation;

/// <summary>Automation rules of a project.</summary>
[Route("api/v1/projects/{projectId:guid}/automations"), RequireWorkspace]
public class AutomationController(AutomationService automation) : ApiControllerBase
{
    [HttpGet, RequireModule(Modules.Projects)]
    public async Task<IActionResult> List(Guid projectId, CancellationToken ct) => Ok(await automation.ListAsync(projectId, ct));

    [HttpPost, RequireModule(Modules.Projects, AccessLevel.Edit)]
    public async Task<IActionResult> Create(Guid projectId, [FromBody] UpsertAutomationRequest req, CancellationToken ct) => Created(await automation.CreateAsync(projectId, req, ct));

    [HttpPut("{id:guid}"), RequireModule(Modules.Projects, AccessLevel.Edit)]
    public async Task<IActionResult> Update(Guid projectId, Guid id, [FromBody] UpsertAutomationRequest req, CancellationToken ct) => Ok(await automation.UpdateAsync(projectId, id, req, ct));

    [HttpDelete("{id:guid}"), RequireModule(Modules.Projects, AccessLevel.Edit)]
    public async Task<IActionResult> Delete(Guid projectId, Guid id, CancellationToken ct)
    {
        await automation.DeleteAsync(projectId, id, ct);
        return NoContent();
    }
}
