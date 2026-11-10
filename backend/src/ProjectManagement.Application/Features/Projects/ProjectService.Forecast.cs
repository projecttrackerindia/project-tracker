using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Projects;

/// <summary>
/// When the project will really finish: the promised date (the due date, else the last stage's date) and an honest forecast from the
/// current stage's remaining work, how loaded its owner is, and how late earlier stages ran. Also the three ring numbers (journey, time
/// used, work done) and one fix: the least-loaded project member who could take the current stage, and the date that would give.
/// </summary>
public record ProjectForecastDto(DateOnly? Promised, DateOnly? Forecast, int SlipDays, string? Reason, Guid? CurrentStageId, string? CurrentStage,
    UserRefDto? CurrentOwner, int? DaysLeft, int JourneyPct, int TimeUsedPct, int WorkDonePct, int StageIndex, int StageCount,
    UserRefDto? SuggestedOwner, int SuggestedOwnerOpenTasks, DateOnly? SuggestedForecast);

public partial class ProjectService
{
    private const double HoursPerDay = 6;

    public async Task<ProjectForecastDto> GetForecastAsync(Guid projectId, CancellationToken ct = default)
    {
        var project = await access.VisibleProjects().AsNoTracking().FirstOrDefaultAsync(p => p.Id == projectId, ct)
            ?? throw new ProjectManagement.Application.Exceptions.NotFoundException("Project not found.");
        var stats = (await GetStatsAsync([projectId], ct))[projectId];
        var stages = await db.ProjectStages.AsNoTracking().Where(s => s.ProjectId == projectId).OrderBy(s => s.Order).ToListAsync(ct);
        return await ForecastAsync(project, stages, ProjectMetrics.Progress(stats), ct);
    }

