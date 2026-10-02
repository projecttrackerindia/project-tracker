using System.Globalization;
using NodaTime;
using NodaTime.TimeZones;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Reminders;

/// <summary>
/// Wall-clock times in a time zone, and the instants they mean. Zones come from the IANA time zone database bundled with NodaTime, so
/// they mean the same on every server whatever its operating system has installed ("Asia/Kolkata", "America/New_York", old names too).
/// </summary>
public static class ZoneTime
{
    public const string Format = "yyyy-MM-dd'T'HH:mm";
    private static readonly ZoneLocalMappingResolver EarlierOrAfterGap = Resolvers.CreateMappingResolver(Resolvers.ReturnEarlier, Resolvers.ReturnStartOfIntervalAfter);

    public static bool IsKnown(string? id) =>
        !string.IsNullOrWhiteSpace(id) && id.Length <= 64 && DateTimeZoneProviders.Tzdb.GetZoneOrNull(id.Trim()) is not null;

    /// <summary>The zone, or UTC when the name is unknown.</summary>
    public static DateTimeZone Find(string? id) =>
        (string.IsNullOrWhiteSpace(id) ? null : DateTimeZoneProviders.Tzdb.GetZoneOrNull(id.Trim())) ?? DateTimeZone.Utc;

    /// <summary>
    /// The instant a wall-clock time means. A time that does not exist (the hour skipped when clocks go forward) becomes the first moment
    /// after the gap; a time that happens twice (when clocks go back) is the first of the two.
    /// </summary>
    public static DateTime ToUtc(DateTime local, DateTimeZone tz) =>
        tz.ResolveLocal(LocalDateTime.FromDateTime(DateTime.SpecifyKind(local, DateTimeKind.Unspecified)), EarlierOrAfterGap).ToDateTimeUtc();

    public static DateTime ToLocal(DateTime utc, DateTimeZone tz) =>
        Instant.FromDateTimeUtc(DateTime.SpecifyKind(utc, DateTimeKind.Utc)).InZone(tz).LocalDateTime.ToDateTimeUnspecified();

    public static DateTime At(DateOnly day, TimeOnly time) => day.ToDateTime(time, DateTimeKind.Unspecified);

    public static bool TryParseLocal(string? text, out DateTime local) =>
        DateTime.TryParseExact(text?.Trim(), [Format, "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd HH:mm"], CultureInfo.InvariantCulture, DateTimeStyles.None, out local);

    public static string Write(DateTime local) => local.ToString(Format, CultureInfo.InvariantCulture);

    public static bool TryParseTime(string? text, out TimeOnly time) =>
        TimeOnly.TryParseExact(text?.Trim(), ["HH:mm", "H:mm", "HH:mm:ss"], CultureInfo.InvariantCulture, DateTimeStyles.None, out time);
}

/// <summary>
/// A repeating rule: the subset of RFC 5545 RRULE that people actually use for reminders - every N days; every N weeks on some weekdays;
/// every N months on a day of the month, on its last day, or on its last working day. Kept as standard RRULE text so calendars can read it.
/// </summary>
public sealed record RecurrenceRule(string Freq, int Interval, IReadOnlyList<DayOfWeek> ByDay, int? ByMonthDay, bool LastWorkingDay)
{
    private static readonly string[] Codes = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
    private static readonly DayOfWeek[] Weekdays = [DayOfWeek.Monday, DayOfWeek.Tuesday, DayOfWeek.Wednesday, DayOfWeek.Thursday, DayOfWeek.Friday];

