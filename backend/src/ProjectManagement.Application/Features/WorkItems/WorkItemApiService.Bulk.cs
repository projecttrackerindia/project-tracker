using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Platform;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.WorkItems;

/// <summary>
/// Bulk edit from a list (Work, Desk queue): one change for up to 200 items of any kind. <see cref="Status"/> is a category (todo, active,
/// done, cancelled) translated to each kind's own status; <see cref="LabelIds"/> are added to tasks (other kinds have no labels);
/// <see cref="ProjectId"/> moves tickets (the related project). <see cref="Delete"/> removes them instead. Send only what changes.
/// </summary>
public record BulkWorkRequest(IReadOnlyList<Guid>? Ids, string? Status = null, Guid? AssigneeId = null, bool Unassign = false, Priority? Priority = null,
    DateOnly? DueDate = null, bool ClearDueDate = false, IReadOnlyList<Guid>? LabelIds = null, Guid? ProjectId = null, bool Delete = false);

public record BulkWorkFailureDto(Guid Id, string? Key, string Reason);
public record BulkWorkResultDto(int Changed, IReadOnlyList<BulkWorkFailureDto> Failed);

public partial class WorkItemApiService
{
    public const int MaxBulk = 200;

    /// <summary>
    /// Each item goes through the same path as a single change (<see cref="PatchAsync"/> or <see cref="DeleteAsync"/>), so every kind's own
    /// permission and workflow rules apply item by item; what may not be changed is reported, the rest is saved, and each changed item gets
    /// one audit entry naming the bulk change.
    /// </summary>
    public async Task<BulkWorkResultDto> BulkAsync(BulkWorkRequest req, CancellationToken ct = default)
    {
        ctx.RequireTenantId();
        var ids = (req.Ids ?? []).Distinct().ToList();
        if (ids.Count == 0) throw new ValidationException("ids", "Choose at least one item.");
        if (ids.Count > MaxBulk) throw new ValidationException("ids", $"Change at most {MaxBulk} items at a time.");
        var status = req.Status?.Trim().ToLowerInvariant();
        if (status is not (null or "" or "todo" or "active" or "done" or "cancelled"))
            throw new ValidationException("status", "Use todo, active, done or cancelled.");
        if (string.IsNullOrEmpty(status)) status = null;
        var labels = (req.LabelIds ?? []).Distinct().ToList();
        if (!req.Delete && status is null && req.AssigneeId is null && !req.Unassign && req.Priority is null && req.DueDate is null && !req.ClearDueDate
            && labels.Count == 0 && req.ProjectId is null)
            throw new ValidationException("ids", "Say what to change.");

        var keys = await db.WorkItems.AsNoTracking().Where(w => ids.Contains(w.Id)).ToDictionaryAsync(w => w.Id, ct);
        var changed = 0;
        var failed = new List<BulkWorkFailureDto>();
        var summary = new { req.Status, req.AssigneeId, req.Unassign, req.Priority, req.DueDate, req.ClearDueDate, LabelIds = labels, req.ProjectId };
        foreach (var id in ids)
        {
            if (!keys.TryGetValue(id, out var item)) { failed.Add(new(id, null, "Not found, or you cannot see it.")); continue; }
            var key = await KeyAsync(item, ct);
            try
            {
                if (req.Delete)
                {
                    await DeleteAsync(id, ct);
                    recorder.Audit("workitem.bulk_deleted", "WorkItem", id, oldValue: new { key, item.Title });
                }
                else
                {
                    var body = await BulkPatchAsync(item, status, req, labels, ct);
                    await PatchAsync(id, body, ct);
                    recorder.Audit("workitem.bulk_updated", "WorkItem", id, newValue: summary);
                }
                await db.SaveChangesAsync(ct);
                changed++;
            }
            catch (AppException ex)
            {
                // Whatever the failed change left half-done stays unsaved: the next item starts clean.
                if (db is DbContext dc) dc.ChangeTracker.Clear();
                failed.Add(new(id, key, ex.Errors.FirstOrDefault()?.Message ?? ex.Message));
            }
        }
        return new BulkWorkResultDto(changed, failed);
    }

    private async Task<string> KeyAsync(WorkItem item, CancellationToken ct) => item switch
    {
        TaskItem t => $"{await db.Projects.AsNoTracking().Where(p => p.Id == t.ProjectId).Select(p => p.Key).FirstOrDefaultAsync(ct)}-{t.Number}",
        StageIssue si => $"{await db.Projects.AsNoTracking().Where(p => p.Id == si.ProjectId).Select(p => p.Key).FirstOrDefaultAsync(ct)}-I{si.Number}",
        WorkTask w => WorkItemService.KeyOf(w.Kind, w.Number),
        _ => item.Number.ToString(),
    };

