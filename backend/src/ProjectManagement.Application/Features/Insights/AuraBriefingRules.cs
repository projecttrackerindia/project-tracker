using System.Globalization;

namespace ProjectManagement.Application.Features.Insights;

/// <summary>
/// The deterministic rules behind Aura's morning briefing: which candidate needs the person most (one score per kind, older and later things
/// first) and, for work at risk, the one plain reason why (a slipped dependency, an overdue owner, a date that keeps moving). Pure functions over
/// facts already read from the database, so the order and the wording never depend on a model; AI only rephrases the headline line.
/// </summary>
public static class AuraBriefingRules
{
    public const int NeedsYouShown = 3;
    public const int RisksShown = 3;

    /// <summary>A thing that may need the person: its kind (approval, review, unblock, due, overdue) and how old or late it is.</summary>
    public record Need(string Id, string Kind, int AgeDays, int Blocks = 0);

    /// <summary>Higher first: decisions others wait on, then work that unblocks others, then work due today, then overdue work.</summary>
    public static int Score(Need n) => n.Kind switch
    {
        "approval" => 500 + Math.Min(n.AgeDays, 30) * 5,
        "slipfix" => 480,
        "review" => 450 + Math.Min(n.AgeDays, 30) * 5,
        "unblock" => 400 + Math.Min(n.Blocks, 10) * 10 + Math.Min(n.AgeDays, 30),
        "due" => 300,
        "overdue" => 200 + Math.Min(n.AgeDays, 60),
        _ => 0,
    };

    /// <summary>The order of what needs you: by score, then by id so two equal items never swap places between refreshes.</summary>
    public static List<T> Rank<T>(IEnumerable<T> items, Func<T, Need> need) =>
        items.OrderByDescending(x => Score(need(x))).ThenBy(x => need(x).Id, StringComparer.Ordinal).ToList();

    public static string Headline(int count) => count switch
    {
        0 => "Nothing needs you today",
        1 => "1 thing needs you today",
        _ => $"{Math.Min(count, NeedsYouShown)} things need you today",
    };

    /// <summary>A task this one waits on.</summary>
    public record Blocker(string Key, string Title, DateOnly? Due, bool Done);
    /// <summary>The latest move of a task's date, with its reason.</summary>
    public record Move(DateOnly? Previous, DateOnly? Revised, string? Reason);
    /// <summary>What is known about one open task.</summary>
    public record RiskFacts(DateOnly? Due, DateOnly Today, bool OwnerIsMe, string? OwnerName, int OwnerOverdue, Blocker? Blocker, Move? LastMove, int Moves);
    /// <summary>The one reason (in words), its kind (dependency, owner, extension, late) and the action that fixes it (open, reassign).</summary>
    public record Risk(string Kind, string Why, string Verb, int Score);

    public static string D(DateOnly? d) => d is { } x ? x.ToString("d MMM", CultureInfo.InvariantCulture) : "no date";

    /// <summary>Why this task is at risk, or null when nothing says it is. The strongest reason wins: a slipped dependency, an overdue owner, a moving date.</summary>
    public static Risk? Assess(RiskFacts f)
    {
        var late = f.Due is { } due && due < f.Today ? f.Today.DayNumber - due.DayNumber : 0;
        if (f.Blocker is { Done: false } b && f.Due is { } d)
        {
            if (b.Due is { } bd && bd > d)
                return new Risk("dependency", $"Waits on {b.Key} “{b.Title}”, which slipped to {D(bd)} — after this is due ({D(d)}).", "open", 90 + late);
            if (b.Due is { } od && od < f.Today)
                return new Risk("dependency", $"Waits on {b.Key} “{b.Title}”, {f.Today.DayNumber - od.DayNumber}d overdue.", "open", 80 + late);
        }
        if (late > 0 && !f.OwnerIsMe && f.OwnerName is { Length: > 0 } owner)
        {
            var load = f.OwnerOverdue > 1 ? $" · {First(owner)} has {f.OwnerOverdue} overdue" : "";
            return new Risk("owner", $"{late} day{(late == 1 ? "" : "s")} overdue{load}.", "reassign", 60 + late + f.OwnerOverdue);
        }
        if (f.Moves > 0 && f.LastMove is { } m && (f.Due is null || f.Due.Value.DayNumber - f.Today.DayNumber <= 7))
        {
            var why = m.Reason is { Length: > 0 } r ? $" — “{r}”" : " — no reason given";
            return new Risk("extension", $"Moved {(f.Moves == 1 ? "once" : $"{f.Moves} times")}: {D(m.Previous)} → {D(m.Revised)}{why}.", "open", 40 + f.Moves * 5 + late);
        }
        if (late > 0)
            return new Risk("late", $"{late} day{(late == 1 ? "" : "s")} overdue{(f.OwnerName is null ? " and nobody owns it" : "")}.", f.OwnerName is null ? "reassign" : "open", 30 + late);
        return null;
    }

    public static string First(string name) => name.Split(' ', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? name;

    /// <summary>The deterministic sentence under the headline: the first thing to do, and what is at risk.</summary>
    public static string Line(IReadOnlyList<(string Title, string Verb)> needs, int risks, int meetings)
    {
        var parts = new List<string>();
        if (needs.Count > 0) parts.Add($"Start with {needs[0].Title}.");
        if (risks > 0) parts.Add($"{risks} {(risks == 1 ? "item is" : "items are")} at risk.");
        if (meetings > 0) parts.Add($"{meetings} meeting{(meetings == 1 ? "" : "s")} today.");
        return parts.Count == 0 ? "A clear day. Pick something you have been meaning to do." : string.Join(" ", parts);
    }
}
