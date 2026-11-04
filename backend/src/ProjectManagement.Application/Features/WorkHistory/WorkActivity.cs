using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Platform;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.WorkHistory;

/// <summary>
/// One line of an item's activity: who did what and when. A field change carries the field and its old and new value; an event (created,
/// deleted, restored, commented, completed ...) has no field. A date moved later carries the reason that was given.
/// </summary>
/// <param name="Action">updated (a field changed), date_extended / date_changed (a date moved later / earlier), or the event: created, deleted, restored, commented, completed, assigned ...</param>
public record ActivityEntryDto(Guid Id, DateTime At, UserRefDto? Actor, string Action, string? Field, string? From, string? To, string Summary, string? Reason = null);

/// <summary>The kinds the activity API knows (its entityType parameter).</summary>
public static class ActivityKinds
{
    public const string Task = "task", Project = "project", ActionItem = "actionitem", Reminder = "reminder", Note = "note", Approval = "approval";
    public static readonly string[] All = [Task, Project, ActionItem, Reminder, Note, Approval];

    /// <summary>"Task", "action-item", "action_item", "ActionItem" … → the canonical kind, or null when unknown.</summary>
    public static string? Parse(string? kind)
    {
        var k = (kind ?? "").Trim().ToLowerInvariant().Replace("-", "").Replace("_", "");
        return k switch
        {
            "task" or "tasks" => Task, "project" or "projects" => Project, "actionitem" or "actionitems" or "action" => ActionItem,
            "reminder" or "reminders" => Reminder, "note" or "notes" => Note, "approval" or "approvals" or "approvalrequest" => Approval, _ => null,
        };
    }
}

