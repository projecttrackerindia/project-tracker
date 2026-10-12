using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Integrations;
namespace ProjectManagement.Api.Controllers.Workspaces;
[Route("api/v1/me/inbox/summaries"),RequireWorkspace,ResponseCache(NoStore=true,Location=ResponseCacheLocation.None)]
public class PersonalInboxSummaryController(PersonalInboxSummaryService service):ApiControllerBase
{
    [HttpGet("options")] public async Task<IActionResult> Options(CancellationToken ct)=>Ok(await service.OptionsAsync(ct));
    [HttpGet] public async Task<IActionResult> List(CancellationToken ct)=>Ok(await service.ListAsync(ct));
    [HttpGet("{operation:guid}")] public async Task<IActionResult> Get(Guid operation,CancellationToken ct)=>Ok(await service.GetAsync(operation,ct));
    [HttpPost,AiRequestLimit] public async Task<IActionResult> Summarize([FromBody]SummarizeInboxRequest req,CancellationToken ct)=>Ok(await service.SummarizeAsync(req,ct));
    [HttpDelete("{operation:guid}")] public async Task<IActionResult> Delete(Guid operation,CancellationToken ct){await service.DeleteAsync(operation,ct);return NoContent();}
}
