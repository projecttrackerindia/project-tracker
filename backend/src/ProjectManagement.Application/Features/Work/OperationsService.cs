using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Work;

public record RoutingRuleDto(Guid Id, Guid? WorkTypeId, string? WorkType, string Mode, IReadOnlyList<UserRefDto> Members, UserRefDto? EscalateTo, bool Enabled, UserRefDto? LastAssigned);
/// <summary><see cref="WorkDays"/>: 1 = Monday ... 7 = Sunday.</summary>
public record OperationsSettingsDto(bool CanManage, bool BusinessHoursOnly, int DayStartMinutes, int DayEndMinutes, IReadOnlyList<int> WorkDays, string TimeZone,
    bool EscalateOnBreach, UserRefDto? EscalateTo, IReadOnlyList<RoutingRuleDto> Rules);
public record SaveOperationsSettingsRequest(bool BusinessHoursOnly, int DayStartMinutes, int DayEndMinutes, IReadOnlyList<int>? WorkDays, string? TimeZone, bool EscalateOnBreach, Guid? EscalateToUserId);
public record SaveRoutingRuleRequest(Guid? WorkTypeId, string? Mode, IReadOnlyList<Guid>? MemberIds, Guid? EscalateToUserId, bool Enabled = true);

public record TriageRequest(string? Title, string? Description, Guid? WorkTypeId = null);
public record TriageDuplicateDto(Guid Id, string Key, string Title, WorkTaskStatus Status, UserRefDto? Assignee, int Score);
/// <summary>Suggestions for new operational work, each with the reason behind it; <see cref="Routed"/>: a routing rule will assign it if nobody is chosen.</summary>
public record TriageDto(Guid? WorkTypeId, string? WorkType, string? TypeReason, Priority? Priority, string? PriorityReason, UserRefDto? Assignee, string? AssigneeReason,
    IReadOnlyList<TriageDuplicateDto> Duplicates, string? Routed);

public record BulkWorkRequest(IReadOnlyList<Guid>? Ids, WorkTaskStatus? Status = null, Guid? AssigneeId = null, bool Unassign = false, Priority? Priority = null,
    DateOnly? DueDate = null, bool ClearDueDate = false);
public record BulkWorkFailureDto(Guid Id, string Message);
public record BulkWorkResultDto(int Updated, IReadOnlyList<BulkWorkFailureDto> Failed);

public record OpsWeekDto(DateOnly WeekStart, int Created, int Completed, int Breached, decimal? Compliance);
public record OpsBreakdownDto(string Name, Guid? Id, int Open, int Completed, int Breached, decimal? Compliance, decimal? MedianResolutionHours);
public record OpsAgingDto(string Label, int Count);
public record OperationsInsightsDto(int Days, int Open, int Unassigned, int Breached, int AtRisk, decimal? Compliance, decimal? MedianResolutionHours, decimal? MedianResponseMinutes,
    int CreatedInPeriod, int CompletedInPeriod, IReadOnlyList<OpsWeekDto> Weeks, IReadOnlyList<OpsAgingDto> Aging, IReadOnlyList<OpsBreakdownDto> ByType,
    IReadOnlyList<OpsBreakdownDto> ByPriority, IReadOnlyList<OpsBreakdownDto> ByPerson, bool BusinessHours, OpsSatisfactionDto? Satisfaction = null);

/// <summary>How customers rated WhatsApp support (1-5 after a chat or its ticket closed), and how often the AI employee answered on its own.</summary>
public record OpsSatisfactionDto(int Asked, int Rated, decimal? Average, decimal? Satisfied, IReadOnlyList<int> Distribution, IReadOnlyList<OpsRatingWeekDto> Weeks,
    IReadOnlyList<OpsRatingPersonDto> ByPerson, IReadOnlyList<OpsLowRatingDto> Low, int Chats, int AiOnly, int HandedOver, IReadOnlyList<OpsCountDto> HandoverReasons);
