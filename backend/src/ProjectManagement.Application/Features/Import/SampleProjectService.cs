using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.Tasks;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Import;

public record SampleProjectDto(bool Exists, Guid? ProjectId, string? Name, int Tasks);

/// <summary>
/// "Add sample project" for a new workspace: a fictional project with a handful of tasks across statuses and dates, so the screens have
/// something to show while people find their way. It is remembered as an import batch of kind "sample", so one click removes exactly it.
/// </summary>
public class SampleProjectService(IAppDbContext db, ICurrentContext ctx, AppClock clock, ProjectService projects, TaskService tasks)
{
    public const string Source = "sample";
    public const string Name = "Sample: Website launch";

    private static readonly (string Title, string Category, Priority Priority, int StartIn, int DueIn, string Description)[] Plan =
    [
        ("Agree the launch goals", "Done", Priority.High, -10, -7, "Three goals and how we will know we met them."),
        ("Write the home page copy", "Active", Priority.High, -3, 2, "Short, plain sentences. One idea per section."),
        ("Design the pricing page", "Active", Priority.Medium, -1, 4, "Two plans side by side; the yearly saving is clear."),
        ("Set up analytics", "Todo", Priority.Medium, 2, 6, "Page views and sign-ups only; no personal data."),
        ("Test on phones", "Todo", Priority.High, 5, 9, "The five most used screens at 390 px, light and dark."),
        ("Launch checklist review", "Todo", Priority.Critical, 9, 12, "Walk through the checklist together the day before."),
    ];

    public async Task<SampleProjectDto> GetAsync(CancellationToken ct = default)
    {
        ctx.RequireTenantId();
        var batch = await db.ImportBatches.AsNoTracking().Where(b => b.Source == Source && b.UndoneAt == null).OrderByDescending(b => b.CreatedAt).FirstOrDefaultAsync(ct);
        if (batch is null) return new(false, null, null, 0);
        var project = await db.Projects.AsNoTracking().Where(p => p.Id == batch.ProjectId).Select(p => new { p.Id, p.Name }).FirstOrDefaultAsync(ct);
        if (project is null) return new(false, null, null, 0);
        return new(true, project.Id, project.Name, await db.Tasks.CountAsync(t => t.ProjectId == project.Id, ct));
    }

    public async Task<SampleProjectDto> AddAsync(CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId(); var uid = ctx.RequireUserId();
        if ((await GetAsync(ct)).Exists) throw new ConflictException("The sample project is already here.", "SAMPLE_EXISTS");
        var group = await db.ProjectGroups.Where(g => g.IsActive).OrderBy(g => g.Order).Select(g => (Guid?)g.Id).FirstOrDefaultAsync(ct);
        var today = clock.Today;
        var detail = await projects.CreateAsync(new CreateProjectRequest(Name, null,
            "A fictional project to explore with. Remove it any time from Settings or the welcome card.", Priority.Medium, ProjectStatus.Active, uid,
            null, today.AddDays(-10), today.AddDays(14), null, ProjectGroupId: group, ProjectType: ProjectType.NewProject), ct);
        var pid = detail.Project.Id;
        var ids = new List<Guid>();
        foreach (var (title, category, priority, startIn, dueIn, description) in Plan)
        {
            var cat = Enum.Parse<StatusCategory>(category);
            var status = detail.Statuses.FirstOrDefault(s => s.Category == cat)?.Id;
            var t = await tasks.CreateAsync(pid, new CreateTaskRequest(title, description, status, priority, uid, today.AddDays(startIn), today.AddDays(dueIn), 4, null, null), ct);
            ids.Add(t.Id);
        }
        db.ImportBatches.Add(new ImportBatch
        {
            TenantId = tid, ProjectId = pid, Source = Source, FileName = Name, TaskIds = string.Join(",", ids), Created = ids.Count, CreatedAt = clock.Now, CreatedBy = uid,
        });
        await db.SaveChangesAsync(ct);
        return new(true, pid, Name, ids.Count);
    }

    /// <summary>Removes the sample project (the usual soft delete) in one click.</summary>
    public async Task<SampleProjectDto> RemoveAsync(CancellationToken ct = default)
    {
        ctx.RequireTenantId();
        var batch = await db.ImportBatches.Where(b => b.Source == Source && b.UndoneAt == null).OrderByDescending(b => b.CreatedAt).FirstOrDefaultAsync(ct)
            ?? throw new NotFoundException("There is no sample project.");
        if (await db.Projects.AnyAsync(p => p.Id == batch.ProjectId, ct)) await projects.DeleteAsync(batch.ProjectId, ct);
        batch.UndoneAt = clock.Now; batch.UpdatedAt = clock.Now; batch.UpdatedBy = ctx.UserId;
        await db.SaveChangesAsync(ct);
        return new(false, null, null, 0);
    }
}
