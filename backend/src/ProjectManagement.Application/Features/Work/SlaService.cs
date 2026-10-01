using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Work;

/// <summary>A target pair for one priority, in minutes (empty = not measured).</summary>
public record SlaTargetDto(Priority Priority, int? ResponseMinutes, int? ResolutionMinutes);
public record SlaOverrideDto(Guid WorkTypeId, string WorkType, IReadOnlyList<SlaTargetDto> Targets);
public record SlaSettingsDto(bool Entitled, bool CanManage, IReadOnlyList<SlaTargetDto> Defaults, IReadOnlyList<SlaOverrideDto> Overrides);
/// <summary>Replaces the targets of the defaults (no work type) or of one work type.</summary>
public record SaveSlaRequest(Guid? WorkTypeId, IReadOnlyList<SlaTargetDto>? Targets);

/// <summary>
/// One clock of a work task: <see cref="State"/> is OnTrack, AtRisk, Breached, Met, Missed (finished late), Paused or Stopped (cancelled).
/// </summary>
public record SlaClockDto(DateTime DueAt, DateTime? MetAt, string State);
public record WorkSlaDto(SlaClockDto? Response, SlaClockDto? Resolution, string State);
public record WorkSlaSummaryDto(int Tracked, int Met, int Missed, decimal? Compliance, int OpenBreached, int OpenAtRisk, int ResponseTracked, int ResponseMet);

/// <summary>
/// Service levels for operational work. The workspace sets response and resolution targets per priority, optionally different for a work
/// type. When a work task is raised (or its priority or type changes while it is open) its due times are fixed from those targets. Response
/// is met when someone first moves it out of To Do or comments when they did not raise it; resolution when it is completed. On Hold stops
/// the resolution clock and the time it spends there is added back. Cancelled work stops both clocks and counts neither way.
/// </summary>
public class SlaService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, PermissionService permissions, EntitlementService entitlements)
{
    /// <summary>A sensible starting point (calendar hours), offered until the workspace saves its own.</summary>
    public static readonly IReadOnlyList<SlaTargetDto> Suggested =
    [
        new(Priority.Critical, 30, 4 * 60), new(Priority.High, 2 * 60, 24 * 60), new(Priority.Medium, 8 * 60, 3 * 24 * 60), new(Priority.Low, 24 * 60, 7 * 24 * 60),
    ];
    private const int MaxTargetMinutes = 365 * 24 * 60;
    private const decimal RiskShare = 0.75m;

    private static readonly Priority[] Order = [Priority.Critical, Priority.High, Priority.Medium, Priority.Low];

    // ------------------------------------------------------------------ settings

    public async Task<SlaSettingsDto> GetAsync(CancellationToken ct = default)
    {
        await permissions.RequireModuleAsync(Modules.Work, AccessLevel.View, ct);
        var rows = await db.SlaPolicies.AsNoTracking().ToListAsync(ct);
        var types = await db.WorkTypes.AsNoTracking().OrderBy(t => t.Order).Select(t => new { t.Id, t.Name }).ToListAsync(ct);
        IReadOnlyList<SlaTargetDto> Targets(Guid? type) => Order.Select(p => rows.FirstOrDefault(r => r.WorkTypeId == type && r.Priority == p) is { } r
            ? new SlaTargetDto(p, r.ResponseMinutes, r.ResolutionMinutes) : new SlaTargetDto(p, null, null)).ToList();
        var overrides = types.Where(t => rows.Any(r => r.WorkTypeId == t.Id)).Select(t => new SlaOverrideDto(t.Id, t.Name, Targets(t.Id))).ToList();
        return new SlaSettingsDto(await entitlements.GetValueAsync(FeatureKeys.ServiceLevels, ct) > 0, await permissions.HasAsync(Permissions.WorkTypesManage, ct),
            rows.Any(r => r.WorkTypeId == null) ? Targets(null) : Suggested.Select(s => new SlaTargetDto(s.Priority, null, null)).ToList(), overrides);
    }

