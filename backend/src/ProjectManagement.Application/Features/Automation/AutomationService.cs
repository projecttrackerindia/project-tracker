using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Planning;
using ProjectManagement.Application.Features.Tasks;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Automation;

/// <summary>One thing a rule does. Workspace rules name a status by category (the project's first status in it) instead of by id.</summary>
public record AutomationStepDto(AutomationAction Action, Priority? ActionPriority, Guid? ActionStatusId, StatusCategory? ActionStatusCategory, Guid? ActionLabelId,
    AutomationTarget ActionTarget, Guid? ActionUserId, string? ActionText, Guid? ActionConversationId = null);

/// <summary>
/// One "If" condition; all of a rule's conditions must hold (AND). Fields: <c>priority</c> (Value = Low/Medium/High/Critical), <c>status</c>
/// (Value = a status category for tasks, a ticket status for tickets), <c>unassigned</c>, <c>businessHours</c> (the event happens within the
/// workspace's working hours) and, for tickets, <c>noReply</c> (no agent has replied for <see cref="Minutes"/> minutes).
/// </summary>
public record AutomationConditionDto(string Field, string? Value = null, int? Minutes = null);

public record AutomationRuleDto(Guid Id, Guid? ProjectId, string Name, bool IsEnabled, AutomationTrigger Trigger, Guid? WhenStatusId, Priority? WhenPriority,
    AutomationAction Action, Priority? ActionPriority, Guid? ActionStatusId, Guid? ActionLabelId, AutomationTarget ActionTarget, Guid? ActionUserId, string? ActionText,
    string Summary, int RunCount, DateTime? LastRunAt, StatusCategory? WhenStatusCategory = null, int? TriggerDays = null, StatusCategory? ActionStatusCategory = null,
    IReadOnlyList<AutomationStepDto>? MoreActions = null, IReadOnlyList<AutomationConditionDto>? Conditions = null, bool IsDraft = false,
    Guid? ActionConversationId = null, string? ConversationName = null);

public record AutomationStepRequest(AutomationAction Action, Priority? ActionPriority, Guid? ActionStatusId, StatusCategory? ActionStatusCategory, Guid? ActionLabelId,
    AutomationTarget? ActionTarget, Guid? ActionUserId, string? ActionText, Guid? ActionConversationId = null);

/// <summary>The first action is in the Action* fields; <see cref="MoreActions"/> are done after it, in order (at most 4 more).</summary>
public record UpsertAutomationRequest(string Name, bool IsEnabled, AutomationTrigger Trigger, Guid? WhenStatusId, Priority? WhenPriority,
    AutomationAction Action, Priority? ActionPriority, Guid? ActionStatusId, Guid? ActionLabelId, AutomationTarget? ActionTarget, Guid? ActionUserId, string? ActionText,
    StatusCategory? WhenStatusCategory = null, int? TriggerDays = null, StatusCategory? ActionStatusCategory = null, IReadOnlyList<AutomationStepRequest>? MoreActions = null,
    Guid? ActionConversationId = null, IReadOnlyList<AutomationConditionDto>? Conditions = null, bool IsDraft = false);

/// <summary>A dry run: the rule as it would be saved, tried against one existing task. Nothing is changed or sent.</summary>
public record TestAutomationRequest(UpsertAutomationRequest Rule, Guid TaskId);
/// <summary>One step of a dry run: the trigger, then each action. <see cref="Pass"/> false means it stopped there (trigger) or would be skipped (action).</summary>
public record AutomationTestStepDto(string Step, bool Pass, string Note);
public record AutomationTestDto(string TaskKey, string TaskTitle, bool WouldRun, IReadOnlyList<AutomationTestStepDto> Steps);
/// <summary>One time a rule did something to a task (from the activity log).</summary>
public record AutomationRunDto(DateTime At, Guid? TaskId, string Summary);

/// <summary>A backtest: the rule as it stands, replayed over the last 7 days. Nothing is changed or sent.</summary>
public record AutomationBacktestDayDto(DateOnly Date, int Count);
public record AutomationBacktestItemDto(Guid Id, string Key, string Title, DateTime At, bool IsTicket);
public record AutomationBacktestDto(int Total, IReadOnlyList<AutomationBacktestDayDto> Days, IReadOnlyList<AutomationBacktestItemDto> Items, string Note);

/// <summary>What a rule keeps beyond its columns (in <see cref="AutomationRule.MoreActionsJson"/>, version 2): every step, the conditions, draft.</summary>
public record AutomationExtras(int V, List<AutomationStepDto>? Steps, List<AutomationConditionDto>? Conditions, bool Draft);

