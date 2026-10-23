using System.Globalization;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Application.Features.Work;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Ai;

public record AiWatchDto(Guid Id, string Kind, string TargetType, string TargetKey, string TargetTitle, string? Status, DateOnly? OnDate, string? Note, string? Link,
    string State, DateTime CreatedAt, DateTime ExpiresAt, DateTime? FiredAt, string? Outcome, string Label);

public record CreateAiWatchRequest(string Kind, string TargetType, Guid TargetId, string TargetKey, string TargetTitle, Guid? ProjectId, string? Status, DateOnly? OnDate, string? Note, string? Link, int? Days);

/// <summary>
/// "Tell me when…" watches. Each one belongs to one person and fires once - a notification in the bell (and on their phone, by their own
/// settings) - then stops. The background check reads the work's current state in bulk, a few thousand watches at a time, so it costs the
/// same whether one person or everyone uses it.
/// </summary>
public class AiWatchService(IAppDbContext db, ICurrentContext ctx, AppClock clock, NotificationRouter router, Recorder recorder, ILogger<AiWatchService> log)
{
    public static readonly string[] Kinds = ["done", "status", "overdue", "slips"];
    public static readonly string[] Targets = ["Task", "Operational", "ActionItem", "Project"];
    public const int MaxActivePerPerson = 50;
    public const int DefaultDays = 60, MaxDays = 365;

    public static string Label(string kind, string key, string? status, DateOnly? on) => kind switch
    {
        "done" => $"when {key} is done",
        "status" => $"when {key} moves to {status}",
        "overdue" => $"if {key} becomes overdue",
        _ => $"if {key} slips past {on?.ToString("d MMM yyyy", CultureInfo.InvariantCulture)}",
    };

    private static AiWatchDto Dto(AiWatch w) => new(w.Id, w.Kind, w.TargetType, w.TargetKey, w.TargetTitle, w.Status, w.OnDate, w.Note, w.Link, w.State, w.CreatedAt, w.ExpiresAt, w.FiredAt, w.Outcome,
        Label(w.Kind, w.TargetKey, w.Status, w.OnDate));

    public async Task<IReadOnlyList<AiWatchDto>> MineAsync(CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var since = clock.Now.AddDays(-14);
        var rows = await db.AiWatches.AsNoTracking().Where(w => w.UserId == me && (w.State == "active" || w.FiredAt >= since))
            .OrderBy(w => w.State == "active" ? 0 : 1).ThenByDescending(w => w.CreatedAt).Take(100).ToListAsync(ct);
        return rows.Select(Dto).ToList();
    }

    /// <summary>Starts a watch for the signed-in person. The target was resolved (and their access to it checked) by the caller.</summary>
    public async Task<AiWatchDto> CreateAsync(CreateAiWatchRequest req, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        if (!Kinds.Contains(req.Kind)) throw new ValidationException("kind", "Watch for: done, a status, overdue, or slipping past a date.");
        if (!Targets.Contains(req.TargetType)) throw new ValidationException("target", "Watch a task, a work item, an action item or a project.");
        if (req.Kind == "status" && string.IsNullOrWhiteSpace(req.Status)) throw new ValidationException("status", "Which status should it reach?");
        if (req.Kind == "slips" && req.OnDate is null) throw new ValidationException("date", "Which date should it not go past?");
        if (req.Kind == "overdue" && req.TargetType == "Project") throw new ValidationException("kind", "A project slips past a date rather than going overdue: use a date.");
        if (await db.AiWatches.CountAsync(w => w.UserId == me && w.State == "active", ct) >= MaxActivePerPerson)
            throw new ConflictException($"You are watching {MaxActivePerPerson} things already. Stop one under Reminders › Watching first.", "AI_WATCH_LIMIT");
        // The same watch again is the same watch, not a second notification.
        var existing = await db.AiWatches.FirstOrDefaultAsync(w => w.UserId == me && w.State == "active" && w.TargetId == req.TargetId && w.Kind == req.Kind && w.Status == req.Status && w.OnDate == req.OnDate, ct);
        if (existing is not null) return Dto(existing);
        var w = new AiWatch
        {
            TenantId = ctx.RequireTenantId(), UserId = me, Kind = req.Kind, TargetType = req.TargetType, TargetId = req.TargetId, TargetKey = Clip(req.TargetKey, 40), TargetTitle = Clip(req.TargetTitle, 200),
            ProjectId = req.ProjectId, Status = req.Status is null ? null : Clip(req.Status.Trim(), 80), OnDate = req.OnDate, Note = req.Note is null ? null : Clip(req.Note.Trim(), 300), Link = req.Link,
            ExpiresAt = clock.Now.AddDays(Math.Clamp(req.Days ?? DefaultDays, 1, MaxDays)), CreatedAt = clock.Now,
        };
        db.AiWatches.Add(w);
        recorder.Audit("ai.watch_started", "AiWatch", w.Id, new { w.Kind, w.TargetType, w.TargetKey });
        await db.SaveChangesAsync(ct);
        return Dto(w);
    }

