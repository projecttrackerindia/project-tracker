using ProjectManagement.Application.Exceptions;

namespace ProjectManagement.Application.Features.ProjectMeetings;

public record MeetingRepeat(string Frequency, int Occurrences);
public static class MeetingRecurrence
{
    /// <summary>The most sessions a series can have, including the first.</summary>
    public const int MaxOccurrences = 120;
    /// <summary>How far back a series that still has sessions can have started: 120 weekly sessions.</summary>
    public static readonly TimeSpan LongestSeries = TimeSpan.FromDays(MaxOccurrences * 7 + 1);

    public static string? Rule(MeetingRepeat? repeat, DateTimeOffset start, string timeZone)
    {
        if (repeat is null) return null;
        if (repeat.Occurrences < 2 || repeat.Occurrences > MaxOccurrences)
            throw new ValidationException("repeat.occurrences", "Choose between 2 and 120 sessions, including the first.");
        if (!ProjectManagement.Application.Features.Reminders.ZoneTime.IsKnown(timeZone))
            throw new ValidationException("timeZone", "Choose a valid time zone for the recurring meeting.");
        var day = ProjectManagement.Application.Features.Reminders.ZoneTime.ToLocal(start.UtcDateTime,
            ProjectManagement.Application.Features.Reminders.ZoneTime.Find(timeZone)).DayOfWeek;
        if (repeat.Frequency == "Weekdays" && day is DayOfWeek.Saturday or DayOfWeek.Sunday)
            throw new ValidationException("startTime", "A weekday series must start Monday through Friday.");
        var frequency = repeat.Frequency switch {
            "Daily" => "FREQ=DAILY", "Weekdays" => "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", "Weekly" => "FREQ=WEEKLY",
            _ => throw new ValidationException("repeat.frequency", "Choose Daily, Weekdays or Weekly.")
        };
        return $"RRULE:{frequency};COUNT={repeat.Occurrences}";
    }

    private enum Pattern { Once, Daily, Weekdays, Weekly }

    /// <summary>Reads back a rule this class wrote (anything else is treated as a single meeting).</summary>
    private static (Pattern Pattern, int Count) Parse(string? rule)
    {
        if (string.IsNullOrWhiteSpace(rule)) return (Pattern.Once, 1);
        var parts = rule.Replace("RRULE:", "", StringComparison.OrdinalIgnoreCase).Split(';', StringSplitOptions.RemoveEmptyEntries)
            .Select(p => p.Split('=', 2)).Where(p => p.Length == 2).ToDictionary(p => p[0].ToUpperInvariant(), p => p[1].ToUpperInvariant());
        var count = parts.TryGetValue("COUNT", out var c) && int.TryParse(c, out var n) ? Math.Clamp(n, 1, 366) : 1;
        return parts.GetValueOrDefault("FREQ") switch
        {
            "DAILY" => (Pattern.Daily, count),
            "WEEKLY" when parts.GetValueOrDefault("BYDAY") == "MO,TU,WE,TH,FR" => (Pattern.Weekdays, count),
            "WEEKLY" => (Pattern.Weekly, count),
            _ => (Pattern.Once, 1),
        };
    }

    /// <summary>
    /// The start (UTC) of every session of a meeting that falls in [fromUtc, toUtcExclusive): the first start for a one-off meeting, each
    /// day / weekday / week of a series, at the same wall-clock time in the meeting's own zone (so a series keeps its local time across a
    /// daylight-saving change, as Google Calendar does).
    /// </summary>
    public static IEnumerable<DateTime> Occurrences(string? rule, DateTime firstStartUtc, string timeZone, DateTime fromUtc, DateTime toUtcExclusive)
    {
        var (pattern, count) = Parse(rule);
        if (pattern == Pattern.Once)
        {
            if (firstStartUtc >= fromUtc && firstStartUtc < toUtcExclusive) yield return firstStartUtc;
            yield break;
        }
        var tz = ProjectManagement.Application.Features.Reminders.ZoneTime.Find(timeZone);
        var local = ProjectManagement.Application.Features.Reminders.ZoneTime.ToLocal(firstStartUtc, tz);
        var first = DateOnly.FromDateTime(local);
        var time = TimeOnly.FromDateTime(local);
        var taken = 0;
        for (var day = first; taken < count && day.DayNumber - first.DayNumber <= 7 * 366; day = day.AddDays(1))
        {
            if (pattern == Pattern.Weekly && (day.DayNumber - first.DayNumber) % 7 != 0) continue;
            if (pattern == Pattern.Weekdays && day.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday) continue;
            taken++;
            var at = ProjectManagement.Application.Features.Reminders.ZoneTime.ToUtc(ProjectManagement.Application.Features.Reminders.ZoneTime.At(day, time), tz);
            if (at >= toUtcExclusive) yield break;
            if (at >= fromUtc) yield return at;
        }
    }
}
