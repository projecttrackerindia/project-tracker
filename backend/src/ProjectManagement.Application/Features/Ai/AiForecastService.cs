using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Ai;

public record AiForecastOutcome(Guid Id, Guid ProjectId, string Project, string Link, DateTime EvidenceAt, DateOnly? ProjectedFinish,
    DateTime? RecordedCompletedAt, Guid? CompletionAuditId, int? ErrorDays, bool ScopeChanged, bool Reopened, bool InputComplete, string Confidence, string MethodologyVersion);
public record AiForecastEvaluation(int Forecasts, int VerifiedCompletions, int ComparableProjects, double? MeanAbsoluteErrorDays,
    double? MeanSignedErrorDays, bool Calibrated, IReadOnlyList<AiForecastOutcome> Items, string Methodology);

public class AiForecastService(IAppDbContext db, ICurrentContext ctx, AppClock clock, ProjectAccess access, PermissionService permissions)
{
    internal async Task CaptureAsync(AiJob job, PortfolioBriefDto brief, DateTime evidenceAt, CancellationToken ct)
    {
        var ids = brief.Ranked.Select(p => p.ProjectId).ToList();
        var versions = await access.VisibleProjects().AsNoTracking().Where(p => ids.Contains(p.Id)).ToDictionaryAsync(p => p.Id, p => p.Version, ct);
        var counts = await access.VisibleTasks().AsNoTracking().Where(t => ids.Contains(t.ProjectId) && t.Status!.Category != StatusCategory.Cancelled)
            .GroupBy(t => t.ProjectId).Select(g => new { ProjectId = g.Key, Count = g.Count() }).ToDictionaryAsync(g => g.ProjectId, g => g.Count, ct);
        foreach (var p in brief.Ranked)
            db.AiForecastSnapshots.Add(new AiForecastSnapshot { TenantId = job.TenantId, UserId = job.UserId, JobId = job.Id, ProjectId = p.ProjectId,
                EvidenceAt = evidenceAt, AsOf = brief.AsOf, DueDate = p.DueDate, ProjectedFinish = p.ProjectedFinish,
                ProjectVersion = versions.GetValueOrDefault(p.ProjectId), TotalTasks = counts.GetValueOrDefault(p.ProjectId), OpenTasks = p.OpenTasks,
                FinishedLast28Days = p.FinishedLast28Days, InputComplete = !brief.Truncated, Confidence = p.Confidence });
    }

    public async Task<AiForecastEvaluation> EvaluateAsync(CancellationToken ct)
    {
        var user = ctx.RequireUserId(); var tenant = ctx.RequireTenantId();
        await permissions.RequireModuleAsync(Modules.Projects, AccessLevel.View, ct);
        var since = clock.Now.AddDays(-90);
        var visible = access.VisibleProjects();
        var snapshots = await db.AiForecastSnapshots.AsNoTracking().Where(f => f.UserId == user && f.EvidenceAt >= since && visible.Any(p => p.Id == f.ProjectId))
            .OrderByDescending(f => f.EvidenceAt).ThenByDescending(f => f.Id).Take(2000).ToListAsync(ct);
        var ids = snapshots.Select(f => f.ProjectId).Distinct().ToList();
        var projects = await visible.AsNoTracking().Where(p => ids.Contains(p.Id)).ToDictionaryAsync(p => p.Id, p => p.Name, ct);
        // Audit rows are deliberately global entities: both tenant and authorized project IDs are required here.
        var events = await db.AuditLogs.AsNoTracking().Where(a => a.TenantId == tenant && a.EntityType == "Project" && a.EntityId != null && ids.Contains(a.EntityId.Value)
            && a.Action == "project.status_changed" && a.CreatedAt >= since && a.CreatedAt <= clock.Now)
            .OrderBy(a => a.CreatedAt).ThenBy(a => a.Seq).Take(10000).Select(a => new { ProjectId = a.EntityId!.Value, a.Id, a.CreatedAt, a.NewValue }).ToListAsync(ct);
        var tasks = await access.VisibleTasks().AsNoTracking().Where(t => ids.Contains(t.ProjectId) && t.Status!.Category != StatusCategory.Cancelled)
            .GroupBy(t => t.ProjectId).Select(g => new { ProjectId = g.Key, Total = g.Count(), Open = g.Count(t => t.Status!.Category != StatusCategory.Done), LatestAdded = g.Max(t => t.CreatedAt) })
            .ToDictionaryAsync(g => g.ProjectId, ct);
        var outcomes = new List<AiForecastOutcome>();
        foreach (var group in snapshots.GroupBy(f => f.ProjectId))
        {
            var recorded = events.Where(e => e.ProjectId == group.Key).ToList();
            var eligible = group.Select(f => new { Forecast = f, Completion = recorded.FirstOrDefault(e => e.NewValue == "Completed" && e.CreatedAt > f.EvidenceAt) }).ToList();
            // One latest eligible forecast per project avoids weighting accuracy by schedule frequency.
            var selected = eligible.FirstOrDefault(x => x.Completion is not null) ?? eligible[0];
            var f = selected.Forecast; var done = selected.Completion; var taskScope = tasks.GetValueOrDefault(f.ProjectId);
            var changed = (taskScope?.Total ?? 0) != f.TotalTasks || taskScope?.LatestAdded > f.EvidenceAt;
            var reopened = done is not null && (recorded.Any(e => e.CreatedAt > done.CreatedAt && e.NewValue is "Active" or "Planning" or "OnHold") || (taskScope?.Open ?? 0) > 0);
            int? error = done is not null && f.ProjectedFinish is { } predicted ? DateOnly.FromDateTime(done.CreatedAt).DayNumber - predicted.DayNumber : null;
            outcomes.Add(new(f.Id, f.ProjectId, projects[f.ProjectId], $"/projects/{f.ProjectId}", f.EvidenceAt, f.ProjectedFinish,
                done?.CreatedAt, done?.Id, error, changed, reopened, f.InputComplete, f.Confidence, f.MethodologyVersion));
        }
        var comparable = outcomes.Where(o => o.ErrorDays != null && o.InputComplete && !o.ScopeChanged && !o.Reopened).ToList();
        return new(snapshots.Count, outcomes.Count(o => o.CompletionAuditId != null), comparable.Count,
            comparable.Count == 0 ? null : comparable.Average(o => Math.Abs(o.ErrorDays!.Value)),
            comparable.Count == 0 ? null : comparable.Average(o => o.ErrorDays!.Value), false, outcomes,
            "Last 90 days, latest eligible forecast per authorized project; actual outcome is a server-audited Completed transition. Errors exclude changed task scope, reopened/inconsistent completion and incomplete inputs. Sample-size confidence is uncalibrated; these are observations, not causal or probability estimates.");
    }
}
