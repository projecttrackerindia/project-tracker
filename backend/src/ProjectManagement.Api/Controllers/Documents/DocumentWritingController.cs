using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Documents;

/// <summary>
/// Documents release 2: AI that writes and edits pages, ask the space, ranked search inside pages, out-of-date checks with a verified badge,
/// and pages that write themselves (drafts to approve).
/// </summary>
[Route("api/v1"), RequireWorkspace, RequireModule(Modules.Documents)]
public class DocumentWritingController(DocumentAiService writing, DocumentRankedSearch search, DocumentFreshnessService freshness, DocumentProposalService proposals) : ApiControllerBase
{
    private static async Task<DraftUpload> ReadAsync(IFormFile f, CancellationToken ct)
    {
        using var ms = new MemoryStream();
        await f.CopyToAsync(ms, ct);
        return new DraftUpload(Path.GetFileName(f.FileName), f.ContentType ?? "application/octet-stream", ms.ToArray());
    }

    /// <summary>A page written by AI from one line, a meeting, a project's tasks, files, a voice note or a template (sent as a form, files and the recording attached).</summary>
    [HttpPost("documents/ai/draft"), AiRequestLimit, RequestSizeLimit(30 * 1024 * 1024)]
    public async Task<IActionResult> Draft([FromForm] string source, [FromForm] string? prompt, [FromForm] Guid? projectId, [FromForm] Guid? meetingId, [FromForm] Guid? templateTypeId,
        [FromForm] string? language, [FromForm] string? kind, CancellationToken ct)
    {
        var form = Request.HasFormContentType ? await Request.ReadFormAsync(ct) : null;
        var files = new List<DraftUpload>();
        DraftUpload? voice = null;
        foreach (var f in form?.Files ?? new FormFileCollection())
        {
            if (f.Length == 0) continue;
            if (f.Name == "voice") voice = await ReadAsync(f, ct);
            else if (files.Count < 5) files.Add(await ReadAsync(f, ct));
        }
        return Ok(await writing.DraftAsync(new DocDraftRequest(source, prompt, projectId, meetingId, templateTypeId, language, kind), files, voice, ct));
    }

    /// <summary>Selected text rewritten, shortened, expanded, fixed, translated (Telugu, Hindi, English) or given another tone.</summary>
    [HttpPost("documents/ai/transform"), AiRequestLimit]
    public async Task<IActionResult> Transform([FromBody] DocTransformRequest req, CancellationToken ct) => Ok(await writing.TransformAsync(req, ct));

    /// <summary>The next paragraphs of a page, in its voice.</summary>
    [HttpPost("documents/ai/continue"), AiRequestLimit]
    public async Task<IActionResult> Continue([FromBody] DocContinueRequest req, CancellationToken ct) => Ok(await writing.ContinueAsync(req, ct));

    /// <summary>An answer from the pages the person may read, cited to the lines it came from.</summary>
    [HttpPost("documents/ai/ask"), AiRequestLimit]
    public async Task<IActionResult> Ask([FromBody] AskSpaceRequest req, CancellationToken ct) => Ok(await writing.AskAsync(req, ct));

    /// <summary>Pages and documents containing the words, best first, each with its matching line.</summary>
    [HttpGet("documents/search")]
    public async Task<IActionResult> Search([FromQuery] string q, [FromQuery] Guid? projectId, [FromQuery] int take = 20, CancellationToken ct = default) =>
        Ok(await search.SearchAsync(q ?? "", projectId, take, ct));

    [HttpGet("documents/{id:guid}/freshness")]
    public async Task<IActionResult> Freshness(Guid id, CancellationToken ct) => Ok(await freshness.GetAsync(id, ct));

    /// <summary>The owner (or an editor) confirms the page is still right: a verified badge with today's date.</summary>
    [HttpPost("documents/{id:guid}/verify")]
    public async Task<IActionResult> Verify(Guid id, [FromBody] VerifyDocumentRequest? req, CancellationToken ct) => Ok(await freshness.VerifyAsync(id, req ?? new VerifyDocumentRequest(null), ct));

    /// <summary>Drafts waiting for approval: decision log entries, release notes, API references.</summary>
    [HttpGet("documents/proposals")]
    public async Task<IActionResult> Proposals([FromQuery] Guid? projectId, [FromQuery] string? status, CancellationToken ct) => Ok(await proposals.ListAsync(projectId, status, ct));

    [HttpPost("documents/proposals/generate")]
    public async Task<IActionResult> Generate([FromBody] GenerateProposalRequest req, CancellationToken ct) => Ok(await proposals.GenerateAsync(req, ct));

    [HttpPost("documents/proposals/{id:guid}/accept")]
    public async Task<IActionResult> Accept(Guid id, CancellationToken ct) => Ok(await proposals.AcceptAsync(id, ct));

    [HttpPost("documents/proposals/{id:guid}/dismiss")]
    public async Task<IActionResult> Dismiss(Guid id, CancellationToken ct) { await proposals.DismissAsync(id, ct); return NoContent(); }
}
