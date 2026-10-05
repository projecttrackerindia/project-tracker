namespace ProjectManagement.Tests;

/// <summary>
/// "Today" the way the application counts it (UTC plus the configured offset, India by default), so a test that sets a due date
/// "14 days from today" agrees with the forecast at every hour of the day, not only when the UTC and the local date happen to match.
/// </summary>
public static class AppDay
{
    public const int OffsetMinutes = 330;   // Application:TimeZoneOffsetMinutes in appsettings.json
    public static DateOnly Today => DateOnly.FromDateTime(DateTime.UtcNow.AddMinutes(OffsetMinutes));
}