    public async Task StopAsync(Guid id, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var w = await db.AiWatches.FirstOrDefaultAsync(x => x.Id == id && x.UserId == me, ct) ?? throw new NotFoundException("Watch not found.");
        if (w.State != "active") return;
        w.State = "stopped";
        await db.SaveChangesAsync(ct);
    }

    private static string Clip(string s, int max) => s.Length <= max ? s : s[..(max - 1)] + "…";

    // ------------------------------------------------------------------ the background check

    private static long _last;

    /// <summary>
    /// Checks the active watches that have waited longest (every couple of minutes at most), fires the ones whose condition holds, and ends
    /// the expired ones and those whose work is gone or whose owner left the workspace. Returns how many fired.
    /// </summary>
    public async Task<int> CheckAsync(bool force = false, int batch = 2000, CancellationToken ct = default)
    {
        var now = clock.Now;
        if (!force && now.Ticks - Interlocked.Read(ref _last) < TimeSpan.FromMinutes(2).Ticks) return 0;
        Interlocked.Exchange(ref _last, now.Ticks);
        var watches = await db.AiWatches.IgnoreQueryFilters().Where(w => w.State == "active").OrderBy(w => w.LastCheckedAt).Take(batch).ToListAsync(ct);
        if (watches.Count == 0) return 0;

        var tenants = watches.Select(w => w.TenantId).Distinct().ToList();
        var users = watches.Select(w => w.UserId).Distinct().ToList();
        var members = (await db.TenantMembers.AsNoTracking().Where(m => tenants.Contains(m.TenantId) && users.Contains(m.UserId) && m.User!.IsActive)
            .Select(m => new { m.TenantId, m.UserId }).ToListAsync(ct)).Select(m => (m.TenantId, m.UserId)).ToHashSet();
        var zones = await db.Users.AsNoTracking().Where(u => users.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.TimeZone, ct);

        Guid[] Ids(string type) => watches.Where(w => w.TargetType == type).Select(w => w.TargetId).Distinct().ToArray();
        var taskIds = Ids("Task"); var workIds = Ids("Operational").Concat(Ids("ActionItem")).ToArray(); var projectIds = Ids("Project");
        var tasks = await db.Tasks.IgnoreQueryFilters().AsNoTracking().Where(t => taskIds.Contains(t.Id))
            .Select(t => new State(t.Id, t.TenantId, t.IsDeleted || t.Project!.IsDeleted, t.Status!.Name, t.Status.Category == StatusCategory.Done || t.Status.Category == StatusCategory.Cancelled, t.DueDate)).ToListAsync(ct);
        var work = await db.WorkTasks.IgnoreQueryFilters().AsNoTracking().Where(w => workIds.Contains(w.Id))
            .Select(w => new { w.Id, w.TenantId, w.IsDeleted, w.Kind, w.Status, w.DueDate }).ToListAsync(ct);
        var projects = await db.Projects.IgnoreQueryFilters().AsNoTracking().Where(p => projectIds.Contains(p.Id))
            .Select(p => new { p.Id, p.TenantId, p.IsDeleted, p.Status, p.DueDate }).ToListAsync(ct);
        // For "slips past" on a project: the latest due date of its open tasks, which moves before the project's own end date usually does.
        var latestOpen = (await db.Tasks.IgnoreQueryFilters().AsNoTracking()
            .Where(t => projectIds.Contains(t.ProjectId) && !t.IsDeleted && t.DueDate != null && t.Status!.Category != StatusCategory.Done && t.Status.Category != StatusCategory.Cancelled)
            .GroupBy(t => t.ProjectId).Select(g => new { g.Key, Latest = g.Max(t => t.DueDate) }).ToListAsync(ct)).ToDictionary(x => x.Key, x => x.Latest);

        var states = new Dictionary<Guid, State>();
        foreach (var t in tasks) states[t.Id] = t;
        foreach (var w in work)
        {
            var (name, finished) = w.Kind == WorkTaskKind.ActionItem
                ? (ActionLabel(w.Status), w.Status == WorkTaskStatus.Completed)
                : (WorkTaskService.Label(w.Status), w.Status is WorkTaskStatus.Completed or WorkTaskStatus.Cancelled);
            states[w.Id] = new State(w.Id, w.TenantId, w.IsDeleted, name, finished, w.DueDate);
        }
        foreach (var p in projects)
        {
            var latest = latestOpen.GetValueOrDefault(p.Id);
            var end = p.DueDate is { } d && latest is { } l ? (d > l ? d : l) : p.DueDate ?? latest;
            states[p.Id] = new State(p.Id, p.TenantId, p.IsDeleted, p.Status.ToString(), p.Status is ProjectStatus.Completed or ProjectStatus.Cancelled or ProjectStatus.Archived, end);
        }

        var fired = 0;
        foreach (var w in watches)
        {
            w.LastCheckedAt = now;
            if (w.ExpiresAt <= now) { w.State = "ended"; w.Outcome = "Stopped watching: the time it was set for ran out."; continue; }
            if (!members.Contains((w.TenantId, w.UserId))) { w.State = "ended"; w.Outcome = "Ended: no longer a member."; continue; }
            if (!states.TryGetValue(w.TargetId, out var s) || s.TenantId != w.TenantId || s.Gone) { w.State = "ended"; w.Outcome = $"Ended: {w.TargetKey} was deleted."; continue; }
            var today = DateOnly.FromDateTime(ZoneTime.ToLocal(now, ZoneTime.Find(zones.GetValueOrDefault(w.UserId) ?? "UTC")));
            var outcome = Evaluate(w, s, today);
            if (outcome is null) continue;
            w.State = "fired"; w.FiredAt = now; w.Outcome = outcome;
            var n = new Notification
            {
                TenantId = w.TenantId, UserId = w.UserId, Type = NotificationType.Reminder, CreatedAt = now, Link = w.Link,
                Title = Clip(outcome, 200), Body = w.Note is null ? $"You asked to be told {Label(w.Kind, w.TargetKey, w.Status, w.OnDate)}." : $"Your note: {w.Note}",
                DedupeKey = $"watch:{w.Id:N}",
            };
            try { if (await router.ApplyAsync(n, ct)) db.Notifications.Add(n); fired++; }
            catch (Exception ex) when (ex is not OperationCanceledException) { log.LogWarning(ex, "A watch notification could not be prepared"); }
        }
        await db.SaveChangesAsync(ct);
        return fired;
    }

