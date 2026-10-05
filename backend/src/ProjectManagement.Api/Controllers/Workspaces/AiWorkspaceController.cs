using System.Text.Json;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Common;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Application.Features.Files;

namespace ProjectManagement.Api.Controllers.Workspaces;

/// <summary>
/// The AI workspace page: conversations, questions answered live, files, and the suggestions the assistant makes. Everything belongs to the
/// signed-in person; the assistant reads only what they may read (see <see cref="AiAgent"/>).
/// </summary>
[Route("api/v1/ai"), RequireWorkspace]
public class AiWorkspaceController(AiAgent agent, AiGuidance guidance, AiAnalysis analysis, AiFileService files, AiUsageService usage) : ApiControllerBase
{
    private static readonly JsonSerializerOptions StreamJson = Make();
    private static JsonSerializerOptions Make() { var o = new JsonSerializerOptions(); Json.Configure(o); return o; }
    private const long FileCeiling = 40L * 1024 * 1024;   // the largest file plus form overhead; the real limits are in AiFileService

    /// <summary>The plan's AI levels and what is left of the month's credits.</summary>
    [HttpGet("usage")]
    public async Task<IActionResult> Usage(CancellationToken ct) => Ok(await agent.UsageAsync(ct));

    /// <summary>Owners and admins: who used the assistant this month and how much (counts only, never what was asked).</summary>
    [HttpGet("usage/report")]
    public async Task<IActionResult> UsageReport([FromQuery] string? month, CancellationToken ct) => Ok(await usage.WorkspaceAsync(month, ct));

    // ---- conversations

    [HttpGet("conversations")]
    public async Task<IActionResult> List(CancellationToken ct) => Ok(await agent.ListAsync(ct));