/// <summary>
/// Creates and edits automation rules: a project's own, or the workspace's (they apply to every project). Needs a plan that includes automation,
/// and edit rights on the project - or, for workspace rules, the permission to manage workflows.
/// </summary>
public class AutomationService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, ProjectAccess access, EntitlementService entitlements,
    PermissionService permissions)
{
    private const int MaxRulesPerProject = 50;
    private const int MaxWorkspaceRules = 50;
    private const int MaxMoreActions = 4;
    private const int MaxConditions = 6;
    private const int MaxExtrasLength = 4000;
    internal static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static bool IsScheduled(AutomationTrigger t) => t is AutomationTrigger.DueSoon or AutomationTrigger.Overdue or AutomationTrigger.Stale;
    /// <summary>Rules on Desk tickets (operational work) rather than on project tasks.</summary>
    public static bool IsTicket(AutomationTrigger t) => t is AutomationTrigger.TicketCreated or AutomationTrigger.TicketChanged or AutomationTrigger.TicketWaiting or AutomationTrigger.TicketResolved;
    /// <summary>Desk ticket rules checked on a schedule (see <see cref="TicketRuleScheduler"/>).</summary>
    public static bool IsTicketScheduled(AutomationTrigger t) => t is AutomationTrigger.TicketWaiting or AutomationTrigger.TicketResolved;

    // ---------------------------------------------------------------- project rules

    public async Task<IReadOnlyList<AutomationRuleDto>> ListAsync(Guid projectId, CancellationToken ct = default)
    {
        await access.GetProjectAsync(projectId, ct);
        var rules = await db.AutomationRules.AsNoTracking().Where(r => r.ProjectId == projectId).OrderBy(r => r.CreatedAt).ToListAsync(ct);
        var names = await NamesAsync(projectId, ct);
        return rules.Select(r => ToDto(r, names)).ToList();
    }

    public async Task<AutomationRuleDto> CreateAsync(Guid projectId, UpsertAutomationRequest req, CancellationToken ct = default)
    {
        var project = await RequireEditableAsync(projectId, ct);
        if (await db.AutomationRules.CountAsync(r => r.ProjectId == projectId, ct) >= MaxRulesPerProject)
            throw new ConflictException($"A project can have at most {MaxRulesPerProject} automation rules.", "LIMIT_REACHED");
        return await AddAsync(project.Id, req, ct);
    }

    public async Task<AutomationRuleDto> UpdateAsync(Guid projectId, Guid id, UpsertAutomationRequest req, CancellationToken ct = default)
    {
        await RequireEditableAsync(projectId, ct);
        var rule = await db.AutomationRules.FirstOrDefaultAsync(r => r.Id == id && r.ProjectId == projectId, ct) ?? throw new NotFoundException("Rule not found.");
        return await SaveAsync(rule, req, ct);
    }

    public async Task DeleteAsync(Guid projectId, Guid id, CancellationToken ct = default)
    {
        await RequireEditableAsync(projectId, ct);
        var rule = await db.AutomationRules.FirstOrDefaultAsync(r => r.Id == id && r.ProjectId == projectId, ct) ?? throw new NotFoundException("Rule not found.");
        await RemoveAsync(rule, ct);
    }

    // ---------------------------------------------------------------- workspace rules

    private async Task RequireWorkspaceManagerAsync(CancellationToken ct)
    {
        await permissions.RequireAsync(Permissions.WorkflowManage, ct);
        await entitlements.EnsureFeatureAsync(FeatureKeys.Automation, ct);
    }

    public async Task<IReadOnlyList<AutomationRuleDto>> ListWorkspaceAsync(CancellationToken ct = default)
    {
        ctx.RequireTenantId();
        var rules = await db.AutomationRules.AsNoTracking().Where(r => r.ProjectId == null).OrderBy(r => r.CreatedAt).ToListAsync(ct);
        var names = await NamesAsync(null, ct);
        return rules.Select(r => ToDto(r, names)).ToList();
    }

    public async Task<AutomationRuleDto> CreateWorkspaceAsync(UpsertAutomationRequest req, CancellationToken ct = default)
    {
        await RequireWorkspaceManagerAsync(ct);
        if (await db.AutomationRules.CountAsync(r => r.ProjectId == null, ct) >= MaxWorkspaceRules)
            throw new ConflictException($"A workspace can have at most {MaxWorkspaceRules} workspace-wide rules.", "LIMIT_REACHED");
        return await AddAsync(null, req, ct);
    }

    public async Task<AutomationRuleDto> UpdateWorkspaceAsync(Guid id, UpsertAutomationRequest req, CancellationToken ct = default)
    {
        await RequireWorkspaceManagerAsync(ct);
        var rule = await db.AutomationRules.FirstOrDefaultAsync(r => r.Id == id && r.ProjectId == null, ct) ?? throw new NotFoundException("Rule not found.");
        return await SaveAsync(rule, req, ct);
    }

    public async Task DeleteWorkspaceAsync(Guid id, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.WorkflowManage, ct);
        var rule = await db.AutomationRules.FirstOrDefaultAsync(r => r.Id == id && r.ProjectId == null, ct) ?? throw new NotFoundException("Rule not found.");
        await RemoveAsync(rule, ct);
    }

    // ---------------------------------------------------------------- dry run and history

    /// <summary>
    /// Tries a rule (saved or not) against one existing task without changing anything: does the trigger match the task as it is now, and
    /// what would each action do. Project rules only take that project's tasks; workspace rules take any task the caller can see.
    /// </summary>
    public async Task<AutomationTestDto> TestAsync(Guid? projectId, TestAutomationRequest req, CancellationToken ct = default)
    {
        if (req.Rule is null) throw new ValidationException("rule", "Describe the rule to try.");
        if (projectId is { } pid) await RequireEditableAsync(pid, ct); else await RequireWorkspaceManagerAsync(ct);
        var rule = new AutomationRule { ProjectId = projectId };
        await ApplyAsync(rule, req.Rule, ct);   // validates; the rule is never added to the database
        var hours = await AutomationHours.LoadAsync(db, clock, ct);
        var conditions = ConditionsOf(rule);
        if (IsTicket(rule.Trigger)) return await TestTicketAsync(rule, req.TaskId, hours, ct);

        var task = await db.Tasks.AsNoTracking().FirstOrDefaultAsync(t => t.Id == req.TaskId, ct) ?? throw new NotFoundException("Task not found.");
        if (projectId is { } p && task.ProjectId != p) throw new ValidationException("taskId", "Choose a task of this project.");
        var project = await access.GetProjectAsync(task.ProjectId, ct);
        var key = $"{project.Key}-{task.Number}";
        var status = await db.WorkflowStatuses.AsNoTracking().FirstOrDefaultAsync(s => s.Id == task.StatusId, ct);
        var open = status is null || (status.Category != StatusCategory.Done && status.Category != StatusCategory.Cancelled);
        var labels = (await db.TaskLabels.AsNoTracking().Where(l => l.TaskId == task.Id).Select(l => l.LabelId).ToListAsync(ct)).ToHashSet();

        var steps = new List<AutomationTestStepDto>();
        var (matched, why) = TriggerMatches(rule, task, status, open);
        steps.Add(new AutomationTestStepDto("When", matched, why));
        if (matched && conditions.Count > 0)
        {
            var failed = AutomationConditions.Failing(conditions, task.Priority, status?.Category.ToString(), task.AssigneeId, task.CreatedAt, null, clock.Now, hours);
            steps.Add(new AutomationTestStepDto("If", failed is null, failed is null ? "Every condition holds." : $"Stops here: {failed}."));
            matched = failed is null;
        }
        foreach (var step in StepsOf(rule))
        {
            if (!matched) { steps.Add(new AutomationTestStepDto("Then", false, "Not reached: the trigger or a condition did not match.")); continue; }
            var (pass, note) = await WouldDoAsync(step, task, labels, ct);
            steps.Add(new AutomationTestStepDto("Then", pass, note));
        }
        return new AutomationTestDto(key, task.Title, matched && steps.Where(s => s.Step == "Then").Any(s => s.Pass), steps);
    }

    private async Task<AutomationTestDto> TestTicketAsync(AutomationRule rule, Guid ticketId, AutomationHours hours, CancellationToken ct)
    {
        var t = await db.WorkTasks.AsNoTracking().FirstOrDefaultAsync(x => x.Id == ticketId && x.Kind == WorkTaskKind.Operational, ct)
            ?? throw new NotFoundException("Ticket not found.");
        var steps = new List<AutomationTestStepDto>
        {
            new("When", true, rule.Trigger switch
            {
                AutomationTrigger.TicketCreated => "This ticket stands in for a new one.",
                AutomationTrigger.TicketWaiting => t.RespondedAt is null && t.CreatedAt <= clock.Now.AddMinutes(-(rule.TriggerDays ?? 0))
                    ? $"Nobody has replied for {rule.TriggerDays} minutes." : "This ticket stands in for one waiting on a reply (checked every few minutes).",
                AutomationTrigger.TicketResolved => t.Status == WorkTaskStatus.Completed ? "It is resolved; the rule picks it up once the days have passed." : "This ticket stands in for a resolved one (checked every few minutes).",
                _ => "This ticket stands in for one that was just created or updated.",
            }),
        };
        var failed = AutomationConditions.Failing(ConditionsOf(rule), t.Priority, t.Status.ToString(), t.AssigneeId, t.CreatedAt, t.RespondedAt, clock.Now, hours);
        if (ConditionsOf(rule).Count > 0) steps.Add(new AutomationTestStepDto("If", failed is null, failed is null ? "Every condition holds." : $"Stops here: {failed}."));
        foreach (var s in StepsOf(rule))
        {
            if (failed is not null) { steps.Add(new AutomationTestStepDto("Then", false, "Not reached: a condition did not match.")); continue; }
            steps.Add(new AutomationTestStepDto("Then", true, s.Action switch
            {
                AutomationAction.PostToChannel => "Would post in the Messages channel (not posted in a test).",
                AutomationAction.TellCustomer => "Would tell the customer on the ticket's channel (not sent in a test).",
                AutomationAction.CloseTicket => t.Status == WorkTaskStatus.Completed ? "Would close the ticket." : "Skipped: only resolved tickets are closed.",
                AutomationAction.Notify => "Would send a notification (not sent in a test).",
                AutomationAction.AddComment => "Would post the comment (not posted in a test).",
                AutomationAction.SetPriority => s.ActionPriority == t.Priority ? "Skipped: the priority is already that." : $"Would set the priority to {s.ActionPriority}.",
                AutomationAction.SetAssignee => "Would assign the ticket.",
                _ => "Would move the ticket.",
            }));
        }
        return new AutomationTestDto(TicketAutomationEngine.KeyOf(t.Number), t.Title, failed is null, steps);
    }

    private (bool, string) TriggerMatches(AutomationRule r, TaskItem t, WorkflowStatus? status, bool open)
    {
        var days = r.TriggerDays ?? 0;
        var today = clock.Today;
        switch (r.Trigger)
        {
            case AutomationTrigger.TaskCreated:
                return (true, "Runs once when a task is created; this task stands in for a new one.");
            case AutomationTrigger.StatusChanged:
                if (r.WhenStatusId is { } ws && ws != t.StatusId) return (false, $"The task is in “{status?.Name ?? "?"}”, not the status the rule waits for.");
                if (r.WhenStatusCategory is { } wc && wc != status?.Category) return (false, $"The task is in “{status?.Name ?? "?"}”, not {Category(wc)}.");
                return (true, $"The task is in “{status?.Name ?? "?"}”.");
            case AutomationTrigger.PriorityChanged:
                if (r.WhenPriority is { } wp && wp != t.Priority) return (false, $"The task's priority is {t.Priority}, not {wp}.");
                return (true, $"The task's priority is {t.Priority}.");
            case AutomationTrigger.DueSoon:
                if (!open) return (false, "The task is closed; scheduled rules only look at open tasks.");
                if (t.DueDate is not { } due) return (false, "The task has no due date.");
                return due >= today && due <= today.AddDays(days) ? (true, $"Due {due:dd MMM}, within {days} day(s).") : (false, $"Due {due:dd MMM}, not within {days} day(s) from today.");
            case AutomationTrigger.Overdue:
                if (!open) return (false, "The task is closed; scheduled rules only look at open tasks.");
                if (t.DueDate is not { } d) return (false, "The task has no due date.");
                return d < today && d <= today.AddDays(-days) ? (true, $"Due {d:dd MMM}, overdue.") : (false, $"Due {d:dd MMM}, not {days} day(s) overdue yet.");
            default:
                if (!open) return (false, "The task is closed; scheduled rules only look at open tasks.");
                var changed = t.UpdatedAt ?? t.CreatedAt;
                return changed <= clock.Now.AddDays(-days) ? (true, $"Last changed {changed:dd MMM}.") : (false, $"Changed {changed:dd MMM}, less than {days} day(s) ago.");
        }
    }

    private async Task<(bool, string)> WouldDoAsync(AutomationStepDto s, TaskItem t, HashSet<Guid> labels, CancellationToken ct)
    {
        switch (s.Action)
        {
            case AutomationAction.SetPriority:
                return s.ActionPriority == t.Priority ? (false, $"Skipped: the priority is already {t.Priority}.") : (true, $"Would set the priority to {s.ActionPriority}.");
            case AutomationAction.MoveToStatus:
            {
                var target = s.ActionStatusId is { } sid
                    ? await db.WorkflowStatuses.AsNoTracking().FirstOrDefaultAsync(x => x.Id == sid && x.ProjectId == t.ProjectId, ct)
                    : s.ActionStatusCategory is { } cat
                        ? await db.WorkflowStatuses.AsNoTracking().Where(x => x.ProjectId == t.ProjectId && x.Category == cat).OrderBy(x => x.Order).FirstOrDefaultAsync(ct)
                        : null;
                if (target is null) return (false, "Skipped: the task's project has no such status.");
                if (target.Id == t.StatusId) return (false, $"Skipped: the task is already in “{target.Name}”.");
                return (true, $"Would move it to “{target.Name}” (unless dependencies or open subtasks hold it back).");
            }
            case AutomationAction.AddLabel:
                return s.ActionLabelId is { } lid && labels.Contains(lid) ? (false, "Skipped: the task already has the label.") : (true, "Would add the label.");
            case AutomationAction.SetAssignee:
            {
                Guid? who = s.ActionTarget == AutomationTarget.Reporter ? t.ReporterId : s.ActionUserId;
                if (who is null) return (false, "Skipped: nobody to assign.");
                return who == t.AssigneeId ? (false, "Skipped: already assigned to them.") : (true, "Would assign the task.");
            }
            case AutomationAction.Notify:
            {
                Guid? who = s.ActionTarget switch { AutomationTarget.Reporter => t.ReporterId, AutomationTarget.Assignee => t.AssigneeId, _ => s.ActionUserId };
                return who is null ? (false, "Skipped: nobody is assigned to notify.") : (true, "Would send a notification (not sent in a test).");
            }
            default:
                return (true, "Would post the comment (not posted in a test).");
        }
    }

    /// <summary>The latest times a rule did something (newest first, at most 50).</summary>
    public async Task<IReadOnlyList<AutomationRunDto>> RunsAsync(Guid? projectId, Guid id, CancellationToken ct = default)
    {
        if (projectId is { } pid) await access.GetProjectAsync(pid, ct); else ctx.RequireTenantId();
        var rule = await db.AutomationRules.AsNoTracking().FirstOrDefaultAsync(r => r.Id == id && r.ProjectId == projectId, ct) ?? throw new NotFoundException("Rule not found.");
        var marker = $"automation “{rule.Name}”";
        var q = db.Activities.AsNoTracking().Where(a => a.Action == "task.automation" && a.Summary.Contains(marker));
        if (projectId is { } p) q = q.Where(a => a.ProjectId == p);
        return await q.OrderByDescending(a => a.CreatedAt).Take(50).Select(a => new AutomationRunDto(a.CreatedAt, a.EntityId, a.Summary)).ToListAsync(ct);
    }

    // ---------------------------------------------------------------- backtest

    private const int BacktestDays = 7;
    private const int BacktestScan = 2000;
    private const int BacktestItems = 50;

    /// <summary>
    /// Replays a rule (saved or not) over the last 7 days, without changing or sending anything: when each matching task or ticket would have
    /// set it off, per day. Event triggers use the task's or ticket's recorded events; scheduled ones the day its due date or quiet spell came
    /// round. Conditions are checked against the item as it is now, and "within business hours" against the moment it would have fired.
    /// </summary>
    public async Task<AutomationBacktestDto> BacktestAsync(Guid? projectId, UpsertAutomationRequest req, CancellationToken ct = default)
    {
        if (req is null) throw new ValidationException("rule", "Describe the rule to try.");
        if (projectId is { } pid) await RequireEditableAsync(pid, ct); else await RequireWorkspaceManagerAsync(ct);
        var rule = new AutomationRule { ProjectId = projectId };
        await ApplyAsync(rule, req, ct);   // validates; never saved
        var hours = await AutomationHours.LoadAsync(db, clock, ct);
        var conditions = ConditionsOf(rule);
        var today = clock.Today;
        var firstDay = today.AddDays(-(BacktestDays - 1));
        var zone = ProjectManagement.Application.Features.Reminders.ZoneTime.Find(clock.ZoneId);
        var since = DayStart(firstDay);
        var now = clock.Now;
        var hits = new List<AutomationBacktestItemDto>();

        if (IsTicket(rule.Trigger))
        {
            var rows = await db.WorkTasks.AsNoTracking()
                .Where(t => t.Kind == WorkTaskKind.Operational && (t.CreatedAt >= since || (t.UpdatedAt != null && t.UpdatedAt >= since)))
                .OrderByDescending(t => t.CreatedAt).Take(BacktestScan)
                .Select(t => new { t.Id, t.Number, t.Title, t.Priority, t.Status, t.AssigneeId, t.CreatedAt, t.UpdatedAt, t.RespondedAt, t.CompletedAt }).ToListAsync(ct);
            var noReply = conditions.FirstOrDefault(c => c.Field == "noReply")?.Minutes;
            foreach (var t in rows)
            {
                // When it would have fired: on creation, or (created or updated) on its latest change - or, waiting for a reply, when the wait ran out.
                DateTime at;
                if (rule.Trigger == AutomationTrigger.TicketWaiting)
                {
                    at = t.CreatedAt.AddMinutes(rule.TriggerDays ?? 0);
                    if (t.RespondedAt is { } r && r <= at) continue;
                }
                else if (rule.Trigger == AutomationTrigger.TicketResolved)
                {
                    if (t.Status != WorkTaskStatus.Completed || t.CompletedAt is not { } done) continue;
                    at = done.AddDays(rule.TriggerDays ?? 0);
                }
                else if (noReply is { } m)
                {
                    at = t.CreatedAt.AddMinutes(m);
                    if (t.RespondedAt is { } r && r <= at) continue;   // an agent answered in time
                    if (rule.Trigger == AutomationTrigger.TicketCreated && t.CreatedAt < since) continue;
                }
                else if (rule.Trigger == AutomationTrigger.TicketCreated) at = t.CreatedAt;
                else at = t.UpdatedAt is { } u && u > t.CreatedAt ? u : t.CreatedAt;
                if (at < since || at > now) continue;
                if (AutomationConditions.Failing(conditions.Where(c => c.Field != "noReply").ToList(), t.Priority, t.Status.ToString(), t.AssigneeId, t.CreatedAt, null, at, hours) is not null) continue;
                hits.Add(new AutomationBacktestItemDto(t.Id, TicketAutomationEngine.KeyOf(t.Number), t.Title, at, true));
            }
        }
        else
        {
            var tasks = db.Tasks.AsNoTracking().Where(t => projectId == null || t.ProjectId == projectId);
            var events = new List<(Guid Id, DateTime At)>();
            switch (rule.Trigger)
            {
                case AutomationTrigger.TaskCreated:
                    events = (await tasks.Where(t => t.CreatedAt >= since).OrderByDescending(t => t.CreatedAt).Take(BacktestScan).Select(t => new { t.Id, t.CreatedAt }).ToListAsync(ct))
                        .Select(x => (x.Id, x.CreatedAt)).ToList();
                    break;
                case AutomationTrigger.StatusChanged:
                case AutomationTrigger.PriorityChanged:
                {
                    var action = rule.Trigger == AutomationTrigger.StatusChanged ? "task.status_changed" : "task.priority_changed";
                    var acts = db.Activities.AsNoTracking().Where(a => a.Action == action && a.EntityId != null && a.CreatedAt >= since);
                    if (projectId is { } p) acts = acts.Where(a => a.ProjectId == p);
                    events = (await acts.OrderByDescending(a => a.CreatedAt).Take(BacktestScan).Select(a => new { Id = a.EntityId!.Value, a.CreatedAt }).ToListAsync(ct))
                        .Select(x => (x.Id, x.CreatedAt)).ToList();
                    break;
                }
                default:
                {
                    // Scheduled: the first day the rule would have picked the task up (checked from the start of that day).
                    var days = rule.TriggerDays ?? 0;
                    var rows = await (rule.Trigger switch
                    {
                        AutomationTrigger.DueSoon => tasks.Where(t => t.DueDate != null && t.DueDate >= firstDay && t.DueDate <= today.AddDays(days)),
                        AutomationTrigger.Overdue => tasks.Where(t => t.DueDate != null && t.DueDate >= firstDay.AddDays(-days - 1) && t.DueDate < today),
                        _ => tasks.Where(t => (t.UpdatedAt ?? t.CreatedAt) >= since.AddDays(-days) && (t.UpdatedAt ?? t.CreatedAt) <= now.AddDays(-days)),
                    }).Take(BacktestScan).Select(t => new { t.Id, t.DueDate, t.CreatedAt, t.UpdatedAt }).ToListAsync(ct);
                    foreach (var t in rows)
                    {
                        DateTime at = rule.Trigger switch
                        {
                            AutomationTrigger.DueSoon => DayStart(Max(t.DueDate!.Value.AddDays(-days), DateOnly.FromDateTime(t.CreatedAt))),
                            AutomationTrigger.Overdue => DayStart(t.DueDate!.Value.AddDays(Math.Max(1, days))),
                            _ => (t.UpdatedAt ?? t.CreatedAt).AddDays(days),
                        };
                        events.Add((t.Id, at));
                    }
                    break;
                }
            }
            events = events.Where(e => e.At >= since && e.At <= now).ToList();
            var ids = events.Select(e => e.Id).Distinct().ToList();
            var info = await tasks.Where(t => ids.Contains(t.Id))
                .Select(t => new { t.Id, t.Number, t.Title, t.Priority, t.StatusId, t.AssigneeId, t.CreatedAt, t.ProjectId }).ToListAsync(ct);
            var statusIds = info.Select(t => t.StatusId).Distinct().ToList();
            var statuses = await db.WorkflowStatuses.AsNoTracking().Where(s => statusIds.Contains(s.Id)).ToDictionaryAsync(s => s.Id, s => s.Category, ct);
            var projectIds = info.Select(t => t.ProjectId).Distinct().ToList();
            var keys = await db.Projects.AsNoTracking().Where(p => projectIds.Contains(p.Id)).ToDictionaryAsync(p => p.Id, p => p.Key, ct);
            var byId = info.ToDictionary(t => t.Id);
            foreach (var (id, at) in events)
            {
                if (!byId.TryGetValue(id, out var t)) continue;
                StatusCategory? category = statuses.TryGetValue(t.StatusId, out var c) ? c : null;
                if (rule.Trigger == AutomationTrigger.StatusChanged && rule.WhenStatusCategory is { } wc && wc != category) continue;
                if (rule.Trigger == AutomationTrigger.StatusChanged && rule.WhenStatusId is { } ws && ws != t.StatusId) continue;
                if (rule.Trigger == AutomationTrigger.PriorityChanged && rule.WhenPriority is { } wp && wp != t.Priority) continue;
                if (AutomationConditions.Failing(conditions, t.Priority, category?.ToString(), t.AssigneeId, t.CreatedAt, null, at, hours) is not null) continue;
                hits.Add(new AutomationBacktestItemDto(t.Id, $"{keys.GetValueOrDefault(t.ProjectId) ?? "?"}-{t.Number}", t.Title, at, false));
            }
        }

        hits = hits.OrderByDescending(h => h.At).ToList();
        var perDay = Enumerable.Range(0, BacktestDays).Select(i => firstDay.AddDays(i))
            .Select(d => new AutomationBacktestDayDto(d, hits.Count(h => DateOnly.FromDateTime(ProjectManagement.Application.Features.Reminders.ZoneTime.ToLocal(h.At, zone)) == d))).ToList();
        var note = rule.Trigger switch
        {
            AutomationTrigger.TaskCreated or AutomationTrigger.TicketCreated => "Replayed from what was created in the last 7 days.",
            AutomationTrigger.StatusChanged or AutomationTrigger.PriorityChanged => "Replayed from the changes recorded in the last 7 days.",
            AutomationTrigger.TicketChanged => "Replayed from tickets created or updated in the last 7 days.",
            AutomationTrigger.TicketWaiting or AutomationTrigger.TicketResolved => "Replayed from tickets created or updated in the last 7 days and when their wait ran out.",
            _ => "Replayed from due dates and quiet spells in the last 7 days.",
        } + " Conditions are checked against each item as it is now. Nothing was changed or sent.";
        return new AutomationBacktestDto(hits.Count, perDay, hits.Take(BacktestItems).ToList(), note);

        DateTime DayStart(DateOnly d) => ProjectManagement.Application.Features.Reminders.ZoneTime.ToUtc(d.ToDateTime(TimeOnly.MinValue), zone);
        static DateOnly Max(DateOnly a, DateOnly b) => a > b ? a : b;
    }

    // ---------------------------------------------------------------- shared

    private async Task<AutomationRuleDto> AddAsync(Guid? projectId, UpsertAutomationRequest req, CancellationToken ct)
    {
        var rule = new AutomationRule { TenantId = ctx.RequireTenantId(), ProjectId = projectId, CreatedAt = clock.Now, CreatedBy = ctx.RequireUserId() };
        await ApplyAsync(rule, req, ct);
        db.AutomationRules.Add(rule);
        recorder.Audit("automation.created", "AutomationRule", rule.Id, newValue: new { rule.Name, rule.Trigger, rule.Action, scope = projectId is null ? "workspace" : "project" });
        await db.SaveChangesAsync(ct);
        return await GetAsync(rule.Id, ct);
    }

    private async Task<AutomationRuleDto> SaveAsync(AutomationRule rule, UpsertAutomationRequest req, CancellationToken ct)
    {
        await ApplyAsync(rule, req, ct);
        rule.UpdatedAt = clock.Now;
        recorder.Audit("automation.updated", "AutomationRule", rule.Id, newValue: new { rule.Name, rule.IsEnabled });
        await db.SaveChangesAsync(ct);
        return await GetAsync(rule.Id, ct);
    }

    private async Task RemoveAsync(AutomationRule rule, CancellationToken ct)
    {
        db.AutomationRules.Remove(rule);
        recorder.Audit("automation.deleted", "AutomationRule", rule.Id, oldValue: new { rule.Name });
        await db.SaveChangesAsync(ct);
    }

    private async Task<AutomationRuleDto> GetAsync(Guid id, CancellationToken ct)
    {
        var rule = await db.AutomationRules.AsNoTracking().FirstAsync(r => r.Id == id, ct);
        return ToDto(rule, await NamesAsync(rule.ProjectId, ct));
    }

    private async Task<Project> RequireEditableAsync(Guid projectId, CancellationToken ct)
    {
        var project = await access.GetProjectAsync(projectId, ct);
        await access.RequireProjectEditAsync(project, ct);
        await entitlements.EnsureFeatureAsync(FeatureKeys.Automation, ct);
        return project;
    }

    // ---------------------------------------------------------------- validation

    private async Task ApplyAsync(AutomationRule rule, UpsertAutomationRequest req, CancellationToken ct)
    {
        var name = req.Name?.Trim() ?? "";
        if (name.Length is < 1 or > 100) throw new ValidationException("name", "Give the rule a name (up to 100 characters).");
        if (!Enum.IsDefined(req.Trigger)) throw new ValidationException("trigger", "Choose when the rule runs.");
        var workspace = rule.ProjectId is null;
        var ticket = IsTicket(req.Trigger);
        if (ticket && !workspace) throw new ValidationException("trigger", "Rules on Desk tickets are workspace rules: add them under Work › Automations.");

        // A draft is saved but never runs until it is turned on.
        rule.Name = name; rule.IsEnabled = req.IsEnabled && !req.IsDraft;
        rule.Trigger = req.Trigger;
        rule.WhenStatusId = !workspace && req.Trigger == AutomationTrigger.StatusChanged ? req.WhenStatusId : null;
        rule.WhenStatusCategory = workspace && req.Trigger == AutomationTrigger.StatusChanged ? req.WhenStatusCategory : null;
        rule.WhenPriority = req.Trigger == AutomationTrigger.PriorityChanged ? req.WhenPriority : null;
        if (rule.WhenStatusId is { } ws) await RequireStatusAsync(rule.ProjectId!.Value, ws, "whenStatusId", ct);
        rule.TriggerDays = null;
        if (IsScheduled(req.Trigger))
        {
            var min = req.Trigger == AutomationTrigger.Stale ? 1 : 0;
            if (req.TriggerDays is not { } days || days < min || days > 365)
                throw new ValidationException("triggerDays", req.Trigger == AutomationTrigger.Stale ? "Say after how many days without changes (1-365)." : "Say how many days (0-365).");
            rule.TriggerDays = days;
        }
        else if (req.Trigger == AutomationTrigger.TicketWaiting)
        {
            if (req.TriggerDays is not { } minutes || minutes < 5 || minutes > 10080) throw new ValidationException("triggerDays", "Say after how many minutes without an agent's reply (5-10080).");
            rule.TriggerDays = minutes;
        }
        else if (req.Trigger == AutomationTrigger.TicketResolved)
        {
            if (req.TriggerDays is not { } days || days < 0 || days > 365) throw new ValidationException("triggerDays", "Say how many days after it was resolved (0-365).");
            rule.TriggerDays = days;
        }

        var first = await StepAsync(rule.ProjectId, new AutomationStepRequest(req.Action, req.ActionPriority, req.ActionStatusId, req.ActionStatusCategory, req.ActionLabelId,
            req.ActionTarget, req.ActionUserId, req.ActionText, req.ActionConversationId), "", ticket, ct);
        rule.Action = first.Action; rule.ActionPriority = first.ActionPriority; rule.ActionStatusId = first.ActionStatusId; rule.ActionStatusCategory = first.ActionStatusCategory;
        rule.ActionLabelId = first.ActionLabelId; rule.ActionTarget = first.ActionTarget; rule.ActionUserId = first.ActionUserId; rule.ActionText = first.ActionText;

        var more = req.MoreActions ?? [];
        if (more.Count > MaxMoreActions) throw new ValidationException("moreActions", $"A rule can do at most {MaxMoreActions + 1} things.");
        var steps = new List<AutomationStepDto>();
        for (var i = 0; i < more.Count; i++) steps.Add(await StepAsync(rule.ProjectId, more[i], $"moreActions[{i}].", ticket, ct));
        var conditions = Conditions(req.Conditions, ticket);

        // Rules that need nothing new keep the original format (an array of the later steps), so older servers and data stay as they were.
        var needsExtras = req.IsDraft || conditions.Count > 0 || first.ActionConversationId is not null || ticket
            || first.Action is AutomationAction.PostToChannel or AutomationAction.TellCustomer;
        rule.MoreActionsJson = needsExtras
            ? JsonSerializer.Serialize(new AutomationExtras(2, [first, .. steps], conditions.Count == 0 ? null : conditions, req.IsDraft), Json)
            : steps.Count == 0 ? null : JsonSerializer.Serialize(steps, Json);
        if (rule.MoreActionsJson is { Length: > MaxExtrasLength }) throw new ValidationException("moreActions", "The rule is too long: shorten the messages or drop a step.");
    }

    /// <summary>Checks the "If" conditions (all must hold) and keeps only what each one uses.</summary>
    private static List<AutomationConditionDto> Conditions(IReadOnlyList<AutomationConditionDto>? input, bool ticket)
    {
        var list = input ?? [];
        if (list.Count > MaxConditions) throw new ValidationException("conditions", $"A rule can have at most {MaxConditions} conditions.");
        var result = new List<AutomationConditionDto>();
        for (var i = 0; i < list.Count; i++)
        {
            var c = list[i] ?? throw new ValidationException($"conditions[{i}]", "Describe the condition.");
            var field = (c.Field ?? "").Trim();
            var key = $"conditions[{i}]";
            switch (field)
            {
                case "priority":
                    if (!Enum.TryParse<Priority>(c.Value, true, out var p) || !Enum.IsDefined(p)) throw new ValidationException(key, "Choose a priority.");
                    result.Add(new AutomationConditionDto("priority", p.ToString()));
                    break;
                case "status":
                    if (ticket)
                    {
                        if (!Enum.TryParse<WorkTaskStatus>(c.Value, true, out var ws) || !Enum.IsDefined(ws)) throw new ValidationException(key, "Choose a ticket status.");
                        result.Add(new AutomationConditionDto("status", ws.ToString()));
                    }
                    else
                    {
                        if (!Enum.TryParse<StatusCategory>(c.Value, true, out var sc) || !Enum.IsDefined(sc)) throw new ValidationException(key, "Choose a kind of status.");
                        result.Add(new AutomationConditionDto("status", sc.ToString()));
                    }
                    break;
                case "unassigned":
                case "businessHours":
                    result.Add(new AutomationConditionDto(field));
                    break;
                case "noReply":
                    if (!ticket) throw new ValidationException(key, "“No agent has replied” is for Desk tickets.");
                    if (c.Minutes is not { } m || m < 1 || m > 7 * 24 * 60) throw new ValidationException(key, "Say for how many minutes (1 to 10080).");
                    result.Add(new AutomationConditionDto("noReply", null, m));
                    break;
                default:
                    throw new ValidationException(key, "Choose a condition: priority, status, unassigned, within business hours or no reply.");
            }
        }
        if (result.Select(r => r.Field).Distinct().Count() != result.Count) throw new ValidationException("conditions", "Each kind of condition can be used once.");
        return result;
    }

    /// <summary>Checks one action and keeps only the fields it uses.</summary>
    private async Task<AutomationStepDto> StepAsync(Guid? projectId, AutomationStepRequest s, string prefix, bool ticket, CancellationToken ct)
    {
        if (s is null) throw new ValidationException($"{prefix}action", "Choose what the rule does.");
        if (!Enum.IsDefined(s.Action)) throw new ValidationException($"{prefix}action", "Choose what the rule does.");
        if (s.Action == AutomationAction.TellCustomer && !ticket) throw new ValidationException($"{prefix}action", "“Tell the customer” is for Desk tickets.");
        if (s.Action == AutomationAction.CloseTicket && !ticket) throw new ValidationException($"{prefix}action", "“Close the ticket” is for Desk tickets.");
        if (s.Action == AutomationAction.AddLabel && ticket) throw new ValidationException($"{prefix}action", "Desk tickets have no labels: choose another step.");
        Guid? conversation = null;
        var text = string.IsNullOrWhiteSpace(s.ActionText) ? null : s.ActionText.Trim();
        if (text is { Length: > 500 }) throw new ValidationException($"{prefix}actionText", "Keep the message under 500 characters.");
        Priority? priority = null; Guid? status = null; StatusCategory? category = null; Guid? label = null; Guid? user = null; string? keepText = null;
        var target = AutomationTarget.User;

        switch (s.Action)
        {
            case AutomationAction.SetPriority:
                priority = s.ActionPriority ?? throw new ValidationException($"{prefix}actionPriority", "Choose a priority.");
                break;
            case AutomationAction.MoveToStatus:
                if (projectId is { } pid)
                {
                    status = s.ActionStatusId ?? throw new ValidationException($"{prefix}actionStatusId", "Choose a status.");
                    await RequireStatusAsync(pid, status.Value, $"{prefix}actionStatusId", ct);
                }
                else category = s.ActionStatusCategory ?? throw new ValidationException($"{prefix}actionStatusCategory", "Choose a kind of status (to do, in progress, done...).");
                break;
            case AutomationAction.AddLabel:
                label = s.ActionLabelId ?? throw new ValidationException($"{prefix}actionLabelId", "Choose a label.");
                if (!await db.Labels.AnyAsync(l => l.Id == label, ct)) throw new ValidationException($"{prefix}actionLabelId", "Label not found.");
                break;
            case AutomationAction.SetAssignee:
                target = s.ActionTarget ?? AutomationTarget.User;
                if (target == AutomationTarget.Assignee) throw new ValidationException($"{prefix}actionTarget", "Assign to a person or to the task's reporter.");
                if (target == AutomationTarget.User) user = await PersonAsync(s.ActionUserId, prefix, ct);
                break;
            case AutomationAction.Notify:
                target = s.ActionTarget ?? AutomationTarget.User;
                if (target == AutomationTarget.User) user = await PersonAsync(s.ActionUserId, prefix, ct);
                keepText = text;
                break;
            case AutomationAction.AddComment:
                keepText = text ?? throw new ValidationException($"{prefix}actionText", "Write the comment to post.");
                break;
            case AutomationAction.PostToChannel:
                conversation = s.ActionConversationId ?? throw new ValidationException($"{prefix}actionConversationId", "Choose a Messages channel.");
                if (!await db.Conversations.AnyAsync(c => c.Id == conversation && c.Type != ConversationType.Direct, ct))
                    throw new ValidationException($"{prefix}actionConversationId", "Channel not found: choose a group or project channel in Messages.");
                keepText = text;
                break;
            case AutomationAction.TellCustomer:
                keepText = text ?? throw new ValidationException($"{prefix}actionText", "Write what to tell the customer.");
                break;
        }
        return new AutomationStepDto(s.Action, priority, status, category, label, target, user, keepText, conversation);
    }

    private async Task<Guid> PersonAsync(Guid? id, string prefix, CancellationToken ct)
    {
        var uid = id ?? throw new ValidationException($"{prefix}actionUserId", "Choose a person.");
        await access.EnsureTenantMemberAsync(uid, $"{prefix}actionUserId", ct);
        return uid;
    }

    private async Task RequireStatusAsync(Guid projectId, Guid statusId, string field, CancellationToken ct)
    {
        if (!await db.WorkflowStatuses.AnyAsync(s => s.Id == statusId && s.ProjectId == projectId, ct))
            throw new ValidationException(field, "That status does not belong to this project.");
    }

    // ---------------------------------------------------------------- presentation

    private record Names(Dictionary<Guid, string> Statuses, Dictionary<Guid, string> Labels, Dictionary<Guid, string> Users, Dictionary<Guid, string> Channels);

    private async Task<Names> NamesAsync(Guid? projectId, CancellationToken ct)
    {
        var tid = ctx.RequireTenantId();
        return new Names(
            projectId is { } pid ? await db.WorkflowStatuses.Where(s => s.ProjectId == pid).ToDictionaryAsync(s => s.Id, s => s.Name, ct) : [],
            await db.Labels.ToDictionaryAsync(l => l.Id, l => l.Name, ct),
            await db.TenantMembers.Where(m => m.TenantId == tid).Join(db.Users, m => m.UserId, u => u.Id, (m, u) => new { u.Id, u.DisplayName }).ToDictionaryAsync(x => x.Id, x => x.DisplayName, ct),
            await db.Conversations.Where(c => c.Type != ConversationType.Direct).Select(c => new { c.Id, c.Name }).ToDictionaryAsync(x => x.Id, x => x.Name ?? "channel", ct));
    }

    /// <summary>The version-2 extras of a rule, or null for a rule in the original format (an array of later steps, or nothing).</summary>
    public static AutomationExtras? ExtrasOf(AutomationRule r)
    {
        var json = r.MoreActionsJson?.TrimStart();
        if (string.IsNullOrEmpty(json) || json[0] != '{') return null;
        try { return JsonSerializer.Deserialize<AutomationExtras>(json, Json); }
        catch (JsonException) { return null; }
    }

    public static IReadOnlyList<AutomationConditionDto> ConditionsOf(AutomationRule r) => ExtrasOf(r)?.Conditions ?? [];
    public static bool IsDraft(AutomationRule r) => ExtrasOf(r)?.Draft == true;

    public static IReadOnlyList<AutomationStepDto> StepsOf(AutomationRule r)
    {
        if (ExtrasOf(r)?.Steps is { Count: > 0 } all) return all;
        var first = new AutomationStepDto(r.Action, r.ActionPriority, r.ActionStatusId, r.ActionStatusCategory, r.ActionLabelId, r.ActionTarget, r.ActionUserId, r.ActionText);
        var more = string.IsNullOrEmpty(r.MoreActionsJson) ? [] : JsonSerializer.Deserialize<List<AutomationStepDto>>(r.MoreActionsJson, Json) ?? [];
        return [first, .. more];
    }

    private static AutomationRuleDto ToDto(AutomationRule r, Names n)
    {
        var steps = StepsOf(r);
        return new(r.Id, r.ProjectId, r.Name, r.IsEnabled, r.Trigger, r.WhenStatusId, r.WhenPriority,
            r.Action, r.ActionPriority, r.ActionStatusId, r.ActionLabelId, r.ActionTarget, r.ActionUserId, r.ActionText, Describe(r, steps, n), r.RunCount, r.LastRunAt,
            r.WhenStatusCategory, r.TriggerDays, r.ActionStatusCategory, steps.Skip(1).ToList(), ConditionsOf(r), IsDraft(r),
            steps[0].ActionConversationId, steps[0].ActionConversationId is { } cid ? n.Channels.GetValueOrDefault(cid) : null);
    }

    private static string Who(AutomationStepDto s, Names n) => s.ActionTarget switch
    {
        AutomationTarget.Reporter => "the reporter",
        AutomationTarget.Assignee => "the assignee",
        _ => s.ActionUserId is { } u && n.Users.TryGetValue(u, out var name) ? name : "someone",
    };

    private static string Category(StatusCategory? c) => c switch
    {
        StatusCategory.Todo => "a to-do status", StatusCategory.Active => "an in-progress status", StatusCategory.Done => "a done status",
        StatusCategory.Cancelled => "a cancelled status", _ => "any status",
    };

    /// <summary>The rule as a sentence, so people can read what it does at a glance.</summary>
    private static string Describe(AutomationRule r, IReadOnlyList<AutomationStepDto> steps, Names n)
    {
        var days = r.TriggerDays ?? 0;
        var when = r.Trigger switch
        {
            AutomationTrigger.TaskCreated => "a task is created",
            AutomationTrigger.StatusChanged when r.WhenStatusId is { } s => $"a task moves to “{(n.Statuses.GetValueOrDefault(s) ?? "?")}”",
            AutomationTrigger.StatusChanged when r.WhenStatusCategory is { } c => $"a task moves to {Category(c)}",
            AutomationTrigger.StatusChanged => "a task changes status",
            AutomationTrigger.PriorityChanged => r.WhenPriority is { } p ? $"a task's priority becomes {p}" : "a task's priority changes",
            AutomationTrigger.DueSoon => days == 0 ? "an open task is due today" : $"an open task is due within {days} day{(days == 1 ? "" : "s")}",
            AutomationTrigger.Overdue => days == 0 ? "an open task becomes overdue" : $"an open task is {days} day{(days == 1 ? "" : "s")} overdue",
            AutomationTrigger.TicketCreated => "a Desk ticket is created",
            AutomationTrigger.TicketChanged => "a Desk ticket is created or updated",
            AutomationTrigger.TicketWaiting => $"a Desk ticket has had no agent reply for {days} minute{(days == 1 ? "" : "s")}",
            AutomationTrigger.TicketResolved => days == 0 ? "a Desk ticket is resolved" : $"a Desk ticket has been resolved for {days} day{(days == 1 ? "" : "s")}",
            _ => $"an open task has not changed for {days} day{(days == 1 ? "" : "s")}",
        };
        var ifs = ConditionsOf(r).Select(c => c.Field switch
        {
            "priority" => $"priority is {c.Value}",
            "status" => IsTicket(r.Trigger) ? $"status is {c.Value}" : $"it is in {Category(Enum.TryParse<StatusCategory>(c.Value, out var sc) ? sc : null)}",
            "unassigned" => "nobody is assigned",
            "businessHours" => "it is within business hours",
            _ => $"no agent has replied for {c.Minutes} minutes",
        }).ToList();
        var condition = ifs.Count == 0 ? "" : $" and {string.Join(" and ", ifs)}";
        string Then(AutomationStepDto s) => s.Action switch
        {
            AutomationAction.SetPriority => $"set the priority to {s.ActionPriority}",
            AutomationAction.MoveToStatus when s.ActionStatusId is { } st => $"move it to “{n.Statuses.GetValueOrDefault(st) ?? "?"}”",
            AutomationAction.MoveToStatus => $"move it to {Category(s.ActionStatusCategory)}",
            AutomationAction.AddLabel => $"add the label “{(s.ActionLabelId is { } l ? n.Labels.GetValueOrDefault(l) ?? "?" : "?")}”",
            AutomationAction.SetAssignee => $"assign it to {Who(s, n)}",
            AutomationAction.Notify => $"notify {Who(s, n)}",
            AutomationAction.PostToChannel => $"post in #{(s.ActionConversationId is { } c ? n.Channels.GetValueOrDefault(c) ?? "channel" : "channel")}",
            AutomationAction.TellCustomer => "tell the customer",
            AutomationAction.CloseTicket => "close it",
            _ => "post a comment",
        };
        var thens = steps.Select(Then).ToList();
        var joined = thens.Count == 1 ? thens[0] : $"{string.Join(", ", thens.Take(thens.Count - 1))} and {thens[^1]}";
        return $"When {when}{(r.ProjectId is null && !IsTicket(r.Trigger) ? " in any project" : "")}{condition}, {joined}.";
    }
}

