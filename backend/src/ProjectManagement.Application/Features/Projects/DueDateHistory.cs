using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Projects;

/// <summary>What a person said about why a delivery date moved (already checked and cleaned).</summary>
public record DueDateNote(string? Reason, string? Dependency);

/// <summary>
/// A date moved later (or a due date was removed) without saying why: 422 DATE_EXTENSION_REASON_REQUIRED, field extensionReason. Every way of
/// changing a date (the forms, bulk edits, the plan sheet, timeline and calendar drags, the assistant) ends here; imports are the exception.
/// </summary>
public sealed class DateExtensionReasonRequiredException(string what)
    : AppException(422, DateExtensionReasonRequiredException.ErrorCode, Say(what), [new ApiError(ErrorCode, Say(what), "extensionReason")])
{
    public const string ErrorCode = "DATE_EXTENSION_REASON_REQUIRED";
    private static string Say(string what) => $"Say why the {what} is moving later (for example a dependency, a change in scope or waiting on a client).";
}

/// <summary>
/// Keeps the history of delivery (due) dates of projects, tasks and sub-tasks: every change is stored with the old and the new date, who made it,
/// when, why, and what it was waiting on. Pushing a date later (or taking it away) needs a reason, so management can see why a delivery slipped.
/// </summary>
public class DueDateHistory(IAppDbContext db, AppClock clock)
{
    public const int MaxReason = 500, MaxDependency = 300;

    /// <summary>Set while an import (a spreadsheet paste, a file import) writes dates: those dates are what the file says, so no reason is asked.</summary>
    public bool Importing { get; set; }

    /// <summary><see cref="RequireReason"/>, except while importing.</summary>
    public string? Require(string what, DateOnly? previous, DateOnly? revised, string? reason, bool removalIsDelay = false) =>
        Importing ? (string.IsNullOrWhiteSpace(reason) ? null : reason.Trim()) : RequireReason(what, previous, revised, reason, removalIsDelay);

    /// <summary>A date moving later, or being removed, is a delay: it needs a reason.</summary>
    public static bool NeedsReason(DateOnly? previous, DateOnly? revised) => previous is not null && (revised is null || revised > previous);

    /// <summary>
    /// With due times: a due moving later in time (a later day, the same day at a later time, or the same day losing its time - date-only
    /// means the end of the day), or being removed, is a delay.
    /// </summary>
    public static bool NeedsReason(DateOnly? previous, TimeOnly? previousTime, DateOnly? revised, TimeOnly? revisedTime) =>
        previous is { } p && (revised is not { } r || r > p || (r == p && (revisedTime ?? TimeOnly.MaxValue) > (previousTime ?? TimeOnly.MaxValue)));

    /// <summary>
    /// <see cref="Prepare(DateOnly?, DateOnly?, string?, string?)"/> for a due that may carry a time of day: only the time changing is a change
    /// too, and moving it later in the same day needs a reason like moving the date.
    /// </summary>
    public static DueDateNote? Prepare(DateOnly? previous, TimeOnly? previousTime, DateOnly? revised, TimeOnly? revisedTime, string? reason, string? dependency)
    {
        if (previous == revised && previousTime == revisedTime) return null;
        var why = Clean(reason, MaxReason, "dueDateReason", "The reason");
        var on = Clean(dependency, MaxDependency, "dueDateDependency", "The dependency");
        if (why is null && NeedsReason(previous, previousTime, revised, revisedTime))
            throw new DateExtensionReasonRequiredException("due date");
        return new DueDateNote(why, on);
    }

    /// <summary>"due 12 Oct 2026 14:30 → 12 Oct 2026 17:00: waiting on the client" (the date-only wording when neither side has a time).</summary>
    public static string Describe(DateOnly? previous, TimeOnly? previousTime, DateOnly? revised, TimeOnly? revisedTime, string? reason)
    {
        if (previousTime is null && revisedTime is null) return Describe(previous, revised, reason);
        string D(DateOnly? d, TimeOnly? t) => d is null ? "none" : $"{d:dd MMM yyyy}{(t is { } x ? " " + x.ToString("HH:mm") : "")}";
        return $"due date {D(previous, previousTime)} → {D(revised, revisedTime)}{(string.IsNullOrEmpty(reason) ? "" : $": {reason}")}";
    }

