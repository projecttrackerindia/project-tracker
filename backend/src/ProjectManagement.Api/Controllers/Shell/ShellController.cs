using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Application.Features.Approvals;
using ProjectManagement.Application.Features.Chat;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Platform;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Application.Features.Time;

namespace ProjectManagement.Api.Controllers.Shell;

/// <summary>
/// Everything the app's frame needs at start, in one call: the numbers it shows (the bell and tab badges, the Approvals count, chat unread,
/// reminders) and the few small answers every screen reads before it can draw (which features are on, whether the assistant may be used, a
/// running timer). A phone on a slow network makes one round trip instead of one per badge and per switch.
///
/// Each part is the same answer as its own endpoint (/notifications/counts, /approvals/counts, /chat/unread, /reminders/counts,
/// /feature-flags/mine, /ai/status, /timer), read through the same service with the same checks, for the signed-in person in the current
/// workspace only. A part this person may not read, or that failed, is null and the app falls back to that endpoint. A part that is
/// legitimately empty says so without being null: `timer` is an object whose `entry` is null when no timer is running.
/// </summary>
[Route("api/v1/shell"), RequireWorkspace]
public class ShellController(ICurrentContext ctx, NotificationService notifications, ApprovalService approvals, ChatService chat, ReminderService reminders,
    FeatureFlagService flags, AiAssistant assistant, TimeService time, ILogger<ShellController> log) : ApiControllerBase
{
    [HttpGet("summary"), HotRead]
    public async Task<IActionResult> Summary(CancellationToken ct)
    {
        var workspaceId = ctx.RequireTenantId();
        // One after another: they share this request's database context.
        var counts = await Part(() => notifications.CountsAsync(ct), "notification counts");
        var needsMe = await Part(async () => (int?)await approvals.NeedsMeCountAsync(ct), "approval counts");
        var unread = await Part(() => chat.UnreadAsync(ct), "chat unread");
        var reminderCounts = await Part(() => reminders.CountsAsync(ct), "reminder counts");
        var mineFlags = await Part(() => flags.MineAsync(ct), "feature flags");
        var ai = await Part(() => assistant.StatusAsync(ct), "assistant status");
        // A stopped timer is an answer, not a missing part: the object is there and its entry is null, so the app does not read /timer again.
        var timer = await Part(async () => new TimerPart(await time.GetRunningAsync(ct)), "running timer");
        return Ok(new
        {
            workspaceId, notifications = counts, approvals = needsMe is null ? null : new { needsMe }, chatUnread = unread, reminders = reminderCounts,
            featureFlags = mineFlags is null ? null : new { flags = mineFlags }, aiStatus = ai, timer,
        });
    }

    private sealed record TimerPart(object? Entry);

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
