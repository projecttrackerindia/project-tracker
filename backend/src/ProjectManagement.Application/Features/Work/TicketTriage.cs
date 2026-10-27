using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Work;

/// <summary>
/// Ticket triage: what new operational work probably is - its type and priority from similar work and its wording, who usually resolves that
/// kind of work (and has room), and open work that looks the same - from the workspace's own history, no AI model involved. The new-ticket
/// form shows it at every level but Off. When a ticket is raised (<see cref="OnRaisedAsync"/>), Settings › AI decides the rest: at Ask first
/// the priority and owner it would set wait in the inbox of the person who raised it (or of the operations escalation contact when they
/// cannot change tickets); at Auto they are set straight away and logged. It never overrides what the person chose: a priority given on
/// the form, or an assignee given or picked by a routing rule, is kept; and it only ever raises a priority, never lowers one.
/// </summary>
public class TicketTriage(IAppDbContext db, ICurrentContext ctx, AppClock clock, PermissionService permissions, AiAgentGate gate, AiActionLog actionLog)
{
    public static readonly TriageDto Nothing = new(null, null, null, null, null, null, null, [], null);

    /// <summary>What an "Ask first" row carries: the priority and owner to set on the ticket.</summary>
    public record Proposal(Priority? Priority, Guid? AssigneeId);