/// <summary>
/// Runs rules for a task event, inside the caller's unit of work (nothing here saves): the project's rules and the workspace's. Actions never
/// trigger further rules, so rules cannot loop. Workspaces on a plan without automation simply run nothing.
/// </summary>
public class AutomationEngine(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, NotificationService notifications,
    EntitlementService entitlements, PlanningService planning, TaskCompletionService completion)
{
    public async Task RunAsync(TaskItem task, string taskKey, AutomationTrigger trigger, Guid? newStatusId = null, Priority? newPriority = null,
        IReadOnlyCollection<Guid>? labelsAlreadyOnTask = null, CancellationToken ct = default)
    {
        if (await entitlements.GetValueAsync(FeatureKeys.Automation, ct) == 0) return;
        var rules = await db.AutomationRules.Where(r => (r.ProjectId == task.ProjectId || r.ProjectId == null) && r.IsEnabled && r.Trigger == trigger)
            .OrderBy(r => r.ProjectId == null).ThenBy(r => r.CreatedAt).ToListAsync(ct);
        if (rules.Count == 0) return;

        StatusCategory? newCategory = newStatusId is { } sid ? await db.WorkflowStatuses.Where(s => s.Id == sid).Select(s => (StatusCategory?)s.Category).FirstOrDefaultAsync(ct) : null;
        var labels = (labelsAlreadyOnTask ?? await db.TaskLabels.Where(l => l.TaskId == task.Id).Select(l => l.LabelId).ToListAsync(ct)).ToHashSet();
        foreach (var rule in rules)
        {
            if (rule.WhenStatusId is { } ws && ws != newStatusId) continue;
            if (rule.WhenStatusCategory is { } wc && wc != newCategory) continue;
            if (rule.WhenPriority is { } wp && wp != newPriority) continue;
            if (!await ConditionsHoldAsync(rule, task, newCategory, ct)) continue;
            await ApplyRuleAsync(rule, task, taskKey, labels, ct);
        }
    }

    private AutomationHours? _hours;

    /// <summary>The rule's "If" conditions (all of them) against the task as it is now; drafts never run.</summary>
    public async Task<bool> ConditionsHoldAsync(AutomationRule rule, TaskItem task, StatusCategory? category, CancellationToken ct)
    {
        if (AutomationService.IsDraft(rule)) return false;
        var conditions = AutomationService.ConditionsOf(rule);
        if (conditions.Count == 0) return true;
        _hours ??= await AutomationHours.LoadAsync(db, clock, ct);
        category ??= await db.WorkflowStatuses.Where(s => s.Id == task.StatusId).Select(s => (StatusCategory?)s.Category).FirstOrDefaultAsync(ct);
        return AutomationConditions.Failing(conditions, task.Priority, category?.ToString(), task.AssigneeId, task.CreatedAt, null, clock.Now, _hours) is null;
    }

    /// <summary>
    /// Does everything a rule says to one task; records the run when anything happened. Returns whether it did something. A scheduled run acts
    /// as the rule's author, so its notifications reach them too (an event run never notifies the person who caused the event).
    /// </summary>
    public async Task<bool> ApplyRuleAsync(AutomationRule rule, TaskItem task, string taskKey, HashSet<Guid> labels, CancellationToken ct, bool scheduled = false)
    {
        // Guardrail: a rule that fires too often (a bulk import, a misconfigured trigger) pauses for the rest of the hour.
        if (!AutomationRunLimiter.Allowed(rule.Id, clock.Now)) return false;
        var outcomes = new List<string>();
        foreach (var step in AutomationService.StepsOf(rule))
            if (await ApplyAsync(rule, step, task, taskKey, labels, scheduled, ct) is { } done) outcomes.Add(done);
        if (outcomes.Count == 0) return false;
        AutomationRunLimiter.Record(rule.Id, clock.Now);
        rule.RunCount++; rule.LastRunAt = clock.Now;
        recorder.Activity("task.automation", "Task", task.Id, $"{taskKey}: automation “{rule.Name}” {string.Join(", ", outcomes)}", task.ProjectId);
        return true;
    }

    /// <summary>Returns what was done, or null when the action did not apply (for example nobody is assigned).</summary>
    private async Task<string?> ApplyAsync(AutomationRule rule, AutomationStepDto step, TaskItem task, string key, HashSet<Guid> labels, bool scheduled, CancellationToken ct)
    {
        var link = $"/projects/{task.ProjectId}?task={task.Id}";
        switch (step.Action)
        {
            case AutomationAction.SetPriority when step.ActionPriority is { } p:
                if (task.Priority == p) return null;
                task.Priority = p;
                return $"set the priority to {p}";

            case AutomationAction.MoveToStatus:
            {
                var status = step.ActionStatusId is { } sid
                    ? await db.WorkflowStatuses.FirstOrDefaultAsync(s => s.Id == sid && s.ProjectId == task.ProjectId, ct)
                    : step.ActionStatusCategory is { } cat
                        ? await db.WorkflowStatuses.Where(s => s.ProjectId == task.ProjectId && s.Category == cat).OrderBy(s => s.Order).FirstOrDefaultAsync(ct)
                        : null;
                if (status is null || task.StatusId == status.Id) return null;
                if (await planning.BlockedReasonAsync(task, status.Category, ct) is not null) return null; // dependencies still win
                if (await completion.IsBlockedFromCompletingAsync(task, status, ct)) return null; // open subtasks / checklist items still win
                var wasDone = task.CompletedAt is not null;
                task.StatusId = status.Id;
                task.CompletedAt = status.Category == StatusCategory.Done ? (wasDone ? task.CompletedAt : clock.Now) : null;
                task.Position = (await db.Tasks.Where(t => t.ProjectId == task.ProjectId && t.StatusId == status.Id).MaxAsync(t => (double?)t.Position, ct) ?? 0) + 1000;
                return $"moved the task to “{status.Name}”";
            }

            case AutomationAction.AddLabel when step.ActionLabelId is { } lid:
                if (!labels.Add(lid) || !await db.Labels.AnyAsync(l => l.Id == lid, ct)) return null;
                db.TaskLabels.Add(new TaskLabel { TenantId = task.TenantId, TaskId = task.Id, LabelId = lid, CreatedAt = clock.Now });
                return "added a label";

            case AutomationAction.SetAssignee:
            {
                var uid = step.ActionTarget == AutomationTarget.Reporter ? task.ReporterId : step.ActionUserId;
                if (uid is not { } who || task.AssigneeId == who) return null;
                if (!await db.TenantMembers.AnyAsync(m => m.TenantId == task.TenantId && m.UserId == who, ct)) return null;
                task.AssigneeId = who;
                await notifications.AddAsync(who, NotificationType.TaskAssigned, $"You were assigned {key}", task.Title, link, toSelf: scheduled, ct: ct);
                return "assigned the task";
            }

            case AutomationAction.Notify:
            {
                var uid = step.ActionTarget switch { AutomationTarget.Reporter => task.ReporterId, AutomationTarget.Assignee => task.AssigneeId, _ => step.ActionUserId };
                if (uid is not { } who) return null;
                await notifications.AddAsync(who, NotificationType.Comment, $"{key}: {rule.Name}", step.ActionText ?? task.Title, link, toSelf: scheduled, ct: ct);
                return "sent a notification";
            }

            case AutomationAction.AddComment when !string.IsNullOrWhiteSpace(step.ActionText):
                db.TaskComments.Add(new TaskComment
                {
                    TenantId = task.TenantId, TaskId = task.Id, AuthorId = ctx.RequireUserId(), Body = $"🤖 {step.ActionText}", CreatedAt = clock.Now, CreatedBy = ctx.UserId,
                });
                return "posted a comment";

            case AutomationAction.PostToChannel when step.ActionConversationId is { } cid:
                return await AutomationChannel.PostAsync(db, clock, task.TenantId, cid, $"⚡ {key} · {task.Title} — {step.ActionText ?? rule.Name}", ct) ? "posted in Messages" : null;
        }
        return null;
    }
}

