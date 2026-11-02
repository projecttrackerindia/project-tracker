using System.Globalization;
using ProjectManagement.Application.Exceptions;

namespace ProjectManagement.Application.Features.Ai;

public static class AiWorkedInterval
{
    public sealed record Interval(DateTime Start, DateTime End);
    public static Interval? Resolve(DateOnly day, string? start, string? end, int minutes, TimeZoneInfo zone)
    {
        if (start is null && end is null) return null;
        if (!TimeOnly.TryParseExact(start, "HH:mm", CultureInfo.InvariantCulture, DateTimeStyles.None, out var from)
            || !TimeOnly.TryParseExact(end, "HH:mm", CultureInfo.InvariantCulture, DateTimeStyles.None, out var to) || to <= from)
            throw new AiToolException("Supply both start_time and end_time as HH:mm on the same day, with end after start.");
        var localStart = day.ToDateTime(from); var localEnd = day.ToDateTime(to);
        if (zone.IsInvalidTime(localStart) || zone.IsInvalidTime(localEnd) || zone.IsAmbiguousTime(localStart) || zone.IsAmbiguousTime(localEnd))
            throw new AiToolException("That clock interval is ambiguous or invalid in this time zone; clarify the exact offset first.");
        var first = TimeZoneInfo.ConvertTimeToUtc(localStart, zone); var last = TimeZoneInfo.ConvertTimeToUtc(localEnd, zone);
        if ((last - first).TotalMinutes != minutes) throw new AiToolException("The supplied minutes do not match the start and end times. Clarify breaks or correct the interval.");
        return new(first, last);
    }
}
