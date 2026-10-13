using ProjectManagement.Application.Exceptions;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Projects;

public record StageScheduleInput(Guid Id, string Name, int? DurationDays, DateOnly? Start, DateOnly? End, bool Completed);
public record StageScheduleRow(Guid Id, string Name, int DurationDays, DateOnly? Start, DateOnly? End, bool Completed, bool Changed);
public record StageSchedulePreview(int Version, StageScheduleMode Mode, DateOnly StartDate, DateOnly DueDate,
    DateOnly FinishDate, int BufferDays, IReadOnlyList<StageScheduleRow> Stages, string? Fingerprint = null);
public record StageDurationInput(Guid Id, int DurationDays);
public record ProjectScheduleRequest(int Version, StageScheduleMode Mode, DateOnly? StartDate, DateOnly? DueDate,
    IReadOnlyList<StageDurationInput>? Durations, string? Reason = null, string? ExpectedFingerprint = null);

/// <summary>One deterministic calendar-day engine for the editor, project dates and confirmed Agent actions.</summary>
public static class StageScheduler
{
    public static int? Duration(int? days, DateOnly? start, DateOnly? end) => days ??
        (start is { } s && end is { } e ? e.DayNumber - s.DayNumber : null);

    public static StageSchedulePreview Calculate(int version, StageScheduleMode mode, DateOnly? start, DateOnly? due,
        IReadOnlyList<StageScheduleInput> stages, int fromIndex = 0, DateOnly? anchorStart = null, bool alignFinish = false, DateOnly? originStart = null)
    {
        if (mode == StageScheduleMode.Manual || !Enum.IsDefined(mode)) throw new ValidationException("mode", "Choose automatic scheduling with a fixed deadline or a finish that follows the schedule.");
        if (start is null || due is null) throw new ValidationException("schedule", "Automatic scheduling needs both a project start date and an end date.");
        if (due < start && (mode == StageScheduleMode.FixedDeadline || alignFinish)) throw new ValidationException("dueDate", "Project end must not be before project start.");
        var durations = stages.Select(s => Duration(s.DurationDays, s.Start, s.End)).ToArray();
        for (var i = 0; i < stages.Count; i++)
            if (durations[i] is null || durations[i] is < 0 or > 36500)
                throw new ValidationException("schedule", $"Set an allocated duration between 0 and 36500 calendar days for stage '{stages[i].Name}'. Zero is a milestone.");
        var cursor = start.Value;
        if (alignFinish)
        {
            var needed = durations.Where((_, i) => !stages[i].Completed).Sum(d => (long)d!.Value);
            var first = due.Value.DayNumber - needed;
            if (first < start.Value.DayNumber) throw new ValidationException("schedule", $"The stages need {needed} calendar days but this project has {due.Value.DayNumber - start.Value.DayNumber}. Increase the end date or reduce allocated durations.");
            cursor = DateOnly.FromDayNumber((int)first);
        }
        var output = new List<StageScheduleRow>();
        var calculatedWork = false;
        for (var i = 0; i < stages.Count; i++)
        {
            var stage = stages[i]; var days = durations[i]!.Value;
            DateOnly? plannedStart; DateOnly? plannedEnd;
            if (stage.Completed && i == 0 && days == 0 && fromIndex == 0)
            {
                // A leading creation marker anchors the plan, not the actual completion history.
                plannedStart = start; plannedEnd = start;
            }
            else if (stage.Completed || i < fromIndex)
            {
                plannedStart = stage.Start; plannedEnd = stage.End;
                if (stage.Completed && (plannedStart is null || plannedEnd is null))
                    throw new ValidationException("schedule", $"Completed stage '{stage.Name}' needs recorded planned dates before automatic scheduling can be enabled. Review its plan in manual mode first.");
                if (plannedStart is { } ps && (ps < start || plannedEnd < ps)) throw new ValidationException("schedule", $"The project start conflicts with the protected plan for stage '{stage.Name}'. Review its history before changing the project boundary.");
                if (plannedEnd is { } pe)
                {
                    if (stage.Completed && calculatedWork && stage.Start < cursor)
                        throw new ValidationException("schedule", $"The recalculated stages overlap completed stage '{stage.Name}'. Completed history cannot be moved automatically.");
                    if (pe > cursor) cursor = pe;
                }
            }
            else
            {
                if (originStart is not null && !alignFinish && stage.Start is { } original)
                {
                    var preceding = i == 0 ? originStart : stages[i - 1].End;
                    if (preceding is { } previous && original > previous)
                    {
                        var shifted = (long)cursor.DayNumber + original.DayNumber - previous.DayNumber;
                        if (shifted > DateOnly.MaxValue.DayNumber) throw new ValidationException("schedule", $"The gap before stage '{stage.Name}' exceeds the supported calendar.");
                        cursor = DateOnly.FromDayNumber((int)shifted);
                    }
                }
                if (i == fromIndex && anchorStart is { } anchor)
                {
                    if (anchor < cursor) throw new ValidationException("plannedStart", $"Stage '{stage.Name}' cannot start before {cursor:yyyy-MM-dd}, when its predecessor finishes or the project starts.");
                    cursor = anchor;
                }
                plannedStart = cursor;
                calculatedWork = true;
                var endDay = (long)cursor.DayNumber + days;
                if (endDay > DateOnly.MaxValue.DayNumber) throw new ValidationException("schedule", $"Stage '{stage.Name}' exceeds the supported calendar. Reduce its duration.");
                plannedEnd = DateOnly.FromDayNumber((int)endDay); cursor = plannedEnd.Value;
            }
            output.Add(new(stage.Id, stage.Name, days, plannedStart, plannedEnd, stage.Completed, plannedStart != stage.Start || plannedEnd != stage.End));
        }
        if (alignFinish && cursor != due)
            throw new ValidationException("schedule", "The requested end cannot accommodate the remaining durations after completed work. Extend the end date or reduce unfinished stage durations. Completed history was preserved; nothing was saved.");
        if (mode == StageScheduleMode.FixedDeadline && cursor > due)
            throw new ValidationException("schedule", $"The schedule finishes on {cursor:yyyy-MM-dd}, {cursor.DayNumber - due.Value.DayNumber} day(s) after the project end {due:yyyy-MM-dd}. Extend the end date, move the stage earlier, or reduce allocated durations. Nothing was saved.");
        var deadline = mode == StageScheduleMode.FollowSchedule ? cursor : due.Value;
        return new(version, mode, start.Value, deadline, cursor, deadline.DayNumber - cursor.DayNumber, output);
    }
}