    /// <summary>
    /// The due time an edit leaves: none without a date or when it is cleared on purpose; the time sent; otherwise the time it had (a client
    /// that does not know about due times, or a date dragged to another day, keeps the time).
    /// </summary>
    public static TimeOnly? NextTime(DateOnly? revised, TimeOnly? requested, bool clear, TimeOnly? current) =>
        revised is null || clear ? null : requested ?? current;

    /// <summary>Signed number of days the date moved (positive = later); null when it was or became empty.</summary>
    public static int? DaysShifted(DateOnly? previous, DateOnly? revised) =>
        previous is { } p && revised is { } r ? r.DayNumber - p.DayNumber : null;

    /// <summary>
    /// Checks a due-date edit before anything is changed. Returns null when the date did not change; otherwise the cleaned reason and
    /// dependency, and throws a validation error when a delay comes without a reason.
    /// </summary>
    public static DueDateNote? Prepare(DateOnly? previous, DateOnly? revised, string? reason, string? dependency)
    {
        if (previous == revised) return null;
        var why = Clean(reason, MaxReason, "dueDateReason", "The reason");
        var on = Clean(dependency, MaxDependency, "dueDateDependency", "The dependency");
        if (why is null && NeedsReason(previous, revised))
            throw new DateExtensionReasonRequiredException("due date");
        return new DueDateNote(why, on);
    }

    /// <summary>A date moving later than it was (both set). A start date being removed is not a delay; a due date being removed is (see <see cref="NeedsReason(DateOnly?, DateOnly?)"/>).</summary>
    public static bool IsLater(DateOnly? previous, DateOnly? revised) => previous is { } p && revised is { } r && r > p;

    /// <summary>
    /// The rule for every other date (start dates, a phase's planned dates, a milestone's dates, an action item's due date): moving it later needs a
    /// reason. Returns the cleaned reason (null when none was given and none was needed).
    /// </summary>
    public static string? RequireReason(string what, DateOnly? previous, DateOnly? revised, string? reason, bool removalIsDelay = false)
    {
        var why = Clean(reason, MaxReason, "extensionReason", "The reason");
        if (previous == revised) return why;
        if (why is null && (IsLater(previous, revised) || (removalIsDelay && previous is not null && revised is null)))
            throw new DateExtensionReasonRequiredException(what);
        return why;
    }

    /// <summary>The reason a request carries, under its new name (extensionReason) or the older one (dueDateReason).</summary>
    public static string? ReasonOf(string? extensionReason, string? dueDateReason) => string.IsNullOrWhiteSpace(extensionReason) ? dueDateReason : extensionReason;

    private static string? Clean(string? text, int max, string field, string label)
    {
        var t = text?.Replace("\r\n", "\n").Trim();
        if (string.IsNullOrEmpty(t)) return null;
        if (t.Length > max) throw new ValidationException(field, $"{label} can be at most {max} characters.");
        return t;
    }

    /// <summary>"due date 12 Oct 2026 → 20 Oct 2026 (8 days later): waiting on the client".</summary>
    public static string Describe(DateOnly? previous, DateOnly? revised, string? reason)
    {
        string D(DateOnly? d) => d?.ToString("dd MMM yyyy") ?? "none";
        var shift = DaysShifted(previous, revised) is { } n && n != 0 ? $" ({Math.Abs(n)} day{(Math.Abs(n) == 1 ? "" : "s")} {(n > 0 ? "later" : "earlier")})" : "";
        return $"due date {D(previous)} → {D(revised)}{shift}{(string.IsNullOrEmpty(reason) ? "" : $": {reason}")}";
    }

    /// <summary>Adds the history row to the current unit of work (the caller saves). Who and when come from the audit stamp.</summary>
    public void Record(Guid tenantId, Guid projectId, Guid? taskId, DateOnly? previous, DateOnly? revised, DueDateNote note) =>
        db.DueDateChanges.Add(new DueDateChange
        {
            TenantId = tenantId, ProjectId = projectId, TaskId = taskId, Previous = previous, Revised = revised,
            Reason = note.Reason, Dependency = note.Dependency, CreatedAt = clock.Now, EntityId = taskId ?? projectId,
        });

