using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Features.Chat;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Application.Features.Support;
using ProjectManagement.Application.Features.Tasks;
using ProjectManagement.Application.Features.Time;
using ProjectManagement.Application.Features.Work;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Notifications;

/// <param name="Action">done, take, reply, approve, reject, snooze, or wake (bring a snoozed one back now).</param>
/// <param name="Text">The reply, or the reason when rejecting or asking for changes.</param>
/// <param name="Until">When a snoozed notification comes back (UTC).</param>
public record NotificationActRequest(string Action, string? Text = null, DateTime? Until = null);
/// <param name="Message">What happened, to show the person ("PAY-12 is done.").</param>
public record NotificationActResultDto(string Message, bool Archived);

/// <summary>
/// Acting on a notification without opening the page it points to: mark the task done, take it, reply, approve or send back, snooze. Each
/// action goes through the same service as the page (so the same permissions, rules, history and notifications apply); the notification is
/// then read, and put away when the thing it asked for is done.
/// </summary>
public class NotificationActionService(IAppDbContext db, ICurrentContext ctx, NotificationService notifications, TaskService tasks, WorkTaskService tickets,
    DocumentWorkflowService reviews, TimesheetApprovalService timesheets, ChatService chat, SupportChannelService support)
{
    private static readonly Regex ProjectTask = new(@"^/projects/(?<p>[0-9a-fA-F-]{36})\?task=(?<t>[0-9a-fA-F-]{36})", RegexOptions.Compiled);
    private static readonly Regex Ticket = new(@"^/operations\?task=(?<t>[0-9a-fA-F-]{36})", RegexOptions.Compiled);
    private static readonly Regex Document = new(@"^/documents/(?<d>[0-9a-fA-F-]{36})$", RegexOptions.Compiled);
    private static readonly Regex Timesheet = new(@"^/timesheet/approvals\?week=\d{4}-\d{2}-\d{2}&review=(?<r>[0-9a-fA-F-]{36})", RegexOptions.Compiled);
    private static readonly Regex ProjectChat = new(@"^/projects/(?<p>[0-9a-fA-F-]{36})\?chat=1$", RegexOptions.Compiled);
    private static readonly Regex DirectChat = new(@"^/chat/(?<c>[0-9a-fA-F-]{36})$", RegexOptions.Compiled);
    private static readonly Regex SupportChat = new(@"^/operations\?view=whatsapp&chat=(?<c>[0-9a-fA-F-]{36})$", RegexOptions.Compiled);

    private enum Target { None, Task, Ticket, Document, Timesheet, ProjectChat, Chat, Support }

    private static (Target Kind, Guid Id) TargetOf(string? link)
    {
        if (string.IsNullOrEmpty(link)) return (Target.None, Guid.Empty);
        if (ProjectTask.Match(link) is { Success: true } a) return (Target.Task, Guid.Parse(a.Groups["t"].Value));
        if (Ticket.Match(link) is { Success: true } b) return (Target.Ticket, Guid.Parse(b.Groups["t"].Value));
        if (Document.Match(link) is { Success: true } c) return (Target.Document, Guid.Parse(c.Groups["d"].Value));
        if (Timesheet.Match(link) is { Success: true } d) return (Target.Timesheet, Guid.Parse(d.Groups["r"].Value));
        if (ProjectChat.Match(link) is { Success: true } e) return (Target.ProjectChat, Guid.Parse(e.Groups["p"].Value));
        if (DirectChat.Match(link) is { Success: true } f) return (Target.Chat, Guid.Parse(f.Groups["c"].Value));
        if (SupportChat.Match(link) is { Success: true } g) return (Target.Support, Guid.Parse(g.Groups["c"].Value));
        return (Target.None, Guid.Empty);
    }

    /// <summary>
    /// Adds to each listed notification what can be done from it. Cheap and honest: approvals are offered only while the person still has a
    /// decision to make, "done" only while the task is open, "take" only while nobody (or someone else) has it.
    /// </summary>
    public async Task<PagedResult<NotificationDto>> DecorateAsync(PagedResult<NotificationDto> page, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var targets = page.Items.Select(n => (n, t: TargetOf(n.Link))).ToList();
        var taskIds = targets.Where(x => x.t.Kind == Target.Task).Select(x => x.t.Id).Distinct().ToList();
        var ticketIds = targets.Where(x => x.t.Kind == Target.Ticket).Select(x => x.t.Id).Distinct().ToList();
        var docIds = targets.Where(x => x.t.Kind == Target.Document).Select(x => x.t.Id).Distinct().ToList();
        var weekIds = targets.Where(x => x.t.Kind == Target.Timesheet).Select(x => x.t.Id).Distinct().ToList();
        var chatIds = targets.Where(x => x.t.Kind == Target.Support).Select(x => x.t.Id).Distinct().ToList();

        var openTasks = taskIds.Count == 0 ? new Dictionary<Guid, Guid?>() : await db.Tasks.AsNoTracking()
            .Where(t => taskIds.Contains(t.Id) && t.Status!.Category != StatusCategory.Done && t.Status.Category != StatusCategory.Cancelled)
            .ToDictionaryAsync(t => t.Id, t => t.AssigneeId, ct);
        var openTickets = ticketIds.Count == 0 ? new Dictionary<Guid, Guid?>() : await db.WorkTasks.AsNoTracking()
            .Where(t => ticketIds.Contains(t.Id) && t.Status != WorkTaskStatus.Completed && t.Status != WorkTaskStatus.Cancelled)
            .ToDictionaryAsync(t => t.Id, t => t.AssigneeId, ct);
        var toDecide = new HashSet<Guid>();
        if (docIds.Count > 0)
        {
            var (rows, _) = await reviews.InboxAsync(ct);
            foreach (var r in rows.Where(r => r.ToDecide && docIds.Contains(r.Approval.DocumentId))) toDecide.Add(r.Approval.DocumentId);
        }
        var waitingWeeks = weekIds.Count == 0 ? [] : (await db.TimesheetApprovals.AsNoTracking()
            .Where(a => weekIds.Contains(a.Id) && a.Status == TimesheetStatus.Submitted && a.UserId != me).Select(a => a.Id).ToListAsync(ct)).ToHashSet();
        var supportChats = chatIds.Count == 0 ? new Dictionary<Guid, Guid?>() : await db.SupportConversations.AsNoTracking()
            .Where(c => chatIds.Contains(c.Id) && c.Status != "closed").ToDictionaryAsync(c => c.Id, c => c.AssigneeId, ct);

        var items = targets.Select(x =>
        {
            var (n, t) = x;
            var acts = new List<string>();
            switch (t.Kind)
            {
                case Target.Task when openTasks.TryGetValue(t.Id, out var owner):
                    acts.Add("done");
                    if (owner != me && n.Type is NotificationType.Nudge or NotificationType.Overdue or NotificationType.Mention or NotificationType.Comment) acts.Add("take");
                    acts.Add("reply");
                    break;
                case Target.Ticket when openTickets.TryGetValue(t.Id, out var holder):
                    acts.Add("done");
                    if (holder != me) acts.Add("take");
                    acts.Add("reply");
                    break;
                case Target.Document when toDecide.Contains(t.Id):
                    acts.Add("approve"); acts.Add("reject");
                    break;
                case Target.Timesheet when waitingWeeks.Contains(t.Id):
                    acts.Add("approve"); acts.Add("reject");
                    break;
                case Target.ProjectChat or Target.Chat when n.Type is NotificationType.Mention or NotificationType.Message:
                    acts.Add("reply");
                    break;
                case Target.Support when supportChats.TryGetValue(t.Id, out var chatOwner) && chatOwner != me:
                    acts.Add("take");
                    break;
            }
            if (!n.Archived) acts.Add("snooze");
            return n with { Actions = acts };
        }).ToList();
        return page with { Items = items };
    }

    public async Task<NotificationActResultDto> ActAsync(Guid id, NotificationActRequest req, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var n = await db.Notifications.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id && x.UserId == me, ct) ?? throw new NotFoundException("Notification not found.");
        var action = (req.Action ?? "").Trim().ToLowerInvariant();
        var text = req.Text?.Trim();
        if (text is { Length: > 4000 }) throw new ValidationException("text", "Keep it under 4000 characters.");

        if (action == "wake")
        {
            await notifications.SnoozeAsync(id, null, ct);
            return new("Back in your inbox.", false);
        }
        if (action == "snooze")
        {
            await notifications.SnoozeAsync(id, req.Until ?? throw new ValidationException("until", "Choose when it should come back."), ct);
            return new($"Snoozed until {req.Until:dd MMM, HH:mm} UTC.", false);
        }

        var (kind, target) = TargetOf(n.Link);
        string message;
        var putAway = true;
        switch (action, kind)
        {
            case ("done", Target.Task):
            {
                var task = await db.Tasks.AsNoTracking().Where(t => t.Id == target).Select(t => new { t.ProjectId, t.Number }).FirstOrDefaultAsync(ct) ?? throw new NotFoundException("The task is gone.");
                var done = await db.WorkflowStatuses.AsNoTracking().Where(s => s.ProjectId == task.ProjectId && s.Category == StatusCategory.Done).OrderBy(s => s.Order).Select(s => (Guid?)s.Id).FirstOrDefaultAsync(ct)
                    ?? throw new ConflictException("This project has no Done status.");
                var moved = await tasks.MoveAsync(target, new MoveTaskRequest(done, null), ct);
                message = $"{moved.Key} is done.";
                break;
            }
            case ("done", Target.Ticket):
            {
                var t = await tickets.SetStatusAsync(target, new SetWorkTaskStatusRequest(WorkTaskStatus.Completed), ct);
                message = $"{t.Key} is completed.";
                break;
            }
            case ("take", Target.Task):
            {
                var d = (await tasks.GetAsync(target, ct)).Task;
                var t = await tasks.UpdateAsync(target, new UpdateTaskRequest(d.Title, d.Description, d.StatusId, d.Priority, me, d.StartDate, d.DueDate, d.EstimatedHours, d.ActualHours,
                    d.Labels.Select(l => l.Id).ToList(), d.Version), ct);
                message = $"{t.Key} is yours now.";
                break;
            }
            case ("take", Target.Ticket):
            {
                var d = await tickets.GetAsync(target, ct);
                var t = await tickets.UpdateAsync(target, new UpdateWorkTaskRequest(d.Title, d.Description, d.WorkTypeId, d.RelatedProject?.Id, me, d.Priority, d.Status, d.StartDate, d.DueDate, d.Version), ct);
                message = $"{t.Key} is yours now.";
                break;
            }
            case ("take", Target.Support):
                await support.AssignAsync(target, new SupportAssignRequest(me), ct);
                message = "The WhatsApp chat is yours now.";
                break;
            case ("reply", Target.Task):
                await tasks.AddCommentAsync(target, new CreateCommentRequest(Required(text, "Write a reply."), null, null), ct);
                message = "Reply posted on the task.";
                putAway = false;
                break;
            case ("reply", Target.Ticket):
                await tickets.AddCommentAsync(target, new WorkCommentRequest(Required(text, "Write a reply.")), ct);
                message = "Reply posted on the ticket.";
                putAway = false;
                break;
            case ("reply", Target.ProjectChat):
            {
                var conv = await db.Conversations.AsNoTracking().Where(c => c.ProjectId == target && c.Type == ConversationType.Project).Select(c => (Guid?)c.Id).FirstOrDefaultAsync(ct)
                    ?? throw new NotFoundException("The project chat is gone.");
                await chat.SendAsync(conv, new SendMessageRequest(Required(text, "Write a reply."), null), ct);
                message = "Sent in the project chat.";
                putAway = false;
                break;
            }
            case ("reply", Target.Chat):
                await chat.SendAsync(target, new SendMessageRequest(Required(text, "Write a reply."), null), ct);
                message = "Sent.";
                putAway = false;
                break;
            case ("approve", Target.Document):
                await reviews.ApproveAsync(target, new DecideRequest(text), ct);
                message = "Approved.";
                break;
            case ("reject", Target.Document):
                await reviews.RequestChangesAsync(target, new DecideRequest(Required(text, "Say what should change.")), ct);
                message = "Sent back with your comments.";
                break;
            case ("approve", Target.Timesheet):
                await timesheets.ApproveAsync(target, new ReviewTimesheetRequest(text), ct);
                message = "Timesheet approved.";
                break;
            case ("reject", Target.Timesheet):
                await timesheets.RejectAsync(target, new ReviewTimesheetRequest(Required(text, "Say why it is being returned, so they know what to fix.")), ct);
                message = "Timesheet returned.";
                break;
            default:
                throw new ValidationException("action", "That cannot be done from this notification. Open it instead.");
        }

        if (putAway) await notifications.SetArchivedAsync(id, true, ct);
        else await notifications.MarkReadAsync(id, ct);
        return new(message, putAway);
    }

    private static string Required(string? text, string message) => string.IsNullOrWhiteSpace(text) ? throw new ValidationException("text", message) : text;
}
