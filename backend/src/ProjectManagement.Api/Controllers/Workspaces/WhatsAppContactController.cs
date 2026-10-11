using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Integrations;
namespace ProjectManagement.Api.Controllers.Workspaces;
[Route("api/v1/me/whatsapp-contact"), RequireWorkspace, ResponseCache(NoStore=true, Location=ResponseCacheLocation.None)]
public class WhatsAppContactController(WhatsAppContactService service) : ApiControllerBase
{
    [HttpGet] public async Task<IActionResult> Status(CancellationToken ct) => Ok(await service.StatusAsync(ct));
    [HttpPost, RequestSizeLimit(1024)] public async Task<IActionResult> Start(StartWhatsAppContact request, CancellationToken ct) => Ok(await service.StartAsync(request, ct));
    [HttpDelete] public async Task<IActionResult> Unlink(CancellationToken ct) { await service.UnlinkAsync(ct); return NoContent(); }
}
