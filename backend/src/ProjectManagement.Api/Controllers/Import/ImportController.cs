using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Import;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Import;

/// <summary>Bulk-import tasks from a CSV file: check first (preview), then import with the same mapping.</summary>
[Route("api/v1/projects/{projectId:guid}/import"), RequireWorkspace]
public class ImportController(TaskImportService import, IHttpClientFactory http) : ApiControllerBase
{
    private const int RequestCeiling = 3 * 1024 * 1024;

    private static async Task<byte[]> ReadAsync(IFormFile? file, CancellationToken ct)
    {
        if (file is null || file.Length == 0) throw new ValidationException("file", "Choose a file.");
        if (file.Length > TaskImportService.MaxBytes) throw new ValidationException("file", "The file is larger than 2 MB.");
        await using var s = file.OpenReadStream();
        using var ms = new MemoryStream();
        await s.CopyToAsync(ms, ct);
        return ms.ToArray();
    }

    private static ImportOptions Options(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return new ImportOptions(false, true, "dmy");
        try { return JsonSerializer.Deserialize<ImportOptions>(json, new JsonSerializerOptions(JsonSerializerDefaults.Web)) ?? new ImportOptions(false, true, "dmy"); }
        catch (JsonException) { throw new ValidationException("options", "The import options could not be read."); }
    }

    [HttpPost("preview"), RequireModule(Modules.Tasks, AccessLevel.Edit)]
    [RequestSizeLimit(RequestCeiling), RequestFormLimits(MultipartBodyLengthLimit = RequestCeiling)]
    public async Task<IActionResult> Preview(Guid projectId, IFormFile? file, [FromForm] string? mapping, [FromForm] string? options, [FromForm] string? source, CancellationToken ct) =>
        Ok(await import.PreviewAsync(projectId, await ReadAsync(file, ct), mapping, Options(options), ct, ImportSources.Normalize(source, file?.FileName)));

    [HttpPost, RequireModule(Modules.Tasks, AccessLevel.Edit)]
    [RequestSizeLimit(RequestCeiling), RequestFormLimits(MultipartBodyLengthLimit = RequestCeiling)]
    public async Task<IActionResult> Import(Guid projectId, IFormFile? file, [FromForm] string? mapping, [FromForm] string? options, [FromForm] string? source, CancellationToken ct) =>
        Created(await import.ImportAsync(projectId, await ReadAsync(file, ct), mapping, Options(options), ct, ImportSources.Normalize(source, file?.FileName), file?.FileName));

    /// <summary>The project's recent imports, each with Undo while it still can be.</summary>
    [HttpGet("batches"), RequireModule(Modules.Tasks)]
    public async Task<IActionResult> Batches(Guid projectId, CancellationToken ct) => Ok(await import.BatchesAsync(projectId, ct));

    [HttpPost("batches/{batchId:guid}/undo"), RequireModule(Modules.Tasks, AccessLevel.Edit)]
    public async Task<IActionResult> Undo(Guid projectId, Guid batchId, CancellationToken ct) => Ok(await import.UndoAsync(projectId, batchId, ct));

    /// <summary>
    /// Reads issues from Jira Cloud (site, e-mail and API token) or tasks from Asana (project and personal access token) and hands them back
    /// as a CSV in that tool's export shape. The browser then previews and imports it like a file, so the token is used once and never stored.
    /// </summary>
    [HttpPost("fetch"), RequireModule(Modules.Tasks, AccessLevel.Edit), RequestSizeLimit(64 * 1024)]
    public async Task<IActionResult> Fetch(Guid projectId, [FromBody] ImportFetchRequest req, CancellationToken ct)
    {
        await import.BatchesAsync(projectId, ct);   // the project must be visible to the caller
        var client = http.CreateClient("import-sources");
        var csv = (req.Source ?? "").ToLowerInvariant() switch
        {
            "jira" => await ImportSources.JiraApiAsync(client, req.Site, req.Email, req.Token, req.Query, ct),
            "asana" => await ImportSources.AsanaApiAsync(client, req.Project, req.Token, ct),
            _ => throw new ValidationException("source", "Choose Jira or Asana."),
        };
        return Ok(new { source = req.Source!.ToLowerInvariant(), fileName = $"{req.Source!.ToLowerInvariant()}-import.csv", csv });
    }
}

public record ImportFetchRequest(string? Source, string? Site, string? Email, string? Token, string? Query, string? Project);
