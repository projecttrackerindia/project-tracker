using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Issues;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Issues;

/// <summary>Test issues found in a project's stages ("Observed / Failed"): reported, worked on, fixed and confirmed. See <see cref="IssueService"/> for the rules.</summary>
[Route("api/v1/projects/{projectId:guid}/issues"), RequireWorkspace, RequireModule(Modules.Projects), RequireModule(Modules.Tasks)]
public class IssuesController(IssueService issues) : ApiControllerBase
{
    [HttpGet]
    public async Task<IActionResult> List(Guid projectId, [FromQuery] Guid? stageId, [FromQuery] bool openOnly, CancellationToken ct) =>
        Ok(await issues.ListAsync(projectId, stageId, openOnly, ct));

    [HttpGet("{issueId:guid}")]
    public async Task<IActionResult> Get(Guid projectId, Guid issueId, CancellationToken ct) => Ok(await issues.GetAsync(projectId, issueId, ct));

    [HttpPost]
    public async Task<IActionResult> Create(Guid projectId, [FromBody] CreateIssueRequest req, CancellationToken ct) => Created(await issues.CreateAsync(projectId, req, ct));

    [HttpPut("{issueId:guid}")]
    public async Task<IActionResult> Update(Guid projectId, Guid issueId, [FromBody] UpdateIssueRequest req, CancellationToken ct) =>
        Ok(await issues.UpdateAsync(projectId, issueId, req, ct));

    [HttpPut("{issueId:guid}/assignee")]
    public async Task<IActionResult> Assign(Guid projectId, Guid issueId, [FromBody] AssignIssueRequest req, CancellationToken ct) =>
        Ok(await issues.AssignAsync(projectId, issueId, req, ct));

    [HttpPut("{issueId:guid}/status")]
    public async Task<IActionResult> ChangeStatus(Guid projectId, Guid issueId, [FromBody] ChangeIssueStatusRequest req, CancellationToken ct) =>
        Ok(await issues.ChangeStatusAsync(projectId, issueId, req, ct));

    [HttpDelete("{issueId:guid}")]
    public async Task<IActionResult> Delete(Guid projectId, Guid issueId, CancellationToken ct)
    {
        await issues.DeleteAsync(projectId, issueId, ct);
        return NoContent();
    }
}
