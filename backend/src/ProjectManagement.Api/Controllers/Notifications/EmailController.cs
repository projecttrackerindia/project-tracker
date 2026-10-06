using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using ProjectManagement.Application.Features.Notifications;

namespace ProjectManagement.Api.Controllers.Notifications;

/// <summary>The two things the outside world does to our e-mail: a person clicks "stop emails like this", and the mail provider tells us an address bounced.</summary>
[Route("api/v1/email")]
public class EmailController(UnsubscribeService unsubscribe, EmailAdminService admin, IConfiguration config, TimeProvider clock, ILogger<EmailController> log) : ApiControllerBase
{
    /// <summary>What the link is about (so the page can say "Stop Mentions emails?"). Nothing changes until the person confirms.</summary>
    [HttpGet("unsubscribe"), AllowAnonymous, EnableRateLimiting("auth")]
    public async Task<IActionResult> Info([FromQuery] string? token, CancellationToken ct) => Ok(await unsubscribe.InfoAsync(token, ct));

    /// <summary>The button on the page, and the one-click request mail programs send for the List-Unsubscribe header (RFC 8058: a POST with the token in the address).</summary>
    [HttpPost("unsubscribe"), AllowAnonymous, EnableRateLimiting("auth")]
    public async Task<IActionResult> Unsubscribe([FromQuery] string? token, CancellationToken ct) => Ok(await unsubscribe.UnsubscribeAsync(token, ct));

    /// <summary>Delivery events from Resend (signed with Svix). A permanent bounce or a spam complaint blocks the address; anything else is ignored.</summary>
    [HttpPost("webhooks/resend"), AllowAnonymous]
    public async Task<IActionResult> Resend(CancellationToken ct)
    {
        var secret = config["Email:Resend:WebhookSecret"];
        if (string.IsNullOrWhiteSpace(secret)) return NotFound();
        using var reader = new StreamReader(Request.Body);
        var body = await reader.ReadToEndAsync(ct);
        if (!SvixSignature.Verify(secret, Request.Headers["svix-id"], Request.Headers["svix-timestamp"], Request.Headers["svix-signature"], body, clock.GetUtcNow()))
            return Unauthorized();
        try
        {
            using var doc = JsonDocument.Parse(body);
            var type = doc.RootElement.GetProperty("type").GetString();
            if (type is not ("email.bounced" or "email.complained")) return NoContent();
            var data = doc.RootElement.GetProperty("data");
            // A temporary problem (a full mailbox) is not a reason to stop writing to someone.
            if (type == "email.bounced" && data.TryGetProperty("bounce", out var bounce) && bounce.TryGetProperty("type", out var bt) && bt.GetString() is { } kind && !kind.Contains("Permanent", StringComparison.OrdinalIgnoreCase)) return NoContent();
            var detail = type == "email.bounced" && data.TryGetProperty("bounce", out var b2) && b2.TryGetProperty("message", out var m) ? m.GetString() : null;
            if (data.TryGetProperty("to", out var to) && to.ValueKind == JsonValueKind.Array)
                foreach (var addr in to.EnumerateArray()) await admin.SuppressAsync(addr.GetString() ?? "", type == "email.bounced" ? "bounce" : "complaint", detail, ct);
        }
        catch (Exception ex) when (ex is JsonException or KeyNotFoundException or InvalidOperationException) { log.LogWarning(ex, "A delivery event could not be read"); }
        return NoContent();
    }
}
