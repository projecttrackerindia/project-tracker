using System.Collections.Concurrent;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Chat;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.Work;
using ProjectManagement.Application.Features.WorkItems;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Reminders;

/// <summary>How the scheduler is doing, for System health: reminders sent, and how late they went out (this server only).</summary>
public sealed class ReminderMetrics
{
    private readonly ConcurrentQueue<double> _lags = new();
    private long _fired;
    private long _lastRun;

    public void Ran(DateTime at) => Interlocked.Exchange(ref _lastRun, at.Ticks);

    public void Fired(double lagSeconds)
    {
        Interlocked.Increment(ref _fired);
        _lags.Enqueue(Math.Max(0, lagSeconds));
        while (_lags.Count > 500 && _lags.TryDequeue(out _)) { }
    }

    public long FiredTotal => Interlocked.Read(ref _fired);
    public DateTime? LastRunAt => Interlocked.Read(ref _lastRun) is var t and > 0 ? new DateTime(t, DateTimeKind.Utc) : null;

    /// <summary>95th percentile of how late reminders went out, in seconds.</summary>
    public double LagP95
    {
        get
        {
            var all = _lags.ToArray();
            if (all.Length == 0) return 0;
            Array.Sort(all);
            return Math.Round(all[(int)Math.Min(all.Length - 1, Math.Ceiling(all.Length * 0.95) - 1)], 1);
        }
    }
}

/// <summary>Where a reminder's work stands now: whether it is still open, its due date, and where it lives.</summary>
public sealed record TargetState(bool Open, DateOnly? Due, Guid? ProjectId, Guid? AssigneeId);

public static class TargetStates
{
    /// <summary>The state of each target that still exists (deleted work is simply missing from the answer). Reads across workspaces.</summary>
    public static async Task<Dictionary<(ReminderTarget, Guid), TargetState>> LoadAsync(IAppDbContext db, IEnumerable<(ReminderTarget Type, Guid Id)> targets, CancellationToken ct)
    {
        var result = new Dictionary<(ReminderTarget, Guid), TargetState>();
        foreach (var group in targets.Distinct().GroupBy(t => t.Type))
            foreach (var chunk in group.Select(t => t.Id).Chunk(400))
            {
                var ids = chunk.ToList();
                switch (group.Key)
                {
                    case ReminderTarget.Task:
                        foreach (var t in await db.Tasks.IgnoreQueryFilters().AsNoTracking().Where(x => ids.Contains(x.Id) && !x.IsDeleted && !x.Project!.IsDeleted)
                            .Select(x => new { x.Id, Cat = x.Status!.Category, x.DueDate, x.ProjectId, x.AssigneeId }).ToListAsync(ct))
                            result[(group.Key, t.Id)] = new(t.Cat is not (StatusCategory.Done or StatusCategory.Cancelled), t.DueDate, t.ProjectId, t.AssigneeId);
                        break;
                    case ReminderTarget.Issue:
                        foreach (var i in await db.StageIssues.IgnoreQueryFilters().AsNoTracking().Where(x => ids.Contains(x.Id) && db.Projects.IgnoreQueryFilters().Any(p => p.Id == x.ProjectId && !p.IsDeleted))
                            .Select(x => new { x.Id, x.Status, x.ProjectId, x.AssigneeId }).ToListAsync(ct))
                            result[(group.Key, i.Id)] = new(i.Status != IssueStatus.Resolved, null, i.ProjectId, i.AssigneeId);
                        break;
                    case ReminderTarget.ActionItem or ReminderTarget.Operational:
                        foreach (var w in await db.WorkTasks.IgnoreQueryFilters().AsNoTracking().Where(x => ids.Contains(x.Id) && !x.IsDeleted)
                            .Select(x => new { x.Id, x.Status, x.DueDate, x.RelatedProjectId, x.AssigneeId }).ToListAsync(ct))
                            result[(group.Key, w.Id)] = new(w.Status is WorkTaskStatus.ToDo or WorkTaskStatus.InProgress or WorkTaskStatus.OnHold, w.DueDate, w.RelatedProjectId, w.AssigneeId);
                        break;
                    case ReminderTarget.Milestone:
                        foreach (var m in await db.Milestones.IgnoreQueryFilters().AsNoTracking().Where(x => ids.Contains(x.Id) && !x.IsDeleted)
                            .Select(x => new { x.Id, x.Status, x.DueDate, x.ProjectId, x.OwnerId }).ToListAsync(ct))
                            result[(group.Key, m.Id)] = new(m.Status != StageStatus.Completed, m.DueDate, m.ProjectId, m.OwnerId);
                        break;
                    case ReminderTarget.ChatMessage:
                        foreach (var c in await db.ChatMessages.IgnoreQueryFilters().AsNoTracking().Where(x => ids.Contains(x.Id) && x.DeletedAt == null).Select(x => x.Id).ToListAsync(ct))
                            result[(group.Key, c)] = new(true, null, null, null);
                        break;
                }
            }
        return result;
    }
}