    /// <summary>The PATCH body one item gets for the bulk change, in that kind's own words.</summary>
    private async Task<JsonElement> BulkPatchAsync(WorkItem item, string? status, BulkWorkRequest req, List<Guid> labels, CancellationToken ct)
    {
        var o = new JsonObject { ["version"] = item.Version };
        if (req.Unassign) o["assigneeId"] = null;
        else if (req.AssigneeId is { } a) o["assigneeId"] = a.ToString();
        if (req.Priority is { } pr) o["priority"] = pr.ToString();
        if (req.ClearDueDate) o["dueDate"] = null;
        else if (req.DueDate is { } d) o["dueDate"] = d.ToString("yyyy-MM-dd");
        if (labels.Count > 0)
        {
            if (item is not TaskItem) throw new ValidationException("labelIds", "Only tasks have labels.");
            var have = await db.TaskLabels.AsNoTracking().Where(l => l.TaskId == item.Id).Select(l => l.LabelId).ToListAsync(ct);
            o["labelIds"] = new JsonArray(have.Union(labels).Select(x => (JsonNode)JsonValue.Create(x.ToString())!).ToArray());
        }
        if (req.ProjectId is { } pid)
        {
            if (item is not WorkTask { Kind: WorkTaskKind.Operational }) throw new ValidationException("projectId", "Only tickets can be moved to another project here.");
            o["projectId"] = pid.ToString();
        }
        if (status is not null)
        {
            switch (item)
            {
                case TaskItem t:
                {
                    var category = status switch { "todo" => StatusCategory.Todo, "active" => StatusCategory.Active, "done" => StatusCategory.Done, _ => StatusCategory.Cancelled };
                    var sid = await db.WorkflowStatuses.AsNoTracking().Where(s => s.ProjectId == t.ProjectId && s.Category == category).OrderBy(s => s.Order).Select(s => (Guid?)s.Id).FirstOrDefaultAsync(ct)
                        ?? throw new ValidationException("status", "This task's project has no column for that status.");
                    o["statusId"] = sid.ToString();
                    break;
                }
                case StageIssue:
                    o["status"] = status switch { "todo" => "Observed", "active" => "InProgress", "done" => "Resolved", _ => throw new ValidationException("status", "Issues cannot be cancelled; resolve them instead.") };
                    break;
                case WorkTask { Kind: WorkTaskKind.ActionItem }:
                    o["status"] = status switch { "todo" => "Open", "active" => "InProgress", "done" => "Completed", _ => throw new ValidationException("status", "Action items cannot be cancelled; complete them instead.") };
                    break;
                default:
                    o["status"] = status switch { "todo" => "ToDo", "active" => "InProgress", "done" => "Completed", _ => "Cancelled" };
                    break;
            }
        }
        return JsonSerializer.SerializeToElement(o);
    }

    /// <summary>An item's History: field changes, who and when, newest first. Opening it needs the same right as opening the item.</summary>
    public async Task<IReadOnlyList<HistoryEntryDto>> HistoryAsync(Guid id, CancellationToken ct = default)
    {
        var item = await FindAsync(id, false, ct);
        switch (item)
        {
            case TaskItem: await tasks.GetAsync(id, ct); break;
            case StageIssue si: await issues.RequireVisibleAsync(si.ProjectId, id, ct); break;
            case WorkTask { Kind: WorkTaskKind.ActionItem } wa: await ActionAsync(wa, ct); break;
            default: await tickets.GetAsync(id, ct); break;
        }
        var rows = (await history.ForAsync(id, ct)).ToList();
        if (item is StageIssue)
        {
            // An issue's status moves are its event list.
            var events = await db.StageIssueEvents.AsNoTracking().Where(e => e.IssueId == id && e.ToStatus != null).OrderByDescending(e => e.CreatedAt).Take(HistoryService.Max)
                .Select(e => new { e.Id, e.CreatedAt, e.ActorId, e.FromStatus, e.ToStatus }).ToListAsync(ct);
            var names = await FieldDiff.NamesAsync(db, events.Select(e => e.ActorId), ct);
            rows.AddRange(events.Select(e => new HistoryEntryDto(e.Id, e.CreatedAt, e.ActorId is { } u ? new ProjectManagement.Application.Features.Projects.UserRefDto(u, names.GetValueOrDefault(u, "Someone")) : null,
                "Status", e.FromStatus is { } f ? WorkItemService.LabelOf(f) : null, e.ToStatus is { } to ? WorkItemService.LabelOf(to) : null)));
            rows = rows.OrderByDescending(r => r.At).Take(HistoryService.Max).ToList();
        }
        return rows;
    }
}
