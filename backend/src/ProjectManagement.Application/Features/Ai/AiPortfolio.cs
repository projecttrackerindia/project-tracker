using System.Globalization;
using System.Text;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Ai;

public sealed record PortfolioRiskDto(Guid ProjectId, string Key, string Name, string? Group, string Health, int Progress, string? Owner, DateOnly? StartDate, DateOnly? DueDate, int DelayedDays,
    int OpenTasks, int OverdueTasks, int BlockedTasks, int OpenActionItems, int OverdueActionItems, int FinishedLast28Days,
    DateOnly? ProjectedFinish, int? ProjectedSlipDays, string Confidence, int Score, string Level, IReadOnlyList<string> Reasons);
public sealed record PortfolioSlipDto(Guid ProjectId, string ProjectKey, string Project, DateOnly? Previous, DateOnly? Revised, int? DaysShifted, string? Reason, string? Dependency, string? By, DateTime At);
public sealed record PortfolioPersonDto(string Name, int Projects, int OpenTasks, int OverdueTasks);
public sealed record PortfolioBriefDto(DateOnly AsOf, int Projects, int OnTrack, int AtRisk, int Delayed, int OnHold, int OverdueTasks, int BlockedTasks, int OpenActionItems, int OverdueActionItems,
    int DateChangesLast30Days, IReadOnlyList<string> Headlines, IReadOnlyList<PortfolioRiskDto> Ranked, IReadOnlyList<PortfolioSlipDto> RecentSlips, IReadOnlyList<PortfolioPersonDto> Stretched);

/// <summary>
/// The portfolio, read the way a delivery director would: which projects are in trouble and why, when each is really likely to finish (from what the
/// team has actually been finishing, not from the plan), what is blocked, which dates moved and for what reason, which action items are overdue and who is
/// stretched across the projects that are in trouble. Every figure is computed here from the data the signed-in person may open (their projects, their
/// tasks, their action items) so what is shown, and what the assistant is told, never reaches beyond that; the model reasons from these numbers and
/// does not do the arithmetic itself.
/// </summary>
public class AiPortfolio(IAppDbContext db, ICurrentContext ctx, AppClock clock, ProjectAccess access, ProjectService projects, PermissionService permissions)
{
    private const int WindowDays = 28;
    private static string Num(double v) => v.ToString("0.#", CultureInfo.InvariantCulture);
    private static string Day(DateOnly? d) => d is { } x ? x.ToString("d MMM yyyy", CultureInfo.InvariantCulture) : "no date";
    private static bool Open(StatusCategory c) => c is not (StatusCategory.Done or StatusCategory.Cancelled);

    /// <summary>When the open work is likely to be finished at the pace of the last four weeks, and how much to trust that.</summary>
    public static (DateOnly? Finish, int? SlipDays, string Confidence) Forecast(int remaining, int finishedLast28, DateOnly today, DateOnly? due)
    {
        if (remaining <= 0) return (today, null, "high");
        if (finishedLast28 <= 0) return (null, null, "none");
        var perDay = finishedLast28 / (double)WindowDays;
        var finish = today.AddDays((int)Math.Ceiling(remaining / perDay));
        var confidence = finishedLast28 >= 8 ? "high" : finishedLast28 >= 3 ? "medium" : "low";
        return (finish, due is { } d ? finish.DayNumber - d.DayNumber : null, confidence);
    }

