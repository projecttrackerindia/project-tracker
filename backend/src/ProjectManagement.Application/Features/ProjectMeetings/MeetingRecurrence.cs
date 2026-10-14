using ProjectManagement.Application.Exceptions;

namespace ProjectManagement.Application.Features.ProjectMeetings;

public record MeetingRepeat(string Frequency, int Occurrences);
public static class MeetingRecurrence
{
    public static string? Rule(MeetingRepeat? repeat, DateTimeOffset start, string timeZone)
    {
        if (repeat is null) return null;
        if (repeat.Occurrences is < 2 or > 120)
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
}