    public static RecurrenceRule? Parse(string? text)
    {
        if (string.IsNullOrWhiteSpace(text) || text.Length > 120) return null;
        var parts = text.Trim().TrimStart().Replace("RRULE:", "", StringComparison.OrdinalIgnoreCase).Split(';', StringSplitOptions.RemoveEmptyEntries)
            .Select(p => p.Split('=', 2)).Where(p => p.Length == 2).ToDictionary(p => p[0].Trim().ToUpperInvariant(), p => p[1].Trim().ToUpperInvariant());
        if (!parts.TryGetValue("FREQ", out var freq) || freq is not ("DAILY" or "WEEKLY" or "MONTHLY")) return null;
        var interval = parts.TryGetValue("INTERVAL", out var iv) ? int.TryParse(iv, out var n) && n is >= 1 and <= 52 ? n : 0 : 1;
        if (interval == 0) return null;
        var days = new List<DayOfWeek>();
        if (parts.TryGetValue("BYDAY", out var bd))
            foreach (var d in bd.Split(',', StringSplitOptions.RemoveEmptyEntries))
            {
                var i = Array.IndexOf(Codes, d.Trim());
                if (i < 0) return null;
                if (!days.Contains((DayOfWeek)i)) days.Add((DayOfWeek)i);
            }
        int? monthDay = null;
        if (parts.TryGetValue("BYMONTHDAY", out var md))
        {
            if (!int.TryParse(md, out var m) || m is 0 or < -1 or > 31) return null;
            monthDay = m;
        }
        var lastWorking = freq == "MONTHLY" && parts.TryGetValue("BYSETPOS", out var pos) && pos == "-1" && Weekdays.All(days.Contains) && days.Count == 5;
        if (freq == "MONTHLY" && days.Count > 0 && !lastWorking) return null;   // "the first Monday" and such are not offered
        return new RecurrenceRule(freq, interval, lastWorking ? [] : days.OrderBy(d => ((int)d + 6) % 7).ToList(), monthDay, lastWorking);
    }

    public string ToRRule()
    {
        var s = $"FREQ={Freq}";
        if (Interval > 1) s += $";INTERVAL={Interval}";
        if (LastWorkingDay) return s + ";BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1";
        if (ByDay.Count > 0) s += ";BYDAY=" + string.Join(',', ByDay.Select(d => Codes[(int)d]));
        if (ByMonthDay is { } md) s += $";BYMONTHDAY={md}";
        return s;
    }

    /// <summary>In words: "every Friday", "every weekday", "every 2 weeks on Monday", "every month on the 15th".</summary>
    public string Describe(DateOnly start)
    {
        string Every(string unit) => Interval == 1 ? $"every {unit}" : $"every {Interval} {unit}s";
        static string Ord(int n) => n + (n % 100 is 11 or 12 or 13 ? "th" : (n % 10) switch { 1 => "st", 2 => "nd", 3 => "rd", _ => "th" });
        switch (Freq)
        {
            case "DAILY": return Interval == 1 ? "every day" : $"every {Interval} days";
            case "WEEKLY":
                var days = ByDay.Count > 0 ? ByDay : [start.DayOfWeek];
                if (Interval == 1 && days.Count == 5 && Weekdays.All(days.Contains)) return "every weekday";
                var names = string.Join(", ", days.Select(d => CultureInfo.InvariantCulture.DateTimeFormat.GetDayName(d)));
                return Interval == 1 ? $"every {names}" : $"{Every("week")} on {names}";
            default:
                var on = LastWorkingDay ? "the last working day" : ByMonthDay == -1 ? "the last day" : $"the {Ord(ByMonthDay ?? start.Day)}";
                return $"{Every("month")} on {on}";
        }
    }

    /// <summary>The first day the rule falls on, after <paramref name="after"/> (or on it, when <paramref name="inclusive"/>), counting from the series' start.</summary>
    public DateOnly? NextDate(DateOnly after, DateOnly start, bool inclusive)
    {
        var d = inclusive ? after : after.AddDays(1);
        if (d < start) d = start;
        for (var i = 0; i < 800; i++, d = d.AddDays(1))
            if (Matches(d, start)) return d;
        return null;
    }

    private bool Matches(DateOnly d, DateOnly start)
    {
        switch (Freq)
        {
            case "DAILY": return (d.DayNumber - start.DayNumber) % Interval == 0;
            case "WEEKLY":
                var days = ByDay.Count > 0 ? ByDay : [start.DayOfWeek];
                if (!days.Contains(d.DayOfWeek)) return false;
                var weeks = (Monday(d).DayNumber - Monday(start).DayNumber) / 7;
                return weeks % Interval == 0;
            default:
                var months = (d.Year * 12 + d.Month) - (start.Year * 12 + start.Month);
                if (months % Interval != 0) return false;
                var last = DateTime.DaysInMonth(d.Year, d.Month);
                if (LastWorkingDay)
                {
                    var lw = new DateOnly(d.Year, d.Month, last);
                    while (lw.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday) lw = lw.AddDays(-1);
                    return d == lw;
                }
                var want = ByMonthDay switch { -1 => last, { } n => Math.Min(n, last), _ => Math.Min(start.Day, last) };
                return d.Day == want;
        }
    }

