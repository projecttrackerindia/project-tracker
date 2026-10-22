using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Infrastructure.Services;

namespace ProjectManagement.Tests;

/// <summary>Short structured tasks on Gemini 2.5 must not spend their answer budget thinking (the cause of "the answer could not be read").</summary>
public class GeminiThinkingTests
{
    private static AiChatRequest Req(string model, bool reasoning = false) => new(model, "s", "", [], [], 400, null, reasoning);

    [Fact]
    public void Flash_answers_without_thinking_unless_reasoning_is_shown()
    {
        var g = GeminiChat.Generation(Req("gemini-2.5-flash"), 400);
        Assert.Equal(0, g["thinkingConfig"]!["thinkingBudget"]!.GetValue<int>());
        Assert.Equal(400, g["maxOutputTokens"]!.GetValue<int>());
        Assert.Null(GeminiChat.Generation(Req("gemini-2.5-flash", reasoning: true), 400)["thinkingConfig"]);
    }

    [Fact]
    public void Pro_gets_its_smallest_thinking_budget_on_top_of_the_answer()
    {
        var g = GeminiChat.Generation(Req("gemini-2.5-pro"), 400);
        Assert.Equal(128, g["thinkingConfig"]!["thinkingBudget"]!.GetValue<int>());
        Assert.Equal(528, g["maxOutputTokens"]!.GetValue<int>());
        Assert.Null(GeminiChat.Generation(Req("gemini-2.0-flash"), 400)["thinkingConfig"]);
    }
}