public record OpsRatingWeekDto(DateOnly WeekStart, int Rated, decimal? Average);
public record OpsRatingPersonDto(string Name, Guid? Id, int Rated, decimal? Average);
public record OpsLowRatingDto(Guid ChatId, string Contact, int Rating, DateTime At, string? TicketKey, string? With);
public record OpsCountDto(string Label, int Count);

/// <summary>
/// Routing for new operational work: picks the assignee from the rule for its work type (or the catch-all rule), taking turns or choosing
/// whoever has the least open work. Only active members who are not guests are ever picked.
/// </summary>
public class WorkRouting(IAppDbContext db, ICurrentContext ctx)
{
    public static readonly string[] Modes = ["round_robin", "least_loaded"];

    public static List<Guid> Members(string json)
    {
        try { return JsonSerializer.Deserialize<List<Guid>>(json) ?? []; } catch (JsonException) { return []; }
    }

    /// <summary>The person new work of this type goes to, and how they were chosen; null when no rule applies or nobody is available.</summary>
    public async Task<(Guid UserId, string Mode)?> PickAsync(Guid? workTypeId, CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        var rules = await db.WorkRoutingRules.Where(r => r.Enabled && (r.WorkTypeId == workTypeId || r.WorkTypeId == null)).ToListAsync(ct);
        var rule = (workTypeId is null ? null : rules.FirstOrDefault(r => r.WorkTypeId == workTypeId)) ?? rules.FirstOrDefault(r => r.WorkTypeId == null);
        if (rule is null) return null;
        var order = Members(rule.MemberIds);
        if (order.Count == 0) return null;
        var active = await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid && order.Contains(m.UserId) && m.Role != TenantRole.Guest && m.User!.IsActive)
            .Select(m => m.UserId).ToListAsync(ct);
        var people = order.Where(active.Contains).ToList();
        if (people.Count == 0) return null;
        // Turn order starts after whoever had the last one.
        var start = rule.LastAssignedUserId is { } last && people.IndexOf(last) is var at && at >= 0 ? at + 1 : 0;
        var turn = Enumerable.Range(0, people.Count).Select(i => people[(start + i) % people.Count]).ToList();
        Guid chosen;
        if (rule.Mode == "least_loaded")
        {
            var open = new[] { WorkTaskStatus.ToDo, WorkTaskStatus.InProgress, WorkTaskStatus.OnHold };
            var load = await db.WorkTasks.AsNoTracking().Where(w => w.Kind == WorkTaskKind.Operational && w.AssigneeId != null && people.Contains(w.AssigneeId.Value) && open.Contains(w.Status))
                .GroupBy(w => w.AssigneeId!.Value).Select(g => new { g.Key, N = g.Count() }).ToDictionaryAsync(x => x.Key, x => x.N, ct);
            chosen = turn.OrderBy(p => load.GetValueOrDefault(p)).First();   // ties keep turn order (a stable sort)
        }
        else chosen = turn[0];
        rule.LastAssignedUserId = chosen;
        return (chosen, rule.Mode);
    }
}

/// <summary>
/// Operations as a tool: business hours and escalation, routing rules, smart triage of new work (type, priority, who usually handles it,
/// and likely duplicates - from the workspace's own history, no AI involved), changes to many work tasks at once, and service-level
/// analytics for the Operations page.
/// </summary>
public class OperationsService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, PermissionService permissions, WorkTaskService work, SlaService sla)
{
    private const int MaxBulk = 200;

    // ------------------------------------------------------------------ settings and routing

