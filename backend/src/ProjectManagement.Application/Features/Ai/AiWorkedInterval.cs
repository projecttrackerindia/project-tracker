using System.Globalization;
using NodaTime;
using ProjectManagement.Application.Exceptions;

namespace ProjectManagement.Application.Features.Ai;

public static class AiWorkedInterval
{
    public sealed record Interval(DateTime Start, DateTime End);
    public static Interval? Resolve(DateOnly day, string? start, string? end, int minutes, DateTimeZone zone)
    {
        if (start is null && end is null) return null;
        if (!TimeOnly.TryParseExact(start, "HH:mm", CultureInfo.InvariantCulture, DateTimeStyles.None, out var from)
            || !TimeOnly.TryParseExact(end, "HH:mm", CultureInfo.InvariantCulture, DateTimeStyles.None, out var to) || to <= from)
            throw new AiToolException("Supply both start_time and end_time as HH:mm on the same day, with end after start.");
        var localStart = day.ToDateTime(from); var localEnd = day.ToDateTime(to);
        var startMapping = zone.MapLocal(LocalDateTime.FromDateTime(localStart));
        var endMapping = zone.MapLocal(LocalDateTime.FromDateTime(localEnd));
        if (startMapping.Count != 1 || endMapping.Count != 1)
            throw new AiToolException("That clock interval is ambiguous or invalid in this time zone; clarify the exact offset first.");
        var first = startMapping.Single().ToDateTimeUtc(); var last = endMapping.Single().ToDateTimeUtc();
        if ((last - first).TotalMinutes != minutes) throw new AiToolException("The supplied minutes do not match the start and end times. Clarify breaks or correct the interval.");
        return new(first, last);
    }
}
