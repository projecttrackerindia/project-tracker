using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.ProjectMeetings;
namespace ProjectManagement.Tests;
public class MeetingRecurrenceTests
{
    [Theory]
    [InlineData("Daily", "RRULE:FREQ=DAILY;COUNT=10")]
    [InlineData("Weekdays", "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;COUNT=10")]
    [InlineData("Weekly", "RRULE:FREQ=WEEKLY;COUNT=10")]
    public void Known_rhythms_produce_bounded_native_rules(string frequency,string expected) =>
        Assert.Equal(expected, MeetingRecurrence.Rule(new(frequency,10), DateTimeOffset.Parse("2030-01-07T09:00:00Z"), "UTC"));
    [Theory]
    [InlineData("Yearly",10,"UTC")]
    [InlineData("Daily",1,"UTC")]
    [InlineData("Daily",121,"UTC")]
    [InlineData("Daily",10,"Not/AZone")]
    public void Invalid_repeats_are_rejected(string frequency,int count,string zone) =>
        Assert.Throws<ValidationException>(() => MeetingRecurrence.Rule(new(frequency,count),DateTimeOffset.Parse("2030-01-07T09:00:00Z"),zone));
    [Fact]
    public void Weekdays_use_the_organizers_local_day_not_the_UTC_day()
    {
        var instant=DateTimeOffset.Parse("2030-01-06T23:00:00Z");
        Assert.NotNull(MeetingRecurrence.Rule(new("Weekdays",5),instant,"Asia/Kolkata"));
        Assert.Throws<ValidationException>(()=>MeetingRecurrence.Rule(new("Weekdays",5),instant,"America/New_York"));
    }
    [Fact]
    public void One_time_meetings_have_no_recurrence() => Assert.Null(MeetingRecurrence.Rule(null,DateTimeOffset.UtcNow,"UTC"));
}
