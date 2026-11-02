using ProjectManagement.Application.Features.Ai;
using NodaTime;
namespace ProjectManagement.Tests;
public class AiWorkedIntervalTests
{
    [Fact]
    public void Deployment_interval_preserves_seven_hours_and_the_india_offset()
    {
        var result = AiWorkedInterval.Resolve(new DateOnly(2026, 11, 2), "09:30", "16:30", 420, DateTimeZoneProviders.Tzdb["Asia/Kolkata"])!;
        Assert.Equal(new DateTime(2026, 11, 2, 4, 0, 0, DateTimeKind.Utc), result.Start);
        Assert.Equal(new DateTime(2026, 11, 2, 11, 0, 0, DateTimeKind.Utc), result.End);
    }
    [Theory]
    [InlineData("09:30", null, 420)]
    [InlineData("16:30", "09:30", 420)]
    [InlineData("09:30", "16:30", 60)]
    public void Incomplete_or_contradictory_intervals_are_refused(string start, string? end, int minutes) =>
        Assert.Throws<AiToolException>(() => AiWorkedInterval.Resolve(new DateOnly(2026, 11, 2), start, end, minutes, DateTimeZone.Utc));
    [Fact]
    public void Duration_only_requests_remain_supported() => Assert.Null(AiWorkedInterval.Resolve(new DateOnly(2026, 11, 2), null, null, 60, DateTimeZone.Utc));
    [Theory]
    [InlineData(2026, 3, 8, "02:15", "03:15")]
    [InlineData(2026, 11, 1, "01:15", "02:15")]
    public void Daylight_saving_gaps_and_ambiguous_times_require_clarification(int year, int month, int day, string from, string to) =>
        Assert.Throws<AiToolException>(() => AiWorkedInterval.Resolve(new DateOnly(year, month, day), from, to, 60, DateTimeZoneProviders.Tzdb["America/New_York"]));
}
