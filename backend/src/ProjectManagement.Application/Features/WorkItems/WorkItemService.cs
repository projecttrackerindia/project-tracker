using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.WorkItems;

/// <summary>
/// One piece of assignable work of any kind, in the shape the cross-cutting views share. <see cref="Category"/> puts every kind's own
/// statuses on one scale (to do, in progress, done, cancelled), so lists and counts mean the same thing whatever the kind.
/// </summary>
public record WorkItemDto(WorkItemKind Kind, Guid Id, string Key, string Title, Guid? ProjectId, string? ProjectKey, string? ProjectName,
    string Status, StatusCategory Category, Priority Priority, DateOnly? DueDate, bool IsOverdue, UserRefDto? Assignee, string? TypeName, DateTime UpdatedAt);

/// <summary>Filters for a list of work items. With no kinds given, every kind the caller can see is included.</summary>
public record WorkItemQuery(IReadOnlyList<WorkItemKind>? Kinds = null, Guid? AssigneeId = null, bool Mine = false, bool OpenOnly = true,
    Guid? ProjectId = null, DateOnly? DueFrom = null, DateOnly? DueTo = null, bool Overdue = false, string? Q = null, int Limit = 200);

public record WorkKindCounts(int Tasks, int Issues, int ActionItems, int Operational)
{
    public int Total => Tasks + Issues + ActionItems + Operational;
}

/// <summary>Open, overdue and finished work of one person, across every kind.</summary>
public record PersonWorkCounts(Guid UserId, int Open, int Overdue, int DueThisWeek, int DoneLast30Days, int DoneTotal, WorkKindCounts OpenByKind);

/// <summary>
/// Whose rules decide what is visible. <see cref="Caller"/>: only what the signed-in person may open (project membership, module access).
/// <see cref="ReportingLine"/>: a manager looking at the people who report to them sees all of their work, wherever it is, because
/// managing people means seeing their work (the same rule the reporting-line views always had).
/// </summary>
public enum WorkItemScope { Caller, ReportingLine }

/// <summary>
/// Reads project tasks, test issues, action items and operational work through one shape, for the views that show them together:
/// My work, workload, the dashboard, the calendar and search. Each kind keeps its own visibility rules; nothing here changes data.
/// </summary>
public class WorkItemService(IAppDbContext db, ICurrentContext ctx, AppClock clock, ProjectAccess access, PermissionService permissions)
{
    public const int MaxLimit = 500;

    public static string KeyOf(WorkTaskKind kind, int number) => kind == WorkTaskKind.ActionItem ? $"AI-{number}" : $"WT-{number}";

    public static StatusCategory CategoryOf(WorkTaskStatus s) => s switch
    {
        WorkTaskStatus.ToDo => StatusCategory.Todo,
        WorkTaskStatus.InProgress or WorkTaskStatus.OnHold => StatusCategory.Active,
        WorkTaskStatus.Completed => StatusCategory.Done,
        _ => StatusCategory.Cancelled,
    };

    /// <summary>Observed is waiting to be picked up; in progress and fixed are still with the team (fixed waits for the tester); resolved is done.</summary>
    public static StatusCategory CategoryOf(IssueStatus s) => s switch
    {
        IssueStatus.Observed => StatusCategory.Todo,
        IssueStatus.InProgress or IssueStatus.Fixed => StatusCategory.Active,
        _ => StatusCategory.Done,
    };

    public static string LabelOf(IssueStatus s) => s switch
    {
        IssueStatus.Observed => "Observed", IssueStatus.InProgress => "In Progress", IssueStatus.Fixed => "Fixed", _ => "Resolved",
    };

    /// <summary>Which kinds the caller may see at all, from their module access.</summary>
    public async Task<HashSet<WorkItemKind>> VisibleKindsAsync(WorkItemScope scope, CancellationToken ct = default)
    {
        if (scope == WorkItemScope.ReportingLine) return [.. Enum.GetValues<WorkItemKind>()];
        var lv = await permissions.LevelsAsync(ct);
        var kinds = new HashSet<WorkItemKind>();
        if (lv[Modules.Tasks] > 0) kinds.Add(WorkItemKind.Task);
        if (lv[Modules.Tasks] > 0 && lv[Modules.Projects] > 0) kinds.Add(WorkItemKind.Issue);
        if (lv[Modules.Projects] > 0) kinds.Add(WorkItemKind.ActionItem);
        if (lv[Modules.Work] > 0) kinds.Add(WorkItemKind.Operational);
        return kinds;
    }

