using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Vault;

namespace ProjectManagement.Api.Controllers.Vault;

/// <summary>
/// Opening a self-destructing link from the vault, without signing in. Describing it does not use it up (link previews in chat apps fetch
/// pages); opening does, and the last allowed opening destroys it. The key is in the link's #fragment and never reaches this server.
/// </summary>
[Route("api/v1/secret-links"), AllowAnonymous, SecretResponse, EnableRateLimiting("auth")]
public class SecretLinksController(SecretLinkPublic links) : ApiControllerBase
{
    private void NoStore()
    {
        Response.Headers.CacheControl = "no-store, max-age=0";
        Response.Headers.Pragma = "no-cache";
        Response.Headers["Referrer-Policy"] = "no-referrer";
        Response.Headers["X-Robots-Tag"] = "noindex, nofollow";
    }

    [HttpGet("{token}")]
    public async Task<IActionResult> Info(string token, CancellationToken ct) { NoStore(); return Ok(await links.InfoAsync(token, ct)); }

    [HttpPost("{token}/open")]
    public async Task<IActionResult> Open(string token, CancellationToken ct) { NoStore(); return Ok(await links.OpenAsync(token, ct)); }
}
