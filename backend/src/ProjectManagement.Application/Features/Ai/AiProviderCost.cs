namespace ProjectManagement.Application.Features.Ai;

public record AiTokenPrice(string Model, string Version, decimal InputPerMillion, decimal OutputPerMillion, decimal CacheReadPerMillion, decimal CacheWritePerMillion, string Source);
public record AiProviderCostEstimate(string Currency, decimal? EstimatedCost, bool Complete, IReadOnlyList<AiTokenPrice> Prices, string Exclusions);

public static class AiProviderCost
{
    public static AiTokenPrice? Price(string? model, string? tier, AiOptions options)
    {
        if (model == "gemini-3.5-flash-lite")
            return new(model, "google-standard-2026-10-10", .30m, 2.50m, .03m, 0, "https://ai.google.dev/gemini-api/docs/pricing");
        if (model?.StartsWith("claude-", StringComparison.OrdinalIgnoreCase) == true)
        {
            var t = tier switch { "quick" => options.Chat.Quick, "standard" => options.Chat.Standard, "deep" => options.Chat.Deep, _ => null };
            if (t is not null) return new(model, "configured-tier-rates-v1", t.InputPerMTok, t.OutputPerMTok,
                t.InputPerMTok * t.CacheReadFactor, t.InputPerMTok * t.CacheWriteFactor, "Ai:Chat configured rates");
        }
        return null;
    }

    public static decimal Cost(AiTokenPrice price, long input, long output, long read, long write) =>
        (input * price.InputPerMillion + output * price.OutputPerMillion + read * price.CacheReadPerMillion + write * price.CacheWritePerMillion) / 1_000_000m;

    public static AiProviderCostEstimate Estimate(IReadOnlyList<AiModelTiming> turns, string tier, AiOptions options, bool applicationReply)
    {
        decimal cost = 0; var complete = applicationReply || turns.Count > 0; var prices = new List<AiTokenPrice>();
        foreach (var turn in turns)
        {
            var price = Price(turn.Model, tier, options);
            if (price is null || turn.StopReason == "failed" || !turn.UsageKnown) { complete = false; continue; }
            cost += Cost(price, turn.InputTokens, turn.OutputTokens, turn.CacheReadTokens, turn.CacheWriteTokens);
            if (!prices.Contains(price)) prices.Add(price);
        }
        return new("USD", complete ? cost : null, complete, prices,
            "Recorded model turns only; excludes taxes, grounding, cache storage, classifiers, unrecorded interrupted usage and local hosting. Not a provider invoice.");
    }
}
