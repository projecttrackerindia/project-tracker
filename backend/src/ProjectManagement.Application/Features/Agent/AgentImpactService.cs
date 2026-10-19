using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Agent;

/// <summary>
/// What a date change does to the rest of the plan, before anyone approves it: follows the task dependencies (finish-to-start and
/// finish-to-finish) from the moved task, shifts what has to move, and says which milestones and whether the project's own due date would
/// be missed. Plain arithmetic over the plan - no model, no credits - so it can run on every proposal and every "what if".
/// </summary>
public class AgentImpactService(IAppDbContext db, ICurrentContext ctx, AppClock clock, ProjectAccess access, AgentSettingsService settings)
{
    private const int MaxNodes = 300;

    public async Task<ImpactDto> WhatIfAsync(WhatIfRequest req, CancellationToken ct = default)
    {
        ctx.RequireUserId();
        var task = await access.VisibleTasks().AsNoTracking().FirstOrDefaultAsync(t => t.Id == req.TaskId, ct) ?? throw new NotFoundException("Task not found.");
        DateOnly target;
        if (req.NewDue is { } due) target = due;
        else if (req.SlipDays is { } days)
        {
            if (days is < -365 or > 365) throw new ValidationException("slipDays", "Choose a slip of up to a year.");
            target = (task.DueDate ?? clock.Today).AddDays(days);
        }
        else throw new ValidationException("newDue", "Give a new date or a number of days.");
        return await AnalyzeAsync(task.Id, target, ct);
    }

    /// <summary>The impact of a proposal that moves a task (a delay or an update with a new date); null when it moves nothing.</summary>
    public async Task<ImpactDto?> ForFindingAsync(Guid findingId, CancellationToken ct = default)
    {
        var f = await db.AgentFindings.AsNoTracking().FirstOrDefaultAsync(x => x.Id == findingId, ct) ?? throw new NotFoundException("That proposal was not found.");
        var project = await access.GetProjectAsync(f.ProjectId, ct);
        if (!await settings.CanManageAsync(project, ct)) throw new ForbiddenException("Only people who may edit this project can see this.", "PERMISSION_DENIED");
        return f is { TaskId: { } taskId, DueDate: { } due } ? await AnalyzeAsync(taskId, due, ct) : null;
    }

    /// <summary>Open tasks of a project to try a "what if" on, the ones others depend on first.</summary>
    public async Task<IReadOnlyList<WhatIfTaskDto>> TasksAsync(Guid projectId, CancellationToken ct = default)
    {
        var project = await access.GetProjectAsync(projectId, ct);
        var tasks = await access.VisibleTasks().AsNoTracking().Where(t => t.ProjectId == projectId && t.ParentTaskId == null
                && t.Status!.Category != StatusCategory.Done && t.Status.Category != StatusCategory.Cancelled)
            .OrderBy(t => t.DueDate == null).ThenBy(t => t.DueDate).Take(300)
            .Select(t => new { t.Id, t.Number, t.Title, t.DueDate, Owner = t.Assignee != null ? t.Assignee.DisplayName : null }).ToListAsync(ct);
        var ids = tasks.Select(t => t.Id).ToList();
        var dependents = await db.TaskDependencies.AsNoTracking().Where(d => ids.Contains(d.DependsOnTaskId)).GroupBy(d => d.DependsOnTaskId)
            .Select(g => new { g.Key, Count = g.Count() }).ToDictionaryAsync(x => x.Key, x => x.Count, ct);
        return tasks.Select(t => new WhatIfTaskDto(t.Id, $"{project.Key}-{t.Number}", t.Title, t.DueDate, t.Owner, dependents.GetValueOrDefault(t.Id)))
            .OrderByDescending(t => t.Dependents).ThenBy(t => t.Due ?? DateOnly.MaxValue).ToList();
    }

