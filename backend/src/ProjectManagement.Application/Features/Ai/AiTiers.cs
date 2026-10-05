using System.Text.RegularExpressions;

namespace ProjectManagement.Application.Features.Ai;

/// <summary>How much model a question gets. A plan allows up to one of these (<c>AI_MODEL_TIER</c>).</summary>
public enum AiTier { Quick = 1, Standard = 2, Deep = 3 }

/// <summary>What the person asked for in the composer. <see cref="Auto"/> lets the router decide.</summary>
public enum AiMode { Auto, Quick, Standard, Deep }

/// <summary>One model level: which model answers, what a message costs in credits, and how much it may write and think.</summary>
public class AiTierOptions
{
    public string Model { get; set; } = "";
    /// <summary>What one answer at this level costs against the workspace's monthly credits.</summary>
    public int Credits { get; set; } = 1;
    public int MaxTokens { get; set; } = 2000;
    /// <summary>Thinking depth: "low", "medium", "high" or "max". Empty = the model's own default (Quick, which does not think).</summary>
    public string? Effort { get; set; }
    /// <summary>Show the model's reasoning summary while it works (Standard and Deep only).</summary>
    public bool ShowReasoning { get; set; }
    /// <summary>What the provider charges per million tokens (US dollars), used only for the administrator's cost estimate. Set to the provider's current prices.</summary>
    public decimal InputPerMTok { get; set; }
    public decimal OutputPerMTok { get; set; }
    /// <summary>Cached input costs a fraction of normal input (0.1 on most models, 0.05 on Opus 5.5) and writing to the cache a premium (1.25).</summary>
    public decimal CacheReadFactor { get; set; } = 0.1m;
    public decimal CacheWriteFactor { get; set; } = 1.25m;
}

/// <summary>Settings of the AI workspace (<c>Ai:Chat</c>): the three model levels, routing, attachments and limits.</summary>
public class AiChatOptions
{
    // Quick answers lookups and small talk without thinking; Standard handles most real questions; Deep is for analysis and planning.
    public AiTierOptions Quick { get; set; } = new() { Model = "claude-haiku-4-5", Credits = 1, MaxTokens = 1500, InputPerMTok = 1m, OutputPerMTok = 5m };
    public AiTierOptions Standard { get; set; } = new() { Model = "claude-sonnet-5-5", Credits = 4, MaxTokens = 6000, Effort = "low", ShowReasoning = true, InputPerMTok = 2m, OutputPerMTok = 10m };
    public AiTierOptions Deep { get; set; } = new() { Model = "claude-opus-5-5", Credits = 15, MaxTokens = 16000, Effort = "high", ShowReasoning = true, InputPerMTok = 4m, OutputPerMTok = 20m, CacheReadFactor = 0.05m };

    /// <summary>For questions the free rules cannot place, ask the smallest model how hard the question is (a few tokens).</summary>
    public bool UseClassifier { get; set; } = true;
    public string ClassifierModel { get; set; } = "claude-haiku-4-5";

    /// <summary>
    /// When the model declines a request (its safety checks sometimes stop harmless work), the same request is tried once on this model before
    /// the person is told. Empty turns it off. The reasoning of the first model is not carried over: it is bound to that model.
    /// </summary>
    public string? RefusalFallbackModel { get; set; } = "claude-opus-4-8";

    public int MaxFilesPerMessage { get; set; } = 5;
    public int MaxImageMb { get; set; } = 5;
    public int MaxDocumentMb { get; set; } = 10;
    /// <summary>Everything attached to one question, in megabytes (the API's request limit is 32).</summary>
    public int MaxTotalMb { get; set; } = 20;
    public int MaxQuestionChars { get; set; } = 8000;
    /// <summary>Earlier messages of the conversation that go along with a new question.</summary>
    public int HistoryMessages { get; set; } = 24;
    /// <summary>
    /// Once a conversation has more than this many messages that are not yet summarized, the older ones are folded into a short summary (made
    /// by the classifier model) and only the most recent <see cref="KeepRecentMessages"/> go to the model word for word.
    /// </summary>
    public int CompactAfterMessages { get; set; } = 16;
    public int KeepRecentMessages { get; set; } = 6;
    public int SummaryMaxTokens { get; set; } = 700;
    /// <summary>Tool calls the assistant may chain to answer one question.</summary>
    public int MaxToolSteps { get; set; } = 8;
    /// <summary>Characters of each document's text kept for the assistant.</summary>
    public int MaxDocumentChars { get; set; } = 60_000;

