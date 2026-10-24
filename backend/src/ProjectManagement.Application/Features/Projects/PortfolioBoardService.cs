using System.Collections.Concurrent;
using System.Globalization;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Application.Features.Reports;
using ProjectManagement.Application.Features.Time;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Projects;

public record PortfolioFilter(Guid? TeamId = null, Guid? OwnerId = null, Guid? GroupId = null, string? Health = null, DateOnly? DueFrom = null, DateOnly? DueTo = null);
public record PortfolioChoiceDto(Guid Id, string Name);
public record DecisionOptionDto(string Id, string Kind, string Title, string Effect, DateOnly? Finish, int? SlipDays, IReadOnlyList<string> Steps, string Why, Guid? PersonId = null);
public record PortfolioDecisionDto(Guid ProjectId, string Key, string Name, string Headline, IReadOnlyList<string> Causes, int SlipDays, DateOnly? DueDate, DateOnly? Finish,
    string Confidence, IReadOnlyList<DecisionOptionDto> Options, int WaitingProposals);
public record MoneyMonthDto(string Month, decimal Cost);
public record ProjectMoneyDto(Guid ProjectId, string Key, string Name, decimal? Budget, decimal Spent, decimal? Forecast, decimal? Overrun, decimal? UsedShare,
    IReadOnlyList<MoneyMonthDto> Burn, string? Warning, decimal? BudgetHours, decimal HoursUsed, decimal? RemainingHours, int PeopleWithoutRate, string Basis);
public record PortfolioMoneyDto(bool Entitled, bool ShowMoney, string Currency, decimal Budget, decimal Spent, decimal Forecast, int Overrunning,
    IReadOnlyList<ProjectMoneyDto> Projects, IReadOnlyList<MoneyMonthDto> Burn, IReadOnlyList<string> Notes);
public record CapacityWeekDto(DateOnly WeekStart, int CapacityMinutes, int DemandMinutes, int? Load);
public record CapacityProjectDto(Guid ProjectId, string Key, string Name, int Minutes, int Tasks);
public record CapacityPersonDto(Guid UserId, string Name, int? Load, IReadOnlyList<CapacityWeekDto> Weeks, IReadOnlyList<CapacityProjectDto> Projects, int LeaveDays, int UnestimatedTasks);
public record PortfolioCapacityDto(DateOnly From, DateOnly To, int People, IReadOnlyList<CapacityPersonDto> Over, IReadOnlyList<CapacityProjectDto> ProjectsAtRisk, IReadOnlyList<string> Notes);
public record PortfolioBoardDto(DateOnly AsOf, PortfolioFilter Filter, PortfolioBriefDto Brief, IReadOnlyList<PortfolioDecisionDto> Decisions, PortfolioMoneyDto Money,
    PortfolioCapacityDto Capacity, IReadOnlyList<PortfolioChoiceDto> Owners, IReadOnlyList<PortfolioChoiceDto> Groups, string Summary);
public record TimelineMilestoneDto(Guid Id, string Name, DateOnly? Due, string Status);
public record TimelineProjectDto(Guid Id, string Key, string Name, string Health, string? Group, DateOnly? Start, DateOnly? Due, DateOnly? OriginalDue, DateOnly? Forecast, int Progress,
    IReadOnlyList<TimelineMilestoneDto> Milestones, IReadOnlyList<Guid> DependsOn);
public record PortfolioTimelineDto(DateOnly From, DateOnly To, IReadOnlyList<TimelineProjectDto> Projects);
public record ApplyDecisionRequest(string Option, PortfolioFilter? Filter = null);
public record ApplyDecisionResult(int Proposals, string Message);
public record PortfolioAiSummaryDto(string Text, string Model, DateTime At, bool Cached);

