using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Platform;

namespace ProjectManagement.Api.Controllers.Platform;

/// <summary>The workspace's public API status page: which APIs it shows, its address and whether it is published. Owners and admins only.</summary>
[Route("api/v1/status-page"), RequireWorkspace]
public class StatusPageController(StatusPageService pages) : ApiControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken ct) => Ok(await pages.GetSettingsAsync(ct));

    [HttpPut]
    public async Task<IActionResult> Save([FromBody] SaveStatusPageRequest req, CancellationToken ct) => Ok(await pages.SaveAsync(req, ct));
}
