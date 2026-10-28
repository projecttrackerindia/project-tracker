using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Platform;

namespace ProjectManagement.Api.Controllers.Platform;

/// <summary>Public holidays of the workspace, counted as days off in Capacity. Owners and admins keep the list. See <see cref="HolidayService"/>.</summary>
[Route("api/v1/holidays"), RequireWorkspace]
public class HolidaysController(HolidayService holidays) : ApiControllerBase
{
    [HttpGet]
    public async Task<IActionResult> List([FromQuery] int? year, CancellationToken ct) => Ok(await holidays.ListAsync(year, ct));

    [HttpPost]
    public async Task<IActionResult> Add([FromBody] AddHolidayRequest req, CancellationToken ct) => Created(await holidays.AddAsync(req, ct));

    /// <summary>Adds a country's list for a year (India: IN); holidays already on the list are kept as they are.</summary>
    [HttpPost("preset")]
    public async Task<IActionResult> Preset([FromBody] HolidayPresetRequest req, CancellationToken ct) => Ok(await holidays.AddPresetAsync(req, ct));

    [HttpDelete("{id:guid}")]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
    {
        await holidays.DeleteAsync(id, ct);
        return NoContent();
    }
}