    private static DateOnly Monday(DateOnly d) => d.AddDays(-(((int)d.DayOfWeek + 6) % 7));
}

/// <summary>A person's working week and quiet hours, from their reminder settings.</summary>
public sealed class WorkCalendar(ReminderSettings s)
{
    private readonly HashSet<DayOfWeek> _days = ParseDays(s.WorkDays);
    public ReminderSettings Settings => s;

    public static HashSet<DayOfWeek> ParseDays(string? text)
    {
        var set = new HashSet<DayOfWeek>();
        foreach (var p in (text ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries))
            if (int.TryParse(p, out var iso) && iso is >= 1 and <= 7) set.Add((DayOfWeek)(iso % 7));
        return set.Count == 0 ? [DayOfWeek.Monday, DayOfWeek.Tuesday, DayOfWeek.Wednesday, DayOfWeek.Thursday, DayOfWeek.Friday] : set;
    }

    public static IReadOnlyList<int> ParseNumbers(string? text, int min, int max) =>
        (text ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries).Select(p => int.TryParse(p, out var n) ? n : int.MinValue)
            .Where(n => n >= min && n <= max).Distinct().OrderBy(n => n).ToList();

    public bool IsWorkingDay(DateOnly d) => _days.Contains(d.DayOfWeek);

    /// <summary>The latest working day on or before <paramref name="d"/>.</summary>
    public DateOnly WorkingOnOrBefore(DateOnly d)
    {
        for (var i = 0; i < 14 && !IsWorkingDay(d); i++) d = d.AddDays(-1);
        return d;
    }

    public DateOnly WorkingOnOrAfter(DateOnly d)
    {
        for (var i = 0; i < 14 && !IsWorkingDay(d); i++) d = d.AddDays(1);
        return d;
    }

    /// <summary>"N working days before" a due date: 0 is the due date itself, or the working day before it when it falls on a day off.</summary>
    public DateOnly WorkingDaysBefore(DateOnly due, int n)
    {
        var d = WorkingOnOrBefore(due);
        for (var i = 0; i < n; i++) d = WorkingOnOrBefore(d.AddDays(-1));
        return d;
    }

    public bool InQuietHours(TimeOnly t)
    {
        if (s.QuietStart is not { } a || s.QuietEnd is not { } b || a == b) return false;
        return a < b ? t >= a && t < b : t >= a || t < b;   // may run past midnight
    }

    /// <summary>Whether something that is not urgent may arrive now: a working day, within working hours, outside quiet hours.</summary>
    public bool IsGoodTime(DateTime local)
    {
        var t = TimeOnly.FromDateTime(local);
        return IsWorkingDay(DateOnly.FromDateTime(local)) && t >= s.WorkStart && t < s.WorkEnd && !InQuietHours(t);
    }

    /// <summary>The next moment, from <paramref name="local"/>, at which <see cref="IsGoodTime"/> holds.</summary>
    public DateTime NextGoodTime(DateTime local)
    {
        if (IsGoodTime(local)) return local;
        var day = DateOnly.FromDateTime(local);
        for (var i = 0; i < 15; i++, day = day.AddDays(1))
        {
            if (!IsWorkingDay(day)) continue;
            // The first good quarter of an hour from the start of work (or from now, today), stepping past quiet hours.
            var from = ZoneTime.At(day, s.WorkStart);
            if (i == 0 && local > from) from = local;
            for (var t = from; t < ZoneTime.At(day, s.WorkEnd); t = t.AddMinutes(15))
                if (IsGoodTime(t)) return t;
        }
        return local.AddHours(1);
    }
}
