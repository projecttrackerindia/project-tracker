using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Agent;

/// <summary>The project agent's AI credits: what a project used this month, its cap, and why proposals were dismissed (in words for the agent).</summary>
public static class AgentCredits
{
    public static DateTime MonthStart(DateTime utc) => new(utc.Year, utc.Month, 1, 0, 0, 0, DateTimeKind.Utc);

    /// <summary>Credits the project agent used for this project since the first of the month (its readings and their checks).</summary>
    public static async Task<int> UsedThisMonthAsync(IAppDbContext db, Guid projectId, DateTime now, CancellationToken ct)
    {
        var from = MonthStart(now);
        return await db.AgentRuns.Where(r => r.ProjectId == projectId && r.StartedAt >= from).SumAsync(r => (int?)r.Credits, ct) ?? 0;
    }

    public static async Task<bool> CapReachedAsync(IAppDbContext db, ProjectAgentSettings s, DateTime now, CancellationToken ct) =>
        s.MonthlyCreditCap > 0 && await UsedThisMonthAsync(db, s.ProjectId, now, ct) >= s.MonthlyCreditCap;

    public static string CapMessage(ProjectAgentSettings s) =>
        $"The agent used this project's {s.MonthlyCreditCap} AI credits for the month. It reads again on the 1st, or raise the cap in its settings.";

    /// <summary>Why a person dismissed a proposal: one of these codes.</summary>
    public static readonly IReadOnlyDictionary<string, string> Reasons = new Dictionary<string, string>
    {
        ["not_needed"] = "not needed", ["wrong"] = "the agent got it wrong", ["duplicate"] = "already proposed or exists", ["already_done"] = "already done",
        ["not_ours"] = "not this project's work", ["other"] = "other",
    };

    public static string ReasonText(string code) => Reasons.TryGetValue(code, out var text) ? text : code;

    /// <summary>Which agent a credit reservation's feature belongs to (for the cost view).</summary>
    public static (string Group, string Label) Feature(string feature) => feature switch
    {
        "workspace" => ("assistant", "Project Assistant"),
        "project_agent" or "project_agent_check" => ("agent", "Project agent"),
        "project_agent_live" => ("meetings", "Meeting bot (live reminders)"),
        "email-rewrite" or "inbox-summary" => ("other", "Mail"),
        "resume-draft" => ("other", "Resumes"),
        _ => ("other", "Other AI features"),
    };
}

public record AgentCostDto(string Month, long Limit, long Spent, long Reserved, long Available, bool Unlimited, double DailyAverage, int? DaysLeft,
    DateOnly? RunsOutOn, bool RunsOutBeforeReset, DateOnly ResetsOn, IReadOnlyList<AgentCostFeatureDto> Features, IReadOnlyList<AgentCostDayDto> Days,
    IReadOnlyList<AgentCostProjectDto> Projects);
public record AgentCostFeatureDto(string Group, string Label, long Credits);
public record AgentCostDayDto(DateOnly Day, long Assistant, long Agent, long Meetings, long Other);
public record AgentCostProjectDto(Guid ProjectId, string Key, string Name, int Credits, int Cap, int Readings);
public record AgentForecast(double DailyAverage, int? DaysLeft, DateOnly? RunsOutOn, bool RunsOutBeforeReset, DateOnly ResetsOn);

/// <summary>
/// What the agents cost in AI credits - the workspace's own currency for AI (a plan's monthly allowance): this month by agent and by project,
/// the last two weeks day by day, and, at the last week's pace, when the credits run out. Owners and admins.
/// </summary>
public class AgentCostService(IAppDbContext db, ICurrentContext ctx, AppClock clock, AiCreditService credits)
{
    public static AgentForecast Forecast(AiCreditBalance balance, long spentLastWeek, DateTime now)
    {
        var today = DateOnly.FromDateTime(now);
        var resets = DateOnly.FromDateTime(AgentCredits.MonthStart(now).AddMonths(1));
        var average = Math.Round(Math.Max(0, spentLastWeek) / 7.0, 1);
        if (balance.Unlimited || average <= 0) return new(average, null, null, false, resets);
        var days = (int)Math.Floor(balance.Available / average);
        var on = today.AddDays(Math.Min(days, 3650));
        return new(average, days, on, on < resets, resets);
    }

