using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Integrations;
namespace ProjectManagement.Api.Controllers.Workspaces;
[Route("api/v1/me/calendar-proposals"),RequireWorkspace,ResponseCache(NoStore=true,Location=ResponseCacheLocation.None)]
public class PersonalCalendarController(PersonalCalendarService service):ApiControllerBase
{
    [HttpGet("options")]public async Task<IActionResult> Options(CancellationToken ct)=>Ok(await service.OptionsAsync(ct));
    [HttpGet]public async Task<IActionResult> List(CancellationToken ct)=>Ok(await service.ListAsync(ct));
    [HttpGet("{id:guid}")]public async Task<IActionResult> Get(Guid id,CancellationToken ct)=>Ok(await service.GetAsync(id,ct));
    [HttpPost]public async Task<IActionResult> Save(SaveCalendarProposal req,CancellationToken ct)=>Ok(await service.SaveAsync(req,ct));
    [HttpGet("{id:guid}/availability")]public async Task<IActionResult> Availability(Guid id,[FromQuery]int version,CancellationToken ct)=>Ok(await service.AvailabilityAsync(id,version,ct));
    [HttpPost("{id:guid}/confirm"),ExternalOperation]public async Task<IActionResult> Confirm(Guid id,ConfirmCalendarProposal req,CancellationToken ct)=>Ok(await service.ConfirmAsync(id,req,ct));
    [HttpPost("{id:guid}/reconcile"),ExternalOperation]public async Task<IActionResult> Reconcile(Guid id,CancellationToken ct)=>Ok(await service.ReconcileAsync(id,ct));
    [HttpDelete("{id:guid}")]public async Task<IActionResult> Delete(Guid id,CancellationToken ct){await service.DeleteAsync(id,ct);return NoContent();}
}