    public async Task<SlaSettingsDto> SaveAsync(SaveSlaRequest req, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.WorkTypesManage, ct);
        await entitlements.EnsureFeatureAsync(FeatureKeys.ServiceLevels, ct);
        var tid = ctx.RequireTenantId();
        string scope = "all work types";
        if (req.WorkTypeId is { } typeId)
            scope = await db.WorkTypes.Where(t => t.Id == typeId).Select(t => t.Name).FirstOrDefaultAsync(ct) ?? throw new ValidationException("workTypeId", "That work type was not found.");
        var targets = req.Targets ?? [];
        if (targets.Select(t => t.Priority).Distinct().Count() != targets.Count) throw new ValidationException("targets", "Give each priority once.");
        foreach (var t in targets)
        {
            Check(t.ResponseMinutes, "response"); Check(t.ResolutionMinutes, "resolution");
            if (t.ResponseMinutes is { } r && t.ResolutionMinutes is { } s && r > s)
                throw new ValidationException("targets", $"{t.Priority}: the response target cannot be longer than the resolution target.");
        }

        db.SlaPolicies.RemoveRange(await db.SlaPolicies.Where(p => p.WorkTypeId == req.WorkTypeId).ToListAsync(ct));
        var now = clock.Now;
        foreach (var t in targets.Where(t => t.ResponseMinutes != null || t.ResolutionMinutes != null))
            db.SlaPolicies.Add(new SlaPolicy { TenantId = tid, WorkTypeId = req.WorkTypeId, Priority = t.Priority, ResponseMinutes = t.ResponseMinutes, ResolutionMinutes = t.ResolutionMinutes, CreatedAt = now, CreatedBy = ctx.UserId });
        // A work type saved with every target empty would be indistinguishable from "uses the defaults": keep one empty row as the marker.
        if (req.WorkTypeId is not null && targets.All(t => t.ResponseMinutes == null && t.ResolutionMinutes == null))
            db.SlaPolicies.Add(new SlaPolicy { TenantId = tid, WorkTypeId = req.WorkTypeId, Priority = Priority.Low, CreatedAt = now, CreatedBy = ctx.UserId });
        recorder.Audit("sla.saved", "SlaPolicy", req.WorkTypeId, null, new { scope, targets });
        await db.SaveChangesAsync(ct);
        return await GetAsync(ct);
    }

    /// <summary>The work type goes back to the workspace's default targets.</summary>
    public async Task<SlaSettingsDto> ClearOverrideAsync(Guid workTypeId, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.WorkTypesManage, ct);
        db.SlaPolicies.RemoveRange(await db.SlaPolicies.Where(p => p.WorkTypeId == workTypeId).ToListAsync(ct));
        recorder.Audit("sla.override_removed", "SlaPolicy", workTypeId);
        await db.SaveChangesAsync(ct);
        return await GetAsync(ct);
    }

    private static void Check(int? minutes, string what)
    {
        if (minutes is { } m && (m < 1 || m > MaxTargetMinutes)) throw new ValidationException("targets", $"Each {what} target must be between 1 minute and 365 days.");
    }

    // ------------------------------------------------------------------ the clocks on a work task

    /// <summary>The targets that apply to a work type and priority: the type's own when it has any, otherwise the defaults.</summary>
    private async Task<(int? Response, int? Resolution)> TargetsAsync(Guid? workTypeId, Priority priority, CancellationToken ct)
    {
        if (await entitlements.GetValueAsync(FeatureKeys.ServiceLevels, ct) <= 0) return (null, null);
        var rows = await db.SlaPolicies.AsNoTracking().Where(p => p.WorkTypeId == workTypeId || p.WorkTypeId == null).ToListAsync(ct);
        var own = rows.Where(r => r.WorkTypeId != null && r.WorkTypeId == workTypeId).ToList();
        var pick = (own.Count > 0 ? own : rows.Where(r => r.WorkTypeId == null)).FirstOrDefault(r => r.Priority == priority);
        return (pick?.ResponseMinutes, pick?.ResolutionMinutes);
    }

    /// <summary>Fixes the due times from the targets for the task's type and priority, measured from when it was raised.</summary>
    public async Task ApplyTargetsAsync(WorkTask t, CancellationToken ct = default)
    {
        if (t.Kind != WorkTaskKind.Operational) return;
        var (response, resolution) = await TargetsAsync(t.WorkTypeId, t.Priority, ct);
        t.SlaAlerted = 0;
        t.ResponseDueAt = response is { } r ? t.CreatedAt.AddMinutes(r) : null;
        if (resolution is { } s)
        {
            t.ResolutionDueAt = t.CreatedAt.AddMinutes(s + t.SlaPausedMinutes);
            t.ResolutionRiskAt = t.CreatedAt.AddMinutes((double)(s * RiskShare) + t.SlaPausedMinutes);
        }
        else { t.ResolutionDueAt = null; t.ResolutionRiskAt = null; }
    }

    /// <summary>Keeps the clocks right when the status changes: response on leaving To Do, pause on hold, resume when it comes back.</summary>
    public void OnStatusChanged(WorkTask t, WorkTaskStatus from, WorkTaskStatus to)
    {
        var now = clock.Now;
        if (from == WorkTaskStatus.ToDo && to != WorkTaskStatus.ToDo && t.RespondedAt is null) t.RespondedAt = now;
        if (to == WorkTaskStatus.OnHold && t.SlaPausedAt is null) t.SlaPausedAt = now;
        else if (from == WorkTaskStatus.OnHold && to != WorkTaskStatus.OnHold && t.SlaPausedAt is { } since)
        {
            var paused = (int)Math.Ceiling((now - since).TotalMinutes);
            t.SlaPausedMinutes += paused;
            if (t.ResolutionDueAt is { } due) t.ResolutionDueAt = due.AddMinutes(paused);
            if (t.ResolutionRiskAt is { } risk) t.ResolutionRiskAt = risk.AddMinutes(paused);
            t.SlaPausedAt = null;
            // The resolution clock moved: its at-risk and missed alerts belong to the new due time.
            t.SlaAlerted &= SlaAlerts.Response;
        }
    }

    /// <summary>A comment from someone other than the person who raised it counts as the first response.</summary>
    public void OnComment(WorkTask t, Guid authorId)
    {
        if (t.RespondedAt is null && authorId != t.ReporterId) t.RespondedAt = clock.Now;
    }

    private static bool IsOpen(WorkTaskStatus s) => s is WorkTaskStatus.ToDo or WorkTaskStatus.InProgress or WorkTaskStatus.OnHold;

    /// <summary>Where the task's clocks stand right now (null when no target applies).</summary>
    public static WorkSlaDto? State(WorkTask t, DateTime now)
    {
        if (t.ResponseDueAt is null && t.ResolutionDueAt is null) return null;
        var cancelled = t.Status == WorkTaskStatus.Cancelled;
        SlaClockDto? response = t.ResponseDueAt is { } rd
            ? new SlaClockDto(rd, t.RespondedAt, t.RespondedAt is { } ra ? (ra <= rd ? "Met" : "Missed") : cancelled ? "Stopped" : now > rd ? "Breached" : "OnTrack")
            : null;
        SlaClockDto? resolution = null;
        if (t.ResolutionDueAt is { } sd)
        {
            string state;
            if (t.Status == WorkTaskStatus.Completed && t.CompletedAt is { } done) state = done <= sd ? "Met" : "Missed";
            else if (cancelled) state = "Stopped";
            else if (t.SlaPausedAt is { } p) state = p > sd ? "Breached" : "Paused";
            else if (now > sd) state = "Breached";
            else if (t.ResolutionRiskAt is { } risk && now >= risk) state = "AtRisk";
            else state = "OnTrack";
            resolution = new SlaClockDto(sd, t.Status == WorkTaskStatus.Completed ? t.CompletedAt : null, state);
        }
        string[] states = [response?.State ?? "", resolution?.State ?? ""];
        var overall = states.Contains("Breached") ? "Breached" : states.Contains("Missed") ? "Missed" : states.Contains("AtRisk") ? "AtRisk"
            : states.Contains("Paused") && IsOpen(t.Status) ? "Paused" : states.Contains("OnTrack") ? "OnTrack" : states.Contains("Stopped") ? "Stopped" : "Met";
        return new WorkSlaDto(response, resolution, overall);
    }
}

