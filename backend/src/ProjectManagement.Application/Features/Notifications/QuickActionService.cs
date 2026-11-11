using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Notifications;

/// <param name="Action">One of the keys <see cref="QuickActions.For"/> offers (approve, reject, reply, read, done, snooze, accept, decline, maybe, late, open...).</param>
/// <param name="Text">The reply, or the reason when rejecting.</param>
/// <param name="Preset">Snooze length: 1h (default), 3h or tomorrow.</param>
public record QuickActionRequest(string Action, string? Text = null, string? Preset = null);
/// <param name="Open">Where the app should open (join, review, discuss, call back), if anywhere.</param>
/// <param name="AlreadyDone">This key was used before: nothing was done twice.</param>
public record QuickActionResultDto(string Message, bool AlreadyDone, string? Open);
public record QuickActionTokenDto(string Token, IReadOnlyList<string> Actions, DateTime ExpiresAt);

/// <summary>
/// Which buttons a notification carries outside the app (Web Push, the desktop app, the phone apps) and in its in-app banner. Only notices that
/// ask the person for something get buttons; the rest stay quiet and simply open. Worked out from the notice alone (no database read), so the
/// push worker can add them cheaply; whether the action is still possible is checked again when it is used.
/// </summary>
public static class QuickActions
{
    private static readonly Regex StartsIn = new(@"^Starts in \d{1,3} minutes?", RegexOptions.Compiled);
    private static readonly Regex Task = new(@"^/projects/[0-9a-fA-F-]{36}\?task=[0-9a-fA-F-]{36}", RegexOptions.Compiled);
    /// <summary>Aura's slip-and-fix card: /projects/{id}?fix={messageId}.{actionId} (see SlipFixOwnerRun).</summary>
    public static readonly Regex SlipFix = new(@"^/projects/[0-9a-fA-F-]{36}\?fix=(?<m>[0-9a-fA-F-]{36})\.(?<a>[0-9a-fA-F]{8})$", RegexOptions.Compiled);
    private static readonly Regex Chat = new(@"^/(chat/[0-9a-fA-F-]{36}$|projects/[0-9a-fA-F-]{36}\?chat=1$)", RegexOptions.Compiled);

    public static IReadOnlyList<string> For(NotificationType type, string? link, string? title)
    {
        link ??= ""; title ??= "";
        // Reminders with their own one-time key keep the Done / Snooze they always had (reminder-actions).
        if (link.StartsWith("/r/", StringComparison.Ordinal)) return [];
        if (title.Contains(" extended", StringComparison.OrdinalIgnoreCase) || title.StartsWith("Date extension", StringComparison.OrdinalIgnoreCase)) return ["accept", "discuss"];
        if (type == NotificationType.Overdue && SlipFix.IsMatch(link)) return ["confirm", "open"];
        switch (type)
        {
            case NotificationType.Approval when link.StartsWith("/approvals?open=", StringComparison.Ordinal) && !IsOutcome(title):
            case NotificationType.Document when link.StartsWith("/documents/", StringComparison.Ordinal) && !IsOutcome(title):
                return ["approve", "reject"];
            case NotificationType.TimesheetReminder when link.StartsWith("/timesheet/approvals", StringComparison.Ordinal):
                return ["approve", "reject"];
            case NotificationType.Message or NotificationType.Mention when Chat.IsMatch(link):
                return ["reply", "read"];
            case NotificationType.Mention or NotificationType.Comment when Task.IsMatch(link):
                return ["reply", "read"];
            case NotificationType.TaskAssigned or NotificationType.DueSoon or NotificationType.Overdue or NotificationType.Nudge when Task.IsMatch(link):
                return ["done", "snooze", "open"];
            case NotificationType.Reminder when StartsIn.IsMatch(title):
                return ["join", "late"];
            case NotificationType.Reminder:
                return ["done", "snooze"];
            case NotificationType.Meeting when title.Contains("invited you", StringComparison.Ordinal) || title.StartsWith("You were invited", StringComparison.Ordinal):
                return ["accept", "decline", "maybe"];
            case NotificationType.Meeting when title.StartsWith("Minutes", StringComparison.Ordinal) || title.Contains("action item", StringComparison.OrdinalIgnoreCase):
                return ["review"];
            case NotificationType.Call when title.StartsWith("Missed call", StringComparison.OrdinalIgnoreCase):
                return ["callback", "message"];
            case NotificationType.Call:
                return ["answer", "decline", "message"];
        }
        return [];
    }