    public AiTierOptions For(AiTier tier) => tier switch { AiTier.Quick => Quick, AiTier.Standard => Standard, _ => Deep };
}

/// <summary>The AI abilities of the workspace's plan, after any exception an administrator granted.</summary>
public record AiPlanLevels(bool Enabled, AiTier MaxTier, long MonthlyCredits, bool Attachments, bool Actions)
{
    public bool UnlimitedCredits => MonthlyCredits < 0;
}

/// <param name="Floor">The lowest level worth using: the conversation is in the middle of looking things up or making changes, and a very small model handles that badly.</param>
public record AiRouteRequest(string Text, int Images, int Documents, AiMode Mode, AiTier PlanMax, AiTier Floor = AiTier.Quick);

/// <summary>The router's decision. <see cref="Wanted"/> is what the question deserved; <see cref="Tier"/> is what the plan lets it have.</summary>
public record AiRoute(AiTier Tier, AiTier Wanted, string Reason, bool Classified = false)
{
    public bool Limited => Wanted > Tier;
}

/// <summary>
/// Chooses the model level for a question so simple questions stay cheap and fast and hard ones get real reasoning. Free rules decide the
/// clear cases; only a question the rules cannot place is sent to the small classifier model. A person's explicit choice always wins,
/// except that the plan's highest level is a ceiling nobody can raise from the composer.
/// </summary>
public static class AiModelRouter
{
    private const RegexOptions Opts = RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled;

    // Work that needs real thinking: finding causes, weighing options, planning, forecasting.
    private static readonly Regex Strong = new(
        @"\b(analy[sz]e|analysis|root[- ]?cause|diagnos\w*|post-?mortem|retro(spective)?|trade-?offs?|forecast\w*|predict\w*|strateg\w*|roadmap|business case|" +
        @"prioriti[sz]\w*|optimi[sz]\w*|bottlenecks?|risk assess\w*|audit|investigate|evaluate|think (hard|deeply|carefully|through)|step[- ]by[- ]step|" +
        @"what should we|how (can|could|should) we (improve|reduce|speed|fix|avoid|prevent|restructure)|why (is|are|was|were|did|does|do|has|have)\b.{0,80}\b(late|delayed|slow|behind|failing|failed|over|blocked|stuck|dropping))", Opts);

    // Mild signals: on their own they leave the question in the middle.
    private static readonly Regex Mild = new(
        @"\b(compare|versus|\bvs\b|recommend\w*|suggest\w*|plan\b|review|explain|summari[sz]e|report|draft|estimate|budget|workload|capacity|why|improve|decide|options?)\b", Opts);

    private static readonly Regex Small = new(
        @"^\s*(hi|hello|hey|thanks|thank you|ok(ay)?|cool|great|good (morning|afternoon|evening)|yes|no|sure|help)\b[\s\p{P}]*$", Opts);

    // Asking for a change (create, assign, invite...) means the model has to look things up, choose a tool and fill it in correctly: a job for Standard at least.
    private static readonly Regex Act = new(
        @"\b(create|add|assign|reassign|schedule|remind|send|e-?mail|invite|set up|setup|make|raise|log|book|move|update|change|rename|delete|close|reopen)\b", Opts);

    private static readonly Regex Lookup = new(
        @"^\s*(what('?s| is| are)? (my|the|our)|who('?s| is| are)|when (is|are|was)|where (is|are)|show( me)?|list|find|how many|count|open|which)\b", Opts);