    /// <summary>The message when the watch's condition holds now, or null.</summary>
    public static string? Evaluate(AiWatch w, State s, DateOnly today)
    {
        var title = $"{w.TargetKey} “{(w.TargetTitle.Length > 60 ? w.TargetTitle[..59] + "…" : w.TargetTitle)}”";
        switch (w.Kind)
        {
            case "done":
                return s.Finished ? $"{title} is {s.StatusName}" : null;
            case "status":
                return string.Equals(s.StatusName, w.Status, StringComparison.OrdinalIgnoreCase) ? $"{title} moved to {s.StatusName}" : null;
            case "overdue":
                return !s.Finished && s.Due is { } due && due < today ? $"{title} is overdue (it was due {due.ToString("d MMM", CultureInfo.InvariantCulture)})" : null;
            case "slips":
                if (w.OnDate is not { } on || s.Finished) return null;
                if (s.Due is { } end && end > on) return $"{title} now ends {end.ToString("d MMM yyyy", CultureInfo.InvariantCulture)}, after {on.ToString("d MMM", CultureInfo.InvariantCulture)}";
                return today > on ? $"{title} is not finished and {on.ToString("d MMM", CultureInfo.InvariantCulture)} has passed" : null;
            default:
                return null;
        }
    }

    private static string ActionLabel(WorkTaskStatus s) => s switch { WorkTaskStatus.ToDo => "Open", WorkTaskStatus.Completed => "Completed", _ => "In Progress" };

    /// <summary>The work's state as the check sees it.</summary>
    public sealed record State(Guid Id, Guid TenantId, bool Gone, string StatusName, bool Finished, DateOnly? Due);
}
