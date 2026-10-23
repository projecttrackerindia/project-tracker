using System.Globalization;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Tasks;

public record SuggestedPerson(Guid UserId, string Name, string Why);
public record SimilarTask(Guid Id, string Key, string Title, decimal? Hours, string? Assignee);
public record TaskSuggestionsDto(
    IReadOnlyList<SuggestedPerson> Assignees,
    decimal? EstimateLow, decimal? EstimateHigh, decimal? Estimate, string? EstimateWhy,
    DateOnly? DueDate, string? DueWhy,
    Priority? Priority, string? PriorityWhy,
    IReadOnlyList<SimilarTask> Similar);

/// <summary>
/// Suggestions for a new task, from the workspace's own history and rules only (no model call, so they are instant and free): who has room
/// and a track record on similar work, how long similar finished work really took, a due date from that, and the priority similar work had.
/// Every suggestion carries the facts behind it, and only work the person may already see is used.
/// </summary>
public class TaskSuggestionService(IAppDbContext db, ProjectAccess access, AiAnalysis analysis, AppClock clock, ProjectManagement.Application.Features.Integrations.GitHubAppService? gitHub = null)
{
    /// <summary>Working hours a person typically spends on one task in a day, used to turn an estimate into working days.</summary>
    private const decimal HoursPerDay = 6m;

    public async Task<TaskSuggestionsDto> SuggestAsync(Guid projectId, string? title, CancellationToken ct = default)
    {
        await access.GetProjectAsync(projectId, ct);   // not found unless the person may open the project
        var text = (title ?? "").Trim();
        var people = (await analysis.RankAssigneesAsync(text, projectId, 3, ct)).Select(f => new SuggestedPerson(f.UserId, f.Name, f.Why)).ToList();

        HashSet<string> words = text.Length == 0 ? new() : AiAnalysis.Words(text);
        // Who actually changed the code this is about (from merged pull requests), first.
        if (gitHub is not null && words.Count > 0)
        {
            var owners = await gitHub.CodeOwnersAsync(words, ct);
            people = [.. owners.Select(o => new SuggestedPerson(o.UserId, o.Name, o.Why)), .. people.Where(p => !owners.Any(o => o.UserId == p.UserId))];
            people = people.Take(3).ToList();
        }
        if (words.Count == 0) return new TaskSuggestionsDto(people, null, null, null, null, null, null, null, null, []);

        // Finished work in the last year that shares words with the new title, this project first, then by how many words match.
        var cutoff = clock.Now.AddDays(-365);
        var finished = await access.VisibleTasks().AsNoTracking()
            .Where(t => t.CompletedAt != null && t.CompletedAt >= cutoff)
            .OrderByDescending(t => t.CompletedAt)
            .Select(t => new { t.Id, t.ProjectId, ProjectKey = t.Project!.Key, t.Number, t.Title, t.Priority, t.ActualHours, t.EstimatedHours, Assignee = t.Assignee != null ? t.Assignee.DisplayName : null })
            .Take(1500).ToListAsync(ct);
        var similar = finished
            .Select(t => new { t, Score = AiAnalysis.Words(t.Title).Count(words.Contains) + (t.ProjectId == projectId ? 0.5 : 0) })
            .Where(x => x.Score >= 1)
            .OrderByDescending(x => x.Score)
            .Take(8).Select(x => x.t).ToList();
        if (similar.Count == 0) return new TaskSuggestionsDto(people, null, null, null, null, null, null, null, null, []);

        // Real time spent: the hours recorded on the task, else the time logged against it, else its estimate.
        var ids = similar.Select(s => s.Id).ToList();
        var logged = await db.TimeEntries.AsNoTracking().Where(e => e.TaskId != null && ids.Contains(e.TaskId.Value))
            .GroupBy(e => e.TaskId!.Value).Select(g => new { Id = g.Key, Minutes = g.Sum(e => e.Minutes) }).ToDictionaryAsync(x => x.Id, x => x.Minutes, ct);
        decimal? Hours(Guid id, decimal? actual, decimal? estimated) =>
            actual is > 0 ? actual : logged.TryGetValue(id, out var m) && m > 0 ? Math.Round(m / 60m, 1) : estimated is > 0 ? estimated : null;
        var shown = similar.Select(s => new SimilarTask(s.Id, $"{s.ProjectKey}-{s.Number}", s.Title, Hours(s.Id, s.ActualHours, s.EstimatedHours), s.Assignee)).ToList();

        decimal? low = null, high = null, mid = null; string? estimateWhy = null; DateOnly? due = null; string? dueWhy = null;
        var hours = shown.Where(s => s.Hours is not null).Select(s => s.Hours!.Value).OrderBy(h => h).ToList();
        if (hours.Count > 0)
        {
            low = Quantile(hours, .25m); high = Quantile(hours, .75m); mid = Quantile(hours, .5m);
            var listed = string.Join(", ", hours.Take(5).Select(H));
            estimateWhy = hours.Count == 1 ? $"One similar finished task took {listed} h." : $"{hours.Count} similar finished tasks took {listed} h.";
            var days = (int)Math.Max(1, Math.Ceiling(mid.Value / HoursPerDay));
            due = AddWorkingDays(clock.Today, days);
            dueWhy = $"About {days} working day{(days == 1 ? "" : "s")} from today at {H(HoursPerDay)} h a day.";
        }

        Priority? priority = null; string? priorityWhy = null;
        var byPriority = similar.GroupBy(s => s.Priority).OrderByDescending(g => g.Count()).FirstOrDefault();
        if (byPriority is not null && byPriority.Count() >= 2 && byPriority.Count() * 2 > similar.Count)
        {
            priority = byPriority.Key;
            priorityWhy = $"{byPriority.Count()} of {similar.Count} similar tasks were {byPriority.Key}.";
        }
        return new TaskSuggestionsDto(people, low, high, mid, estimateWhy, due, dueWhy, priority, priorityWhy, shown.Take(3).ToList());
    }

    private static string H(decimal h) => h.ToString("0.#", CultureInfo.InvariantCulture);

    private static decimal Quantile(IReadOnlyList<decimal> sorted, decimal q)
    {
        if (sorted.Count == 1) return sorted[0];
        var pos = (sorted.Count - 1) * q;
        var lo = (int)Math.Floor(pos); var hi = (int)Math.Ceiling(pos);
        return Math.Round(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo), 1);
    }

    /// <summary>Counts forward over Monday to Friday only.</summary>
    public static DateOnly AddWorkingDays(DateOnly from, int days)
    {
        var d = from;
        while (days > 0)
        {
            d = d.AddDays(1);
            if (d.DayOfWeek is not (DayOfWeek.Saturday or DayOfWeek.Sunday)) days--;
        }
        return d;
    }
}
