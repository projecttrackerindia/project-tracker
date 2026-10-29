using ProjectManagement.Application.Exceptions;

namespace ProjectManagement.Application.Features.ProjectMeetings;

/// <summary>
/// How a meeting repeats, as the schedule form sends it. <paramref name="Frequency"/>: Daily, Weekdays, Weekly, Monthly or Custom (every
/// <paramref name="Interval"/> weeks on <paramref name="Days"/>). It ends after <paramref name="Occurrences"/> sessions (2 to 120, including the
/// first) and/or on <paramref name="Until"/> (the last day a session may fall on, in the meeting's zone; the form defaults it to the project's due date).
/// </summary>
public record MeetingRepeat(string Frequency, int Occurrences = 0, DateOnly? Until = null, int Interval = 1, IReadOnlyList<string>? Days = null);

/// <summary>
/// The repeat rule a meeting stores (a small subset of RFC 5545 RRULE, which Google and Outlook read too) and its expansion into sessions.
/// Expansion always happens on the server, in the meeting's own zone, so a series keeps its wall-clock time across a daylight-saving change.
/// </summary>
public static class MeetingRecurrence
{
    /// <summary>The most sessions a series can have, including the first.</summary>
    public const int MaxOccurrences = 120;
    /// <summary>The longest gap a custom series may have between its weeks.</summary>
    public const int MaxInterval = 4;
    /// <summary>How far back a series that still has sessions can have started: 120 monthly sessions (the longest a rule here can run).</summary>
    public static readonly TimeSpan LongestSeries = TimeSpan.FromDays(MaxOccurrences * 31 + 1);

    private static readonly string[] DayCodes = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
    private static readonly string[] DayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

    public static string? Rule(MeetingRepeat? repeat, DateTimeOffset start, string timeZone)
    {
        if (repeat is null || string.Equals(repeat.Frequency, "Once", StringComparison.OrdinalIgnoreCase) || string.Equals(repeat.Frequency, "None", StringComparison.OrdinalIgnoreCase)) return null;
        if (!ProjectManagement.Application.Features.Reminders.ZoneTime.IsKnown(timeZone))
            throw new ValidationException("timeZone", "Choose a valid time zone for the recurring meeting.");
        var tz = ProjectManagement.Application.Features.Reminders.ZoneTime.Find(timeZone);
        var local = ProjectManagement.Application.Features.Reminders.ZoneTime.ToLocal(start.UtcDateTime, tz);
        var day = local.DayOfWeek;
        if (repeat.Until is null && (repeat.Occurrences < 2 || repeat.Occurrences > MaxOccurrences))
            throw new ValidationException("repeat.occurrences", "Choose between 2 and 120 sessions, including the first.");
        if (repeat.Until is not null && repeat.Occurrences != 0 && (repeat.Occurrences < 2 || repeat.Occurrences > MaxOccurrences))
            throw new ValidationException("repeat.occurrences", "Choose between 2 and 120 sessions, including the first.");
        if (repeat.Until is { } until)
        {
            var first = DateOnly.FromDateTime(local);
            if (until <= first) throw new ValidationException("repeat.until", "The series must end after its first session.");
            if (until.DayNumber - first.DayNumber > LongestSeries.TotalDays) throw new ValidationException("repeat.until", "A series can run for at most ten years.");
        }
        string body;
        switch (repeat.Frequency)
        {
            case "Daily": body = "FREQ=DAILY"; break;
            case "Weekdays":
                if (day is DayOfWeek.Saturday or DayOfWeek.Sunday) throw new ValidationException("startTime", "A weekday series must start Monday through Friday.");
                body = "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"; break;
            case "Weekly": body = "FREQ=WEEKLY"; break;
            case "Monthly":
                if (local.Day > 28) throw new ValidationException("startTime", "A monthly series must start on day 1 to 28, so every month has its session.");
                body = "FREQ=MONTHLY"; break;
            case "Custom":
            {
                if (repeat.Interval < 1 || repeat.Interval > MaxInterval) throw new ValidationException("repeat.interval", "Repeat every 1 to 4 weeks.");
                var days = (repeat.Days ?? []).Select(d => d.Trim().ToUpperInvariant()).Select(d => d.Length >= 2 ? d[..2] : d).Distinct().ToList();
                if (days.Count == 0 || days.Any(d => !DayCodes.Contains(d))) throw new ValidationException("repeat.days", "Choose the days of the week it repeats on.");
                if (!days.Contains(DayCodes[(int)day])) throw new ValidationException("startTime", "The first session must fall on one of the days chosen.");
                var ordered = DayCodes.Skip(1).Append("SU").Where(days.Contains);
                body = $"FREQ=WEEKLY{(repeat.Interval > 1 ? $";INTERVAL={repeat.Interval}" : "")};BYDAY={string.Join(",", ordered)}";
                break;
            }
            default: throw new ValidationException("repeat.frequency", "Choose Once, Daily, Weekdays, Weekly, Monthly or Custom.");
        }
        if (repeat.Occurrences > 0) body += $";COUNT={repeat.Occurrences}";
        if (repeat.Until is { } u)
        {
            // The end of that day in the meeting's zone, as a UTC instant (the form RFC 5545 asks for with a timed first session).
            var lastUtc = ProjectManagement.Application.Features.Reminders.ZoneTime.ToUtc(ProjectManagement.Application.Features.Reminders.ZoneTime.At(u, new TimeOnly(23, 59, 59)), tz);
            body += $";UNTIL={lastUtc:yyyyMMdd'T'HHmmss'Z'}";
        }
        return $"RRULE:{body}";
    }

