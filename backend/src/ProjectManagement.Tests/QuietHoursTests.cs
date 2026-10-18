using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Tests;

/// <summary>E-mail and push created during a person's quiet hours wait until those hours end, in that person's own time zone.</summary>
public class QuietHoursTests
{
    private static readonly NodaTime.DateTimeZone Kolkata = ZoneTime.Find("Asia/Kolkata");
    private static ReminderSettings Night() => new() { QuietStart = new TimeOnly(21, 0), QuietEnd = new TimeOnly(8, 0) };

    [Fact]
    public void Late_evening_waits_until_the_next_morning()
    {
        // 22:00 in Kolkata (16:30 UTC) -> 08:00 the next day in Kolkata (02:30 UTC).
        var until = QuietHours.Until(Night(), Kolkata, new DateTime(2026, 10, 18, 16, 30, 0, DateTimeKind.Utc));
        Assert.Equal(new DateTime(2026, 10, 19, 2, 30, 0, DateTimeKind.Utc), until);
    }

    [Fact]
    public void Early_morning_waits_until_the_same_morning()
    {
        // 06:00 in Kolkata (00:30 UTC) -> 08:00 the same day (02:30 UTC).
        var until = QuietHours.Until(Night(), Kolkata, new DateTime(2026, 10, 19, 0, 30, 0, DateTimeKind.Utc));
        Assert.Equal(new DateTime(2026, 10, 19, 2, 30, 0, DateTimeKind.Utc), until);
    }

    [Fact]
    public void Daytime_and_no_quiet_hours_deliver_now()
    {
        Assert.Null(QuietHours.Until(Night(), Kolkata, new DateTime(2026, 10, 19, 6, 30, 0, DateTimeKind.Utc)));   // 12:00 in Kolkata
        Assert.Null(QuietHours.Until(new ReminderSettings { QuietStart = null, QuietEnd = null }, Kolkata, new DateTime(2026, 10, 18, 16, 30, 0, DateTimeKind.Utc)));
    }

    [Fact]
    public void A_daytime_window_ends_the_same_day()
    {
        var focus = new ReminderSettings { QuietStart = new TimeOnly(13, 0), QuietEnd = new TimeOnly(15, 0) };
        // 14:00 in Kolkata (08:30 UTC) -> 15:00 (09:30 UTC).
        Assert.Equal(new DateTime(2026, 10, 19, 9, 30, 0, DateTimeKind.Utc), QuietHours.Until(focus, Kolkata, new DateTime(2026, 10, 19, 8, 30, 0, DateTimeKind.Utc)));
    }

    [Fact]
    public void Security_alerts_and_set_reminders_are_never_held()
    {
        Assert.True(QuietHours.NeverHeld(NotificationType.Security));
        Assert.True(QuietHours.NeverHeld(NotificationType.Reminder));
        Assert.False(QuietHours.NeverHeld(NotificationType.Mention));
        Assert.False(QuietHours.NeverHeld(NotificationType.Meeting));
    }
}