    private static bool IsOutcome(string title) => title.StartsWith("Approved", StringComparison.Ordinal) || title.StartsWith("Rejected", StringComparison.Ordinal)
        || title.StartsWith("Expired", StringComparison.Ordinal) || title.StartsWith("Sent back", StringComparison.Ordinal);
}

/// <summary>
/// Acting on a notification from outside the app with a signed, short-lived, single-use key instead of a sign-in. The key names the notification,
/// the person and the workspace; the API's context middleware signs the request in as that person in that workspace (with every membership,
/// suspension and IP rule applied, see CurrentContextMiddleware), so the action then runs through the same services and permission checks as the
/// app. Every use is audited (that audit row is also what makes a key single-use) and a repeat of the same key does nothing twice.
/// </summary>
public class QuickActionService(IAppDbContext db, ICurrentContext ctx, AppClock clock, ITokenService tokens, Recorder recorder,
    NotificationActionService actions, NotificationService notifications, ProjectManagement.Application.Features.ProjectMeetings.MeetingService meetings,
    ProjectManagement.Application.Features.Approvals.ApprovalService approvals, ProjectManagement.Application.Features.Ai.AiAgent aura)
{
    public const string Purpose = "notification-action";
    public const string AuditAction = "notification.quick_action";
    public static readonly TimeSpan Lifetime = TimeSpan.FromHours(24);

    public record Claim(Guid NotificationId, Guid UserId, Guid TenantId, Guid KeyId);

    public static string Issue(ITokenService tokens, Guid notificationId, Guid userId, Guid tenantId) =>
        tokens.Seal(Purpose, $"{notificationId:N}.{userId:N}.{tenantId:N}.{Guid.NewGuid():N}", Lifetime);

    public static Claim? Read(ITokenService tokens, string? token)
    {
        if (string.IsNullOrWhiteSpace(token)) return null;
        var parts = tokens.Unseal(Purpose, token.Trim())?.Split('.');
        if (parts is not { Length: 4 }) return null;
        return Guid.TryParseExact(parts[0], "N", out var n) && Guid.TryParseExact(parts[1], "N", out var u) && Guid.TryParseExact(parts[2], "N", out var t) && Guid.TryParseExact(parts[3], "N", out var k)
            ? new Claim(n, u, t, k) : null;
    }

    /// <summary>A key for one of the caller's own notifications (the desktop and phone apps ask for one when they show a notice natively).</summary>
    public async Task<QuickActionTokenDto> IssueAsync(Guid notificationId, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId(); var tid = ctx.RequireTenantId();
        var n = await db.Notifications.AsNoTracking().Where(x => x.Id == notificationId && x.UserId == me).Select(x => new { x.Type, x.Link, x.Title }).FirstOrDefaultAsync(ct)
            ?? throw new NotFoundException("Notification not found.");
        return new(Issue(tokens, notificationId, me, tid), QuickActions.For(n.Type, n.Link, n.Title), clock.Now.Add(Lifetime));
    }

    public async Task<QuickActionResultDto> RedeemAsync(string token, QuickActionRequest req, CancellationToken ct = default)
    {
        var claim = Read(tokens, token) ?? throw new UnauthorizedException("This action has expired. Open the app to finish it.", "QUICK_ACTION_EXPIRED");
        // The middleware signed the request in from this very key; anything else (no membership any more, suspended, blocked by the
        // workspace's IP rules) means the app must be opened and signed in to.
        if (ctx.UserId != claim.UserId || ctx.TenantId != claim.TenantId)
            throw new ForbiddenException("Open the app to finish this.", "QUICK_ACTION_REAUTH");
        var action = (req.Action ?? "").Trim().ToLowerInvariant();

        var used = await db.AuditLogs.AsNoTracking().Where(a => a.Action == AuditAction && a.EntityId == claim.KeyId && a.TenantId == claim.TenantId)
            .Select(a => a.NewValue).FirstOrDefaultAsync(ct);
        if (used is not null) return new("Already done.", true, null);

        var n = await db.Notifications.AsNoTracking().FirstOrDefaultAsync(x => x.Id == claim.NotificationId && x.UserId == claim.UserId, ct)
            ?? throw new NotFoundException("This notification is gone.");
        var offered = QuickActions.For(n.Type, n.Link, n.Title);
        if (!offered.Contains(action) && action != "read") throw new ValidationException("action", "That cannot be done from this notification. Open it instead.");

        var result = await ActAsync(n, action, req, ct);
        recorder.Audit(AuditAction, "QuickActionKey", claim.KeyId, newValue: new { action, notification = n.Id, type = n.Type.ToString() });
        await db.SaveChangesAsync(ct);
        return result;
    }

    /// <summary>The same actions from inside the app (an in-app banner), for a signed-in person: no key needed, the same checks and audit.</summary>
    public async Task<QuickActionResultDto> ActForMeAsync(Guid notificationId, QuickActionRequest req, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId(); ctx.RequireTenantId();
        var n = await db.Notifications.AsNoTracking().FirstOrDefaultAsync(x => x.Id == notificationId && x.UserId == me, ct) ?? throw new NotFoundException("Notification not found.");
        var action = (req.Action ?? "").Trim().ToLowerInvariant();
        if (!QuickActions.For(n.Type, n.Link, n.Title).Contains(action) && action != "read") throw new ValidationException("action", "That cannot be done from this notification. Open it instead.");
        var result = await ActAsync(n, action, req, ct);
        recorder.Audit(AuditAction, "Notification", n.Id, newValue: new { action, type = n.Type.ToString(), via = "app" });
        await db.SaveChangesAsync(ct);
        return result;
    }

    private async Task<QuickActionResultDto> ActAsync(Notification n, string action, QuickActionRequest req, CancellationToken ct)
    {
        var text = req.Text?.Trim();
        switch (action)
        {
            case "read":
                await notifications.MarkReadAsync(n.Id, ct);
                return new("Marked as read.", false, null);
            case "open" or "join" or "review" or "discuss" or "callback" or "answer" or "message":
                // These finish in the app: the notice is read, the app opens where it points.
                await notifications.MarkReadAsync(n.Id, ct);
                return new("Opening.", false, n.Link);
            case "snooze":
                var until = clock.Now.Add((req.Preset ?? "1h").Trim().ToLowerInvariant() switch { "3h" => TimeSpan.FromHours(3), "tomorrow" => TimeSpan.FromHours(18), _ => TimeSpan.FromHours(1) });
                var s = await actions.ActAsync(n.Id, new NotificationActRequest("snooze", null, until), ct);
                return new(s.Message, false, null);
            case "late":
                return new(await RunningLateAsync(n, ct), false, null);
            case "confirm" when QuickActions.SlipFix.Match(n.Link ?? "") is { Success: true } fix:
            {
                // Aura's prepared fix, confirmed with one tap: the same confirmation as the card (rights, 24-hour expiry, payload binding, undo).
                var done = await aura.ConfirmAsync(Guid.Parse(fix.Groups["m"].Value), fix.Groups["a"].Value, ct);
                if (done.Status != "done") throw new ConflictException(done.Error ?? "That could not be done. Open the project to do it by hand.", "AI_ACTION_FAILED");
                await notifications.SetArchivedAsync(n.Id, true, ct);
                return new($"Done: {done.Title}. You can undo it from Aura for a few minutes.", false, null);
            }
            case "accept" when IsExtension(n):
                await notifications.SetArchivedAsync(n.Id, true, ct);
                return new("Noted. The new date stands.", false, null);
            case "decline" when n.Type == NotificationType.Call:
                await notifications.MarkReadAsync(n.Id, ct);
                return new("Declined.", false, null);
            case "accept" or "decline" or "maybe":
                return new(await RsvpAsync(n, action, ct), false, null);
            case "reject" when string.IsNullOrWhiteSpace(text):
                throw new ValidationException("text", "Say why, so they know what to change.");
            case "approve" or "reject" when n.Type == NotificationType.Approval:
            {
                var id = Guid.Parse(n.Link!["/approvals?open=".Length..][..36]);
                await approvals.DecideAsync(id, new ProjectManagement.Application.Features.Approvals.DecideApprovalRequest(action, text), ct);
                await notifications.SetArchivedAsync(n.Id, true, ct);
                return new(action == "approve" ? "Approved." : "Rejected.", false, null);
            }
            default:
            {
                // done, reply, approve / reject of documents and timesheets: the in-app actions, same rules.
                var r = await actions.ActAsync(n.Id, new NotificationActRequest(action, text), ct);
                return new(r.Message, false, null);
            }
        }
    }

    private static bool IsExtension(Notification n) => n.Title.Contains(" extended", StringComparison.OrdinalIgnoreCase) || n.Title.StartsWith("Date extension", StringComparison.OrdinalIgnoreCase);

    private static readonly Regex Meeting = new(@"^/(calls/meeting/(?<w>w/)?|meet\?open=(?<k>[wp]):)(?<m>[0-9a-fA-F-]{36})", RegexOptions.Compiled);

    private static (Guid Id, bool Workspace) MeetingOf(Notification n)
    {
        var m = Meeting.Match(n.Link ?? "");
        if (!m.Success) throw new ValidationException("action", "This notice is not about a meeting.");
        return (Guid.Parse(m.Groups["m"].Value), m.Groups["w"].Success || m.Groups["k"].Value == "w");
    }

    private async Task<string> RsvpAsync(Notification n, string action, CancellationToken ct)
    {
        var (id, workspace) = MeetingOf(n);
        var req = new ProjectManagement.Application.Features.ProjectMeetings.MeetingRsvpRequest(action == "maybe" ? "tentative" : action);
        var status = workspace ? await meetings.RespondWorkspaceAsync(id, req, ct) : await meetings.RespondAsync(id, req, ct);
        await notifications.SetArchivedAsync(n.Id, true, ct);
        return status switch { "Accepted" => "Accepted.", "Declined" => "Declined.", _ => "Marked as maybe." };
    }

    /// <summary>"Running late": every other attendee hears it (once per meeting), quietly, with the meeting's link.</summary>
    private async Task<string> RunningLateAsync(Notification n, CancellationToken ct)
    {
        var me = ctx.RequireUserId();
        var (id, workspace) = MeetingOf(n);
        string? title; List<Guid> people;
        if (workspace)
        {
            title = await db.WorkspaceMeetings.AsNoTracking().Where(m => m.Id == id).Select(m => m.Title).FirstOrDefaultAsync(ct);
            people = await db.WorkspaceMeetingAttendees.AsNoTracking().Where(a => a.MeetingId == id).Select(a => a.UserId).ToListAsync(ct);
        }
        else
        {
            title = await db.ProjectMeetings.AsNoTracking().Where(m => m.Id == id).Select(m => m.Title).FirstOrDefaultAsync(ct);
            people = await db.MeetingParticipants.AsNoTracking().Where(p => p.MeetingId == id && p.UserId != null).Select(p => p.UserId!.Value).ToListAsync(ct);
        }
        if (title is null) throw new NotFoundException("Meeting not found.");
        if (!people.Contains(me)) throw new ForbiddenException("You are not in this meeting.");
        var name = await db.Users.AsNoTracking().Where(u => u.Id == me).Select(u => u.DisplayName).FirstAsync(ct);
        foreach (var p in people.Distinct().Where(p => p != me))
            await notifications.AddAsync(p, NotificationType.Meeting, $"{name} is running about 5 minutes late", title, n.Link, $"late:{id:N}:{me:N}", ct: ct);
        await notifications.MarkReadAsync(n.Id, ct);
        return "Told the others you're running late.";
    }
}
