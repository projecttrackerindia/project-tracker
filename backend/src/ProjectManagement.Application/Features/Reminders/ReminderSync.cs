using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Services;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.Work;
using ProjectManagement.Application.Features.WorkItems;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Reminders;

/// <summary>
/// Keeps one piece of work's reminders in step with it the moment it changes, instead of waiting for the planner's next pass. Called by
/// every write path of tasks, tickets, action items and issues (status, delete, restore, due date, assignee, rename), after they saved:
/// <list type="bullet">
/// <item>deleted: its open reminders become <em>orphaned</em> (Cancelled, marked with <see cref="Orphaned"/>) and come back on restore;</item>
/// <item>finished: reminders kept "only while open" finish with it (automatic ones that never went off simply go);</item>
/// <item>due date or assignee changed: automatic reminders that no longer fit (another day, another person) are withdrawn or closed;</item>
/// <item>due date cleared: personal reminders counted from it are paused (Cancelled, marked <see cref="DuePaused"/>) and the person is told;
/// a new due date brings them back, rescheduled; a moved due date moves them;</item>
/// <item>renamed or moved: the key, title and link every reminder shows are refreshed.</item>
/// </list>
/// The two marks reuse <see cref="Reminder.LockToken"/>, which only ever matters while a reminder is Scheduled and being fired, so a
/// Cancelled reminder can carry why it was stopped without a new column.
/// </summary>
public class ReminderSync(IAppDbContext db, AppClock clock, NotificationService notifications)
{
    /// <summary>Stopped because its work was deleted; revived when the work is restored.</summary>
    public static readonly Guid Orphaned = new("0a0a0a0a-0000-4000-8000-00000000de1e");
    /// <summary>Stopped because the due date it was counted from was cleared; revived when the work has a due date again.</summary>
    public static readonly Guid DuePaused = new("0a0a0a0a-0000-4000-8000-0000000d0e00");

    private static readonly ReminderSource[] Automatic = [ReminderSource.DueDate, ReminderSource.Overdue, ReminderSource.Escalation];

    /// <summary>What a reminder shows about its work: the key, title and link (null when the work is gone).</summary>
    public sealed record Display(string Key, string Title, Guid? ProjectId, string Link);

    public static bool IsOrphaned(Reminder r) => r.State == ReminderState.Cancelled && r.LockToken == Orphaned;
    public static bool IsDuePaused(Reminder r) => r.State == ReminderState.Cancelled && r.LockToken == DuePaused;

    public async Task OnWorkChangedAsync(ReminderTarget type, Guid id, CancellationToken ct = default)
    {
        if (type is not (ReminderTarget.Task or ReminderTarget.Issue or ReminderTarget.ActionItem or ReminderTarget.Operational)) return;
        var rows = await db.Reminders.Where(r => r.TargetType == type && r.TargetId == id
            && (r.State == ReminderState.Scheduled || r.State == ReminderState.Fired || r.State == ReminderState.Cancelled && (r.LockToken == Orphaned || r.LockToken == DuePaused)))
            .ToListAsync(ct);
        if (rows.Count == 0) return;
        var now = clock.Now;
        var states = await TargetStates.LoadAsync(db, [(type, id)], ct);
        var display = await DisplayAsync(type, id, ct);
        Apply(db, rows, states.TryGetValue((type, id), out var st) ? st : null, display, now, out var paused);
        foreach (var r in paused)
            await notifications.AddAsync(r.UserId, NotificationType.Reminder, $"Reminder paused: {r.Title}",
                $"{r.TargetKey ?? "The work"} no longer has a due date, so the reminder counted from it is paused. It comes back when a due date is set.",
                r.Link, toSelf: true, ct: ct);
        await db.SaveChangesAsync(ct);
    }

