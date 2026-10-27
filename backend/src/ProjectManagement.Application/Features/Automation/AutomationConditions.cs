using Microsoft.EntityFrameworkCore;
using NodaTime;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Automation;

/// <summary>
/// The workspace's working hours for the "within business hours" condition: the Desk's hours (Settings › Desk) when they are set, otherwise
/// Monday to Friday, 9:00 to 18:00 in the workspace's zone.
/// </summary>
public sealed record AutomationHours(int WorkDays, int DayStart, int DayEnd, DateTimeZone Zone)
{
    public static async Task<AutomationHours> LoadAsync(IAppDbContext db, AppClock clock, CancellationToken ct)
    {
        var s = await db.OperationsSettings.AsNoTracking().FirstOrDefaultAsync(ct);
        var zone = ZoneTime.Find(s?.TimeZone ?? clock.ZoneId);
        if (s is null || s.WorkDays is <= 0 or >= 128 || s.DayEndMinutes - s.DayStartMinutes < 15) return new AutomationHours(31, 9 * 60, 18 * 60, zone);
        return new AutomationHours(s.WorkDays, s.DayStartMinutes, s.DayEndMinutes, zone);
    }

    public bool Within(DateTime utc)
    {
        var local = ZoneTime.ToLocal(utc, Zone);
        if ((WorkDays & (1 << (((int)local.DayOfWeek + 6) % 7))) == 0) return false;
        var minute = (int)local.TimeOfDay.TotalMinutes;
        return minute >= DayStart && minute < DayEnd;
    }
}

/// <summary>Evaluates a rule's "If" conditions (all must hold) against a task or ticket at a moment.</summary>
public static class AutomationConditions
{
    /// <summary>Null when every condition holds; otherwise why the first failing one does not.</summary>
    /// <param name="status">The task's status category, or the ticket's status, as text.</param>
    /// <param name="respondedAt">Tickets: when an agent first acted on it (for <c>noReply</c>).</param>
    public static string? Failing(IReadOnlyList<AutomationConditionDto> conditions, Priority priority, string? status, Guid? assigneeId, DateTime createdAt,
        DateTime? respondedAt, DateTime at, AutomationHours hours)
    {
        foreach (var c in conditions)
        {
            switch (c.Field)
            {
                case "priority" when !string.Equals(c.Value, priority.ToString(), StringComparison.OrdinalIgnoreCase):
                    return $"the priority is {priority}, not {c.Value}";
                case "status" when !string.Equals(c.Value, status, StringComparison.OrdinalIgnoreCase):
                    return $"the status is {status ?? "unknown"}, not {c.Value}";
                case "unassigned" when assigneeId is not null:
                    return "someone is assigned";
                case "businessHours" when !hours.Within(at):
                    return "it is outside business hours";
                case "noReply" when c.Minutes is { } m:
                    if (respondedAt is { } r && r <= createdAt.AddMinutes(m)) return "an agent has replied";
                    if (at < createdAt.AddMinutes(m)) return $"it has waited less than {m} minutes";
                    break;
            }
        }
        return null;
    }
}

/// <summary>Posts an automation's line in a Messages channel (a group or project conversation) as a system line; it shows on the next load.</summary>
public static class AutomationChannel
{
    public static async Task<bool> PostAsync(IAppDbContext db, AppClock clock, Guid tenantId, Guid conversationId, string body, CancellationToken ct)
    {
        var conv = await db.Conversations.FirstOrDefaultAsync(c => c.Id == conversationId && c.Type != ConversationType.Direct, ct);
        if (conv is null) return false;
        var text = body.Length > 2000 ? body[..2000] : body;
        var line = new ChatMessage { TenantId = tenantId, ConversationId = conv.Id, Kind = ChatMessageKind.System, Body = text, CreatedAt = clock.Now };
        db.ChatMessages.Add(line);
        conv.LastMessageAt = clock.Now; conv.LastMessageId = line.Id; conv.LastMessageSenderId = null;
        conv.LastMessageSnippet = text.Length > 120 ? text[..120] : text;
        return true;
    }
}

