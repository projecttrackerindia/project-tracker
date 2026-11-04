using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Approvals;
using ProjectManagement.Application.Features.Chat;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Reminders;

namespace ProjectManagement.Api.Controllers.Shell;

/// <summary>
/// Everything the app's frame shows as numbers, in one call (the bell and tab badges, the Approvals count, chat unread, reminders): a phone
/// on a slow network makes one round trip at start instead of one per badge. Each part is the same answer as its own endpoint
/// (/notifications/counts, /approvals/counts, /chat/unread, /reminders/counts), for the signed-in person in the current workspace only;
/// a part this person may not read is null and the app falls back to that endpoint.
/// </summary>
[Route("api/v1/shell"), RequireWorkspace]
public class ShellController(ICurrentContext ctx, NotificationService notifications, ApprovalService approvals, ChatService chat, ReminderService reminders,
    ILogger<ShellController> log) : ApiControllerBase
{
    [HttpGet("summary")]
    public async Task<IActionResult> Summary(CancellationToken ct)
    {
        var workspaceId = ctx.RequireTenantId();
        // One after another: they share this request's database context.
        var counts = await Part(() => notifications.CountsAsync(ct), "notification counts");
        var needsMe = await Part(async () => (int?)await approvals.NeedsMeCountAsync(ct), "approval counts");
        var unread = await Part(() => chat.UnreadAsync(ct), "chat unread");
        var reminderCounts = await Part(() => reminders.CountsAsync(ct), "reminder counts");
        return Ok(new
        {
            workspaceId, notifications = counts, approvals = needsMe is null ? null : new { needsMe }, chatUnread = unread, reminders = reminderCounts,
        });
    }

    private async Task<T?> Part<T>(Func<Task<T>> read, string what)
    {
        try { return await read(); }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            log.LogDebug(ex, "Shell summary: {Part} not available", what);
            return default;
        }
    }
}
