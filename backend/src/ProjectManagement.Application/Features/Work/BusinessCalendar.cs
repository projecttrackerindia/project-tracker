using NodaTime;
using ProjectManagement.Application.Features.Reminders;

namespace ProjectManagement.Application.Features.Work;

/// <summary>
/// Working hours for service-level clocks: which days (bits, Monday = 1 ... Sunday = 64), from when to when (minutes after midnight), in
/// which zone. <see cref="Add"/> moves an instant forward by a number of working minutes; <see cref="Between"/> counts the working minutes
/// between two instants. Days are walked in the zone's own wall clock, so daylight saving and holidays-free weeks behave as people expect.
/// </summary>
public sealed record BusinessCalendar(int WorkDays, int DayStart, int DayEnd, DateTimeZone Zone)
{
    private const int MaxDays = 3 * 366;

    public static int Bit(DayOfWeek d) => 1 << (((int)d + 6) % 7);
    public bool IsWorkDay(DateOnly d) => (WorkDays & Bit(d.DayOfWeek)) != 0;
    private int Length => Math.Max(0, DayEnd - DayStart);
    public bool Valid => WorkDays is > 0 and < 128 && DayStart >= 0 && DayEnd <= 24 * 60 && Length >= 15;

    private DateTime Utc(DateOnly day, int minute) => ZoneTime.ToUtc(day.ToDateTime(TimeOnly.MinValue).AddMinutes(minute), Zone);

    /// <summary>The instant <paramref name="minutes"/> working minutes after <paramref name="fromUtc"/>.</summary>
    public DateTime Add(DateTime fromUtc, int minutes)
    {
        if (!Valid) return fromUtc.AddMinutes(minutes);
        var local = ZoneTime.ToLocal(fromUtc, Zone);
        var day = DateOnly.FromDateTime(local);
        var minute = (int)local.TimeOfDay.TotalMinutes;
        var left = Math.Max(0, minutes);
        for (var i = 0; i < MaxDays; i++, day = day.AddDays(1), minute = 0)
        {
            if (!IsWorkDay(day)) continue;
            var start = Math.Max(minute, DayStart);
            if (start >= DayEnd) continue;
            var room = DayEnd - start;
            if (left <= room) return Utc(day, start + left);
            left -= room;
        }
        return fromUtc.AddMinutes(minutes);   // nothing that far ahead: fall back to calendar time
    }

    /// <summary>Working minutes between two instants (0 when <paramref name="toUtc"/> is not later).</summary>
    public int Between(DateTime fromUtc, DateTime toUtc)
    {
        if (toUtc <= fromUtc) return 0;
        if (!Valid) return (int)Math.Ceiling((toUtc - fromUtc).TotalMinutes);
        var a = ZoneTime.ToLocal(fromUtc, Zone); var b = ZoneTime.ToLocal(toUtc, Zone);
        var total = 0;
        var day = DateOnly.FromDateTime(a);
        var last = DateOnly.FromDateTime(b);
        for (var i = 0; day <= last && i < MaxDays; i++, day = day.AddDays(1))
        {
            if (!IsWorkDay(day)) continue;
            var from = day == DateOnly.FromDateTime(a) ? Math.Max(DayStart, (int)a.TimeOfDay.TotalMinutes) : DayStart;
            var to = day == last ? Math.Min(DayEnd, (int)Math.Ceiling(b.TimeOfDay.TotalMinutes)) : DayEnd;
            if (to > from) total += to - from;
        }
        return total;
    }
}
