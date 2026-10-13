using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Tests;

public class StageSchedulerTests
{
    private static readonly DateOnly Start = new(2030, 1, 1);
    private static StageScheduleInput Stage(string name, int? days, int start, int end, bool done = false) =>
        new(Guid.NewGuid(), name, days, Start.AddDays(start), Start.AddDays(end), done);

    [Fact]
    public void Durations_are_preserved_and_zero_duration_milestones_share_a_boundary()
    {
        var result = StageScheduler.Calculate(1, StageScheduleMode.FixedDeadline, Start, Start.AddDays(20),
            [Stage("Created", 0, 0, 0, true), Stage("Design", 4, 0, 9), Stage("Build", 8, 9, 17), Stage("Launch", 0, 17, 17)]);
        Assert.Equal(Start.AddDays(4), result.Stages[1].End); Assert.Equal(Start.AddDays(4), result.Stages[2].Start);
        Assert.Equal(Start.AddDays(12), result.FinishDate); Assert.Equal(8, result.BufferDays);
        Assert.Equal(Start.AddDays(12), result.Stages[3].Start); Assert.Equal(result.Stages[3].Start, result.Stages[3].End);
    }

    [Theory]
    [InlineData(2)] [InlineData(0)]
    public void Moving_a_stage_in_both_directions_shifts_only_its_successors(int anchor)
    {
        var stages = new[] { Stage("Created", 0, 0, 0, true), Stage("Design", 3, 2, 5), Stage("Build", 5, 5, 10) };
        var result = StageScheduler.Calculate(1, StageScheduleMode.FixedDeadline, Start, Start.AddDays(20), stages, 1, Start.AddDays(anchor));
        Assert.Equal(Start.AddDays(anchor + 3), result.Stages[2].Start); Assert.Equal(Start.AddDays(anchor + 8), result.FinishDate);
        Assert.Equal(stages[0].Start, result.Stages[0].Start);
    }

    [Theory]
    [InlineData(-1)] [InlineData(1)]
    public void Project_start_moves_reanchor_creation_milestones_and_preserve_durations(int shift)
    {
        var stages = new[] { Stage("Created", 0, 0, 0, true), Stage("Build", 4, 0, 4) };
        var result = StageScheduler.Calculate(1, StageScheduleMode.FixedDeadline, Start.AddDays(shift), Start.AddDays(10), stages, originStart: Start);
        Assert.Equal(Start.AddDays(shift), result.Stages[0].Start); Assert.Equal(Start.AddDays(shift), result.Stages[1].Start);
        Assert.Equal(Start.AddDays(shift + 4), result.FinishDate);
    }

    [Fact]
    public void Overflow_has_actionable_validation_and_cannot_compress_allocated_durations()
    {
        var error = Assert.Throws<ValidationException>(() => StageScheduler.Calculate(1, StageScheduleMode.FixedDeadline, Start, Start.AddDays(5), [Stage("Build", 8, 0, 8)]));
        Assert.Contains("3 day(s)", error.Message); Assert.Contains("Nothing was saved", error.Message);
    }

    [Fact]
    public void Manual_start_cannot_overlap_the_previous_stage()
    {
        var error = Assert.Throws<ValidationException>(() => StageScheduler.Calculate(1, StageScheduleMode.FixedDeadline, Start, Start.AddDays(20),
            [Stage("Design", 5, 0, 5), Stage("Build", 5, 5, 10)], 1, Start.AddDays(3)));
        Assert.Contains("predecessor", error.Message);
    }

    [Fact]
    public void Completed_work_plans_remain_protected_and_invalid_boundaries_are_rejected()
    {
        var history = Stage("Signed off", 4, 0, 4, true);
        var result = StageScheduler.Calculate(1, StageScheduleMode.FixedDeadline, Start, Start.AddDays(20), [history, Stage("Build", 5, 4, 9)]);
        Assert.Equal(history.Start, result.Stages[0].Start); Assert.Equal(history.End, result.Stages[0].End);
        Assert.Throws<ValidationException>(() => StageScheduler.Calculate(1, StageScheduleMode.FixedDeadline, Start.AddDays(1), Start.AddDays(20), [history]));
    }

    [Fact]
    public void Follow_schedule_aligns_the_project_end_and_can_anchor_a_deadline_from_the_back()
    {
        var stages = new[] { Stage("Design", 4, 0, 4), Stage("Build", 6, 4, 10) };
        var forward = StageScheduler.Calculate(1, StageScheduleMode.FollowSchedule, Start, Start.AddDays(20), stages);
        Assert.Equal(Start.AddDays(10), forward.DueDate);
        var backward = StageScheduler.Calculate(1, StageScheduleMode.FollowSchedule, Start, Start.AddDays(20), stages, alignFinish: true);
        Assert.Equal(Start.AddDays(10), backward.Stages[0].Start); Assert.Equal(Start.AddDays(20), backward.DueDate);
        Assert.Throws<ValidationException>(() => StageScheduler.Calculate(1, StageScheduleMode.FollowSchedule, Start, Start.AddDays(9), stages, alignFinish: true));
    }

    [Fact]
    public void Leap_days_and_calendar_limits_are_handled_without_timezone_arithmetic()
    {
        var start = new DateOnly(2028, 2, 28);
        var result = StageScheduler.Calculate(1, StageScheduleMode.FixedDeadline, start, start.AddDays(4), [new(Guid.NewGuid(), "Test", 2, null, null, false)]);
        Assert.Equal(new DateOnly(2028, 3, 1), result.FinishDate);
        Assert.Throws<ValidationException>(() => StageScheduler.Calculate(1, StageScheduleMode.FollowSchedule, DateOnly.MaxValue, DateOnly.MaxValue, [new(Guid.NewGuid(), "Overflow", 1, null, null, false)]));
    }

    [Fact]
    public void Backward_scheduling_cannot_hide_an_overlap_with_completed_work()
    {
        var error = Assert.Throws<ValidationException>(() => StageScheduler.Calculate(1, StageScheduleMode.FollowSchedule, Start, Start.AddDays(8),
            [Stage("Completed design", 5, 0, 5, true), Stage("Build", 4, 5, 9)], alignFinish: true));
        Assert.Contains("completed work", error.Message);
    }

    [Fact]
    public void Missing_completed_stage_plans_require_review_before_automatic_scheduling()
    {
        Assert.Throws<ValidationException>(() => StageScheduler.Calculate(1, StageScheduleMode.FollowSchedule, Start, Start.AddDays(10),
            [Stage("Design", 2, 0, 2), new(Guid.NewGuid(), "Missing history", 2, null, null, true)]));
    }
}