/// <summary>
/// The portfolio as a board for leaders: the decisions to make this week (a project heading late, why, and options with their effect, one
/// click turning an option into proposals for the project to approve), the money (budget against cost from the timesheet, burn by month and
/// a forecast at completion), the capacity of the next four weeks (who is over 100% and which projects that puts at risk), a timeline of every
/// project, a summary in words, filters and an export for the board meeting. Built on the same rules-based brief as the rest of the page, over
/// the projects the person may open only.
/// </summary>
public class PortfolioBoardService(IAppDbContext db, ICurrentContext ctx, AppClock clock, AiPortfolio portfolio, ProjectAccess access, PermissionService permissions,
    EntitlementService entitlements, CapacityService capacity, Recorder recorder, IAiClient ai, AiCreditService credits, IOptions<AiOptions> aiOptions)
{
    public const int CapacityWeeks = 4;
    /// <summary>A task with no estimate counts as this much work when filling the next four weeks (said in the notes).</summary>
    public const int DefaultTaskMinutes = 4 * 60;
    private static string Day(DateOnly? d) => d is { } x ? x.ToString("d MMM", CultureInfo.InvariantCulture) : "no date";
    private static string Plural(int n, string one, string many) => $"{n} {(n == 1 ? one : many)}";
    private static bool Open(StatusCategory c) => c is not (StatusCategory.Done or StatusCategory.Cancelled);
    private bool IsAdmin => ctx.Role is TenantRole.Owner or TenantRole.Admin;

    // ---------------------------------------------------------------- the board

    public async Task<PortfolioBoardDto> BoardAsync(PortfolioFilter filter, CancellationToken ct = default)
    {
        var brief = await portfolio.BriefAsync(filter.TeamId, ct);
        var lens = await access.RequireLensAsync(filter.TeamId, ct);
        var meta = await access.LensProjects(lens).AsNoTracking().Where(p => p.Status != ProjectStatus.Archived && p.Status != ProjectStatus.Completed && p.Status != ProjectStatus.Cancelled)
            .Select(p => new { p.Id, p.OwnerId, p.ProjectGroupId }).Take(500).ToListAsync(ct);
        var byId = meta.ToDictionary(m => m.Id);
        var ranked = brief.Ranked.Where(r => byId.ContainsKey(r.ProjectId)
            && (filter.OwnerId is null || byId[r.ProjectId].OwnerId == filter.OwnerId)
            && (filter.GroupId is null || byId[r.ProjectId].ProjectGroupId == filter.GroupId)
            && (string.IsNullOrWhiteSpace(filter.Health) || string.Equals(r.Health, filter.Health, StringComparison.OrdinalIgnoreCase))
            && (filter.DueFrom is null || r.DueDate >= filter.DueFrom) && (filter.DueTo is null || r.DueDate <= filter.DueTo)).ToList();
        var filtered = brief with
        {
            Ranked = ranked, Projects = ranked.Count, OnTrack = ranked.Count(x => x.Health == "OnTrack"), AtRisk = ranked.Count(x => x.Health == "AtRisk"),
            Delayed = ranked.Count(x => x.Health == "Delayed"), OverdueTasks = ranked.Sum(x => x.OverdueTasks), BlockedTasks = ranked.Sum(x => x.BlockedTasks),
            OpenActionItems = ranked.Sum(x => x.OpenActionItems), OverdueActionItems = ranked.Sum(x => x.OverdueActionItems),
            RecentSlips = brief.RecentSlips.Where(s => ranked.Any(r => r.ProjectId == s.ProjectId)).ToList(),
        };
        var ids = ranked.Select(r => r.ProjectId).ToList();
        var cap = await CapacityAsync(ids, ct);
        var decisions = await DecisionsAsync(ranked, cap, ct);
        var money = await MoneyAsync(ids, ct);

        var ownerIds = meta.Select(m => m.OwnerId).Distinct().ToList();
        var owners = await db.Users.AsNoTracking().Where(u => ownerIds.Contains(u.Id)).OrderBy(u => u.DisplayName).Select(u => new PortfolioChoiceDto(u.Id, u.DisplayName)).ToListAsync(ct);
        var groupIds = meta.Where(m => m.ProjectGroupId != null).Select(m => m.ProjectGroupId!.Value).Distinct().ToList();
        var groups = await db.ProjectGroups.AsNoTracking().Where(g => groupIds.Contains(g.Id)).OrderBy(g => g.Name).Select(g => new PortfolioChoiceDto(g.Id, g.Name)).ToListAsync(ct);
        return new PortfolioBoardDto(clock.Today, filter, filtered, decisions, money, cap, owners, groups, Summary(filtered, decisions, money, cap));
    }

    /// <summary>The page's summary in plain words, from the numbers (the Monday notice carries the same).</summary>
    public static string Summary(PortfolioBriefDto b, IReadOnlyList<PortfolioDecisionDto> decisions, PortfolioMoneyDto money, PortfolioCapacityDto cap)
    {
        if (b.Projects == 0) return "No active projects match.";
        var sb = new StringBuilder();
        sb.Append($"{Plural(b.Projects, "active project", "active projects")}: {b.OnTrack} on track, {b.AtRisk} at risk, {b.Delayed} delayed. ");
        if (decisions.Count > 0) sb.Append($"{Plural(decisions.Count, "decision", "decisions")} this week, the biggest: {decisions[0].Headline} ");
        else sb.Append("No project is forecast to miss its date. ");
        if (money.ShowMoney && money.Overrunning > 0) sb.Append($"{Plural(money.Overrunning, "project is", "projects are")} forecast to go over budget. ");
        if (cap.Over.Count > 0) sb.Append($"{Plural(cap.Over.Count, "person is", "people are")} over 100% in the next {CapacityWeeks} weeks, putting {Plural(cap.ProjectsAtRisk.Count, "project", "projects")} at risk.");
        return sb.ToString().Trim();
    }

    // ---------------------------------------------------------------- decisions

    private async Task<List<PortfolioDecisionDto>> DecisionsAsync(List<PortfolioRiskDto> ranked, PortfolioCapacityDto cap, CancellationToken ct)
    {
        var today = clock.Today;
        var late = ranked.Where(r => r.DueDate is not null && (r.ProjectedSlipDays is > 0 && r.Confidence != "none" || r.Health == "Delayed")).Take(8).ToList();
        if (late.Count == 0) return [];
        var ids = late.Select(r => r.ProjectId).ToList();
        var since14 = clock.Now.AddDays(-14);
        var tasks = await access.VisibleTasks().AsNoTracking().Where(t => ids.Contains(t.ProjectId))
            .Select(t => new { t.Id, t.ProjectId, t.Number, t.Title, t.AssigneeId, t.Priority, t.DueDate, t.CreatedAt, t.CompletedAt, t.EstimatedHours, t.ActualHours, Cat = t.Status!.Category, Key = t.Project!.Key })
            .Take(20_000).ToListAsync(ct);
        var people = tasks.Where(t => t.AssigneeId != null).Select(t => t.AssigneeId!.Value).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => people.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        var horizon = today.AddDays(60);
        var leave = await db.PlannedLeaves.AsNoTracking().Where(l => people.Contains(l.UserId) && l.WorkDate >= today && l.WorkDate <= horizon)
            .Select(l => new { l.UserId, l.WorkDate }).ToListAsync(ct);
        var waiting = await db.AgentFindings.AsNoTracking().Where(f => ids.Contains(f.ProjectId) && f.Status == AgentFindingStatus.Proposed && f.SourceLabel == "Portfolio")
            .GroupBy(f => f.ProjectId).Select(g => new { g.Key, N = g.Count() }).ToDictionaryAsync(x => x.Key, x => x.N, ct);
        // Who has room: under 70% in the next two weeks, with the most spare first.
        var spare = await SpareAsync(ct);

        var list = new List<PortfolioDecisionDto>();
        foreach (var r in late)
        {
            var mine = tasks.Where(t => t.ProjectId == r.ProjectId).ToList();
            var open = mine.Where(t => Open(t.Cat)).ToList();
            var finish = r.ProjectedFinish; var slip = r.ProjectedSlipDays ?? (r.DueDate is { } d0 && d0 < today ? today.DayNumber - d0.DayNumber : 0);
            var causes = new List<string>();
            // Leave of the people holding the open work, before the finish.
            var holders = open.Where(t => t.AssigneeId != null).GroupBy(t => t.AssigneeId!.Value).OrderByDescending(g => g.Count()).Select(g => g.Key).ToList();
            foreach (var who in holders)
            {
                var days = leave.Where(l => l.UserId == who && l.WorkDate <= (finish ?? horizon)).Select(l => l.WorkDate).OrderBy(x => x).ToList();
                if (days.Count == 0) continue;
                causes.Add($"{names.GetValueOrDefault(who) ?? "Someone"} is on leave from {Day(days[0])} ({Plural(days.Count, "day", "days")}) with {Plural(open.Count(t => t.AssigneeId == who), "open task", "open tasks")}");
                if (causes.Count >= 2) break;
            }
            var added = mine.Count(t => t.CreatedAt >= since14);
            var done14 = mine.Count(t => t.CompletedAt >= since14);
            if (added > done14 && added >= 3) causes.Add($"{Plural(added, "task was", "tasks were")} added in the last 2 weeks and {done14} finished");
            var est = open.Where(t => t.EstimatedHours is > 0 && t.ActualHours is > 0 && t.ActualHours > t.EstimatedHours).ToList();
            if (est.Count > 0) causes.Add($"{Plural(est.Count, "task has", "tasks have")} already taken longer than estimated ({est.Sum(t => t.ActualHours!.Value - t.EstimatedHours!.Value):0.#} h over)");
            if (r.BlockedTasks > 0) causes.Add($"{Plural(r.BlockedTasks, "task waits", "tasks wait")} on unfinished work");
            if (r.OverdueTasks > 0) causes.Add($"{Plural(r.OverdueTasks, "task is", "tasks are")} overdue");
            if (r.FinishedLast28Days > 0) causes.Add($"the team finishes about {Math.Round(r.FinishedLast28Days / 4.0, 1).ToString(CultureInfo.InvariantCulture)} tasks a week with {open.Count} open");
            else if (open.Count > 0) causes.Add($"nothing was finished in the last 4 weeks with {open.Count} open");
            var headline = slip > 0 && finish is not null
                ? $"{r.Key} finishes {Plural(slip, "day", "days")} late ({Day(finish)}, due {Day(r.DueDate)}){(causes.Count > 0 ? ": " + string.Join(" and ", causes.Take(2)) : "")}."
                : $"{r.Key} is past its due date ({Day(r.DueDate)}){(causes.Count > 0 ? ": " + string.Join(" and ", causes.Take(2)) : "")}.";

            var options = new List<DecisionOptionDto>();
            var contributors = Math.Max(1, mine.Where(t => t.Cat == StatusCategory.Done && t.CompletedAt >= clock.Now.AddDays(-28) && t.AssigneeId != null).Select(t => t.AssigneeId).Distinct().Count());
            string Effect(ScenarioOutcomeDto o) => o.Finish is null ? "cannot be forecast" : o.SlipDays is null ? $"finishes {Day(o.Finish)}" : o.SlipDays <= 0 ? $"on time ({Day(o.Finish)})" : $"{Plural(o.SlipDays.Value, "day", "days")} late ({Day(o.Finish)})";

            // 1. Move someone with room onto it for a week.
            var helper = spare.FirstOrDefault(s => !holders.Contains(s.UserId));
            var toGive = open.Where(t => t.Cat == StatusCategory.Todo).OrderBy(t => t.AssigneeId is null ? 0 : 1).ThenByDescending(t => t.Priority).ThenBy(t => t.DueDate ?? DateOnly.MaxValue).ToList();
            if (helper is not null && r.FinishedLast28Days > 0 && toGive.Count > 0)
            {
                var perPersonWeek = r.FinishedLast28Days / 4.0 / contributors;
                var extra = Math.Max(1, (int)Math.Round(perPersonWeek * AiPortfolio.NewPersonShare));
                var give = toGive.Take(Math.Min(extra, 5)).ToList();
                var (_, after, _, _) = AiPortfolio.Simulate(open.Count, r.FinishedLast28Days, contributors, today, r.DueDate, 0, 0, give.Count);
                options.Add(new DecisionOptionDto("move_person", "move_person", $"Move {helper.Name} onto {r.Key} for a week", Effect(after), after.Finish, after.SlipDays,
                    give.Select(t => $"Give {t.Key}-{t.Number} “{t.Title}” to {helper.Name}").ToList(),
                    $"{helper.Name} is at {helper.Load}% over the next 2 weeks; a week of their time is counted at {(int)(AiPortfolio.NewPersonShare * 100)}% of someone already on it.", helper.UserId));
            }
            // 2. Cut lower-priority work that has not started.
            var (_, _, need, _) = AiPortfolio.Simulate(open.Count, r.FinishedLast28Days, contributors, today, r.DueDate, 0, 0, 0);
            var cuttable = open.Where(t => t.Cat == StatusCategory.Todo && t.Priority is Priority.Low or Priority.Medium).OrderBy(t => t.Priority).ThenByDescending(t => t.DueDate ?? DateOnly.MaxValue).ToList();
            if (need?.CutTasks is > 0 && cuttable.Count > 0)
            {
                var cut = cuttable.Take(Math.Min(need.CutTasks.Value, Math.Min(cuttable.Count, 8))).ToList();
                var (_, after, _, _) = AiPortfolio.Simulate(open.Count, r.FinishedLast28Days, contributors, today, r.DueDate, 0, 0, cut.Count);
                options.Add(new DecisionOptionDto("cut_scope", "cut_scope", $"Take {Plural(cut.Count, "lower-priority task", "lower-priority tasks")} out of {r.Key}", Effect(after), after.Finish, after.SlipDays,
                    cut.Select(t => $"Take out {t.Key}-{t.Number} “{t.Title}” ({t.Priority})").ToList(),
                    cut.Count < need.CutTasks ? $"Only {cut.Count} not-started Low or Medium tasks can go; {need.CutTasks} would be needed to land on {Day(r.DueDate)}." : $"{need.Note}"));
            }
            // 3. Accept the forecast date.
            if (finish is { } f && r.DueDate is { } due && f > due)
                options.Add(new DecisionOptionDto("accept_date", "accept_date", $"Accept the new date, {Day(f)}", "on time against the new date", f, 0,
                    [$"Move {r.Key}'s delivery date from {Day(due)} to {Day(f)}, with the reason recorded"], "Sets expectations now instead of missing the date later."));
            list.Add(new PortfolioDecisionDto(r.ProjectId, r.Key, r.Name, headline, causes, slip, r.DueDate, finish, r.Confidence, options, waiting.GetValueOrDefault(r.ProjectId)));
        }
        return list.OrderByDescending(d => d.SlipDays).ToList();
    }

    private record Spare(Guid UserId, string Name, int Load);

    /// <summary>Members with room in the next two weeks (under 70% by open, dated, assigned work), most room first.</summary>
    private async Task<List<Spare>> SpareAsync(CancellationToken ct)
    {
        var tid = ctx.RequireTenantId();
        var start = clock.Today; var end = start.AddDays(13);
        var members = await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid && m.Role != TenantRole.Guest && m.User!.IsActive)
            .Select(m => new { m.UserId, m.User!.DisplayName, m.WeeklyCapacityMinutes }).Take(500).ToListAsync(ct);
        var ids = members.Select(m => m.UserId).ToList();
        var work = await db.Tasks.AsNoTracking().Where(t => t.AssigneeId != null && ids.Contains(t.AssigneeId.Value) && t.CompletedAt == null && t.DueDate != null && t.DueDate <= end
                && t.Status!.Category != StatusCategory.Done && t.Status.Category != StatusCategory.Cancelled)
            .Select(t => new { t.AssigneeId, t.EstimatedHours, t.ActualHours }).ToListAsync(ct);
        var leave = await db.PlannedLeaves.AsNoTracking().Where(l => ids.Contains(l.UserId) && l.WorkDate >= start && l.WorkDate <= end).Select(l => l.UserId).ToListAsync(ct);
        var days = CapacityService.WorkingDays(start, end);
        return members.Select(m =>
        {
            var capMin = (m.WeeklyCapacityMinutes ?? CapacityService.StandardWeekMinutes) * Math.Max(0, days - leave.Count(l => l == m.UserId)) / 5;
            var demand = work.Where(w => w.AssigneeId == m.UserId).Sum(w => Remaining(w.EstimatedHours, w.ActualHours));
            return new Spare(m.UserId, m.DisplayName, capMin <= 0 ? 999 : (int)Math.Round(demand * 100.0 / capMin));
        }).Where(s => s.Load < 70).OrderBy(s => s.Load).ThenBy(s => s.Name).Take(20).ToList();
    }

    private static int Remaining(decimal? estimate, decimal? actual) =>
        estimate is > 0 ? (int)Math.Round(Math.Max(0m, estimate.Value - (actual ?? 0m)) * 60m) : DefaultTaskMinutes;

    /// <summary>
    /// Turns an option into proposals in the project's Agent tab (the project's own approval step applies them): tasks given to someone, tasks
    /// taken out of scope, or a new delivery date with its reason.
    /// </summary>
    public async Task<ApplyDecisionResult> ApplyAsync(Guid projectId, ApplyDecisionRequest req, CancellationToken ct = default)
    {
        var project = await access.GetProjectAsync(projectId, ct);
        if (ctx.Role == TenantRole.Guest) throw new ForbiddenException("Guests cannot propose changes.", "PERMISSION_DENIED");
        var board = await BoardAsync((req.Filter ?? new PortfolioFilter()) with { OwnerId = null, GroupId = null, Health = null, DueFrom = null, DueTo = null }, ct);
        var decision = board.Decisions.FirstOrDefault(d => d.ProjectId == projectId) ?? throw new ConflictException("This project no longer needs a decision.", "NO_DECISION");
        var option = decision.Options.FirstOrDefault(o => o.Id == req.Option) ?? throw new ValidationException("option", "That option is not available any more.");
        if (decision.WaitingProposals > 0) throw new ConflictException($"{Plural(decision.WaitingProposals, "proposal from the portfolio is", "proposals from the portfolio are")} already waiting in {project.Key}. Decide those first.", "PROPOSALS_WAITING");
        var now = clock.Now; var me = ctx.RequireUserId();
        var run = new AgentRun { TenantId = ctx.RequireTenantId(), ProjectId = projectId, Trigger = "portfolio", Status = "done", StartedAt = now, FinishedAt = now, CreatedAt = now, CreatedBy = me,
            Summary = Cut($"Portfolio decision: {option.Title}. {decision.Headline}", 4000) };
        db.AgentRuns.Add(run);
        var findings = new List<AgentFinding>();
        AgentFinding New(AgentFindingKind kind, string title) => new()
        {
            TenantId = run.TenantId, ProjectId = projectId, RunId = run.Id, Kind = kind, Title = Cut(title, 300)!, SourceLabel = "Portfolio", Confidence = 100, Grounded = true,
            Detail = Cut($"{option.Title} — {option.Effect}. {decision.Headline} {option.Why}", 4000), Evidence = Cut(decision.Headline, 2000), CreatedAt = now, CreatedBy = me,
        };
        var openTasks = await access.VisibleTasks().AsNoTracking().Where(t => t.ProjectId == projectId).Select(t => new { t.Id, t.Number, t.Title }).ToListAsync(ct);
        Guid? TaskOf(string step)
        {
            var m = System.Text.RegularExpressions.Regex.Match(step, $@"{System.Text.RegularExpressions.Regex.Escape(project.Key)}-(\d+)");
            return m.Success && int.TryParse(m.Groups[1].Value, out var n) ? openTasks.FirstOrDefault(t => t.Number == n)?.Id : null;
        }
        switch (option.Kind)
        {
            case "move_person":
                var helper = option.PersonId ?? throw new ConflictException("That person is not available any more.");
                foreach (var step in option.Steps)
                    if (TaskOf(step) is { } tid) { var f = New(AgentFindingKind.UpdateTask, step); f.TaskId = tid; f.AssigneeId = helper; findings.Add(f); }
                break;
            case "cut_scope":
                foreach (var step in option.Steps)
                    if (TaskOf(step) is { } tid) { var f = New(AgentFindingKind.UpdateTask, step); f.TaskId = tid; f.NewStatus = "cancelled"; f.Comment = $"Taken out of scope: {option.Title} ({option.Effect})."; findings.Add(f); }
                break;
            case "accept_date":
                var date = New(AgentFindingKind.Decision, option.Steps[0]); date.DueDate = option.Finish; date.NewStatus = "project_due"; findings.Add(date);
                break;
        }
        if (findings.Count == 0) throw new ConflictException("Nothing in that option can be proposed any more.");
        db.AgentFindings.AddRange(findings);
        run.FindingCount = findings.Count;
        recorder.Audit("portfolio.decision_proposed", "Project", projectId, null, new { option.Kind, option.Title, findings = findings.Count });
        await db.SaveChangesAsync(ct);
        return new ApplyDecisionResult(findings.Count, $"{Plural(findings.Count, "proposal is", "proposals are")} waiting in {project.Key} › Agent for approval.");
    }

    private static string? Cut(string? s, int max) => s is null ? null : s.Length <= max ? s : s[..(max - 1)] + "…";

    // ---------------------------------------------------------------- money

    private async Task<PortfolioMoneyDto> MoneyAsync(IReadOnlyList<Guid> ids, CancellationToken ct)
    {
        var currency = await capacity.CurrencyAsync(ct);
        var entitled = await entitlements.GetValueAsync(FeatureKeys.ResourceManagement, ct) > 0;
        var showMoney = IsAdmin || await permissions.HasBroadReportsAccessAsync(ct);
        if (!entitled || !showMoney || ids.Count == 0)
            return new PortfolioMoneyDto(entitled, showMoney, currency, 0, 0, 0, 0, [], [],
                !entitled ? ["Budgets and costs come with resource management (Business plan)."] : !showMoney ? ["Money is shown to owners, admins and people with access to everyone's reports."] : []);
        var tid = ctx.RequireTenantId();
        var projects = await db.Projects.AsNoTracking().Where(p => ids.Contains(p.Id)).Select(p => new { p.Id, p.Key, p.Name, p.BudgetAmount, p.BudgetHours, p.StartDate, p.DueDate }).ToListAsync(ct);
        var rates = await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid).ToDictionaryAsync(m => m.UserId, m => m.CostRate, ct);
        var sixMonths = new DateOnly(clock.Today.Year, clock.Today.Month, 1).AddMonths(-5);
        var time = await db.TimeEntries.AsNoTracking().Where(e => e.ProjectId != null && ids.Contains(e.ProjectId.Value) && e.TaskId != null && !(e.StartedAt != null && e.EndedAt == null))
            .GroupBy(e => new { e.ProjectId, e.UserId, Year = e.WorkDate.Year, Month = e.WorkDate.Month }).Select(g => new { g.Key.ProjectId, g.Key.UserId, g.Key.Year, g.Key.Month, Minutes = g.Sum(x => x.Minutes) })
            .ToListAsync(ct);
        var remaining = await access.VisibleTasks().AsNoTracking().Where(t => ids.Contains(t.ProjectId) && t.CompletedAt == null && t.Status!.Category != StatusCategory.Done && t.Status.Category != StatusCategory.Cancelled)
            .GroupBy(t => t.ProjectId).Select(g => new { g.Key, Hours = g.Sum(t => t.EstimatedHours != null && t.EstimatedHours > (t.ActualHours ?? 0) ? t.EstimatedHours.Value - (t.ActualHours ?? 0) : 0m),
                Unestimated = g.Count(t => t.EstimatedHours == null || t.EstimatedHours == 0) }).ToDictionaryAsync(x => x.Key, ct);
        var months = Enumerable.Range(0, 6).Select(i => sixMonths.AddMonths(i)).ToList();
        string Month(DateOnly d) => d.ToString("MMM yyyy", CultureInfo.InvariantCulture);
        var list = new List<ProjectMoneyDto>();
        foreach (var p in projects)
        {
            var mine = time.Where(t => t.ProjectId == p.Id).ToList();
            var minutes = mine.Sum(t => t.Minutes);
            var noRate = mine.Select(t => t.UserId).Distinct().Count(u => rates.GetValueOrDefault(u) is null);
            var spent = Math.Round(mine.Sum(t => t.Minutes / 60m * (rates.GetValueOrDefault(t.UserId) ?? 0m)), 2);
            var burn = months.Select(m => new MoneyMonthDto(Month(m), Math.Round(mine.Where(t => t.Year == m.Year && t.Month == m.Month).Sum(t => t.Minutes / 60m * (rates.GetValueOrDefault(t.UserId) ?? 0m)), 2))).ToList();
            var hoursUsed = Math.Round(minutes / 60m, 1);
            var avgRate = minutes > 0 ? spent / (minutes / 60m) : rates.Values.Where(v => v is > 0).Select(v => v!.Value).DefaultIfEmpty(0m).Average();
            var left = remaining.GetValueOrDefault(p.Id);
            decimal? forecast = null; string basis;
            if (left is not null && left.Hours > 0 && left.Unestimated == 0) { forecast = Math.Round(spent + left.Hours * avgRate, 2); basis = "spent so far plus the open estimates"; }
            else if (left is not null && left.Hours > 0) { forecast = Math.Round(spent + (left.Hours + left.Unestimated * DefaultTaskMinutes / 60m) * avgRate, 2); basis = $"spent plus open estimates ({left.Unestimated} unestimated tasks counted at {DefaultTaskMinutes / 60} h)"; }
            else if (p.StartDate is { } s && p.DueDate is { } d && d > s && clock.Today > s)
            {
                var elapsed = Math.Clamp((decimal)(clock.Today.DayNumber - s.DayNumber) / (d.DayNumber - s.DayNumber), 0.05m, 1m);
                forecast = spent > 0 ? Math.Round(spent / elapsed, 2) : null; basis = "the pace so far, to the due date";
            }
            else basis = "not enough to forecast";
            decimal? overrun = p.BudgetAmount is > 0 && forecast is { } fc && fc > p.BudgetAmount ? Math.Round(fc - p.BudgetAmount.Value, 2) : null;
            string? warning = overrun is { } o ? $"Forecast {Math.Round(forecast!.Value):N0} {currency} is {Math.Round(o / p.BudgetAmount!.Value * 100):0}% over the {Math.Round(p.BudgetAmount.Value):N0} budget"
                : p.BudgetAmount is > 0 && spent > p.BudgetAmount ? "Already over budget" : null;
            list.Add(new ProjectMoneyDto(p.Id, p.Key, p.Name, p.BudgetAmount, spent, forecast, overrun, p.BudgetAmount is > 0 ? Math.Round(spent / p.BudgetAmount.Value, 4) : null,
                burn, warning, p.BudgetHours, hoursUsed, left?.Hours, noRate, basis));
        }
        var notes = new List<string>();
        if (list.Sum(x => x.PeopleWithoutRate) > 0) notes.Add($"{Plural(list.Sum(x => x.PeopleWithoutRate), "person has", "people have")} logged time without a cost rate; their hours count as 0. Set rates in Settings › Rates.");
        if (list.All(x => x.Budget is null)) notes.Add("No project has a budget yet. Set one in the project's settings to see burn against it.");
        var burnAll = months.Select(m => new MoneyMonthDto(Month(m), list.Sum(x => x.Burn.First(b => b.Month == Month(m)).Cost))).ToList();
        return new PortfolioMoneyDto(true, true, currency, list.Sum(x => x.Budget ?? 0), list.Sum(x => x.Spent), list.Sum(x => x.Forecast ?? x.Spent), list.Count(x => x.Overrun is > 0),
            list.OrderByDescending(x => x.Overrun ?? 0).ThenByDescending(x => x.Spent).ToList(), burnAll, notes);
    }

    // ---------------------------------------------------------------- capacity

    /// <summary>
    /// The next four weeks: each person's capacity (weekly hours, less planned leave) against the open, dated work assigned to them in the
    /// visible projects (its remaining estimate, spread over the working days up to its due date; overdue work lands in the first week).
    /// </summary>
    private async Task<PortfolioCapacityDto> CapacityAsync(IReadOnlyList<Guid> ids, CancellationToken ct)
    {
        var start = TimesheetApprovalService.WeekOf(clock.Today);
        var end = start.AddDays(CapacityWeeks * 7 - 1);
        var today = clock.Today;
        if (ids.Count == 0) return new PortfolioCapacityDto(start, end, 0, [], [], []);
        var tid = ctx.RequireTenantId();
        var work = await access.VisibleTasks().AsNoTracking().Where(t => ids.Contains(t.ProjectId) && t.AssigneeId != null && t.CompletedAt == null && t.DueDate != null && t.DueDate <= end
                && t.Status!.Category != StatusCategory.Done && t.Status.Category != StatusCategory.Cancelled)
            .Select(t => new { t.ProjectId, Key = t.Project!.Key, Project = t.Project.Name, Assignee = t.AssigneeId!.Value, t.StartDate, t.DueDate, t.EstimatedHours, t.ActualHours }).Take(20_000).ToListAsync(ct);
        var people = work.Select(w => w.Assignee).Distinct().ToList();
        var members = await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid && people.Contains(m.UserId)).Select(m => new { m.UserId, m.User!.DisplayName, m.WeeklyCapacityMinutes }).ToListAsync(ct);
        var leave = await db.PlannedLeaves.AsNoTracking().Where(l => people.Contains(l.UserId) && l.WorkDate >= start && l.WorkDate <= end).Select(l => new { l.UserId, l.WorkDate }).ToListAsync(ct);
        var weeks = Enumerable.Range(0, CapacityWeeks).Select(i => start.AddDays(i * 7)).ToList();

        var result = new List<CapacityPersonDto>();
        foreach (var m in members)
        {
            var off = leave.Where(l => l.UserId == m.UserId).Select(l => l.WorkDate).ToHashSet();
            var weekly = m.WeeklyCapacityMinutes ?? CapacityService.StandardWeekMinutes;
            var demand = weeks.ToDictionary(w => w, _ => 0);
            var perProject = new Dictionary<Guid, (string Key, string Name, int Minutes, int Tasks)>();
            var unestimated = 0;
            foreach (var t in work.Where(w => w.Assignee == m.UserId))
            {
                var minutes = Remaining(t.EstimatedHours, t.ActualHours);
                if (t.EstimatedHours is not > 0) unestimated++;
                var days = CapacityPlan.Days(today, start, end, t.StartDate, t.DueDate!.Value, off);
                foreach (var d in days) { var w = weeks.Last(x => x <= d); demand[w] += minutes / days.Count; }
                (string Key, string Name, int Minutes, int Tasks) cur = perProject.TryGetValue(t.ProjectId, out var had) ? had : (t.Key, t.Project, 0, 0);
                perProject[t.ProjectId] = (cur.Key, cur.Name, cur.Minutes + minutes, cur.Tasks + 1);
            }
            var weekRows = weeks.Select(w =>
            {
                var workingDays = Enumerable.Range(0, 7).Select(i => w.AddDays(i)).Count(d => CapacityPlan.Open(d, today, off));
                var capMin = weekly * workingDays / 5;
                return new CapacityWeekDto(w, capMin, demand[w], CapacityPlan.Load(demand[w], capMin));
            }).ToList();
            var totalCap = weekRows.Sum(x => x.CapacityMinutes); var totalDemand = weekRows.Sum(x => x.DemandMinutes);
            var load = CapacityPlan.Load(totalDemand, totalCap);
            result.Add(new CapacityPersonDto(m.UserId, m.DisplayName, load, weekRows,
                perProject.Select(p => new CapacityProjectDto(p.Key, p.Value.Key, p.Value.Name, p.Value.Minutes, p.Value.Tasks)).OrderByDescending(p => p.Minutes).ToList(),
                off.Count, unestimated));
        }
        // Over: more work than time in some week - including work in a week with no time at all (all of it on leave).
        var over = result.Where(p => p.Weeks.Any(w => w.Load > 100 || (w.CapacityMinutes == 0 && w.DemandMinutes > 0)))
            .OrderByDescending(p => p.Weeks.Max(w => w.Load ?? (w.DemandMinutes > 0 ? int.MaxValue : 0))).ToList();
        var atRisk = over.SelectMany(p => p.Projects).GroupBy(p => p.ProjectId)
            .Select(g => new CapacityProjectDto(g.Key, g.First().Key, g.First().Name, g.Sum(x => x.Minutes), g.Sum(x => x.Tasks))).OrderByDescending(p => p.Minutes).ToList();
        var notes = new List<string>();
        var unest = result.Sum(p => p.UnestimatedTasks);
        if (unest > 0) notes.Add($"{Plural(unest, "task has", "tasks have")} no estimate and {(unest == 1 ? "counts" : "count")} as {DefaultTaskMinutes / 60} hours.");
        notes.Add("Only assigned work with a due date in the next 4 weeks is counted; planned leave lowers capacity.");
        return new PortfolioCapacityDto(start, end, result.Count, over, atRisk, notes);
    }

    // ---------------------------------------------------------------- timeline

    public async Task<PortfolioTimelineDto> TimelineAsync(PortfolioFilter filter, CancellationToken ct = default)
    {
        var board = await BoardAsync(filter, ct);
        var ranked = board.Brief.Ranked;
        var ids = ranked.Select(r => r.ProjectId).ToList();
        var milestones = await db.Milestones.AsNoTracking().Where(m => ids.Contains(m.ProjectId)).OrderBy(m => m.DueDate).Select(m => new { m.Id, m.ProjectId, m.Name, m.DueDate, m.Status }).ToListAsync(ct);
        var firstDue = (await db.DueDateChanges.AsNoTracking().Where(c => ids.Contains(c.ProjectId) && c.TaskId == null).OrderBy(c => c.CreatedAt).Select(c => new { c.ProjectId, c.Previous }).ToListAsync(ct))
            .GroupBy(c => c.ProjectId).ToDictionary(g => g.Key, g => g.First().Previous);
        // A project depends on another when one of its tasks waits on a task there.
        var deps = await (from d in db.TaskDependencies.AsNoTracking()
                          join t in db.Tasks.AsNoTracking() on d.TaskId equals t.Id
                          join o in db.Tasks.AsNoTracking() on d.DependsOnTaskId equals o.Id
                          where ids.Contains(t.ProjectId) && ids.Contains(o.ProjectId) && t.ProjectId != o.ProjectId
                          select new { From = t.ProjectId, To = o.ProjectId }).Distinct().ToListAsync(ct);
        var list = ranked.Select(r => new TimelineProjectDto(r.ProjectId, r.Key, r.Name, r.Health, r.Group, r.StartDate, r.DueDate,
            firstDue.GetValueOrDefault(r.ProjectId) is { } o && o != r.DueDate ? o : null, r.ProjectedFinish, r.Progress,
            milestones.Where(m => m.ProjectId == r.ProjectId).Select(m => new TimelineMilestoneDto(m.Id, m.Name, m.DueDate, m.Status.ToString())).ToList(),
            deps.Where(d => d.From == r.ProjectId).Select(d => d.To).ToList())).OrderBy(p => p.Start ?? p.Due ?? DateOnly.MaxValue).ToList();
        var dates = list.SelectMany(p => new[] { p.Start, p.Due, p.OriginalDue, p.Forecast }).Concat(milestones.Select(m => m.DueDate)).Where(d => d is not null).Select(d => d!.Value).ToList();
        var from = dates.Count == 0 ? clock.Today.AddDays(-14) : dates.Min();
        var to = dates.Count == 0 ? clock.Today.AddDays(90) : dates.Max();
        return new PortfolioTimelineDto(from, to, list);
    }

    // ---------------------------------------------------------------- summary in words and export

    private static readonly ConcurrentDictionary<string, PortfolioAiSummaryDto> Summaries = new();

    /// <summary>An executive summary written by the model from the board's numbers (it does no arithmetic of its own); kept for six hours.</summary>
    public async Task<PortfolioAiSummaryDto> AiSummaryAsync(PortfolioFilter filter, bool fresh, CancellationToken ct = default)
    {
        if (!ai.Configured) throw new ConflictException("The AI assistant is not set up on this server.", "AI_NOT_CONFIGURED");
        await entitlements.EnsureFeatureAsync(FeatureKeys.AiAssistant, ct);
        var key = $"{ctx.RequireTenantId():N}:{ctx.RequireUserId():N}:{filter}:{clock.Today:yyyyMMdd}";
        if (!fresh && Summaries.TryGetValue(key, out var hit) && hit.At > clock.Now.AddHours(-6)) return hit with { Cached = true };
        var board = await BoardAsync(filter, ct);
        var text = new StringBuilder(AiPortfolio.ToText(board.Brief, 10));
        foreach (var d in board.Decisions.Take(5))
            text.AppendLine($"Decision: {d.Headline} Options: {string.Join("; ", d.Options.Select(o => $"{o.Title} → {o.Effect}"))}.");
        if (board.Money.ShowMoney)
            foreach (var m in board.Money.Projects.Where(p => p.Budget is not null).Take(8))
                text.AppendLine($"Money {m.Key}: budget {m.Budget} {board.Money.Currency}, spent {m.Spent}, forecast {m.Forecast?.ToString() ?? "n/a"} ({m.Basis}){(m.Warning is null ? "" : " - " + m.Warning)}.");
        foreach (var p in board.Capacity.Over.Take(6))
            text.AppendLine($"Capacity: {p.Name} at {p.Load}% over the next {CapacityWeeks} weeks across {string.Join(", ", p.Projects.Select(x => x.Key))}.");
        var system = "You write a short executive summary of a project portfolio for a leadership meeting: 4 to 6 sentences, plain words, no headings or bullets. " +
                     "Say what is going well, what is at risk and why, the one or two decisions to make this week with the option you would pick and its effect, and any money or people concern. " +
                     "Use only the numbers given; never invent figures; call forecasts estimates.";
        var cost = Math.Clamp(aiOptions.Value.Chat.Quick.Credits, 1, 10000);
        AiAnswer answer;
        await using (var lease = await credits.ReserveAsync(Guid.NewGuid(), cost, "portfolio_summary", ct))
        {
            answer = await ai.CompleteAsync(system, text.ToString(), 600, ct);
            await lease.SettleAsync(cost, ct);
        }
        var result = new PortfolioAiSummaryDto(answer.Text.Trim(), answer.Model, clock.Now, false);
        Summaries[key] = result;
        return result;
    }

    /// <summary>The board for the meeting: projects, decisions, money and capacity, as Excel or PDF.</summary>
    public async Task<ReportFile> ExportAsync(PortfolioFilter filter, ReportFormat format, CancellationToken ct = default)
    {
        if (format is not (ReportFormat.Xlsx or ReportFormat.Pdf)) throw new ValidationException("format", "Choose Excel or PDF.");
        var b = await BoardAsync(filter, ct);
        var sections = new List<ReportSection>
        {
            new("Projects", ["Key", "Project", "Group", "Owner", "Health", "Risk", "Done %", "Due", "Likely finish", "Days late", "Open", "Overdue", "Blocked", "Reasons"],
                b.Brief.Ranked.Select(r => (IReadOnlyList<object?>)[r.Key, r.Name, r.Group, r.Owner, r.Health, r.Level, r.Progress, r.DueDate, r.ProjectedFinish, r.ProjectedSlipDays,
                    r.OpenTasks, r.OverdueTasks, r.BlockedTasks, string.Join("; ", r.Reasons)]).ToList()),
            new("Decisions this week", ["Project", "Why", "Option", "Effect"],
                b.Decisions.SelectMany(d => d.Options.Count == 0 ? [(IReadOnlyList<object?>)[d.Key, d.Headline, "-", "-"]]
                    : d.Options.Select(o => (IReadOnlyList<object?>)[d.Key, d.Headline, o.Title, o.Effect])).ToList()),
        };
        if (b.Money.ShowMoney && b.Money.Entitled)
            sections.Add(new ReportSection($"Money ({b.Money.Currency})", ["Key", "Project", "Budget", "Spent", "Forecast at completion", "Over by", "Hours used", "Warning"],
                b.Money.Projects.Select(m => (IReadOnlyList<object?>)[m.Key, m.Name, m.Budget, m.Spent, m.Forecast, m.Overrun, m.HoursUsed, m.Warning]).ToList()));
        sections.Add(new ReportSection($"Capacity, {b.Capacity.From:d MMM} to {b.Capacity.To:d MMM}", ["Person", "Load %", "Weeks over 100%", "Projects"],
            b.Capacity.Over.Select(p => (IReadOnlyList<object?>)[p.Name, p.Load, p.Weeks.Count(w => w.Load > 100), string.Join(", ", p.Projects.Select(x => x.Key))]).ToList()));
        var doc = new ReportDocument("Portfolio", $"As of {b.AsOf:d MMM yyyy} · {b.Summary}", sections);
        recorder.Audit("portfolio.exported", "Tenant", ctx.RequireTenantId(), null, new { format = format.ToString(), projects = b.Brief.Projects });
        return ReportWriter.Write(doc, format);
    }
}

