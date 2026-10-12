using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Integrations;
namespace ProjectManagement.Api.Controllers.Workspaces;
[Route("api/v1/me/email-drafts"),RequireWorkspace,ResponseCache(NoStore=true,Location=ResponseCacheLocation.None)]
public class PersonalEmailController(PersonalEmailService service):ApiControllerBase
{
    [HttpGet("options")] public async Task<IActionResult> Options(CancellationToken ct)=>Ok(await service.AiOptionsAsync(ct));
    [HttpPost("{id:guid}/improve"),AiRequestLimit] public async Task<IActionResult> Improve(Guid id,[FromBody]EmailAiRequest req,CancellationToken ct)=>Ok(await service.ImproveAsync(id,req,ct));
    [HttpGet] public async Task<IActionResult> List(CancellationToken ct)=>Ok(await service.ListAsync(ct));
    [HttpGet("{id:guid}")] public async Task<IActionResult> Get(Guid id,CancellationToken ct)=>Ok(await service.GetAsync(id,ct));
    [HttpPost] public async Task<IActionResult> Create([FromBody]SavePersonalEmailRequest req,CancellationToken ct)=>Created(await service.SaveAsync(null,req,ct));
    [HttpPut("{id:guid}")] public async Task<IActionResult> Save(Guid id,[FromBody]SavePersonalEmailRequest req,CancellationToken ct)=>Ok(await service.SaveAsync(id,req,ct));
    [HttpDelete("{id:guid}")] public async Task<IActionResult> Delete(Guid id,CancellationToken ct){await service.DeleteAsync(id,ct);return NoContent();}
    [HttpPost("{id:guid}/send"),ExternalOperation] public async Task<IActionResult> Send(Guid id,[FromBody]SendPersonalEmailRequest req,CancellationToken ct)=>Ok(await service.SendAsync(id,req,ct));
}
