using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Entities;

/// <summary>
/// A repeating task: the rule (every day, weekdays, every week on some days, every month on a date or on the nth weekday, every N days/weeks/months),
/// when it ends (after N times or by a date), and the fields every new occurrence copies. Each occurrence is an ordinary task, linked to the
/// series by a <see cref="TaskOccurrence"/> row; the next one is made when the current one is completed, or a few days ahead by the background job.
/// "All following" changes end this series before the edited occurrence and start a new one from it, so the past keeps the rule it ran under.
/// </summary>
public class TaskRecurrence : TenantEntity, ITenantScoped
{
    public Guid ProjectId { get; set; }
    /// <summary>What each new occurrence is called, its notes, priority and owner ("all following" edits change these; "this one" edits only the task).</summary>
    public string Title { get; set; } = "";
    public string? Description { get; set; }
    public ProjectManagement.Domain.Enums.Priority Priority { get; set; } = ProjectManagement.Domain.Enums.Priority.Medium;
    public Guid? AssigneeId { get; set; }
    /// <summary>daily, weekdays, weekly or monthly.</summary>
    public string Frequency { get; set; } = "weekly";
    /// <summary>Every N days / weeks / months (1 = every one). Ignored for weekdays.</summary>
    public int Interval { get; set; } = 1;
    /// <summary>Weekly: the ISO weekdays it falls on ("1,3,5" = Monday, Wednesday, Friday). Empty = the weekday of the first occurrence.</summary>
    public string? DaysOfWeek { get; set; }
    /// <summary>Monthly by date: the day of the month (a short month uses its last day).</summary>
    public int? MonthDay { get; set; }
    /// <summary>Monthly by weekday: which one (1-4, 5 = the last) of <see cref="MonthWeekday"/> (ISO 1-7).</summary>
    public int? MonthWeek { get; set; }
    public int? MonthWeekday { get; set; }
    /// <summary>Stop after this many occurrences (skipped ones count).</summary>
    public int? EndAfter { get; set; }
    /// <summary>Stop after this date.</summary>
    public DateOnly? EndBy { get; set; }
    /// <summary>The first occurrence's date: weekly intervals count from its week.</summary>
    public DateOnly AnchorDate { get; set; }
    /// <summary>Dates that were skipped (ISO, comma separated): never generated again.</summary>
    public string? SkippedDates { get; set; }
    /// <summary>Days between an occurrence's start and due date (null = occurrences have no start date).</summary>
    public int? LeadDays { get; set; }
    /// <summary>False once the series has ended, was stopped, or was split by an "all following" change.</summary>
    public bool IsActive { get; set; } = true;
}

/// <summary>One task of a repeating series: which series, which date it is for, and its place in the series (1 first).</summary>
public class TaskOccurrence : TenantEntity, ITenantScoped
{
    public Guid RecurrenceId { get; set; }
    public Guid TaskId { get; set; }
    public int Index { get; set; }
    public DateOnly Date { get; set; }
}

/// <summary>
/// A reusable project or task: sections, tasks with sub-tasks, checklists, labels, default owners and dates kept as day offsets from the start, so
/// "Create from template" with a start date shifts every date. The content is JSON (see the Application's TemplateContent).
/// </summary>
public class WorkTemplate : TenantEntity, ITenantScoped
{
    /// <summary>project or task.</summary>
    public string Kind { get; set; } = "project";
    public string Name { get; set; } = "";
    public string? Description { get; set; }
    public string ContentJson { get; set; } = "{}";
}
