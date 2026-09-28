using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Work;

public record WorkTypeDto(Guid Id, string Name, string? Description, int Order, bool IsActive, int TaskCount);
public record UpsertWorkTypeRequest(string? Name, string? Description, bool? IsActive);
public record ReorderWorkTypesRequest(IReadOnlyList<Guid>? Ids);

/// <summary>
/// The workspace's list of kinds of work (Bug Fix, Data Preparation ...). A new workspace gets the standard set the first time the list is used;
/// after that it is the workspace's own: add, rename, describe, reorder, deactivate. A type that work tasks use cannot be deleted, only deactivated.
/// </summary>
public class WorkTypeService(IAppDbContext db, ICurrentContext ctx, Recorder recorder, PermissionService permissions, AppClock clock)
{
    /// <summary>The standard set, in the order they are offered.</summary>
    public static readonly string[] Defaults =
    [
        "Bug Fix", "Issue Analysis", "Data Preparation", "Data Correction", "Production Support", "Report Preparation", "Technical Analysis",
        "Performance Analysis", "Configuration Change", "Deployment Support", "Maintenance", "Customer Request", "Ad-hoc", "Other",
    ];

    /// <summary>Creates the standard set when the workspace has no work types at all (made in the tenant's own context, on first use).</summary>
    public async Task EnsureDefaultsAsync(CancellationToken ct = default)
    {
        if (await db.WorkTypes.AnyAsync(ct)) return;
        var tid = ctx.RequireTenantId();
        var now = clock.Now;
        for (var i = 0; i < Defaults.Length; i++)
            db.WorkTypes.Add(new WorkType { TenantId = tid, Name = Defaults[i], Order = i, IsActive = true, CreatedAt = now, CreatedBy = ctx.UserId });
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateException) { /* another request seeded them at the same moment */ }
    }

    private static string CleanName(string? name)
    {
        var n = (name ?? "").Trim();
        if (n.Length == 0) throw new ValidationException("name", "Give the work type a name.");
        if (n.Length > 60) throw new ValidationException("name", "The name can be at most 60 characters.");
        return n;
    }

    private static string? CleanDescription(string? d)
    {
        var t = d?.Trim();
        if (string.IsNullOrEmpty(t)) return null;
        if (t.Length > 200) throw new ValidationException("description", "The description can be at most 200 characters.");
        return t;
    }

    public async Task<IReadOnlyList<WorkTypeDto>> ListAsync(bool includeInactive, CancellationToken ct = default)
    {
        await EnsureDefaultsAsync(ct);
        var types = await db.WorkTypes.AsNoTracking().OrderBy(t => t.Order).ThenBy(t => t.Name).ToListAsync(ct);
        var counts = await db.WorkTasks.AsNoTracking().GroupBy(t => t.WorkTypeId).Select(g => new { Id = g.Key, N = g.Count() }).ToDictionaryAsync(x => x.Id, x => x.N, ct);
        return types.Where(t => includeInactive || t.IsActive).Select(t => new WorkTypeDto(t.Id, t.Name, t.Description, t.Order, t.IsActive, counts.GetValueOrDefault(t.Id))).ToList();
    }

    private async Task<WorkType> FindAsync(Guid id, CancellationToken ct) =>
        await db.WorkTypes.FirstOrDefaultAsync(t => t.Id == id, ct) ?? throw new NotFoundException("Work type not found.", "WORK_TYPE_NOT_FOUND");

    private async Task RequireUniqueAsync(string name, Guid? except, CancellationToken ct)
    {
        var lower = name.ToLower();
        if (await db.WorkTypes.AnyAsync(t => t.Name.ToLower() == lower && t.Id != except, ct))
            throw new ValidationException("name", $"There is already a work type called “{name}”.");
    }

    public async Task<WorkTypeDto> CreateAsync(UpsertWorkTypeRequest req, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.WorkTypesManage, ct);
        await EnsureDefaultsAsync(ct);
        var name = CleanName(req.Name);
        await RequireUniqueAsync(name, null, ct);
        var next = (await db.WorkTypes.MaxAsync(t => (int?)t.Order, ct) ?? -1) + 1;
        var type = new WorkType { TenantId = ctx.RequireTenantId(), Name = name, Description = CleanDescription(req.Description), Order = next, IsActive = req.IsActive ?? true, CreatedAt = clock.Now, CreatedBy = ctx.UserId };
        db.WorkTypes.Add(type);
        recorder.Audit("worktype.created", "WorkType", type.Id, new { type.Name });
        await db.SaveChangesAsync(ct);
        return new WorkTypeDto(type.Id, type.Name, type.Description, type.Order, type.IsActive, 0);
    }

    public async Task<WorkTypeDto> UpdateAsync(Guid id, UpsertWorkTypeRequest req, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.WorkTypesManage, ct);
        var type = await FindAsync(id, ct);
        var name = CleanName(req.Name);
        await RequireUniqueAsync(name, id, ct);
        var was = new { type.Name, type.IsActive };
        type.Name = name; type.Description = CleanDescription(req.Description);
        if (req.IsActive is { } active) type.IsActive = active;
        recorder.Audit("worktype.updated", "WorkType", id, was, new { type.Name, type.IsActive });
        await db.SaveChangesAsync(ct);
        return new WorkTypeDto(type.Id, type.Name, type.Description, type.Order, type.IsActive, await db.WorkTasks.CountAsync(t => t.WorkTypeId == id, ct));
    }

    public async Task ReorderAsync(ReorderWorkTypesRequest req, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.WorkTypesManage, ct);
        var ids = req.Ids ?? [];
        var all = await db.WorkTypes.ToListAsync(ct);
        if (ids.Count != all.Count || ids.Distinct().Count() != ids.Count || all.Any(t => !ids.Contains(t.Id)))
            throw new ValidationException("ids", "Send every work type once, in the new order.");
        for (var i = 0; i < ids.Count; i++) all.First(t => t.Id == ids[i]).Order = i;
        await db.SaveChangesAsync(ct);
    }

    public async Task DeleteAsync(Guid id, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.WorkTypesManage, ct);
        var type = await FindAsync(id, ct);
        var used = await db.WorkTasks.CountAsync(t => t.WorkTypeId == id, ct);
        if (used > 0)
            throw new ConflictException($"{used} work task{(used == 1 ? " uses" : "s use")} “{type.Name}”, so it cannot be deleted. Deactivate it instead: it stays on those tasks but is no longer offered for new ones.", "WORK_TYPE_IN_USE");
        db.WorkTypes.Remove(type);
        recorder.Audit("worktype.deleted", "WorkType", id, new { type.Name });
        await db.SaveChangesAsync(ct);
    }
}
