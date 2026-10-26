using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Talk;

namespace ProjectManagement.Api.Controllers.Chat;

/// <summary>Talk: chat, mail and meetings in one list (each thread keeps its own endpoints).</summary>
[Route("api/v1/talk"), RequireWorkspace, ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
public class TalkController(TalkService talk) : ApiControllerBase
{
    /// <summary>The conversations to show, newest first. f = all | chat | mail | meetings.</summary>
    [HttpGet("conversations")]
    public async Task<IActionResult> Conversations([FromQuery] string? f, CancellationToken ct) => Ok(await talk.ListAsync(f, ct));
}
