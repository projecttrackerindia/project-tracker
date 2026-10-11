using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Integrations;
namespace ProjectManagement.Api.Controllers.Workspaces;
[Route("api/v1/me/whatsapp-contact"), RequireWorkspace, ResponseCache(NoStore=true, Location=ResponseCacheLocation.None)]
public class WhatsAppContactController(WhatsAppContactService service,WhatsAppDeliveryService delivery) : ApiControllerBase
{
    [HttpGet] public async Task<IActionResult> Status(CancellationToken ct) => Ok(await service.StatusAsync(ct));
    [HttpPost, RequestSizeLimit(1024)] public async Task<IActionResult> Start(StartWhatsAppContact request, CancellationToken ct) => Ok(await service.StartAsync(request, ct));
    [HttpGet("notification-preferences")] public async Task<IActionResult> Notifications(CancellationToken ct) => Ok(await service.NotificationPreferencesAsync(ct));
    [HttpPut("notification-preferences"), RequestSizeLimit(2048)] public async Task<IActionResult> Notifications(UpdateWhatsAppNotifications request, CancellationToken ct) => Ok(await service.UpdateNotificationsAsync(request, ct));
    [HttpGet("deliveries")] public async Task<IActionResult> Deliveries(CancellationToken ct) => Ok(await delivery.ListAsync(false,ct));
    [HttpDelete] public async Task<IActionResult> Unlink(CancellationToken ct) { await service.UnlinkAsync(ct); return NoContent(); }
}