    // ------------------------------------------------------------------ sources, each already narrowed to what the scope may see

    private IQueryable<TaskItem> Tasks(WorkItemScope scope) => scope == WorkItemScope.Caller ? access.VisibleTasks() : db.Tasks;

    private IQueryable<StageIssue> Issues(WorkItemScope scope)
    {
        var q = db.StageIssues.Where(i => db.Projects.Any(p => p.Id == i.ProjectId));   // issues of deleted projects stay hidden
        return scope == WorkItemScope.Caller ? q.Where(i => access.VisibleProjects().Any(p => p.Id == i.ProjectId)) : q;
    }

    private IQueryable<WorkTask> WorkTasks(WorkItemScope scope, WorkTaskKind kind)
    {
        var q = db.WorkTasks.Where(w => w.Kind == kind);
        if (kind == WorkTaskKind.ActionItem)
        {
            q = q.Where(w => w.RelatedProjectId != null && db.Projects.Any(p => p.Id == w.RelatedProjectId));
            if (scope == WorkItemScope.Caller) q = q.Where(w => access.VisibleProjects().Any(p => p.Id == w.RelatedProjectId));
        }
        return q;
    }

    private static bool OpenWork(WorkTaskStatus s) => s is WorkTaskStatus.ToDo or WorkTaskStatus.InProgress or WorkTaskStatus.OnHold;

    // ------------------------------------------------------------------ lists

