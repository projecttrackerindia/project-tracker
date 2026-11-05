using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.Tasks;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Recurring;

/// <summary>A section of a project template (it becomes a timeline stage). Offsets are days from the project's start.</summary>
public record SectionTemplate(string Name, int StartOffset = 0, int? EndOffset = null);

/// <summary>
/// A task in a template. Offsets are days from the start the template is created with. <paramref name="Owner"/> is a default role:
/// <c>creator</c> (whoever creates from the template) or <c>projectOwner</c>; <paramref name="AssigneeId"/> a named person (used while they are
/// still a member).
/// </summary>
public record TaskTemplate(string Title, string? Description = null, Priority Priority = Priority.Medium, string? Section = null, int? StartOffset = null,
    int? DueOffset = null, string? Owner = null, Guid? AssigneeId = null, IReadOnlyList<string>? Labels = null, IReadOnlyList<string>? Checklist = null,
    IReadOnlyList<TaskTemplate>? Subtasks = null, decimal? EstimatedHours = null);

public record TemplateContent(Priority? Priority = null, ProjectType? ProjectType = null, DeliveryMethod? DeliveryMethod = null, int? DurationDays = null,
    string? ProjectDescription = null, IReadOnlyList<SectionTemplate>? Sections = null, IReadOnlyList<TaskTemplate>? Tasks = null);

public record WorkTemplateDto(Guid Id, string Kind, string Name, string? Description, int TaskCount, int SectionCount, int? DurationDays, DateTime CreatedAt, TemplateContent? Content = null);
public record UpsertWorkTemplateRequest(string Kind, string Name, string? Description, TemplateContent Content);
public record SaveAsTemplateRequest(string? Name, string? Description = null);
public record CreateProjectFromTemplateRequest(string Name, DateOnly StartDate, Guid? ProjectGroupId = null, string? Key = null, Guid? OwnerId = null);
public record CreateTaskFromTemplateRequest(Guid ProjectId, DateOnly StartDate, Guid? StageId = null);
public record CreatedFromTemplateDto(Guid? ProjectId, IReadOnlyList<Guid> TaskIds);