/// <summary>The alerts a work task has had for its current due times (bit flags in <see cref="WorkTask.SlaAlerted"/>).</summary>
public static class SlaAlerts
{
    public const int Response = 1;
    public const int Risk = 2;
    public const int Resolution = 4;
}

/// <summary>
/// Watches the clocks across every workspace (run by a background worker each minute): tells the assignee - or, while nobody is assigned,
/// the person who raised it - once when a task is three quarters of the way to its resolution target, and once each when the response or
/// resolution target is missed; the person who raised it hears about misses too. Each task remembers which alerts it has had, so a task
/// that stays late is not looked at again and newer ones are never crowded out.
/// </summary>
public class SlaMonitor(IAppDbContext db, AppClock clock, ProjectManagement.Application.Features.Notifications.NotificationRouter router, ILogger<SlaMonitor> log)
{
    private const int Batch = 500;

    public async Task<int> RunAsync(CancellationToken ct = default)
    {
        var now = clock.Now;
        var open = new[] { WorkTaskStatus.ToDo, WorkTaskStatus.InProgress, WorkTaskStatus.OnHold };
        var due = await db.WorkTasks.IgnoreQueryFilters()
            .Where(t => !t.IsDeleted && t.Kind == WorkTaskKind.Operational && open.Contains(t.Status)
                        && db.Tenants.IgnoreQueryFilters().Any(x => x.Id == t.TenantId && !x.IsDeleted)
                        && ((t.RespondedAt == null && t.ResponseDueAt != null && t.ResponseDueAt <= now && (t.SlaAlerted & SlaAlerts.Response) == 0)
                            || (t.SlaPausedAt == null && t.ResolutionRiskAt != null && t.ResolutionRiskAt <= now && (t.SlaAlerted & SlaAlerts.Risk) == 0)
                            || (t.SlaPausedAt == null && t.ResolutionDueAt != null && t.ResolutionDueAt <= now && (t.SlaAlerted & SlaAlerts.Resolution) == 0)))
            .OrderBy(t => t.CreatedAt).Take(Batch).ToListAsync(ct);
        if (due.Count == 0) return 0;

        var notes = new List<Notification>();
        foreach (var t in due)
        {
            var key = WorkTaskService.KeyOf(t.Number);
            var owner = t.AssigneeId ?? t.ReporterId;
            void Tell(Guid user, string kind, DateTime dueAt, string title, string body) => notes.Add(new Notification
            {
                TenantId = t.TenantId, UserId = user, Type = NotificationType.ServiceLevel, DedupeKey = $"sla:{kind}:{t.Id:N}:{dueAt:yyyyMMddHHmm}:{user:N}",
                Title = title, Body = body, Link = WorkTaskService.LinkOf(t.Id), CreatedAt = now,
            });

            if (t.RespondedAt is null && t.ResponseDueAt is { } rd && rd <= now && (t.SlaAlerted & SlaAlerts.Response) == 0)
            {
                foreach (var u in new[] { owner, t.ReporterId }.Distinct())
                    Tell(u, "resp", rd, $"{key} missed its response target", $"“{t.Title}” was due a first response by {rd:dd MMM HH:mm} UTC.");
                t.SlaAlerted |= SlaAlerts.Response;
            }
            if (t.SlaPausedAt is null && t.ResolutionDueAt is { } sd && sd <= now)
            {
                if ((t.SlaAlerted & SlaAlerts.Resolution) == 0)
                    foreach (var u in new[] { owner, t.ReporterId }.Distinct())
                        Tell(u, "res", sd, $"{key} missed its resolution target", $"“{t.Title}” was due to be resolved by {sd:dd MMM HH:mm} UTC.");
                // Past due, an at-risk warning would only be noise.
                t.SlaAlerted |= SlaAlerts.Resolution | SlaAlerts.Risk;
            }
            else if (t.SlaPausedAt is null && t.ResolutionRiskAt is { } risk && risk <= now && t.ResolutionDueAt is { } dueAt && (t.SlaAlerted & SlaAlerts.Risk) == 0)
            {
                Tell(owner, "risk", dueAt, $"{key} is close to its resolution target", $"“{t.Title}” is due to be resolved by {dueAt:dd MMM HH:mm} UTC.");
                t.SlaAlerted |= SlaAlerts.Risk;
            }
        }

        // A notification that already went out (the same alert for the same due time) is not repeated.
        var keys = notes.Select(n => n.DedupeKey!).ToList();
        var sent = (await db.Notifications.IgnoreQueryFilters().Where(n => n.DedupeKey != null && keys.Contains(n.DedupeKey)).Select(n => n.DedupeKey!).ToListAsync(ct)).ToHashSet();
        await router.PreloadAsync(notes.Select(n => n.UserId), ct);
        var added = 0;
        foreach (var n in notes)
        {
            if (!sent.Add(n.DedupeKey!)) continue;
            if (await router.ApplyAsync(n, ct)) { db.Notifications.Add(n); added++; }
        }
        await db.SaveChangesAsync(ct);
        if (added > 0) log.LogInformation("Service levels: sent {Count} notification(s) for {Tasks} work task(s)", added, due.Count);
        return added;
    }
}