    private async Task<Dictionary<Guid, string>> NamesAsync(IEnumerable<Guid?> ids, CancellationToken ct)
    {
        var list = ids.Where(x => x != null).Select(x => x!.Value).Distinct().ToList();
        return list.Count == 0 ? [] : await db.Users.AsNoTracking().Where(u => list.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
    }

    /// <summary>
    /// A ticket is being raised (not saved yet). <paramref name="chosePriority"/>: the person gave a priority; <paramref name="hasOwner"/>:
    /// it has an assignee already (given, or picked by routing). Returns what was set at Auto ("priority High, assignee Ravi"), or null.
    /// </summary>
    public async Task<string?> OnRaisedAsync(WorkTask task, bool chosePriority, CancellationToken ct = default)
    {
        var level = await gate.LevelAsync(AiAgents.Triage, ct);
        if (level < AiAgentLevel.AskFirst) return null;
        var s = await SuggestAsync(new TriageRequest(task.Title, task.Description, task.WorkTypeId), ct);
        Priority? priority = !chosePriority && s.Priority is { } p && p > task.Priority ? p : null;
        Guid? assignee = task.AssigneeId is null && s.Assignee is { } a ? a.Id : null;
        if (priority is null && assignee is null) return null;
        var parts = new List<string>();
        if (priority is { } pr) parts.Add($"priority {pr}{(s.PriorityReason is { } why ? $" ({why})" : "")}");
        if (assignee is not null) parts.Add($"assignee {s.Assignee!.Name}{(s.AssigneeReason is { } who ? $" ({who})" : "")}");
        var key = WorkTaskService.KeyOf(task.Number);
        var target = new AiActionLog.Target("ticket", task.Id, key, null, $"/work?item={task.Id}");
        if (level == AiAgentLevel.Auto)
        {
            if (priority is { } np) task.Priority = np;
            if (assignee is { } na) task.AssigneeId = na;
            actionLog.Applied(AiAgents.Triage, "triage", target, $"Set {string.Join(" and ", parts)} on {key}", null);
            return string.Join(", ", parts);
        }
        if (await DeciderAsync(ct) is { } decider)
            actionLog.Propose(AiAgents.Triage, "triage", target, $"{key} {Text.Truncate(task.Title, 120)}: set {string.Join(" and ", parts)}?", decider, new Proposal(priority, assignee));
        return null;
    }

    /// <summary>Who decides an "Ask first" triage: the person raising the ticket when they may change tickets, else the escalation contact.</summary>
    private async Task<Guid?> DeciderAsync(CancellationToken ct)
    {
        if (ctx.UserId is { } me && await permissions.LevelAsync(Modules.Work, ct) >= AccessLevel.Edit) return me;
        return await db.OperationsSettings.AsNoTracking().Select(o => o.EscalateToUserId).FirstOrDefaultAsync(ct);
    }


    private static readonly HashSet<string> Stop = ["the", "and", "for", "with", "from", "this", "that", "are", "was", "not", "can", "cannot", "into", "our", "you", "your", "have", "has",
        "please", "need", "needs", "when", "after", "before", "about", "there", "their", "they", "will", "would", "should", "could", "any", "all", "but", "out", "get", "got", "its"];
    private static readonly string[] Critical = ["outage", "down", "production", "prod", "sev1", "p1", "breach", "data loss", "security", "all users", "everyone"];
    private static readonly string[] High = ["urgent", "asap", "blocked", "blocking", "failing", "failed", "error", "broken", "crash", "cannot", "can't", "unable", "customer", "escalat"];

    private static HashSet<string> Words(string? text) =>
        Regex.Matches((text ?? "").ToLowerInvariant(), "[a-z0-9]+").Select(m => m.Value).Where(w => w.Length >= 3 && !Stop.Contains(w)).Select(w => w.Length > 4 && w.EndsWith('s') ? w[..^1] : w).ToHashSet();

    private static double Similarity(HashSet<string> a, HashSet<string> b) => a.Count == 0 || b.Count == 0 ? 0 : (double)a.Intersect(b).Count() / a.Union(b).Count();

    /// <summary>What new work probably is: its type and priority from similar work and its wording, who usually resolves that kind of work
    /// (and has room), and open work that looks the same.</summary>
    public async Task<TriageDto> SuggestAsync(TriageRequest req, CancellationToken ct = default)
    {
        var title = (req.Title ?? "").Trim();
        if (title.Length < 3) return Nothing;
        var words = Words(title);
        var all = Words($"{title} {req.Description}");
        var since = clock.Now.AddDays(-365);
        var history = await db.WorkTasks.AsNoTracking().Where(w => w.Kind == WorkTaskKind.Operational && w.CreatedAt >= since)
            .OrderByDescending(w => w.CreatedAt).Take(1500)
            .Select(w => new { w.Id, w.Number, w.Title, w.Description, w.WorkTypeId, w.Priority, w.Status, w.AssigneeId, w.CompletedBy, w.CreatedAt, w.CompletedAt }).ToListAsync(ct);
        var scored = history.Select(h => new { h, Score = Similarity(words, Words(h.Title)) * 0.7 + Similarity(all, Words($"{h.Title} {h.Description}")) * 0.3 })
            .Where(x => x.Score > 0.12).OrderByDescending(x => x.Score).Take(25).ToList();
        var types = await db.WorkTypes.AsNoTracking().Where(t => t.IsActive).Select(t => new { t.Id, t.Name }).ToListAsync(ct);

        // Type: the most common type among similar work, else a type named in the text.
        Guid? typeId = null; string? typeReason = null;
        var byType = scored.Where(x => x.h.WorkTypeId != null).GroupBy(x => x.h.WorkTypeId!.Value).Select(g => new { g.Key, Weight = g.Sum(x => x.Score), N = g.Count() })
            .Where(g => types.Any(t => t.Id == g.Key)).OrderByDescending(g => g.Weight).FirstOrDefault();
        if (byType is not null && byType.N >= 2) { typeId = byType.Key; typeReason = $"{byType.N} similar work items were this type"; }
        else if (types.FirstOrDefault(t => Words(t.Name).Any(all.Contains)) is { } named) { typeId = named.Id; typeReason = $"the text mentions “{named.Name.ToLowerInvariant()}”"; }

        // Priority: wording first (an outage is an outage), then what similar work usually was.
        var text = $" {title} {req.Description} ".ToLowerInvariant();
        Priority? priority = null; string? priorityReason = null;
        if (Critical.FirstOrDefault(k => text.Contains($" {k}") || text.Contains($"{k} ")) is { } c) { priority = Priority.Critical; priorityReason = $"it mentions “{c}”"; }
        else if (High.FirstOrDefault(k => text.Contains(k)) is { } h) { priority = Priority.High; priorityReason = $"it mentions “{h}”"; }
        else if (scored.Count >= 3)
        {
            var common = scored.Take(10).GroupBy(x => x.h.Priority).OrderByDescending(g => g.Count()).First();
            priority = common.Key; priorityReason = $"most similar work was {common.Key.ToString().ToLowerInvariant()} priority";
        }

        // Who: whoever resolved the most similar work, preferring the one with the least open work now.
        UserRefDto? assignee = null; string? assigneeReason = null;
        var solvers = scored.Where(x => x.h.Status == WorkTaskStatus.Completed && (x.h.AssigneeId ?? x.h.CompletedBy) != null)
            .GroupBy(x => (x.h.AssigneeId ?? x.h.CompletedBy)!.Value).Select(g => new { User = g.Key, N = g.Count(), Weight = g.Sum(x => x.Score) }).ToList();
        if (solvers.Count > 0)
        {
            var tid = ctx.RequireTenantId();
            var ids = solvers.Select(s => s.User).ToList();
            var eligible = await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid && ids.Contains(m.UserId) && m.Role != TenantRole.Guest && m.User!.IsActive).Select(m => m.UserId).ToListAsync(ct);
            var open = new[] { WorkTaskStatus.ToDo, WorkTaskStatus.InProgress, WorkTaskStatus.OnHold };
            var load = await db.WorkTasks.AsNoTracking().Where(w => w.Kind == WorkTaskKind.Operational && w.AssigneeId != null && eligible.Contains(w.AssigneeId.Value) && open.Contains(w.Status))
                .GroupBy(w => w.AssigneeId!.Value).Select(g => new { g.Key, N = g.Count() }).ToDictionaryAsync(x => x.Key, x => x.N, ct);
            var pick = solvers.Where(s => eligible.Contains(s.User)).OrderByDescending(s => s.Weight - load.GetValueOrDefault(s.User) * 0.08).FirstOrDefault();
            if (pick is not null)
            {
                var name = await db.Users.AsNoTracking().Where(u => u.Id == pick.User).Select(u => u.DisplayName).FirstAsync(ct);
                assignee = new UserRefDto(pick.User, name);
                var n = load.GetValueOrDefault(pick.User);
                assigneeReason = $"resolved {pick.N} similar item{(pick.N == 1 ? "" : "s")} · {n} open now";
            }
        }

        // Duplicates: open work that reads the same.
        var openStatuses = new[] { WorkTaskStatus.ToDo, WorkTaskStatus.InProgress, WorkTaskStatus.OnHold };
        var dupes = scored.Where(x => openStatuses.Contains(x.h.Status) && x.Score >= 0.4).Take(3).ToList();
        var names = await NamesAsync(dupes.Select(d => d.h.AssigneeId), ct);
        var duplicates = dupes.Select(d => new TriageDuplicateDto(d.h.Id, WorkTaskService.KeyOf(d.h.Number), d.h.Title, d.h.Status,
            d.h.AssigneeId is { } a && names.TryGetValue(a, out var n) ? new UserRefDto(a, n) : null, (int)Math.Round(d.Score * 100))).ToList();

        // Whether a routing rule would assign it anyway.
        var routeType = req.WorkTypeId ?? typeId;
        var rules = await db.WorkRoutingRules.AsNoTracking().Where(r => r.Enabled && (r.WorkTypeId == routeType || r.WorkTypeId == null)).ToListAsync(ct);
        var rule = rules.FirstOrDefault(r => r.WorkTypeId != null && r.WorkTypeId == routeType) ?? rules.FirstOrDefault(r => r.WorkTypeId == null);
        var routed = rule is null ? null : rule.Mode == "least_loaded" ? "to whoever on the rota has the least open work" : "to the next person on the rota";
        return new TriageDto(typeId, typeId is { } id ? types.First(t => t.Id == id).Name : null, typeReason, priority, priorityReason, assignee, assigneeReason, duplicates, routed);
    }

}
