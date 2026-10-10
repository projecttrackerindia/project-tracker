using ProjectManagement.Application.Features.Ai;

namespace ProjectManagement.Tests;

public class AiProviderCostTests
{
    [Fact]
    public void Gemini_estimate_uses_completed_turn_usage_and_retains_the_price_version()
    {
        var estimate = AiProviderCost.Estimate([new(0, 10, 1_000_000, 1_000_000, "end_turn", Model: "gemini-3.5-flash-lite", CacheReadTokens: 1_000_000)], "quick", new AiOptions(), false);
        Assert.True(estimate.Complete); Assert.Equal(2.83m, estimate.EstimatedCost);
        Assert.Equal("google-standard-2026-10-10", Assert.Single(estimate.Prices).Version);
    }

    [Theory]
    [InlineData("unknown-model", "end_turn")]
    [InlineData("gemini-3.5-flash-lite", "failed")]
    public void Unknown_or_interrupted_usage_is_not_reported_as_free(string model, string stop)
    {
        var estimate = AiProviderCost.Estimate([new(0, 10, 30, 20, stop, Model: model)], "quick", new AiOptions(), false);
        Assert.False(estimate.Complete); Assert.Null(estimate.EstimatedCost);
    }
}