    /// <summary>Work items matching the query, soonest due first (undated last), then the more urgent.</summary>
    public async Task<IReadOnlyList<WorkItemDto>> ListAsync(WorkItemQuery query, WorkItemScope scope = WorkItemScope.Caller, CancellationToken ct = default)
    {
        ctx.RequireTenantId();
        var limit = Math.Clamp(query.Limit, 1, MaxLimit);
        var visible = await VisibleKindsAsync(scope, ct);
        var wanted = query.Kinds is { Count: > 0 } k ? visible.Intersect(k).ToHashSet() : visible;
        var assignee = query.Mine ? ctx.RequireUserId() : query.AssigneeId;
        var today = clock.Today;
        var q = query.Q?.Trim().ToLowerInvariant();
        if (q is { Length: 0 }) q = null;
        int? number = q is null ? null : ParseNumber(q);
        var rows = new List<WorkItemDto>();

        if (wanted.Contains(WorkItemKind.Task))
        {
            var tq = Tasks(scope).AsNoTracking();
            if (assignee is { } a) tq = tq.Where(t => t.AssigneeId == a);
            if (query.OpenOnly) tq = tq.Where(t => t.Status!.Category != StatusCategory.Done && t.Status.Category != StatusCategory.Cancelled);
            if (query.ProjectId is { } pid) tq = tq.Where(t => t.ProjectId == pid);
            if (query.DueFrom is { } f) tq = tq.Where(t => t.DueDate != null && t.DueDate >= f);
            if (query.DueTo is { } to) tq = tq.Where(t => t.DueDate != null && t.DueDate <= to);
            if (query.Overdue) tq = tq.Where(t => t.DueDate != null && t.DueDate < today && t.Status!.Category != StatusCategory.Done && t.Status.Category != StatusCategory.Cancelled);
            if (q is not null) tq = tq.Where(t => t.Title.ToLower().Contains(q) || (t.Description != null && t.Description.ToLower().Contains(q)) || t.Number == number);
            var tasks = await tq.OrderBy(t => t.DueDate == null).ThenBy(t => t.DueDate).Take(limit)
                .Select(t => new { t.Id, t.Number, t.Title, t.ProjectId, ProjectKey = t.Project!.Key, ProjectName = t.Project.Name, Status = t.Status!.Name, t.Status.Category,
                    t.Priority, t.DueDate, t.AssigneeId, Updated = t.UpdatedAt ?? t.CreatedAt })
                .ToListAsync(ct);
            rows.AddRange(tasks.Select(t => new WorkItemDto(WorkItemKind.Task, t.Id, $"{t.ProjectKey}-{t.Number}", t.Title, t.ProjectId, t.ProjectKey, t.ProjectName,
                t.Status, t.Category, t.Priority, t.DueDate, IsLate(t.DueDate, t.Category, today), Ref(t.AssigneeId), null, t.Updated)));
        }

        if (wanted.Contains(WorkItemKind.Issue) && query.DueFrom is null && query.DueTo is null && !query.Overdue)   // issues have no due date
        {
            var iq = Issues(scope).AsNoTracking();
            if (assignee is { } a) iq = iq.Where(i => i.AssigneeId == a);
            if (query.OpenOnly) iq = iq.Where(i => i.Status != IssueStatus.Resolved);
            if (query.ProjectId is { } pid) iq = iq.Where(i => i.ProjectId == pid);
            if (q is not null) iq = iq.Where(i => i.Title.ToLower().Contains(q) || (i.Details != null && i.Details.ToLower().Contains(q)) || i.Number == number);
            var issues = await (from i in iq
                                join p in db.Projects.AsNoTracking() on i.ProjectId equals p.Id
                                orderby i.CreatedAt descending
                                select new { i.Id, i.Number, i.Title, i.ProjectId, ProjectKey = p.Key, ProjectName = p.Name, i.Status, i.Severity, i.AssigneeId, Updated = i.UpdatedAt ?? i.CreatedAt })
                .Take(limit).ToListAsync(ct);
            rows.AddRange(issues.Select(i => new WorkItemDto(WorkItemKind.Issue, i.Id, $"{i.ProjectKey}-I{i.Number}", i.Title, i.ProjectId, i.ProjectKey, i.ProjectName,
                LabelOf(i.Status), CategoryOf(i.Status), i.Severity, null, false, Ref(i.AssigneeId), "Test issue", i.Updated)));
        }

        foreach (var (kind, itemKind) in new[] { (WorkTaskKind.ActionItem, WorkItemKind.ActionItem), (WorkTaskKind.Operational, WorkItemKind.Operational) })
        {
            if (!wanted.Contains(itemKind)) continue;
            var wq = WorkTasks(scope, kind).AsNoTracking();
            if (assignee is { } a) wq = wq.Where(w => w.AssigneeId == a);
            if (query.OpenOnly) wq = wq.Where(w => w.Status == WorkTaskStatus.ToDo || w.Status == WorkTaskStatus.InProgress || w.Status == WorkTaskStatus.OnHold);
            if (query.ProjectId is { } pid) wq = wq.Where(w => w.RelatedProjectId == pid);
            if (query.DueFrom is { } f) wq = wq.Where(w => w.DueDate != null && w.DueDate >= f);
            if (query.DueTo is { } to) wq = wq.Where(w => w.DueDate != null && w.DueDate <= to);
            if (query.Overdue) wq = wq.Where(w => w.DueDate != null && w.DueDate < today && (w.Status == WorkTaskStatus.ToDo || w.Status == WorkTaskStatus.InProgress || w.Status == WorkTaskStatus.OnHold));
            if (q is not null) wq = wq.Where(w => w.Title.ToLower().Contains(q) || (w.Description != null && w.Description.ToLower().Contains(q)) || w.Number == number);
            var work = await wq.OrderBy(w => w.DueDate == null).ThenBy(w => w.DueDate).Take(limit)
                .Select(w => new { w.Id, w.Number, w.Title, w.RelatedProjectId, w.Status, w.Priority, w.DueDate, w.AssigneeId, TypeName = w.WorkType != null ? w.WorkType.Name : null,
                    Updated = w.UpdatedAt ?? w.CreatedAt })
                .ToListAsync(ct);
            var projectIds = work.Where(w => w.RelatedProjectId != null).Select(w => w.RelatedProjectId!.Value).Distinct().ToList();
            var projects = await db.Projects.AsNoTracking().Where(p => projectIds.Contains(p.Id)).ToDictionaryAsync(p => p.Id, p => new { p.Key, p.Name }, ct);
            rows.AddRange(work.Select(w =>
            {
                var p = w.RelatedProjectId is { } id && projects.TryGetValue(id, out var x) ? x : null;
                var cat = CategoryOf(w.Status);
                return new WorkItemDto(itemKind, w.Id, KeyOf(kind, w.Number), w.Title, p is null ? null : w.RelatedProjectId, p?.Key, p?.Name,
                    kind == WorkTaskKind.ActionItem ? ActionLabel(w.Status) : WorkLabel(w.Status), cat, w.Priority, w.DueDate, IsLate(w.DueDate, cat, today), Ref(w.AssigneeId),
                    kind == WorkTaskKind.ActionItem ? "Action item" : w.TypeName, w.Updated);
            }));
        }

        await FillNamesAsync(rows, ct);
        return Order(rows).Take(limit).ToList();

        UserRefDto? Ref(Guid? id) => id is { } u ? new UserRefDto(u, "") : null;
    }