    public async Task<AgentCostDto> GetAsync(CancellationToken ct = default)
    {
        if (ctx.Role is not (TenantRole.Owner or TenantRole.Admin)) throw new ForbiddenException("Only workspace owners and admins can see what the agents cost.", "PERMISSION_DENIED");
        var now = clock.Now;
        var balance = await credits.BalanceAsync(ct);
        var month = AgentCredits.MonthStart(now);
        var since = now.Date.AddDays(-13);
        var from = since < month ? since : month;
        var rows = await db.AiCreditReservations.AsNoTracking().Where(r => r.Status == "settled" && r.SettledAt != null && r.SettledAt >= from)
            .Select(r => new { r.Feature, r.Charged, At = r.SettledAt!.Value }).Take(100_000).ToListAsync(ct);
        var weekAgo = now.AddDays(-7);
        var forecast = Forecast(balance, rows.Where(r => r.At >= weekAgo).Sum(r => (long)r.Charged), now);
        var features = rows.Where(r => r.At >= month).GroupBy(r => AgentCredits.Feature(r.Feature))
            .Select(g => new AgentCostFeatureDto(g.Key.Group, g.Key.Label, g.Sum(r => (long)r.Charged))).OrderByDescending(f => f.Credits).ToList();
        var days = new List<AgentCostDayDto>();
        for (var d = DateOnly.FromDateTime(since); d <= DateOnly.FromDateTime(now); d = d.AddDays(1))
        {
            var day = d;
            var on = rows.Where(r => DateOnly.FromDateTime(r.At) == day).Select(r => (Group: AgentCredits.Feature(r.Feature).Group, r.Charged)).ToList();
            days.Add(new AgentCostDayDto(day, on.Where(x => x.Group == "assistant").Sum(x => (long)x.Charged), on.Where(x => x.Group == "agent").Sum(x => (long)x.Charged),
                on.Where(x => x.Group == "meetings").Sum(x => (long)x.Charged), on.Where(x => x.Group == "other").Sum(x => (long)x.Charged)));
        }
        var runs = await db.AgentRuns.AsNoTracking().Where(r => r.StartedAt >= month).GroupBy(r => r.ProjectId)
            .Select(g => new { ProjectId = g.Key, Credits = g.Sum(r => r.Credits), Readings = g.Count() }).ToListAsync(ct);
        var caps = await db.ProjectAgentSettings.AsNoTracking().Where(s => s.Enabled || s.MonthlyCreditCap > 0).Select(s => new { s.ProjectId, s.MonthlyCreditCap }).ToListAsync(ct);
        var ids = runs.Select(r => r.ProjectId).Concat(caps.Select(c => c.ProjectId)).Distinct().ToList();
        var projects = await db.Projects.AsNoTracking().Where(p => ids.Contains(p.Id)).Select(p => new { p.Id, p.Key, p.Name }).ToListAsync(ct);
        var perProject = projects.Select(p =>
        {
            var r = runs.FirstOrDefault(x => x.ProjectId == p.Id);
            return new AgentCostProjectDto(p.Id, p.Key, p.Name, r?.Credits ?? 0, caps.FirstOrDefault(c => c.ProjectId == p.Id)?.MonthlyCreditCap ?? 0, r?.Readings ?? 0);
        }).OrderByDescending(p => p.Credits).ThenBy(p => p.Name, StringComparer.Ordinal).Take(20).ToList();
        return new AgentCostDto(balance.Month, balance.Limit, balance.Spent, balance.Reserved, balance.Available, balance.Unlimited, forecast.DailyAverage, forecast.DaysLeft,
            forecast.RunsOutOn, forecast.RunsOutBeforeReset, forecast.ResetsOn, features, days, perProject);
    }
}

public record AgentKindStatDto(string Kind, int Decided, int Approved, int ApprovedAsIs, int Edited, int Dismissed, int? Rate, bool Safe, bool Automatic, bool Suggested,
    IReadOnlyList<AgentReasonCountDto> Reasons);
public record AgentReasonCountDto(string Reason, string Label, int Count);
public record AgentAutonomyHintDto(Guid ProjectId, string ProjectKey, string ProjectName, string Kind, int Decided, int Rate, int Level, string Message);
public record AgentAutonomyReportDto(Guid ProjectId, int Level, int MinDecisions, int MinRate, IReadOnlyList<AgentKindStatDto> Kinds, IReadOnlyList<AgentAutonomyHintDto> Hints);

/// <summary>
/// Earned autonomy: how the team decided on each kind of proposal over the last 90 days (approved as proposed, edited, dismissed and why), and
/// - when a safe kind has been approved unchanged at least 95% of at least 30 times - the suggestion to let the agent carry those out by itself.
/// The lead accepts (the project goes to level 4 for that kind only) or says "not now". Nothing changes without them.
/// </summary>
public class AgentAutonomyHintService(IAppDbContext db, ICurrentContext ctx, AppClock clock, ProjectAccess access, AgentSettingsService settings, Recorder recorder)
{
    public const int MinDecisions = 30;
    public const int MinRate = 95;
    private const int Days = 90;