/// <summary>
/// Project and task templates: listed, saved from an existing project or task (dates become offsets from its start), and used ("Create from
/// template" with a start date shifts every date). Creating goes through the ordinary project and task services, so permissions, plan limits,
/// numbering and notifications are exactly those of creating by hand.
/// </summary>
public class TemplateService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, PermissionService permissions, ProjectAccess access,
    ProjectService projects, TaskService tasks, ChecklistService checklists)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter() } };
    private const int MaxTasks = 300;

    private static TemplateContent Read(WorkTemplate t)
    {
        try { return JsonSerializer.Deserialize<TemplateContent>(t.ContentJson, Json) ?? new TemplateContent(); }
        catch (JsonException) { return new TemplateContent(); }
    }

    private static int Count(IReadOnlyList<TaskTemplate>? list) => (list ?? []).Sum(t => 1 + Count(t.Subtasks));

    private static WorkTemplateDto Dto(WorkTemplate t, bool withContent)
    {
        var c = Read(t);
        return new WorkTemplateDto(t.Id, t.Kind, t.Name, t.Description, Count(c.Tasks), c.Sections?.Count ?? 0, c.DurationDays, t.CreatedAt, withContent ? c : null);
    }

    private static string Kind(string? kind) => (kind ?? "").Trim().ToLowerInvariant() switch
    {
        "project" => "project",
        "task" => "task",
        _ => throw new ValidationException("kind", "A template is for a project or a task."),
    };

    private static void Validate(string name, TemplateContent content, string kind)
    {
        if (string.IsNullOrWhiteSpace(name)) throw new ValidationException("name", "Give the template a name.");
        if (name.Trim().Length > 120) throw new ValidationException("name", "Keep the name to 120 characters.");
        if (Count(content.Tasks) > MaxTasks) throw new ValidationException("content", $"A template can hold at most {MaxTasks} tasks.");
        if (kind == "task" && (content.Tasks?.Count ?? 0) != 1) throw new ValidationException("content", "A task template holds exactly one task (with its sub-tasks).");
        void Each(IReadOnlyList<TaskTemplate>? list, int depth)
        {
            foreach (var t in list ?? [])
            {
                if (string.IsNullOrWhiteSpace(t.Title)) throw new ValidationException("content", "Every task needs a title.");
                TextLimits.EnsureTitle(t.Title, field: "content");
                if (depth > 0 && (t.Subtasks?.Count ?? 0) > 0) throw new ValidationException("content", "Sub-tasks cannot have their own sub-tasks.");
                if (t.StartOffset is { } s && t.DueOffset is { } d && d < s) throw new ValidationException("content", $"\"{t.Title}\" is due before it starts.");
                Each(t.Subtasks, depth + 1);
            }
        }
        Each(content.Tasks, 0);
    }

    public async Task<IReadOnlyList<WorkTemplateDto>> ListAsync(string? kind, string? q, CancellationToken ct = default)
    {
        var query = db.WorkTemplates.AsNoTracking();
        if (!string.IsNullOrWhiteSpace(kind)) { var k = Kind(kind); query = query.Where(t => t.Kind == k); }
        if (!string.IsNullOrWhiteSpace(q)) { var term = q.Trim().ToLower(); query = query.Where(t => t.Name.ToLower().Contains(term) || (t.Description != null && t.Description.ToLower().Contains(term))); }
        var rows = await query.OrderBy(t => t.Name).Take(200).ToListAsync(ct);
        return rows.Select(t => Dto(t, false)).ToList();
    }

    public async Task<WorkTemplateDto> GetAsync(Guid id, CancellationToken ct = default) =>
        Dto(await db.WorkTemplates.AsNoTracking().FirstOrDefaultAsync(t => t.Id == id, ct) ?? throw new NotFoundException("Template not found."), true);

    public async Task<WorkTemplateDto> CreateAsync(UpsertWorkTemplateRequest req, CancellationToken ct = default)
    {
        var kind = Kind(req.Kind);
        await permissions.RequireAsync(kind == "project" ? Permissions.ProjectsCreate : Permissions.TasksCreate, ct);
        var content = req.Content ?? new TemplateContent();
        Validate(req.Name, content, kind);
        return await SaveAsync(kind, req.Name, req.Description, content, null, ct);
    }

    public async Task<WorkTemplateDto> UpdateAsync(Guid id, UpsertWorkTemplateRequest req, CancellationToken ct = default)
    {
        var t = await db.WorkTemplates.FirstOrDefaultAsync(x => x.Id == id, ct) ?? throw new NotFoundException("Template not found.");
        await permissions.RequireAsync(t.Kind == "project" ? Permissions.ProjectsCreate : Permissions.TasksCreate, ct);
        var content = req.Content ?? new TemplateContent();
        Validate(req.Name, content, t.Kind);
        t.Name = req.Name.Trim(); t.Description = Text.Truncate(req.Description?.Trim(), 500); t.ContentJson = JsonSerializer.Serialize(content, Json);
        t.UpdatedAt = clock.Now; t.UpdatedBy = ctx.UserId;
        recorder.Audit("template.updated", "WorkTemplate", t.Id, newValue: new { t.Name });
        await db.SaveChangesAsync(ct);
        return Dto(t, true);
    }

    public async Task DeleteAsync(Guid id, CancellationToken ct = default)
    {
        var t = await db.WorkTemplates.FirstOrDefaultAsync(x => x.Id == id, ct) ?? throw new NotFoundException("Template not found.");
        await permissions.RequireAsync(t.Kind == "project" ? Permissions.ProjectsCreate : Permissions.TasksCreate, ct);
        db.WorkTemplates.Remove(t);
        recorder.Audit("template.deleted", "WorkTemplate", t.Id, oldValue: new { t.Name });
        await db.SaveChangesAsync(ct);
    }

    private async Task<WorkTemplateDto> SaveAsync(string kind, string name, string? description, TemplateContent content, Guid? source, CancellationToken ct)
    {
        var t = new WorkTemplate
        {
            TenantId = ctx.RequireTenantId(), Kind = kind, Name = name.Trim(), Description = Text.Truncate(description?.Trim(), 500),
            ContentJson = JsonSerializer.Serialize(content, Json), CreatedAt = clock.Now, CreatedBy = ctx.UserId,
        };
        db.WorkTemplates.Add(t);
        recorder.Audit("template.created", "WorkTemplate", t.Id, newValue: new { t.Name, t.Kind, Source = source });
        await db.SaveChangesAsync(ct);
        return Dto(t, true);
    }

    // ---------------------------------------------------------------- save as template

    private async Task<List<TaskTemplate>> CaptureAsync(IReadOnlyList<TaskItem> top, DateOnly start, Guid projectOwner, Dictionary<Guid, string> stageNames, CancellationToken ct)
    {
        var ids = top.Select(t => t.Id).ToList();
        var subs = await db.Tasks.AsNoTracking().Where(t => t.ParentTaskId != null && ids.Contains(t.ParentTaskId.Value)).OrderBy(t => t.Position).ToListAsync(ct);
        var all = ids.Concat(subs.Select(s => s.Id)).ToList();
        var labels = (await db.TaskLabels.AsNoTracking().Where(l => all.Contains(l.TaskId)).Select(l => new { l.TaskId, l.Label!.Name }).ToListAsync(ct))
            .GroupBy(l => l.TaskId).ToDictionary(g => g.Key, g => (IReadOnlyList<string>)g.Select(x => x.Name).ToList());
        var checks = (await db.ChecklistItems.AsNoTracking().Where(c => all.Contains(c.TaskId)).OrderBy(c => c.Position).Select(c => new { c.TaskId, c.Title }).ToListAsync(ct))
            .GroupBy(c => c.TaskId).ToDictionary(g => g.Key, g => (IReadOnlyList<string>)g.Select(x => x.Title).ToList());
        int? Off(DateOnly? d) => d is { } x ? x.DayNumber - start.DayNumber : null;
        TaskTemplate One(TaskItem t, IReadOnlyList<TaskTemplate>? children) => new(
            t.Title, t.Description, t.Priority, t.StageId is { } sid ? stageNames.GetValueOrDefault(sid) : null, Off(t.StartDate), Off(t.DueDate),
            t.AssigneeId == projectOwner ? "projectOwner" : null, t.AssigneeId == projectOwner ? null : t.AssigneeId,
            labels.GetValueOrDefault(t.Id), checks.GetValueOrDefault(t.Id), children, t.EstimatedHours);
        return top.Select(t => One(t, subs.Where(s => s.ParentTaskId == t.Id).Select(s => One(s, null)).ToList())).ToList();
    }

    public async Task<WorkTemplateDto> SaveProjectAsync(Guid projectId, SaveAsTemplateRequest req, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.ProjectsCreate, ct);
        var project = await access.GetProjectAsync(projectId, ct);
        var top = await db.Tasks.AsNoTracking().Where(t => t.ProjectId == projectId && t.ParentTaskId == null).OrderBy(t => t.Position).Take(MaxTasks).ToListAsync(ct);
        var stages = await db.ProjectStages.AsNoTracking().Where(s => s.ProjectId == projectId).OrderBy(s => s.Order).ToListAsync(ct);
        var start = project.StartDate ?? top.Select(t => t.StartDate ?? t.DueDate).Where(d => d is not null).Min() ?? clock.Today;
        int? Off(DateOnly? d) => d is { } x ? x.DayNumber - start.DayNumber : null;
        var content = new TemplateContent(project.Priority, project.ProjectType, project.DeliveryMethod,
            project.DueDate is { } due ? due.DayNumber - start.DayNumber : null, project.Description,
            stages.Select(s => new SectionTemplate(s.Name, Off(s.PlannedStart) ?? 0, Off(s.PlannedEnd))).ToList(),
            await CaptureAsync(top, start, project.OwnerId, stages.ToDictionary(s => s.Id, s => s.Name), ct));
        var name = string.IsNullOrWhiteSpace(req.Name) ? project.Name : req.Name;
        Validate(name, content, "project");
        return await SaveAsync("project", name, req.Description ?? project.Description, content, projectId, ct);
    }

    public async Task<WorkTemplateDto> SaveTaskAsync(Guid taskId, SaveAsTemplateRequest req, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.TasksCreate, ct);
        var task = await access.VisibleTasks().AsNoTracking().FirstOrDefaultAsync(t => t.Id == taskId, ct) ?? throw new NotFoundException("Task not found.");
        if (task.ParentTaskId is not null) throw new ValidationException("taskId", "Save the parent task as a template; its sub-tasks come with it.");
        var project = await db.Projects.AsNoTracking().FirstAsync(p => p.Id == task.ProjectId, ct);
        var start = task.StartDate ?? task.DueDate ?? clock.Today;
        var content = new TemplateContent(Tasks: await CaptureAsync([task], start, project.OwnerId, new Dictionary<Guid, string>(), ct));
        var name = string.IsNullOrWhiteSpace(req.Name) ? task.Title : req.Name;
        Validate(name, content, "task");
        return await SaveAsync("task", name, req.Description, content, taskId, ct);
    }

    // ---------------------------------------------------------------- create from template

    private async Task<Dictionary<string, Guid>> LabelIdsAsync(IEnumerable<string> names, CancellationToken ct)
    {
        var wanted = names.Where(n => !string.IsNullOrWhiteSpace(n)).Select(n => n.Trim()).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        var map = new Dictionary<string, Guid>(StringComparer.OrdinalIgnoreCase);
        if (wanted.Count == 0) return map;
        foreach (var l in await db.Labels.AsNoTracking().ToListAsync(ct)) map.TryAdd(l.Name, l.Id);
        if (!await permissions.HasAsync(Permissions.LabelsManage, ct)) return map;   // labels the workspace does not have are left off
        foreach (var n in wanted.Where(n => !map.ContainsKey(n)))
            map[n] = (await projects.CreateLabelAsync(new UpsertLabelRequest(Text.Truncate(n, 40)!, null), ct)).Id;
        return map;
    }

    private static IEnumerable<string> AllLabels(IReadOnlyList<TaskTemplate>? list) => (list ?? []).SelectMany(t => (t.Labels ?? []).Concat(AllLabels(t.Subtasks)));

    private async Task<List<Guid>> MakeTasksAsync(Guid projectId, IReadOnlyList<TaskTemplate> list, DateOnly start, Guid projectOwner, Guid? fixedStage,
        Dictionary<string, Guid> stageIds, CancellationToken ct)
    {
        var labelIds = await LabelIdsAsync(AllLabels(list), ct);
        var me = ctx.RequireUserId();
        var members = (await db.TenantMembers.AsNoTracking().Select(m => m.UserId).ToListAsync(ct)).ToHashSet();
        Guid? Who(TaskTemplate t) => t.Owner switch
        {
            "creator" => me,
            "projectOwner" => projectOwner,
            _ => t.AssigneeId is { } a && members.Contains(a) ? (Guid?)a : null,
        };
        DateOnly? At(int? offset) => offset is { } o ? start.AddDays(o) : null;
        async Task<TaskDto> One(TaskTemplate t, Guid? parent)
        {
            var labels = (t.Labels ?? []).Select(n => labelIds.TryGetValue(n.Trim(), out var id) ? id : Guid.Empty).Where(id => id != Guid.Empty).Distinct().ToList();
            Guid? stage = null;
            if (parent is null) stage = fixedStage ?? (t.Section is { } s && stageIds.TryGetValue(s, out var sid) ? sid : (Guid?)null);
            var dto = await tasks.CreateAsync(projectId, new CreateTaskRequest(t.Title, t.Description, null, t.Priority, Who(t), At(t.StartOffset), At(t.DueOffset),
                t.EstimatedHours, labels, parent, null, stage), ct);
            foreach (var item in (t.Checklist ?? []).Take(100))
                await checklists.AddAsync(dto.Id, new AddChecklistItemRequest(item), ct);
            return dto;
        }
        var made = new List<Guid>();
        foreach (var t in list)
        {
            var parent = await One(t, null);
            made.Add(parent.Id);
            foreach (var s in t.Subtasks ?? []) made.Add((await One(s, parent.Id)).Id);
        }
        return made;
    }

    public async Task<CreatedFromTemplateDto> CreateProjectAsync(Guid templateId, CreateProjectFromTemplateRequest req, CancellationToken ct = default)
    {
        var t = await db.WorkTemplates.AsNoTracking().FirstOrDefaultAsync(x => x.Id == templateId && x.Kind == "project", ct) ?? throw new NotFoundException("Template not found.");
        var c = Read(t);
        if (string.IsNullOrWhiteSpace(req.Name)) throw new ValidationException("name", "Give the project a name.");
        var group = req.ProjectGroupId ?? await db.ProjectGroups.AsNoTracking().Where(g => g.IsActive).OrderBy(g => g.Order).Select(g => (Guid?)g.Id).FirstOrDefaultAsync(ct);
        var due = c.DurationDays is { } days ? req.StartDate.AddDays(days) : (DateOnly?)null;
        var detail = await projects.CreateAsync(new CreateProjectRequest(req.Name, req.Key, c.ProjectDescription, c.Priority ?? Priority.Medium, null, req.OwnerId, null,
            req.StartDate, due, null, null, group, c.ProjectType ?? ProjectType.Other, c.DeliveryMethod), ct);
        var projectId = detail.Project.Id;
        var project = await db.Projects.FirstAsync(p => p.Id == projectId, ct);

        // The template's sections replace the default timeline the new project started with (it is brand new: nothing is in it yet).
        var stageIds = new Dictionary<string, Guid>(StringComparer.OrdinalIgnoreCase);
        if (c.Sections is { Count: > 0 } sections)
        {
            db.ProjectStages.RemoveRange(await db.ProjectStages.Where(s => s.ProjectId == projectId).ToListAsync(ct));
            var order = 0;
            foreach (var s in sections.Where(s => !string.IsNullOrWhiteSpace(s.Name)).Take(50))
            {
                var stage = new ProjectStage
                {
                    TenantId = project.TenantId, ProjectId = projectId, Name = Text.Truncate(s.Name.Trim(), 100)!, Order = order++,
                    PlannedStart = req.StartDate.AddDays(s.StartOffset), PlannedEnd = s.EndOffset is { } e ? req.StartDate.AddDays(Math.Max(e, s.StartOffset)) : null,
                    CreatedAt = clock.Now,
                };
                if (stage.PlannedEnd is { } end) stage.DurationDays = end.DayNumber - stage.PlannedStart!.Value.DayNumber;
                db.ProjectStages.Add(stage);
                stageIds.TryAdd(s.Name.Trim(), stage.Id);
            }
            await db.SaveChangesAsync(ct);
        }
        var made = await MakeTasksAsync(projectId, c.Tasks ?? [], req.StartDate, project.OwnerId, null, stageIds, ct);
        recorder.Activity("project.from_template", "Project", projectId, $"Created \"{project.Name}\" from the template \"{t.Name}\"", projectId);
        await db.SaveChangesAsync(ct);
        return new CreatedFromTemplateDto(projectId, made);
    }

    public async Task<CreatedFromTemplateDto> CreateTaskAsync(Guid templateId, CreateTaskFromTemplateRequest req, CancellationToken ct = default)
    {
        var t = await db.WorkTemplates.AsNoTracking().FirstOrDefaultAsync(x => x.Id == templateId && x.Kind == "task", ct) ?? throw new NotFoundException("Template not found.");
        var project = await access.GetProjectAsync(req.ProjectId, ct);
        var made = await MakeTasksAsync(project.Id, Read(t).Tasks ?? [], req.StartDate, project.OwnerId, req.StageId, new Dictionary<string, Guid>(StringComparer.OrdinalIgnoreCase), ct);
        return new CreatedFromTemplateDto(project.Id, made);
    }
}
