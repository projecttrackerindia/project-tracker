using System.Globalization;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Tasks;

public record CustomFieldDto(Guid Id, string Name, CustomFieldType Type, IReadOnlyList<string> Options, int SortOrder, int InUse);
public record UpsertCustomFieldRequest(string Name, CustomFieldType Type, IReadOnlyList<string>? Options);
public record OrderCustomFieldsRequest(IReadOnlyList<Guid> Ids);
public record CustomFieldValueDto(Guid FieldId, string Value);
/// <summary>Field id → new value; null or empty clears the value.</summary>
public record SetCustomFieldValuesRequest(Dictionary<Guid, string?> Values);

/// <summary>Workspace-defined extra fields on tasks, and their values. Defining fields is a workflow-management job; filling them is task editing.</summary>
public class CustomFieldService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, PermissionService permissions,
    EntitlementService entitlements, ProjectAccess access)
{
    public const int MaxFields = 20;
    private const int MaxOptions = 30, MaxOptionLength = 50, MaxTextLength = 500, MaxName = 40;

    // ---------------------------------------------------------------- definitions

    private static string[] SplitOptions(string? stored) => string.IsNullOrEmpty(stored) ? [] : stored.Split('\n');

    private static CustomFieldDto ToDto(CustomFieldDefinition d, int inUse) => new(d.Id, d.Name, d.Type, SplitOptions(d.Options), d.SortOrder, inUse);

    public async Task<IReadOnlyList<CustomFieldDto>> ListAsync(CancellationToken ct = default)
    {
        ctx.RequireTenantId();
        var defs = await db.CustomFieldDefinitions.AsNoTracking().OrderBy(d => d.SortOrder).ThenBy(d => d.CreatedAt).ToListAsync(ct);
        var used = await db.CustomFieldValues.GroupBy(v => v.FieldId).Select(g => new { g.Key, N = g.Count() }).ToDictionaryAsync(x => x.Key, x => x.N, ct);
        return defs.Select(d => ToDto(d, used.GetValueOrDefault(d.Id))).ToList();
    }

    private async Task RequireManageAsync(CancellationToken ct)
    {
        await permissions.RequireAsync(Permissions.WorkflowManage, ct);
        await entitlements.EnsureFeatureAsync(FeatureKeys.CustomFields, ct);
    }

    private static (string Name, string? Options) Clean(UpsertCustomFieldRequest req)
    {
        var name = (req.Name ?? "").Trim();
        if (name.Length is < 1 or > MaxName) throw new ValidationException("name", $"Give the field a name of 1 to {MaxName} characters.");
        if (!Enum.IsDefined(req.Type)) throw new ValidationException("type", "Unknown field type.");
        if (req.Type != CustomFieldType.Dropdown) return (name, null);

        var options = (req.Options ?? []).Select(o => (o ?? "").Trim()).Where(o => o.Length > 0).ToList();
        if (options.Count == 0) throw new ValidationException("options", "A dropdown needs at least one choice.");
        if (options.Count > MaxOptions) throw new ValidationException("options", $"A dropdown can have at most {MaxOptions} choices.");
        if (options.Any(o => o.Length > MaxOptionLength || o.Contains('\n'))) throw new ValidationException("options", $"Each choice can be at most {MaxOptionLength} characters.");
        if (options.Select(o => o.ToLowerInvariant()).Distinct().Count() != options.Count) throw new ValidationException("options", "The same choice appears twice.");
        return (name, string.Join('\n', options));
    }

    public async Task<CustomFieldDto> CreateAsync(UpsertCustomFieldRequest req, CancellationToken ct = default)
    {
        await RequireManageAsync(ct);
        var (name, options) = Clean(req);
        var existing = await db.CustomFieldDefinitions.ToListAsync(ct);
        if (existing.Count >= MaxFields) throw new ConflictException($"A workspace can have at most {MaxFields} custom fields.", "LIMIT_REACHED");
        if (existing.Any(d => d.Name.Equals(name, StringComparison.OrdinalIgnoreCase))) throw new ConflictException("A field with this name already exists.", "NAME_TAKEN");

        var def = new CustomFieldDefinition
        {
            TenantId = ctx.RequireTenantId(), Name = name, Type = req.Type, Options = options, SortOrder = existing.Count == 0 ? 0 : existing.Max(d => d.SortOrder) + 1,
            CreatedAt = clock.Now, CreatedBy = ctx.RequireUserId(),
        };
        db.CustomFieldDefinitions.Add(def);
        recorder.Audit("customfield.created", "CustomFieldDefinition", def.Id, newValue: new { def.Name, def.Type });
        await db.SaveChangesAsync(ct);
        return ToDto(def, 0);
    }

    /// <summary>Renames a field or edits a dropdown's choices. The type cannot change once tasks may hold values.</summary>
    public async Task<CustomFieldDto> UpdateAsync(Guid id, UpsertCustomFieldRequest req, CancellationToken ct = default)
    {
        await RequireManageAsync(ct);
        var def = await db.CustomFieldDefinitions.FirstOrDefaultAsync(d => d.Id == id, ct) ?? throw new NotFoundException("Field not found.");
        var (name, options) = Clean(req);
        if (req.Type != def.Type) throw new ConflictException("The type of a field cannot be changed. Create a new field instead.", "TYPE_LOCKED");
        if (await db.CustomFieldDefinitions.AnyAsync(d => d.Id != id && d.Name.ToLower() == name.ToLower(), ct)) throw new ConflictException("A field with this name already exists.", "NAME_TAKEN");

        def.Name = name; def.Options = options; def.UpdatedAt = clock.Now;
        recorder.Audit("customfield.updated", "CustomFieldDefinition", id, newValue: new { def.Name });
        await db.SaveChangesAsync(ct);
        return ToDto(def, await db.CustomFieldValues.CountAsync(v => v.FieldId == id, ct));
    }

    public async Task DeleteAsync(Guid id, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.WorkflowManage, ct); // deleting stays possible after a downgrade
        var def = await db.CustomFieldDefinitions.FirstOrDefaultAsync(d => d.Id == id, ct) ?? throw new NotFoundException("Field not found.");
        var values = await db.CustomFieldValues.Where(v => v.FieldId == id).ToListAsync(ct);
        db.CustomFieldValues.RemoveRange(values);
        db.CustomFieldDefinitions.Remove(def);
        recorder.Audit("customfield.deleted", "CustomFieldDefinition", id, oldValue: new { def.Name, def.Type, ValuesRemoved = values.Count });
        await db.SaveChangesAsync(ct);
    }

    public async Task<IReadOnlyList<CustomFieldDto>> ReorderAsync(OrderCustomFieldsRequest req, CancellationToken ct = default)
    {
        await RequireManageAsync(ct);
        var defs = await db.CustomFieldDefinitions.ToListAsync(ct);
        var ids = req.Ids.Distinct().ToList();
        if (ids.Count != defs.Count || defs.Any(d => !ids.Contains(d.Id))) throw new ValidationException("ids", "The list changed. Reload and try again.");
        for (var i = 0; i < ids.Count; i++) defs.First(d => d.Id == ids[i]).SortOrder = i;
        await db.SaveChangesAsync(ct);
        return await ListAsync(ct);
    }

    // ---------------------------------------------------------------- values

    /// <summary>
    /// Checks a typed-in value against its field and returns the canonical stored form, or null to clear it. Shared with CSV import,
    /// which converts its own date formats to ISO first.
    /// </summary>
    public static string? Normalize(CustomFieldDefinition def, string? raw)
    {
        var text = (raw ?? "").Trim();
        if (text.Length == 0) return null;
        switch (def.Type)
        {
            case CustomFieldType.Text:
                if (text.Length > MaxTextLength) throw new ValidationException("value", $"“{def.Name}” can be at most {MaxTextLength} characters.");
                return text;
            case CustomFieldType.Number:
                if (!decimal.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var n) || Math.Abs(n) > 1_000_000_000_000m)
                    throw new ValidationException("value", $"“{def.Name}” must be a number.");
                return n.ToString("0.####", CultureInfo.InvariantCulture);
            case CustomFieldType.Date:
                if (!DateOnly.TryParseExact(text, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d))
                    throw new ValidationException("value", $"“{def.Name}” must be a date (yyyy-mm-dd).");
                return d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            case CustomFieldType.Checkbox:
                return text.ToLowerInvariant() switch
                {
                    "true" or "yes" or "y" or "1" or "x" => "true",
                    "false" or "no" or "n" or "0" => "false",
                    _ => throw new ValidationException("value", $"“{def.Name}” must be yes or no."),
                };
            default:
                var choice = SplitOptions(def.Options).FirstOrDefault(o => o.Equals(text, StringComparison.OrdinalIgnoreCase));
                return choice ?? throw new ValidationException("value", $"“{text}” is not one of the choices for “{def.Name}”.");
        }
    }

    /// <summary>The value as a typed cell for reports: numbers and dates stay numbers and dates, checkboxes read Yes / No.</summary>
    public static object? ForExport(CustomFieldDefinition def, string value) => def.Type switch
    {
        CustomFieldType.Number when decimal.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var n) => n,
        CustomFieldType.Date when DateOnly.TryParseExact(value, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d) => d,
        CustomFieldType.Checkbox => value == "true" ? "Yes" : "No",
        _ => value,
    };

    public async Task<IReadOnlyList<CustomFieldValueDto>> GetValuesAsync(Guid taskId, CancellationToken ct = default)
    {
        if (!await access.VisibleTasks().AnyAsync(t => t.Id == taskId, ct)) throw new NotFoundException("Task not found.");
        return await db.CustomFieldValues.AsNoTracking().Where(v => v.TaskId == taskId).Select(v => new CustomFieldValueDto(v.FieldId, v.Value)).ToListAsync(ct);
    }

    public async Task<IReadOnlyList<CustomFieldValueDto>> SetValuesAsync(Guid taskId, SetCustomFieldValuesRequest req, CancellationToken ct = default)
    {
        var task = await access.VisibleTasks().FirstOrDefaultAsync(t => t.Id == taskId, ct) ?? throw new NotFoundException("Task not found.");
        await permissions.RequireTaskEditAsync(task, ct);
        var project = await db.Projects.Where(p => p.Id == task.ProjectId).Select(p => new { p.Key, p.Status }).FirstAsync(ct);
        if (project.Status == ProjectStatus.Archived) throw new ConflictException("Archived projects are read-only.", "PROJECT_ARCHIVED");

        var wanted = req.Values ?? [];
        var defs = await db.CustomFieldDefinitions.Where(d => wanted.Keys.Contains(d.Id)).ToDictionaryAsync(d => d.Id, ct);
        var existing = await db.CustomFieldValues.Where(v => v.TaskId == taskId).ToDictionaryAsync(v => v.FieldId, ct);
        var changes = new List<string>();

        foreach (var (fieldId, raw) in wanted)
        {
            if (!defs.TryGetValue(fieldId, out var def)) throw new ValidationException("values", "One of those fields does not exist.");
            var value = Normalize(def, raw);
            existing.TryGetValue(fieldId, out var row);
            if (value is null)
            {
                if (row is null) continue;
                db.CustomFieldValues.Remove(row); changes.Add($"{def.Name} cleared");
            }
            else if (row is null)
            {
                db.CustomFieldValues.Add(new CustomFieldValue { TenantId = task.TenantId, TaskId = taskId, FieldId = fieldId, Value = value, CreatedAt = clock.Now, CreatedBy = ctx.UserId });
                changes.Add($"{def.Name} = {value}");
            }
            else if (row.Value != value) { row.Value = value; row.UpdatedAt = clock.Now; changes.Add($"{def.Name} = {value}"); }
        }

        if (changes.Count > 0)
        {
            task.Version++;
            recorder.Activity("task.fields_changed", "Task", taskId, $"{project.Key}-{task.Number}: {string.Join(", ", changes)}", task.ProjectId);
        }
        await db.SaveChangesAsync(ct);
        return await GetValuesAsync(taskId, ct);
    }
}