    private enum Pattern { Once, Daily, Weekly, Monthly }
    private sealed record Parsed(Pattern Pattern, int Count, DateTime? Until, int Interval, HashSet<DayOfWeek>? Days);

    /// <summary>Reads back a rule this class wrote (anything else is treated as a single meeting).</summary>
    private static Parsed Parse(string? rule)
    {
        if (string.IsNullOrWhiteSpace(rule)) return new(Pattern.Once, 1, null, 1, null);
        var parts = rule.Replace("RRULE:", "", StringComparison.OrdinalIgnoreCase).Split(';', StringSplitOptions.RemoveEmptyEntries)
            .Select(p => p.Split('=', 2)).Where(p => p.Length == 2).GroupBy(p => p[0].Trim().ToUpperInvariant()).ToDictionary(g => g.Key, g => g.First()[1].Trim().ToUpperInvariant());
        var until = parts.TryGetValue("UNTIL", out var un) ? ParseUntil(un) : null;
        var count = parts.TryGetValue("COUNT", out var c) && int.TryParse(c, out var n) ? Math.Clamp(n, 1, 366) : until is null ? 1 : 366 * 10;
        var interval = parts.TryGetValue("INTERVAL", out var iv) && int.TryParse(iv, out var i) ? Math.Clamp(i, 1, 52) : 1;
        HashSet<DayOfWeek>? days = null;
        if (parts.TryGetValue("BYDAY", out var bd))
        {
            days = bd.Split(',', StringSplitOptions.RemoveEmptyEntries).Select(d => Array.IndexOf(DayCodes, d.Trim().Length >= 2 ? d.Trim()[^2..] : d.Trim()))
                .Where(x => x >= 0).Select(x => (DayOfWeek)x).ToHashSet();
            if (days.Count == 0) days = null;
        }
        return parts.GetValueOrDefault("FREQ") switch
        {
            "DAILY" => new(Pattern.Daily, count, until, interval, null),
            "WEEKLY" => new(Pattern.Weekly, count, until, interval, days),
            "MONTHLY" => new(Pattern.Monthly, count, until, interval, null),
            _ => new(Pattern.Once, 1, null, 1, null),
        };
    }

