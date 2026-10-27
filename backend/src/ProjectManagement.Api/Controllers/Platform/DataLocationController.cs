using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Platform;

namespace ProjectManagement.Api.Controllers.Platform;

/// <summary>Settings › Security › Data location: where data and backups are kept (region only) and the "Keep data in India" choice. See <see cref="DataLocationService"/>.</summary>
[Route("api/v1/settings/data-location"), RequireWorkspace]
public class DataLocationController(DataLocationService location) : ApiControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken ct) => Ok(await location.GetAsync(ct));

    [HttpPut]
    public async Task<IActionResult> Set([FromBody] SetDataLocationRequest req, CancellationToken ct) => Ok(await location.SetAsync(req, ct));
}