/// <summary>
/// Runs the time-based rules (due soon, overdue, no changes for a while) across every workspace, from a background worker. Each rule acts as
/// the person who wrote it (or the workspace owner when they have left), and runs once per task per period - a due date, or a quiet spell -
/// so it never repeats itself; moving the due date or touching the task starts a new period.
/// </summary>
public class AutomationScheduler(IAppDbContext db, CurrentContext cc, AppClock clock, AutomationEngine engine, EntitlementService entitlements, ILogger<AutomationScheduler> log)
{
    private const int PerRule = 200;

    public async Task<int> RunAsync(CancellationToken ct = default)
    {
        var scheduled = new[] { AutomationTrigger.DueSoon, AutomationTrigger.Overdue, AutomationTrigger.Stale };
        var rules = await db.AutomationRules.IgnoreQueryFilters().AsNoTracking()
            .Where(r => r.IsEnabled && scheduled.Contains(r.Trigger) && db.Tenants.IgnoreQueryFilters().Any(t => t.Id == r.TenantId && t.Status == TenantStatus.Active && !t.IsDeleted))
            .Select(r => new { r.Id, r.TenantId }).ToListAsync(ct);
        var total = 0;
        foreach (var tenant in rules.GroupBy(r => r.TenantId))
        {
            try { total += await RunTenantAsync(tenant.Key, tenant.Select(r => r.Id).ToList(), ct); }
            catch (Exception ex) when (ex is not OperationCanceledException) { log.LogError(ex, "Scheduled automation failed for workspace {Tenant}", tenant.Key); }
        }
        return total;
    }

