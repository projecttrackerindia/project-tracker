using System.Text.RegularExpressions;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Desk;

/// <summary>An engineer the router may offer a ticket to, with what they are doing now.</summary>
public record DeskCandidate(Guid UserId, string Name, string Status, IReadOnlyCollection<string> Skills, string Department, int Active, int MaxActive,
    int? ShiftStartMinutes, int? ShiftEndMinutes, bool OnCall);

/// <summary>What the router needs about a ticket. <paramref name="NowMinutes"/>: minutes since midnight in the workspace's zone.</summary>
public record DeskRouteRequest(Priority Priority, string Department, IReadOnlyCollection<string> Skills, int NowMinutes, IReadOnlyCollection<Guid> Exclude);

/// <summary>An engineer the router would pick, best first, with the score (0-100) and the reasons in plain words.</summary>
public record DeskRanked(Guid UserId, string Name, int Score, string Reason);

/// <summary>What happens to an assignment nobody accepted in time.</summary>
public enum DeskEscalationStep { None, Reassign, Supervisor }

/// <summary>
/// The Desk's decisions that need no database: who to route a ticket to, when to escalate, how long to wait before retrying an inbound
/// message. Kept pure so they are tested directly.
/// </summary>
public static class DeskRules
{
    public static readonly string[] Statuses = ["available", "busy", "away", "offline"];
    public const int MaxAttempts = 5;

    /// <summary>
    /// Ranks engineers for a ticket. Only people who are available, not on a call, inside their shift and under their ticket cap qualify; a
    /// Critical ticket may also go to someone busy when nobody is available. People in the ticket's department come first when there are any.
    /// Score: skills matched (40), room left under the cap (40), same department (20).
    /// </summary>
    public static IReadOnlyList<DeskRanked> Rank(DeskRouteRequest req, IEnumerable<DeskCandidate> engineers)
    {
        var all = engineers.Where(e => !req.Exclude.Contains(e.UserId) && !e.OnCall && e.Active < Math.Max(1, e.MaxActive) && InShift(e, req.NowMinutes)).ToList();
        var pool = all.Where(e => e.Status == "available").ToList();
        if (pool.Count == 0 && req.Priority == Priority.Critical) pool = all.Where(e => e.Status == "busy").ToList();
        var dept = req.Department.Trim();
        var sameDept = dept.Length == 0 ? new List<DeskCandidate>() : pool.Where(e => string.Equals(e.Department.Trim(), dept, StringComparison.OrdinalIgnoreCase)).ToList();
        if (sameDept.Count > 0) pool = sameDept;
        var wanted = req.Skills.Select(Norm).Where(s => s.Length > 0).ToHashSet();
        return pool.Select(e =>
        {
            var have = e.Skills.Select(Norm).ToHashSet();
            var matched = wanted.Count(have.Contains);
            var skillScore = wanted.Count == 0 ? 20 : 40 * matched / wanted.Count;
            var cap = Math.Max(1, e.MaxActive);
            var roomScore = 40 * (cap - e.Active) / cap;
            var deptScore = sameDept.Count > 0 ? 20 : 0;
            var reasons = new List<string>();
            if (wanted.Count > 0) reasons.Add(matched == 0 ? "no matching skills" : $"skills {string.Join(", ", wanted.Where(have.Contains))}");
            reasons.Add($"{e.Active} of {cap} tickets");
            if (deptScore > 0) reasons.Add(e.Department.Trim());
            if (e.Status == "busy") reasons.Add("busy, but the ticket is critical");
            return new DeskRanked(e.UserId, e.Name, Math.Clamp(skillScore + roomScore + deptScore, 0, 100), string.Join(" · ", reasons));
        }).OrderByDescending(r => r.Score).ThenBy(r => pool.First(p => p.UserId == r.UserId).Active).ThenBy(r => r.Name, StringComparer.OrdinalIgnoreCase).ToList();
    }

    /// <summary>Inside the engineer's shift (minutes from midnight; a shift may run past midnight). No shift set: any time.</summary>
    public static bool InShift(DeskCandidate e, int nowMinutes)
    {
        if (e.ShiftStartMinutes is not { } start || e.ShiftEndMinutes is not { } end || start == end) return true;
        return start < end ? nowMinutes >= start && nowMinutes < end : nowMinutes >= start || nowMinutes < end;
    }

    /// <summary>
    /// An offer nobody accepted: within the window nothing happens; after it the ticket moves to the next engineer until it has moved
    /// <paramref name="maxReassignments"/> times, then the supervisor is told once.
    /// </summary>
    public static DeskEscalationStep Escalation(DateTime now, DateTime? acceptDueAt, DateTime? acceptedAt, int reassignments, int maxReassignments, DateTime? escalatedAt)
    {
        if (acceptedAt is not null || acceptDueAt is not { } due || now < due) return DeskEscalationStep.None;
        if (reassignments < Math.Max(0, maxReassignments)) return DeskEscalationStep.Reassign;
        return escalatedAt is null ? DeskEscalationStep.Supervisor : DeskEscalationStep.None;
    }

    /// <summary>When a failed inbound message is tried again: 30 s, 1, 2, 4, 8 minutes; null after the last try (it goes to the dead letters).</summary>
    public static DateTime? NextAttempt(int attempts, DateTime now) =>
        attempts >= MaxAttempts ? null : now.AddSeconds(30 * Math.Pow(2, Math.Max(0, attempts - 1)));

    /// <summary>An AI decision is applied only at or above the threshold (0-100); below it a person decides.</summary>
    public static bool NeedsReview(int confidence, int threshold) => confidence < Math.Clamp(threshold, 0, 100);

    public static IReadOnlyList<string> SplitSkills(string? skills) =>
        (skills ?? "").Split([',', ';', '\n'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Select(Norm).Where(s => s.Length > 0).Distinct().Take(30).ToList();

    private static string Norm(string s) => Regex.Replace(s.Trim().ToLowerInvariant(), @"\s+", " ");
}