/// <summary>
/// The scheduler. Every run it (1) keeps the automatic reminders in step with the work (<see cref="ReminderPlanner"/>, every few
/// minutes), (2) fires what is due - claiming each reminder first, so several servers never send one twice - and (3) sends the morning
/// briefings. Firing respects each person's zone, working hours and quiet hours (for what is not exact), and their daily limit for
/// automatic reminders; three or more for one person at once become one notification.
/// </summary>
public class ReminderEngine(IAppDbContext db, AppClock clock, NotificationRouter router, IChatNotifier live, ReminderPlanner planner, ReminderMetrics metrics,
    PortfolioDigestService digest, ILogger<ReminderEngine> log)
{
    private const int Batch = 200;
    private static long _lastPlan, _lastBriefing;
    private static readonly ReminderSource[] Automatic = [ReminderSource.DueDate, ReminderSource.Overdue, ReminderSource.Escalation];

    /// <summary>One pass. With <paramref name="at"/> (tests, catch-up) planning and briefings run every time; otherwise every five minutes.</summary>
    public async Task<int> RunAsync(DateTime? at = null, CancellationToken ct = default)
    {
        var now = at ?? clock.Now;
        var every = TimeSpan.FromMinutes(5).Ticks;
        if (at is not null || now.Ticks - Interlocked.Read(ref _lastPlan) >= every)
        {
            Interlocked.Exchange(ref _lastPlan, now.Ticks);
            try { await planner.PlanAsync(now, ct); }
            catch (DbUpdateException ex) { log.LogDebug(ex, "Reminder planning met another server's work; it will settle on the next run"); }
        }
        var fired = await FireDueAsync(now, ct);
        if (at is not null || now.Ticks - Interlocked.Read(ref _lastBriefing) >= every)
        {
            Interlocked.Exchange(ref _lastBriefing, now.Ticks);
            await BriefAsync(now, ct);
            try { await digest.SendAsync(now, force: true, ct); }
            catch (Exception ex) when (ex is not OperationCanceledException) { log.LogError(ex, "The weekly portfolio brief failed; the reminders carry on"); }
        }
        metrics.Ran(now);
        return fired;
    }

    // ------------------------------------------------------------------ firing

    public async Task<int> FireDueAsync(DateTime now, CancellationToken ct = default)
    {
        var ids = await db.Reminders.IgnoreQueryFilters()
            .Where(r => (r.State == ReminderState.Scheduled || r.State == ReminderState.Fired) && r.NextFireAt != null && r.NextFireAt <= now
                        && (r.LockedUntil == null || r.LockedUntil < now))
            .OrderBy(r => r.NextFireAt).Select(r => r.Id).Take(Batch).ToListAsync(ct);
        if (ids.Count == 0) return 0;
        // Claim them: only the rows this server managed to mark are its to send.
        var claim = Guid.NewGuid();
        await db.Reminders.IgnoreQueryFilters().Where(r => ids.Contains(r.Id) && (r.LockedUntil == null || r.LockedUntil < now))
            .ExecuteUpdateAsync(s => s.SetProperty(r => r.LockToken, claim).SetProperty(r => r.LockedUntil, now.AddMinutes(2)), ct);
        var rows = await db.Reminders.IgnoreQueryFilters().Where(r => r.LockToken == claim).ToListAsync(ct);
        if (rows.Count == 0) return 0;

        var userIds = rows.Select(r => r.UserId).Concat(rows.Where(r => r.CreatedBy != null).Select(r => r.CreatedBy!.Value)).Distinct().ToList();
        var tenantIds = rows.Select(r => r.TenantId).Distinct().ToList();
        var users = await db.Users.AsNoTracking().Where(u => userIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, ct);
        var tenants = await db.Tenants.IgnoreQueryFilters().AsNoTracking().Where(t => tenantIds.Contains(t.Id)).ToDictionaryAsync(t => t.Id, ct);
        var members = (await db.TenantMembers.IgnoreQueryFilters().AsNoTracking().Where(m => tenantIds.Contains(m.TenantId) && userIds.Contains(m.UserId))
            .Select(m => new { m.TenantId, m.UserId, m.Role }).ToListAsync(ct)).ToDictionary(m => (m.TenantId, m.UserId), m => m.Role);
        var settings = await db.ReminderSettings.AsNoTracking().Where(s => userIds.Contains(s.UserId)).ToDictionaryAsync(s => s.UserId, ct);
        var targets = await TargetStates.LoadAsync(db, rows.Where(r => r.TargetId != null).Select(r => (r.TargetType, r.TargetId!.Value)), ct);
        var autoToday = new Dictionary<(Guid, Guid), int>();
        var pending = new List<(Reminder R, string Token)>();

        foreach (var r in rows)
        {
            r.LockToken = null; r.LockedUntil = null;
            var user = users.GetValueOrDefault(r.UserId);
            if (user is null || !user.IsActive || !tenants.TryGetValue(r.TenantId, out var tenant) || tenant.IsDeleted || tenant.Status != TenantStatus.Active
                || !members.TryGetValue((r.TenantId, r.UserId), out var role))
            {
                Stop(r, ReminderState.Cancelled, now);   // the person or the workspace is gone
                continue;
            }
            if (r.TargetId is { } targetId)
            {
                if (!targets.TryGetValue((r.TargetType, targetId), out var state)) { Stop(r, ReminderState.Cancelled, now); continue; }
                if (r.OnlyIfOpen && !state.Open) { Stop(r, ReminderState.Done, now); continue; }   // finished together with its work
                // Access is checked again: a guest who left the project no longer hears about its work.
                if (role == TenantRole.Guest && state.ProjectId is { } pid
                    && !await db.ProjectMembers.IgnoreQueryFilters().AnyAsync(m => m.ProjectId == pid && m.UserId == r.UserId, ct))
                { Stop(r, ReminderState.Cancelled, now); continue; }
            }

            var s = settings.GetValueOrDefault(r.UserId) ?? new ReminderSettings { UserId = r.UserId };
            var cal = new WorkCalendar(s);
            var tz = ZoneTime.Find(user.TimeZone);
            if (!r.Exact)
            {
                var local = ZoneTime.ToLocal(now, tz);
                if (!cal.IsGoodTime(local)) { r.NextFireAt = ZoneTime.ToUtc(cal.NextGoodTime(local), tz); continue; }   // waits for working hours
            }

            var quiet = false;
            if (Automatic.Contains(r.Source))
            {
                var key = (r.TenantId, r.UserId);
                if (!autoToday.TryGetValue(key, out var sent))
                {
                    var dayStart = ZoneTime.ToUtc(ZoneTime.At(DateOnly.FromDateTime(ZoneTime.ToLocal(now, tz)), TimeOnly.MinValue), tz);
                    sent = await db.Notifications.IgnoreQueryFilters().CountAsync(n => n.TenantId == r.TenantId && n.UserId == r.UserId
                        && (n.Type == NotificationType.DueSoon || n.Type == NotificationType.Overdue) && n.CreatedAt >= dayStart, ct);
                }
                quiet = sent >= s.DailyAutoLimit;
                autoToday[key] = sent + (quiet ? 0 : 1);
            }

            metrics.Fired((now - r.NextFireAt!.Value).TotalSeconds);
            r.State = ReminderState.Fired; r.LastFiredAt = now; r.FireCount++; r.IsSnoozed = false; r.Quiet = quiet;
            r.NextFireAt = r.Recurrence is not null ? ReminderService.NextOccurrence(r, now) : null;
            var token = ReminderService.NewActionToken(r, now);
            if (!quiet) pending.Add((r, token));
        }

        foreach (var group in pending.GroupBy(p => (p.R.TenantId, p.R.UserId)))
        {
            var list = group.ToList();
            if (list.Count >= 3)
            {
                var n = new Notification
                {
                    TenantId = group.Key.TenantId, UserId = group.Key.UserId, CreatedAt = now, Link = "/reminders",
                    Type = list.Any(p => p.R.Source == ReminderSource.Personal) ? NotificationType.Reminder : list.Any(p => p.R.Source == ReminderSource.Nudge) ? NotificationType.Nudge : NotificationType.DueSoon,
                    Title = $"{list.Count} reminders", Body = Text(string.Join(" · ", list.Select(p => p.R.Title)), 500),
                    DedupeKey = $"rems:{group.Key.UserId:N}:{now:yyyyMMddHHmmss}",
                };
                if (await router.ApplyAsync(n, ct)) db.Notifications.Add(n);
            }
            else foreach (var (r, token) in list)
            {
                var from = r.Source == ReminderSource.Nudge && r.CreatedBy is { } c && users.TryGetValue(c, out var sender) ? sender.DisplayName : null;
                var n = new Notification
                {
                    TenantId = r.TenantId, UserId = r.UserId, CreatedAt = now, Link = $"/r/{token}", DedupeKey = $"rem:{r.Id:N}:{r.FireCount}",
                    Type = r.Source switch { ReminderSource.Personal => NotificationType.Reminder, ReminderSource.Nudge => NotificationType.Nudge, ReminderSource.DueDate => NotificationType.DueSoon, _ => NotificationType.Overdue },
                    Title = Text(from is null ? r.Title : $"{from} reminds you: {r.Title}", 200)!,
                    Body = Text(r.Note ?? (r.Source is ReminderSource.Personal or ReminderSource.Nudge && r.TargetKey is not null ? $"{r.TargetKey} · {r.TargetTitle}" : r.TargetTitle), 500),
                };
                if (await router.ApplyAsync(n, ct)) db.Notifications.Add(n);
            }
        }
        await db.SaveChangesAsync(ct);

        // Open tabs show it at once, with Done and Snooze right there.
        foreach (var group in pending.GroupBy(p => (p.R.TenantId, p.R.UserId)))
        {
            try
            {
                await live.ToUsersAsync(group.Key.TenantId, [group.Key.UserId], "reminder", group.Select(p => new
                {
                    id = p.R.Id, title = p.R.Title, note = p.R.Note, targetKey = p.R.TargetKey, link = p.R.Link, source = p.R.Source.ToString(),
                    from = p.R.Source == ReminderSource.Nudge && p.R.CreatedBy is { } c && users.TryGetValue(c, out var u) ? u.DisplayName : null,
                }).ToList(), ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException) { log.LogDebug(ex, "Could not show a reminder live"); }
        }
        return pending.Count;
    }

    private static void Stop(Reminder r, ReminderState state, DateTime now)
    {
        r.State = state; r.NextFireAt = null; r.ActionTokenHash = null;
        if (state == ReminderState.Done) r.CompletedAt = now;
    }

    private static string? Text(string? s, int max) => s is null ? null : s.Length <= max ? s : s[..(max - 1)] + "…";

    // ------------------------------------------------------------------ morning briefing

    /// <summary>
    /// Once a working day, at each person's briefing time (and within three hours of it, so a late server never sends yesterday's news
    /// at teatime): what is due today, what is overdue and which reminders are coming - per workspace, only when there is something to say.
    /// </summary>
    public async Task<int> BriefAsync(DateTime now, CancellationToken ct = default)
    {
        var people = await (from m in db.TenantMembers.IgnoreQueryFilters().AsNoTracking()
                            join t in db.Tenants.IgnoreQueryFilters().AsNoTracking() on m.TenantId equals t.Id
                            join u in db.Users.AsNoTracking() on m.UserId equals u.Id
                            where !t.IsDeleted && t.Status == TenantStatus.Active && u.IsActive && !u.IsPlatformAdmin
                            select new { m.TenantId, m.UserId, u.TimeZone }).ToListAsync(ct);
        if (people.Count == 0) return 0;
        var userIds = people.Select(p => p.UserId).Distinct().ToList();
        var settings = await db.ReminderSettings.Where(s => userIds.Contains(s.UserId)).ToDictionaryAsync(s => s.UserId, ct);

        // Who is due a briefing now.
        var due = new List<(Guid Tenant, Guid User, DateOnly Today, NodaTime.DateTimeZone Tz)>();
        foreach (var person in people.GroupBy(p => p.UserId))
        {
            var s = settings.GetValueOrDefault(person.Key);
            if (s is { BriefingEnabled: false }) continue;
            var tz = ZoneTime.Find(person.First().TimeZone);
            var local = ZoneTime.ToLocal(now, tz);
            var today = DateOnly.FromDateTime(local);
            var day = today.ToString("yyyyMMdd");
            var cal = new WorkCalendar(s ?? new ReminderSettings());
            var at = TimeOnly.FromDateTime(local);
            var time = s?.BriefingTime ?? new ReminderSettings().BriefingTime;
            if (s?.LastBriefingDay == day || !cal.IsWorkingDay(today) || at < time) continue;
            if (s is null) { s = new ReminderSettings { UserId = person.Key }; db.ReminderSettings.Add(s); settings[person.Key] = s; }
            s.LastBriefingDay = day;
            if (at > time.AddHours(3)) continue;   // too late in the day: skipped, not sent late
            foreach (var p in person) due.Add((p.TenantId, p.UserId, today, tz));
        }
        if (due.Count == 0) { await db.SaveChangesAsync(ct); return 0; }

        var briefed = 0;
        var maxDay = due.Max(d => d.Today);
        var who = due.Select(d => d.User).Distinct().ToList();
        var tenantsOf = due.Select(d => d.Tenant).Distinct().ToList();
        var tasks = await db.Tasks.IgnoreQueryFilters().AsNoTracking().Where(t => !t.IsDeleted && !t.Project!.IsDeleted && t.AssigneeId != null && who.Contains(t.AssigneeId.Value)
                && tenantsOf.Contains(t.TenantId) && t.DueDate != null && t.DueDate <= maxDay && t.Status!.Category != StatusCategory.Done && t.Status.Category != StatusCategory.Cancelled)
            .Select(t => new { t.TenantId, User = t.AssigneeId!.Value, Due = t.DueDate!.Value, Label = t.Project!.Key + "-" + t.Number + " " + t.Title }).Take(5000).ToListAsync(ct);
        var work = await db.WorkTasks.IgnoreQueryFilters().AsNoTracking().Where(w => !w.IsDeleted && w.AssigneeId != null && who.Contains(w.AssigneeId.Value) && tenantsOf.Contains(w.TenantId)
                && w.DueDate != null && w.DueDate <= maxDay && (w.Status == WorkTaskStatus.ToDo || w.Status == WorkTaskStatus.InProgress || w.Status == WorkTaskStatus.OnHold))
            .Select(w => new { w.TenantId, User = w.AssigneeId!.Value, Due = w.DueDate!.Value, w.Kind, w.Number, w.Title }).Take(5000).ToListAsync(ct);
        var items = tasks.Select(t => (t.TenantId, t.User, t.Due, t.Label))
            .Concat(work.Select(w => (w.TenantId, w.User, w.Due, Label: $"{WorkItemService.KeyOf(w.Kind, w.Number)} {w.Title}"))).ToList();
        var horizon = now.AddHours(30);
        var reminders = await db.Reminders.IgnoreQueryFilters().AsNoTracking().Where(r => who.Contains(r.UserId) && tenantsOf.Contains(r.TenantId)
                && (r.State == ReminderState.Fired || r.State == ReminderState.Scheduled && r.NextFireAt != null && r.NextFireAt <= horizon))
            .Select(r => new { r.TenantId, r.UserId, r.State, r.NextFireAt, r.Title }).ToListAsync(ct);

        foreach (var (tenant, user, today, tz) in due)
        {
            var mine = items.Where(i => i.TenantId == tenant && i.User == user).ToList();
            var dueToday = mine.Where(i => i.Due == today).ToList();
            var overdue = mine.Where(i => i.Due < today).ToList();
            var endOfDay = ZoneTime.ToUtc(ZoneTime.At(today.AddDays(1), TimeOnly.MinValue), tz);
            var rem = reminders.Where(r => r.TenantId == tenant && r.UserId == user && (r.State == ReminderState.Fired || r.NextFireAt < endOfDay)).ToList();
            if (dueToday.Count + overdue.Count + rem.Count == 0) continue;
            var parts = new List<string>();
            if (dueToday.Count > 0) parts.Add($"{dueToday.Count} due today");
            if (overdue.Count > 0) parts.Add($"{overdue.Count} overdue");
            if (rem.Count > 0) parts.Add($"{rem.Count} reminder{(rem.Count == 1 ? "" : "s")}");
            var lines = overdue.Select(i => "Overdue: " + i.Label).Concat(dueToday.Select(i => "Today: " + i.Label)).Concat(rem.Select(r => "Reminder: " + r.Title)).Take(6);
            var n = new Notification
            {
                TenantId = tenant, UserId = user, Type = NotificationType.Briefing, CreatedAt = now, Link = "/reminders",
                Title = "Your day: " + string.Join(", ", parts), Body = Text(string.Join("\n", lines), 500), DedupeKey = $"brief:{tenant:N}:{user:N}:{today:yyyyMMdd}",
            };
            if (await router.ApplyAsync(n, ct)) { db.Notifications.Add(n); briefed++; }
        }
        await db.SaveChangesAsync(ct);
        return briefed;
    }
}

/// <summary>
/// Keeps the automatic reminders in step with the work: for every open, dated, assigned task, action item, operational work task and
/// milestone it works out which reminders the person's settings ask for (working days before the due date, follow-ups once it is
/// overdue, an early "time to start" for big pieces of work, and - on Business plans - the workspace's escalation ladder), creates the
/// ones that are missing and withdraws (deletes) the waiting ones the work no longer calls for (finished, moved, reassigned, deleted), so
/// they come back if the work moves back. A reminder the person dismissed stays Cancelled with its key, so it is not made again. Reminders about finished work leave "needs attention" by themselves, and
/// personal reminders set relative to a due date follow it when it moves.
/// </summary>
public class ReminderPlanner(IAppDbContext db, EntitlementService entitlements, ILogger<ReminderPlanner> log)
{
    private const int Cap = 5000;
    private static readonly ReminderSource[] Automatic = [ReminderSource.DueDate, ReminderSource.Overdue, ReminderSource.Escalation];

    private sealed record Item(ReminderTarget Type, Guid Id, Guid TenantId, string Key, string Title, Guid? ProjectId, string Link, DateOnly Due, Guid Assignee, Guid? Owner, decimal? Estimate);
    private sealed record Want(string Key, Item Item, Guid User, ReminderSource Source, string Title, string Zone, DateTime Local, DateTime Utc);

    public async Task<int> PlanAsync(DateTime now, CancellationToken ct = default)
    {
        var today = DateOnly.FromDateTime(now);
        var from = today.AddDays(-40);
        var to = today.AddDays(30);
        var items = new List<Item>();

        var tasks = await db.Tasks.IgnoreQueryFilters().AsNoTracking()
            .Where(t => !t.IsDeleted && !t.Project!.IsDeleted && t.AssigneeId != null && t.DueDate >= from && t.DueDate <= to
                && t.Status!.Category != StatusCategory.Done && t.Status.Category != StatusCategory.Cancelled
                && db.Tenants.IgnoreQueryFilters().Any(x => x.Id == t.TenantId && !x.IsDeleted && x.Status == TenantStatus.Active))
            .Select(t => new { t.Id, t.TenantId, t.Number, t.Title, t.ProjectId, Key = t.Project!.Key, Owner = t.Project.OwnerId, Due = t.DueDate!.Value, Assignee = t.AssigneeId!.Value, t.EstimatedHours })
            .Take(Cap).ToListAsync(ct);
        items.AddRange(tasks.Select(t => new Item(ReminderTarget.Task, t.Id, t.TenantId, $"{t.Key}-{t.Number}", t.Title, t.ProjectId, $"/projects/{t.ProjectId}?task={t.Id}", t.Due, t.Assignee, t.Owner, t.EstimatedHours)));

        var work = await db.WorkTasks.IgnoreQueryFilters().AsNoTracking()
            .Where(w => !w.IsDeleted && w.AssigneeId != null && w.DueDate >= from && w.DueDate <= to
                && (w.Status == WorkTaskStatus.ToDo || w.Status == WorkTaskStatus.InProgress || w.Status == WorkTaskStatus.OnHold)
                && (w.Kind == WorkTaskKind.Operational || db.Projects.IgnoreQueryFilters().Any(p => p.Id == w.RelatedProjectId && !p.IsDeleted))
                && db.Tenants.IgnoreQueryFilters().Any(x => x.Id == w.TenantId && !x.IsDeleted && x.Status == TenantStatus.Active))
            .Select(w => new { w.Id, w.TenantId, w.Kind, w.Number, w.Title, w.RelatedProjectId, Due = w.DueDate!.Value, Assignee = w.AssigneeId!.Value, w.ReporterId,
                ProjectOwner = db.Projects.IgnoreQueryFilters().Where(p => p.Id == w.RelatedProjectId).Select(p => (Guid?)p.OwnerId).FirstOrDefault() })
            .Take(Cap).ToListAsync(ct);
        items.AddRange(work.Select(w => w.Kind == WorkTaskKind.ActionItem
            ? new Item(ReminderTarget.ActionItem, w.Id, w.TenantId, WorkItemService.KeyOf(w.Kind, w.Number), w.Title, w.RelatedProjectId, ActionItemService.LinkOf(w.RelatedProjectId!.Value, w.Id), w.Due, w.Assignee, w.ProjectOwner, null)
            : new Item(ReminderTarget.Operational, w.Id, w.TenantId, WorkItemService.KeyOf(w.Kind, w.Number), w.Title, w.RelatedProjectId, WorkTaskService.LinkOf(w.Id), w.Due, w.Assignee, w.ReporterId, null)));

        var milestones = await db.Milestones.IgnoreQueryFilters().AsNoTracking()
            .Where(m => !m.IsDeleted && m.OwnerId != null && m.DueDate >= from && m.DueDate <= to && m.Status != StageStatus.Completed
                && db.Projects.IgnoreQueryFilters().Any(p => p.Id == m.ProjectId && !p.IsDeleted)
                && db.Tenants.IgnoreQueryFilters().Any(x => x.Id == m.TenantId && !x.IsDeleted && x.Status == TenantStatus.Active))
            .Select(m => new { m.Id, m.TenantId, m.Name, m.ProjectId, Due = m.DueDate!.Value, Owner = m.OwnerId!.Value,
                Key = db.Projects.IgnoreQueryFilters().Where(p => p.Id == m.ProjectId).Select(p => p.Key).FirstOrDefault(),
                ProjectOwner = db.Projects.IgnoreQueryFilters().Where(p => p.Id == m.ProjectId).Select(p => p.OwnerId).FirstOrDefault() })
            .Take(Cap).ToListAsync(ct);
        items.AddRange(milestones.Select(m => new Item(ReminderTarget.Milestone, m.Id, m.TenantId, $"{m.Key} milestone", m.Name, m.ProjectId, $"/projects/{m.ProjectId}?tab=plan", m.Due, m.Owner, m.ProjectOwner, null)));
        var complete = tasks.Count < Cap && work.Count < Cap && milestones.Count < Cap;

        // The people involved: assignees, and for escalation their managers and the owners.
        var tenantIds = items.Select(i => i.TenantId).Distinct().ToList();
        var members = await db.TenantMembers.IgnoreQueryFilters().AsNoTracking().Where(m => tenantIds.Contains(m.TenantId))
            .Select(m => new { m.TenantId, m.UserId, m.ReportsToUserId }).ToListAsync(ct);
        var memberOf = members.ToDictionary(m => (m.TenantId, m.UserId), m => m.ReportsToUserId);
        var userIds = members.Select(m => m.UserId).Distinct().ToList();
        var users = await db.Users.AsNoTracking().Where(u => userIds.Contains(u.Id) && u.IsActive).ToDictionaryAsync(u => u.Id, u => new { u.TimeZone, u.DisplayName }, ct);
        var settings = await db.ReminderSettings.AsNoTracking().Where(s => userIds.Contains(s.UserId)).ToDictionaryAsync(s => s.UserId, ct);
        var policies = await db.ReminderPolicies.IgnoreQueryFilters().AsNoTracking().Where(p => p.EscalationEnabled && tenantIds.Contains(p.TenantId)).ToListAsync(ct);
        var ladders = new Dictionary<Guid, IReadOnlyList<EscalationStep>>();
        foreach (var p in policies)
            if ((await entitlements.GetEntitlementsAsync(p.TenantId, ct)).GetValueOrDefault(FeatureKeys.ReminderEscalation) > 0)
                ladders[p.TenantId] = EscalationStep.Parse(p.Steps);

        var wants = new List<Want>();
        foreach (var item in items)
        {
            if (!memberOf.ContainsKey((item.TenantId, item.Assignee)) || !users.TryGetValue(item.Assignee, out var assignee)) continue;
            var code = item.Type.ToString().ToLowerInvariant();
            var s = settings.GetValueOrDefault(item.Assignee) ?? new ReminderSettings();
            var cal = new WorkCalendar(s);
            void Add(string step, Guid user, string zone, ReminderSource source, string title, DateOnly day, TimeOnly time)
            {
                var local = ZoneTime.At(day, time);
                wants.Add(new Want($"auto:{code}:{item.Id:N}:{user:N}:{step}:{item.Due:yyyyMMdd}", item, user, source, title, zone, local, ZoneTime.ToUtc(local, ZoneTime.Find(zone))));
            }
            string When(DateOnly d) => d.ToString("ddd d MMM", System.Globalization.CultureInfo.InvariantCulture);

            if (s.AutoEnabled)
            {
                var leads = WorkCalendar.ParseNumbers(s.DueLeads, 0, 10);
                foreach (var n in leads)
                {
                    var day = cal.WorkingDaysBefore(item.Due, n);
                    var title = day == item.Due ? $"{item.Key} is due today" : day.AddDays(1) == item.Due ? $"{item.Key} is due tomorrow" : $"{item.Key} is due {When(item.Due)}";
                    Add($"L{n}", item.Assignee, assignee.TimeZone, ReminderSource.DueDate, title, day, s.DefaultTime);
                }
                // Big pieces of work get a nudge to start in time: a working day per eight hours of estimate.
                if (item.Estimate is >= 8 && (int)Math.Min(10, Math.Ceiling((double)item.Estimate.Value / 8)) is var start && start > (leads.Count == 0 ? 0 : leads.Max()))
                    Add("W", item.Assignee, assignee.TimeZone, ReminderSource.DueDate, $"Time to start {item.Key}: about {item.Estimate:0} h of work, due {When(item.Due)}",
                        cal.WorkingDaysBefore(item.Due, start), s.DefaultTime);
                foreach (var n in WorkCalendar.ParseNumbers(s.OverdueSteps, 1, 30))
                    Add($"O{n}", item.Assignee, assignee.TimeZone, ReminderSource.Overdue, $"{item.Key} is {n} day{(n == 1 ? "" : "s")} overdue", cal.WorkingOnOrAfter(item.Due.AddDays(n)), s.DefaultTime);
            }

            if (ladders.TryGetValue(item.TenantId, out var ladder))
                foreach (var step in ladder)
                {
                    var to2 = step.Who == "Manager" ? memberOf.GetValueOrDefault((item.TenantId, item.Assignee)) : item.Owner;
                    if (to2 is not { } recipient || recipient == item.Assignee || !memberOf.ContainsKey((item.TenantId, recipient)) || !users.TryGetValue(recipient, out var r)) continue;
                    var rs = settings.GetValueOrDefault(recipient) ?? new ReminderSettings();
                    Add($"E{step.Days}{step.Who}", recipient, r.TimeZone, ReminderSource.Escalation, $"{item.Key} is {step.Days} days overdue ({assignee.DisplayName})",
                        new WorkCalendar(rs).WorkingOnOrAfter(item.Due.AddDays(step.Days)), rs.DefaultTime);
                }
        }

        // Keep what is still wanted (a reminder waiting for working hours may sit a little past its time); create what is new and close at hand.
        var keep = wants.Where(w => w.Utc >= now.AddDays(-3) && w.Utc <= now.AddDays(8)).GroupBy(w => w.Key).Select(g => g.First()).ToList();
        var keepKeys = keep.Select(w => w.Key).ToHashSet();
        var known = new HashSet<string>();
        foreach (var chunk in keep.Select(w => w.Key).Chunk(400))
        {
            var list = chunk.ToList();
            known.UnionWith(await db.Reminders.IgnoreQueryFilters().Where(r => r.SystemKey != null && list.Contains(r.SystemKey)).Select(r => r.SystemKey!).ToListAsync(ct));
        }
        var created = 0;
        foreach (var w in keep.Where(w => !known.Contains(w.Key) && w.Utc >= now.AddHours(-2)))
        {
            db.Reminders.Add(new Reminder
            {
                TenantId = w.Item.TenantId, UserId = w.User, Source = w.Source, Title = w.Title, TargetType = w.Item.Type, TargetId = w.Item.Id,
                TargetKey = w.Item.Key, TargetTitle = w.Item.Title.Length > 200 ? w.Item.Title[..200] : w.Item.Title, TargetProjectId = w.Item.ProjectId, Link = w.Item.Link,
                TimeZone = w.Zone, LocalAt = ZoneTime.Write(w.Local), OnlyIfOpen = true, Exact = false, NextFireAt = w.Utc, SystemKey = w.Key, CreatedAt = now,
            });
            created++;
        }
        await db.SaveChangesAsync(ct);

        // Withdraw waiting automatic reminders the work no longer calls for.
        if (complete)
        {
            var waiting = await db.Reminders.IgnoreQueryFilters().AsNoTracking()
                .Where(r => r.State == ReminderState.Scheduled && r.SystemKey != null && Automatic.Contains(r.Source)).Select(r => new { r.Id, r.SystemKey }).ToListAsync(ct);
            var stale = waiting.Where(r => !keepKeys.Contains(r.SystemKey!)).Select(r => r.Id).ToList();
            foreach (var chunk in stale.Chunk(400))
            {
                var ids = chunk.ToList();
                await db.Reminders.IgnoreQueryFilters().Where(r => ids.Contains(r.Id) && r.State == ReminderState.Scheduled).ExecuteDeleteAsync(ct);
            }
        }
        else log.LogWarning("Reminder planning saw more than {Cap} dated items of one kind; waiting reminders were left as they are this time", Cap);

        // Reminders about work: finished with the work, gone with it, and - when set relative to the due date - moved with it.
        var watched = await db.Reminders.IgnoreQueryFilters()
            .Where(r => r.TargetId != null && (r.State == ReminderState.Scheduled || r.State == ReminderState.Fired) && (r.OnlyIfOpen || r.AnchorDays != null))
            .Take(Cap * 2).ToListAsync(ct);
        var states = await TargetStates.LoadAsync(db, watched.Select(r => (r.TargetType, r.TargetId!.Value)), ct);
        foreach (var r in watched)
        {
            if (!states.TryGetValue((r.TargetType, r.TargetId!.Value), out var st)) { r.State = ReminderState.Cancelled; r.NextFireAt = null; continue; }
            if (r.OnlyIfOpen && !st.Open)
            {
                // Automatic ones that never went off simply go; anything the person saw counts as done with the work.
                if (r.State == ReminderState.Scheduled && Automatic.Contains(r.Source)) db.Reminders.Remove(r);
                else { r.State = ReminderState.Done; r.CompletedAt = now; r.NextFireAt = null; }
                continue;
            }
            if (r.AnchorDays is not null && r.State == ReminderState.Scheduled && !r.IsSnoozed && st.Due is { } due)
            {
                var next = ReminderService.AnchoredFire(r, due);
                if (next != r.NextFireAt && next > now) r.NextFireAt = next;
            }
        }
        await db.SaveChangesAsync(ct);
        return created;
    }
}

/// <summary>Done and snooze from the links in e-mails and push notifications, which carry a one-time key instead of a sign-in.</summary>
public class ReminderActionService(IAppDbContext db, AppClock clock)
{
    private async Task<Reminder?> FindAsync(string token, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(token) || token.Length > 100) return null;
        var hash = ReminderService.HashToken(token.Trim());
        return await db.Reminders.IgnoreQueryFilters().FirstOrDefaultAsync(r => r.ActionTokenHash == hash, ct);
    }

    public async Task<ReminderActionInfoDto> InfoAsync(string token, CancellationToken ct = default)
    {
        var r = await FindAsync(token, ct);
        return r is null ? new ReminderActionInfoDto(false, null, null, null, null, null, null, false, null, null) : await InfoAsync(r, ct);
    }

    private async Task<ReminderActionInfoDto> InfoAsync(Reminder r, CancellationToken ct)
    {
        var workspace = await db.Tenants.IgnoreQueryFilters().Where(t => t.Id == r.TenantId).Select(t => t.Name).FirstOrDefaultAsync(ct);
        return new ReminderActionInfoDto(r.ActionTokenExpiresAt > clock.Now, r.Title, r.Note, r.TargetKey, r.Link, r.State, r.NextFireAt, r.IsSnoozed, r.TimeZone, workspace);
    }

    public async Task<ReminderActionInfoDto> ActAsync(string token, ReminderActionRequest req, CancellationToken ct = default)
    {
        var r = await FindAsync(token, ct) ?? throw new NotFoundException("This link is no longer valid.");
        var now = clock.Now;
        if (r.ActionTokenExpiresAt is not { } exp || exp <= now) throw new ConflictException("This link has already been used or has expired. Open the app to change the reminder.", "REMINDER_LINK_USED");
        var user = await db.Users.AsNoTracking().FirstAsync(u => u.Id == r.UserId, ct);
        switch ((req.Action ?? "").Trim().ToLowerInvariant())
        {
            case "done":
                ReminderService.Complete(db, r, now);
                break;
            case "snooze":
                var settings = await db.ReminderSettings.AsNoTracking().FirstOrDefaultAsync(s => s.UserId == r.UserId, ct) ?? new ReminderSettings { UserId = r.UserId };
                ReminderService.Snooze(r, new SnoozeRequest(req.Preset ?? "1h", null, null), settings, ZoneTime.Find(user.TimeZone), now);
                break;
            default:
                throw new ValidationException("action", "Choose done or snooze.");
        }
        // One use: the link now only shows where the reminder stands.
        r.ActionTokenExpiresAt = now;
        await db.SaveChangesAsync(ct);
        return await InfoAsync(r, ct);
    }
}