    private async Task<Dictionary<Guid, string>> NamesAsync(IEnumerable<Guid?> ids, CancellationToken ct)
    {
        var list = ids.Where(x => x != null).Select(x => x!.Value).Distinct().ToList();
        return list.Count == 0 ? [] : await db.Users.AsNoTracking().Where(u => list.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
    }

    public async Task<OperationsSettingsDto> GetSettingsAsync(CancellationToken ct = default)
    {
        await permissions.RequireModuleAsync(Modules.Work, AccessLevel.View, ct);
        var s = await db.OperationsSettings.AsNoTracking().FirstOrDefaultAsync(ct);
        var rules = await db.WorkRoutingRules.AsNoTracking().ToListAsync(ct);
        var types = await db.WorkTypes.AsNoTracking().ToDictionaryAsync(t => t.Id, t => t.Name, ct);
        var names = await NamesAsync(rules.SelectMany(r => WorkRouting.Members(r.MemberIds).Select(m => (Guid?)m)).Concat(rules.Select(r => r.EscalateToUserId))
            .Concat(rules.Select(r => r.LastAssignedUserId)).Append(s?.EscalateToUserId), ct);
        UserRefDto? Ref(Guid? id) => id is { } u && names.TryGetValue(u, out var n) ? new UserRefDto(u, n) : null;
        var days = Enumerable.Range(1, 7).Where(d => ((s?.WorkDays ?? 31) & (1 << (d - 1))) != 0).ToList();
        return new OperationsSettingsDto(await permissions.HasAsync(Permissions.WorkTypesManage, ct), s?.BusinessHoursOnly ?? false, s?.DayStartMinutes ?? 9 * 60,
            s?.DayEndMinutes ?? 18 * 60, days, s?.TimeZone ?? clock.ZoneId, s?.EscalateOnBreach ?? false, Ref(s?.EscalateToUserId),
            rules.OrderBy(r => r.WorkTypeId is null ? "" : types.GetValueOrDefault(r.WorkTypeId.Value) ?? "~").Select(r => new RoutingRuleDto(r.Id, r.WorkTypeId,
                r.WorkTypeId is { } t ? types.GetValueOrDefault(t) : null, r.Mode, WorkRouting.Members(r.MemberIds).Select(m => Ref(m)).Where(x => x is not null).Select(x => x!).ToList(),
                Ref(r.EscalateToUserId), r.Enabled, Ref(r.LastAssignedUserId))).ToList());
    }

    private async Task CheckPersonAsync(Guid? userId, string field, CancellationToken ct)
    {
        if (userId is not { } u) return;
        var tid = ctx.RequireTenantId();
        if (!await db.TenantMembers.AnyAsync(m => m.TenantId == tid && m.UserId == u && m.Role != TenantRole.Guest, ct))
            throw new ValidationException(field, "Choose a member of this workspace (not a guest).");
    }

    public async Task<OperationsSettingsDto> SaveSettingsAsync(SaveOperationsSettingsRequest req, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.WorkTypesManage, ct);
        if (req.DayStartMinutes is < 0 or >= 24 * 60 || req.DayEndMinutes is <= 0 or > 24 * 60 || req.DayEndMinutes - req.DayStartMinutes < 60)
            throw new ValidationException("dayEndMinutes", "The working day must be at least an hour, within one day.");
        var days = (req.WorkDays ?? []).Distinct().ToList();
        if (days.Count == 0 || days.Any(d => d is < 1 or > 7)) throw new ValidationException("workDays", "Choose at least one working day.");
        if (req.TimeZone is { Length: > 0 } z && !ZoneTime.IsKnown(z)) throw new ValidationException("timeZone", "That time zone is not known.");
        if (req.EscalateOnBreach && req.EscalateToUserId is null) throw new ValidationException("escalateToUserId", "Choose who hears about missed targets.");
        await CheckPersonAsync(req.EscalateToUserId, "escalateToUserId", ct);
        var tid = ctx.RequireTenantId();
        var s = await db.OperationsSettings.FirstOrDefaultAsync(ct);
        if (s is null) { s = new OperationsSettings { TenantId = tid, CreatedAt = clock.Now, CreatedBy = ctx.UserId }; db.OperationsSettings.Add(s); }
        var before = new { s.BusinessHoursOnly, s.DayStartMinutes, s.DayEndMinutes, s.WorkDays, s.TimeZone, s.EscalateOnBreach, s.EscalateToUserId };
        s.BusinessHoursOnly = req.BusinessHoursOnly; s.DayStartMinutes = req.DayStartMinutes; s.DayEndMinutes = req.DayEndMinutes;
        s.WorkDays = days.Aggregate(0, (bits, d) => bits | (1 << (d - 1)));
        s.TimeZone = string.IsNullOrWhiteSpace(req.TimeZone) ? clock.ZoneId : req.TimeZone.Trim();
        s.EscalateOnBreach = req.EscalateOnBreach; s.EscalateToUserId = req.EscalateToUserId;
        s.UpdatedAt = clock.Now; s.UpdatedBy = ctx.UserId;
        recorder.Audit("operations.settings", "OperationsSettings", s.Id, before, new { s.BusinessHoursOnly, s.DayStartMinutes, s.DayEndMinutes, s.WorkDays, s.TimeZone, s.EscalateOnBreach, s.EscalateToUserId });
        await db.SaveChangesAsync(ct);
        sla.ResetCalendar();
        return await GetSettingsAsync(ct);
    }

