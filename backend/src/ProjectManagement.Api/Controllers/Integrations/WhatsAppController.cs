using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Integrations;

namespace ProjectManagement.Api.Controllers.Integrations;

[Route("api/v1/integrations/whatsapp"), RequireWorkspace]
public class WhatsAppController(WhatsAppGatewayService service, WhatsAppInstallationService installation) : ApiControllerBase
{
    public const string ProofCookie = "__Secure-pt-whatsapp-install";
    private static CookieOptions ProofOptions => new() { HttpOnly = true, Secure = true, SameSite = SameSiteMode.Strict,
        Path = "/api/v1/integrations/whatsapp", MaxAge = TimeSpan.FromMinutes(10) };
    [HttpPost("connect")]
    public async Task<IActionResult> Connect(CancellationToken ct)
    {
        var start = await installation.StartAsync(ct);
        Response.Headers.CacheControl = "no-store";
        Response.Cookies.Append(ProofCookie, start.BrowserProof, ProofOptions);
        return Ok(new { start.State, start.AppId, start.ConfigId, start.ApiVersion, start.SignupVersion });
    }
    [HttpPost("complete"), RequestSizeLimit(8192)]
    public async Task<IActionResult> Complete(WhatsAppConnectRequest request, CancellationToken ct)
    {
        try { await installation.CompleteAsync(request, Request.Cookies[ProofCookie], ct); return NoContent(); }
        finally { Response.Cookies.Delete(ProofCookie, ProofOptions); }
    }
    [HttpPost("cancel")]
    public async Task<IActionResult> Cancel(WhatsAppCancelRequest request, CancellationToken ct)
    {
        try { await installation.CancelAsync(request.State, Request.Cookies[ProofCookie], ct); return NoContent(); }
        finally { Response.Cookies.Delete(ProofCookie, ProofOptions); }
    }
    public record WhatsAppCancelRequest(string State);
    [HttpGet("status")]
    public async Task<IActionResult> Status(CancellationToken ct) { Response.Headers.CacheControl = "no-store"; return Ok(await service.StatusAsync(ct)); }
    [HttpGet("receipts")]
    public async Task<IActionResult> Receipts(CancellationToken ct) { Response.Headers.CacheControl = "no-store"; return Ok(await service.ReceiptsAsync(ct)); }
    [HttpPost("disconnect")]
    public async Task<IActionResult> Disconnect(CancellationToken ct) { await service.DisconnectAsync(ct); return NoContent(); }
}

[Route("api/v1/integrations/whatsapp/webhook"), AllowAnonymous]
public class WhatsAppWebhookController(WhatsAppGatewayService service) : ApiControllerBase
{
    [HttpGet]
    public IActionResult Verify([FromQuery(Name = "hub.mode")] string? mode,
        [FromQuery(Name = "hub.verify_token")] string? token, [FromQuery(Name = "hub.challenge")] string? challenge) =>
        Content(service.VerifyChallenge(mode, token, challenge), "text/plain");
    [HttpPost, RequestSizeLimit(64 * 1024)]
    public async Task<IActionResult> Receive(CancellationToken ct)
    {
        if (Request.ContentLength > 64 * 1024) throw new ValidationException("body", "WhatsApp payload is too large.");
        using var stream = new MemoryStream();
        var buffer = new byte[8192];
        int read;
        while ((read = await Request.Body.ReadAsync(buffer, ct)) > 0)
        {
            if (stream.Length + read > 64 * 1024) throw new ValidationException("body", "WhatsApp payload is too large.");
            stream.Write(buffer, 0, read);
        }
        await service.ReceiveAsync(stream.ToArray(), Request.Headers["X-Hub-Signature-256"].ToString(), ct);
        return Ok(new { received = true });
    }
}