    public async Task<PortfolioBriefDto> BriefAsync(CancellationToken ct = default)
    {
        ctx.RequireTenantId();
        await permissions.RequireModuleAsync(Modules.Projects, AccessLevel.View, ct);
        var today = clock.Today;
        var since28 = clock.Now.AddDays(-WindowDays);
        var since30 = clock.Now.AddDays(-30);

        var rows = await access.VisibleProjects().AsNoTracking().Where(p => p.Status != ProjectStatus.Archived && p.Status != ProjectStatus.Completed && p.Status != ProjectStatus.Cancelled)
            .Select(p => new { p.Id, p.Key, p.Name, p.Status, p.StartDate, p.DueDate, p.OwnerId, p.ProjectGroupId, Project = p }).Take(500).ToListAsync(ct);
        var ids = rows.Select(r => r.Id).ToList();
        var stats = ids.Count == 0 ? [] : await projects.GetStatsAsync(ids, ct);
        var groupNames = await db.ProjectGroups.AsNoTracking().ToDictionaryAsync(g => g.Id, g => g.Name, ct);
        var ownerIds = rows.Select(r => r.OwnerId).Distinct().ToList();
        var owners = await db.Users.AsNoTracking().Where(u => ownerIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);

        // Tasks the person can open, in those projects.
        var tasks = ids.Count == 0 ? [] : await access.VisibleTasks().AsNoTracking().Where(t => ids.Contains(t.ProjectId))
            .Select(t => new { t.Id, t.ProjectId, t.DueDate, t.CompletedAt, Cat = t.Status!.Category, t.AssigneeId }).Take(40_000).ToListAsync(ct);
        var perProject = tasks.GroupBy(t => t.ProjectId).ToDictionary(g => g.Key, g => new
        {
            Open = g.Count(t => Open(t.Cat)),
            Overdue = g.Count(t => Open(t.Cat) && t.DueDate is { } d && d < today),
            Finished = g.Count(t => t.Cat == StatusCategory.Done && t.CompletedAt is { } c && c >= since28),
        });
        // Waiting on something that is not finished.
        var blocked = ids.Count == 0 ? [] : await (from d in db.TaskDependencies.AsNoTracking()
                                                   join t in access.VisibleTasks().AsNoTracking() on d.TaskId equals t.Id
                                                   where ids.Contains(t.ProjectId) && t.Status!.Category != StatusCategory.Done && t.Status.Category != StatusCategory.Cancelled
                                                   join p in db.Tasks.AsNoTracking() on d.DependsOnTaskId equals p.Id
                                                   where p.Status!.Category != StatusCategory.Done && p.Status.Category != StatusCategory.Cancelled
                                                   select new { d.TaskId, t.ProjectId }).Distinct().ToListAsync(ct);
        var blockedBy = blocked.GroupBy(b => b.ProjectId).ToDictionary(g => g.Key, g => g.Count());

        // Action items belong to the project and are visible with it.
        var items = ids.Count == 0 ? [] : await db.WorkTasks.AsNoTracking().Where(w => w.Kind == WorkTaskKind.ActionItem && w.RelatedProjectId != null && ids.Contains(w.RelatedProjectId.Value))
            .Select(w => new { Project = w.RelatedProjectId!.Value, w.Status, w.DueDate }).Take(20_000).ToListAsync(ct);
        static bool ItemOpen(WorkTaskStatus s) => s is WorkTaskStatus.ToDo or WorkTaskStatus.InProgress or WorkTaskStatus.OnHold;
        var itemsBy = items.GroupBy(i => i.Project).ToDictionary(g => g.Key, g => (Open: g.Count(i => ItemOpen(i.Status)), Overdue: g.Count(i => ItemOpen(i.Status) && i.DueDate is { } d && d < today)));

        // Delivery dates that moved.
        var changes = ids.Count == 0 ? [] : await db.DueDateChanges.AsNoTracking().Where(c => ids.Contains(c.ProjectId) && c.CreatedAt >= since30).OrderByDescending(c => c.CreatedAt).Take(300).ToListAsync(ct);
        var visibleTaskIds = tasks.Select(t => t.Id).ToHashSet();
        changes = changes.Where(c => c.TaskId is null || visibleTaskIds.Contains(c.TaskId.Value)).ToList();
        var baseline = ids.Count == 0 ? [] : (await db.DueDateChanges.AsNoTracking().Where(c => ids.Contains(c.ProjectId) && c.TaskId == null).OrderBy(c => c.CreatedAt).Select(c => new { c.ProjectId, c.Previous, c.Revised }).ToListAsync(ct))
            .GroupBy(c => c.ProjectId).ToDictionary(g => g.Key, g => g.First().Previous ?? g.First().Revised);

        var risks = new List<PortfolioRiskDto>();
        foreach (var r in rows)
        {
            var st = stats.GetValueOrDefault(r.Id) ?? new ProjectStatsDto(0, 0, 0, 0, 0, 0);
            var health = ProjectMetrics.Health(r.Project, st, today);
            var progress = ProjectMetrics.Progress(st);
            var t = perProject.GetValueOrDefault(r.Id);
            var open = t?.Open ?? 0; var overdue = t?.Overdue ?? 0; var finished = t?.Finished ?? 0;
            var blockedN = blockedBy.GetValueOrDefault(r.Id);
            var ai = itemsBy.GetValueOrDefault(r.Id);
            var original = baseline.GetValueOrDefault(r.Id) ?? r.DueDate;
            var delayed = original is { } o && r.DueDate is { } cur && cur > o ? cur.DayNumber - o.DayNumber : 0;
            var (finish, slip, conf) = Forecast(open, finished, today, r.DueDate);

            var reasons = new List<string>(); var score = 0.0;
            if (health == ProjectHealth.Delayed) { score += 5; reasons.Add($"Past its due date ({Day(r.DueDate)}) with {progress}% done"); }
            else if (health == ProjectHealth.AtRisk) { score += 3; reasons.Add("Marked at risk by its own progress against the plan"); }
            if (overdue > 0) { score += Math.Min(overdue, 6); reasons.Add($"{overdue} overdue task{(overdue == 1 ? "" : "s")} of {open} open"); }
            if (blockedN > 0) { score += Math.Min(blockedN * 2, 4); reasons.Add($"{blockedN} task{(blockedN == 1 ? " is" : "s are")} waiting on unfinished work"); }
            if (delayed > 0) { score += Math.Min(delayed / 3.0, 4); reasons.Add($"Delivery date already moved by {delayed} day{(delayed == 1 ? "" : "s")}"); }
            if (slip is > 0 && r.DueDate is not null) { score += Math.Min(slip.Value / 7.0, 4) * (conf == "low" ? 0.5 : 1); reasons.Add($"At the pace of the last 4 weeks it finishes about {Day(finish)}, {slip} day{(slip == 1 ? "" : "s")} after its due date ({conf} confidence)"); }
            else if (conf == "none" && open > 0) { score += 2; reasons.Add($"{open} open task{(open == 1 ? "" : "s")} and nothing finished in the last 4 weeks"); }
            if (r.StartDate is { } s0 && r.DueDate is { } d0 && d0 > s0 && health != ProjectHealth.Delayed)
            {
                var span = d0.DayNumber - s0.DayNumber; var elapsed = Math.Clamp((today.DayNumber - s0.DayNumber) / (double)span, 0, 1);
                if (elapsed > 0.3 && elapsed - progress / 100.0 > 0.2) { score += 2; reasons.Add($"{Num(elapsed * 100)}% of the time has passed and {progress}% is done"); }
            }
            if (ai.Overdue > 0) { score += Math.Min(ai.Overdue, 3); reasons.Add($"{ai.Overdue} overdue action item{(ai.Overdue == 1 ? "" : "s")}"); }
            if (r.Status == ProjectStatus.OnHold) { score += 1; reasons.Add("On hold"); }
            var rounded = (int)Math.Round(score);
            risks.Add(new PortfolioRiskDto(r.Id, r.Key, r.Name, r.ProjectGroupId is { } g ? groupNames.GetValueOrDefault(g) : null, health.ToString(), progress, owners.GetValueOrDefault(r.OwnerId),
                r.StartDate, r.DueDate, delayed, open, overdue, blockedN, ai.Open, ai.Overdue, finished, finish, slip, conf, rounded,
                rounded >= 9 ? "Critical" : rounded >= 5 ? "High" : rounded >= 2 ? "Medium" : "Low", reasons.Take(5).ToList()));
        }
        var ranked = risks.OrderByDescending(x => x.Score).ThenByDescending(x => x.OverdueTasks).ThenBy(x => x.Name).ToList();

        // Who is carrying several of the projects in trouble.
        var troubled = ranked.Where(x => x.Score >= 5).Select(x => x.ProjectId).ToHashSet();
        var load = tasks.Where(t => t.AssigneeId != null && troubled.Contains(t.ProjectId) && Open(t.Cat)).GroupBy(t => t.AssigneeId!.Value)
            .Select(g => new { Who = g.Key, Projects = g.Select(t => t.ProjectId).Distinct().Count(), Open = g.Count(), Overdue = g.Count(t => t.DueDate is { } d && d < today) })
            .Where(x => x.Projects >= 2 || x.Overdue >= 4).OrderByDescending(x => x.Projects).ThenByDescending(x => x.Overdue).Take(5).ToList();
        var whoIds = load.Select(l => l.Who).ToList();
        var names = whoIds.Count == 0 ? [] : await db.Users.AsNoTracking().Where(u => whoIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        var stretched = load.Select(l => new PortfolioPersonDto(names.GetValueOrDefault(l.Who) ?? "Someone", l.Projects, l.Open, l.Overdue)).ToList();

        var byKey = rows.ToDictionary(r => r.Id);
        var slipIds = changes.Where(c => c.CreatedBy != null).Select(c => c.CreatedBy!.Value).Distinct().ToList();
        var slipNames = slipIds.Count == 0 ? [] : await db.Users.AsNoTracking().Where(u => slipIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        var slips = changes.Where(c => c.TaskId is null).Take(10).Select(c => new PortfolioSlipDto(c.ProjectId, byKey[c.ProjectId].Key, byKey[c.ProjectId].Name, c.Previous, c.Revised, DueDateHistory.DaysShifted(c.Previous, c.Revised),
            c.Reason, c.Dependency, c.CreatedBy is { } u ? slipNames.GetValueOrDefault(u) : null, c.CreatedAt)).ToList();

        var onTrack = ranked.Count(x => x.Health == "OnTrack"); var atRisk = ranked.Count(x => x.Health == "AtRisk"); var late = ranked.Count(x => x.Health == "Delayed");
        var totalOverdue = ranked.Sum(x => x.OverdueTasks);
        var headlines = new List<string>();
        if (ranked.Count == 0) headlines.Add("There are no active projects you can see.");
        else
        {
            headlines.Add($"{ranked.Count} active project{(ranked.Count == 1 ? "" : "s")}: {onTrack} on track, {atRisk} at risk, {late} delayed.");
            if (totalOverdue > 0) { var worst = ranked.OrderByDescending(x => x.OverdueTasks).First(); headlines.Add($"{totalOverdue} tasks are overdue; {worst.OverdueTasks} of them in {worst.Name}."); }
            foreach (var p in ranked.Where(x => x.ProjectedSlipDays is > 0 && x.Confidence != "low").OrderByDescending(x => x.ProjectedSlipDays).Take(2))
                headlines.Add($"{p.Name} is likely to finish about {p.ProjectedSlipDays} days after its due date ({p.Confidence} confidence).");
            if (items.Count(i => ItemOpen(i.Status) && i.DueDate is { } d && d < today) is > 0 and var oi) headlines.Add($"{oi} action item{(oi == 1 ? " is" : "s are")} overdue across the portfolio.");
            if (changes.Count(c => c.TaskId is null) is > 0 and var moved) headlines.Add($"{moved} project delivery date{(moved == 1 ? " was" : "s were")} moved in the last 30 days.");
        }
        return new PortfolioBriefDto(today, ranked.Count, onTrack, atRisk, late, rows.Count(r => r.Status == ProjectStatus.OnHold), totalOverdue, ranked.Sum(x => x.BlockedTasks),
            ranked.Sum(x => x.OpenActionItems), ranked.Sum(x => x.OverdueActionItems), changes.Count(c => c.TaskId is null), headlines, ranked, slips, stretched);
    }

    /// <summary>The brief as text for the model: the headline numbers, the projects that need attention with their reasons and forecast, slips and who is stretched.</summary>
    public static string ToText(PortfolioBriefDto b, int top = 12)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"Portfolio as of {Day(b.AsOf)} (only projects the person can open).");
        foreach (var h in b.Headlines) sb.AppendLine("- " + h);
        if (b.Ranked.Count == 0) return sb.ToString();
        sb.AppendLine($"Totals: {b.OverdueTasks} overdue tasks, {b.BlockedTasks} blocked tasks, {b.OpenActionItems} open action items ({b.OverdueActionItems} overdue), {b.DateChangesLast30Days} project date changes in 30 days.");
        sb.AppendLine("Projects, highest risk first (key | name | risk | health | progress | owner | due | projected finish | open/overdue/blocked tasks | action items open/overdue | reasons):");
        foreach (var p in b.Ranked.Take(top))
            sb.AppendLine($"{p.Key} | {p.Name} | {p.Level} ({p.Score}) | {p.Health} | {p.Progress}% | {p.Owner ?? "no owner"} | due {Day(p.DueDate)} | " +
                $"{(p.ProjectedFinish is { } f ? $"{Day(f)} ({(p.ProjectedSlipDays is { } s ? (s > 0 ? $"+{s}d" : $"{s}d") : "n/a")}, {p.Confidence} confidence)" : "cannot be forecast: no recent progress")} | " +
                $"{p.OpenTasks}/{p.OverdueTasks}/{p.BlockedTasks} | {p.OpenActionItems}/{p.OverdueActionItems} | {(p.Reasons.Count == 0 ? "no concerns" : string.Join("; ", p.Reasons))}");
        if (b.Ranked.Count > top) sb.AppendLine($"…and {b.Ranked.Count - top} lower-risk projects.");
        if (b.RecentSlips.Count > 0)
        {
            sb.AppendLine("Delivery dates moved in the last 30 days (project | from → to | days | reason | waiting on | by):");
            foreach (var s in b.RecentSlips) sb.AppendLine($"{s.ProjectKey} | {Day(s.Previous)} → {Day(s.Revised)} | {s.DaysShifted?.ToString("+0;-0") ?? "?"} | {s.Reason ?? "no reason given"} | {s.Dependency ?? "-"} | {s.By ?? "-"}");
        }
        if (b.Stretched.Count > 0)
            sb.AppendLine("People carrying several projects in trouble: " + string.Join("; ", b.Stretched.Select(p => $"{p.Name} ({p.Projects} projects, {p.OpenTasks} open tasks, {p.OverdueTasks} overdue)")) + ".");
        sb.AppendLine("The forecast uses the number of tasks finished in the last 28 days; treat it as an estimate, say how confident it is, and do not present it as a commitment.");
        return sb.ToString();
    }
}