    private static DateTime? ParseUntil(string s)
    {
        var fmt = s.Length >= 15 ? (s.EndsWith('Z') ? "yyyyMMdd'T'HHmmss'Z'" : "yyyyMMdd'T'HHmmss") : "yyyyMMdd";
        if (!DateTime.TryParseExact(s, fmt, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.AdjustToUniversal | System.Globalization.DateTimeStyles.AssumeUniversal, out var d)) return null;
        // A bare date means the whole of that day.
        return DateTime.SpecifyKind(s.Length < 15 ? d.Date.AddDays(1).AddTicks(-1) : d, DateTimeKind.Utc);
    }

    /// <summary>Whether the rule repeats at all.</summary>
    public static bool Repeats(string? rule) => Parse(rule).Pattern != Pattern.Once;

    /// <summary>
    /// The start (UTC) of every session of a meeting that falls in [fromUtc, toUtcExclusive): the first start for a one-off meeting, each
    /// day / weekday / week / chosen weekday / month of a series, at the same wall-clock time in the meeting's own zone (so a series keeps
    /// its local time across a daylight-saving change, as Google Calendar does).
    /// </summary>
    public static IEnumerable<DateTime> Occurrences(string? rule, DateTime firstStartUtc, string timeZone, DateTime fromUtc, DateTime toUtcExclusive)
    {
        var r = Parse(rule);
        if (r.Pattern == Pattern.Once)
        {
            if (firstStartUtc >= fromUtc && firstStartUtc < toUtcExclusive) yield return firstStartUtc;
            yield break;
        }
        var tz = ProjectManagement.Application.Features.Reminders.ZoneTime.Find(timeZone);
        var local = ProjectManagement.Application.Features.Reminders.ZoneTime.ToLocal(firstStartUtc, tz);
        var first = DateOnly.FromDateTime(local);
        var time = TimeOnly.FromDateTime(local);
        // Weeks counted from the Monday of the first session's week, so "every 2 weeks on Mon and Wed" keeps its pairs together.
        var firstMonday = first.AddDays(-(((int)first.DayOfWeek + 6) % 7));
        var taken = 0;
        var horizon = (int)LongestSeries.TotalDays;
        for (var day = first; taken < r.Count && day.DayNumber - first.DayNumber <= horizon; day = day.AddDays(1))
        {
            var offset = day.DayNumber - first.DayNumber;
            switch (r.Pattern)
            {
                case Pattern.Daily when offset % r.Interval != 0: continue;
                case Pattern.Weekly when r.Days is null && offset % (7 * r.Interval) != 0: continue;
                case Pattern.Weekly when r.Days is not null && (!r.Days.Contains(day.DayOfWeek) || (day.DayNumber - firstMonday.DayNumber) / 7 % r.Interval != 0): continue;
                case Pattern.Monthly when day.Day != first.Day || ((day.Year - first.Year) * 12 + day.Month - first.Month) % r.Interval != 0: continue;
            }
            var at = ProjectManagement.Application.Features.Reminders.ZoneTime.ToUtc(ProjectManagement.Application.Features.Reminders.ZoneTime.At(day, time), tz);
            if (r.Until is { } u && at > u) yield break;
            taken++;
            if (at >= toUtcExclusive) yield break;
            if (at >= fromUtc) yield return at;
        }
    }

    /// <summary>How many sessions of the rule start before <paramref name="beforeUtc"/> (for splitting a series with "this and following").</summary>
    public static int CountBefore(string? rule, DateTime firstStartUtc, string timeZone, DateTime beforeUtc) =>
        Occurrences(rule, firstStartUtc, timeZone, DateTime.SpecifyKind(DateTime.MinValue, DateTimeKind.Utc), beforeUtc).Count();

    /// <summary>The sessions a rule still allows after <paramref name="taken"/> have happened (null = no count, it ends by date).</summary>
    public static int? CountLeft(string? rule, int taken)
    {
        var r = Parse(rule);
        if (r.Pattern == Pattern.Once) return 0;
        var hasCount = rule!.Contains("COUNT=", StringComparison.OrdinalIgnoreCase);
        return hasCount ? Math.Max(0, r.Count - taken) : null;
    }

