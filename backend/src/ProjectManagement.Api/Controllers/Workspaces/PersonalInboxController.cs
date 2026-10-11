using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Integrations;
namespace ProjectManagement.Api.Controllers.Workspaces;
[Route("api/v1/me/inbox"),RequireWorkspace,ResponseCache(NoStore=true,Location=ResponseCacheLocation.None)]
public class PersonalInboxController(PersonalInboxService service):ApiControllerBase
{
    [HttpGet] public async Task<IActionResult> List([FromQuery]string provider,[FromQuery]string? cursor,CancellationToken ct)=>Ok(await service.ListAsync(provider,cursor,ct));
    [HttpGet("thread")] public async Task<IActionResult> Thread([FromQuery]string provider,[FromQuery]string messageId,CancellationToken ct)=>Ok(await service.ThreadAsync(provider,messageId,ct));
}
