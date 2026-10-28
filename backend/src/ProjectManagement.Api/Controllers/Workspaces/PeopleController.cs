using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.People;

namespace ProjectManagement.Api.Controllers.Workspaces;

/// <summary>People &amp; Roles: suspend and reactivate members, and preview who gains or loses what before a change is saved.</summary>
[Route("api/v1/workspace"), RequireWorkspace]
public class PeopleController(PeopleAdminService people) : ApiControllerBase
{
    /// <summary>Keeps the person in the workspace (history, assignments, reporting lines) but stops them opening it; ends their sessions here.</summary>
    [HttpPost("members/{userId:guid}/suspend")]
    public async Task<IActionResult> Suspend(Guid userId, CancellationToken ct) => Ok(await people.SuspendAsync(userId, ct));

    [HttpPost("members/{userId:guid}/reactivate")]
    public async Task<IActionResult> Reactivate(Guid userId, CancellationToken ct) => Ok(await people.ReactivateAsync(userId, ct));

    /// <summary>Dry run: what a change to an access level, job role, job role access, suspension or removal would do. Nothing is saved.</summary>
    [HttpPost("people/impact")]
    public async Task<IActionResult> Impact([FromBody] ImpactRequest req, CancellationToken ct) => Ok(await people.PreviewAsync(req, ct));
}
