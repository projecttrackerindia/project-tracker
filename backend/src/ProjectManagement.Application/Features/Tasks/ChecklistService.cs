using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Tasks;

public record ChecklistItemDto(Guid Id, string Title, bool IsDone, double Position, DateTime? CompletedAt);
public record ChecklistDto(IReadOnlyList<ChecklistItemDto> Items, int Total, int Done, int Progress);
public record AddChecklistItemRequest(string Title);
public record UpdateChecklistItemRequest(string? Title, bool? IsDone);
public record ReorderChecklistRequest(IReadOnlyList<Guid> ItemIds);

/// <summary>The checklist of a task: small steps to tick off. Anyone who can edit the task can change its checklist.</summary>
public class ChecklistService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, PermissionService permissions, ProjectAccess access)
{
    private const int MaxItems = 100;
    private const int MaxTitle = 200;

    private async Task<(TaskItem Task, string Key)> VisibleTaskAsync(Guid taskId, CancellationToken ct)
    {
        var task = await access.VisibleTasks().FirstOrDefaultAsync(t => t.Id == taskId, ct) ?? throw new NotFoundException("Task not found.");
        var key = await db.Projects.Where(p => p.Id == task.ProjectId).Select(p => p.Key).FirstAsync(ct);
        return (task, $"{key}-{task.Number}");
    }

    private async Task<(TaskItem Task, string Key)> EditableTaskAsync(Guid taskId, CancellationToken ct)
    {
        var found = await VisibleTaskAsync(taskId, ct);
        await permissions.RequireTaskEditAsync(found.Task, ct);
        if (await db.Projects.Where(p => p.Id == found.Task.ProjectId).Select(p => p.Status).FirstAsync(ct) == ProjectStatus.Archived)
            throw new ConflictException("Archived projects are read-only.", "PROJECT_ARCHIVED");
        return found;
    }

    private static string CleanTitle(string? title)
    {
        var t = (title ?? "").Trim();
        if (t.Length == 0) throw new ValidationException("title", "Write what needs to be done.");
        if (t.Length > MaxTitle) throw new ValidationException("title", $"Keep it under {MaxTitle} characters.");
        return t;
    }

    private static ChecklistDto Build(IEnumerable<ChecklistItem> items)
    {
        var list = items.OrderBy(i => i.Position).ThenBy(i => i.CreatedAt).Select(i => new ChecklistItemDto(i.Id, i.Title, i.IsDone, i.Position, i.CompletedAt)).ToList();
        var done = list.Count(i => i.IsDone);
        return new ChecklistDto(list, list.Count, done, list.Count == 0 ? 0 : (int)Math.Round(done * 100.0 / list.Count));
    }

    public async Task<ChecklistDto> GetAsync(Guid taskId, CancellationToken ct = default)
    {
        await VisibleTaskAsync(taskId, ct);
        return Build(await db.ChecklistItems.AsNoTracking().Where(i => i.TaskId == taskId).ToListAsync(ct));
    }

    public async Task<ChecklistDto> AddAsync(Guid taskId, AddChecklistItemRequest req, CancellationToken ct = default)
    {
        var (task, _) = await EditableTaskAsync(taskId, ct);
        var title = CleanTitle(req.Title);
        var existing = await db.ChecklistItems.Where(i => i.TaskId == taskId).Select(i => i.Position).ToListAsync(ct);
        if (existing.Count >= MaxItems) throw new ConflictException($"A checklist can have at most {MaxItems} items.", "LIMIT_REACHED");

        db.ChecklistItems.Add(new ChecklistItem
        {
            TenantId = task.TenantId, TaskId = taskId, Title = title, Position = (existing.Count == 0 ? 0 : existing.Max()) + 1000,
            CreatedAt = clock.Now, CreatedBy = ctx.RequireUserId(),
        });
        await db.SaveChangesAsync(ct);
        return await GetAsync(taskId, ct);
    }

    public async Task<ChecklistDto> UpdateAsync(Guid taskId, Guid itemId, UpdateChecklistItemRequest req, CancellationToken ct = default)
    {
        var (task, key) = await EditableTaskAsync(taskId, ct);
        var item = await db.ChecklistItems.FirstOrDefaultAsync(i => i.Id == itemId && i.TaskId == taskId, ct) ?? throw new NotFoundException("Checklist item not found.");
        if (req.Title is not null) item.Title = CleanTitle(req.Title);
        if (req.IsDone is { } done && done != item.IsDone)
        {
            item.IsDone = done;
            item.CompletedAt = done ? clock.Now : null;
            item.CompletedBy = done ? ctx.RequireUserId() : null;
        }
        item.UpdatedAt = clock.Now;
        await db.SaveChangesAsync(ct);

        var all = await db.ChecklistItems.Where(i => i.TaskId == taskId).ToListAsync(ct);
        if (req.IsDone == true && all.Count > 0 && all.All(i => i.IsDone))
        {
            recorder.Activity("task.checklist_completed", "Task", taskId, $"Finished every item of the checklist on {key} \"{task.Title}\"", task.ProjectId);
            await db.SaveChangesAsync(ct);
        }
        return Build(all);
    }

    public async Task<ChecklistDto> DeleteAsync(Guid taskId, Guid itemId, CancellationToken ct = default)
    {
        await EditableTaskAsync(taskId, ct);
        var item = await db.ChecklistItems.FirstOrDefaultAsync(i => i.Id == itemId && i.TaskId == taskId, ct) ?? throw new NotFoundException("Checklist item not found.");
        db.ChecklistItems.Remove(item);
        await db.SaveChangesAsync(ct);
        return await GetAsync(taskId, ct);
    }

    /// <summary>Sets the order: the ids must be exactly the task's current items.</summary>
    public async Task<ChecklistDto> ReorderAsync(Guid taskId, ReorderChecklistRequest req, CancellationToken ct = default)
    {
        await EditableTaskAsync(taskId, ct);
        var items = await db.ChecklistItems.Where(i => i.TaskId == taskId).ToListAsync(ct);
        var ids = req.ItemIds.Distinct().ToList();
        if (ids.Count != items.Count || items.Any(i => !ids.Contains(i.Id)))
            throw new ValidationException("itemIds", "The list changed while you were reordering. Reload and try again.");
        for (var n = 0; n < ids.Count; n++) items.First(i => i.Id == ids[n]).Position = (n + 1) * 1000;
        await db.SaveChangesAsync(ct);
        return Build(items);
    }
}
