using System.Text;
using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Insights;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Notifications;

[Route("api/v1/notifications")]
public class NotificationsController(NotificationService notifications, NotificationActionService actions) : ApiControllerBase
{
    [HttpGet]
    public async Task<IActionResult> List([FromQuery] bool unreadOnly = false, [FromQuery] int page = 1, [FromQuery] int pageSize = 25, [FromQuery] string? lane = null,
        [FromQuery] bool archived = false, [FromQuery] string? category = null, CancellationToken ct = default) =>
        Ok(await actions.DecorateAsync(await notifications.ListAsync(unreadOnly, page, pageSize, ct, lane, archived, category), ct));

    /// <summary>Back to unread.</summary>
    [HttpPost("{id:guid}/unread")]
    public async Task<IActionResult> MarkUnread(Guid id, CancellationToken ct) { await notifications.MarkUnreadAsync(id, ct); return NoContent(); }

    /// <summary>Deletes it from this person's Notification Centre (a soft delete: put away, never removed for anyone else).</summary>
    [HttpDelete("{id:guid}")]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct) { await notifications.SetArchivedAsync(id, true, ct); return NoContent(); }

    /// <summary>Clears a stacked group (ids), a category, or everything.</summary>
    [HttpPost("clear")]
    public async Task<IActionResult> Clear([FromBody] NotificationClearRequest req, CancellationToken ct) => Ok(new { cleared = await notifications.ClearAsync(req, ct) });

    /// <summary>Hides it until the given time; then it is back on top, unread, and pushed again. Null brings it back now.</summary>
    [HttpPost("{id:guid}/snooze")]
    public async Task<IActionResult> Snooze(Guid id, [FromBody] NotificationSnoozeRequest req, CancellationToken ct) { await notifications.SnoozeAsync(id, req.Until, ct); return NoContent(); }

    /// <summary>Does what the notification asks without opening it: done, take, reply, approve, reject (send back) or snooze.</summary>
    [HttpPost("{id:guid}/act")]
    public async Task<IActionResult> Act(Guid id, [FromBody] NotificationActRequest req, CancellationToken ct) => Ok(await actions.ActAsync(id, req, ct));

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
    public async Task<IActionResult> MarkAllRead([FromQuery] string? category, CancellationToken ct)
    {
        await notifications.MarkAllReadAsync(ct, category);
        return NoContent();
    }
}
