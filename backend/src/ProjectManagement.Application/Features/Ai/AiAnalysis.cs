using System.Globalization;
using System.Text;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.WorkItems;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Ai;

/// <summary>One thing worth the person's attention, found without asking a model; "Prompt" is what to ask to dig into it.</summary>
public sealed record AiInsightDto(string Id, string Severity, string Title, string Detail, string Prompt);

/// <summary>
/// What the assistant knows about how the organization really works, worked out from its own data: who has too much and who has room, who
/// has done similar work before, how long things take and how often they are late. Every figure is computed here, deterministically and
/// through the asker's own access (the projects they can open, the people whose workload they may see), so the model reasons from facts
/// instead of guessing and a restricted person never learns anything they could not already see.
/// </summary>
public class AiAnalysis(IAppDbContext db, ICurrentContext ctx, AppClock clock, ProjectAccess access, WorkloadService workload, WorkItemService workItems,
    ProjectStatusService status)
{
    private static string Num(double v) => v.ToString("0.#", CultureInfo.InvariantCulture);
    private static string Clean(string s) => s.Replace('\n', ' ').Replace('|', '/').Trim();
    private static bool Done(StatusCategory c) => c is StatusCategory.Done or StatusCategory.Cancelled;

    // ------------------------------------------------------------------ the organization at a glance (goes with every question)

    /// <summary>A few lines on the workspace itself: its projects, groups, work types, roles and recent pace. Short on purpose; it is sent every time.</summary>
    public async Task<string> OverviewAsync(CancellationToken ct)
    {
        var tid = ctx.RequireTenantId();
        var today = clock.Today;
        var sb = new StringBuilder();
        var projects = await access.VisibleProjects().AsNoTracking().Where(p => p.Status != ProjectStatus.Archived)
            .Select(p => new { p.Key, p.Name, p.Status, p.ProjectType, Group = p.ProjectGroupId }).Take(300).ToListAsync(ct);
        var members = ctx.Role == TenantRole.Guest ? 0 : await db.TenantMembers.AsNoTracking().CountAsync(m => m.TenantId == tid, ct);
        sb.Append(ctx.Role == TenantRole.Guest ? "" : $"This workspace has {members} member{(members == 1 ? "" : "s")}. ");
        if (ctx.TeamLens is { } lens && await db.Teams.AsNoTracking().Where(t => t.Id == lens).Select(t => t.Name).FirstOrDefaultAsync(ct) is { } teamName)
            sb.AppendLine($"The person is currently looking at the team \"{Clean(teamName)}\": every project, task and figure you can read is limited to that team's projects. Say so when it matters, and offer to look at all teams if they ask about something outside it.");
        sb.AppendLine($"The person can see {projects.Count} active project{(projects.Count == 1 ? "" : "s")}.");
        if (projects.Count == 0) return sb.ToString();

        var byStatus = projects.GroupBy(p => p.Status).Select(g => $"{g.Count()} {g.Key}");
        var byType = projects.GroupBy(p => p.ProjectType).OrderByDescending(g => g.Count()).Take(5).Select(g => $"{g.Count()} {g.Key}");
        sb.AppendLine($"Projects by status: {string.Join(", ", byStatus)}. By type: {string.Join(", ", byType)}.");
        sb.AppendLine("Projects: " + string.Join("; ", projects.Take(15).Select(p => $"{p.Key} {Clean(p.Name)}")) + (projects.Count > 15 ? $"; and {projects.Count - 15} more" : "") + ".");

        var groups = await db.ProjectGroups.AsNoTracking().Where(g => g.IsActive).OrderBy(g => g.Order).Select(g => g.Name).Take(8).ToListAsync(ct);
        if (groups.Count > 0) sb.AppendLine("Project groups: " + string.Join(", ", groups.Select(Clean)) + ".");
        var types = await db.WorkTypes.AsNoTracking().Where(t => t.IsActive).OrderBy(t => t.Order).Select(t => t.Name).Take(10).ToListAsync(ct);
        if (types.Count > 0) sb.AppendLine("Operational work types: " + string.Join(", ", types.Select(Clean)) + ".");

        if (ctx.Role != TenantRole.Guest)
        {
            var roles = await (from m in db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid && m.OrgRoleId != null)
                               join r in db.OrgRoles.AsNoTracking() on m.OrgRoleId equals r.Id
                               group r by r.Name into g
                               orderby g.Count() descending
                               select new { g.Key, N = g.Count() }).Take(8).ToListAsync(ct);
            if (roles.Count > 0) sb.AppendLine("Job roles: " + string.Join(", ", roles.Select(r => $"{r.N} {Clean(r.Key)}")) + ".");
        }

        var since = clock.Now.AddDays(-30);
        var doneRecently = await access.VisibleTasks().AsNoTracking().CountAsync(t => t.CompletedAt != null && t.CompletedAt >= since, ct);
        var overdue = await access.VisibleTasks().AsNoTracking().CountAsync(t => t.DueDate != null && t.DueDate < today && t.Status!.Category != StatusCategory.Done && t.Status.Category != StatusCategory.Cancelled, ct);
        sb.AppendLine($"Pace: {doneRecently} project tasks finished in the last 30 days; {overdue} open tasks are past their due date.");
        return sb.ToString();
    }

    // ------------------------------------------------------------------ who has too much, who has room

    private sealed record Load(Guid UserId, string Name, string? JobRole, int Open, int Overdue, int DueThisWeek, int Done30, double HoursLeft, double WeeklyHours);

    private async Task<(List<Load> People, string ScopeName)> LoadsAsync(WorkloadScope? requested, CancellationToken ct)
    {
        var w = await workload.GetAsync(requested, ct);
        var ids = w.Members.Select(m => m.UserId).ToList();
        var tid = ctx.RequireTenantId();
        var caps = await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid && ids.Contains(m.UserId)).Select(m => new { m.UserId, m.WeeklyCapacityMinutes }).ToDictionaryAsync(x => x.UserId, x => x.WeeklyCapacityMinutes, ct);
        var hours = await access.VisibleTasks().AsNoTracking()
            .Where(t => t.AssigneeId != null && ids.Contains(t.AssigneeId.Value) && t.EstimatedHours != null && t.Status!.Category != StatusCategory.Done && t.Status.Category != StatusCategory.Cancelled)
            .GroupBy(t => t.AssigneeId!.Value).Select(g => new { g.Key, H = g.Sum(t => t.EstimatedHours!.Value) }).ToDictionaryAsync(x => x.Key, x => (double)x.H, ct);
        var people = w.Members.Select(m => new Load(m.UserId, m.Name, m.JobRole, m.Open, m.Overdue, m.DueThisWeek, m.DoneLast30Days,
            hours.GetValueOrDefault(m.UserId), (caps.GetValueOrDefault(m.UserId) ?? 2400) / 60.0)).ToList();
        return (people, w.Scope.ToString());
    }

    /// <summary>Per person: open, overdue, due this week, estimated hours left against their weekly capacity, recent pace; who is stretched, who has room, and a suggested rebalance.</summary>
    public async Task<(string Text, int Count)> WorkloadBalanceAsync(WorkloadScope? scope, CancellationToken ct)
    {
        var (people, scopeName) = await LoadsAsync(scope, ct);
        if (people.Count == 0) return ("Nobody is in that workload.", 0);
        var avg = people.Average(p => (double)p.Open);
        string Verdict(Load p) =>
            p.Overdue >= 3 || (people.Count > 1 && p.Open >= 5 && p.Open > avg * 1.5) || (p.HoursLeft > 0 && p.HoursLeft > p.WeeklyHours * 2) ? "OVERLOADED"
            : people.Count > 1 && p.Open <= avg * 0.5 && p.Overdue == 0 ? "HAS ROOM" : "balanced";
        var sb = new StringBuilder();
        sb.AppendLine($"Workload ({scopeName}), {people.Count} people, average {Num(avg)} open items each. name | job role | open | overdue | due this week | est. hours left (of weekly capacity) | finished in 30 days | verdict");
        foreach (var p in people.OrderByDescending(p => p.Overdue * 3 + p.Open).Take(60))
            sb.AppendLine($"{Clean(p.Name)} | {Clean(p.JobRole ?? "-")} | {p.Open} | {p.Overdue} | {p.DueThisWeek} | {(p.HoursLeft > 0 ? Num(p.HoursLeft) : "no estimates")} ({Num(p.WeeklyHours)}h/week) | {p.Done30} | {Verdict(p)}");
        var over = people.Where(p => Verdict(p) == "OVERLOADED").ToList();
        var room = people.Where(p => Verdict(p) == "HAS ROOM").OrderBy(p => p.Open).ToList();
        if (over.Count > 0 && room.Count > 0)
        {
            sb.AppendLine("Rebalancing idea: move work from " + string.Join(", ", over.Select(p => Clean(p.Name))) + " to " + string.Join(", ", room.Select(p => Clean(p.Name))) +
                ". Use suggest_assignee for the individual items and propose_update_work to reassign.");
        }
        else if (over.Count > 0) sb.AppendLine("Several people are stretched and nobody clearly has room: look at deadlines, scope or extra help rather than moving work around.");
        return (sb.ToString(), people.Count);
    }

    // ------------------------------------------------------------------ who should get this

    private static readonly HashSet<string> Stop = new(StringComparer.OrdinalIgnoreCase)
        { "the", "a", "an", "and", "or", "of", "to", "for", "in", "on", "with", "from", "by", "is", "are", "be", "update", "create", "add", "fix", "make", "new", "task" };

    private static HashSet<string> Words(string s) =>
        s.Split([' ', '-', '_', '/', ',', '.', ':', ';', '(', ')'], StringSplitOptions.RemoveEmptyEntries).Select(w => w.ToLowerInvariant()).Where(w => w.Length > 2 && !Stop.Contains(w)).ToHashSet();

    /// <summary>
    /// Ranks the people who could take a piece of work: how much they already carry, how late they already are, whether they work on that project,
    /// and whether they have finished similar work before (matching words in the titles of tasks they completed). The reasons are listed so the
    /// recommendation can be explained, not just stated.
    /// </summary>
    public async Task<(string Text, int Count)> SuggestAssigneeAsync(string title, Guid? projectId, string? projectLabel, double? estimateHours, DateOnly? due, CancellationToken ct)
    {
        var tid = ctx.RequireTenantId();
        var candidates = await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid && m.Role != TenantRole.Guest && m.User!.IsActive)
            .Select(m => new { m.UserId, m.User!.DisplayName, m.WeeklyCapacityMinutes, JobRole = db.OrgRoles.Where(r => r.Id == m.OrgRoleId).Select(r => r.Name).FirstOrDefault() })
            .Take(300).ToListAsync(ct);
        if (candidates.Count == 0) return ("There is nobody to assign to.", 0);
        var ids = candidates.Select(c => c.UserId).ToList();
        var counts = await workItems.CountsAsync(ids, WorkItemScope.Caller, ct);
        var words = Words(title);

        // What each person has finished before: in this project, and anything whose title shares words with the new work.
        var cutoff = clock.Now.AddDays(-365);
        var doneQuery = access.VisibleTasks().AsNoTracking().Where(t => t.AssigneeId != null && ids.Contains(t.AssigneeId.Value) && t.CompletedAt != null && t.CompletedAt >= cutoff);
        var done = await doneQuery.OrderByDescending(t => t.CompletedAt).Select(t => new { Who = t.AssigneeId!.Value, t.Title, t.ProjectId, t.CompletedAt, t.DueDate }).Take(2000).ToListAsync(ct);
        var scored = new List<(string Name, double Score, string Why)>();
        foreach (var c in candidates)
        {
            var n = counts.GetValueOrDefault(c.UserId);
            var mine = done.Where(d => d.Who == c.UserId).ToList();
            var inProject = projectId is { } pid ? mine.Count(d => d.ProjectId == pid) : 0;
            var similar = words.Count == 0 ? 0 : mine.Count(d => Words(d.Title).Overlaps(words));
            var onTime = mine.Count(d => d.DueDate is { } dd && DateOnly.FromDateTime(d.CompletedAt!.Value) <= dd);
            var dated = mine.Count(d => d.DueDate != null);
            var open = n?.Open ?? 0; var overdue = n?.Overdue ?? 0; var thisWeek = n?.DueThisWeek ?? 0;
            var score = Math.Min(inProject, 8) * 1.2 + Math.Min(similar, 6) * 2.0 + (dated >= 3 ? 3.0 * onTime / dated : 0) - open * 0.6 - overdue * 2.0 - thisWeek * 0.4 + (n?.DoneLast30Days > 0 ? 0.5 : 0);
            var why = new List<string> { $"{open} open, {overdue} overdue, {thisWeek} due this week" };
            if (inProject > 0) why.Add($"finished {inProject} task{(inProject == 1 ? "" : "s")} in this project");
            if (similar > 0) why.Add($"{similar} similar task{(similar == 1 ? "" : "s")} done before");
            if (dated >= 3) why.Add($"{Num(100.0 * onTime / dated)}% of dated work delivered on time");
            if (c.JobRole is not null) why.Add($"job role {Clean(c.JobRole)}");
            scored.Add((Clean(c.DisplayName), score, string.Join("; ", why)));
        }
        var top = scored.OrderByDescending(s => s.Score).Take(5).ToList();
        var sb = new StringBuilder($"Best fits for “{Clean(title)}”{(projectLabel is null ? "" : $" on {projectLabel}")}{(due is null ? "" : $", due {due:d MMM yyyy}")}{(estimateHours is null ? "" : $", about {Num(estimateHours.Value)}h")}, best first:\n");
        var rank = 1;
        foreach (var t in top) sb.AppendLine($"{rank++}. {t.Name} (score {Num(t.Score)}): {t.Why}");
        sb.AppendLine("Scores favour people with room and a track record on similar work; they are a guide, not a rule. State the trade-off when the best fit is already stretched.");
        return (sb.ToString(), top.Count);
    }

    // ------------------------------------------------------------------ what the past says

    /// <summary>On-time rate, cycle time, weekly pace, the projects slipping most and (where the person may see people's work) who delivers on time.</summary>
    public async Task<(string Text, int Count)> HistoryInsightsAsync(Guid? projectId, string? projectLabel, int days, CancellationToken ct)
    {
        days = Math.Clamp(days, 14, 365);
        var today = clock.Today;
        var from = clock.Now.AddDays(-days);
        var q = access.VisibleTasks().AsNoTracking();
        if (projectId is { } pid) q = q.Where(t => t.ProjectId == pid);
        var finished = await q.Where(t => t.CompletedAt != null && t.CompletedAt >= from)
            .Select(t => new { t.ProjectId, Project = t.Project!.Key, t.Priority, t.AssigneeId, t.CreatedAt, t.CompletedAt, t.DueDate, t.EstimatedHours, t.ActualHours }).Take(5000).ToListAsync(ct);
        var open = await q.Where(t => t.Status!.Category != StatusCategory.Done && t.Status.Category != StatusCategory.Cancelled)
            .Select(t => new { t.ProjectId, Project = t.Project!.Key, t.DueDate, t.AssigneeId }).Take(5000).ToListAsync(ct);

        var sb = new StringBuilder($"History of {(projectLabel ?? "the work the person can see")} over the last {days} days (project tasks).\n");
        if (finished.Count == 0 && open.Count == 0) return (sb + "There is no task history yet, so nothing can be concluded from past data.", 0);

        sb.AppendLine($"Finished: {finished.Count}. Open now: {open.Count}, of which {open.Count(o => o.DueDate is { } d && d < today)} are past due and {open.Count(o => o.AssigneeId is null)} have no assignee.");
        var dated = finished.Where(f => f.DueDate != null).ToList();
        if (dated.Count > 0)
        {
            var onTime = dated.Count(f => DateOnly.FromDateTime(f.CompletedAt!.Value) <= f.DueDate!.Value);
            sb.AppendLine($"On-time delivery: {Num(100.0 * onTime / dated.Count)}% of {dated.Count} dated tasks finished by their due date; the late ones were late by {Num(dated.Where(f => DateOnly.FromDateTime(f.CompletedAt!.Value) > f.DueDate!.Value).Select(f => (double)(DateOnly.FromDateTime(f.CompletedAt!.Value).DayNumber - f.DueDate!.Value.DayNumber)).DefaultIfEmpty(0).Average())} days on average.");
        }
        if (finished.Count > 0)
        {
            var cycle = finished.Select(f => (f.CompletedAt!.Value - f.CreatedAt).TotalDays).OrderBy(x => x).ToList();
            sb.AppendLine($"Cycle time (created to finished): median {Num(cycle[cycle.Count / 2])} days, 90th percentile {Num(cycle[(int)(cycle.Count * 0.9) == cycle.Count ? cycle.Count - 1 : (int)(cycle.Count * 0.9)])} days.");
            var byPriority = finished.GroupBy(f => f.Priority).OrderByDescending(g => (int)g.Key).Select(g => $"{g.Key} {Num(g.Average(f => (f.CompletedAt!.Value - f.CreatedAt).TotalDays))}d");
            sb.AppendLine("Average cycle time by priority: " + string.Join(", ", byPriority) + ".");
            var est = finished.Where(f => f.EstimatedHours > 0 && f.ActualHours > 0).ToList();
            if (est.Count >= 5) sb.AppendLine($"Estimates: actual effort was {Num((double)(est.Sum(f => f.ActualHours!.Value) / est.Sum(f => f.EstimatedHours!.Value)) * 100)}% of estimated across {est.Count} tasks (above 100% means work tends to take longer than planned).");
            var weeks = Enumerable.Range(0, 8).Select(i => { var end = clock.Now.AddDays(-7 * i); var start = end.AddDays(-7); return finished.Count(f => f.CompletedAt > start && f.CompletedAt <= end); }).Reverse().ToList();
            sb.AppendLine("Finished per week, oldest to latest of the last 8 weeks: " + string.Join(", ", weeks) + (weeks.Count >= 4 && weeks.TakeLast(2).Sum() < weeks.Take(2).Sum() * 0.6 ? " (pace is dropping)." : "."));
        }
        if (projectId is null)
        {
            var slipping = open.Where(o => o.DueDate is { } d && d < today).GroupBy(o => o.Project).OrderByDescending(g => g.Count()).Take(5).Select(g => $"{g.Key} {g.Count()} overdue of {open.Count(o => o.Project == g.Key)} open");
            var list = string.Join("; ", slipping);
            if (list.Length > 0) sb.AppendLine("Projects with the most overdue work: " + list + ".");
        }

        // Who delivers on time: only where the person may see people's workload, otherwise just their own figures.
        var scopes = await workload.AvailableAsync(ct);
        var me = ctx.RequireUserId();
        var visible = scopes.Any(s => s is WorkloadScope.Everyone or WorkloadScope.Reports) ? null : new HashSet<Guid> { me };
        var perPerson = dated.Where(f => f.AssigneeId != null && (visible is null || visible.Contains(f.AssigneeId.Value))).GroupBy(f => f.AssigneeId!.Value).Where(g => g.Count() >= 3)
            .Select(g => new { g.Key, N = g.Count(), OnTime = g.Count(f => DateOnly.FromDateTime(f.CompletedAt!.Value) <= f.DueDate!.Value) }).OrderByDescending(x => (double)x.OnTime / x.N).Take(8).ToList();
        if (perPerson.Count > 0)
        {
            var names = await db.Users.AsNoTracking().Where(u => perPerson.Select(p => p.Key).Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
            sb.AppendLine("On-time rate per person (3+ dated tasks): " + string.Join("; ", perPerson.Select(p => $"{Clean(names.GetValueOrDefault(p.Key) ?? "?")} {Num(100.0 * p.OnTime / p.N)}% of {p.N}")) + ".");
        }
        sb.AppendLine("Use these figures to say what is likely to happen next and why; do not claim causes the numbers do not show.");
        return (sb.ToString(), finished.Count + open.Count);
    }

    // ------------------------------------------------------------------ the proactive feed (no model involved)

    /// <summary>Things worth looking at today, found by rules over the person's own data. Each has a ready-made question for the assistant.</summary>
    public async Task<IReadOnlyList<AiInsightDto>> InsightsAsync(CancellationToken ct)
    {
        var me = ctx.RequireUserId(); var today = clock.Today;
        var list = new List<AiInsightDto>();

        var mine = (await workItems.CountsAsync([me], WorkItemScope.Caller, ct)).GetValueOrDefault(me);
        if (mine is { Overdue: > 0 })
            list.Add(new("my-overdue", "high", $"{mine.Overdue} of your items {(mine.Overdue == 1 ? "is" : "are")} overdue", $"{mine.Open} open in total, {mine.DueThisWeek} more due this week.", "Which of my overdue items should I do first, and which can I hand to someone else?"));

        try
        {
            var scopes = await workload.AvailableAsync(ct);
            if (scopes.Any(s => s is WorkloadScope.Everyone or WorkloadScope.Reports))
            {
                var (people, _) = await LoadsAsync(scopes.Contains(WorkloadScope.Everyone) ? WorkloadScope.Everyone : WorkloadScope.Reports, ct);
                if (people.Count >= 2)
                {
                    var avg = people.Average(p => (double)p.Open);
                    var over = people.Where(p => p.Overdue >= 3 || (p.Open >= 5 && p.Open > avg * 1.5)).OrderByDescending(p => p.Overdue).ToList();
                    var room = people.Where(p => p.Open <= avg * 0.5 && p.Overdue == 0).ToList();
                    if (over.Count > 0)
                        list.Add(new("overloaded", "high", over.Count == 1 ? $"{over[0].Name} is stretched" : $"{over.Count} people are stretched",
                            string.Join("; ", over.Take(3).Select(p => $"{p.Name}: {p.Open} open, {p.Overdue} overdue")) + (room.Count > 0 ? $". {string.Join(", ", room.Take(2).Select(p => p.Name))} {(room.Count == 1 ? "has" : "have")} room." : "."),
                            room.Count > 0 ? "Rebalance the team's work: who is overloaded, who has room, and which items should move? Prepare the reassignments." : "Who on the team is overloaded and what should we do about it?"));
                }
            }
        }
        catch (AppException) { /* a workload the person may not see is simply left out */ }

        var unassigned = await access.VisibleTasks().AsNoTracking().CountAsync(t => t.AssigneeId == null && t.ParentTaskId == null && t.Status!.Category != StatusCategory.Done && t.Status.Category != StatusCategory.Cancelled, ct);
        if (unassigned > 0 && ctx.Role != TenantRole.Guest)
            list.Add(new("unassigned", "medium", $"{unassigned} open task{(unassigned == 1 ? " has" : "s have")} no owner", "Work without an owner is the work that slips.", "Suggest the best person for each unassigned task based on workload and who has done similar work, then prepare the assignments."));

        var groups = await status.GroupsAsync(ct: ct);
        var risky = groups.SelectMany(g => g.Projects).Where(p => p.Health is ProjectHealth.AtRisk or ProjectHealth.Delayed).OrderByDescending(p => p.Health).Take(3).ToList();
        foreach (var p in risky)
            list.Add(new($"risk-{p.Key}", p.Health == ProjectHealth.Delayed ? "high" : "medium", $"{p.Name} is {(p.Health == ProjectHealth.Delayed ? "delayed" : "at risk")}", $"{p.Key}, {p.Progress}% done.", $"Analyse why {p.Name} ({p.Key}) is {(p.Health == ProjectHealth.Delayed ? "delayed" : "at risk")}, what the history says about how late it will land, and recommend what to do."));

        var order = new Dictionary<string, int> { ["high"] = 0, ["medium"] = 1, ["low"] = 2 };
        return list.OrderBy(i => order[i.Severity]).Take(5).ToList();
    }
}