    /// <summary>The level the free rules give a question, or null when they cannot tell (a middle case worth asking the classifier about).</summary>
    public static (AiTier? Tier, string Reason) Heuristic(AiRouteRequest r)
    {
        var text = r.Text.Trim();
        var strong = Strong.Matches(text).Select(m => m.Value.ToLowerInvariant()).Distinct().Count();
        var mild = Mild.Matches(text).Select(m => m.Value.ToLowerInvariant()).Distinct().Count();
        var score = strong * 2 + mild;
        if (text.Length > 600) score++;
        if (text.Length > 1500) score++;
        if (text.Count(c => c == '?') >= 3) score++;
        if (r.Documents > 0) score++;

        if (score >= 4) return (AiTier.Deep, "A question that needs analysis or planning");
        if (r.Images > 0 || r.Documents > 0) return (AiTier.Standard, "Reading an attachment");
        // The wording rules know English. Written in another script they cannot tell how hard it is, so a score of 0 means "unknown", not "easy".
        if (score == 0 && text.Any(c => char.IsLetter(c) && c > '\u024F')) return (null, "");
        if (score == 0 && Small.IsMatch(text)) return (AiTier.Quick, "A short message");
        if (score == 0 && Act.IsMatch(text)) return (AiTier.Standard, "A request to make a change");
        if (score == 0 && text.Length <= 220 && (Lookup.IsMatch(text) || text.Length <= 80)) return (AiTier.Quick, "A quick lookup");
        if (score == 0) return (AiTier.Standard, "A regular question");
        return (null, "");   // some analytical wording but not conclusive
    }

    /// <summary>The final level: the person's choice or the rules' (or the classifier's) answer, held to the plan's ceiling.</summary>
    public static AiRoute Decide(AiRouteRequest r, AiTier? classified = null)
    {
        AiTier wanted;
        string reason;
        var fromClassifier = false;
        switch (r.Mode)
        {
            case AiMode.Quick: (wanted, reason) = (AiTier.Quick, "You chose Quick"); break;
            case AiMode.Standard: (wanted, reason) = (AiTier.Standard, "You chose Standard"); break;
            case AiMode.Deep: (wanted, reason) = (AiTier.Deep, "You chose Deep thinking"); break;
            default:
                var (h, why) = Heuristic(r);
                if (h is { } t) (wanted, reason) = (t, why);
                else if (classified is { } c) { (wanted, reason, fromClassifier) = (c, c == AiTier.Deep ? "Needs careful reasoning" : c == AiTier.Quick ? "Simple enough to answer fast" : "A regular question", true); }
                else (wanted, reason) = (AiTier.Standard, "A regular question");
                break;
        }
        // Images and documents need a model that reads them well; Quick is bumped to Standard unless the plan stops at Quick.
        if (wanted == AiTier.Quick && (r.Images > 0 || r.Documents > 0) && r.Mode == AiMode.Auto) (wanted, reason) = (AiTier.Standard, "Reading an attachment");
        if (r.Mode == AiMode.Auto && wanted < r.Floor) { wanted = r.Floor; reason = "Continuing what we were doing"; }
        var tier = wanted > r.PlanMax ? r.PlanMax : wanted;
        return new AiRoute(tier, wanted, reason, fromClassifier);
    }

    /// <summary>Whether the free rules left the question undecided, so a classifier call could still change the outcome.</summary>
    public static bool NeedsClassifier(AiRouteRequest r) => r.Mode == AiMode.Auto && r.PlanMax > AiTier.Quick && Heuristic(r).Tier is null;

    public static AiTier? ParseClassifier(string? answer)
    {
        if (string.IsNullOrWhiteSpace(answer)) return null;
        var a = answer.ToLowerInvariant();
        // Whichever level word comes first in the answer ("deep", "standard" or "quick").
        AiTier? best = null;
        var bestAt = int.MaxValue;
        foreach (var (word, tier) in new[] { ("quick", AiTier.Quick), ("standard", AiTier.Standard), ("deep", AiTier.Deep) })
        {
            var at = a.IndexOf(word, StringComparison.Ordinal);
            if (at >= 0 && at < bestAt) (best, bestAt) = (tier, at);
        }
        return best;
    }

    public const string ClassifierPrompt =
        "You decide how much reasoning a question needs from an assistant inside a project management app. Answer with exactly one word.\n" +
        "quick = a greeting, a simple lookup or a one-fact question.\n" +
        "standard = a normal question or a short summary that needs a few facts put together.\n" +
        "deep = analysis, finding causes, comparing options, planning, forecasting or a report that needs careful multi-step reasoning.";
}
