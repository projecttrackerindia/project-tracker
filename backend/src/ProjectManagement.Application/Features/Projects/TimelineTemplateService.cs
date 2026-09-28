using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Projects;

public record TimelineTemplateStageInput(string Name, int Weight);
public record UpsertTimelineTemplateRequest(string Name, string? Description, IReadOnlyList<TimelineTemplateStageInput> Stages);
/// <summary>Saves a project's current stages, in their current order, as a template of the workspace.</summary>
public record SaveProjectTimelineRequest(string Name, string? Description);

/// <summary>
/// The timelines a new project can start from: the built-in ones plus the workspace's own. A project copies the stages it starts
/// from, so editing or deleting a template never changes a project that already exists.
/// </summary>
public class TimelineTemplateService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, PermissionService permissions,
    EntitlementService entitlements, ProjectAccess access)
{
    public const int MaxTemplates = 20;
    public const int MaxStages = 30;
    private const string CustomPrefix = "custom:";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private static string KeyOf(Guid id) => $"{CustomPrefix}{id}";

    private static IReadOnlyList<TimelineTemplateStage> Read(CustomTimelineTemplate t)
    {
        try { return JsonSerializer.Deserialize<List<TimelineTemplateStage>>(t.StagesJson, Json) ?? []; }
        catch (JsonException) { return []; }
    }

    private static TimelineTemplateDto ToDto(CustomTimelineTemplate t)
    {
        var stages = Read(t);
        return new TimelineTemplateDto(KeyOf(t.Id), t.Name, t.Description ?? "", false, stages.Select(s => s.Name).ToList(), true, t.Id, stages.Select(s => s.Weight).ToList());
    }

    private static TimelineTemplateDto ToDto(TimelineTemplate t) =>
        new(t.Key, t.Name, t.Description, t.Key == TimelineTemplates.DefaultKey, t.Stages.Select(s => s.Name).ToList(), false, null, t.Stages.Select(s => s.Weight).ToList());

    // ---------------------------------------------------------------- read

    /// <summary>The built-in timelines first, then the workspace's own by name.</summary>
    public async Task<IReadOnlyList<TimelineTemplateDto>> ListAsync(CancellationToken ct = default)
    {
        ctx.RequireTenantId();
        var custom = await db.CustomTimelineTemplates.AsNoTracking().OrderBy(t => t.Name).ToListAsync(ct);
        return TimelineTemplates.All.Select(ToDto).Concat(custom.Select(ToDto)).ToList();
    }

    /// <summary>The template a new project is created from: the built-in default when none is named, a validation error for an unknown one.</summary>
    public async Task<TimelineTemplate> ResolveAsync(string? key, CancellationToken ct = default)
    {
        if (key is not null && key.StartsWith(CustomPrefix, StringComparison.OrdinalIgnoreCase))
        {
            var found = Guid.TryParse(key[CustomPrefix.Length..], out var id)
                ? await db.CustomTimelineTemplates.AsNoTracking().FirstOrDefaultAsync(t => t.Id == id, ct) : null;
            if (found is null) throw new ValidationException("timelineTemplate", "Choose one of the available project timelines.");
            var stages = Read(found);
            if (stages.Count == 0) throw new ValidationException("timelineTemplate", "That timeline has no stages.");
            return new TimelineTemplate(KeyOf(found.Id), found.Name, found.Description ?? "", stages);
        }
        return TimelineTemplates.Resolve(key);
    }

    // ---------------------------------------------------------------- write

    private async Task RequireManageAsync(CancellationToken ct)
    {
        await permissions.RequireAsync(Permissions.WorkflowManage, ct);
        await entitlements.EnsureFeatureAsync(FeatureKeys.CustomWorkflows, ct);
    }

    private async Task<List<TimelineTemplateStage>> ValidateAsync(string? name, string? description, IReadOnlyList<TimelineTemplateStageInput>? input, Guid? self, CancellationToken ct)
    {
        var trimmed = (name ?? "").Trim();
        if (trimmed.Length == 0) throw new ValidationException("name", "Give the timeline a name.");
        if (trimmed.Length > 80) throw new ValidationException("name", "Use at most 80 characters.");
        if ((description?.Trim().Length ?? 0) > 300) throw new ValidationException("description", "Use at most 300 characters.");
        if (TimelineTemplates.All.Any(t => t.Name.Equals(trimmed, StringComparison.OrdinalIgnoreCase)))
            throw new ValidationException("name", "That name is used by a built-in timeline. Choose another.");
        if (await db.CustomTimelineTemplates.AnyAsync(t => t.Id != self && t.Name.ToLower() == trimmed.ToLower(), ct))
            throw new ValidationException("name", "You already have a timeline with this name.");

        var stages = (input ?? []).Select(s => new TimelineTemplateStage((s.Name ?? "").Trim(), s.Weight)).ToList();
        if (stages.Count == 0) throw new ValidationException("stages", "Add at least one stage.");
        if (stages.Count > MaxStages) throw new ValidationException("stages", $"A timeline can have up to {MaxStages} stages.");
        if (stages.Any(s => s.Name.Length == 0)) throw new ValidationException("stages", "Every stage needs a name.");
        if (stages.Any(s => s.Name.Length > 80)) throw new ValidationException("stages", "Stage names can have at most 80 characters.");
        if (stages.Any(s => s.Weight is < 0 or > 100)) throw new ValidationException("stages", "A stage's time share must be between 0 and 100.");
        return stages;
    }

    public async Task<TimelineTemplateDto> CreateAsync(UpsertTimelineTemplateRequest req, CancellationToken ct = default)
    {
        await RequireManageAsync(ct);
        var tid = ctx.RequireTenantId();
        if (await db.CustomTimelineTemplates.CountAsync(ct) >= MaxTemplates)
            throw new ConflictException($"A workspace can have up to {MaxTemplates} custom timelines. Delete one first.", "TEMPLATE_LIMIT");
        var stages = await ValidateAsync(req.Name, req.Description, req.Stages, null, ct);

        var t = new CustomTimelineTemplate
        {
            TenantId = tid, Name = req.Name.Trim(), Description = string.IsNullOrWhiteSpace(req.Description) ? null : req.Description.Trim(),
            StagesJson = JsonSerializer.Serialize(stages, Json), CreatedAt = clock.Now, CreatedBy = ctx.UserId,
        };
        db.CustomTimelineTemplates.Add(t);
        recorder.Audit("timeline_template.created", "TimelineTemplate", t.Id, newValue: new { t.Name, Stages = stages.Select(s => s.Name) });
        await db.SaveChangesAsync(ct);
        return ToDto(t);
    }

    public async Task<TimelineTemplateDto> UpdateAsync(Guid id, UpsertTimelineTemplateRequest req, CancellationToken ct = default)
    {
        await RequireManageAsync(ct);
        var t = await db.CustomTimelineTemplates.FirstOrDefaultAsync(x => x.Id == id, ct) ?? throw new NotFoundException("Timeline not found.");
        var stages = await ValidateAsync(req.Name, req.Description, req.Stages, id, ct);
        var before = t.Name;
        t.Name = req.Name.Trim();
        t.Description = string.IsNullOrWhiteSpace(req.Description) ? null : req.Description.Trim();
        t.StagesJson = JsonSerializer.Serialize(stages, Json);
        t.UpdatedAt = clock.Now;
        recorder.Audit("timeline_template.updated", "TimelineTemplate", id, before, new { t.Name, Stages = stages.Select(s => s.Name) });
        await db.SaveChangesAsync(ct);
        return ToDto(t);
    }

    public async Task DeleteAsync(Guid id, CancellationToken ct = default)
    {
        await RequireManageAsync(ct);
        var t = await db.CustomTimelineTemplates.FirstOrDefaultAsync(x => x.Id == id, ct) ?? throw new NotFoundException("Timeline not found.");
        db.CustomTimelineTemplates.Remove(t);
        recorder.Audit("timeline_template.deleted", "TimelineTemplate", id, t.Name);
        await db.SaveChangesAsync(ct);
    }

    /// <summary>
    /// Copies a project's stages, in their current order, into a new template. A stage's time share comes from its planned dates
    /// (the longest stage gets 10, a stage with no length gets 0, one without dates 1), so the template keeps the project's proportions.
    /// </summary>
    public async Task<TimelineTemplateDto> CreateFromProjectAsync(Guid projectId, SaveProjectTimelineRequest req, CancellationToken ct = default)
    {
        await RequireManageAsync(ct);
        await access.GetProjectAsync(projectId, ct); // 404 when the project is not visible to the caller
        var rows = await db.ProjectStages.AsNoTracking().Where(s => s.ProjectId == projectId).OrderBy(s => s.Order).ToListAsync(ct);
        if (rows.Count == 0) throw new ValidationException("stages", "This project has no stages to save.");

        int? Days(ProjectStage s) => s.PlannedStart is { } a && s.PlannedEnd is { } b ? Math.Max(0, b.DayNumber - a.DayNumber) : null;
        var longest = rows.Max(s => Days(s) ?? 0);
        var input = rows.Select(s => new TimelineTemplateStageInput(s.Name,
            Days(s) is not { } d ? 1 : d == 0 || longest == 0 ? 0 : Math.Max(1, (int)Math.Round(d * 10.0 / longest)))).ToList();
        return await CreateAsync(new UpsertTimelineTemplateRequest(req.Name, req.Description, input), ct);
    }
}
