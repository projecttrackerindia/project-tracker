using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Api.Controllers.Platform;

/// <summary>
/// What our own apps report about themselves: unexpected errors (relayed to the Sentry-compatible service, scrubbed, off without a
/// DSN) and real-user speed (Core Web Vitals per page pattern and device class, kept per workspace). See docs/ops.md.
/// </summary>
[Route("api/v1/telemetry")]
public class TelemetryController(ErrorReporter errors, WebVitalsStore vitals, ICurrentContext ctx) : ApiControllerBase
{
    /// <summary>Whether the apps should report errors at all, and the server's release (for the app to tag its own).</summary>
    [HttpGet("config"), AllowAnonymous]
    public IActionResult Config() => Ok(new { errors = errors.Enabled, release = errors.Release, vitals = true });

    /// <summary>One error from an app. Works signed out too (sign-in page errors); rate limited globally and per address.</summary>
    [HttpPost("errors"), AllowAnonymous]
    public IActionResult Error([FromBody] ClientErrorReport report)
    {
        if (string.IsNullOrWhiteSpace(report.Message) && string.IsNullOrWhiteSpace(report.Type))
            throw new ValidationException("message", "Say what went wrong.");
        var id = errors.CaptureClient(report);
        return Accepted(new { reported = id is not null });
    }

    /// <summary>A batch of speed measurements from a signed-in person's browser or app, stored under their current workspace only.</summary>
    [HttpPost("vitals")]
    public IActionResult Vitals([FromBody] WebVitalsBeacon beacon)
    {
        var tenant = ctx.RequireTenantId();
        return Accepted(new { kept = vitals.Record(tenant, beacon) });
    }

    /// <summary>
    /// The 75th percentile per page and device. A workspace owner or admin sees their own workspace; a platform administrator may
    /// ask for every workspace together (<c>all=true</c>), which shows page patterns only, never which workspace.
    /// </summary>
    [HttpGet("vitals")]
    public IActionResult Report([FromQuery] int days = 7, [FromQuery] bool all = false)
    {
        if (all)
        {
            if (!ctx.IsPlatformAdmin) throw new ForbiddenException();
            return Ok(vitals.Report(null, days));
        }
        var tenant = ctx.RequireTenantId();
        if (ctx.Role is not (TenantRole.Admin or TenantRole.Owner)) throw new ForbiddenException();
        return Ok(vitals.Report(tenant, days));
    }
}
