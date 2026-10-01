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
    AutomationTarget ActionTarget, Guid? ActionUserId, string? ActionText);

public record AutomationRuleDto(Guid Id, Guid? ProjectId, string Name, bool IsEnabled, AutomationTrigger Trigger, Guid? WhenStatusId, Priority? WhenPriority,
    AutomationAction Action, Priority? ActionPriority, Guid? ActionStatusId, Guid? ActionLabelId, AutomationTarget ActionTarget, Guid? ActionUserId, string? ActionText,
    string Summary, int RunCount, DateTime? LastRunAt, StatusCategory? WhenStatusCategory = null, int? TriggerDays = null, StatusCategory? ActionStatusCategory = null,
    IReadOnlyList<AutomationStepDto>? MoreActions = null);

public record AutomationStepRequest(AutomationAction Action, Priority? ActionPriority, Guid? ActionStatusId, StatusCategory? ActionStatusCategory, Guid? ActionLabelId,
    AutomationTarget? ActionTarget, Guid? ActionUserId, string? ActionText);

/// <summary>The first action is in the Action* fields; <see cref="MoreActions"/> are done after it, in order (at most 4 more).</summary>
public record UpsertAutomationRequest(string Name, bool IsEnabled, AutomationTrigger Trigger, Guid? WhenStatusId, Priority? WhenPriority,
    AutomationAction Action, Priority? ActionPriority, Guid? ActionStatusId, Guid? ActionLabelId, AutomationTarget? ActionTarget, Guid? ActionUserId, string? ActionText,
    StatusCategory? WhenStatusCategory = null, int? TriggerDays = null, StatusCategory? ActionStatusCategory = null, IReadOnlyList<AutomationStepRequest>? MoreActions = null);

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
    internal static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static bool IsScheduled(AutomationTrigger t) => t is AutomationTrigger.DueSoon or AutomationTrigger.Overdue or AutomationTrigger.Stale;

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

        rule.Name = name; rule.IsEnabled = req.IsEnabled;
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

        var first = await StepAsync(rule.ProjectId, new AutomationStepRequest(req.Action, req.ActionPriority, req.ActionStatusId, req.ActionStatusCategory, req.ActionLabelId,
            req.ActionTarget, req.ActionUserId, req.ActionText), "", ct);
        rule.Action = first.Action; rule.ActionPriority = first.ActionPriority; rule.ActionStatusId = first.ActionStatusId; rule.ActionStatusCategory = first.ActionStatusCategory;
        rule.ActionLabelId = first.ActionLabelId; rule.ActionTarget = first.ActionTarget; rule.ActionUserId = first.ActionUserId; rule.ActionText = first.ActionText;

        var more = req.MoreActions ?? [];
        if (more.Count > MaxMoreActions) throw new ValidationException("moreActions", $"A rule can do at most {MaxMoreActions + 1} things.");
        var steps = new List<AutomationStepDto>();
        for (var i = 0; i < more.Count; i++) steps.Add(await StepAsync(rule.ProjectId, more[i], $"moreActions[{i}].", ct));
        rule.MoreActionsJson = steps.Count == 0 ? null : JsonSerializer.Serialize(steps, Json);
    }

    /// <summary>Checks one action and keeps only the fields it uses.</summary>
    private async Task<AutomationStepDto> StepAsync(Guid? projectId, AutomationStepRequest s, string prefix, CancellationToken ct)
    {
        if (!Enum.IsDefined(s.Action)) throw new ValidationException($"{prefix}action", "Choose what the rule does.");
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
        }
        return new AutomationStepDto(s.Action, priority, status, category, label, target, user, keepText);
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

    private record Names(Dictionary<Guid, string> Statuses, Dictionary<Guid, string> Labels, Dictionary<Guid, string> Users);

    private async Task<Names> NamesAsync(Guid? projectId, CancellationToken ct)
    {
        var tid = ctx.RequireTenantId();
        return new Names(
            projectId is { } pid ? await db.WorkflowStatuses.Where(s => s.ProjectId == pid).ToDictionaryAsync(s => s.Id, s => s.Name, ct) : [],
            await db.Labels.ToDictionaryAsync(l => l.Id, l => l.Name, ct),
            await db.TenantMembers.Where(m => m.TenantId == tid).Join(db.Users, m => m.UserId, u => u.Id, (m, u) => new { u.Id, u.DisplayName }).ToDictionaryAsync(x => x.Id, x => x.DisplayName, ct));
    }

    public static IReadOnlyList<AutomationStepDto> StepsOf(AutomationRule r)
    {
        var first = new AutomationStepDto(r.Action, r.ActionPriority, r.ActionStatusId, r.ActionStatusCategory, r.ActionLabelId, r.ActionTarget, r.ActionUserId, r.ActionText);
        var more = string.IsNullOrEmpty(r.MoreActionsJson) ? [] : JsonSerializer.Deserialize<List<AutomationStepDto>>(r.MoreActionsJson, Json) ?? [];
        return [first, .. more];
    }

    private static AutomationRuleDto ToDto(AutomationRule r, Names n)
    {
        var steps = StepsOf(r);
        return new(r.Id, r.ProjectId, r.Name, r.IsEnabled, r.Trigger, r.WhenStatusId, r.WhenPriority,
            r.Action, r.ActionPriority, r.ActionStatusId, r.ActionLabelId, r.ActionTarget, r.ActionUserId, r.ActionText, Describe(r, steps, n), r.RunCount, r.LastRunAt,
            r.WhenStatusCategory, r.TriggerDays, r.ActionStatusCategory, steps.Skip(1).ToList());
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
            _ => $"an open task has not changed for {days} day{(days == 1 ? "" : "s")}",
        };
        string Then(AutomationStepDto s) => s.Action switch
        {
            AutomationAction.SetPriority => $"set the priority to {s.ActionPriority}",
            AutomationAction.MoveToStatus when s.ActionStatusId is { } st => $"move it to “{n.Statuses.GetValueOrDefault(st) ?? "?"}”",
            AutomationAction.MoveToStatus => $"move it to {Category(s.ActionStatusCategory)}",
            AutomationAction.AddLabel => $"add the label “{(s.ActionLabelId is { } l ? n.Labels.GetValueOrDefault(l) ?? "?" : "?")}”",
            AutomationAction.SetAssignee => $"assign it to {Who(s, n)}",
            AutomationAction.Notify => $"notify {Who(s, n)}",
            _ => "post a comment",
        };
        var thens = steps.Select(Then).ToList();
        var joined = thens.Count == 1 ? thens[0] : $"{string.Join(", ", thens.Take(thens.Count - 1))} and {thens[^1]}";
        return $"When {when}{(r.ProjectId is null ? " in any project" : "")}, {joined}.";
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
            await ApplyRuleAsync(rule, task, taskKey, labels, ct);
        }
    }

    /// <summary>
    /// Does everything a rule says to one task; records the run when anything happened. Returns whether it did something. A scheduled run acts
    /// as the rule's author, so its notifications reach them too (an event run never notifies the person who caused the event).
    /// </summary>
    public async Task<bool> ApplyRuleAsync(AutomationRule rule, TaskItem task, string taskKey, HashSet<Guid> labels, CancellationToken ct, bool scheduled = false)
    {
        var outcomes = new List<string>();
        foreach (var step in AutomationService.StepsOf(rule))
            if (await ApplyAsync(rule, step, task, taskKey, labels, scheduled, ct) is { } done) outcomes.Add(done);
        if (outcomes.Count == 0) return false;
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
