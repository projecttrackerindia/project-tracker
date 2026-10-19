using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Agent;

/// <summary>
/// The Command Center: "what needs me today?" across every project the person works on, each item with the evidence behind it - never an
/// unexplained score. Decisions waiting, change requests with what they would move, check-ins, late work, work others wait on, double-booked
/// meetings, projects at risk, missed commitments, a meeting saying one date while the tracker says another, topics that keep coming back
/// without closure; then what changed since the last visit, today's meetings, project health and how reliably commitments are kept.
/// Everything here is computed from the tracker (no model, no credits), so it is instant and the same for everyone who looks.
/// </summary>
public class AgentCommandCenterService(IAppDbContext db, ICurrentContext ctx, AppClock clock, AgentSettingsService settings, AgentImpactService impact,
    AgentFollowUpService followUps, AgentDelegationService delegations, AiPortfolio portfolio, ILogger<AgentCommandCenterService> log)
{
    private static readonly AgentFindingKind[] Moves = [AgentFindingKind.Delay, AgentFindingKind.UpdateTask];

    public async Task<CommandCenterDto> GetAsync(CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var tid = ctx.RequireTenantId();
        var now = clock.Now;
        var today = clock.Today;
        var name = await db.Users.AsNoTracking().Where(u => u.Id == me).Select(u => u.DisplayName).FirstAsync(ct);

        // "Since my last visit": the visit before this one (a refresh within half an hour is the same visit).
        var pref = await db.AgentPersonalSettings.FirstOrDefaultAsync(p => p.UserId == me, ct);
        if (pref is null) { pref = new AgentPersonalSettings { TenantId = tid, UserId = me, CreatedAt = now, CreatedBy = me }; db.AgentPersonalSettings.Add(pref); }
        if (pref.LastVisitAt is null || now - pref.LastVisitAt > TimeSpan.FromMinutes(30)) { pref.PreviousVisitAt = pref.LastVisitAt; pref.LastVisitAt = now; pref.UpdatedAt = now; }
        var since = pref.PreviousVisitAt ?? now.AddDays(-1);
        if (since < now.AddDays(-14)) since = now.AddDays(-14);
        try { await db.SaveChangesAsync(ct); } catch (DbUpdateException) { /* two tabs at once: the other one recorded the visit */ }

        // My projects: ones I own, am a member of, or have work in - and, of those, the ones I may decide on.
        var myProjects = await db.Projects.AsNoTracking().Where(p => p.Status != ProjectStatus.Archived && (p.OwnerId == me
                || db.ProjectMembers.Any(m => m.ProjectId == p.Id && m.UserId == me) || db.Tasks.Any(t => t.ProjectId == p.Id && t.AssigneeId == me)))
            .OrderBy(p => p.Name).Take(200).ToListAsync(ct);
        var projectIds = myProjects.Select(p => p.Id).ToList();
        var keyOf = myProjects.ToDictionary(p => p.Id, p => p.Key);
        var manage = new HashSet<Guid>();
        foreach (var p in myProjects) if (await settings.CanManageAsync(p, ct)) manage.Add(p.Id);
        var manageIds = manage.ToList();

        var attention = new List<CcAttentionDto>();

        // 1. Proposals waiting for my decision, per project.
        var waiting = await db.AgentFindings.AsNoTracking().Where(f => manageIds.Contains(f.ProjectId) && f.Status == AgentFindingStatus.Proposed && f.CommitmentId == null)
            .Select(f => new { f.ProjectId, f.Kind, f.CreatedAt }).ToListAsync(ct);
        foreach (var g in waiting.GroupBy(f => f.ProjectId).OrderByDescending(g => g.Count()))
        {
            var p = myProjects.First(x => x.Id == g.Key);
            var oldest = (int)(now - g.Min(f => f.CreatedAt)).TotalDays;
            attention.Add(new CcAttentionDto($"decide:{g.Key:N}", "decide", oldest >= 3 ? "high" : "medium",
                $"{g.Count()} proposal{(g.Count() == 1 ? "" : "s")} from the agent in {p.Name}", null,
                [string.Join(", ", g.GroupBy(f => AgentDelegationService.Label(f.Kind)).Select(k => $"{k.Count()} {k.Key.ToLowerInvariant()}")),
                    oldest >= 1 ? $"oldest waiting {oldest} day{(oldest == 1 ? "" : "s")}" : "new today"],
                $"/projects/{p.Id}?tab=agent", p.Id, p.Key, null, "review"));
        }

        // 2. Change requests from check-ins, with what they would move.
        var requests = await db.AgentFindings.AsNoTracking().Where(f => manageIds.Contains(f.ProjectId) && f.Status == AgentFindingStatus.Proposed && f.CommitmentId != null)
            .OrderBy(f => f.CreatedAt).Take(10).ToListAsync(ct);
        foreach (var f in requests)
        {
            var why = new List<string> { $"“{AgentAnalysisService.Cut(f.Detail, 160)}” - {f.SourceLabel}" };
            var severity = "medium";
            if (f is { TaskId: { } taskId, DueDate: { } due })
            {
                try
                {
                    var effect = await impact.AnalyzeAsync(taskId, due, ct);
                    why.Add(effect.Summary);
                    severity = effect.Level == "high" ? "high" : "medium";
                }
                catch (AppException) { }
            }
            attention.Add(new CcAttentionDto($"cr:{f.Id:N}", "change_request", severity, f.Title, null, why, $"/projects/{f.ProjectId}?tab=agent",
                f.ProjectId, keyOf.GetValueOrDefault(f.ProjectId), f.Id.ToString(), "decide"));
        }

        // 3. Check-ins waiting for my answer.
        var mine = await followUps.MineAsync(ct);
        foreach (var c in mine.Where(c => c.AwaitingAnswer))
            attention.Add(new CcAttentionDto($"ci:{c.Id:N}", "check_in", c.DueDate < today ? "high" : "medium", $"Is {c.EntityKey ?? c.Title} on track?",
                c.Title, [c.Quote is null ? $"due {c.DueDate:ddd d MMM}" : $"you said “{AgentAnalysisService.Cut(c.Quote, 120)}”", c.SourceLabel ?? "from a meeting"],
                null, c.ProjectId, c.ProjectKey, c.Id.ToString(), "check_in"));

        // 4-5. My late work, and work others are waiting on.
        var myOpen = await db.Tasks.AsNoTracking().Where(t => t.AssigneeId == me && t.ParentTaskId == null && projectIds.Contains(t.ProjectId)
                && t.Status!.Category != StatusCategory.Done && t.Status.Category != StatusCategory.Cancelled)
            .Select(t => new { t.Id, t.ProjectId, t.Number, t.Title, t.DueDate }).Take(2000).ToListAsync(ct);
        var myIds = myOpen.Select(t => t.Id).ToList();
        var waitingOnMe = await db.TaskDependencies.AsNoTracking().Where(d => myIds.Contains(d.DependsOnTaskId)
                && d.Task!.Status!.Category != StatusCategory.Done && d.Task.Status.Category != StatusCategory.Cancelled)
            .Select(d => new { d.DependsOnTaskId, d.Task!.ProjectId, d.Task.Number, d.Task.DueDate, Owner = d.Task.Assignee != null ? d.Task.Assignee.DisplayName : null })
            .ToListAsync(ct);
        string K(Guid projectId, int n) => $"{keyOf.GetValueOrDefault(projectId) ?? "?"}-{n}";
        var owe = myOpen.Where(t => t.DueDate is { } d && d <= today || waitingOnMe.Any(w => w.DependsOnTaskId == t.Id))
            .Select(t => new CcWorkDto(t.Id, t.ProjectId, K(t.ProjectId, t.Number), t.Title, t.DueDate,
                t.DueDate is { } d ? d < today ? "overdue" : d == today ? "due_today" : "open" : "open", t.DueDate is { } d2 && d2 < today ? today.DayNumber - d2.DayNumber : null,
                waitingOnMe.Where(w => w.DependsOnTaskId == t.Id).Select(w => $"{K(w.ProjectId, w.Number)} ({AgentSessions.FirstName(w.Owner)})").ToList()))
            .OrderByDescending(w => w.Waiting.Count).ThenBy(w => w.Due ?? DateOnly.MaxValue).Take(15).ToList();
        var late = owe.Where(w => w.State == "overdue").ToList();
        if (late.Count > 0)
            attention.Add(new CcAttentionDto("overdue", "overdue", late.Any(w => w.DaysLate >= 3) ? "high" : "medium",
                $"{late.Count} of your tasks {(late.Count == 1 ? "is" : "are")} late", null,
                late.Take(4).Select(w => $"{w.Key} · {w.DaysLate}d late").ToList(), "/my-work", null, null, null, "open"));
        foreach (var w in owe.Where(w => w.Waiting.Count > 0).Take(3))
            attention.Add(new CcAttentionDto($"blocking:{w.Id:N}", "blocking", w.State == "overdue" || waitingOnMe.Any(x => x.DependsOnTaskId == w.Id && x.DueDate <= today.AddDays(3)) ? "high" : "medium",
                $"{w.Key} is holding up {w.Waiting.Count} task{(w.Waiting.Count == 1 ? "" : "s")}", w.Title,
                [$"waiting: {string.Join(", ", w.Waiting.Take(3))}{(w.Waiting.Count > 3 ? $" +{w.Waiting.Count - 3}" : "")}", w.Due is { } d ? $"your date: {d:ddd d MMM}" : "no date set"],
                $"/projects/{w.ProjectId}", w.ProjectId, keyOf.GetValueOrDefault(w.ProjectId), w.Id.ToString(), "open"));

        // 6. Double-booked: the agent can go to one of them.
        IReadOnlyList<MyMeetingDto> meetings = [];
        try { meetings = await delegations.MyMeetingsAsync(now.AddHours(-1), 72, ct); }
        catch (AppException ex) { log.LogInformation("Meetings unavailable for the Command Center: {Reason}", ex.Message); }
        var seenPairs = new HashSet<string>();
        foreach (var m in meetings.Where(m => m.Project && m.StartUtc > now && m.OverlapsWith.Count > 0 && m.DelegationId is null && !m.Organizer).Take(4))
        {
            if (!seenPairs.Add(string.Join("|", new[] { m.Title }.Concat(m.OverlapsWith).OrderBy(x => x)))) continue;
            attention.Add(new CcAttentionDto($"double:{m.Id}", "double_booked", m.StartUtc < now.AddHours(24) ? "high" : "medium",
                $"Double-booked: {m.Title}", $"overlaps {string.Join(", ", m.OverlapsWith)}",
                [m.AgentEnabled ? "the agent can attend as your assistant and report back" : $"switch on {m.ProjectName}'s agent to send it"],
                null, m.ProjectId, m.ProjectKey, m.MeetingId?.ToString(), m.AgentEnabled ? "delegate" : null, m.StartUtc.ToString("o")));
        }

        // 7. Projects at risk (the portfolio's own rules: overdue work, slipping dates, elapsed time against progress).
        IReadOnlyList<PortfolioRiskDto> ranked = [];
        try { ranked = (await portfolio.BriefAsync(null, ct)).Ranked.Where(r => projectIds.Contains(r.ProjectId)).ToList(); }
        catch (AppException ex) { log.LogInformation("Portfolio brief unavailable for the Command Center: {Reason}", ex.Message); }
        foreach (var r in ranked.Where(r => r.Level == "high" && manage.Contains(r.ProjectId)).Take(3))
            attention.Add(new CcAttentionDto($"risk:{r.ProjectId:N}", "at_risk", "high", $"{r.Name} is at risk", r.ProjectedSlipDays is > 0 ? $"projected {r.ProjectedSlipDays} days late" : null,
                r.Reasons.Take(4).ToList(), $"/projects/{r.ProjectId}", r.ProjectId, r.Key, null, "open"));

        // 8. Commitments missed in my projects this fortnight.
        var fortnight = today.AddDays(-14);
        var missed = await db.AgentCommitments.AsNoTracking().Where(c => manageIds.Contains(c.ProjectId) && c.Status == "missed" && c.DueDate >= fortnight)
            .Select(c => new { c.ProjectId, c.EntityKey, c.Title, c.OwnerUserId, c.DueDate }).ToListAsync(ct);
        var ownerIds = missed.Select(m => m.OwnerUserId).Distinct().ToList();
        var owners = await db.Users.AsNoTracking().Where(u => ownerIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        foreach (var g in missed.GroupBy(m => m.ProjectId).Where(g => g.Count() >= 2))
            attention.Add(new CcAttentionDto($"missed:{g.Key:N}", "missed_commitments", g.Count() >= 4 ? "high" : "medium",
                $"{g.Count()} commitments missed in {myProjects.First(p => p.Id == g.Key).Name}", "in the last two weeks",
                g.OrderBy(m => m.DueDate).Take(4).Select(m => $"{m.EntityKey ?? m.Title} ({AgentSessions.FirstName(owners.GetValueOrDefault(m.OwnerUserId))}, due {m.DueDate:d MMM})").ToList(),
                $"/projects/{g.Key}?tab=agent", g.Key, keyOf.GetValueOrDefault(g.Key), null, "open"));

        // 9. A meeting or message gave a date the tracker does not have.
        var dated = await db.AgentFindings.AsNoTracking().Where(f => manageIds.Contains(f.ProjectId) && f.Status == AgentFindingStatus.Proposed && f.CommitmentId == null
                && Moves.Contains(f.Kind) && f.TaskId != null && f.DueDate != null)
            .Select(f => new { f.Id, f.ProjectId, f.TaskId, f.DueDate, f.SourceLabel, f.Evidence, TaskDue = db.Tasks.Where(t => t.Id == f.TaskId).Select(t => t.DueDate).FirstOrDefault(),
                Number = db.Tasks.Where(t => t.Id == f.TaskId).Select(t => t.Number).FirstOrDefault() })
            .Take(20).ToListAsync(ct);
        foreach (var f in dated.Where(f => f.TaskDue != f.DueDate).Take(4))
            attention.Add(new CcAttentionDto($"conflict:{f.Id:N}", "conflict", "medium",
                $"{K(f.ProjectId, f.Number)}: {f.SourceLabel ?? "the source"} says {f.DueDate:d MMM}, the tracker says {(f.TaskDue is { } td ? td.ToString("d MMM") : "no date")}", null,
                [f.Evidence is null ? "which date should stand?" : $"“{AgentAnalysisService.Cut(f.Evidence, 140)}”"], $"/projects/{f.ProjectId}?tab=agent",
                f.ProjectId, keyOf.GetValueOrDefault(f.ProjectId), f.Id.ToString(), "decide"));

        // 10. Work that keeps coming up without closure.
        var month = now.AddDays(-30);
        var talked = await db.AgentFindings.AsNoTracking().Where(f => manageIds.Contains(f.ProjectId) && f.TaskId != null && f.CreatedAt >= month
                && (f.Kind == AgentFindingKind.Delay || f.Kind == AgentFindingKind.Missed || f.Kind == AgentFindingKind.UpdateTask))
            .Select(f => new { f.TaskId, f.RunId, f.ProjectId }).ToListAsync(ct);
        var repeated = talked.GroupBy(f => f.TaskId!.Value).Where(g => g.Select(x => x.RunId).Distinct().Count() >= 3).Select(g => g.Key).ToList();
        if (repeated.Count > 0)
        {
            var stillOpen = await db.Tasks.AsNoTracking().Where(t => repeated.Contains(t.Id) && t.Status!.Category != StatusCategory.Done && t.Status.Category != StatusCategory.Cancelled)
                .Select(t => new { t.Id, t.ProjectId, t.Number, t.Title }).Take(3).ToListAsync(ct);
            foreach (var t in stillOpen)
                attention.Add(new CcAttentionDto($"unresolved:{t.Id:N}", "unresolved", "medium",
                    $"{K(t.ProjectId, t.Number)} has come up {talked.Where(x => x.TaskId == t.Id).Select(x => x.RunId).Distinct().Count()} times without closure", t.Title,
                    ["raised again in meetings, mail or chat this month", "consider an owner, a date or a decision"], $"/projects/{t.ProjectId}", t.ProjectId,
                    keyOf.GetValueOrDefault(t.ProjectId), t.Id.ToString(), "open"));
        }

        var ordered = attention.OrderBy(a => a.Severity switch { "high" => 0, "medium" => 1, _ => 2 })
            .ThenBy(a => Array.IndexOf(new[] { "change_request", "check_in", "blocking", "double_booked", "decide", "overdue", "conflict", "at_risk", "missed_commitments", "unresolved" }, a.Kind))
            .Take(20).ToList();

        // What changed since my last visit.
        var changes = new List<CcChangeDto>();
        var finished = await db.Tasks.AsNoTracking().Where(t => projectIds.Contains(t.ProjectId) && t.CompletedAt >= since && t.Status!.Category == StatusCategory.Done)
            .OrderByDescending(t => t.CompletedAt).Take(30).Select(t => new { t.ProjectId, t.Number, t.CompletedAt, t.AssigneeId }).ToListAsync(ct);
        if (finished.Count > 0)
            changes.Add(new CcChangeDto("done", $"{finished.Count} task{(finished.Count == 1 ? "" : "s")} finished: {string.Join(", ", finished.Take(5).Select(t => K(t.ProjectId, t.Number)))}{(finished.Count > 5 ? $" +{finished.Count - 5}" : "")}",
                null, finished.Max(t => t.CompletedAt!.Value), null));
        var given = await db.Tasks.AsNoTracking().Where(t => t.AssigneeId == me && t.CreatedAt >= since && t.ReporterId != me).OrderByDescending(t => t.CreatedAt).Take(10)
            .Select(t => new { t.Id, t.ProjectId, t.Number, t.Title, t.CreatedAt }).ToListAsync(ct);
        foreach (var t in given.Take(5))
            changes.Add(new CcChangeDto("assigned", $"New for you: {K(t.ProjectId, t.Number)} {AgentAnalysisService.Cut(t.Title, 80)}", $"/projects/{t.ProjectId}", t.CreatedAt, keyOf.GetValueOrDefault(t.ProjectId)));
        var decided = await db.AgentFindings.AsNoTracking().Where(f => projectIds.Contains(f.ProjectId) && f.Status == AgentFindingStatus.Applied && f.DecidedAt >= since
                && (f.Kind == AgentFindingKind.Decision || f.Kind == AgentFindingKind.Delay || f.AutoApplied))
            .OrderByDescending(f => f.DecidedAt).Take(12).Select(f => new { f.ProjectId, f.Kind, f.Title, f.DecidedAt, f.AutoApplied, f.AppliedKey }).ToListAsync(ct);
        foreach (var f in decided)
            changes.Add(new CcChangeDto(f.AutoApplied ? "auto" : f.Kind == AgentFindingKind.Decision ? "decision" : "moved",
                f.AutoApplied ? $"The agent added {f.AppliedKey ?? AgentAnalysisService.Cut(f.Title, 80)}" : f.Kind == AgentFindingKind.Decision ? $"Decision: {AgentAnalysisService.Cut(f.Title, 100)}" : AgentAnalysisService.Cut(f.Title, 100)!,
                $"/projects/{f.ProjectId}?tab=agent", f.DecidedAt!.Value, keyOf.GetValueOrDefault(f.ProjectId)));
        var read = await db.AgentRuns.AsNoTracking().Where(r => projectIds.Contains(r.ProjectId) && r.Status == "done" && r.FinishedAt >= since && r.Trigger == "meeting")
            .OrderByDescending(r => r.FinishedAt).Take(5).Select(r => new { r.ProjectId, r.FindingCount, r.FinishedAt }).ToListAsync(ct);
        foreach (var r in read)
            changes.Add(new CcChangeDto("meeting", $"A {keyOf.GetValueOrDefault(r.ProjectId)} meeting was read: {r.FindingCount} item{(r.FindingCount == 1 ? "" : "s")}", $"/projects/{r.ProjectId}?tab=agent",
                r.FinishedAt!.Value, keyOf.GetValueOrDefault(r.ProjectId)));
        changes = changes.OrderByDescending(c => c.At).Take(15).ToList();

        // Health of my projects, with how reliably commitments were kept there (30 days).
        var since30 = today.AddDays(-30);
        var promised = await db.AgentCommitments.AsNoTracking().Where(c => projectIds.Contains(c.ProjectId) && c.DueDate >= since30)
            .Select(c => new { c.ProjectId, c.Status }).ToListAsync(ct);
        var health = ranked.OrderByDescending(r => r.Score).Take(8).Select(r => new CcHealthDto(r.ProjectId, r.Key, r.Name, r.Level, r.Score, r.Reasons.Take(3).ToList(), r.Progress,
            r.OverdueTasks, r.DueDate, r.ProjectedFinish, r.ProjectedSlipDays, promised.Count(c => c.ProjectId == r.ProjectId && c.Status == "kept"),
            promised.Count(c => c.ProjectId == r.ProjectId && c.Status == "missed"))).ToList();
        var reliability = new CcReliabilityDto(promised.Count(c => c.Status == "kept"), promised.Count(c => c.Status == "missed"), promised.Count(c => c.Status == "open"),
            promised.Count(c => c.Status == "moved"));

        var localNow = ZoneTimeLocal(now, clock.Zone);
        // "Today" is the coming day rather than the calendar date, so a late-evening look still shows tomorrow morning's stand-up.
        var todays = meetings.Where(m => m.EndUtc > now.AddMinutes(-30) && m.StartUtc < now.AddHours(18)).Take(12).ToList();
        var mineDelegations = await delegations.MineAsync(ct);

        var greeting = (localNow.Hour < 12 ? "Good morning" : localNow.Hour < 17 ? "Good afternoon" : "Good evening") + $", {AgentSessions.FirstName(name)}";
        var headline = ordered.Count == 0
            ? $"Nothing needs you right now.{(todays.Count > 0 ? $" {todays.Count} meeting{(todays.Count == 1 ? "" : "s")} today." : "")}"
            : $"{ordered.Count} thing{(ordered.Count == 1 ? " needs" : "s need")} your attention{(ordered.Count(a => a.Severity == "high") is > 0 and var h ? $", {h} urgent" : "")}: " +
              Sentence(ordered[0].Title) + (ordered.Count > 1 ? " " + Sentence(ordered[1].Title) : "");
        var counts = new CcCountsDto(ordered.Count, waiting.Count + requests.Count, owe.Count(w => w.State == "due_today"), late.Count, owe.Count(w => w.Waiting.Count > 0),
            mine.Count(c => c.AwaitingAnswer), todays.Count, ranked.Count(r => r.Level == "high"));
        return new CommandCenterDto(greeting, headline, since, counts, ordered, todays, changes, health, reliability, mine, owe, mineDelegations);
    }

    /// <summary>Ends a title as a sentence (a question keeps its question mark).</summary>
    private static string Sentence(string text) => text.TrimEnd().EndsWith('?') || text.TrimEnd().EndsWith('.') || text.TrimEnd().EndsWith('!') ? text.TrimEnd() : text.TrimEnd() + ".";

    private static DateTime ZoneTimeLocal(DateTime utc, NodaTime.DateTimeZone zone) => Reminders.ZoneTime.ToLocal(utc, zone);

    // ---------------------------------------------------------------- personal settings

    public async Task<AgentPersonalSettingsDto> GetSettingsAsync(CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var p = await db.AgentPersonalSettings.AsNoTracking().FirstOrDefaultAsync(x => x.UserId == me, ct);
        var google = await db.GoogleConnections.AsNoTracking().AnyAsync(c => c.UserId == me, ct);
        return new AgentPersonalSettingsDto(p?.AutoDelegate ?? false, p?.MeetingBriefs ?? true, p?.BriefMinutes ?? 10, p?.CheckIns ?? true, google);
    }

    public async Task<AgentPersonalSettingsDto> SaveSettingsAsync(SaveAgentPersonalSettingsRequest req, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId(); var tid = ctx.RequireTenantId();
        if (req.BriefMinutes is { } m && m is < 5 or > 60) throw new ValidationException("briefMinutes", "Choose 5 to 60 minutes.");
        var p = await db.AgentPersonalSettings.FirstOrDefaultAsync(x => x.UserId == me, ct);
        if (p is null) { p = new AgentPersonalSettings { TenantId = tid, UserId = me, CreatedAt = clock.Now, CreatedBy = me }; db.AgentPersonalSettings.Add(p); }
        p.AutoDelegate = req.AutoDelegate ?? p.AutoDelegate; p.MeetingBriefs = req.MeetingBriefs ?? p.MeetingBriefs;
        p.BriefMinutes = req.BriefMinutes ?? p.BriefMinutes; p.CheckIns = req.CheckIns ?? p.CheckIns; p.UpdatedAt = clock.Now;
        await db.SaveChangesAsync(ct);
        return await GetSettingsAsync(ct);
    }

    // ---------------------------------------------------------------- the decision registry and the audit trail

    /// <summary>Decisions the agent recorded, newest first, across the projects the person can open (the quotes only where they may decide).</summary>
    public async Task<IReadOnlyList<AgentDecisionDto>> DecisionsAsync(Guid? projectId, string? q, CancellationToken ct = default)
    {
        ctx.RequireUserId();
        var query = db.AgentFindings.AsNoTracking().Where(f => f.Kind == AgentFindingKind.Decision && f.Status != AgentFindingStatus.Dismissed && f.Status != AgentFindingStatus.Failed);
        if (projectId is { } pid) query = query.Where(f => f.ProjectId == pid);
        var visible = db.Projects.Select(p => p.Id);
        query = query.Where(f => visible.Contains(f.ProjectId));
        if (!string.IsNullOrWhiteSpace(q))
        {
            var term = q.Trim().ToLower();
            if (term.Length > 100) term = term[..100];
            query = query.Where(f => f.Title.ToLower().Contains(term) || (f.Detail != null && f.Detail.ToLower().Contains(term)));
        }
        var rows = await query.OrderByDescending(f => f.CreatedAt).Take(150).ToListAsync(ct);
        var pids = rows.Select(r => r.ProjectId).Distinct().ToList();
        var projects = await db.Projects.AsNoTracking().Where(p => pids.Contains(p.Id)).ToListAsync(ct);
        var canManage = new HashSet<Guid>();
        foreach (var p in projects) if (await settings.CanManageAsync(p, ct)) canManage.Add(p.Id);
        var userIds = rows.Where(r => r.DecidedBy is not null).Select(r => r.DecidedBy!.Value).Distinct().ToList();
        var users = await db.Users.AsNoTracking().Where(u => userIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        var taskIds = rows.Where(r => r.TaskId is not null).Select(r => r.TaskId!.Value).ToList();
        var tasks = await db.Tasks.AsNoTracking().Where(t => taskIds.Contains(t.Id)).ToDictionaryAsync(t => t.Id, t => t.Number, ct);
        return rows.Select(r =>
        {
            var p = projects.First(x => x.Id == r.ProjectId);
            var decide = canManage.Contains(r.ProjectId);
            return new AgentDecisionDto(r.Id, r.ProjectId, p.Key, p.Name, r.Title, r.Detail, decide ? r.Evidence : null, r.SourceLabel,
                r.Status.ToString(), r.CreatedAt, r.DecidedBy is { } d && users.TryGetValue(d, out var n) ? new AgentPersonRef(d, n) : null, r.DecidedAt,
                r.TaskId is { } t && tasks.TryGetValue(t, out var num) ? $"{p.Key}-{num}" : null);
        }).ToList();
    }

    /// <summary>Everything decided on the agent's proposals - by whom (or by the agent itself), before and after - for the projects the person may decide on.</summary>
    public async Task<IReadOnlyList<AgentAuditDto>> AuditAsync(Guid? projectId, CancellationToken ct = default)
    {
        ctx.RequireUserId();
        var projects = await db.Projects.AsNoTracking().Where(p => projectId == null || p.Id == projectId)
            .Where(p => db.AgentFindings.Any(f => f.ProjectId == p.Id && f.Status != AgentFindingStatus.Proposed)).Take(100).ToListAsync(ct);
        var allowed = new List<Project>();
        foreach (var p in projects) if (await settings.CanManageAsync(p, ct)) allowed.Add(p);
        if (projectId is not null && allowed.Count == 0 && projects.Count > 0) throw new ForbiddenException("Only people who may edit this project can see its audit trail.", "PERMISSION_DENIED");
        var ids = allowed.Select(p => p.Id).ToList();
        var rows = await db.AgentFindings.AsNoTracking().Where(f => ids.Contains(f.ProjectId) && f.Status != AgentFindingStatus.Proposed)
            .OrderByDescending(f => f.DecidedAt ?? f.UpdatedAt ?? f.CreatedAt).Take(150).ToListAsync(ct);
        var userIds = rows.SelectMany(r => new[] { r.DecidedBy, r.AssigneeId }).Where(x => x is not null).Select(x => x!.Value).Distinct().ToList();
        var users = await db.Users.AsNoTracking().Where(u => userIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        return rows.Select(r =>
        {
            var p = allowed.First(x => x.Id == r.ProjectId);
            var after = new List<string>();
            if (r.DueDate is { } d) after.Add($"due {d:yyyy-MM-dd}");
            if (r.NewStatus is { } st) after.Add(st.Replace('_', ' '));
            if (r.AssigneeId is { } a && users.TryGetValue(a, out var owner)) after.Add(owner);
            if (r.Priority is { } pr) after.Add(pr.ToString());
            var action = r.Status switch
            {
                AgentFindingStatus.Dismissed => "Dismissed",
                AgentFindingStatus.Failed => "Failed",
                _ => r.AutoApplied ? "Carried out by the agent" : "Approved",
            };
            return new AgentAuditDto(r.Id, r.ProjectId, p.Key, r.Kind, action, r.Title, r.AppliedKey, r.Status.ToString(), r.AutoApplied,
                r.DecidedBy is { } by && users.TryGetValue(by, out var n) ? new AgentPersonRef(by, n) : null, r.DecidedAt, r.Confidence, r.Before,
                after.Count == 0 ? null : string.Join(" · ", after), r.Evidence, r.SourceLabel, r.Error);
        }).ToList();
    }
}
