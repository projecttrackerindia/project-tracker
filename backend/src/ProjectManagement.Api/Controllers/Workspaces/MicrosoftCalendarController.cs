using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Integrations;
namespace ProjectManagement.Api.Controllers.Workspaces;
[Route("api/v1/me/microsoft-calendars"),RequireWorkspace,ResponseCache(NoStore=true,Location=ResponseCacheLocation.None)]
public class MicrosoftCalendarController(MicrosoftCalendarReadService service):ApiControllerBase
{
    [HttpGet]public async Task<IActionResult> List(CancellationToken ct)=>Ok(await service.ListAsync(ct));
    [HttpPost("availability"),ExternalOperation]public async Task<IActionResult> Availability(CalendarReadWindow req,CancellationToken ct)=>Ok(await service.AvailabilityAsync(req,ct));
}