    public static string KindLabel(AgentFindingKind kind) => kind switch
    {
        AgentFindingKind.CreateTask => "new tasks", AgentFindingKind.CreateActionItem => "action items", AgentFindingKind.CreateIssue => "new tickets",
        AgentFindingKind.UpdateTask => "task updates", AgentFindingKind.UpdateIssue => "ticket updates", AgentFindingKind.Delay => "delays",
        AgentFindingKind.Decision => "decisions", AgentFindingKind.Missed => "missed points", _ => "suggestions",
    };

    private sealed record Row(Guid ProjectId, AgentFindingKind Kind, AgentFindingStatus Status, bool AutoApplied, bool Edited, string? Reason);

    private async Task<List<Row>> RowsAsync(IReadOnlyCollection<Guid> projectIds, CancellationToken ct)
    {
        var since = clock.Now.AddDays(-Days);
        return (await db.AgentFindings.AsNoTracking().Where(f => projectIds.Contains(f.ProjectId) && f.DecidedAt != null && f.DecidedAt >= since
                && (f.Status == AgentFindingStatus.Applied || f.Status == AgentFindingStatus.Dismissed))
            .Select(f => new { f.ProjectId, f.Kind, f.Status, f.AutoApplied, Edited = f.Edits != null, f.DismissReason }).Take(50_000).ToListAsync(ct))
            .Select(f => new Row(f.ProjectId, f.Kind, f.Status, f.AutoApplied, f.Edited, f.DismissReason)).ToList();
    }

