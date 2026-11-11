using System.Collections.Concurrent;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Application.Services;

namespace ProjectManagement.Application.Features.Ai;

public sealed record SnapshotPoint(Guid ProjectId, DateTime EvidenceAt, DateOnly? Projected);
public sealed record StatusEvent(Guid ProjectId, DateTime At, string? NewValue);
public sealed record ScoredForecast(Guid ProjectId, DateTime EvidenceAt, DateOnly Predicted, DateOnly Actual, int ErrorDays);

/// <summary>
/// How a forecast is marked against what really happened, kept apart from the database so it can be tested on its own. A project counts once, when
/// the audited status change to Completed exists and was not undone by a later reopening; its forecast is the latest one taken at least
/// <see cref="LeadDays"/> days before that, because a forecast made the day before the finish proves nothing. Scope changes are not excluded:
/// they are part of why forecasts miss.
/// </summary>
public static class ForecastScoring
{
    /// <summary>The forecast the background job records for every active project (see <see cref="SlipFixService"/>).</summary>
    public const string Method = "stage-forecast-v1";
    public const int LeadDays = 7;

    public static List<ScoredForecast> Score(IEnumerable<SnapshotPoint> snapshots, IEnumerable<StatusEvent> events, Func<DateTime, DateOnly> toDay)
    {
        var eventsBy = events.GroupBy(e => e.ProjectId).ToDictionary(g => g.Key, g => g.OrderBy(e => e.At).ToList());
        var scored = new List<ScoredForecast>();
        foreach (var group in snapshots.GroupBy(s => s.ProjectId))
        {
            if (!eventsBy.TryGetValue(group.Key, out var list)) continue;
            var done = list.FirstOrDefault(e => e.NewValue == "Completed");
            if (done is null) continue;
            if (list.Any(e => e.At > done.At && (e.NewValue == "Active" || e.NewValue == "Planning" || e.NewValue == "OnHold"))) continue;
            var pick = group.Where(s => s.Projected != null && s.EvidenceAt <= done.At.AddDays(-LeadDays)).OrderByDescending(s => s.EvidenceAt).FirstOrDefault();
            if (pick?.Projected is not { } predicted) continue;
            var actual = toDay(done.At);
            scored.Add(new ScoredForecast(group.Key, pick.EvidenceAt, predicted, actual, actual.DayNumber - predicted.DayNumber));
        }
        return scored;
    }

    public static ForecastCalibration Summarise(IReadOnlyList<ScoredForecast> scored) => scored.Count == 0 ? ForecastCalibration.None
        : new ForecastCalibration(scored.Count, scored.Count(s => Math.Abs(s.ErrorDays) <= ForecastConfidence.WithinDays),
            scored.Average(s => Math.Abs((double)s.ErrorDays)), scored.Average(s => (double)s.ErrorDays));
}

/// <summary>
/// Reads the recorded forecasts of a workspace and what happened to those projects. Used to calibrate the confidence on the project page; only counts
/// leave it (no project names), and the answer is kept for a few minutes per workspace because it changes only when a project completes.
/// </summary>
public class ForecastCalibrationService(IAppDbContext db, ICurrentContext ctx, AppClock clock)
{
    private static readonly ConcurrentDictionary<Guid, (DateTime At, ForecastCalibration Value)> Cache = new();
    private static readonly TimeSpan Keep = TimeSpan.FromMinutes(10);
    public const int WindowDays = 90;   // forecast evidence is kept for 90 days

    public Task<ForecastCalibration> ForCurrentWorkspaceAsync(CancellationToken ct = default) => ForWorkspaceAsync(ctx.RequireTenantId(), ct);

    public async Task<ForecastCalibration> ForWorkspaceAsync(Guid tenant, CancellationToken ct = default)
    {
        if (Cache.TryGetValue(tenant, out var hit) && clock.Now - hit.At < Keep) return hit.Value;
        var value = ForecastScoring.Summarise(await ScoredAsync(tenant, ct));
        if (Cache.Count > 5000) Cache.Clear();
        Cache[tenant] = (clock.Now, value);
        return value;
    }

    /// <summary>Drops the remembered answer (a test, or after a completion).</summary>
    public static void Forget(Guid tenant) => Cache.TryRemove(tenant, out _);

    public async Task<List<ScoredForecast>> ScoredAsync(Guid tenant, CancellationToken ct)
    {
        var since = clock.Now.AddDays(-WindowDays);
        var snapshots = await db.AiForecastSnapshots.IgnoreQueryFilters().AsNoTracking()
            .Where(f => f.TenantId == tenant && f.MethodologyVersion == ForecastScoring.Method && f.ProjectedFinish != null && f.EvidenceAt >= since)
            .Select(f => new SnapshotPoint(f.ProjectId, f.EvidenceAt, f.ProjectedFinish)).Take(20_000).ToListAsync(ct);
        if (snapshots.Count == 0) return [];
        var ids = snapshots.Select(s => s.ProjectId).Distinct().ToList();
        // Audit rows are global entities: the workspace and the project ids are both named here.
        var events = await db.AuditLogs.AsNoTracking()
            .Where(a => a.TenantId == tenant && a.EntityType == "Project" && a.EntityId != null && ids.Contains(a.EntityId.Value) && a.Action == "project.status_changed" && a.CreatedAt >= since)
            .Select(a => new StatusEvent(a.EntityId!.Value, a.CreatedAt, a.NewValue)).Take(20_000).ToListAsync(ct);
        return ForecastScoring.Score(snapshots, events, d => DateOnly.FromDateTime(ZoneTime.ToLocal(d, clock.Zone)));
    }
}