    /// <summary>Open items first; then the soonest due (undated last); then the more urgent; then the most recently changed.</summary>
    public static IEnumerable<WorkItemDto> Order(IEnumerable<WorkItemDto> rows) =>
        rows.OrderBy(r => r.Category is StatusCategory.Done or StatusCategory.Cancelled)
            .ThenBy(r => r.DueDate is null).ThenBy(r => r.DueDate)
            .ThenByDescending(r => (int)r.Priority)
            .ThenByDescending(r => r.UpdatedAt);

    private async Task FillNamesAsync(List<WorkItemDto> rows, CancellationToken ct)
    {
        var ids = rows.Where(r => r.Assignee is not null).Select(r => r.Assignee!.Id).Distinct().ToList();
        if (ids.Count == 0) return;
        var names = await db.Users.AsNoTracking().Where(u => ids.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        for (var i = 0; i < rows.Count; i++)
            if (rows[i].Assignee is { } a) rows[i] = rows[i] with { Assignee = names.TryGetValue(a.Id, out var n) ? new UserRefDto(a.Id, n) : null };
    }

    private static bool IsLate(DateOnly? due, StatusCategory cat, DateOnly today) =>
        due is { } d && d < today && cat is not (StatusCategory.Done or StatusCategory.Cancelled);

    public static string WorkLabel(WorkTaskStatus s) => s switch
    {
        WorkTaskStatus.ToDo => "To Do", WorkTaskStatus.InProgress => "In Progress", WorkTaskStatus.OnHold => "On Hold",
        WorkTaskStatus.Completed => "Completed", _ => "Cancelled",
    };

    public static string ActionLabel(WorkTaskStatus s) => s switch
    {
        WorkTaskStatus.ToDo => "Open", WorkTaskStatus.Completed => "Completed", WorkTaskStatus.Cancelled => "Cancelled", _ => "In Progress",
    };

    /// <summary>"wt-12", "ai-12", "atlas-12", "atlas-i3" or just "12": the number part, for finding an item by its key.</summary>
    private static int? ParseNumber(string q)
    {
        var dash = q.LastIndexOf('-');
        var tail = dash >= 0 ? q[(dash + 1)..] : q;
        if (tail.StartsWith('i')) tail = tail[1..];
        return int.TryParse(tail, out var n) ? n : null;
    }

    // ------------------------------------------------------------------ counts

    /// <summary>
    /// Open, overdue, due-this-week and finished work per person, across every kind the scope can see. People with nothing are included
    /// with zeros, so a list of people never silently drops someone.
    /// </summary>
    public async Task<IReadOnlyDictionary<Guid, PersonWorkCounts>> CountsAsync(IReadOnlyCollection<Guid> people, WorkItemScope scope, CancellationToken ct = default)
    {
        var result = people.Distinct().ToDictionary(p => p, p => new Counter());
        if (result.Count == 0) return new Dictionary<Guid, PersonWorkCounts>();
        var ids = result.Keys.ToList();
        var kinds = await VisibleKindsAsync(scope, ct);
        var today = clock.Today; var week = today.AddDays(7);
        var since30 = clock.Now.AddDays(-30);

        if (kinds.Contains(WorkItemKind.Task))
        {
            var rows = await Tasks(scope).AsNoTracking().Where(t => t.AssigneeId != null && ids.Contains(t.AssigneeId.Value))
                .GroupBy(t => new { Who = t.AssigneeId!.Value, t.Status!.Category, Late = t.DueDate != null && t.DueDate < today, Soon = t.DueDate != null && t.DueDate >= today && t.DueDate <= week,
                    Recent = t.CompletedAt != null && t.CompletedAt >= since30 })
                .Select(g => new { g.Key.Who, g.Key.Category, g.Key.Late, g.Key.Soon, g.Key.Recent, N = g.Count() }).ToListAsync(ct);
            foreach (var r in rows) result[r.Who].Add(WorkItemKind.Task, r.Category, r.Late, r.Soon, r.Recent, r.N);
        }
        if (kinds.Contains(WorkItemKind.Issue))
        {
            var rows = await Issues(scope).AsNoTracking().Where(i => i.AssigneeId != null && ids.Contains(i.AssigneeId.Value))
                .GroupBy(i => new { Who = i.AssigneeId!.Value, i.Status, Recent = i.ResolvedAt != null && i.ResolvedAt >= since30 })
                .Select(g => new { g.Key.Who, g.Key.Status, g.Key.Recent, N = g.Count() }).ToListAsync(ct);
            foreach (var r in rows) result[r.Who].Add(WorkItemKind.Issue, CategoryOf(r.Status), false, false, r.Recent, r.N);
        }
        foreach (var (kind, itemKind) in new[] { (WorkTaskKind.ActionItem, WorkItemKind.ActionItem), (WorkTaskKind.Operational, WorkItemKind.Operational) })
        {
            if (!kinds.Contains(itemKind)) continue;
            var rows = await WorkTasks(scope, kind).AsNoTracking().Where(w => w.AssigneeId != null && ids.Contains(w.AssigneeId.Value))
                .GroupBy(w => new { Who = w.AssigneeId!.Value, w.Status, Late = w.DueDate != null && w.DueDate < today, Soon = w.DueDate != null && w.DueDate >= today && w.DueDate <= week,
                    Recent = w.CompletedAt != null && w.CompletedAt >= since30 })
                .Select(g => new { g.Key.Who, g.Key.Status, g.Key.Late, g.Key.Soon, g.Key.Recent, N = g.Count() }).ToListAsync(ct);
            foreach (var r in rows) result[r.Who].Add(itemKind, CategoryOf(r.Status), r.Late, r.Soon, r.Recent, r.N);
        }
        return result.ToDictionary(x => x.Key, x => x.Value.ToDto(x.Key));
    }

    /// <summary>The next few open items of each person (soonest due first), across every kind the scope can see.</summary>
    public async Task<IReadOnlyDictionary<Guid, IReadOnlyList<WorkItemDto>>> NextUpAsync(IReadOnlyCollection<Guid> people, WorkItemScope scope, int perPerson, CancellationToken ct = default)
    {
        var map = new Dictionary<Guid, IReadOnlyList<WorkItemDto>>();
        foreach (var who in people.Distinct())
            map[who] = await ListAsync(new WorkItemQuery(AssigneeId: who, OpenOnly: true, Limit: perPerson), scope, ct);
        return map;
    }

    private sealed class Counter
    {
        private int _open, _late, _soon, _recent, _done, _tasks, _issues, _actions, _ops;

        public void Add(WorkItemKind kind, StatusCategory cat, bool late, bool soon, bool recentlyDone, int n)
        {
            if (cat is StatusCategory.Todo or StatusCategory.Active)
            {
                _open += n;
                if (late) _late += n;
                if (soon) _soon += n;
                switch (kind)
                {
                    case WorkItemKind.Task: _tasks += n; break;
                    case WorkItemKind.Issue: _issues += n; break;
                    case WorkItemKind.ActionItem: _actions += n; break;
                    default: _ops += n; break;
                }
            }
            else if (cat == StatusCategory.Done)
            {
                _done += n;
                if (recentlyDone) _recent += n;
            }
        }

        public PersonWorkCounts ToDto(Guid who) => new(who, _open, _late, _soon, _recent, _done, new WorkKindCounts(_tasks, _issues, _actions, _ops));
    }
}
