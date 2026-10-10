using ProjectManagement.Application.Features.Ai;
namespace ProjectManagement.Tests;
public sealed class AiIntentMatchingTests
{
    [Theory]
    [InlineData("hey hi")]
    [InlineData("Hi, hello!")]
    [InlineData("hey hi how are you?")]
    public void Compound_greetings_do_not_require_inference(string text) => Assert.True(AiToolbox.IsGreeting(text));

    [Theory]
    [InlineData("hi, show overdue tasks")]
    [InlineData("hey assign this to Siva")]
    [InlineData("thanks for creating the project")]
    public void Business_requests_are_not_swallowed_by_greeting_matching(string text) => Assert.False(AiToolbox.IsGreeting(text));
    [Theory]
    [InlineData("sivareddy")]
    [InlineData("SIVA-REDDY")]
    [InlineData("sivaredy")]
    public void Normalization_and_one_edit_match_existing_members(string query) =>
        Assert.Equal([0], AiPersonMatching.Match(query, [("Siva Reddy", "siva@example.com"), ("Prasanna", "p@example.com")]));
    [Fact]
    public void Close_candidates_require_clarification() =>
        Assert.Equal(2, AiPersonMatching.Match("sivareddx", [("Siva Reddy", "one@example.com"), ("Siva Reddi", "two@example.com")]).Count);
    [Fact]
    public void Emails_and_short_names_are_never_typo_guessed()
    {
        Assert.Empty(AiPersonMatching.Match("siva@exampel.com", [("Siva Reddy", "siva@example.com")]));
        Assert.Empty(AiPersonMatching.Match("Sva", [("Siva", "siva@example.com")]));
    }
    [Theory]
    [InlineData("yes but don't send")]
    [InlineData("confirm sending the message to someone else")]
    [InlineData("did you confirm sending the message?")]
    public void Conditional_or_different_confirmations_are_not_approval(string text) => Assert.False(AiMessageCommands.IsConfirmation(text));
    [Fact]
    public void Compound_task_requests_are_not_cut_short() => Assert.Null(AiReadCommands.Tasks("show tasks for Siva Reddy and send him Hi"));
}
