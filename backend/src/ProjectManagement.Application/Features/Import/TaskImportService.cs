using System.Globalization;
using System.Text;
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

namespace ProjectManagement.Application.Features.Import;

public record ImportError(int Row, string Field, string Message);
public record ImportOptions(bool SkipInvalid, bool CreateMissingLabels, string DateFormat);

/// <summary>What the file looks like and how it would import with the chosen column mapping.</summary>
public record ImportPreviewDto(char Delimiter, IReadOnlyList<string> Headers, IReadOnlyList<IReadOnlyList<string>> Sample, int TotalRows,
    IReadOnlyDictionary<string, int> SuggestedMapping, int ValidRows, int InvalidRows, IReadOnlyList<ImportError> Errors, int NewLabels);
public record ImportResultDto(int Created, int Skipped, int LabelsCreated, IReadOnlyList<ImportError> Errors);

/// <summary>
/// Imports tasks from a CSV file into a project. The same validation runs for the preview and for the real import, so what the
/// preview promises is what happens. Nothing is stored between the two calls: the file is sent again with the chosen mapping.
/// </summary>
public class TaskImportService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, PermissionService permissions,
    EntitlementService entitlements, ProjectAccess access, PriorityService priorities)
{
    public const int MaxRows = 5000;
    public const long MaxBytes = 2 * 1024 * 1024;
    private const int MaxNewLabels = 20;
    private const int MaxErrorsShown = 50;

    /// <summary>The task fields a column can be mapped to.</summary>
    public static readonly string[] Fields = ["title", "description", "status", "priority", "assignee", "startDate", "dueDate", "estimatedHours", "labels", "milestone"];

    private static readonly Dictionary<string, string[]> Aliases = new()
    {
        ["title"] = ["title", "name", "task", "summary", "subject"],
        ["description"] = ["description", "details", "notes", "body"],
        ["status"] = ["status", "state", "stage"],
        ["priority"] = ["priority", "importance", "severity"],
        ["assignee"] = ["assignee", "assigned to", "owner", "assigned", "email"],
        ["startDate"] = ["start date", "start", "begin", "starts"],
        ["dueDate"] = ["due date", "due", "deadline", "end date", "target date"],
        ["estimatedHours"] = ["estimated hours", "estimate", "hours", "effort", "estimated"],
        ["labels"] = ["labels", "label", "tags", "tag"],
        ["milestone"] = ["milestone", "release", "version"],
    };

    // ---------------------------------------------------------------- reading the file

    public static string Decode(byte[] bytes)
    {
        if (bytes.Length > MaxBytes) throw new ValidationException("file", $"The file is larger than {MaxBytes / 1024 / 1024} MB.");
        return new UTF8Encoding(false, false).GetString(bytes);
    }

    private static CsvTable Read(byte[] bytes)
    {
        try { return CsvParser.Parse(Decode(bytes), MaxRows); }
        catch (CsvException e) { throw new ValidationException("file", e.Message); }
    }

    /// <summary>Guesses which column is which from the header names (first match wins; a column is used once).</summary>
    private static Dictionary<string, int> Suggest(IReadOnlyList<string> headers, Dictionary<string, CustomFieldDefinition> custom)
    {
        var map = new Dictionary<string, int>();
        var lower = headers.Select(h => h.Trim().ToLowerInvariant()).ToList();
        foreach (var field in Fields)
        {
            var i = lower.FindIndex(h => Aliases[field].Contains(h) && !map.ContainsValue(lower.IndexOf(h)));
            if (i >= 0) map[field] = i;
        }
        foreach (var (key, def) in custom)
        {
            var i = lower.FindIndex(h => h == def.Name.ToLowerInvariant() && !map.ContainsValue(lower.IndexOf(h)));
            if (i >= 0) map[key] = i;
        }
        return map;
    }

    public static Dictionary<string, int> ParseMapping(string? json, int columns, IEnumerable<string>? extraFields = null)
    {
        if (string.IsNullOrWhiteSpace(json)) return [];
        Dictionary<string, int>? map;
        try { map = JsonSerializer.Deserialize<Dictionary<string, int>>(json, new JsonSerializerOptions(JsonSerializerDefaults.Web)); }
        catch (JsonException) { throw new ValidationException("mapping", "The column mapping could not be read."); }
        map ??= [];
        foreach (var (field, col) in map)
        {
            if (!Fields.Contains(field) && extraFields?.Contains(field) != true) throw new ValidationException("mapping", $"Unknown field “{field}”.");
            if (col < 0 || col >= columns) throw new ValidationException("mapping", $"Column {col + 1} does not exist.");
        }
        if (map.Values.Distinct().Count() != map.Count) throw new ValidationException("mapping", "Each column can only be used for one field.");
        return map;
    }

    // ---------------------------------------------------------------- validating rows

    private record ParsedRow(int Number, string Title, string? Description, Guid StatusId, Priority Priority, Guid? AssigneeId, DateOnly? Start, DateOnly? Due,
        decimal? Hours, List<string> Labels, Guid? MilestoneId, Dictionary<Guid, string> Custom);

    private record Lookups(Project Project, List<WorkflowStatus> Statuses, Dictionary<string, Guid> Members, Dictionary<string, Priority> Priorities,
        Dictionary<string, Guid> Milestones, HashSet<string> LabelNames, Dictionary<string, CustomFieldDefinition> Custom);

    private async Task<Lookups> LoadLookupsAsync(Guid projectId, CancellationToken ct)
    {
        var project = await access.GetProjectAsync(projectId, ct);
        await permissions.RequireAsync(Permissions.TasksCreate, ct);
        if (project.Status == ProjectStatus.Archived) throw new ConflictException("Archived projects are read-only. Restore the project to import tasks.", "PROJECT_ARCHIVED");
        var tid = ctx.RequireTenantId();

        var statuses = await db.WorkflowStatuses.Where(s => s.ProjectId == projectId).OrderBy(s => s.Order).ToListAsync(ct);
        var members = new Dictionary<string, Guid>(StringComparer.OrdinalIgnoreCase);
        foreach (var m in await db.TenantMembers.Where(m => m.TenantId == tid).Join(db.Users, m => m.UserId, u => u.Id, (m, u) => new { u.Id, u.Email, u.DisplayName }).ToListAsync(ct))
        {
            members[m.Email] = m.Id;
            members.TryAdd(m.DisplayName, m.Id);   // the e-mail address always wins over a name that happens to match
        }
        var prio = new Dictionary<string, Priority>(StringComparer.OrdinalIgnoreCase);
        foreach (var p in await priorities.GetAsync(ct)) { prio[p.Name] = p.Level; prio.TryAdd(p.Level.ToString(), p.Level); }
        var milestones = (await db.Milestones.Where(m => m.ProjectId == projectId).Select(m => new { m.Name, m.Id }).ToListAsync(ct))
            .GroupBy(m => m.Name.ToLowerInvariant()).ToDictionary(g => g.Key, g => g.First().Id);
        var labels = (await db.Labels.Select(l => l.Name).ToListAsync(ct)).Select(n => n.ToLowerInvariant()).ToHashSet();
        // Custom fields are mapped as "cf:<id>" so they can never clash with a built-in field name.
        var custom = (await db.CustomFieldDefinitions.ToListAsync(ct)).ToDictionary(d => $"cf:{d.Id}");
        return new Lookups(project, statuses, members, prio, milestones, labels, custom);
    }

    private static readonly string[] IsoFormats = ["yyyy-MM-dd", "yyyy-M-d", "yyyy/MM/dd", "yyyyMMdd"];
    private static readonly string[] DmyFormats = ["dd/MM/yyyy", "d/M/yyyy", "dd-MM-yyyy", "d-M-yyyy", "dd.MM.yyyy", "d.M.yyyy", "dd MMM yyyy", "d MMM yyyy"];
    private static readonly string[] MdyFormats = ["MM/dd/yyyy", "M/d/yyyy", "MM-dd-yyyy", "M-d-yyyy", "MMM d, yyyy", "MMM dd, yyyy"];

    private static bool TryDate(string text, string format, out DateOnly date)
    {
        var formats = IsoFormats.Concat(format == "mdy" ? MdyFormats : DmyFormats).ToArray();
        return DateOnly.TryParseExact(text.Trim(), formats, CultureInfo.InvariantCulture, DateTimeStyles.None, out date);
    }

    private (List<ParsedRow> Rows, List<ImportError> Errors, HashSet<string> NewLabels, int Invalid) Validate(
        CsvTable table, Dictionary<string, int> map, Lookups lk, ImportOptions options)
    {
        var rows = new List<ParsedRow>(); var errors = new List<ImportError>(); var newLabels = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var invalid = 0;
        var defaultStatus = (lk.Statuses.FirstOrDefault(s => s.Category == StatusCategory.Todo) ?? lk.Statuses.First()).Id;

        string Cell(IReadOnlyList<string> r, string field) => map.TryGetValue(field, out var c) && c < r.Count ? r[c].Trim() : "";

        for (var i = 0; i < table.Rows.Count; i++)
        {
            var r = table.Rows[i]; var n = i + 2;   // row 1 is the header, so the first data row is row 2 (as in a spreadsheet)
            var rowErrors = new List<ImportError>();
            void Bad(string field, string msg) => rowErrors.Add(new ImportError(n, field, msg));

            var title = Cell(r, "title");
            if (title.Length == 0) Bad("title", "Title is empty.");
            else if (title.Length > 200) Bad("title", "Title is longer than 200 characters.");
            var description = Cell(r, "description");
            if (description.Length > 10000) Bad("description", "Description is longer than 10,000 characters.");

            var statusId = defaultStatus;
            var status = Cell(r, "status");
            if (status.Length > 0)
            {
                var s = lk.Statuses.FirstOrDefault(x => x.Name.Equals(status, StringComparison.OrdinalIgnoreCase));
                if (s is null) Bad("status", $"Unknown status “{status}”. This project has: {string.Join(", ", lk.Statuses.Select(x => x.Name))}.");
                else statusId = s.Id;
            }

            var priority = Priority.Medium;
            var prio = Cell(r, "priority");
            if (prio.Length > 0)
            {
                if (lk.Priorities.TryGetValue(prio, out var pv)) priority = pv;
                else Bad("priority", $"Unknown priority “{prio}”.");
            }

            Guid? assignee = null;
            var who = Cell(r, "assignee");
            if (who.Length > 0)
            {
                if (lk.Members.TryGetValue(who, out var uid)) assignee = uid;
                else Bad("assignee", $"“{who}” is not a member of this workspace.");
            }

            DateOnly? start = null, due = null;
            var sd = Cell(r, "startDate"); var dd = Cell(r, "dueDate");
            if (sd.Length > 0) { if (TryDate(sd, options.DateFormat, out var d)) start = d; else Bad("startDate", $"“{sd}” is not a date in the chosen format."); }
            if (dd.Length > 0) { if (TryDate(dd, options.DateFormat, out var d)) due = d; else Bad("dueDate", $"“{dd}” is not a date in the chosen format."); }
            if (start is { } a && due is { } b && b < a) Bad("dueDate", "Due date is before the start date.");

            decimal? hours = null;
            var hs = Cell(r, "estimatedHours");
            if (hs.Length > 0)
            {
                if (decimal.TryParse(hs.Replace(',', '.'), NumberStyles.Number, CultureInfo.InvariantCulture, out var h) && h is >= 0 and <= 10000) hours = h;
                else Bad("estimatedHours", $"“{hs}” is not a number of hours between 0 and 10000.");
            }

            var labelNames = Cell(r, "labels").Split([',', ';', '|'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Where(l => l.Length > 0).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
            foreach (var l in labelNames)
            {
                if (l.Length > 50) Bad("labels", $"Label “{l[..20]}…” is too long.");
                else if (!lk.LabelNames.Contains(l.ToLowerInvariant()))
                {
                    if (options.CreateMissingLabels) newLabels.Add(l); else Bad("labels", $"Label “{l}” does not exist.");
                }
            }

            Guid? milestone = null;
            var ms = Cell(r, "milestone");
            if (ms.Length > 0)
            {
                if (lk.Milestones.TryGetValue(ms.ToLowerInvariant(), out var mid)) milestone = mid;
                else Bad("milestone", $"Milestone “{ms}” does not exist in this project.");
            }

            var custom = new Dictionary<Guid, string>();
            foreach (var (key, def) in lk.Custom)
            {
                if (!map.ContainsKey(key)) continue;
                var raw = Cell(r, key);
                if (raw.Length == 0) continue;
                // Dates arrive in the file's own format; the field stores ISO.
                if (def.Type == CustomFieldType.Date) { if (TryDate(raw, options.DateFormat, out var cd)) raw = cd.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture); }
                else if (def.Type == CustomFieldType.Number) raw = raw.Replace(',', '.');
                try { var v = CustomFieldService.Normalize(def, raw); if (v is not null) custom[def.Id] = v; }
                catch (ValidationException e) { Bad(def.Name, e.Message); }
            }

            if (rowErrors.Count > 0) { invalid++; errors.AddRange(rowErrors); continue; }
            rows.Add(new ParsedRow(n, title, description.Length == 0 ? null : description, statusId, priority, assignee, start, due, hours, labelNames, milestone, custom));
        }
        return (rows, errors, newLabels, invalid);
    }

    private ImportOptions Clean(ImportOptions? o) => new(o?.SkipInvalid ?? false, o?.CreateMissingLabels ?? true, o?.DateFormat == "mdy" ? "mdy" : "dmy");

    // ---------------------------------------------------------------- preview

    public async Task<ImportPreviewDto> PreviewAsync(Guid projectId, byte[] file, string? mappingJson, ImportOptions? options, CancellationToken ct = default)
    {
        var lk = await LoadLookupsAsync(projectId, ct);
        var table = Read(file);
        var suggested = Suggest(table.Headers, lk.Custom);
        var map = string.IsNullOrWhiteSpace(mappingJson) ? suggested : ParseMapping(mappingJson, table.Headers.Count, lk.Custom.Keys);
        var sample = table.Rows.Take(5).Select(r => (IReadOnlyList<string>)r.Select(c => c.Length > 120 ? c[..120] + "…" : c).ToList()).ToList();

        if (!map.ContainsKey("title"))
            return new ImportPreviewDto(table.Delimiter, table.Headers, sample, table.Rows.Count, suggested, 0, table.Rows.Count,
                [new ImportError(0, "title", "Choose which column holds the task title.")], 0);

        var (rows, errors, newLabels, invalid) = Validate(table, map, lk, Clean(options));
        return new ImportPreviewDto(table.Delimiter, table.Headers, sample, table.Rows.Count, suggested, rows.Count, invalid, errors.Take(MaxErrorsShown).ToList(), newLabels.Count);
    }

    // ---------------------------------------------------------------- import

    public async Task<ImportResultDto> ImportAsync(Guid projectId, byte[] file, string? mappingJson, ImportOptions? options, CancellationToken ct = default)
    {
        var lk = await LoadLookupsAsync(projectId, ct);
        var opt = Clean(options);
        var table = Read(file);
        var map = string.IsNullOrWhiteSpace(mappingJson) ? Suggest(table.Headers, lk.Custom) : ParseMapping(mappingJson, table.Headers.Count, lk.Custom.Keys);
        if (!map.ContainsKey("title")) throw new ValidationException("mapping", "Choose which column holds the task title.");

        var (rows, errors, newLabels, invalid) = Validate(table, map, lk, opt);
        if (invalid > 0 && !opt.SkipInvalid)
            throw new ConflictException($"{invalid} row{(invalid == 1 ? " has" : "s have")} problems. Fix the file, or choose to skip the invalid rows.", "IMPORT_INVALID_ROWS");
        if (rows.Count == 0) throw new ValidationException("file", "There are no valid rows to import.");
        if (newLabels.Count > MaxNewLabels) throw new ValidationException("labels", $"The file would create {newLabels.Count} new labels. Import is limited to {MaxNewLabels} new labels at once.");

        await entitlements.EnsureWithinLimitAsync(FeatureKeys.TaskLimit, await db.Tasks.CountAsync(ct), rows.Count, ct);

        var tid = ctx.RequireTenantId(); var uid = ctx.RequireUserId(); var now = clock.Now;
        var labelIds = (await db.Labels.ToListAsync(ct)).ToDictionary(l => l.Name.ToLowerInvariant(), l => l.Id);
        foreach (var name in newLabels.Where(n => !labelIds.ContainsKey(n.ToLowerInvariant())))
        {
            var label = new Label { TenantId = tid, Name = name, CreatedAt = now, CreatedBy = uid };
            db.Labels.Add(label);
            labelIds[name.ToLowerInvariant()] = label.Id;
        }

        var number = await db.Tasks.IgnoreQueryFilters().Where(t => t.ProjectId == projectId).MaxAsync(t => (int?)t.Number, ct) ?? 0;
        var positions = (await db.Tasks.Where(t => t.ProjectId == projectId).GroupBy(t => t.StatusId).Select(g => new { g.Key, Max = g.Max(t => t.Position) }).ToListAsync(ct))
            .ToDictionary(x => x.Key, x => x.Max);
        var doneStatuses = lk.Statuses.Where(s => s.Category == StatusCategory.Done).Select(s => s.Id).ToHashSet();

        foreach (var r in rows)
        {
            var task = new TaskItem
            {
                TenantId = tid, ProjectId = projectId, Number = ++number, Title = r.Title, Description = r.Description, StatusId = r.StatusId, Priority = r.Priority,
                AssigneeId = r.AssigneeId, ReporterId = uid, StartDate = r.Start, DueDate = r.Due, EstimatedHours = r.Hours, MilestoneId = r.MilestoneId,
                Position = positions.GetValueOrDefault(r.StatusId) + 1000, CreatedAt = now, CreatedBy = uid, CompletedAt = doneStatuses.Contains(r.StatusId) ? now : null,
            };
            positions[r.StatusId] = task.Position;
            db.Tasks.Add(task);
            foreach (var (fieldId, value) in r.Custom) db.CustomFieldValues.Add(new CustomFieldValue { TenantId = tid, TaskId = task.Id, FieldId = fieldId, Value = value, CreatedAt = now, CreatedBy = uid });
            foreach (var l in r.Labels) db.TaskLabels.Add(new TaskLabel { TenantId = tid, TaskId = task.Id, LabelId = labelIds[l.ToLowerInvariant()], CreatedAt = now });
        }

        lk.Project.UpdatedAt = now;
        // One summary entry instead of one per task, and no assignment notifications: a bulk import should not flood anyone's inbox.
        recorder.Activity("task.imported", "Project", projectId, $"Imported {rows.Count} task{(rows.Count == 1 ? "" : "s")} from a CSV file into {lk.Project.Key}", projectId);
        recorder.Audit("task.import", "Project", projectId, newValue: new { Created = rows.Count, Skipped = invalid, LabelsCreated = newLabels.Count });
        await db.SaveChangesAsync(ct);
        return new ImportResultDto(rows.Count, invalid, newLabels.Count, errors.Take(MaxErrorsShown).ToList());
    }
}