/// <summary>
/// Runs workspace rules on Desk tickets (operational work) when one is created or updated, inside the caller's unit of work (nothing here saves).
/// Like task rules, actions never trigger further rules and each rule runs at most 100 times an hour. Drafts and switched-off rules never run.
/// </summary>
public class TicketAutomationEngine(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, NotificationService notifications, EntitlementService entitlements,
    ProjectManagement.Application.Features.Support.TicketCustomerMessenger customers)
{
    public static string KeyOf(int number) => $"WT-{number}";

    public async Task<int> RunAsync(WorkTask ticket, bool created, CancellationToken ct = default)
    {
        if (ticket.Kind != WorkTaskKind.Operational) return 0;
        if (await entitlements.GetValueAsync(FeatureKeys.Automation, ct) == 0) return 0;
        var triggers = created ? new[] { AutomationTrigger.TicketCreated, AutomationTrigger.TicketChanged } : new[] { AutomationTrigger.TicketChanged };
        var rules = await db.AutomationRules.Where(r => r.ProjectId == null && r.IsEnabled && triggers.Contains(r.Trigger)).OrderBy(r => r.CreatedAt).ToListAsync(ct);
        if (rules.Count == 0) return 0;
        var hours = await AutomationHours.LoadAsync(db, clock, ct);
        var ran = 0;
        foreach (var rule in rules)
        {
            if (await RunRuleAsync(rule, ticket, hours, ct)) ran++;
        }
        return ran;
    }

    /// <summary>
    /// One rule on one ticket (an event, or the scheduler when a ticket's wait ran out): drafts never run, every condition must hold, then each
    /// step in order. Returns whether any step did something. Nothing here saves.
    /// </summary>
    public async Task<bool> RunRuleAsync(AutomationRule rule, WorkTask ticket, AutomationHours hours, CancellationToken ct)
    {
        if (AutomationService.IsDraft(rule)) return false;
        if (AutomationConditions.Failing(AutomationService.ConditionsOf(rule), ticket.Priority, ticket.Status.ToString(), ticket.AssigneeId, ticket.CreatedAt,
                ticket.RespondedAt, clock.Now, hours) is not null) return false;
        if (!AutomationRunLimiter.Allowed(rule.Id, clock.Now)) return false;
        var outcomes = new List<string>();
        foreach (var step in AutomationService.StepsOf(rule))
            if (await ApplyAsync(rule, step, ticket, ct) is { } done) outcomes.Add(done);
        if (outcomes.Count == 0) return false;
        AutomationRunLimiter.Record(rule.Id, clock.Now);
        rule.RunCount++; rule.LastRunAt = clock.Now;
        recorder.Activity("task.automation", "WorkTask", ticket.Id, $"{KeyOf(ticket.Number)}: automation “{rule.Name}” {string.Join(", ", outcomes)}", null);
        return true;
    }

    private async Task<string?> ApplyAsync(AutomationRule rule, AutomationStepDto step, WorkTask t, CancellationToken ct)
    {
        var key = KeyOf(t.Number);
        var link = $"/work?item={t.Id}";
        switch (step.Action)
        {
            case AutomationAction.SetPriority when step.ActionPriority is { } p:
                if (t.Priority == p) return null;
                t.Priority = p;
                return $"set the priority to {p}";
            case AutomationAction.MoveToStatus when step.ActionStatusCategory is { } cat:
            {
                var status = cat switch
                {
                    StatusCategory.Todo => WorkTaskStatus.ToDo, StatusCategory.Active => WorkTaskStatus.InProgress,
                    StatusCategory.Done => WorkTaskStatus.Completed, _ => WorkTaskStatus.Cancelled,
                };
                if (t.Status == status) return null;
                t.Status = status;
                t.CompletedAt = status == WorkTaskStatus.Completed ? clock.Now : null;
                return $"moved the ticket to {status}";
            }
            case AutomationAction.SetAssignee:
            {
                var uid = step.ActionTarget == AutomationTarget.Reporter ? t.ReporterId : step.ActionUserId;
                if (uid is not { } who || t.AssigneeId == who) return null;
                if (!await db.TenantMembers.AnyAsync(m => m.TenantId == t.TenantId && m.UserId == who, ct)) return null;
                t.AssigneeId = who;
                await notifications.AddAsync(who, NotificationType.TaskAssigned, $"You were assigned {key}", t.Title, link, ct: ct);
                return "assigned the ticket";
            }
            case AutomationAction.Notify:
            {
                var uid = step.ActionTarget switch { AutomationTarget.Reporter => t.ReporterId, AutomationTarget.Assignee => t.AssigneeId, _ => step.ActionUserId };
                if (uid is not { } who) return null;
                await notifications.AddAsync(who, NotificationType.Comment, $"{key}: {rule.Name}", step.ActionText ?? t.Title, link, ct: ct);
                return "sent a notification";
            }
            case AutomationAction.AddComment when !string.IsNullOrWhiteSpace(step.ActionText):
                db.WorkTaskComments.Add(new WorkTaskComment { TenantId = t.TenantId, WorkTaskId = t.Id, AuthorId = ctx.RequireUserId(), Body = $"🤖 {step.ActionText}", CreatedAt = clock.Now, CreatedBy = ctx.UserId });
                return "posted a comment";
            case AutomationAction.TellCustomer when !string.IsNullOrWhiteSpace(step.ActionText):
            {
                // Sent on the ticket's channel (WhatsApp chat or the e-mail that raised it) and kept on the ticket; without a channel, a comment.
                var customer = await db.SupportConversations.AsNoTracking().Where(c => c.WorkTaskId == t.Id).Select(c => c.ContactName).FirstOrDefaultAsync(ct)
                    ?? await db.Users.AsNoTracking().Where(u => u.Id == t.ReporterId).Select(u => u.DisplayName).FirstOrDefaultAsync(ct);
                var line = ProjectManagement.Application.Features.Support.DeskReplies.FillLine(step.ActionText!, t, customer, clock.Now);
                var told = await customers.TellAsync(t, line, rule.Name, ct);
                if (told is null)
                {
                    db.WorkTaskComments.Add(new WorkTaskComment { TenantId = t.TenantId, WorkTaskId = t.Id, AuthorId = ctx.RequireUserId(), Body = $"📣 To the customer: {line}", CreatedAt = clock.Now, CreatedBy = ctx.UserId });
                    return "noted the reply for the customer (the ticket has no customer channel)";
                }
                return told.Sent ? $"told the customer on {ProjectManagement.Application.Features.Support.TicketCustomerMessenger.Label(told.Channel)}"
                    : $"could not tell the customer on {ProjectManagement.Application.Features.Support.TicketCustomerMessenger.Label(told.Channel)} ({told.Note})";
            }
            case AutomationAction.CloseTicket:
            {
                // Only a resolved ticket is closed: its resolution counts as accepted and its WhatsApp chat is closed.
                if (t.Status != WorkTaskStatus.Completed || t.ResolutionAcceptedAt is not null) return null;
                t.ResolutionAcceptedAt = clock.Now; t.ResolutionAcceptedBy = ctx.RequireUserId();
                t.Version++; t.UpdatedAt = clock.Now; t.UpdatedBy = ctx.UserId;
                foreach (var chat in await db.SupportConversations.Where(c => c.WorkTaskId == t.Id && c.Status != "closed").ToListAsync(ct))
                { chat.Status = "closed"; chat.NeedsReply = false; chat.WaitingSince = null; }
                db.WorkTaskComments.Add(new WorkTaskComment { TenantId = t.TenantId, WorkTaskId = t.Id, AuthorId = ctx.RequireUserId(), Body = $"🔒 Closed by “{rule.Name}”.", CreatedAt = clock.Now, CreatedBy = ctx.UserId });
                return "closed the ticket";
            }
            case AutomationAction.PostToChannel when step.ActionConversationId is { } cid:
                return await AutomationChannel.PostAsync(db, clock, t.TenantId, cid, $"⚡ {key} · {t.Title} — {step.ActionText ?? rule.Name}", ct) ? "posted in Messages" : null;
        }
        return null;
    }
}

