using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Application.Features.Platform;

namespace ProjectManagement.Api.Controllers.Platform;

/// <summary>
/// A published status page, read without signing in (the web page /status/{slug} shows it). Components, their state, 90 days of bars and
/// recent incidents only; see <see cref="StatusPageService.PublicAsync"/> for what is never shown.
/// </summary>
[Route("api/v1/public/status"), AllowAnonymous]
public class PublicStatusController(StatusPageService pages) : ApiControllerBase
{
    [HttpGet("{slug}")]
    public async Task<IActionResult> Get(string slug, CancellationToken ct)
    {
        Response.Headers.CacheControl = "public, max-age=60";
        Response.Headers["X-Robots-Tag"] = "noindex";
        return Ok(await pages.PublicAsync(slug, ct));
    }
}
