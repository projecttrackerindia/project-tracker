namespace ProjectManagement.Application.Features.Load;

/// <summary>
/// The arithmetic of Load, kept apart from the database so it can be tested on its own: effort from a size, the personal calibration factor,
/// learned medians, how open work is spread over the days until it is due, and the four states.
/// </summary>
public static class LoadMath
{
    public const string Free = "free", Balanced = "balanced", Stretched = "stretched", Overloaded = "overloaded", Leave = "leave", Off = "off";
    public static readonly string[] Sizes = ["S", "M", "L", "XL"];
    public const double DefaultHours = 4;   // an unsized, unestimated item counts as M

    /// <summary>Hours for a rough size: S 1h, M 4h, L 8h, XL 24h (three days). Null for no size.</summary>
    public static double? SizeHours(string? size) => size?.Trim().ToUpperInvariant() switch
    {
        "S" => 1, "M" => 4, "L" => 8, "XL" => 24, _ => null,
    };

    /// <summary>A size normalised to S/M/L/XL, or null (empty clears it); anything else is refused by the caller.</summary>
    public static string? NormaliseSize(string? size, out bool valid)
    {
        var s = size?.Trim().ToUpperInvariant();
        valid = string.IsNullOrEmpty(s) || Sizes.Contains(s);
        return string.IsNullOrEmpty(s) || !valid ? null : s;
    }

    /// <summary>
    /// How a person's logged time compares with their estimates (actual / estimated over finished work), bounded to 0.7-1.6 so one odd task
    /// cannot swing the picture. Needs three finished estimated items; otherwise 1.
    /// </summary>
    public static double Calibration(IEnumerable<(double Estimated, double Actual)> finished)
    {
        var list = finished.Where(x => x.Estimated > 0 && x.Actual > 0).ToList();
        if (list.Count < 3) return 1;
        var ratio = list.Sum(x => x.Actual) / list.Sum(x => x.Estimated);
        return Math.Clamp(ratio, 0.7, 1.6);
    }

    /// <summary>The median of at least three values, else null.</summary>
    public static double? Median(IEnumerable<double> values)
    {
        var v = values.Where(x => x > 0).OrderBy(x => x).ToList();
        if (v.Count < 3) return null;
        return v.Count % 2 == 1 ? v[v.Count / 2] : (v[v.Count / 2 - 1] + v[v.Count / 2]) / 2;
    }

    /// <summary>
    /// The working days an item's remaining effort is spread over: from today (or its start, if later) to its due date, skipping days the
    /// person does not work. Overdue work (and work due on a day already gone) lands on today, or the next working day. Work with no due date
    /// is spread over the next ten working days. Never empty: when no working day is found in reach, the first day is used.
    /// </summary>
    public static List<DateOnly> SpreadDays(DateOnly today, DateOnly? start, DateOnly? due, Func<DateOnly, bool> works)
    {
        var first = start is { } s && s > today ? s : today;
        var days = new List<DateOnly>();
        if (due is null)
        {
            for (var d = first; days.Count < 10 && d <= first.AddDays(60); d = d.AddDays(1)) if (works(d)) days.Add(d);
        }
        else if (due.Value < first)
        {
            for (var d = today; d <= today.AddDays(30); d = d.AddDays(1)) if (works(d)) { days.Add(d); break; }
        }
        else
        {
            for (var d = first; d <= due.Value; d = d.AddDays(1)) if (works(d)) days.Add(d);
            if (days.Count == 0) for (var d = due.Value.AddDays(1); d <= due.Value.AddDays(30); d = d.AddDays(1)) if (works(d)) { days.Add(d); break; }
        }
        if (days.Count == 0) days.Add(first);
        return days;
    }

    /// <summary>Committed as a share of capacity, in percent; null when there is no capacity and nothing committed.</summary>
    public static int? Percent(double committed, double capacity) =>
        capacity > 0 ? (int)Math.Round(committed / capacity * 100) : committed > 0 ? 999 : null;

    /// <summary>Free under 50%, Balanced 50-85, Stretched 85-110, Overloaded over 110.</summary>
    public static string State(int? percent) => percent switch
    {
        null => Free,
        < 50 => Free,
        <= 85 => Balanced,
        <= 110 => Stretched,
        _ => Overloaded,
    };

    /// <summary>"Mon", "Tue"... for a reason line.</summary>
    public static string Dow(DateOnly d) => d.DayOfWeek.ToString()[..3];

    /// <summary>A run of days as "Wed" or "Wed–Thu" (first and last).</summary>
    public static string Range(IReadOnlyList<DateOnly> days) =>
        days.Count == 0 ? "" : days.Count == 1 || days[0] == days[^1] ? Dow(days[0]) : $"{Dow(days[0])}–{Dow(days[^1])}";
}
