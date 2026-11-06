using System.Collections.Concurrent;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Agent;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Insights;

/// <summary>
/// The one action of a briefing item. <c>Verb</c>: approve (POST <c>Endpoint</c> with <c>Body</c>, in place), review (open the meeting review
/// sheet for <c>TargetId</c>), open (go to <c>Href</c>), reassign (open the item to give it another owner) or join (open <c>Href</c>, the call).
/// </summary>
public record AuraActionDto(string Verb, string Label, string? Href, string? Endpoint = null, object? Body = null, Guid? TargetId = null);
/// <summary>Something Aura read to say what it says: a date change, a dependency, an activity, a comment - with where to open it.</summary>
public record AuraEvidenceDto(string Kind, string Label, string? Detail, string? Href, DateTime? At = null);
public record AuraBriefItemDto(string Id, string Kind, string Title, string Why, string? ProjectName, Guid? ProjectId, AuraActionDto Action,
    string Tone = "neutral", IReadOnlyList<AuraEvidenceDto>? Evidence = null);
public record AuraMeetingBriefDto(string Id, string Title, DateTime Start, DateTime? End, string? ProjectName, Guid? ProjectId, string? JoinUrl, string? Link,
    IReadOnlyList<string> OpenQuestions, AuraActionDto Action);
/// <summary>
/// Aura's morning briefing. <c>GeneratedAt</c> is when today's briefing was first written for this person (once per local morning);
/// <c>RefreshedAt</c> when the items were last read again (every call - live events make the client ask again). <c>Ai</c>: the line was
/// phrased by the model (false: the deterministic sentence, as without AI keys).
/// </summary>
public record AuraBriefingDto(DateOnly Day, string TimeZone, string Headline, string Line, bool Ai, IReadOnlyList<AuraBriefItemDto> NeedsYou, int MoreNeedsYou,
    IReadOnlyList<AuraBriefItemDto> AtRisk, IReadOnlyList<AuraMeetingBriefDto> Meetings, bool FridayReport, DateTime GeneratedAt, DateTime RefreshedAt);

