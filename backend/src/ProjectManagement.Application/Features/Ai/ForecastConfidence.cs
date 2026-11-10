using System.Globalization;

namespace ProjectManagement.Application.Features.Ai;

/// <summary>
/// How sure Aura is of a project's likely finish, in words a person can act on. <see cref="Band"/> is high, medium, low, early or none;
/// <see cref="Label"/> is the whole line ("Likely 22 Dec · fairly sure"). <see cref="ConfidencePct"/> is present only when there are enough
/// comparable completed projects to calibrate against (<see cref="ForecastConfidence.MinComparable"/>); otherwise it is null and the label says
/// "early estimate". It is never a model's guess: it is a lower bound on the share of past forecasts that landed within <see cref="WithinDays"/> days.
/// </summary>
public sealed record ForecastConfidenceDto(string Band, string Label, int? ConfidencePct, bool Calibrated, int ComparableProjects, int WithinDays,
    IReadOnlyList<string> Evidence);

/// <summary>What is known about the current project: how its finished stages ran, its stage owner's load and whether the scope grew.</summary>
public sealed record ForecastEvidence(int FinishedStages, double AverageStageSlipDays, bool OwnerOverloaded, int? OwnerLoadPercent, int TasksAddedRecently, int OpenTasks,
    int WindowDays = 14);

/// <summary>How past forecasts did: completed projects whose forecast (made at least a week before) could be checked, and how many landed within the window.</summary>
public sealed record ForecastCalibration(int Verified, int WithinWindow, double? MeanAbsoluteErrorDays, double? MeanSignedErrorDays)
{
    public static readonly ForecastCalibration None = new(0, 0, null, null);
}

/// <summary>
/// The method (see docs/AI-KNOWLEDGE-AND-FORECASTS.md): the base band comes from how often past forecasts held (Wilson lower bound, so a handful of
/// lucky projects cannot read as certainty); current evidence (slow earlier stages, an overloaded stage owner, scope added lately) lowers it by a
/// step per two points of concern. With fewer than <see cref="MinComparable"/> comparable completed projects there is nothing to calibrate against,
/// so the answer is "early estimate" with no percentage, whatever the evidence says.
/// </summary>
public static class ForecastConfidence
{
    public const int MinComparable = 5;
    public const int WithinDays = 3;
    private const double Z = 1.2816;   // one-sided 90%: the lower bound a person can lean on

    private static readonly string[] Bands = ["low", "medium", "high"];
    private static string Words(string band) => band switch { "high" => "sure", "medium" => "fairly sure", "low" => "not very sure", _ => "early estimate" };
    private static string Day(DateOnly d) => d.ToString("d MMM", CultureInfo.InvariantCulture);

    /// <summary>Lower bound of the share of forecasts that held, from <paramref name="hits"/> of <paramref name="n"/> (Wilson score).</summary>
    public static double WilsonLower(int hits, int n)
    {
        if (n <= 0) return 0;
        var p = Math.Clamp(hits, 0, n) / (double)n;
        var z2 = Z * Z;
        return Math.Max(0, (p + z2 / (2 * n) - Z * Math.Sqrt(p * (1 - p) / n + z2 / (4.0 * n * n))) / (1 + z2 / n));
    }

    /// <summary>Points of concern from the evidence, and the plain sentences behind them.</summary>
    public static (int Concern, List<string> Notes) Concerns(ForecastEvidence e)
    {
        var concern = 0; var notes = new List<string>();
        if (e.FinishedStages >= 2)
        {
            if (e.AverageStageSlipDays >= 5) { concern += 2; notes.Add($"Earlier stages finished about {Math.Round(e.AverageStageSlipDays)} days late on average."); }
            else if (e.AverageStageSlipDays >= 2) { concern += 1; notes.Add($"Earlier stages finished about {Math.Round(e.AverageStageSlipDays)} days late on average."); }
            else notes.Add("Earlier stages finished on time.");
        }
        else notes.Add("Few finished stages to learn from yet.");
        if (e.OwnerOverloaded)
        {
            concern += 2;
            notes.Add(e.OwnerLoadPercent is { } p ? $"The current stage owner is overloaded ({p}% of what fits before the stage date)." : "The current stage owner is overloaded.");
        }
        if (e.TasksAddedRecently >= 3 && e.OpenTasks > 0 && e.TasksAddedRecently * 5 >= e.OpenTasks)
        {
            concern += 1;
            notes.Add($"{e.TasksAddedRecently} tasks were added in the last {e.WindowDays} days, so the scope is still moving.");
        }
        return (concern, notes);
    }

    public static ForecastConfidenceDto Compute(DateOnly? forecast, ForecastEvidence evidence, ForecastCalibration calibration)
    {
        if (forecast is not { } date) return new("none", "No date yet", null, false, calibration.Verified, WithinDays, []);
        var (concern, notes) = Concerns(evidence);
        if (calibration.Verified < MinComparable)
        {
            notes.Add($"Based on this project alone: {calibration.Verified} of the {MinComparable} completed projects needed to check how often forecasts hold have been verified here.");
            return new("early", $"Likely {Day(date)} · early estimate", null, false, calibration.Verified, WithinDays, notes);
        }
        var lower = WilsonLower(calibration.WithinWindow, calibration.Verified);
        var pct = (int)Math.Clamp(Math.Round(lower * 100 / 5.0) * 5, 5, 95);
        var baseBand = pct >= 85 ? "high" : pct >= 65 ? "medium" : "low";
        var band = Bands[Math.Max(0, Array.IndexOf(Bands, baseBand) - concern / 2)];
        notes.Insert(0, $"{calibration.WithinWindow} of {calibration.Verified} past forecasts landed within {WithinDays} days of the real finish.");
        if (band != baseBand) notes.Add("Lowered because of the points above.");
        return new(band, $"Likely {Day(date)} · {Words(band)}", pct, true, calibration.Verified, WithinDays, notes);
    }

    /// <summary>A sentence for Aura's answers: the line, and the plain reasons.</summary>
    public static string ToText(ForecastConfidenceDto c) => c.Band == "none" ? c.Label
        : $"{c.Label}{(c.ConfidencePct is { } p ? $" ({p}% of past forecasts held within {c.WithinDays} days)" : "")}. {string.Join(" ", c.Evidence)}";
}
