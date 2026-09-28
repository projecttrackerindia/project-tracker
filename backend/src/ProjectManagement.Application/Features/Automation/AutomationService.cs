using Microsoft.EntityFrameworkCore;
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

public record AutomationRuleDto(Guid Id, Guid ProjectId, string Name, bool IsEnabled, AutomationTrigger Trigger, Guid? WhenStatusId, Priority? WhenPriority,
    AutomationAction Action, Priority? ActionPriority, Guid? ActionStatusId, Guid? ActionLabelId, AutomationTarget ActionTarget, Guid? ActionUserId, string? ActionText,
    string Summary, int RunCount, DateTime? LastRunAt);

public record UpsertAutomationRequest(string Name, bool IsEnabled, AutomationTrigger Trigger, Guid? WhenStatusId, Priority? WhenPriority,
    AutomationAction Action, Priority? ActionPriority, Guid? ActionStatusId, Guid? ActionLabelId, AutomationTarget? ActionTarget, Guid? ActionUserId, string? ActionText);

/// <summary>Creates and edits the automation rules of a project. Needs a plan that includes automation and edit rights on the project.</summary>
public class AutomationService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, ProjectAccess access, EntitlementService entitlements)
{
    private const int MaxRulesPerProject = 50;

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
        var rule = new AutomationRule { TenantId = ctx.RequireTenantId(), ProjectId = project.Id, CreatedAt = clock.Now, CreatedBy = ctx.RequireUserId() };
        await ApplyAsync(rule, req, ct);
        db.AutomationRules.Add(rule);
        recorder.Audit("automation.created", "AutomationRule", rule.Id, newValue: new { rule.Name, rule.Trigger, rule.Action });
        await db.SaveChangesAsync(ct);
        return await GetAsync(rule.Id, ct);
    }

    public async Task<AutomationRuleDto> UpdateAsync(Guid projectId, Guid id, UpsertAutomationRequest req, CancellationToken ct = default)
    {
        await RequireEditableAsync(projectId, ct);
        var rule = await db.AutomationRules.FirstOrDefaultAsync(r => r.Id == id && r.ProjectId == projectId, ct) ?? throw new NotFoundException("Rule not found.");
        await ApplyAsync(rule, req, ct);
        rule.UpdatedAt = clock.Now;
        recorder.Audit("automation.updated", "AutomationRule", rule.Id, newValue: new { rule.Name, rule.IsEnabled });
        await db.SaveChangesAsync(ct);
        return await GetAsync(id, ct);
    }

    public async Task DeleteAsync(Guid projectId, Guid id, CancellationToken ct = default)
    {
        await RequireEditableAsync(projectId, ct);
        var rule = await db.AutomationRules.FirstOrDefaultAsync(r => r.Id == id && r.ProjectId == projectId, ct) ?? throw new NotFoundException("Rule not found.");
        db.AutomationRules.Remove(rule);
        recorder.Audit("automation.deleted", "AutomationRule", id, oldValue: new { rule.Name });
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

        rule.Name = name; rule.IsEnabled = req.IsEnabled;
        rule.Trigger = req.Trigger;
        rule.WhenStatusId = req.Trigger == AutomationTrigger.StatusChanged ? req.WhenStatusId : null;
        rule.WhenPriority = req.Trigger == AutomationTrigger.PriorityChanged ? req.WhenPriority : null;
        if (rule.WhenStatusId is { } ws) await RequireStatusAsync(rule.ProjectId, ws, "whenStatusId", ct);

        rule.Action = req.Action;
        rule.ActionPriority = null; rule.ActionStatusId = null; rule.ActionLabelId = null; rule.ActionUserId = null; rule.ActionText = null;
        rule.ActionTarget = AutomationTarget.User;
        var text = string.IsNullOrWhiteSpace(req.ActionText) ? null : req.ActionText.Trim();
        if (text is { Length: > 500 }) throw new ValidationException("actionText", "Keep the message under 500 characters.");

        switch (req.Action)
        {
            case AutomationAction.SetPriority:
                rule.ActionPriority = req.ActionPriority ?? throw new ValidationException("actionPriority", "Choose a priority.");
                break;
            case AutomationAction.MoveToStatus:
                rule.ActionStatusId = req.ActionStatusId ?? throw new ValidationException("actionStatusId", "Choose a status.");
                await RequireStatusAsync(rule.ProjectId, rule.ActionStatusId.Value, "actionStatusId", ct);
                break;
            case AutomationAction.AddLabel:
                rule.ActionLabelId = req.ActionLabelId ?? throw new ValidationException("actionLabelId", "Choose a label.");
                if (!await db.Labels.AnyAsync(l => l.Id == rule.ActionLabelId, ct)) throw new ValidationException("actionLabelId", "Label not found.");
                break;
            case AutomationAction.SetAssignee:
                if ((req.ActionTarget ?? AutomationTarget.User) == AutomationTarget.Assignee)
                    throw new ValidationException("actionTarget", "Assign to a person or to the task's reporter.");
                await ApplyTargetAsync(rule, req, ct);
                break;
            case AutomationAction.Notify:
                await ApplyTargetAsync(rule, req, ct);
                rule.ActionText = text;
                break;
            case AutomationAction.AddComment:
                rule.ActionText = text ?? throw new ValidationException("actionText", "Write the comment to post.");
                break;
        }
    }

    private async Task ApplyTargetAsync(AutomationRule rule, UpsertAutomationRequest req, CancellationToken ct)
    {
        rule.ActionTarget = req.ActionTarget ?? AutomationTarget.User;
        if (rule.ActionTarget != AutomationTarget.User) return;
        var uid = req.ActionUserId ?? throw new ValidationException("actionUserId", "Choose a person.");
        await access.EnsureTenantMemberAsync(uid, "actionUserId", ct);
        rule.ActionUserId = uid;
    }

    private async Task RequireStatusAsync(Guid projectId, Guid statusId, string field, CancellationToken ct)
    {
        if (!await db.WorkflowStatuses.AnyAsync(s => s.Id == statusId && s.ProjectId == projectId, ct))
            throw new ValidationException(field, "That status does not belong to this project.");
    }

    // ---------------------------------------------------------------- presentation

    private record Names(Dictionary<Guid, string> Statuses, Dictionary<Guid, string> Labels, Dictionary<Guid, string> Users);

    private async Task<Names> NamesAsync(Guid projectId, CancellationToken ct)
    {
        var tid = ctx.RequireTenantId();
        return new Names(
            await db.WorkflowStatuses.Where(s => s.ProjectId == projectId).ToDictionaryAsync(s => s.Id, s => s.Name, ct),
            await db.Labels.ToDictionaryAsync(l => l.Id, l => l.Name, ct),
            await db.TenantMembers.Where(m => m.TenantId == tid).Join(db.Users, m => m.UserId, u => u.Id, (m, u) => new { u.Id, u.DisplayName }).ToDictionaryAsync(x => x.Id, x => x.DisplayName, ct));
    }

    private static AutomationRuleDto ToDto(AutomationRule r, Names n) => new(r.Id, r.ProjectId, r.Name, r.IsEnabled, r.Trigger, r.WhenStatusId, r.WhenPriority,
        r.Action, r.ActionPriority, r.ActionStatusId, r.ActionLabelId, r.ActionTarget, r.ActionUserId, r.ActionText, Describe(r, n), r.RunCount, r.LastRunAt);

    private static string Who(AutomationRule r, Names n) => r.ActionTarget switch
    {
        AutomationTarget.Reporter => "the reporter",
        AutomationTarget.Assignee => "the assignee",
        _ => r.ActionUserId is { } u && n.Users.TryGetValue(u, out var name) ? name : "someone",
    };

    /// <summary>The rule as a sentence, so people can read what it does at a glance.</summary>
    private static string Describe(AutomationRule r, Names n)
    {
        var when = r.Trigger switch
        {
            AutomationTrigger.TaskCreated => "a task is created",
            AutomationTrigger.StatusChanged => r.WhenStatusId is { } s ? $"a task moves to “{(n.Statuses.GetValueOrDefault(s) ?? "?")}”" : "a task changes status",
            _ => r.WhenPriority is { } p ? $"a task's priority becomes {p}" : "a task's priority changes",
        };
        var then = r.Action switch
        {
            AutomationAction.SetPriority => $"set the priority to {r.ActionPriority}",
            AutomationAction.MoveToStatus => $"move it to “{(r.ActionStatusId is { } st ? n.Statuses.GetValueOrDefault(st) ?? "?" : "?")}”",
            AutomationAction.AddLabel => $"add the label “{(r.ActionLabelId is { } l ? n.Labels.GetValueOrDefault(l) ?? "?" : "?")}”",
            AutomationAction.SetAssignee => $"assign it to {Who(r, n)}",
            AutomationAction.Notify => $"notify {Who(r, n)}",
            _ => "post a comment",
        };
        return $"When {when}, {then}.";
    }
}