/// <summary>
/// "3 things need you today": approvals waiting on the person, meeting minutes to review, their work that blocks others, work due today; what is
/// at risk and why (slipped dependency, overdue owner, the reasons dates were moved); and today's meetings with the questions left open last time.
/// Everything comes from rules over the person's own reach (projects and tasks through the query filters, approvals addressed to them, findings
/// on projects they may edit); the model only shortens the line under the headline, and is never needed.
/// </summary>
public class AuraBriefingService(IAppDbContext db, ICurrentContext ctx, AppClock clock, TimelineService timeline, AgentSettingsService agent,
    DocumentAiService ai)
{
    private record Cached(DateTime GeneratedAt, string Fingerprint, string Line, bool Ai);
    private static readonly ConcurrentDictionary<string, Cached> Lines = new();

    public static string TaskHref(Guid taskId) => $"/work?item={taskId}";

    public async Task<AuraBriefingDto> GetAsync(CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        var me = ctx.RequireUserId();
        var today = clock.Today;
        var now = clock.Now;

        var needs = new List<(AuraBriefItemDto Item, AuraBriefingRules.Need Need)>();
        needs.AddRange(await ApprovalsAsync(me, now, ct));
        needs.AddRange(await ReviewsAsync(now, ct));
        needs.AddRange(await MyWorkAsync(me, today, ct));
        var ranked = AuraBriefingRules.Rank(needs, x => x.Need).Select(x => x.Item).ToList();
        var shown = ranked.Take(AuraBriefingRules.NeedsYouShown).ToList();

        var risks = await RisksAsync(me, today, shown.Select(s => s.Id).ToHashSet(), ct);
        var meetings = await MeetingsAsync(today, now, ct);
        var friday = today.DayOfWeek == DayOfWeek.Friday
            && await db.Projects.AsNoTracking().AnyAsync(p => p.OwnerId == me && p.ArchivedAt == null && p.Status != ProjectStatus.Archived && p.Status != ProjectStatus.Completed && p.Status != ProjectStatus.Cancelled, ct);

        var line = AuraBriefingRules.Line(shown.Select(s => (s.Title, s.Action.Verb)).ToList(), risks.Count, meetings.Count);
        var (generated, phrased, byAi) = await PhraseAsync(tid, me, today, shown, risks, meetings, line, ct);
        return new AuraBriefingDto(today, clock.ZoneId, AuraBriefingRules.Headline(ranked.Count), phrased, byAi, shown, Math.Max(0, ranked.Count - shown.Count),
            risks, meetings, friday, generated, now);
    }

    // ------------------------------------------------------------------ what needs you

    private async Task<List<(AuraBriefItemDto, AuraBriefingRules.Need)>> ApprovalsAsync(Guid me, DateTime now, CancellationToken ct)
    {
        var rows = await (from s in db.ApprovalRequestSteps.AsNoTracking()
                          join r in db.ApprovalRequests.AsNoTracking() on s.RequestId equals r.Id
                          join u in db.Users.AsNoTracking() on r.RequesterId equals u.Id into req
                          from u in req.DefaultIfEmpty()
                          where s.ApproverId == me && s.Status == "Pending" && r.Status == ApprovalStatuses.Pending
                          orderby r.CreatedAt
                          select new { r.Id, r.Title, r.Summary, r.CreatedAt, Requester = u != null ? u.DisplayName : null }).Take(20).ToListAsync(ct);
        return rows.DistinctBy(r => r.Id).Select(r =>
        {
            var age = Math.Max(0, (int)(now - r.CreatedAt).TotalDays);
            var why = $"{(r.Requester is { } n ? AuraBriefingRules.First(n) : "Someone")} asked {(age == 0 ? "today" : age == 1 ? "yesterday" : $"{age} days ago")}"
                      + (r.Summary is { Length: > 0 } s ? $" · {Text.Truncate(s, 90)}" : "") + ".";
            var item = new AuraBriefItemDto($"approval:{r.Id}", "approval", r.Title, why, null, null,
                new AuraActionDto("approve", "Approve", $"/approvals?open={r.Id}", $"/api/v1/approvals/{r.Id}/decide", new { action = "approve" }, r.Id),
                age >= 2 ? "orange" : "neutral");
            return (item, new AuraBriefingRules.Need(item.Id, "approval", age));
        }).ToList();
    }

    /// <summary>Meetings the agent read whose action items wait for this person's decision (projects they may edit).</summary>
    private async Task<List<(AuraBriefItemDto, AuraBriefingRules.Need)>> ReviewsAsync(DateTime now, CancellationToken ct)
    {
        var runs = await (from r in db.AgentRuns.AsNoTracking()
                          where r.MeetingId != null && r.Status == "done" && r.FinishedAt != null && r.FinishedAt > now.AddDays(-14)
                                && db.AgentFindings.Any(f => f.RunId == r.Id && f.Status == AgentFindingStatus.Proposed)
                          orderby r.FinishedAt descending
                          select new { r.Id, r.ProjectId, r.MeetingId, r.FinishedAt, Pending = db.AgentFindings.Count(f => f.RunId == r.Id && f.Status == AgentFindingStatus.Proposed) })
            .Take(10).ToListAsync(ct);
        if (runs.Count == 0) return [];
        var projectIds = runs.Select(r => r.ProjectId).Distinct().ToList();
        var projects = await db.Projects.Where(p => projectIds.Contains(p.Id)).ToListAsync(ct);
        var mine = new HashSet<Guid>();
        foreach (var p in projects) if (await agent.CanManageAsync(p, ct)) mine.Add(p.Id);
        var meetingIds = runs.Select(r => r.MeetingId!.Value).Distinct().ToList();
        var titles = await db.ProjectMeetings.AsNoTracking().Where(m => meetingIds.Contains(m.Id)).ToDictionaryAsync(m => m.Id, m => m.Title, ct);
        var botTitles = await db.AgentMeetingBots.AsNoTracking().Where(b => meetingIds.Contains(b.MeetingId) && b.Title != null)
            .Select(b => new { b.MeetingId, b.Title }).ToListAsync(ct);
        return runs.Where(r => mine.Contains(r.ProjectId)).Select(r =>
        {
            var p = projects.First(x => x.Id == r.ProjectId);
            var title = titles.GetValueOrDefault(r.MeetingId!.Value) ?? botTitles.FirstOrDefault(b => b.MeetingId == r.MeetingId)?.Title ?? "your meeting";
            var age = Math.Max(0, (int)(now - r.FinishedAt!.Value).TotalDays);
            var item = new AuraBriefItemDto($"review:{r.Id}", "review", $"Approve the minutes of {title}",
                $"{r.Pending} item{(r.Pending == 1 ? "" : "s")} drafted from the meeting, waiting for you.", p.Name, p.Id,
                new AuraActionDto("review", "Review", $"/?aura=review&run={r.Id}", null, null, r.Id));
            return (item, new AuraBriefingRules.Need(item.Id, "review", age));
        }).ToList();
    }

    /// <summary>My open work: what blocks someone else, what is due today, what is overdue.</summary>
    private async Task<List<(AuraBriefItemDto, AuraBriefingRules.Need)>> MyWorkAsync(Guid me, DateOnly today, CancellationToken ct)
    {
        var open = await (from t in db.Tasks.AsNoTracking()
                          join s in db.WorkflowStatuses.AsNoTracking() on t.StatusId equals s.Id
                          join p in db.Projects.AsNoTracking() on t.ProjectId equals p.Id
                          where t.AssigneeId == me && s.Category != StatusCategory.Done && s.Category != StatusCategory.Cancelled
                                && t.DueDate != null && t.DueDate <= today
                          orderby t.DueDate
                          select new { t.Id, t.Number, t.Title, t.DueDate, t.DueTime, t.ProjectId, p.Key, p.Name }).Take(50).ToListAsync(ct);
        // My open work that someone else's open work waits on.
        var blocking = await (from d in db.TaskDependencies.AsNoTracking()
                              join mineT in db.Tasks.AsNoTracking() on d.DependsOnTaskId equals mineT.Id
                              join ms in db.WorkflowStatuses.AsNoTracking() on mineT.StatusId equals ms.Id
                              join other in db.Tasks.AsNoTracking() on d.TaskId equals other.Id
                              join os in db.WorkflowStatuses.AsNoTracking() on other.StatusId equals os.Id
                              join p in db.Projects.AsNoTracking() on mineT.ProjectId equals p.Id
                              join op in db.Projects.AsNoTracking() on other.ProjectId equals op.Id
                              where mineT.AssigneeId == me && ms.Category != StatusCategory.Done && ms.Category != StatusCategory.Cancelled
                                    && os.Category != StatusCategory.Done && os.Category != StatusCategory.Cancelled && other.AssigneeId != me
                              select new { mineT.Id, mineT.Number, mineT.Title, mineT.DueDate, mineT.ProjectId, p.Key, p.Name, OtherKey = op.Key, OtherNumber = other.Number,
                                  OtherOwner = db.Users.Where(u => u.Id == other.AssigneeId).Select(u => u.DisplayName).FirstOrDefault() })
            .Take(100).ToListAsync(ct);

        var list = new List<(AuraBriefItemDto, AuraBriefingRules.Need)>();
        foreach (var g in blocking.GroupBy(b => b.Id))
        {
            var t = g.First();
            var who = g.Select(x => x.OtherOwner).Where(x => x != null).Distinct().Select(x => AuraBriefingRules.First(x!)).Take(2).ToList();
            var why = $"{g.Count()} task{(g.Count() == 1 ? "" : "s")} wait{(g.Count() == 1 ? "s" : "")} on it ({string.Join(", ", g.Select(x => $"{x.OtherKey}-{x.OtherNumber}").Distinct().Take(3))})"
                      + (who.Count > 0 ? $" · {string.Join(" and ", who)} {(who.Count == 1 ? "is" : "are")} blocked" : "") + ".";
            var age = t.DueDate is { } d && d < today ? today.DayNumber - d.DayNumber : 0;
            var item = new AuraBriefItemDto($"task:{t.Id}", "unblock", $"{t.Key}-{t.Number} {t.Title}", why, t.Name, t.ProjectId,
                new AuraActionDto("open", "Open", TaskHref(t.Id), null, null, t.Id), "orange");
            list.Add((item, new AuraBriefingRules.Need(item.Id, "unblock", age, g.Count())));
        }
        foreach (var t in open)
        {
            var id = $"task:{t.Id}";
            if (list.Any(x => x.Item1.Id == id)) continue;
            var late = today.DayNumber - t.DueDate!.Value.DayNumber;
            var why = late == 0 ? (t.DueTime is { } at ? $"Due today at {at:HH:mm}." : "Due today.") : $"{late} day{(late == 1 ? "" : "s")} overdue.";
            var item = new AuraBriefItemDto(id, late == 0 ? "due" : "overdue", $"{t.Key}-{t.Number} {t.Title}", why, t.Name, t.ProjectId,
                new AuraActionDto("open", "Open", TaskHref(t.Id), null, null, t.Id), late == 0 ? "neutral" : "red");
            list.Add((item, new AuraBriefingRules.Need(id, late == 0 ? "due" : "overdue", late)));
        }
        return list;
    }

    // ------------------------------------------------------------------ at risk, and why

    private async Task<List<AuraBriefItemDto>> RisksAsync(Guid me, DateOnly today, HashSet<string> already, CancellationToken ct)
    {
        var horizon = today.AddDays(7);
        var rows = await (from t in db.Tasks.AsNoTracking()
                          join s in db.WorkflowStatuses.AsNoTracking() on t.StatusId equals s.Id
                          join p in db.Projects.AsNoTracking() on t.ProjectId equals p.Id
                          where s.Category != StatusCategory.Done && s.Category != StatusCategory.Cancelled && p.ArchivedAt == null
                                && (t.AssigneeId == me || p.OwnerId == me) && t.DueDate != null && t.DueDate <= horizon
                          orderby t.DueDate
                          select new { t.Id, t.Number, t.Title, t.DueDate, t.AssigneeId, t.ProjectId, p.Key, p.Name,
                              Owner = db.Users.Where(u => u.Id == t.AssigneeId).Select(u => u.DisplayName).FirstOrDefault() }).Take(300).ToListAsync(ct);
        if (rows.Count == 0) return [];
        var ids = rows.Select(r => r.Id).ToList();
        var blockerRows = await (from d in db.TaskDependencies.AsNoTracking()
                              join b in db.Tasks.AsNoTracking() on d.DependsOnTaskId equals b.Id
                              join s in db.WorkflowStatuses.AsNoTracking() on b.StatusId equals s.Id
                              join p in db.Projects.AsNoTracking() on b.ProjectId equals p.Id
                              where ids.Contains(d.TaskId)
                              select new { d.TaskId, b.Id, ProjectKey = p.Key, b.Number, b.Title, b.DueDate, Done = s.Category == StatusCategory.Done || s.Category == StatusCategory.Cancelled })
            .ToListAsync(ct);
        var blockers = blockerRows.Select(x => new { x.TaskId, x.Id, Key = $"{x.ProjectKey}-{x.Number}", x.Title, x.DueDate, x.Done }).ToList();
        var moves = await db.DueDateChanges.AsNoTracking().Where(c => c.TaskId != null && ids.Contains(c.TaskId.Value))
            .OrderByDescending(c => c.CreatedAt).Select(c => new { TaskId = c.TaskId!.Value, c.Previous, c.Revised, c.Reason }).ToListAsync(ct);
        var owners = rows.Where(r => r.AssigneeId != null).Select(r => r.AssigneeId!.Value).Distinct().ToList();
        var overdueByOwner = await (from t in db.Tasks.AsNoTracking()
                                    join s in db.WorkflowStatuses.AsNoTracking() on t.StatusId equals s.Id
                                    where t.AssigneeId != null && owners.Contains(t.AssigneeId.Value) && t.DueDate != null && t.DueDate < today
                                          && s.Category != StatusCategory.Done && s.Category != StatusCategory.Cancelled
                                    group t by t.AssigneeId into g
                                    select new { Id = g.Key!.Value, Count = g.Count() }).ToDictionaryAsync(x => x.Id, x => x.Count, ct);

        var risks = new List<(AuraBriefItemDto Item, int Score)>();
        foreach (var r in rows)
        {
            if (already.Contains($"task:{r.Id}")) continue;
            // The blocker that hurts most: not done, and the latest date.
            var b = blockers.Where(x => x.TaskId == r.Id && !x.Done).OrderByDescending(x => x.DueDate ?? DateOnly.MaxValue).FirstOrDefault();
            var mv = moves.Where(m => m.TaskId == r.Id).ToList();
            var facts = new AuraBriefingRules.RiskFacts(r.DueDate, today, r.AssigneeId == me, r.Owner, r.AssigneeId is { } a ? overdueByOwner.GetValueOrDefault(a) : 0,
                b is null ? null : new AuraBriefingRules.Blocker(b.Key, b.Title, b.DueDate, b.Done),
                mv.Count == 0 ? null : new AuraBriefingRules.Move(mv[0].Previous, mv[0].Revised, mv[0].Reason), mv.Count);
            if (AuraBriefingRules.Assess(facts) is not { } risk) continue;
            var evidence = new List<AuraEvidenceDto>();
            if (b is not null) evidence.Add(new AuraEvidenceDto("dependency", $"{b.Key} {b.Title}", b.DueDate is { } bd ? $"due {AuraBriefingRules.D(bd)}" : "no date", TaskHref(b.Id)));
            foreach (var m in mv.Take(3)) evidence.Add(new AuraEvidenceDto("date", $"{AuraBriefingRules.D(m.Previous)} → {AuraBriefingRules.D(m.Revised)}", m.Reason, TaskHref(r.Id)));
            var action = risk.Verb == "reassign"
                ? new AuraActionDto("reassign", "Reassign", $"{TaskHref(r.Id)}&field=assignee", null, null, r.Id)
                : risk.Kind == "dependency" && b is not null ? new AuraActionDto("open", $"Open {b.Key}", TaskHref(b.Id), null, null, b.Id)
                : new AuraActionDto("open", "Open", TaskHref(r.Id), null, null, r.Id);
            var title = $"{r.Key}-{r.Number} {r.Title}" + (r.Owner is { } o && r.AssigneeId != me ? $" · {AuraBriefingRules.First(o)}" : "");
            risks.Add((new AuraBriefItemDto($"risk:{r.Id}", risk.Kind, title, risk.Why, r.Name, r.ProjectId, action, risk.Score >= 60 ? "red" : "orange", evidence), risk.Score));
        }
        return risks.OrderByDescending(x => x.Score).ThenBy(x => x.Item.Id, StringComparer.Ordinal).Take(AuraBriefingRules.RisksShown).Select(x => x.Item).ToList();
    }

    // ------------------------------------------------------------------ today's meetings, with the questions left open

    private async Task<List<AuraMeetingBriefDto>> MeetingsAsync(DateOnly today, DateTime now, CancellationToken ct)
    {
        TimelineDto day;
        try { day = await timeline.GetAsync(today, today, "me", null, ct); }
        catch (AppException) { return []; }   // no calendar for this person: nothing to list
        var meets = day.Events.Where(e => e.Type == "meeting" && (e.End ?? e.Start.AddMinutes(30)) > now).OrderBy(e => e.Start).Take(4).ToList();
        if (meets.Count == 0) return [];
        var meetingIds = meets.Select(m => m.SourceId).Distinct().ToList();
        var projectIds = meets.Where(m => m.ProjectId != null).Select(m => m.ProjectId!.Value).Distinct().ToList();
        var since = now.AddDays(-21);
        // Points nobody picked up in the last session of this meeting, else lately in its project.
        var open = await (from f in db.AgentFindings.AsNoTracking()
                          join r in db.AgentRuns.AsNoTracking() on f.RunId equals r.Id
                          where f.Kind == AgentFindingKind.Missed && f.Status != AgentFindingStatus.Dismissed && f.CreatedAt > since
                                && ((r.MeetingId != null && meetingIds.Contains(r.MeetingId.Value)) || projectIds.Contains(f.ProjectId))
                          orderby f.CreatedAt descending
                          select new { f.Title, r.MeetingId, f.ProjectId }).Take(40).ToListAsync(ct);
        return meets.Select(m =>
        {
            var qs = open.Where(o => o.MeetingId == m.SourceId).Concat(open.Where(o => m.ProjectId != null && o.ProjectId == m.ProjectId))
                .Select(o => o.Title).Distinct().Take(3).ToList();
            var soon = m.Start - now <= TimeSpan.FromMinutes(15);
            var action = m.JoinUrl is { Length: > 0 } j && soon ? new AuraActionDto("join", "Join", j)
                : new AuraActionDto("open", m.JoinUrl is { Length: > 0 } ? "Prepare" : "Open", m.Link);
            return new AuraMeetingBriefDto(m.Id, m.Title, m.Start, m.End, m.ProjectName, m.ProjectId, m.JoinUrl, m.Link, qs, action);
        }).ToList();
    }

    // ------------------------------------------------------------------ the line, phrased once per morning

    private async Task<(DateTime Generated, string Line, bool Ai)> PhraseAsync(Guid tid, Guid me, DateOnly today, IReadOnlyList<AuraBriefItemDto> needs,
        IReadOnlyList<AuraBriefItemDto> risks, IReadOnlyList<AuraMeetingBriefDto> meetings, string line, CancellationToken ct)
    {
        var key = $"{tid:N}:{me:N}:{today:yyyyMMdd}";
        var fingerprint = string.Join("|", needs.Select(n => n.Id).Concat(risks.Select(r => r.Id)).Concat(meetings.Select(m => m.Id)));
        if (Lines.TryGetValue(key, out var hit) && hit.Fingerprint == fingerprint) return (hit.GeneratedAt, hit.Line, hit.Ai);
        var generated = hit?.GeneratedAt ?? clock.Now;
        if (Lines.Count > 20_000) Lines.Clear();   // bounded: a day's worth of people
        foreach (var stale in Lines.Keys.Where(k => k.StartsWith($"{tid:N}:{me:N}:", StringComparison.Ordinal) && k != key).ToList()) Lines.TryRemove(stale, out _);

        var phrased = line; var byAi = false;
        if (needs.Count + risks.Count > 0)
        {
            try
            {
                await ai.EnsureAiAsync(ct);
                var facts = string.Join("\n", needs.Select(n => $"NEEDS YOU: {n.Title} — {n.Why} (action: {n.Action.Label})")
                    .Concat(risks.Select(r => $"AT RISK: {r.Title} — {r.Why}")).Concat(meetings.Select(m => $"MEETING: {m.Title}")));
                var system = GrootIdentity.Generic + "You write the one sentence under a morning briefing's headline. Under 22 words. Tell the person what to do first and what is at risk, " +
                             "using only the facts given. Plain words, no greeting, no emoji, no lists, no quotes around it.";
                var answer = await ai.AskModelAsync("aura_briefing", system, facts.Length > 3000 ? facts[..3000] : facts, 80, 1, ct);
                var text = (answer.Text ?? "").Split('\n').Select(l => l.Trim()).FirstOrDefault(l => l.Length > 0)?.Trim('"', '“', '”') ?? "";
                if (text.Length is > 0 and <= 240) { phrased = text; byAi = true; }
            }
            catch (Exception ex) when (ex is not OperationCanceledException) { /* without AI (or when it fails) the rules' sentence stands */ }
        }
        Lines[key] = new Cached(generated, fingerprint, phrased, byAi);
        return (generated, phrased, byAi);
    }
}