    private async Task<int> RunTenantAsync(Guid tenantId, List<Guid> ruleIds, CancellationToken ct)
    {
        if ((await entitlements.GetEntitlementsAsync(tenantId, ct)).GetValueOrDefault(FeatureKeys.Automation) <= 0) return 0;
        var tenant = await db.Tenants.IgnoreQueryFilters().AsNoTracking().FirstAsync(t => t.Id == tenantId, ct);
        cc.TenantId = tenantId; cc.WorkspaceType = tenant.Type; cc.IsPlatformAdmin = false;
        var today = clock.Today;
        var done = 0;
        foreach (var ruleId in ruleIds)
        {
            var rule = await db.AutomationRules.FirstAsync(r => r.Id == ruleId, ct);
            var actor = await db.TenantMembers.AsNoTracking().FirstOrDefaultAsync(m => m.TenantId == tenantId && m.UserId == rule.CreatedBy, ct)
                ?? await db.TenantMembers.AsNoTracking().FirstOrDefaultAsync(m => m.TenantId == tenantId && m.UserId == tenant.OwnerUserId, ct);
            if (actor is null) continue;
            cc.UserId = actor.UserId; cc.Role = actor.Role;

            var days = rule.TriggerDays ?? 0;
            var open = db.Tasks.Where(t => (rule.ProjectId == null || t.ProjectId == rule.ProjectId)
                && t.Status!.Category != StatusCategory.Done && t.Status.Category != StatusCategory.Cancelled
                && db.Projects.Any(p => p.Id == t.ProjectId && p.Status != ProjectStatus.Archived));
            var soon = today.AddDays(days); var late = today.AddDays(-days); var quietSince = clock.Now.AddDays(-days);
            var matching = rule.Trigger switch
            {
                AutomationTrigger.DueSoon => open.Where(t => t.DueDate != null && t.DueDate >= today && t.DueDate <= soon),
                AutomationTrigger.Overdue => open.Where(t => t.DueDate != null && t.DueDate < today && t.DueDate <= late),
                _ => open.Where(t => (t.UpdatedAt ?? t.CreatedAt) <= quietSince),
            };
            // The period: the due date (moving it starts a new one), or the moment of the last change (touching the task does).
            var candidates = (await matching.OrderBy(t => t.DueDate).Select(t => new { t.Id, t.DueDate, Changed = t.UpdatedAt ?? t.CreatedAt }).Take(PerRule * 2).ToListAsync(ct))
                .Select(t => new { t.Id, Period = rule.Trigger == AutomationTrigger.Stale ? t.Changed.ToString("yyyyMMddHHmm") : t.DueDate!.Value.ToString("yyyy-MM-dd") }).ToList();
            if (candidates.Count == 0) continue;
            var ids = candidates.Select(c => c.Id).ToList();
            var ran = (await db.AutomationRuns.Where(x => x.RuleId == rule.Id && ids.Contains(x.TaskId)).Select(x => new { x.TaskId, x.Period }).ToListAsync(ct))
                .Select(x => (x.TaskId, x.Period)).ToHashSet();
            foreach (var c in candidates.Select(c => (c.Id, Period: Short(c.Period))).Where(c => !ran.Contains(c)).Take(PerRule))
            {
                var task = await db.Tasks.FirstAsync(t => t.Id == c.Id, ct);
                if (!await engine.ConditionsHoldAsync(rule, task, null, ct)) continue;   // not now (outside business hours, ...): looked at again next time
                var key = $"{await db.Projects.Where(p => p.Id == task.ProjectId).Select(p => p.Key).FirstAsync(ct)}-{task.Number}";
                var labels = (await db.TaskLabels.Where(l => l.TaskId == task.Id).Select(l => l.LabelId).ToListAsync(ct)).ToHashSet();
                if (await engine.ApplyRuleAsync(rule, task, key, labels, ct, scheduled: true)) done++;
                db.AutomationRuns.Add(new AutomationRun { TenantId = tenantId, RuleId = rule.Id, TaskId = task.Id, Period = c.Period, CreatedAt = clock.Now });
                await db.SaveChangesAsync(ct);
            }
        }
        return done;
    }

    /// <summary>The period as stored (at most 20 characters): a date, or the minute of the last change.</summary>
    private static string Short(string period) => period.Length <= 20 ? period : period[..20];
}

/// <summary>
/// At most <see cref="MaxRunsPerHour"/> runs of one rule in any hour, per server process. Together with "actions never trigger further rules",
/// this keeps a rule from flooding people (it cannot trigger itself, and it cannot run away on a bulk change).
/// </summary>
public static class AutomationRunLimiter
{
    public const int MaxRunsPerHour = 100;
    private static readonly ConcurrentDictionary<Guid, Queue<DateTime>> Runs = new();

    public static bool Allowed(Guid ruleId, DateTime now)
    {
        if (!Runs.TryGetValue(ruleId, out var q)) return true;
        lock (q)
        {
            while (q.Count > 0 && q.Peek() <= now.AddHours(-1)) q.Dequeue();
            return q.Count < MaxRunsPerHour;
        }
    }

    public static void Record(Guid ruleId, DateTime now)
    {
        var q = Runs.GetOrAdd(ruleId, _ => new Queue<DateTime>());
        lock (q) q.Enqueue(now);
    }
}