/// <summary>
/// Desk ticket rules checked on a timer (from the automation worker): "no agent has replied for N minutes" and "resolved for N days". Each rule
/// acts as the person who wrote it (or the workspace owner when they have left) and runs at most once per ticket per wait - the ticket's creation
/// for a reply, the moment it was resolved for the resolved rule (reopening and resolving again starts a new wait). The run is remembered in the
/// ticket's history, so a restart or a second worker never repeats it.
/// </summary>
public class TicketRuleScheduler(IAppDbContext db, CurrentContext cc, AppClock clock, TicketAutomationEngine engine, EntitlementService entitlements,
    Microsoft.Extensions.Logging.ILogger<TicketRuleScheduler> log)
{
    public const string RunAction = "ticket.rule";
    private const int PerRule = 200;

    public static string MarkerOf(Guid ruleId, string period) => $"{ruleId:N}|{period}";

    public async Task<int> RunAsync(CancellationToken ct = default)
    {
        var scheduled = new[] { AutomationTrigger.TicketWaiting, AutomationTrigger.TicketResolved };
        var rules = await db.AutomationRules.IgnoreQueryFilters().AsNoTracking()
            .Where(r => r.IsEnabled && r.ProjectId == null && scheduled.Contains(r.Trigger)
                && db.Tenants.IgnoreQueryFilters().Any(t => t.Id == r.TenantId && t.Status == TenantStatus.Active && !t.IsDeleted))
            .Select(r => new { r.Id, r.TenantId }).ToListAsync(ct);
        var total = 0;
        foreach (var tenant in rules.GroupBy(r => r.TenantId))
        {
            try { total += await RunTenantAsync(tenant.Key, tenant.Select(r => r.Id).ToList(), ct); }
            catch (Exception ex) when (ex is not OperationCanceledException) { Microsoft.Extensions.Logging.LoggerExtensions.LogError(log, ex, "Scheduled ticket rules failed for workspace {Tenant}", tenant.Key); }
        }
        return total;
    }

    private async Task<int> RunTenantAsync(Guid tenantId, List<Guid> ruleIds, CancellationToken ct)
    {
        if ((await entitlements.GetEntitlementsAsync(tenantId, ct)).GetValueOrDefault(FeatureKeys.Automation) <= 0) return 0;
        var tenant = await db.Tenants.IgnoreQueryFilters().AsNoTracking().FirstAsync(t => t.Id == tenantId, ct);
        cc.TenantId = tenantId; cc.WorkspaceType = tenant.Type; cc.IsPlatformAdmin = false;
        var hours = await AutomationHours.LoadAsync(db, clock, ct);
        var now = clock.Now;
        var done = 0;
        foreach (var ruleId in ruleIds)
        {
            var rule = await db.AutomationRules.FirstAsync(r => r.Id == ruleId, ct);
            if (AutomationService.IsDraft(rule)) continue;
            var actor = await db.TenantMembers.AsNoTracking().FirstOrDefaultAsync(m => m.TenantId == tenantId && m.UserId == rule.CreatedBy, ct)
                ?? await db.TenantMembers.AsNoTracking().FirstOrDefaultAsync(m => m.TenantId == tenantId && m.UserId == tenant.OwnerUserId, ct);
            if (actor is null) continue;
            cc.UserId = actor.UserId; cc.Role = actor.Role;

            var n = rule.TriggerDays ?? 0;
            var tickets = db.WorkTasks.Where(t => t.Kind == WorkTaskKind.Operational);
            List<(Guid Id, string Period)> candidates;
            if (rule.Trigger == AutomationTrigger.TicketWaiting)
            {
                var before = now.AddMinutes(-n);
                candidates = (await tickets.Where(t => t.RespondedAt == null && t.CreatedAt <= before
                        && (t.Status == WorkTaskStatus.ToDo || t.Status == WorkTaskStatus.InProgress || t.Status == WorkTaskStatus.OnHold))
                    .OrderBy(t => t.CreatedAt).Take(PerRule * 2).Select(t => new { t.Id }).ToListAsync(ct))
                    .Select(t => (t.Id, "wait")).ToList();
            }
            else
            {
                var before = now.AddDays(-n);
                candidates = (await tickets.Where(t => t.Status == WorkTaskStatus.Completed && t.CompletedAt != null && t.CompletedAt <= before)
                    .OrderBy(t => t.CompletedAt).Take(PerRule * 2).Select(t => new { t.Id, t.CompletedAt }).ToListAsync(ct))
                    .Select(t => (t.Id, "done" + t.CompletedAt!.Value.ToString("yyyyMMddHHmmss"))).ToList();
            }
            if (candidates.Count == 0) continue;
            var ids = candidates.Select(c => c.Id).ToList();
            var markers = (await db.Activities.AsNoTracking().Where(a => a.Action == RunAction && a.EntityId != null && ids.Contains(a.EntityId.Value))
                .Select(a => a.NewValue).ToListAsync(ct)).ToHashSet();
            foreach (var (id, period) in candidates.Where(c => !markers.Contains(MarkerOf(rule.Id, c.Period))).Take(PerRule))
            {
                var ticket = await db.WorkTasks.FirstAsync(t => t.Id == id, ct);
                // Conditions that do not hold now (outside business hours, ...) are looked at again next time; otherwise it is remembered either way.
                if (AutomationConditions.Failing(AutomationService.ConditionsOf(rule), ticket.Priority, ticket.Status.ToString(), ticket.AssigneeId, ticket.CreatedAt,
                        ticket.RespondedAt, now, hours) is not null) continue;
                if (await engine.RunRuleAsync(rule, ticket, hours, ct)) done++;
                db.Activities.Add(new Activity
                {
                    TenantId = tenantId, ActorId = actor.UserId, Action = RunAction, EntityType = "WorkTask", EntityId = id,
                    Summary = $"{TicketAutomationEngine.KeyOf(ticket.Number)}: scheduled rule “{rule.Name}” checked", NewValue = MarkerOf(rule.Id, period), CreatedAt = now,
                });
                await db.SaveChangesAsync(ct);
            }
        }
        return done;
    }
}
