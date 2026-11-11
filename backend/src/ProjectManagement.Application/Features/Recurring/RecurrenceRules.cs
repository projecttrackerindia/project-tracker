using System.Globalization;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Recurring;

/// <summary>A repeat rule as the API takes and returns it.</summary>
/// <param name="Frequency">daily, weekdays, weekly, monthly, or custom (every <paramref name="Interval"/> of <paramref name="Unit"/>).</param>
/// <param name="Unit">For custom: day, week or month.</param>
/// <param name="DaysOfWeek">Weekly: ISO weekdays (1 = Monday ... 7 = Sunday).</param>
/// <param name="MonthWeek">Monthly by weekday: 1-4, or 5 for the last.</param>
public record RecurrenceRuleDto(string Frequency, int Interval = 1, string? Unit = null, IReadOnlyList<int>? DaysOfWeek = null, int? MonthDay = null,
    int? MonthWeek = null, int? MonthWeekday = null, int? EndAfter = null, DateOnly? EndBy = null);

/// <summary>The date arithmetic of repeat rules: pure, so it is tested on its own.</summary>
public static class RecurrenceRules
{
    public static int IsoDay(DateOnly d) => d.DayOfWeek == DayOfWeek.Sunday ? 7 : (int)d.DayOfWeek;

    private static readonly string[] DayNames = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    private static readonly string[] Ordinals = ["", "first", "second", "third", "fourth", "last"];

    /// <summary>Normalises a request into the stored columns; throws a validation error for a rule that cannot work.</summary>
    public static void Apply(TaskRecurrence r, RecurrenceRuleDto rule, DateOnly anchor)
    {
        var freq = (rule.Frequency ?? "").Trim().ToLowerInvariant();
        if (freq == "custom")
            freq = (rule.Unit ?? "day").Trim().ToLowerInvariant() switch { "day" or "days" => "daily", "week" or "weeks" => "weekly", "month" or "months" => "monthly", _ => "" };
        if (freq is not ("daily" or "weekdays" or "weekly" or "monthly"))
            throw new ValidationException("frequency", "Choose daily, weekdays, weekly, monthly or a custom interval.");
        if (rule.Interval is < 1 or > 365) throw new ValidationException("interval", "Repeat every 1 to 365.");
        if (rule.EndAfter is < 1 or > 1000) throw new ValidationException("endAfter", "End after 1 to 1000 times.");
        if (rule.EndBy is { } by && by < anchor) throw new ValidationException("endBy", "The end date must not be before the first occurrence.");
        var days = (rule.DaysOfWeek ?? []).Distinct().OrderBy(d => d).ToList();
        if (days.Any(d => d is < 1 or > 7)) throw new ValidationException("daysOfWeek", "Weekdays are 1 (Monday) to 7 (Sunday).");
        if (rule.MonthDay is < 1 or > 31) throw new ValidationException("monthDay", "Day of the month is 1 to 31.");
        if (rule.MonthWeek is < 1 or > 5) throw new ValidationException("monthWeek", "Which week is 1 to 4, or 5 for the last.");
        if (rule.MonthWeekday is < 1 or > 7) throw new ValidationException("monthWeekday", "Weekdays are 1 (Monday) to 7 (Sunday).");
        if ((rule.MonthWeek is null) != (rule.MonthWeekday is null)) throw new ValidationException("monthWeek", "Give both the week and the weekday.");

        r.Frequency = freq;
        r.Interval = freq == "weekdays" ? 1 : rule.Interval;
        r.DaysOfWeek = freq == "weekly" ? string.Join(",", days.Count == 0 ? [IsoDay(anchor)] : days) : null;
        r.MonthWeek = freq == "monthly" ? rule.MonthWeek : null;
        r.MonthWeekday = freq == "monthly" ? rule.MonthWeekday : null;
        r.MonthDay = freq == "monthly" && rule.MonthWeek is null ? rule.MonthDay ?? anchor.Day : null;
        r.EndAfter = rule.EndAfter;
        r.EndBy = rule.EndBy;
        r.AnchorDate = anchor;
    }

    public static RecurrenceRuleDto ToDto(TaskRecurrence r) => new(r.Frequency, r.Interval, null, Days(r), r.MonthDay, r.MonthWeek, r.MonthWeekday, r.EndAfter, r.EndBy);

    public static IReadOnlyList<int> Days(TaskRecurrence r) =>
        (r.DaysOfWeek ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries).Select(x => int.Parse(x, CultureInfo.InvariantCulture)).ToList();

    public static HashSet<DateOnly> Skipped(TaskRecurrence r) =>
        (r.SkippedDates ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries).Select(x => DateOnly.ParseExact(x, "yyyy-MM-dd", CultureInfo.InvariantCulture)).ToHashSet();

