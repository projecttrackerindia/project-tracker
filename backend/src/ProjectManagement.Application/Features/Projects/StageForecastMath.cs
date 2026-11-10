using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Projects;

public sealed record ForecastStage(Guid Id, string Name, StageStatus Status, DateOnly? PlannedStart, DateOnly? PlannedEnd, DateOnly? ActualEnd, Guid? OwnerId);
public sealed record ForecastOpenTask(Guid? AssigneeId, double Hours);
/// <param name="Delay">Days the current stage is behind its own date.</param>
/// <param name="Overload">Days added because the stage owner has more open work than fits before the stage date.</param>
/// <param name="History">Half of how late finished stages ran, carried into what is left.</param>
/// <param name="FinishedStages">Finished stages that had both dates, and their average lateness in days (not halved).</param>
public sealed record StageForecastResult(int Index, int Delay, int Overload, int History, int Slip, DateOnly? Forecast, string? Reason, int FinishedStages,
    double AverageStageSlipDays, double OwnerCapacityHours);

/// <summary>
/// The arithmetic of the project page's forecast, apart from the database so the project page and the background slip-and-fix job give the same
/// answer from the same figures: the current stage's remaining work at six hours a day, the owner's load beyond what fits before the stage date, and
/// how late earlier stages ran.
/// </summary>
public static class StageForecastMath
{
    public const double HoursPerDay = 6;

    public static StageForecastResult Compute(DateOnly today, DateOnly? promised, ProjectStatus status, IReadOnlyList<ForecastStage> stages,
        IReadOnlyList<ForecastOpenTask> openInCurrent, double ownerOpenHours, string? ownerFirstName)
    {
        var index = -1;
        for (var i = 0; i < stages.Count; i++) if (stages[i].Status != StageStatus.Completed) { index = i; break; }
        var current = index >= 0 ? stages[index] : null;

        int delay = 0, overload = 0; string? reason = null; double capacityHours = 0;
        if (current is not null)
        {
            var people = Math.Max(1, openInCurrent.Select(t => t.AssigneeId).Where(a => a != null).Distinct().Count());
            var hours = openInCurrent.Sum(t => t.Hours);
            var workDays = (int)Math.Ceiling(hours / HoursPerDay / people);
            if (current.PlannedEnd is { } end)
            {
                var finish = today.AddDays(workDays);
                delay = Math.Max(0, finish.DayNumber - end.DayNumber);
                if (today > end) delay = Math.Max(delay, today.DayNumber - end.DayNumber);
            }
            if (current.OwnerId is not null)
            {
                capacityHours = Math.Max(1, (current.PlannedEnd?.DayNumber ?? today.DayNumber + 5) - today.DayNumber) * HoursPerDay;
                overload = (int)Math.Max(0, Math.Ceiling((ownerOpenHours - capacityHours) / HoursPerDay / 2));
            }
            if (delay > 0) reason = $"{current.Name} is behind";
            else if (overload > 0) reason = $"{ownerFirstName ?? "Its owner"} is overloaded in {current.Name}";
        }
        // How late finished stages ran: half of their average slip is carried into what is left.
        var slips = stages.Where(s => s.Status == StageStatus.Completed && s.ActualEnd != null && s.PlannedEnd != null)
            .Select(s => Math.Max(0, s.ActualEnd!.Value.DayNumber - s.PlannedEnd!.Value.DayNumber)).ToList();
        var history = slips.Count > 0 && index >= 0 && index < stages.Count - 1 ? (int)Math.Round(slips.Average() / 2) : 0;
        if (reason is null && history > 0) reason = "earlier stages ran late";

        var slip = status is ProjectStatus.Completed or ProjectStatus.Cancelled ? 0 : delay + overload + history;
        return new StageForecastResult(index, delay, overload, history, slip, promised?.AddDays(slip), slip > 0 ? reason : null, slips.Count,
            slips.Count > 0 ? slips.Average() : 0, capacityHours);
    }
}
