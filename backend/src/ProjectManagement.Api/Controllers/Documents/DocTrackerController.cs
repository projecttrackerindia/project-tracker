using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.DocTracker;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Documents;

/// <summary>DocTracker: every project's APIs, documents and architecture in one place. Reads go through the document and API services, so access is unchanged.</summary>
[Route("api/v1/doctracker"), RequireWorkspace, RequireModule(Modules.Documents)]
public class DocTrackerController(DocTrackerService tracker) : ApiControllerBase
{
    [HttpGet("catalog")]
    public async Task<IActionResult> Catalog(CancellationToken ct) => Ok(await tracker.CatalogAsync(ct));

    /// <summary>A project's architecture and request-flow diagrams. <c>general</c> (no project id) is the organization-wide one.</summary>
    [HttpGet("architecture")]
    public async Task<IActionResult> Architecture([FromQuery] Guid? projectId, CancellationToken ct) => Ok(await tracker.ArchitectureAsync(projectId, ct));

    [HttpPut("architecture")]
    public async Task<IActionResult> SaveArchitecture([FromQuery] Guid? projectId, [FromBody] SaveArchitectureRequest req, CancellationToken ct) => Ok(await tracker.SaveArchitectureAsync(projectId, req, ct));

    /// <summary>The project's API document (created with a first API when there is none), where its new endpoints go.</summary>
    [HttpPost("api-home")]
    public async Task<IActionResult> ApiHome([FromQuery] Guid? projectId, CancellationToken ct) => Ok(await tracker.ApiHomeAsync(projectId, ct));
}