    private async Task<ProjectForecastDto> ForecastAsync(Project project, List<ProjectStage> stages, int workDone, CancellationToken ct)
    {
        var today = clock.Today;
        var promised = project.DueDate ?? stages.LastOrDefault(s => s.PlannedEnd != null)?.PlannedEnd;
        var index = stages.FindIndex(s => s.Status != StageStatus.Completed);
        var current = index >= 0 ? stages[index] : null;

        // Journey: completed stages, plus the share of the current stage's planned time already gone.
        double journey = stages.Count == 0 ? 0 : stages.Count(s => s.Status == StageStatus.Completed);
        if (current is { PlannedStart: { } cs, PlannedEnd: { } ce } && ce > cs)
            journey += Math.Clamp((today.DayNumber - cs.DayNumber) / (double)(ce.DayNumber - cs.DayNumber), 0, 1);
        var journeyPct = stages.Count == 0 ? 0 : (int)Math.Round(journey * 100 / stages.Count);
        var start = project.StartDate ?? stages.FirstOrDefault()?.PlannedStart;
        var timeUsed = start is { } s0 && promised is { } p0 && p0 > s0 ? (int)Math.Round(Math.Clamp((today.DayNumber - s0.DayNumber) * 100.0 / (p0.DayNumber - s0.DayNumber), 0, 100)) : 0;

        int delay = 0, overload = 0; string? reason = null; UserRefDto? owner = null;
        if (current is not null)
        {
            var open = await db.Tasks.AsNoTracking().Where(t => t.StageId == current.Id && t.ParentTaskId == null
                    && t.Status!.Category != StatusCategory.Done && t.Status!.Category != StatusCategory.Cancelled)
                .Select(t => new { t.AssigneeId, t.EstimatedHours }).ToListAsync(ct);
            var people = Math.Max(1, open.Select(t => t.AssigneeId).Where(a => a != null).Distinct().Count());
            var hours = open.Sum(t => (double)(t.EstimatedHours ?? 4m));
            var workDays = (int)Math.Ceiling(hours / HoursPerDay / people);
            if (current.PlannedEnd is { } end)
            {
                var finish = today.AddDays(workDays);
                delay = Math.Max(0, finish.DayNumber - end.DayNumber);
                if (today > end) delay = Math.Max(delay, today.DayNumber - end.DayNumber);
            }
            if (current.OwnerId is { } oid)
            {
                var name = await db.Users.AsNoTracking().Where(u => u.Id == oid).Select(u => u.DisplayName).FirstOrDefaultAsync(ct);
                owner = name is null ? null : new UserRefDto(oid, name);
                // The owner's open work everywhere in the workspace beyond what fits before the stage's date.
                var ownerHours = (await db.Tasks.AsNoTracking().Where(t => t.AssigneeId == oid
                        && t.Status!.Category != StatusCategory.Done && t.Status!.Category != StatusCategory.Cancelled)
                    .Select(t => t.EstimatedHours).ToListAsync(ct)).Sum(h => (double)(h ?? 4m));
                var capacity = Math.Max(1, (current.PlannedEnd?.DayNumber ?? today.DayNumber + 5) - today.DayNumber) * HoursPerDay;
                overload = (int)Math.Max(0, Math.Ceiling((ownerHours - capacity) / HoursPerDay / 2));
            }
            if (delay > 0) reason = $"{current.Name} is behind";
            else if (overload > 0) reason = $"{owner?.Name.Split(' ')[0] ?? "Its owner"} is overloaded in {current.Name}";
        }
        // How late finished stages ran: half of their average slip is carried into what is left.
        var slips = stages.Where(s => s.Status == StageStatus.Completed && s.ActualEnd != null && s.PlannedEnd != null)
            .Select(s => Math.Max(0, s.ActualEnd!.Value.DayNumber - s.PlannedEnd!.Value.DayNumber)).ToList();
        var history = slips.Count > 0 && index >= 0 && index < stages.Count - 1 ? (int)Math.Round(slips.Average() / 2) : 0;
        if (reason is null && history > 0) reason = "earlier stages ran late";

        var slip = project.Status is ProjectStatus.Completed or ProjectStatus.Cancelled ? 0 : delay + overload + history;
        var forecast = promised?.AddDays(slip);

        // One fix: the project member with the least open work takes the current stage, removing the owner's overload.
        UserRefDto? suggested = null; var suggestedOpen = 0; DateOnly? suggestedForecast = null;
        if (current is not null && overload > 0)
        {
            var members = await db.ProjectMembers.AsNoTracking().Where(m => m.ProjectId == project.Id && m.UserId != current.OwnerId).Select(m => m.UserId).ToListAsync(ct);
            if (members.Count > 0)
            {
                var load = await db.Tasks.AsNoTracking().Where(t => t.AssigneeId != null && members.Contains(t.AssigneeId.Value)
                        && t.Status!.Category != StatusCategory.Done && t.Status!.Category != StatusCategory.Cancelled)
                    .GroupBy(t => t.AssigneeId).Select(g => new { Id = g.Key!.Value, N = g.Count() }).ToListAsync(ct);
                var best = members.Select(id => new { Id = id, N = load.FirstOrDefault(l => l.Id == id)?.N ?? 0 }).OrderBy(x => x.N).First();
                var name = await db.Users.AsNoTracking().Where(u => u.Id == best.Id).Select(u => u.DisplayName).FirstOrDefaultAsync(ct);
                if (name is not null) { suggested = new UserRefDto(best.Id, name); suggestedOpen = best.N; suggestedForecast = promised?.AddDays(slip - overload); }
            }
        }
        int? daysLeft = current?.PlannedEnd is { } pe ? pe.DayNumber - today.DayNumber : null;
        return new ProjectForecastDto(promised, forecast, slip, slip > 0 ? reason : null, current?.Id, current?.Name, owner, daysLeft,
            journeyPct, timeUsed, workDone, index < 0 ? stages.Count : index + 1, stages.Count, suggested, suggestedOpen, suggestedForecast);
    }
}