    public async Task<ImpactDto> AnalyzeAsync(Guid taskId, DateOnly newDue, CancellationToken ct = default)
    {
        var root = await db.Tasks.AsNoTracking().FirstOrDefaultAsync(t => t.Id == taskId, ct) ?? throw new NotFoundException("Task not found.");
        var project = await db.Projects.AsNoTracking().FirstAsync(p => p.Id == root.ProjectId, ct);
        var rows = await db.Tasks.AsNoTracking().Where(t => t.ProjectId == root.ProjectId)
            .Select(t => new Node(t.Id, t.Number, t.Title, t.StartDate, t.DueDate, t.AssigneeId, t.MilestoneId,
                t.Status!.Category == StatusCategory.Done || t.Status.Category == StatusCategory.Cancelled))
            .Take(20_000).ToListAsync(ct);
        var byId = rows.ToDictionary(r => r.Id);
        var ids = rows.Select(r => r.Id).ToList();
        var links = await db.TaskDependencies.AsNoTracking().Where(d => ids.Contains(d.DependsOnTaskId))
            .Select(d => new { d.TaskId, d.DependsOnTaskId, d.Type }).ToListAsync(ct);
        var successors = links.GroupBy(l => l.DependsOnTaskId).ToDictionary(g => g.Key, g => g.Select(l => (l.TaskId, l.Type)).ToList());

        // Breadth-first from the moved task: a successor moves when the new finish no longer leaves room for it; it keeps its length.
        var finish = new Dictionary<Guid, DateOnly> { [root.Id] = newDue };
        var starts = new Dictionary<Guid, DateOnly?>();
        var depth = new Dictionary<Guid, int> { [root.Id] = 0 };
        var queue = new Queue<Guid>(); queue.Enqueue(root.Id);
        while (queue.Count > 0 && finish.Count < MaxNodes)
        {
            var id = queue.Dequeue();
            if (!successors.TryGetValue(id, out var next)) continue;
            var predFinish = finish[id];
            foreach (var (succId, type) in next)
            {
                if (!byId.TryGetValue(succId, out var s) || s.Closed || succId == root.Id) continue;
                DateOnly? due = finish.TryGetValue(succId, out var movedDue) ? movedDue : s.Due;
                var start = starts.TryGetValue(succId, out var movedStart) ? movedStart : s.Start ?? s.Due;
                var shift = 0;
                if (type == DependencyType.FinishToStart) { if (start is { } st && st <= predFinish) shift = predFinish.DayNumber + 1 - st.DayNumber; }
                else if (type == DependencyType.FinishToFinish) { if (due is { } dd && dd < predFinish) shift = predFinish.DayNumber - dd.DayNumber; }
                else continue;   // start-based links do not move when a finish moves
                if (shift <= 0 || due is not { } current) continue;
                finish[succId] = current.AddDays(shift);
                starts[succId] = start?.AddDays(shift);
                depth[succId] = depth[id] + 1;
                queue.Enqueue(succId);
            }
        }

        var userIds = rows.Where(r => finish.ContainsKey(r.Id) && r.Owner is not null).Select(r => r.Owner!.Value).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => userIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        string Key(Node n) => $"{project.Key}-{n.Number}";
        var moves = finish.Where(kv => kv.Key != root.Id).Select(kv => byId[kv.Key])
            .Select(n => new ImpactTaskDto(n.Id, Key(n), n.Title, n.Owner is { } o ? names.GetValueOrDefault(o) : null, n.Due, finish[n.Id],
                n.Due is { } d ? finish[n.Id].DayNumber - d.DayNumber : 0, depth[n.Id]))
            .OrderBy(m => m.Depth).ThenBy(m => m.NewDue).ToList();

        // Milestones whose date the moved work would now pass.
        var milestoneIds = finish.Keys.Select(id => byId[id].Milestone).Where(m => m is not null).Select(m => m!.Value).Distinct().ToList();
        var milestones = await db.Milestones.AsNoTracking().Where(m => milestoneIds.Contains(m.Id) && m.DueDate != null).ToListAsync(ct);
        var missed = new List<string>();
        foreach (var m in milestones.OrderBy(m => m.DueDate))
        {
            var latest = finish.Where(kv => byId[kv.Key].Milestone == m.Id).Max(kv => kv.Value);
            if (latest > m.DueDate) missed.Add($"{m.Name} (due {m.DueDate:d MMM}) would be missed by {latest.DayNumber - m.DueDate!.Value.DayNumber} day{(latest.DayNumber - m.DueDate.Value.DayNumber == 1 ? "" : "s")}");
        }

        // The project's finish: the latest due date among open work, before and after.
        var openDues = rows.Where(r => !r.Closed && r.Due is not null).ToDictionary(r => r.Id, r => r.Due!.Value);
        foreach (var kv in finish) openDues[kv.Key] = kv.Value;
        DateOnly? after = openDues.Count == 0 ? null : openDues.Values.Max();
        int? projectSlip = project.DueDate is { } pd && after is { } af && af > pd ? af.DayNumber - pd.DayNumber : null;
        var slip = root.DueDate is { } rd ? newDue.DayNumber - rd.DayNumber : 0;

        var key = $"{project.Key}-{root.Number}";
        var level = projectSlip is > 0 || missed.Count > 0 ? "high" : moves.Count > 0 ? "medium" : slip > 0 ? "low" : "none";
        var parts = new List<string>();
        var verb = slip > 0 ? $"Moving {key} by {slip} day{(slip == 1 ? "" : "s")}" : slip < 0 ? $"Bringing {key} forward by {-slip} day{(slip == -1 ? "" : "s")}" : $"Setting {key} to {newDue:d MMM}";
        parts.Add(moves.Count == 0 ? $"{verb} moves nothing else" : $"{verb} moves {moves.Count} dependent task{(moves.Count == 1 ? "" : "s")} ({string.Join(", ", moves.Take(3).Select(m => m.Key))}{(moves.Count > 3 ? $" +{moves.Count - 3}" : "")})");
        if (projectSlip is { } ps) parts.Add($"the project would finish {ps} day{(ps == 1 ? "" : "s")} after its due date ({project.DueDate:d MMM})");
        else if (project.DueDate is not null) parts.Add("the project's due date still holds");
        if (missed.Count > 0) parts.Add($"{missed.Count} milestone{(missed.Count == 1 ? "" : "s")} would be missed");
        var summary = string.Join("; ", parts) + ".";
        return new ImpactDto(root.Id, root.ProjectId, key, root.Title, root.DueDate, newDue, slip, moves, missed, project.DueDate, after, projectSlip,
            names.Values.Distinct().OrderBy(n => n).ToList(), summary, level);
    }

    private sealed record Node(Guid Id, int Number, string Title, DateOnly? Start, DateOnly? Due, Guid? Owner, Guid? Milestone, bool Closed);
}
