using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Projects;

/// <summary>Feeds the Project Status presentation page.</summary>
[Route("api/v1/project-status"), RequireWorkspace, RequireModule(Modules.Projects)]
public class ProjectStatusController(ProjectStatusService status) : ApiControllerBase
{
    /// <summary>The projects organized by group, for the page's sidebar.</summary>
    [HttpGet("groups")]
    public async Task<IActionResult> Groups(CancellationToken ct) => Ok(await status.GroupsAsync(ct));

    /// <summary>One project's status: its tasks, the history of its delivery dates and what is blocking work.</summary>
    [HttpGet("projects/{id:guid}")]
    public async Task<IActionResult> Report(Guid id, CancellationToken ct) => Ok(await status.ReportAsync(id, ct));
}
