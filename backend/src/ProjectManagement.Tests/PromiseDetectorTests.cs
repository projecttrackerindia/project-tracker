using ProjectManagement.Application.Features.Reminders;

namespace ProjectManagement.Tests;

/// <summary>Promises found in what people write, and when to remind them (the writer's local time, their usual reminder time 09:00).</summary>
public class PromiseDetectorTests
{
    // Wednesday 21 October 2026, 10:00.
    private static readonly DateTime Now = new(2026, 10, 21, 10, 0, 0);
    private static readonly TimeOnly Usual = new(9, 0);

    private static Promise One(string text) => Assert.Single(PromiseDetector.Find(text, Now, Usual));

    [Theory]
    [InlineData("Sure, I'll send the estimate by Friday.", "Send the estimate", "2026-10-23 09:00")]
    [InlineData("Will share the deck tomorrow", "Share the deck", "2026-10-22 09:00")]
    [InlineData("Let me check and revert by EOD", "Check and revert", "2026-10-21 16:00")]
    [InlineData("Ravi, I'll share the deck next Monday", "Share the deck", "2026-10-26 09:00")]
    [InlineData("I'll call the bank in 2 hours", "Call the bank", "2026-10-21 11:30")]
    [InlineData("I will submit the invoice on 5 November", "Submit the invoice", "2026-11-05 09:00")]
    [InlineData("I'll finish the review by Wednesday", "Finish the review", "2026-10-21 11:00")]   // due today, the morning has passed
    [InlineData("I'm going to update the runbook next week", "Update the runbook", "2026-10-26 09:00")]
    [InlineData("Report kal tak bhej dunga", "Report bhej dunga", "2026-10-22 09:00")]            // Hindi
    [InlineData("Repu report pampistanu", "Report pampistanu", "2026-10-22 09:00")]              // Telugu
    public void A_promise_with_a_time_becomes_a_reminder_for_the_morning_it_is_due(string text, string title, string at)
    {
        var p = One(text);
        Assert.Equal(title, p.Title);
        Assert.Equal(at, p.LocalAt.ToString("yyyy-MM-dd HH:mm"));
        Assert.Equal(text.Trim(), p.Quote);
    }

    [Theory]
    [InlineData("Can you send the estimate by Friday?")]        // a question
    [InlineData("I won't be able to do it tomorrow")]           // a refusal
    [InlineData("I can't send it today")]
    [InlineData("Nice work today, team")]                        // no promise
    [InlineData("I'll look into it")]                            // no time
    [InlineData("")]
    public void Questions_refusals_and_promises_without_a_time_are_not_reminders(string text) =>
        Assert.Empty(PromiseDetector.Find(text, Now, Usual));

    [Fact]
    public void Several_promises_in_one_message_each_count_up_to_three()
    {
        var all = PromiseDetector.Find("I'll send the draft tomorrow. Also I will call Meena on Friday. Thanks!", Now, Usual);
        Assert.Equal(2, all.Count);
        Assert.Equal("Send the draft", all[0].Title);
        Assert.Equal("Call Meena", all[1].Title);
        Assert.True(PromiseDetector.Find(string.Join(". ", Enumerable.Repeat("I'll do it tomorrow", 6)), Now, Usual).Count <= 3);
    }

    [Fact]
    public void Only_the_writers_own_words_count_in_an_email_reply()
    {
        const string mail = "Thanks Ravi, I'll send the signed copy tomorrow.\n\n-- \nPriya\n\nOn Tue, 20 Oct 2026, Ravi wrote:\n> I will pay the invoice on Friday.\n";
        var own = PromiseDetector.OwnWords(mail);
        Assert.DoesNotContain("pay the invoice", own);
        Assert.Equal("Send the signed copy", One(own).Title);
        Assert.Empty(PromiseDetector.Find(PromiseDetector.OwnWords("Noted.\n> I'll call you tomorrow"), Now, Usual));
    }

    [Theory]
    [InlineData("2026-10-27", "2026-10-27 09:00")]
    [InlineData("Friday", "2026-10-23 09:00")]
    [InlineData("by next Monday", "2026-10-26 09:00")]
    [InlineData("tomorrow", "2026-10-22 09:00")]
    [InlineData("5 Nov", "2026-11-05 09:00")]
    public void A_due_date_as_said_in_a_meeting_is_read(string said, string at) =>
        Assert.Equal(at, PromiseDetector.DueFrom(said, Now, Usual)?.ToString("yyyy-MM-dd HH:mm"));

    [Theory]
    [InlineData("2026-10-01")]
    [InlineData("soon")]
    [InlineData(null)]
    public void A_past_or_vague_due_date_is_not(string? said) => Assert.Null(PromiseDetector.DueFrom(said, Now, Usual));

    [Fact]
    public void Late_in_the_evening_a_today_promise_is_not_offered()
    {
        Assert.Empty(PromiseDetector.Find("I'll send it today", new DateTime(2026, 10, 21, 22, 0, 0), Usual));
    }
}