    public async Task<OperationsSettingsDto> SaveRuleAsync(Guid? id, SaveRoutingRuleRequest req, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.WorkTypesManage, ct);
        var mode = (req.Mode ?? "round_robin").Trim().ToLowerInvariant();
        if (!WorkRouting.Modes.Contains(mode)) throw new ValidationException("mode", "Choose taking turns or least open work.");
        var members = (req.MemberIds ?? []).Distinct().ToList();
        if (members.Count is 0 or > 50) throw new ValidationException("memberIds", "Choose one to fifty people to share the work.");
        var tid = ctx.RequireTenantId();
        var ok = await db.TenantMembers.Where(m => m.TenantId == tid && members.Contains(m.UserId) && m.Role != TenantRole.Guest).CountAsync(ct);
        if (ok != members.Count) throw new ValidationException("memberIds", "Everyone must be a member of this workspace (not a guest).");
        await CheckPersonAsync(req.EscalateToUserId, "escalateToUserId", ct);
        if (req.WorkTypeId is { } wt && !await db.WorkTypes.AnyAsync(t => t.Id == wt, ct)) throw new ValidationException("workTypeId", "That work type was not found.");

        var rule = id is { } rid ? await db.WorkRoutingRules.FirstOrDefaultAsync(r => r.Id == rid, ct) ?? throw new NotFoundException("Routing rule not found.") : null;
        if (await db.WorkRoutingRules.AnyAsync(r => r.WorkTypeId == req.WorkTypeId && (rule == null || r.Id != rule.Id), ct))
            throw new ConflictException(req.WorkTypeId is null ? "There is already a rule for all other work types." : "That work type already has a rule.", "ROUTING_RULE_EXISTS");
        if (rule is null) { rule = new WorkRoutingRule { TenantId = tid, CreatedAt = clock.Now, CreatedBy = ctx.UserId }; db.WorkRoutingRules.Add(rule); }
        rule.WorkTypeId = req.WorkTypeId; rule.Mode = mode; rule.MemberIds = JsonSerializer.Serialize(members); rule.EscalateToUserId = req.EscalateToUserId; rule.Enabled = req.Enabled;
        if (rule.LastAssignedUserId is { } last && !members.Contains(last)) rule.LastAssignedUserId = null;
        rule.UpdatedAt = clock.Now; rule.UpdatedBy = ctx.UserId;
        recorder.Audit("operations.routing", "WorkRoutingRule", rule.Id, null, new { rule.WorkTypeId, rule.Mode, members = members.Count, rule.Enabled });
        await db.SaveChangesAsync(ct);
        return await GetSettingsAsync(ct);
    }

    public async Task<OperationsSettingsDto> DeleteRuleAsync(Guid id, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.WorkTypesManage, ct);
        var rule = await db.WorkRoutingRules.FirstOrDefaultAsync(r => r.Id == id, ct) ?? throw new NotFoundException("Routing rule not found.");
        db.WorkRoutingRules.Remove(rule);
        recorder.Audit("operations.routing_removed", "WorkRoutingRule", id);
        await db.SaveChangesAsync(ct);
        return await GetSettingsAsync(ct);
    }

    // ------------------------------------------------------------------ smart triage

    private static readonly HashSet<string> Stop = ["the", "and", "for", "with", "from", "this", "that", "are", "was", "not", "can", "cannot", "into", "our", "you", "your", "have", "has",
        "please", "need", "needs", "when", "after", "before", "about", "there", "their", "they", "will", "would", "should", "could", "any", "all", "but", "out", "get", "got", "its"];
    private static readonly string[] Critical = ["outage", "down", "production", "prod", "sev1", "p1", "breach", "data loss", "security", "all users", "everyone"];
    private static readonly string[] High = ["urgent", "asap", "blocked", "blocking", "failing", "failed", "error", "broken", "crash", "cannot", "can't", "unable", "customer", "escalat"];

    private static HashSet<string> Words(string? text) =>
        Regex.Matches((text ?? "").ToLowerInvariant(), "[a-z0-9]+").Select(m => m.Value).Where(w => w.Length >= 3 && !Stop.Contains(w)).Select(w => w.Length > 4 && w.EndsWith('s') ? w[..^1] : w).ToHashSet();

    private static double Similarity(HashSet<string> a, HashSet<string> b) => a.Count == 0 || b.Count == 0 ? 0 : (double)a.Intersect(b).Count() / a.Union(b).Count();

    /// <summary>What new work probably is: its type and priority from similar work and its wording, who usually resolves that kind of work
    /// (and has room), and open work that looks the same.</summary>
    public async Task<TriageDto> TriageAsync(TriageRequest req, CancellationToken ct = default)
    {
        await permissions.RequireModuleAsync(Modules.Work, AccessLevel.View, ct);
        var title = (req.Title ?? "").Trim();
        if (title.Length < 3) return new TriageDto(null, null, null, null, null, null, null, [], null);
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

    // ------------------------------------------------------------------ many at once

    /// <summary>Changes many work tasks at once - status, assignee, priority, due date - through the same rules as changing one: each is
    /// checked on its own, and the ones the caller cannot change are reported back.</summary>
    public async Task<BulkWorkResultDto> BulkAsync(BulkWorkRequest req, CancellationToken ct = default)
    {
        var ids = (req.Ids ?? []).Distinct().ToList();
        if (ids.Count == 0) throw new ValidationException("ids", "Choose the work to change.");
        if (ids.Count > MaxBulk) throw new ValidationException("ids", $"Change at most {MaxBulk} at once.");
        var fields = req.Priority is not null || req.AssigneeId is not null || req.Unassign || req.DueDate is not null || req.ClearDueDate;
        if (!fields && req.Status is null) throw new ValidationException("ids", "Choose what to change.");
        var updated = 0;
        var failed = new List<BulkWorkFailureDto>();
        foreach (var id in ids)
        {
            try
            {
                var t = await work.GetAsync(id, ct);
                if (!t.Can.Edit) throw new ForbiddenException("You can only change work that is assigned to you or that you raised.", "PERMISSION_DENIED");
                if (!fields) await work.SetStatusAsync(id, new SetWorkTaskStatusRequest(req.Status!.Value), ct);
                else await work.UpdateAsync(id, new UpdateWorkTaskRequest(t.Title, t.Description, t.WorkTypeId, t.RelatedProject?.Id,
                    req.Unassign ? null : req.AssigneeId ?? t.Assignee?.Id, req.Priority ?? t.Priority, req.Status ?? t.Status, t.StartDate,
                    req.ClearDueDate ? null : req.DueDate ?? t.DueDate, t.Version), ct);
                updated++;
            }
            catch (AppException ex) { failed.Add(new BulkWorkFailureDto(id, ex.Message)); }
        }
        return new BulkWorkResultDto(updated, failed);
    }

    // ------------------------------------------------------------------ analytics

    private static decimal? Median(IEnumerable<double> values)
    {
        var v = values.OrderBy(x => x).ToList();
        if (v.Count == 0) return null;
        var m = v.Count % 2 == 1 ? v[v.Count / 2] : (v[v.Count / 2 - 1] + v[v.Count / 2]) / 2;
        return Math.Round((decimal)m, 1);
    }

    private sealed class OpsRow
    {
        public Guid Id { get; init; }
        public Guid? WorkTypeId { get; init; }
        public Priority Priority { get; init; }
        public WorkTaskStatus Status { get; init; }
        public Guid? AssigneeId { get; init; }
        public DateTime CreatedAt { get; init; }
        public DateTime? CompletedAt { get; init; }
        public DateTime? RespondedAt { get; init; }
        public DateTime? ResolutionDueAt { get; init; }
        public DateTime? ResolutionRiskAt { get; init; }
        public DateTime? SlaPausedAt { get; init; }
    }

    /// <summary>Service levels and flow for operational work over the last <paramref name="days"/> days: compliance, resolution and first
    /// response times, created against completed per week, the age of what is open, and the same by type, priority and person.</summary>
    public async Task<OperationsInsightsDto> InsightsAsync(int days, CancellationToken ct = default)
    {
        await permissions.RequireModuleAsync(Modules.Work, AccessLevel.View, ct);
        days = Math.Clamp(days, 14, 180);
        var now = clock.Now;
        var from = now.AddDays(-days);
        var openStatuses = new[] { WorkTaskStatus.ToDo, WorkTaskStatus.InProgress, WorkTaskStatus.OnHold };
        var rows = await db.WorkTasks.AsNoTracking()
            .Where(w => w.Kind == WorkTaskKind.Operational && (w.CreatedAt >= from || openStatuses.Contains(w.Status) || (w.CompletedAt != null && w.CompletedAt >= from)))
            .OrderByDescending(w => w.CreatedAt).Take(6000)
            .Select(w => new OpsRow { Id = w.Id, WorkTypeId = w.WorkTypeId, Priority = w.Priority, Status = w.Status, AssigneeId = w.AssigneeId, CreatedAt = w.CreatedAt,
                CompletedAt = w.CompletedAt, RespondedAt = w.RespondedAt, ResolutionDueAt = w.ResolutionDueAt, ResolutionRiskAt = w.ResolutionRiskAt, SlaPausedAt = w.SlaPausedAt })
            .ToListAsync(ct);
        var types = await db.WorkTypes.AsNoTracking().ToDictionaryAsync(t => t.Id, t => t.Name, ct);
        var names = await NamesAsync(rows.Select(r => r.AssigneeId), ct);
        var business = await sla.CalendarAsync(ct) is not null;

        bool IsOpen(OpsRow r) => openStatuses.Contains(r.Status);
        bool Closed(OpsRow r) => r.Status == WorkTaskStatus.Completed && r.CompletedAt >= from;
        bool Met(OpsRow r) => r.ResolutionDueAt is { } d && r.CompletedAt is { } c && c <= d;
        bool Breached(OpsRow r) => r.ResolutionDueAt is { } d && IsOpen(r) && d < (r.SlaPausedAt ?? now);
        static decimal? Compliance(int met, int total) => total == 0 ? null : Math.Round((decimal)met / total, 4);
        decimal? Hours(IEnumerable<OpsRow> closed) => Median(closed.Select(r => (r.CompletedAt!.Value - r.CreatedAt).TotalHours));

        var weeks = new List<OpsWeekDto>();
        var firstWeek = ProjectManagement.Application.Features.Time.TimesheetApprovalService.WeekOf(DateOnly.FromDateTime(from));
        for (var w = firstWeek; w <= DateOnly.FromDateTime(now); w = w.AddDays(7))
        {
            var a = w.ToDateTime(TimeOnly.MinValue, DateTimeKind.Utc); var b = a.AddDays(7);
            var done = rows.Where(r => r.Status == WorkTaskStatus.Completed && r.CompletedAt >= a && r.CompletedAt < b).ToList();
            var tracked = done.Where(r => r.ResolutionDueAt != null).ToList();
            var dueHere = rows.Where(r => r.ResolutionDueAt >= a && r.ResolutionDueAt < b && r.ResolutionDueAt <= now && r.Status != WorkTaskStatus.Cancelled).ToList();
            weeks.Add(new OpsWeekDto(w, rows.Count(r => r.CreatedAt >= a && r.CreatedAt < b), done.Count,
                dueHere.Count(r => r.CompletedAt is { } c ? c > r.ResolutionDueAt : IsOpen(r)), Compliance(tracked.Count(Met), tracked.Count)));
        }

        var open = rows.Where(IsOpen).ToList();
        var aging = new[] { ("Under 2 days", 0, 2), ("2–7 days", 2, 7), ("1–4 weeks", 7, 28), ("Over 4 weeks", 28, 100000) }
            .Select(b => new OpsAgingDto(b.Item1, open.Count(r => (now - r.CreatedAt).TotalDays >= b.Item2 && (now - r.CreatedAt).TotalDays < b.Item3))).ToList();

        OpsBreakdownDto Breakdown(string name, Guid? id, IReadOnlyList<OpsRow> g)
        {
            var closed = g.Where(Closed).ToList();
            var tracked = closed.Where(r => r.ResolutionDueAt != null).ToList();
            return new OpsBreakdownDto(name, id, g.Count(IsOpen), closed.Count, g.Count(Breached), Compliance(tracked.Count(Met), tracked.Count), Hours(closed));
        }
        var byType = rows.GroupBy(r => r.WorkTypeId).Select(g => Breakdown(g.Key is { } t ? types.GetValueOrDefault(t) ?? "Other" : "Other", g.Key, g.ToList()))
            .OrderByDescending(b => b.Open + b.Completed).Take(12).ToList();
        var byPriority = new[] { Priority.Critical, Priority.High, Priority.Medium, Priority.Low }
            .Select(p => Breakdown(p.ToString(), null, rows.Where(r => r.Priority == p).ToList())).ToList();
        var byPerson = rows.GroupBy(r => r.AssigneeId).Select(g => Breakdown(g.Key is { } u ? names.GetValueOrDefault(u) ?? "Former member" : "Unassigned", g.Key, g.ToList()))
            .OrderByDescending(b => b.Open).ThenByDescending(b => b.Completed).Take(15).ToList();

        var closedInPeriod = rows.Where(Closed).ToList();
        var measured = closedInPeriod.Where(r => r.ResolutionDueAt != null).ToList();
        var responded = rows.Where(r => r.RespondedAt is { } x && x >= from).Select(r => Math.Max(0, (r.RespondedAt!.Value - r.CreatedAt).TotalMinutes));
        return new OperationsInsightsDto(days, open.Count, open.Count(r => r.AssigneeId == null), open.Count(Breached),
            open.Count(r => r.SlaPausedAt == null && r.ResolutionRiskAt <= now && r.ResolutionDueAt > now),
            Compliance(measured.Count(Met), measured.Count), Hours(closedInPeriod), Median(responded),
            rows.Count(r => r.CreatedAt >= from), closedInPeriod.Count, weeks, aging, byType, byPriority, byPerson, business, await SatisfactionAsync(from, firstWeek, now, ct));
    }

    /// <summary>Ratings in the period: average, share of 4s and 5s, the spread, by week and by the person who had the chat, the latest low ones, and AI handovers.</summary>
    private async Task<OpsSatisfactionDto?> SatisfactionAsync(DateTime from, DateOnly firstWeek, DateTime now, CancellationToken ct)
    {
        var chats = await db.SupportConversations.AsNoTracking().Where(c => c.CreatedAt >= from || c.LastMessageAt >= from)
            .Select(c => new { c.Id, c.ContactName, c.Rating, c.RatedAt, c.RatingAskedAt, c.AssigneeId, c.WorkTaskId, c.HandedOverAt, c.HandoverReason }).Take(20000).ToListAsync(ct);
        if (chats.Count == 0) return null;
        var rated = chats.Where(c => c.Rating is >= 1 and <= 5 && (c.RatedAt ?? c.RatingAskedAt) >= from).ToList();
        decimal? Avg(IEnumerable<int> xs) { var l = xs.ToList(); return l.Count == 0 ? null : Math.Round((decimal)l.Average(), 2); }
        var weeks = new List<OpsRatingWeekDto>();
        for (var w = firstWeek; w <= DateOnly.FromDateTime(now); w = w.AddDays(7))
        {
            var a = w.ToDateTime(TimeOnly.MinValue, DateTimeKind.Utc); var b = a.AddDays(7);
            var inWeek = rated.Where(c => (c.RatedAt ?? c.RatingAskedAt) >= a && (c.RatedAt ?? c.RatingAskedAt) < b).Select(c => c.Rating!.Value).ToList();
            weeks.Add(new OpsRatingWeekDto(w, inWeek.Count, Avg(inWeek)));
        }
        var names = await NamesAsync(rated.Select(c => c.AssigneeId).Concat(chats.Select(c => c.AssigneeId)), ct);
        var byPerson = rated.GroupBy(c => c.AssigneeId).Select(g => new OpsRatingPersonDto(g.Key is { } u ? names.GetValueOrDefault(u) ?? "Former member" : "AI employee", g.Key, g.Count(), Avg(g.Select(c => c.Rating!.Value))))
            .OrderByDescending(p => p.Rated).Take(12).ToList();
        var ticketIds = rated.Where(c => c.Rating <= 2 && c.WorkTaskId != null).Select(c => c.WorkTaskId!.Value).ToList();
        var keys = await db.WorkTasks.AsNoTracking().Where(t => ticketIds.Contains(t.Id)).ToDictionaryAsync(t => t.Id, t => ProjectManagement.Application.Features.WorkItems.WorkItemService.KeyOf(t.Kind, t.Number), ct);
        var low = rated.Where(c => c.Rating <= 2).OrderByDescending(c => c.RatedAt ?? c.RatingAskedAt).Take(8)
            .Select(c => new OpsLowRatingDto(c.Id, c.ContactName ?? "Customer", c.Rating!.Value, (c.RatedAt ?? c.RatingAskedAt)!.Value, c.WorkTaskId is { } t ? keys.GetValueOrDefault(t) : null,
                c.AssigneeId is { } u ? names.GetValueOrDefault(u) : null)).ToList();
        var handed = chats.Where(c => c.HandedOverAt >= from).ToList();
        var reasons = new[] { ("asked", "Customer asked for a person"), ("unsure", "Not in the documents"), ("upset", "Customer upset"), ("rule", "A connected system's rule"), ("off", "AI switched off") }
            .Select(r => new OpsCountDto(r.Item2, handed.Count(c => c.HandoverReason == r.Item1))).Where(r => r.Count > 0).ToList();
        return new OpsSatisfactionDto(chats.Count(c => c.RatingAskedAt >= from), rated.Count, Avg(rated.Select(c => c.Rating!.Value)),
            rated.Count == 0 ? null : Math.Round((decimal)rated.Count(c => c.Rating >= 4) / rated.Count, 4),
            [.. Enumerable.Range(1, 5).Select(n => rated.Count(c => c.Rating == n))], weeks, byPerson, low,
            chats.Count, chats.Count(c => c.HandedOverAt == null && c.AssigneeId == null), handed.Count, reasons);
    }
}