/// <summary>
/// GET /api/v1/activity: the field-level history of one task, project, action item, reminder, note or approval, newest first and paged. Built from
/// what every save already records (the field diffs in the tamper-evident audit log, the activity rows, the date history with its reasons), so
/// nothing is written twice. The caller must be allowed to see the item (otherwise 404, the same answer as for an item that does not exist), and
/// everything is read inside the signed-in workspace only.
/// </summary>
public class WorkActivityService(IAppDbContext db, ICurrentContext ctx, ProjectAccess access,
    ProjectManagement.Application.Features.Notes.NoteService notes, ProjectManagement.Application.Features.Approvals.ApprovalService approvals)
{
    public const int MaxPageSize = 100, MaxScanned = 1000;

    public async Task<PagedResult<ActivityEntryDto>> ListAsync(string? entityType, Guid entityId, int page = 1, int pageSize = 50, CancellationToken ct = default)
    {
        var kind = ActivityKinds.Parse(entityType) ?? throw new ValidationException("entityType", $"Choose one of: {string.Join(", ", ActivityKinds.All)}.");
        if (entityId == Guid.Empty) throw new ValidationException("entityId", "Say which item.");
        page = Math.Max(1, page);
        pageSize = Math.Clamp(pageSize, 1, MaxPageSize);
        var tid = ctx.RequireTenantId();
        await EnsureVisibleAsync(kind, entityId, ct);

        var rows = new List<ActivityEntryDto>();

        // 1. Field changes: one audit row per save, old and new values keyed by field.
        var audits = await db.AuditLogs.AsNoTracking().Where(a => a.TenantId == tid && a.EntityId == entityId && a.Action.EndsWith(FieldDiff.ActionSuffix))
            .OrderByDescending(a => a.CreatedAt).Take(MaxScanned).Select(a => new { a.Id, a.CreatedAt, a.UserId, a.OldValue, a.NewValue }).ToListAsync(ct);
        foreach (var a in audits)
        {
            var before = Parse(a.OldValue); var after = Parse(a.NewValue);
            foreach (var field in after.Keys.Union(before.Keys))
            {
                var from = before.GetValueOrDefault(field); var to = after.GetValueOrDefault(field);
                rows.Add(new ActivityEntryDto(Derive(a.Id, field), a.CreatedAt, Actor(a.UserId), "updated", field, from, to, $"{field}: {from ?? "none"} → {to ?? "none"}"));
            }
        }

        // 2. Events (created, deleted, restored, commented ...) from the activity rows; rows with values are field changes from before field diffs existed.
        var since = audits.Count > 0 ? audits.Min(a => a.CreatedAt).AddMinutes(-1) : DateTime.MaxValue;
        var events = await db.Activities.AsNoTracking().Where(a => a.EntityId == entityId)
            .OrderByDescending(a => a.CreatedAt).Take(MaxScanned).Select(a => new { a.Id, a.CreatedAt, a.ActorId, a.Action, a.Summary, a.OldValue, a.NewValue }).ToListAsync(ct);
        foreach (var e in events)
        {
            var hasValues = e.OldValue is not null || e.NewValue is not null;
            if (hasValues && e.CreatedAt >= since) continue;   // the same change is already in the field diff
            if (!hasValues && IsPlainUpdate(e.Action) && audits.Any(a => Math.Abs((a.CreatedAt - e.CreatedAt).TotalSeconds) < 60)) continue;
            rows.Add(hasValues
                ? new ActivityEntryDto(e.Id, e.CreatedAt, Actor(e.ActorId), "updated", HistoryService.FieldOf(e.Action), e.OldValue, e.NewValue, e.Summary)
                : new ActivityEntryDto(e.Id, e.CreatedAt, Actor(e.ActorId), EventOf(e.Action), null, null, null, e.Summary));
        }

        // Events kept only in the audit log (a reminder's created / deleted / restored: reminders are personal, so they stay out of the
        // activity feed and its webhooks), unless the activity rows already have the same event.
        var auditEvents = await db.AuditLogs.AsNoTracking().Where(a => a.TenantId == tid && a.EntityId == entityId
                && (a.Action.EndsWith(".created") || a.Action.EndsWith(".deleted") || a.Action.EndsWith(".restored")))
            .OrderByDescending(a => a.CreatedAt).Take(100).Select(a => new { a.Id, a.CreatedAt, a.UserId, a.Action }).ToListAsync(ct);
        foreach (var e in auditEvents)
        {
            var what = EventOf(e.Action);
            if (rows.Any(r => r.Action == what && Math.Abs((r.At - e.CreatedAt).TotalSeconds) < 60)) continue;
            rows.Add(new ActivityEntryDto(e.Id, e.CreatedAt, Actor(e.UserId), what, null, null, null, $"{char.ToUpperInvariant(what[0])}{what[1..]}"));
        }

        // 3. Dates that moved, with the reason given: they replace the plain field change of the same save.
        var dates = await DateChangesAsync(kind, entityId, ct);
        foreach (var d in dates)
        {
            var label = DateLabel(kind, d.EntityType, d.Field);
            var from = d.Previous?.ToString("yyyy-MM-dd"); var to = d.Revised?.ToString("yyyy-MM-dd");
            rows.RemoveAll(r => r.Action == "updated" && r.Field == label && r.To == to && Math.Abs((r.At - d.CreatedAt).TotalSeconds) < 60);
            var later = DueDateHistory.IsLater(d.Previous, d.Revised) || (d.Previous is not null && d.Revised is null && d.Field is null);
            var shift = DueDateHistory.DaysShifted(d.Previous, d.Revised) is { } n && n != 0 ? $" ({Math.Abs(n)} day{(Math.Abs(n) == 1 ? "" : "s")} {(n > 0 ? "later" : "earlier")})" : "";
            rows.Add(new ActivityEntryDto(d.Id, d.CreatedAt, Actor(d.CreatedBy), later ? "date_extended" : "date_changed", label, from, to,
                $"{label}: {from ?? "none"} → {to ?? "none"}{shift}{(string.IsNullOrEmpty(d.Reason) ? "" : $": {d.Reason}")}", d.Reason));
        }

        var ordered = rows.OrderByDescending(r => r.At).ThenBy(r => r.Field).ToList();
        var pageRows = ordered.Skip((page - 1) * pageSize).Take(pageSize).ToList();
        var ids = pageRows.Where(r => r.Actor is not null).Select(r => r.Actor!.Id).Distinct().ToList();
        var names = ids.Count == 0 ? new Dictionary<Guid, string>() : await db.Users.AsNoTracking().Where(u => ids.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        var named = pageRows.Select(r => r.Actor is { } x ? r with { Actor = new UserRefDto(x.Id, names.GetValueOrDefault(x.Id, "Someone")) } : r).ToList();
        return new PagedResult<ActivityEntryDto>(named, page, pageSize, ordered.Count);
    }

    /// <summary>The item must exist in this workspace and the caller must be allowed to see it (404 otherwise, never a hint that it exists).</summary>
    private async Task EnsureVisibleAsync(string kind, Guid id, CancellationToken ct)
    {
        var me = ctx.RequireUserId();
        switch (kind)
        {
            case ActivityKinds.Task:
                if (!await access.VisibleTasks().AsNoTracking().AnyAsync(t => t.Id == id, ct)) throw new NotFoundException("Task not found.");
                break;
            case ActivityKinds.Project:
                await access.GetProjectAsync(id, ct);
                break;
            case ActivityKinds.ActionItem:
            {
                var item = await db.WorkTasks.AsNoTracking().Where(w => w.Id == id && w.Kind == WorkTaskKind.ActionItem).Select(w => new { w.RelatedProjectId }).FirstOrDefaultAsync(ct)
                    ?? throw new NotFoundException("Action item not found.", "ACTION_ITEM_NOT_FOUND");
                if (item.RelatedProjectId is { } pid) await access.GetProjectAsync(pid, ct);
                break;
            }
            case ActivityKinds.Reminder:
                if (!await db.Reminders.AsNoTracking().AnyAsync(r => r.Id == id && (r.UserId == me || r.CreatedBy == me), ct)) throw new NotFoundException("Reminder not found.");
                break;
            case ActivityKinds.Note:
                await notes.GetAsync(id, ct);
                break;
            case ActivityKinds.Approval:
                await approvals.GetAsync(id, ct);
                break;
        }
    }

    private async Task<List<DueDateChange>> DateChangesAsync(string kind, Guid id, CancellationToken ct)
    {
        var q = db.DueDateChanges.AsNoTracking();
        q = kind switch
        {
            // A project's own dates (not its tasks'); its milestones and phases are shown with the project too.
            ActivityKinds.Project => q.Where(c => (c.EntityId == id && (c.EntityType == null || c.EntityType == DateKinds.Project))
                || (c.ProjectId == id && c.TaskId == null && c.EntityType == null && c.Field == null)
                || (c.ProjectId == id && (c.EntityType == DateKinds.Milestone || c.EntityType == DateKinds.Stage))),
            ActivityKinds.Task or ActivityKinds.ActionItem => q.Where(c => c.EntityId == id || c.TaskId == id),
            _ => q.Where(c => false),
        };
        return await q.OrderByDescending(c => c.CreatedAt).Take(MaxScanned).ToListAsync(ct);
    }

    /// <summary>The label a date has in the History (the same words the field diffs use).</summary>
    public static string DateLabel(string kind, string? entityType, string? field) => (entityType, field) switch
    {
        (DateKinds.Stage, DateKinds.Start) => "Phase planned start",
        (DateKinds.Stage, _) => "Phase planned end",
        (DateKinds.Milestone, DateKinds.Start) => "Milestone start date",
        (DateKinds.Milestone, _) => "Milestone due date",
        (_, DateKinds.Start) => "Start date",
        _ => "Due date",
    };

    private static bool IsPlainUpdate(string action) => action.EndsWith(".updated", StringComparison.OrdinalIgnoreCase);

    /// <summary>"task.created" → created, "actionitem.from_meeting" → from_meeting, "approval.approved" → approved.</summary>
    public static string EventOf(string action)
    {
        var i = action.LastIndexOf('.');
        return i >= 0 && i < action.Length - 1 ? action[(i + 1)..] : action;
    }

    private static UserRefDto? Actor(Guid? id) => id is { } u ? new UserRefDto(u, "") : null;

    /// <summary>A stable id for one field of a save that changed several (the audit row's id is shared by all of them).</summary>
    private static Guid Derive(Guid id, string field)
    {
        var bytes = MD5.HashData(Encoding.UTF8.GetBytes($"{id:N}:{field}"));
        return new Guid(bytes);
    }

    private static Dictionary<string, string?> Parse(string? json)
    {
        if (string.IsNullOrWhiteSpace(json) || json[0] != '{') return new();
        try { return JsonSerializer.Deserialize<Dictionary<string, string?>>(json) ?? new(); }
        catch (JsonException) { return new(); }
    }
}

/// <summary>What a change notice is about: the item, where it opens, and which notification kind it is (task, project ...).</summary>
/// <param name="Label">How people know it: "ATL-12", "Action item “Send the deck”", "Project Atlas".</param>
public record WorkNoticeTarget(Guid Id, string Label, string Link, NotificationType Type, bool Watchers = false);

/// <summary>
/// Tells the people on a piece of work that it changed: created, assigned, status or dates changed, commented, completed, deleted, restored.
/// Never the person who made the change. Each person's channels (bell, live, sound, desktop, push, e-mail, digest, quiet hours) are their own
/// notification settings (the router applies them, and the live feed announces new rows after the save commits). A burst of changes to the same
/// item within <see cref="Burst"/> becomes one notice per person, with one line per change, instead of one notice per save.
/// </summary>
public class WorkChangeNotices(IAppDbContext db, ICurrentContext ctx, AppClock clock, NotificationRouter router)
{
    public static readonly TimeSpan Burst = TimeSpan.FromMinutes(2);
    public const string KeyPrefix = "work-change:";
    private const int MaxLines = 8;

    public static string KeyOf(Guid id) => $"{KeyPrefix}{id:N}";

    /// <summary>
    /// Adds (or folds into a recent one) a notice for each person in <paramref name="people"/> (plus the task's watchers when the target asks for
    /// them), except the actor and anyone in <paramref name="except"/>. The caller saves. Returns how many people were told.
    /// </summary>
    public async Task<int> TellAsync(WorkNoticeTarget target, string change, IEnumerable<Guid?> people, CancellationToken ct = default, IEnumerable<Guid>? except = null)
    {
        var tid = ctx.RequireTenantId();
        var who = people.Where(p => p is not null).Select(p => p!.Value).ToHashSet();
        if (target.Watchers)
            who.UnionWith(await db.TaskWatchers.AsNoTracking().Where(w => w.TaskId == target.Id).Select(w => w.UserId).Take(200).ToListAsync(ct));
        if (ctx.UserId is { } actor) who.Remove(actor);
        foreach (var x in except ?? []) who.Remove(x);
        if (who.Count == 0) return 0;
        // Only people still in this workspace.
        var list = who.ToList();
        var members = await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid && list.Contains(m.UserId)).Select(m => m.UserId).ToListAsync(ct);
        if (members.Count == 0) return 0;

        var now = clock.Now;
        var key = KeyOf(target.Id);
        var since = now - Burst;
        // Still unread, not yet e-mailed, and recent: the change is added to that notice.
        var recent = await db.Notifications.Where(n => n.DedupeKey == key && members.Contains(n.UserId) && n.CreatedAt >= since && n.ReadAt == null && n.ArchivedAt == null
            && n.EmailedAt == null).ToListAsync(ct);
        foreach (var pending in db.Notifications.Local.Where(n => n.DedupeKey == key && members.Contains(n.UserId)))
            if (!recent.Contains(pending)) recent.Add(pending);
        // What this same save already put away (a delete archives the item's notices) is not added to.
        recent = recent.Where(n => n.ReadAt == null && n.ArchivedAt == null && n.EmailedAt == null).ToList();
        var told = 0;
        foreach (var user in members)
        {
            var line = Text.Truncate(change, 300)!;
            if (recent.Where(n => n.UserId == user).OrderByDescending(n => n.CreatedAt).FirstOrDefault() is { } open)
            {
                var lines = (open.Body ?? "").Split('\n', StringSplitOptions.RemoveEmptyEntries).ToList();
                if (!lines.Contains(line)) lines.Add(line);
                if (lines.Count > MaxLines) lines = lines.Skip(lines.Count - MaxLines).ToList();
                open.Body = Text.Truncate(string.Join("\n", lines), 500);
                open.Title = Text.Truncate(lines.Count > 1 ? $"{target.Label}: {lines.Count} changes" : $"{target.Label}: {line}", 200)!;
                told++;
                continue;
            }
            var n = new Notification
            {
                TenantId = tid, UserId = user, Type = target.Type, Title = Text.Truncate($"{target.Label}: {line}", 200)!, Body = line, Link = target.Link,
                DedupeKey = key, CreatedAt = now,
            };
            if (await router.ApplyAsync(n, ct)) { db.Notifications.Add(n); told++; }
        }
        return told;
    }

    /// <summary>
    /// A date moved later, with its reason: the item's owner(s), its watchers and the project's manager hear about it (never the person who moved it).
    /// </summary>
    public async Task<int> ExtendedAsync(WorkNoticeTarget target, Guid? projectId, string what, DateOnly? from, DateOnly? to, string? reason, IEnumerable<Guid?> owners, CancellationToken ct = default)
    {
        Guid? manager = projectId is { } pid ? await db.Projects.AsNoTracking().Where(p => p.Id == pid).Select(p => (Guid?)p.OwnerId).FirstOrDefaultAsync(ct) : null;
        var shift = DueDateHistory.DaysShifted(from, to) is { } n && n > 0 ? $" (+{n}d)" : "";
        var line = $"{what} moved {from?.ToString("dd MMM yyyy") ?? "none"} → {to?.ToString("dd MMM yyyy") ?? "none"}{shift}{(string.IsNullOrWhiteSpace(reason) ? "" : $": {reason}")}";
        return await TellAsync(target, line, owners.Append(manager), ct);
    }
}
