using ProjectManagement.Application.Features.Ai;
namespace ProjectManagement.Tests;
public class AiWorkedIntervalTests
{
    [Fact]
    public void Deployment_interval_preserves_seven_hours_and_the_india_offset()
    {
        var result = AiWorkedInterval.Resolve(new DateOnly(2026, 11, 2), "09:30", "16:30", 420, TimeZoneInfo.FindSystemTimeZoneById("Asia/Kolkata"))!;
        Assert.Equal(new DateTime(2026, 11, 2, 4, 0, 0, DateTimeKind.Utc), result.Start);
        Assert.Equal(new DateTime(2026, 11, 2, 11, 0, 0, DateTimeKind.Utc), result.End);
    }
    [Theory]
    [InlineData("09:30", null, 420)]
    [InlineData("16:30", "09:30", 420)]
    [InlineData("09:30", "16:30", 60)]
    public void Incomplete_or_contradictory_intervals_are_refused(string start, string? end, int minutes) =>
        Assert.Throws<AiToolException>(() => AiWorkedInterval.Resolve(new DateOnly(2026, 11, 2), start, end, minutes, TimeZoneInfo.Utc));
    [Fact]
    public void Duration_only_requests_remain_supported() => Assert.Null(AiWorkedInterval.Resolve(new DateOnly(2026, 11, 2), null, null, 60, TimeZoneInfo.Utc));
}