/// <summary>
/// How the portfolio capacity spreads work over days. Work is spread over the working days a person still has (not weekends, not their
/// planned leave, not days already past) from when it can start to when it is due. Work that is overdue, or due on a day that is gone or
/// off, lands on the next day the person can actually work - so on a Saturday the week that is ending shows no time and no work, rather
/// than a percentage of nothing.
/// </summary>
public static class CapacityPlan
{
    public static bool Working(DateOnly d) => d.DayOfWeek is not (DayOfWeek.Saturday or DayOfWeek.Sunday);

    /// <summary>A day the person can still work: a weekday, not on leave, today or later.</summary>
    public static bool Open(DateOnly d, DateOnly today, IReadOnlySet<DateOnly> off) => Working(d) && !off.Contains(d) && d >= today;

    /// <summary>The days a piece of work is spread over, within [windowStart, windowEnd]. Never empty.</summary>
    public static List<DateOnly> Days(DateOnly today, DateOnly windowStart, DateOnly windowEnd, DateOnly? taskStart, DateOnly due, IReadOnlySet<DateOnly> off)
    {
        var from = new[] { today, taskStart ?? today, windowStart }.Max();
        var to = due < from ? from : due;
        var days = new List<DateOnly>();
        for (var d = from; d <= to && d <= windowEnd; d = d.AddDays(1)) if (Open(d, today, off)) days.Add(d);
        if (days.Count > 0) return days;
        // Overdue, or due on a day off: the next day the person can work.
        for (var d = from; d <= windowEnd; d = d.AddDays(1)) if (Open(d, today, off)) return [d];
        // No working day left in the whole window (on leave throughout): its last day, where it shows as work with no time.
        return [windowEnd];
    }

    /// <summary>Work as a share of the time available; none when there is no time (the screen then says so, rather than 999%).</summary>
    public static int? Load(int demandMinutes, int capacityMinutes) =>
        capacityMinutes > 0 ? (int)Math.Round(demandMinutes * 100.0 / capacityMinutes) : null;
}

