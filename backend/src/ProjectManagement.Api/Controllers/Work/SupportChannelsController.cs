using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Support;
namespace ProjectManagement.Api.Controllers.Work;

/// <summary>Teams' WhatsApp Business numbers and the support chats on them.</summary>
[Route("api/v1/support"), RequireWorkspace, ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
public class SupportChannelsController(SupportChannelService support) : ApiControllerBase
{
    [HttpGet("channels")] public async Task<IActionResult> Channels(CancellationToken ct) => Ok(await support.ChannelsAsync(ct));
    [HttpPost("channels")] public async Task<IActionResult> Connect([FromBody] SaveSupportChannelRequest req, CancellationToken ct) => Created(await support.SaveChannelAsync(null, req, ct));
    [HttpPut("channels/{id:guid}")] public async Task<IActionResult> Save(Guid id, [FromBody] SaveSupportChannelRequest req, CancellationToken ct) => Ok(await support.SaveChannelAsync(id, req, ct));
    [HttpPost("channels/{id:guid}/check")] public async Task<IActionResult> Check(Guid id, CancellationToken ct) => Ok(await support.CheckChannelAsync(id, ct));
    [HttpDelete("channels/{id:guid}")] public async Task<IActionResult> Remove(Guid id, CancellationToken ct) { await support.DeleteChannelAsync(id, ct); return NoContent(); }
    [HttpGet("conversations")] public async Task<IActionResult> Conversations([FromQuery] Guid? channelId, [FromQuery] string? status, CancellationToken ct) => Ok(await support.ConversationsAsync(channelId, status, ct));
    [HttpGet("conversations/{id:guid}")] public async Task<IActionResult> Conversation(Guid id, CancellationToken ct) => Ok(await support.ConversationAsync(id, ct));
    [HttpPost("conversations/{id:guid}/reply")] public async Task<IActionResult> Reply(Guid id, [FromBody] SupportReplyRequest req, CancellationToken ct) => Ok(await support.ReplyAsync(id, req, ct));
    [HttpPost("conversations/{id:guid}/ticket")] public async Task<IActionResult> Ticket(Guid id, CancellationToken ct) => Ok(await support.CreateTicketAsync(id, ct));
    [HttpPost("conversations/{id:guid}/{mode:regex(^(ai|human|close)$)}")] public async Task<IActionResult> Mode(Guid id, string mode, CancellationToken ct) => Ok(await support.SetModeAsync(id, mode, ct));
}

/// <summary>Where Meta delivers messages for one connected number (the address and verify token are shown when the number is connected).</summary>
[Route("api/v1/support/whatsapp/{channelId:guid}"), AllowAnonymous]
public class SupportWhatsAppWebhookController(SupportChannelService support) : ApiControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Verify(Guid channelId, [FromQuery(Name = "hub.mode")] string? mode, [FromQuery(Name = "hub.verify_token")] string? token,
        [FromQuery(Name = "hub.challenge")] string? challenge, CancellationToken ct) =>
        await support.VerifyWebhookAsync(channelId, mode, token, challenge, ct) is { } echo ? Content(echo, "text/plain") : StatusCode(403);

    [HttpPost, RequestSizeLimit(256 * 1024)]
    public async Task<IActionResult> Receive(Guid channelId, CancellationToken ct)
    {
        using var stream = new MemoryStream();
        await Request.Body.CopyToAsync(stream, ct);
        if (stream.Length > 256 * 1024) throw new ValidationException("body", "Payload is too large.");
        return await support.ReceiveAsync(channelId, stream.ToArray(), Request.Headers["X-Hub-Signature-256"].ToString(), ct) ? Ok(new { received = true }) : StatusCode(401);
    }
}
