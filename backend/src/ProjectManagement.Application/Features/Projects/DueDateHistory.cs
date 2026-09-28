using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Projects;

/// <summary>What a person said about why a delivery date moved (already checked and cleaned).</summary>
public record DueDateNote(string? Reason, string? Dependency);

/// <summary>
/// Keeps the history of delivery (due) dates of projects, tasks and sub-tasks: every change is stored with the old and the new date, who made it,
/// when, why, and what it was waiting on. Pushing a date later (or taking it away) needs a reason, so management can see why a delivery slipped.
/// </summary>
public class DueDateHistory(IAppDbContext db, AppClock clock)
{
    public const int MaxReason = 500, MaxDependency = 300;

    /// <summary>A date moving later, or being removed, is a delay: it needs a reason.</summary>
    public static bool NeedsReason(DateOnly? previous, DateOnly? revised) => previous is not null && (revised is null || revised > previous);

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
            throw new ValidationException("dueDateReason", "Say why the due date is moving (for example a dependency, a change in scope or waiting on a client).");
        return new DueDateNote(why, on);
    }

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
            Reason = note.Reason, Dependency = note.Dependency, CreatedAt = clock.Now,
        });
}