    /// <summary>The same rule ending just before <paramref name="beforeUtc"/>: the first part of a series split with "this and following".</summary>
    public static string EndBefore(string rule, DateTime beforeUtc)
    {
        var parts = rule.Replace("RRULE:", "", StringComparison.OrdinalIgnoreCase).Split(';', StringSplitOptions.RemoveEmptyEntries)
            .Where(p => !p.StartsWith("UNTIL=", StringComparison.OrdinalIgnoreCase) && !p.StartsWith("COUNT=", StringComparison.OrdinalIgnoreCase)).ToList();
        parts.Add($"UNTIL={beforeUtc.AddSeconds(-1):yyyyMMdd'T'HHmmss'Z'}");
        return "RRULE:" + string.Join(";", parts);
    }

    /// <summary>The same pattern from a new first session: the second part of a split series (its count is what was left, or its end date).</summary>
    public static string Continue(string rule, int? countLeft)
    {
        var parts = rule.Replace("RRULE:", "", StringComparison.OrdinalIgnoreCase).Split(';', StringSplitOptions.RemoveEmptyEntries)
            .Where(p => !p.StartsWith("COUNT=", StringComparison.OrdinalIgnoreCase)).ToList();
        if (countLeft is { } n) parts.Add($"COUNT={Math.Max(1, n)}");
        return "RRULE:" + string.Join(";", parts);
    }

    /// <summary>Daily, Weekly, Monthly, Custom or Ad hoc: the cadence chip on Plan sheet rows, review headers and My Work tags.</summary>
    public static string Cadence(string? rule)
    {
        var r = Parse(rule);
        return r.Pattern switch
        {
            Pattern.Once => "Ad hoc",
            Pattern.Daily => r.Interval == 1 ? "Daily" : "Custom",
            Pattern.Monthly => r.Interval == 1 ? "Monthly" : "Custom",
            // A weekday stand-up is a daily meeting to the people in it.
            _ when r.Interval == 1 && r.Days is not null && r.Days.SetEquals(Weekdays) => "Daily",
            _ when r.Interval == 1 && (r.Days is null || r.Days.Count == 1) => "Weekly",
            _ => "Custom",
        };
    }

    private static readonly HashSet<DayOfWeek> Weekdays = [DayOfWeek.Monday, DayOfWeek.Tuesday, DayOfWeek.Wednesday, DayOfWeek.Thursday, DayOfWeek.Friday];

    /// <summary>"Every Mon · until 21 Nov", "Every weekday · 10 sessions", "Every 2 weeks on Mon, Wed": the line under Repeats.</summary>
    public static string Describe(string? rule, DateTime firstStartUtc, string timeZone)
    {
        var r = Parse(rule);
        if (r.Pattern == Pattern.Once) return "Once";
        var tz = ProjectManagement.Application.Features.Reminders.ZoneTime.Find(timeZone);
        var local = ProjectManagement.Application.Features.Reminders.ZoneTime.ToLocal(firstStartUtc, tz);
        var weekdays = r.Days is not null && r.Days.SetEquals(Weekdays);
        var what = r.Pattern switch
        {
            Pattern.Daily => r.Interval == 1 ? "Every day" : $"Every {r.Interval} days",
            Pattern.Monthly => $"Every month on the {Ordinal(local.Day)}",
            _ when weekdays && r.Interval == 1 => "Every weekday",
            _ => $"Every {(r.Interval > 1 ? $"{r.Interval} weeks on " : "")}{string.Join(", ", (r.Days ?? [local.DayOfWeek]).OrderBy(d => ((int)d + 6) % 7).Select(d => DayNames[(int)d]))}",
        };
        var hasCount = rule!.Contains("COUNT=", StringComparison.OrdinalIgnoreCase);
        var end = r.Until is { } u ? $"until {ProjectManagement.Application.Features.Reminders.ZoneTime.ToLocal(u, tz):d MMM}" : hasCount ? $"{r.Count} sessions" : null;
        return end is null ? what : $"{what} · {end}";
    }

    private static string Ordinal(int n) => n + (n % 100 is 11 or 12 or 13 ? "th" : (n % 10) switch { 1 => "st", 2 => "nd", 3 => "rd", _ => "th" });
}