    public static void AddSkipped(TaskRecurrence r, DateOnly d)
    {
        var set = Skipped(r); set.Add(d);
        r.SkippedDates = string.Join(",", set.OrderBy(x => x).TakeLast(300).Select(x => x.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)));
    }

    /// <summary>The nth (1-4, 5 = last) ISO weekday of a month.</summary>
    public static DateOnly NthWeekday(int year, int month, int week, int isoDay)
    {
        if (week >= 5)
        {
            var last = new DateOnly(year, month, DateTime.DaysInMonth(year, month));
            while (IsoDay(last) != isoDay) last = last.AddDays(-1);
            return last;
        }
        var d = new DateOnly(year, month, 1);
        while (IsoDay(d) != isoDay) d = d.AddDays(1);
        return d.AddDays(7 * (week - 1));
    }

    private static DateOnly MonthDate(int year, int month, int day) => new(year, month, Math.Min(day, DateTime.DaysInMonth(year, month)));

    private static int MonthsBetween(DateOnly a, DateOnly b) => (b.Year - a.Year) * 12 + b.Month - a.Month;

    private static DateOnly WeekStart(DateOnly d) => d.AddDays(1 - IsoDay(d));

    /// <summary>The first date the rule falls on strictly after <paramref name="after"/>, ignoring skips and the end. Never null for a valid rule.</summary>
    public static DateOnly Raw(TaskRecurrence r, DateOnly after)
    {
        switch (r.Frequency)
        {
            case "daily":
                {
                    // On the grid that starts at the anchor, every Interval days.
                    var span = after.DayNumber - r.AnchorDate.DayNumber;
                    var steps = span < 0 ? 0 : span / r.Interval + 1;
                    return r.AnchorDate.AddDays(steps * r.Interval);
                }
            case "weekdays":
                {
                    var d = after.AddDays(1);
                    while (IsoDay(d) > 5) d = d.AddDays(1);
                    return d;
                }
            case "weekly":
                {
                    var days = Days(r);
                    if (days.Count == 0) days = [IsoDay(r.AnchorDate)];
                    var anchorWeek = WeekStart(r.AnchorDate);
                    var d = after.AddDays(1);
                    for (var i = 0; i < 7 * r.Interval + 14; i++, d = d.AddDays(1))
                    {
                        var weeks = (WeekStart(d).DayNumber - anchorWeek.DayNumber) / 7;
                        if (weeks >= 0 && weeks % r.Interval == 0 && days.Contains(IsoDay(d))) return d;
                    }
                    return after.AddDays(7 * r.Interval);
                }
            default: // monthly
                {
                    var start = new DateOnly(after.Year, after.Month, 1);
                    var offset = MonthsBetween(r.AnchorDate, start);
                    if (offset < 0) { start = new DateOnly(r.AnchorDate.Year, r.AnchorDate.Month, 1); offset = 0; }
                    var rem = offset % r.Interval;
                    if (rem != 0) start = start.AddMonths(r.Interval - rem);
                    for (var i = 0; i < 4; i++, start = start.AddMonths(r.Interval))
                    {
                        var candidate = r.MonthWeek is { } w && r.MonthWeekday is { } wd
                            ? NthWeekday(start.Year, start.Month, w, wd)
                            : MonthDate(start.Year, start.Month, r.MonthDay ?? r.AnchorDate.Day);
                        if (candidate > after) return candidate;
                    }
                    return start;
                }
        }
    }

    /// <summary>
    /// The next occurrence after <paramref name="after"/>, given that <paramref name="index"/> occurrences already exist (skipped ones are
    /// stepped over and count), or null when the series has ended.
    /// </summary>
    public static (DateOnly Date, int Index)? Next(TaskRecurrence r, DateOnly after, int index)
    {
        var skipped = Skipped(r);
        var d = after;
        for (var guard = 0; guard < 500; guard++)
        {
            d = Raw(r, d);
            index++;
            if (r.EndAfter is { } n && index > n) return null;
            if (r.EndBy is { } by && d > by) return null;
            if (!skipped.Contains(d)) return (d, index);
        }
        return null;
    }

    /// <summary>The next few dates, for the "Repeats" preview.</summary>
    public static IReadOnlyList<DateOnly> Preview(TaskRecurrence r, DateOnly after, int index, int count = 5)
    {
        var list = new List<DateOnly>();
        var at = after; var i = index;
        while (list.Count < count && Next(r, at, i) is { } next) { list.Add(next.Date); at = next.Date; i = next.Index; }
        return list;
    }

    /// <summary>"Every 2 weeks on Mon, Thu · 6 times", for the task sheet.</summary>
    public static string Describe(TaskRecurrence r)
    {
        var every = r.Interval > 1;
        var text = r.Frequency switch
        {
            "daily" => every ? $"Every {r.Interval} days" : "Every day",
            "weekdays" => "Every weekday",
            "weekly" => (every ? $"Every {r.Interval} weeks" : "Every week") + " on " + string.Join(", ", Days(r).Select(d => DayNames[d])),
            _ => (every ? $"Every {r.Interval} months" : "Every month") + (r.MonthWeek is { } w && r.MonthWeekday is { } wd
                ? $" on the {Ordinals[w]} {DayNames[wd]}" : $" on day {r.MonthDay}"),
        };
        if (r.EndAfter is { } n) text += $" · {n} time{(n == 1 ? "" : "s")}";
        else if (r.EndBy is { } by) text += $" · until {by.ToString("d MMM yyyy", CultureInfo.InvariantCulture)}";
        return text;
    }
}
