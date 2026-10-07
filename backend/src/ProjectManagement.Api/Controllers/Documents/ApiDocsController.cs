using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.ApiDocs;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Documents;

/// <summary>The API reference of a document: the APIs it describes, their endpoints, import and export, and what changed between versions. Who may open a document is decided in the data layer (see <c>DocumentService</c>).</summary>
[Route("api/v1"), RequireWorkspace, RequireModule(Modules.Documents)]
public class ApiDocsController(ApiDocService api, ApiTransferService transfer) : ApiControllerBase
{
    [HttpGet("documents/{id:guid}/api")]
    public async Task<IActionResult> Overview(Guid id, [FromQuery] Guid? versionId, CancellationToken ct) => Ok(await api.OverviewAsync(id, versionId, ct));

    [HttpPost("documents/{id:guid}/api/definitions")]
    public async Task<IActionResult> AddDefinition(Guid id, [FromBody] SaveDefinitionRequest req, CancellationToken ct) => Created(await api.SaveDefinitionAsync(id, null, req, ct));

    [HttpPut("documents/{id:guid}/api/definitions/{definitionId:guid}")]
    public async Task<IActionResult> UpdateDefinition(Guid id, Guid definitionId, [FromBody] SaveDefinitionRequest req, CancellationToken ct) => Ok(await api.SaveDefinitionAsync(id, definitionId, req, ct));

    [HttpDelete("documents/{id:guid}/api/definitions/{definitionId:guid}")]
    public async Task<IActionResult> DeleteDefinition(Guid id, Guid definitionId, CancellationToken ct) => Ok(await api.DeleteDefinitionAsync(id, definitionId, ct));

    [HttpGet("documents/{id:guid}/api/endpoints")]
    public async Task<IActionResult> Endpoints(Guid id, [FromQuery] Guid? definitionId, [FromQuery] string? q, [FromQuery] string? method, [FromQuery] string? tag, [FromQuery] Guid? versionId,
        [FromQuery] string? cursor, [FromQuery] int? limit, CancellationToken ct) => Ok(await api.ListAsync(id, new EndpointFilter(definitionId, q, method, tag, versionId), cursor, limit, ct));

    [HttpGet("documents/{id:guid}/api/endpoints/{endpointId:guid}")]
    public async Task<IActionResult> Endpoint(Guid id, Guid endpointId, [FromQuery] Guid? versionId, CancellationToken ct) => Ok(await api.GetAsync(id, endpointId, versionId, ct));

    [HttpPost("documents/{id:guid}/api/endpoints")]
    public async Task<IActionResult> AddEndpoint(Guid id, [FromBody] SaveEndpointRequest req, CancellationToken ct) => Created(await api.SaveEndpointAsync(id, null, req, ct));

    [HttpPut("documents/{id:guid}/api/endpoints/{endpointId:guid}")]
    public async Task<IActionResult> UpdateEndpoint(Guid id, Guid endpointId, [FromBody] SaveEndpointRequest req, CancellationToken ct) => Ok(await api.SaveEndpointAsync(id, endpointId, req, ct));

    [HttpDelete("documents/{id:guid}/api/endpoints/{endpointId:guid}")]
    public async Task<IActionResult> DeleteEndpoint(Guid id, Guid endpointId, CancellationToken ct)
    {
        await api.DeleteEndpointAsync(id, endpointId, ct);
        return NoContent();
    }

    /// <summary>Import an OpenAPI 3 (JSON or YAML) or Postman 2.1 file. <c>dryRun</c> only says what would happen.</summary>
    [HttpPost("documents/{id:guid}/api/import"), RequestSizeLimit(7_000_000)]
    public async Task<IActionResult> Import(Guid id, [FromBody] ImportApiRequest req, CancellationToken ct) => Ok(await transfer.ImportAsync(id, req, ct));

    [HttpGet("documents/{id:guid}/api/export")]
    public async Task<IActionResult> Export(Guid id, [FromQuery] string? format, [FromQuery] Guid? definitionId, [FromQuery] Guid? versionId, CancellationToken ct)
    {
        var f = await transfer.ExportAsync(id, format, definitionId, versionId, ct);
        Response.Headers.CacheControl = "private, no-store";
        return File(f.Bytes, f.ContentType, f.FileName);
    }

    /// <summary>What changed in the API between two versions (or a version and the working copy), with the breaking changes first.</summary>
    [HttpGet("documents/{id:guid}/api/changes")]
    public async Task<IActionResult> Changes(Guid id, [FromQuery] Guid? from, [FromQuery] Guid? to, CancellationToken ct) => Ok(await transfer.ChangesAsync(id, from, to, ct));

    /// <summary>Published endpoints by a fragment of their path, summary or group, in documents the person may open.</summary>
    [HttpGet("api-search")]
    public async Task<IActionResult> Search([FromQuery] string? q, [FromQuery] Guid? projectId, [FromQuery] int? limit, CancellationToken ct) => Ok(await api.SearchAsync(q, projectId, limit, ct));
}