    [HttpGet("conversations/{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct) => Ok(await agent.GetAsync(id, ct));

    [HttpPatch("conversations/{id:guid}")]
    public async Task<IActionResult> Update(Guid id, [FromBody] RenameAiConversationRequest req, CancellationToken ct) => Ok(await agent.UpdateAsync(id, req, ct));

    [HttpDelete("conversations/{id:guid}")]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
    {
        await agent.DeleteAsync(id, ct);
        return NoContent();
    }

    // ---- asking (answers stream back as server-sent events)

    /// <summary>Starts a new conversation with a question.</summary>
    [HttpPost("ask")]
    public async Task<IActionResult> AskNew([FromBody] AiAskRequest req, CancellationToken ct) => await StreamAsync(await agent.PrepareAsync(null, req, ct), ct);

    /// <summary>Asks a follow-up in an existing conversation.</summary>
    [HttpPost("conversations/{id:guid}/ask")]
    public async Task<IActionResult> Ask(Guid id, [FromBody] AiAskRequest req, CancellationToken ct) => await StreamAsync(await agent.PrepareAsync(id, req, ct), ct);

    private async Task<IActionResult> StreamAsync(AiRun run, CancellationToken ct)
    {
        // Everything that can be refused was refused above, as an ordinary error response. From here on the connection stays open and
        // problems arrive as an "error" event.
        Response.StatusCode = StatusCodes.Status200OK;
        Response.ContentType = "text/event-stream; charset=utf-8";
        Response.Headers.CacheControl = "no-store, no-transform";   // no-transform: proxies must not compress (and so hold back) the stream
        Response.Headers["X-Accel-Buffering"] = "no";               // nginx: pass each piece on at once
        HttpContext.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();
        await Response.StartAsync(ct);
        try
        {
            await foreach (var e in agent.StreamAsync(run, ct))
            {
                await Response.WriteAsync($"event: {e.Name}\ndata: {JsonSerializer.Serialize(e, e.GetType(), StreamJson)}\n\n", ct);
                await Response.Body.FlushAsync(ct);
            }
        }
        catch (OperationCanceledException) { /* the person pressed Stop or left; the answer so far is already saved */ }
        return new EmptyResult();
    }

    // ---- suggestions the assistant made

    [HttpPost("messages/{messageId:guid}/actions/{actionId}/confirm")]
    public async Task<IActionResult> Confirm(Guid messageId, string actionId, CancellationToken ct) => Ok(await agent.ConfirmAsync(messageId, actionId, ct));

    [HttpPost("messages/{messageId:guid}/actions/{actionId}/dismiss")]
    public async Task<IActionResult> Dismiss(Guid messageId, string actionId, CancellationToken ct) => Ok(await agent.DismissAsync(messageId, actionId, ct));

    // ---- files

    [HttpPost("files")]
    [RequestSizeLimit(FileCeiling), RequestFormLimits(MultipartBodyLengthLimit = FileCeiling)]
    public async Task<IActionResult> Upload(IFormFile file, CancellationToken ct)
    {
        await using var stream = file.OpenReadStream();
        return Created(await files.UploadAsync(file.FileName, stream, file.Length, ct));
    }

    /// <summary>The owner's own file: pictures can be shown inline, everything else downloads.</summary>
    [HttpGet("files/{id:guid}")]
    public async Task<IActionResult> Download(Guid id, [FromQuery] bool inline, CancellationToken ct)
    {
        var (file, content) = await files.OpenAsync(id, ct);
        Response.Headers.CacheControl = "private, no-store";
        Response.Headers["X-Content-Type-Options"] = "nosniff";
        Response.Headers.ContentSecurityPolicy = "default-src 'none'; sandbox";
        return inline && FileRules.IsImage(file.ContentType) ? File(content, file.ContentType) : File(content, file.ContentType, file.FileName);
    }

    /// <summary>Takes back a file that was added but not yet sent with a question.</summary>
    [HttpDelete("files/{id:guid}")]
    public async Task<IActionResult> RemoveFile(Guid id, CancellationToken ct)
    {
        await files.RemovePendingAsync(id, ct);
        return NoContent();
    }

    /// <summary>Everything still waiting in one answer, confirmed in order.</summary>
    [HttpPost("messages/{id:guid}/actions/confirm-all")]
    public async Task<IActionResult> ConfirmAll(Guid id, CancellationToken ct) => Ok(await agent.ConfirmAllAsync(id, ct));

    /// <summary>What deserves attention today, found by rules over the person's own data (no model, no credits).</summary>
    [HttpGet("insights")]
    public async Task<IActionResult> Insights(CancellationToken ct) => Ok(await analysis.InsightsAsync(ct));

    // ---- getting to know the person (no model involved)

    [HttpGet("starters")]
    public async Task<IActionResult> Starters(CancellationToken ct) => Ok(await guidance.StartersAsync(ct));

    [HttpPost("messages/{id:guid}/feedback")]
    public async Task<IActionResult> Feedback(Guid id, [FromBody] AiFeedbackRequest req, CancellationToken ct) { await guidance.FeedbackAsync(id, req.Rating, req.Reason, ct); return NoContent(); }

    [HttpGet("profile")]
    public async Task<IActionResult> Profile(CancellationToken ct) => Ok(await guidance.ProfileAsync(ct));

    [HttpPut("profile")]
    public async Task<IActionResult> SetProfile([FromBody] SetAiProfileRequest req, CancellationToken ct) => Ok(await guidance.SetNotesAsync(req.Notes, ct));

    [HttpDelete("profile")]
    public async Task<IActionResult> ResetProfile(CancellationToken ct) => Ok(await guidance.ResetAsync(ct));

    // ---- what the organization tells the assistant about itself

    [HttpGet("instructions")]
    public async Task<IActionResult> Instructions(CancellationToken ct) => Ok(await agent.InstructionsAsync(ct));

    [HttpPut("instructions")]
    public async Task<IActionResult> SetInstructions([FromBody] SetAiInstructionsRequest req, CancellationToken ct) => Ok(await agent.SetInstructionsAsync(req.Text, ct));
}