    private static List<AgentKindStatDto> Stats(IEnumerable<Row> rows, ProjectAgentSettings? s)
    {
        var level = AgentAutonomy.Level(s?.AutonomyLevel ?? AgentAutonomy.Assistant);
        var auto = level >= AgentAutonomy.Delegate ? AgentAutonomy.Kinds(s?.AutoApplyKinds) : [];
        var notNow = (s?.AutonomyHintsDismissed ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var byKind = rows.Where(r => !r.AutoApplied).GroupBy(r => r.Kind).ToDictionary(g => g.Key, g => g.ToList());
        var list = new List<AgentKindStatDto>();
        foreach (var kind in Enum.GetValues<AgentFindingKind>())
        {
            var g = byKind.GetValueOrDefault(kind) ?? [];
            var approved = g.Count(r => r.Status == AgentFindingStatus.Applied);
            var asIs = g.Count(r => r.Status == AgentFindingStatus.Applied && !r.Edited);
            var dismissed = g.Count(r => r.Status == AgentFindingStatus.Dismissed);
            int? rate = g.Count == 0 ? null : (int)Math.Floor(asIs * 100.0 / g.Count);
            var safe = AgentAutonomy.Safe.Contains(kind);
            var automatic = auto.Contains(kind);
            var reasons = g.Where(r => r.Status == AgentFindingStatus.Dismissed).GroupBy(r => r.Reason ?? "unspecified")
                .Select(x => new AgentReasonCountDto(x.Key, x.Key == "unspecified" ? "no reason given" : AgentCredits.ReasonText(x.Key), x.Count())).OrderByDescending(x => x.Count).ToList();
            list.Add(new AgentKindStatDto(kind.ToString(), g.Count, approved, asIs, approved - asIs, dismissed, rate, safe, automatic,
                safe && !automatic && g.Count >= MinDecisions && rate >= MinRate && !notNow.Contains(kind.ToString()), reasons));
        }
        return list.Where(k => k.Decided > 0 || k.Automatic).OrderByDescending(k => k.Decided).ToList();
    }

    private static string Message(string kind, int decided, int rate, int level) =>
        $"The team approved {rate}% of the agent's {KindLabel(Enum.Parse<AgentFindingKind>(kind))} unchanged ({decided} decisions in {Days} days). " +
        (level >= AgentAutonomy.Delegate ? "Let it create them by itself?" : "Let it create them by itself? The project goes to level 4 (Delegate) for this kind only.");

    /// <summary>For one project (people who may set up its agent).</summary>
    public async Task<AgentAutonomyReportDto> ProjectAsync(Guid projectId, CancellationToken ct = default)
    {
        var project = await access.GetProjectAsync(projectId, ct);
        if (!await settings.CanManageAsync(project, ct)) throw new ForbiddenException("Only people who may edit this project can see this.", "PERMISSION_DENIED");
        var s = await db.ProjectAgentSettings.AsNoTracking().FirstOrDefaultAsync(x => x.ProjectId == projectId, ct);
        var stats = Stats(await RowsAsync([projectId], ct), s);
        var level = AgentAutonomy.Level(s?.AutonomyLevel ?? AgentAutonomy.Assistant);
        var hints = s is { Enabled: true } ? stats.Where(k => k.Suggested)
            .Select(k => new AgentAutonomyHintDto(projectId, project.Key, project.Name, k.Kind, k.Decided, k.Rate ?? 0, level, Message(k.Kind, k.Decided, k.Rate ?? 0, level))).ToList() : [];
        return new AgentAutonomyReportDto(projectId, level, MinDecisions, MinRate, stats, hints);
    }

    /// <summary>Every project with the agent on that has earned a suggestion (owners and admins: the Agent Tracker and the weekly summary).</summary>
    public async Task<IReadOnlyList<AgentAutonomyHintDto>> WorkspaceAsync(CancellationToken ct = default)
    {
        if (ctx.Role is not (TenantRole.Owner or TenantRole.Admin)) throw new ForbiddenException("Only workspace owners and admins can see this.", "PERMISSION_DENIED");
        var on = await db.ProjectAgentSettings.AsNoTracking().Where(s => s.Enabled).ToListAsync(ct);
        if (on.Count == 0) return [];
        var rows = await RowsAsync(on.Select(s => s.ProjectId).ToList(), ct);
        var projects = await db.Projects.AsNoTracking().Where(p => on.Select(s => s.ProjectId).Contains(p.Id)).Select(p => new { p.Id, p.Key, p.Name }).ToDictionaryAsync(p => p.Id, ct);
        var hints = new List<AgentAutonomyHintDto>();
        foreach (var s in on)
        {
            if (!projects.TryGetValue(s.ProjectId, out var p)) continue;
            var level = AgentAutonomy.Level(s.AutonomyLevel);
            foreach (var k in Stats(rows.Where(r => r.ProjectId == s.ProjectId), s).Where(k => k.Suggested))
                hints.Add(new AgentAutonomyHintDto(p.Id, p.Key, p.Name, k.Kind, k.Decided, k.Rate ?? 0, level, Message(k.Kind, k.Decided, k.Rate ?? 0, level)));
        }
        return hints.OrderByDescending(h => h.Decided).Take(20).ToList();
    }

    private async Task<ProjectAgentSettings> ManagedAsync(Guid projectId, string kind, CancellationToken ct)
    {
        var project = await access.GetProjectAsync(projectId, ct);
        if (!await settings.CanManageAsync(project, ct)) throw new ForbiddenException("Only people who may edit this project can change its agent.", "PERMISSION_DENIED");
        ProjectAccess.EnsureNotArchived(project, "change its agent");
        if (!Enum.TryParse<AgentFindingKind>(kind, true, out var k) || !AgentAutonomy.Safe.Contains(k))
            throw new ValidationException("kind", "Only new items and notes can be carried out without a person.");
        return await db.ProjectAgentSettings.FirstOrDefaultAsync(x => x.ProjectId == projectId, ct) ?? throw new NotFoundException("The project agent is not set up.");
    }

    /// <summary>"Yes": level 4 for this kind (and the kinds already automatic at level 4, if any) - never for other kinds by default.</summary>
    public async Task<AgentAutonomyReportDto> AcceptAsync(Guid projectId, string kind, CancellationToken ct = default)
    {
        var s = await ManagedAsync(projectId, kind, ct);
        var k = Enum.Parse<AgentFindingKind>(kind, true);
        var before = new { s.AutonomyLevel, s.AutoApplyKinds };
        var kinds = AgentAutonomy.Level(s.AutonomyLevel) >= AgentAutonomy.Delegate ? AgentAutonomy.Kinds(s.AutoApplyKinds).ToList() : [];
        if (!kinds.Contains(k)) kinds.Add(k);
        s.AutonomyLevel = AgentAutonomy.Delegate;
        s.AutoApplyKinds = AgentAutonomy.KindsCsv(kinds.Select(x => x.ToString()));
        s.UpdatedAt = clock.Now; s.UpdatedBy = ctx.RequireUserId();
        recorder.Audit("agent.autonomy_hint_accepted", "Project", projectId, before, new { s.AutonomyLevel, s.AutoApplyKinds, kind = k.ToString() });
        await db.SaveChangesAsync(ct);
        return await ProjectAsync(projectId, ct);
    }

    /// <summary>"Not now": the suggestion for this kind is not made again for this project (until the lead clears it in the settings).</summary>
    public async Task<AgentAutonomyReportDto> DismissAsync(Guid projectId, string kind, CancellationToken ct = default)
    {
        var s = await ManagedAsync(projectId, kind, ct);
        var k = Enum.Parse<AgentFindingKind>(kind, true).ToString();
        var list = (s.AutonomyHintsDismissed ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();
        if (!list.Contains(k, StringComparer.OrdinalIgnoreCase)) list.Add(k);
        s.AutonomyHintsDismissed = string.Join(',', list);
        s.UpdatedAt = clock.Now; s.UpdatedBy = ctx.RequireUserId();
        recorder.Audit("agent.autonomy_hint_dismissed", "Project", projectId, null, new { kind = k });
        await db.SaveChangesAsync(ct);
        return await ProjectAsync(projectId, ct);
    }
}
