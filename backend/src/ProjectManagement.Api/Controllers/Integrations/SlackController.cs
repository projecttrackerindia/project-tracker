using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Integrations;

namespace ProjectManagement.Api.Controllers.Integrations;

[Route("api/v1/integrations/slack"), RequireWorkspace]
public class SlackController(SlackConnectionService service) : ApiControllerBase
{
    public const string ProofCookie = "__Secure-pt-slack-install";
    [HttpGet("status")]
    public async Task<IActionResult> Status(CancellationToken ct) => Ok(await service.StatusAsync(ct));
    [HttpPost("connect")]
    public async Task<IActionResult> Connect(CancellationToken ct)
    {
        var start = await service.StartAsync(ct);
        Response.Cookies.Append(ProofCookie, start.BrowserProof, new CookieOptions { HttpOnly = true, Secure = true, SameSite = SameSiteMode.Lax,
            Path = "/api/v1/integrations/slack/callback", MaxAge = TimeSpan.FromMinutes(10) });
        return Ok(new { start.Url });
    }
    [HttpPost("disconnect")]
    public async Task<IActionResult> Disconnect(CancellationToken ct) { await service.DisconnectAsync(ct); return NoContent(); }
}

[Route("api/v1/integrations/slack"), AllowAnonymous]
public class SlackInboundController(SlackConnectionService service) : ApiControllerBase
{
    [HttpGet("callback")]
    public async Task<IActionResult> Callback(string? state, string? code, string? error, CancellationToken ct)
    {
        var proof = Request.Cookies[SlackController.ProofCookie];
        Response.Cookies.Delete(SlackController.ProofCookie, new CookieOptions { HttpOnly = true, Secure = true, SameSite = SameSiteMode.Lax, Path = "/api/v1/integrations/slack/callback" });
        return Redirect(await service.CompleteAsync(state, proof, code, error, ct));
    }

    [HttpPost("events"), RequestSizeLimit(64 * 1024)]
    public async Task<IActionResult> Events(CancellationToken ct)
    {
        using var stream = new MemoryStream(); await Request.Body.CopyToAsync(stream, ct);
        if (stream.Length > 64 * 1024) throw new ValidationException("body", "Slack payload is too large.");
        if (!service.VerifySignature(Request.Headers["X-Slack-Request-Timestamp"].ToString(), Request.Headers["X-Slack-Signature"].ToString(), stream.GetBuffer().AsSpan(0, (int)stream.Length)))
            throw new UnauthorizedException("Slack signature is invalid.", "SLACK_SIGNATURE_INVALID");
        using var json = JsonDocument.Parse(stream.ToArray()); var root = json.RootElement;
        var type = root.GetProperty("type").GetString();
        if (type == "url_verification") return new JsonResult(new { challenge = root.GetProperty("challenge").GetString() });
        if (type == "event_callback" && root.TryGetProperty("event", out var ev))
        {
            // Only lifecycle events are supported until account linking and the durable delivery gateway are shipped.
            var eventType = ev.GetProperty("type").GetString();
            if (eventType == "app_uninstalled")
                await service.RevokeFromEventAsync(root.GetProperty("api_app_id").GetString() ?? "", root.GetProperty("team_id").GetString() ?? "", root.GetProperty("event_id").GetString() ?? "", root.GetProperty("event_time").GetInt64(), null, ct);
            if (eventType == "tokens_revoked" && ev.TryGetProperty("tokens", out var tokens) && tokens.TryGetProperty("bot", out var bot))
                await service.RevokeFromEventAsync(root.GetProperty("api_app_id").GetString() ?? "", root.GetProperty("team_id").GetString() ?? "", root.GetProperty("event_id").GetString() ?? "", root.GetProperty("event_time").GetInt64(), bot.EnumerateArray().Select(x => x.GetString() ?? "").ToArray(), ct);
        }
        return new JsonResult(new { ok = true });
    }
}