/// <summary>
/// Runs a project's rules for a task event, inside the caller's unit of work (nothing here saves). Actions never trigger further rules,
/// so rules cannot loop. Projects on a plan without automation simply run nothing.
/// </summary>
public class AutomationEngine(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, NotificationService notifications,
    EntitlementService entitlements, PlanningService planning, TaskCompletionService completion)
{
    public async Task RunAsync(TaskItem task, string taskKey, AutomationTrigger trigger, Guid? newStatusId = null, Priority? newPriority = null,
        IReadOnlyCollection<Guid>? labelsAlreadyOnTask = null, CancellationToken ct = default)
    {
        if (await entitlements.GetValueAsync(FeatureKeys.Automation, ct) == 0) return;
        var rules = await db.AutomationRules.Where(r => r.ProjectId == task.ProjectId && r.IsEnabled && r.Trigger == trigger).OrderBy(r => r.CreatedAt).ToListAsync(ct);
        if (rules.Count == 0) return;

        var labels = (labelsAlreadyOnTask ?? await db.TaskLabels.Where(l => l.TaskId == task.Id).Select(l => l.LabelId).ToListAsync(ct)).ToHashSet();
        foreach (var rule in rules)
        {
            if (rule.WhenStatusId is { } ws && ws != newStatusId) continue;
            if (rule.WhenPriority is { } wp && wp != newPriority) continue;
            var outcome = await ApplyAsync(rule, task, taskKey, labels, ct);
            if (outcome is null) continue;
            rule.RunCount++; rule.LastRunAt = clock.Now;
            recorder.Activity("task.automation", "Task", task.Id, $"{taskKey}: automation “{rule.Name}” {outcome}", task.ProjectId);
        }
    }

    /// <summary>Returns what was done, or null when the rule did not apply (for example nobody is assigned).</summary>
    private async Task<string?> ApplyAsync(AutomationRule rule, TaskItem task, string key, HashSet<Guid> labels, CancellationToken ct)
    {
        var link = $"/projects/{task.ProjectId}?task={task.Id}";
        switch (rule.Action)
        {
            case AutomationAction.SetPriority when rule.ActionPriority is { } p:
                if (task.Priority == p) return null;
                task.Priority = p;
                return $"set the priority to {p}";

            case AutomationAction.MoveToStatus when rule.ActionStatusId is { } sid:
            {
                if (task.StatusId == sid) return null;
                var status = await db.WorkflowStatuses.FirstOrDefaultAsync(s => s.Id == sid && s.ProjectId == task.ProjectId, ct);
                if (status is null) return null;
                if (await planning.BlockedReasonAsync(task, status.Category, ct) is not null) return null; // dependencies still win
                if (await completion.IsBlockedFromCompletingAsync(task, status, ct)) return null; // open subtasks / checklist items still win
                var wasDone = task.CompletedAt is not null;
                task.StatusId = status.Id;
                task.CompletedAt = status.Category == StatusCategory.Done ? (wasDone ? task.CompletedAt : clock.Now) : null;
                task.Position = (await db.Tasks.Where(t => t.ProjectId == task.ProjectId && t.StatusId == sid).MaxAsync(t => (double?)t.Position, ct) ?? 0) + 1000;
                return $"moved the task to “{status.Name}”";
            }

            case AutomationAction.AddLabel when rule.ActionLabelId is { } lid:
                if (!labels.Add(lid) || !await db.Labels.AnyAsync(l => l.Id == lid, ct)) return null;
                db.TaskLabels.Add(new TaskLabel { TenantId = task.TenantId, TaskId = task.Id, LabelId = lid, CreatedAt = clock.Now });
                return "added a label";

            case AutomationAction.SetAssignee:
            {
                var uid = rule.ActionTarget == AutomationTarget.Reporter ? task.ReporterId : rule.ActionUserId;
                if (uid is not { } who || task.AssigneeId == who) return null;
                if (!await db.TenantMembers.AnyAsync(m => m.TenantId == task.TenantId && m.UserId == who, ct)) return null;
                task.AssigneeId = who;
                await notifications.AddAsync(who, NotificationType.TaskAssigned, $"You were assigned {key}", task.Title, link, ct: ct);
                return "assigned the task";
            }

            case AutomationAction.Notify:
            {
                var uid = rule.ActionTarget switch { AutomationTarget.Reporter => task.ReporterId, AutomationTarget.Assignee => task.AssigneeId, _ => rule.ActionUserId };
                if (uid is not { } who) return null;
                await notifications.AddAsync(who, NotificationType.Comment, $"{key}: {rule.Name}", rule.ActionText ?? task.Title, link, ct: ct);
                return "sent a notification";
            }

            case AutomationAction.AddComment when !string.IsNullOrWhiteSpace(rule.ActionText):
                db.TaskComments.Add(new TaskComment
                {
                    TenantId = task.TenantId, TaskId = task.Id, AuthorId = ctx.RequireUserId(), Body = $"🤖 {rule.ActionText}", CreatedAt = clock.Now, CreatedBy = ctx.UserId,
                });
                return "posted a comment";
        }
        return null;
    }
}
