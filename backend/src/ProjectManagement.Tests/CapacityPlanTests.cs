using ProjectManagement.Application.Features.Projects;

namespace ProjectManagement.Tests;

/// <summary>How portfolio capacity places work on days: never a percentage of no time (the 999% a Saturday used to show).</summary>
public class CapacityPlanTests
{
    private static readonly DateOnly Saturday = new(2026, 10, 24), Monday = new(2026, 10, 26), WeekStart = new(2026, 10, 19), WindowEnd = new(2026, 11, 15);
    private static readonly HashSet<DateOnly> None = [];

    [Fact]
    public void On_a_Saturday_overdue_work_and_work_due_today_land_on_Monday_not_in_the_week_that_is_over()
    {
        Assert.Equal([Monday], CapacityPlan.Days(Saturday, WeekStart, WindowEnd, null, Saturday.AddDays(-3), None));   // overdue
        Assert.Equal([Monday], CapacityPlan.Days(Saturday, WeekStart, WindowEnd, null, Saturday, None));               // due today (a Saturday)
        // Due next Wednesday: spread over Monday to Wednesday.
        Assert.Equal([Monday, Monday.AddDays(1), Monday.AddDays(2)], CapacityPlan.Days(Saturday, WeekStart, WindowEnd, null, Monday.AddDays(2), None));
        // The week that is ending has no time left; it is shown as such, not as 999%.
        Assert.Null(CapacityPlan.Load(16 * 60, 0));
        Assert.Equal(200, CapacityPlan.Load(16 * 60, 8 * 60));
    }

    [Fact]
    public void Leave_moves_work_to_the_next_day_the_person_is_in()
    {
        var off = new HashSet<DateOnly> { Monday, Monday.AddDays(1) };
        Assert.Equal([Monday.AddDays(2)], CapacityPlan.Days(Saturday, WeekStart, WindowEnd, null, Monday, off));
        // On leave for the whole window: the work stays visible, on its last day, as work with no time.
        var allOff = Enumerable.Range(0, 30).Select(i => Saturday.AddDays(i)).ToHashSet();
        Assert.Equal([WindowEnd], CapacityPlan.Days(Saturday, WeekStart, WindowEnd, null, Monday, allOff));
    }

    [Fact]
    public void Work_that_starts_later_is_not_pulled_forward()
    {
        var start = Monday.AddDays(7);
        Assert.Equal([start, start.AddDays(1)], CapacityPlan.Days(Saturday, WeekStart, WindowEnd, start, start.AddDays(1), None));
    }
}
