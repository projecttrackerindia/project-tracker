using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Desk;
using ProjectManagement.Application.Features.Support;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Desk;

/// <summary>
/// The Desk's omnichannel layer: Integrations settings (write-only keys), engineers' availability and skills, the inbound queue and its dead
/// letters, each ticket's routing (AI insight, offer, accept, reassign, supervisor override, review) and voice intake (consent, turns, summary).
/// </summary>
[Route("api/v1/desk"), RequireWorkspace, RequireModule(Modules.Work), ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
public class DeskOmnichannelController(DeskSettingsService settings, DeskRoutingService routing, DeskVoiceService voice, SupportChannelService support) : ApiControllerBase
{
    [HttpGet("settings")] public async Task<IActionResult> Settings(CancellationToken ct) => Ok(await settings.GetAsync(ct));
    [HttpPut("settings")] public async Task<IActionResult> SaveSettings([FromBody] SaveDeskSettingsRequest req, CancellationToken ct) => Ok(await settings.SaveAsync(req, ct));

    [HttpGet("engineers")] public async Task<IActionResult> Engineers(CancellationToken ct) => Ok(await settings.EngineersAsync(ct));
    [HttpPut("engineers/{userId:guid}")] public async Task<IActionResult> SaveEngineer(Guid userId, [FromBody] SaveDeskEngineerRequest req, CancellationToken ct) => Ok(await settings.SaveEngineerAsync(userId, req, ct));
    [HttpPost("engineers/me/status")] public async Task<IActionResult> MyStatus([FromBody] DeskStatusRequest req, CancellationToken ct) => Ok(await settings.SetMyStatusAsync(req, ct));

    [HttpGet("queue")] public async Task<IActionResult> Queue(CancellationToken ct) => Ok(await settings.QueueAsync(ct));
    [HttpPost("queue/{id:guid}/retry")] public async Task<IActionResult> Retry(Guid id, CancellationToken ct) => Ok(await settings.RetryAsync(id, ct));

    [HttpGet("tickets/{id:guid}/routing")] public async Task<IActionResult> Routing(Guid id, CancellationToken ct) => Ok(await routing.PanelAsync(id, ct));
    [HttpGet("tickets/{id:guid}/whatsapp")]
    public async Task<IActionResult> WhatsApp(Guid id, CancellationToken ct) => await support.TicketChatAsync(id, ct) is { } chat ? Ok(chat) : NoContent();
    [HttpPost("tickets/{id:guid}/accept")] public async Task<IActionResult> Accept(Guid id, CancellationToken ct) => Ok(await routing.AcceptAsync(id, ct));
    [HttpPost("tickets/{id:guid}/reassign")] public async Task<IActionResult> Reassign(Guid id, [FromBody] DeskReassignRequest req, CancellationToken ct) => Ok(await routing.ReassignAsync(id, req, false, ct));
    [HttpPost("tickets/{id:guid}/override")] public async Task<IActionResult> Override(Guid id, [FromBody] DeskReassignRequest req, CancellationToken ct) => Ok(await routing.ReassignAsync(id, req, true, ct));
    [HttpPost("tickets/{id:guid}/review")] public async Task<IActionResult> Review(Guid id, [FromBody] DeskReviewRequest req, CancellationToken ct) => Ok(await routing.ReviewAsync(id, req, ct));
    [HttpGet("tickets/{id:guid}/voice")] public async Task<IActionResult> TicketVoice(Guid id, CancellationToken ct) => Ok(await voice.ForTicketAsync(id, ct));
    [HttpPost("tickets/{id:guid}/callback")] public async Task<IActionResult> Callback(Guid id, [FromBody] DeskCallbackRequest req, CancellationToken ct) => Ok(await voice.CallbackAsync(id, req, ct));

    [HttpGet("voice")] public async Task<IActionResult> VoiceStatus(CancellationToken ct) => Ok(await voice.StatusAsync(ct));
    [HttpPost("voice/sessions")] public async Task<IActionResult> StartVoice([FromBody] StartDeskVoiceRequest req, CancellationToken ct) => Created(await voice.StartAsync(req, ct));
    [HttpGet("voice/sessions/{id:guid}")] public async Task<IActionResult> VoiceSession(Guid id, CancellationToken ct) => Ok(await voice.GetAsync(id, ct));
    [HttpPost("voice/sessions/{id:guid}/consent")] public async Task<IActionResult> Consent(Guid id, [FromBody] DeskConsentRequest req, CancellationToken ct) => Ok(await voice.ConsentAsync(id, req, ct));
    [HttpPost("voice/sessions/{id:guid}/say")] public async Task<IActionResult> Say(Guid id, [FromBody] DeskVoiceSayRequest req, CancellationToken ct) => Ok(await voice.SayAsync(id, req, ct));
    [HttpPost("voice/sessions/{id:guid}/listen"), AiRequestLimit, RequestSizeLimit(9_000_000)]
    public async Task<IActionResult> Listen(Guid id, IFormFile file, CancellationToken ct)
    {
        using var ms = new MemoryStream();
        await file.CopyToAsync(ms, ct);
        return Ok(await voice.ListenAsync(id, ms.ToArray(), file.ContentType ?? "audio/webm", ct));
    }
    [HttpPost("voice/sessions/{id:guid}/complete")] public async Task<IActionResult> Complete(Guid id, CancellationToken ct) => Ok(await voice.CompleteAsync(id, ct));
    [HttpGet("voice/sessions/{id:guid}/audio/{index:int}")]
    public async Task<IActionResult> Audio(Guid id, int index, CancellationToken ct)
    {
        var (content, type) = await voice.AudioAsync(id, index, ct);
        Response.Headers["X-Content-Type-Options"] = "nosniff";
        Response.Headers["Content-Security-Policy"] = "default-src 'none'; sandbox";
        return File(content, type.StartsWith("audio/", StringComparison.Ordinal) ? type : "application/octet-stream");
    }
}
