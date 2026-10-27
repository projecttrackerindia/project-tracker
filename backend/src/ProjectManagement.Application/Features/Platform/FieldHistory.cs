using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Services;

namespace ProjectManagement.Application.Features.Platform;

/// <summary>
/// The fields one save changed, as text people can read ("Status": "To do" → "In progress"). Written as one audit row per save
/// (<c>{kind}.fields_changed</c>, old and new values as JSON objects keyed by field) so the History list can show who changed what and when
/// without a table of its own; the audit log is already tamper-evident and kept per workspace.
/// </summary>
public sealed class FieldDiff
{
    public const string ActionSuffix = ".fields_changed";
    private readonly Dictionary<string, string?> _old = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string?> _new = new(StringComparer.Ordinal);

    public int Count => _old.Count;

    /// <summary>Adds the field when its value changed (texts compared as shown; long values are cut to 200 characters).</summary>
    public FieldDiff Add(string field, string? before, string? after, int max = 100)
    {
        before = Clip(string.IsNullOrWhiteSpace(before) ? null : before.Trim(), max);
        after = Clip(string.IsNullOrWhiteSpace(after) ? null : after.Trim(), max);
        if (string.Equals(before, after, StringComparison.Ordinal)) return this;
        _old[field] = before; _new[field] = after;
        return this;
    }

    public FieldDiff Add(string field, DateOnly? before, DateOnly? after) =>
        Add(field, before?.ToString("yyyy-MM-dd"), after?.ToString("yyyy-MM-dd"));

    /// <summary>Writes the audit row (nothing when nothing changed). <paramref name="kind"/> is task, worktask, actionitem, issue or project.</summary>
    public void Record(Recorder recorder, string kind, string entityType, Guid id)
    {
        if (_old.Count == 0) return;
        recorder.Audit(kind + ActionSuffix, entityType, id, new Dictionary<string, string?>(_old), new Dictionary<string, string?>(_new));
    }

    private static string? Clip(string? s, int max) => s is { } t && t.Length > max ? t[..(max - 1)] + "…" : s;

    /// <summary>The display names of the people a save touched (old and new assignee, owner ...), in one query.</summary>
    public static async Task<Dictionary<Guid, string>> NamesAsync(IAppDbContext db, IEnumerable<Guid?> ids, CancellationToken ct)
    {
        var list = ids.Where(x => x is not null).Select(x => x!.Value).Distinct().ToList();
        return list.Count == 0 ? new() : await db.Users.AsNoTracking().Where(u => list.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
    }

    public static string? Name(Dictionary<Guid, string> names, Guid? id) => id is { } g ? names.GetValueOrDefault(g, "Someone") : null;
}

/// <summary>One field change in an item's or a project's History: who, when, which field, old → new.</summary>
public record HistoryEntryDto(Guid Id, DateTime At, UserRefDto? Actor, string Field, string? From, string? To);

/// <summary>
/// History for work items and projects: the field changes recorded by <see cref="FieldDiff"/>, newest first; for changes made before that
/// existed, the activity rows that carried an old and a new value. The caller must already be allowed to see the item (checked by the callers).
/// </summary>
public class HistoryService(IAppDbContext db, ICurrentContext ctx, ProjectAccess access)
{
    public const int Max = 200;

    /// <summary>A project's History: needs the right to see the project.</summary>
    public async Task<IReadOnlyList<HistoryEntryDto>> ProjectAsync(Guid projectId, CancellationToken ct = default)
    {
        await access.GetProjectAsync(projectId, ct);
        return await ForAsync(projectId, ct);
    }

    public async Task<IReadOnlyList<HistoryEntryDto>> ForAsync(Guid entityId, CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        // AuditLogs is not tenant-filtered (platform rows have no workspace): the workspace is named here.
        var audits = await db.AuditLogs.AsNoTracking().Where(a => a.TenantId == tid && a.EntityId == entityId && a.Action.EndsWith(FieldDiff.ActionSuffix))
            .OrderByDescending(a => a.CreatedAt).Take(Max).Select(a => new { a.Id, a.CreatedAt, a.UserId, a.OldValue, a.NewValue }).ToListAsync(ct);
        var rows = new List<HistoryEntryDto>();
        foreach (var a in audits)
        {
            var before = Parse(a.OldValue); var after = Parse(a.NewValue);
            foreach (var field in after.Keys.Union(before.Keys))
                rows.Add(new HistoryEntryDto(a.Id, a.CreatedAt, a.UserId is { } u ? new UserRefDto(u, "") : null, field, before.GetValueOrDefault(field), after.GetValueOrDefault(field)));
        }
        // Older changes: activity rows with both values (status, due date, phase, title ...), from before field diffs were recorded.
        // (A save writes its activity rows a moment before or after its field diff: those are the same change, so the cut-off leaves a minute's margin.)
        var since = audits.Count > 0 ? audits.Min(a => a.CreatedAt).AddMinutes(-1) : DateTime.MaxValue;
        var legacy = await db.Activities.AsNoTracking().Where(a => a.EntityId == entityId && a.CreatedAt < since && (a.OldValue != null || a.NewValue != null))
            .OrderByDescending(a => a.CreatedAt).Take(Max).Select(a => new { a.Id, a.CreatedAt, a.ActorId, a.Action, a.OldValue, a.NewValue }).ToListAsync(ct);
        rows.AddRange(legacy.Select(a => new HistoryEntryDto(a.Id, a.CreatedAt, a.ActorId is { } u ? new UserRefDto(u, "") : null, FieldOf(a.Action), a.OldValue, a.NewValue)));

        var ordered = rows.OrderByDescending(r => r.At).ThenBy(r => r.Field).Take(Max).ToList();
        var ids = ordered.Where(r => r.Actor is not null).Select(r => r.Actor!.Id).Distinct().ToList();
        var names = ids.Count == 0 ? new Dictionary<Guid, string>() : await db.Users.AsNoTracking().Where(u => ids.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        return ordered.Select(r => r.Actor is { } x ? r with { Actor = new UserRefDto(x.Id, names.GetValueOrDefault(x.Id, "Someone")) } : r).ToList();
    }

    /// <summary>"task.status_changed" → Status, "project.due_changed" → Due date …</summary>
    public static string FieldOf(string action)
    {
        var a = action.ToLowerInvariant();
        if (a.Contains("status")) return "Status";
        if (a.Contains("due")) return "Due date";
        if (a.Contains("start")) return "Start date";
        if (a.Contains("stage")) return "Phase";
        if (a.Contains("renamed")) return "Title";
        if (a.Contains("priority")) return "Priority";
        if (a.Contains("health")) return "Health";
        if (a.Contains("delivery")) return "Delivery method";
        if (a.Contains("assign")) return "Assignee";
        return "Change";
    }

    private static Dictionary<string, string?> Parse(string? json)
    {
        if (string.IsNullOrWhiteSpace(json) || json[0] != '{') return new();
        try { return JsonSerializer.Deserialize<Dictionary<string, string?>>(json) ?? new(); }
        catch (JsonException) { return new(); }
    }
}
