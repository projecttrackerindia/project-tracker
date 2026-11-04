using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Projects;

/// <summary>
/// What a deleted project or task leaves behind that the query filters cannot hide on their own, because it points at the work only by a
/// link or a copied id: reminders (stopped as <em>orphaned</em>, the same mark a task delete uses, so nothing is lost) and notifications
/// (archived: out of the inbox, still under Archived). Rows that carry a ProjectId or TaskId column disappear through the query filter
/// (see AppDbContext.QueryFilters). Nothing is ever removed. Runs inside the signed-in workspace (the normal tenant filter applies).
/// </summary>
public static class DeletedWorkTraces
{
    private const int Chunk = 500;

    /// <summary>Reminders about the project (or any of the listed items in it): open ones stop, marked orphaned.</summary>
    public static async Task<int> OrphanRemindersAsync(IAppDbContext db, Guid? projectId, IReadOnlyCollection<Guid> workIds, CancellationToken ct)
    {
        var rows = new List<Reminder>();
        if (projectId is { } pid)
            rows.AddRange(await db.Reminders.Where(r => r.TargetProjectId == pid && (r.State == ReminderState.Scheduled || r.State == ReminderState.Fired)).ToListAsync(ct));
        foreach (var part in workIds.Chunk(Chunk))
        {
            var ids = part.ToList();
            rows.AddRange(await db.Reminders.Where(r => r.TargetId != null && ids.Contains(r.TargetId.Value) && (r.State == ReminderState.Scheduled || r.State == ReminderState.Fired)).ToListAsync(ct));
        }
        var n = 0;
        foreach (var r in rows.DistinctBy(r => r.Id))
        {
            r.State = ReminderState.Cancelled; r.LockToken = ReminderSync.Orphaned; r.LockedUntil = null; r.ActionTokenHash = null; n++;
        }
        return n;
    }

    /// <summary>The links notifications use for a project, a task or an action item (see the notification senders).</summary>
    public static IEnumerable<string> LinkPatterns(Guid? projectId, IEnumerable<Guid> workIds)
    {
        if (projectId is { } pid) yield return $"/projects/{pid}";
        foreach (var id in workIds)
        {
            yield return $"task={id}";
            yield return $"action={id}";
            yield return $"issue={id}";
            yield return $"/tasks/{id}";
        }
    }

    /// <summary>Notifications that open the deleted project or item: archived (and read), never removed.</summary>
    public static async Task<int> ArchiveNotificationsAsync(IAppDbContext db, DateTime now, Guid? projectId, IReadOnlyCollection<Guid> workIds, CancellationToken ct)
    {
        var n = 0;
        foreach (var pattern in LinkPatterns(projectId, workIds))
        {
            var p = pattern;
            var rows = await db.Notifications.Where(x => x.ArchivedAt == null && x.Link != null && x.Link.Contains(p)).ToListAsync(ct);
            foreach (var x in rows) { x.ArchivedAt = now; x.ReadAt ??= now; n++; }
        }
        return n;
    }
}
