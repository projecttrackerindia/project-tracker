using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Import;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers;

/// <summary>Bulk-import tasks from a CSV file: check first (preview), then import with the same mapping.</summary>
[Route("api/v1/projects/{projectId:guid}/import"), RequireWorkspace]
public class ImportController(TaskImportService import) : ApiControllerBase
{
    private const int RequestCeiling = 3 * 1024 * 1024;

    private static async Task<byte[]> ReadAsync(IFormFile? file, CancellationToken ct)
    {
        if (file is null || file.Length == 0) throw new ValidationException("file", "Choose a CSV file.");
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
    public async Task<IActionResult> Preview(Guid projectId, IFormFile? file, [FromForm] string? mapping, [FromForm] string? options, CancellationToken ct) =>
        Ok(await import.PreviewAsync(projectId, await ReadAsync(file, ct), mapping, Options(options), ct));

    [HttpPost, RequireModule(Modules.Tasks, AccessLevel.Edit)]
    [RequestSizeLimit(RequestCeiling), RequestFormLimits(MultipartBodyLengthLimit = RequestCeiling)]
    public async Task<IActionResult> Import(Guid projectId, IFormFile? file, [FromForm] string? mapping, [FromForm] string? options, CancellationToken ct) =>
        Created(await import.ImportAsync(projectId, await ReadAsync(file, ct), mapping, Options(options), ct));
}