    /// <summary>
    /// Any other date that moved: a start date of a project or task (<paramref name="field"/> "start"), an action item's due date, a milestone's
    /// start or due date, a phase's planned start or end. Nothing is written when the date did not change.
    /// </summary>
    /// <param name="entityType">project, task, actionitem, milestone or stage.</param>
    public void RecordDate(Guid tenantId, Guid projectId, string entityType, Guid entityId, string? field, DateOnly? previous, DateOnly? revised, string? reason)
    {
        if (previous == revised) return;
        var legacy = field is null && entityType is DateKinds.Project or DateKinds.Task;
        db.DueDateChanges.Add(new DueDateChange
        {
            TenantId = tenantId, ProjectId = projectId, TaskId = entityType is DateKinds.Task or DateKinds.ActionItem ? entityId : null,
            EntityType = legacy ? null : entityType, EntityId = entityId, Field = field, Previous = previous, Revised = revised, Reason = reason, CreatedAt = clock.Now,
        });
    }
}

/// <summary>
/// How far a delivery date has slipped: the first due date it had (<see cref="OriginalDate"/>, null when it never moved), how many times it was
/// moved later (<see cref="ExtensionCount"/>) and the days between the original and the current due date (<see cref="TotalSlipDays"/>, negative
/// when it is now earlier).
/// </summary>
public record DateSlip(DateOnly? OriginalDate, int ExtensionCount, int TotalSlipDays)
{
    public static readonly DateSlip None = new(null, 0, 0);
}

public static class DateSlips
{
    /// <summary>The due-date slips of projects (their own due date), by project id. Read-only, one query.</summary>
    public static async Task<Dictionary<Guid, DateSlip>> ProjectsAsync(IAppDbContext db, IReadOnlyCollection<Guid> projectIds, CancellationToken ct)
    {
        if (projectIds.Count == 0) return new();
        var ids = projectIds.Distinct().ToList();
        var rows = await db.DueDateChanges.AsNoTracking().Where(c => c.TaskId == null && c.EntityType == null && c.Field == null && ids.Contains(c.ProjectId))
            .OrderBy(c => c.CreatedAt).ThenBy(c => c.Id).Select(c => new { Key = c.ProjectId, c.Previous, c.Revised }).ToListAsync(ct);
        return rows.GroupBy(r => r.Key).ToDictionary(g => g.Key, g => Of(g.Select(r => (r.Previous, r.Revised)).ToList()));
    }

    /// <summary>The due-date slips of tasks or action items, by item id.</summary>
    public static async Task<Dictionary<Guid, DateSlip>> ItemsAsync(IAppDbContext db, IReadOnlyCollection<Guid> itemIds, CancellationToken ct)
    {
        if (itemIds.Count == 0) return new();
        var ids = itemIds.Distinct().ToList();
        var rows = await db.DueDateChanges.AsNoTracking().Where(c => c.Field == null && c.TaskId != null && ids.Contains(c.TaskId.Value))
            .OrderBy(c => c.CreatedAt).ThenBy(c => c.Id).Select(c => new { Key = c.TaskId!.Value, c.Previous, c.Revised }).ToListAsync(ct);
        return rows.GroupBy(r => r.Key).ToDictionary(g => g.Key, g => Of(g.Select(r => (r.Previous, r.Revised)).ToList()));
    }

    /// <summary>From the changes oldest first: the first date it had, how many moves were later, and original → current in days.</summary>
    public static DateSlip Of(IReadOnlyList<(DateOnly? Previous, DateOnly? Revised)> changes)
    {
        if (changes.Count == 0) return DateSlip.None;
        var original = changes[0].Previous ?? changes[0].Revised;
        var extensions = changes.Count(c => DueDateHistory.IsLater(c.Previous, c.Revised));
        var current = changes[^1].Revised;
        var slip = original is { } o && current is { } n ? n.DayNumber - o.DayNumber : 0;
        return new DateSlip(original, extensions, slip);
    }
}

/// <summary>The kinds of item a date change is about (DueDateChange.EntityType, the activity API's entityType).</summary>
public static class DateKinds
{
    public const string Project = "project", Task = "task", ActionItem = "actionitem", Milestone = "milestone", Stage = "stage";
    /// <summary>DueDateChange.Field: null is the due (end) date.</summary>
    public const string Start = "start", End = "end";
}