    /// <summary>The rules, on reminders already loaded (tracked). <paramref name="state"/> null: the work is deleted.</summary>
    public static void Apply(IAppDbContext db, IEnumerable<Reminder> rows, TargetState? state, Display? display, DateTime now, out List<Reminder> paused)
    {
        paused = [];
        foreach (var r in rows)
        {
            if (state is null)
            {
                // Deleted: stop it, but remember why (and when it was due) so a restore brings it back as it was.
                if (r.State is ReminderState.Scheduled or ReminderState.Fired) { r.State = ReminderState.Cancelled; r.LockToken = Orphaned; r.LockedUntil = null; r.ActionTokenHash = null; }
                continue;
            }
            if (display is not null) { r.TargetKey = display.Key; r.TargetTitle = display.Title.Length > 200 ? display.Title[..200] : display.Title; r.TargetProjectId = display.ProjectId; r.Link = display.Link; }

            if (IsOrphaned(r))
            {
                // Restored: back to waiting (or "needs you", if its time passed meanwhile). Automatic ones whose time passed go; the planner remakes what is still wanted.
                r.LockToken = null;
                if (r.NextFireAt is { } next && next > now) r.State = ReminderState.Scheduled;
                else if (Automatic.Contains(r.Source)) { db.Reminders.Remove(r); continue; }
                else { r.State = ReminderState.Fired; r.LastFiredAt ??= now; }
            }

            if (r.OnlyIfOpen && !state.Open)
            {
                if (r.State == ReminderState.Cancelled) continue;
                if (r.State == ReminderState.Scheduled && Automatic.Contains(r.Source)) db.Reminders.Remove(r);
                else { r.State = ReminderState.Done; r.CompletedAt = now; r.NextFireAt = null; r.ActionTokenHash = null; }
                continue;
            }

            if (Automatic.Contains(r.Source) && r.State is ReminderState.Scheduled or ReminderState.Fired && !ReminderEngine.StillMatches(r, state))
            {
                // Planned for another due date or another person: the waiting one is withdrawn, the one already showing is closed.
                if (r.State == ReminderState.Scheduled) db.Reminders.Remove(r);
                else { r.State = ReminderState.Cancelled; r.NextFireAt = null; r.ActionTokenHash = null; }
                continue;
            }

            if (r.AnchorDays is not null)
            {
                if (state.Due is not { } due)
                {
                    if (r.State is ReminderState.Scheduled or ReminderState.Fired)
                    {
                        r.State = ReminderState.Cancelled; r.LockToken = DuePaused; r.NextFireAt = null; r.ActionTokenHash = null;
                        paused.Add(r);
                    }
                    continue;
                }
                var at = ReminderService.AnchoredFire(r, due);
                if (IsDuePaused(r))
                {
                    r.LockToken = null; r.IsSnoozed = false;
                    r.NextFireAt = at > now ? at : now;
                    r.State = ReminderState.Scheduled;
                }
                else if (r.State == ReminderState.Scheduled && !r.IsSnoozed && at != r.NextFireAt && at > now) r.NextFireAt = at;
            }
        }
    }

    /// <summary>Key, title and link of a piece of work, read across the caller's workspace (deleted work: null).</summary>
    public async Task<Display?> DisplayAsync(ReminderTarget type, Guid id, CancellationToken ct)
    {
        switch (type)
        {
            case ReminderTarget.Task:
            {
                var t = await db.Tasks.AsNoTracking().Where(x => x.Id == id).Select(x => new { x.Number, x.Title, x.ProjectId, Key = x.Project!.Key }).FirstOrDefaultAsync(ct);
                return t is null ? null : new($"{t.Key}-{t.Number}", t.Title, t.ProjectId, $"/projects/{t.ProjectId}?task={id}");
            }
            case ReminderTarget.Issue:
            {
                var i = await (from x in db.StageIssues.AsNoTracking()
                               join p in db.Projects.AsNoTracking() on x.ProjectId equals p.Id
                               where x.Id == id
                               select new { x.Number, x.Title, x.ProjectId, p.Key }).FirstOrDefaultAsync(ct);
                return i is null ? null : new($"{i.Key}-I{i.Number}", i.Title, i.ProjectId, IssueLink(i.ProjectId, id));
            }
            default:
            {
                var w = await db.WorkTasks.AsNoTracking().Where(x => x.Id == id).Select(x => new { x.Kind, x.Number, x.Title, x.RelatedProjectId }).FirstOrDefaultAsync(ct);
                if (w is null) return null;
                return new(WorkItemService.KeyOf(w.Kind, w.Number), w.Title, w.RelatedProjectId,
                    w.Kind == WorkTaskKind.ActionItem && w.RelatedProjectId is { } pid ? ActionItemService.LinkOf(pid, id) : WorkTaskService.LinkOf(id));
            }
        }
    }

    public static string IssueLink(Guid projectId, Guid issueId) => $"/projects/{projectId}?tab=issues&issue={issueId}";
}
