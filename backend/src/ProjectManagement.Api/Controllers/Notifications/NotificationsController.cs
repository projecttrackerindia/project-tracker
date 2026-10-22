using System.Text;
using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Insights;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Notifications;

[Route("api/v1/notifications")]
public class NotificationsController(NotificationService notifications) : ApiControllerBase
{
    [HttpGet]
    public async Task<IActionResult> List([FromQuery] bool unreadOnly = false, [FromQuery] int page = 1, [FromQuery] int pageSize = 25, [FromQuery] string? lane = null,
        [FromQuery] bool archived = false, CancellationToken ct = default) =>
        Ok(await notifications.ListAsync(unreadOnly, page, pageSize, ct, lane, archived));

    /// <summary>Unread overall and in each lane (needs you, for your information).</summary>
    [HttpGet("counts")]
    public async Task<IActionResult> Counts(CancellationToken ct) => Ok(await notifications.CountsAsync(ct));

    [HttpPost("{id:guid}/archive")]
    public async Task<IActionResult> Archive(Guid id, CancellationToken ct) { await notifications.SetArchivedAsync(id, true, ct); return NoContent(); }

    [HttpPost("{id:guid}/unarchive")]
    public async Task<IActionResult> Unarchive(Guid id, CancellationToken ct) { await notifications.SetArchivedAsync(id, false, ct); return NoContent(); }

    /// <summary>Archives everything already read.</summary>
    [HttpPost("archive-read")]
    public async Task<IActionResult> ArchiveRead(CancellationToken ct) => Ok(new { archived = await notifications.ArchiveReadAsync(ct) });

    [HttpGet("unread-count")]
    public async Task<IActionResult> UnreadCount(CancellationToken ct) => Ok(await notifications.UnreadCountAsync(ct));

    [HttpPost("{id:guid}/read")]
    public async Task<IActionResult> MarkRead(Guid id, CancellationToken ct)
    {
        await notifications.MarkReadAsync(id, ct);
        return NoContent();
    }

    [HttpPost("read-all")]
    public async Task<IActionResult> MarkAllRead(CancellationToken ct)
    {
        await notifications.MarkAllReadAsync(ct);
        return NoContent();
    }
}
