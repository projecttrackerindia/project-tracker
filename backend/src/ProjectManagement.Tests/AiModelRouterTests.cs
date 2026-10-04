using ProjectManagement.Application.Features.Ai;

namespace ProjectManagement.Tests;

/// <summary>Which model level a question gets: simple questions stay cheap, hard ones get real reasoning, and the plan is a ceiling.</summary>
public class AiModelRouterTests
{
    private static AiRoute Route(string text, AiMode mode = AiMode.Auto, AiTier plan = AiTier.Deep, int images = 0, int docs = 0, AiTier? classified = null) =>
        AiModelRouter.Decide(new AiRouteRequest(text, images, docs, mode, plan), classified);

    [Theory]
    [InlineData("hi")]
    [InlineData("Thanks!")]
    [InlineData("Which tasks are overdue?")]
    [InlineData("Show me my work due today")]
    [InlineData("Who is on the Atlas project?")]
    public void Greetings_and_lookups_are_answered_by_the_quick_level(string text) => Assert.Equal(AiTier.Quick, Route(text).Tier);

    [Theory]
    [InlineData("Analyze why the Atlas project is late and recommend how to fix it")]
    [InlineData("What is the root cause of the delays across our projects? Compare the options and prioritize the fixes.")]
    [InlineData("Think carefully and plan a step-by-step recovery for the migration, with the trade-offs")]
    public void Analysis_and_planning_get_deep_thinking(string text)
    {
        var route = Route(text);
        Assert.Equal(AiTier.Deep, route.Tier);
        Assert.False(route.Limited);
    }

    [Fact]
    public void A_regular_question_gets_the_standard_level()
    {
        Assert.Equal(AiTier.Standard, Route("Can you tell me what the team agreed to do about the vendor contract and who is following up on it this week?").Tier);
    }

    [Fact]
    public void Attachments_need_at_least_the_standard_level_in_auto_mode()
    {
        Assert.Equal(AiTier.Standard, Route("what is this?", images: 1).Tier);
        Assert.Equal(AiTier.Standard, Route("hi", docs: 1).Tier);
        // ... but not when the plan stops at Quick.
        Assert.Equal(AiTier.Quick, Route("what is this?", images: 1, plan: AiTier.Quick).Tier);
    }

    [Fact]
    public void A_persons_choice_wins_over_the_rules_but_never_over_the_plan()
    {
        Assert.Equal(AiTier.Quick, Route("Analyze why the Atlas project is late and recommend how to fix it", AiMode.Quick).Tier);
        Assert.Equal(AiTier.Deep, Route("hi", AiMode.Deep).Tier);

        var capped = Route("Analyze why the Atlas project is late and recommend how to fix it", AiMode.Deep, AiTier.Standard);
        Assert.Equal(AiTier.Standard, capped.Tier);
        Assert.Equal(AiTier.Deep, capped.Wanted);
        Assert.True(capped.Limited);   // the page tells the person this needed a higher plan
    }

    [Fact]
    public void The_plan_ceiling_applies_to_automatic_choices_too()
    {
        var route = Route("Analyze why the Atlas project is late and recommend how to fix it", plan: AiTier.Quick);
        Assert.Equal(AiTier.Quick, route.Tier);
        Assert.True(route.Limited);
    }

    [Fact]
    public void Only_undecided_questions_are_worth_a_classifier_call()
    {
        AiRouteRequest R(string t, AiMode m = AiMode.Auto, AiTier p = AiTier.Deep) => new(t, 0, 0, m, p);
        Assert.True(AiModelRouter.NeedsClassifier(R("Summarise our portfolio")));          // a little analytical wording, not conclusive
        Assert.False(AiModelRouter.NeedsClassifier(R("hi")));                              // clearly small
        Assert.False(AiModelRouter.NeedsClassifier(R("Analyze why the Atlas project is late and recommend a fix")));   // clearly deep
        Assert.False(AiModelRouter.NeedsClassifier(R("Summarise our portfolio", AiMode.Deep)));   // the person chose
        Assert.False(AiModelRouter.NeedsClassifier(R("Summarise our portfolio", p: AiTier.Quick))); // nothing higher to pick
    }

    [Fact]
    public void The_classifiers_answer_decides_an_undecided_question()
    {
        Assert.Equal(AiTier.Deep, Route("Summarise our portfolio", classified: AiTier.Deep).Tier);
        Assert.Equal(AiTier.Quick, Route("Summarise our portfolio", classified: AiTier.Quick).Tier);
        Assert.Equal(AiTier.Standard, Route("Summarise our portfolio").Tier);   // no classifier answer: the middle level
        Assert.True(Route("Summarise our portfolio", classified: AiTier.Deep).Classified);
    }

    [Theory]
    [InlineData("deep", AiTier.Deep)]
    [InlineData("Quick.", AiTier.Quick)]
    [InlineData("  standard\n", AiTier.Standard)]
    [InlineData("I would say deep, not quick", AiTier.Deep)]
    [InlineData("", null)]
    [InlineData("banana", null)]
    public void The_classifiers_answer_is_read_leniently(string answer, AiTier? expected) => Assert.Equal(expected, AiModelRouter.ParseClassifier(answer));
}
