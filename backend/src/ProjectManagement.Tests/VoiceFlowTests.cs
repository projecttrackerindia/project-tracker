using ProjectManagement.Application.Features.Voice;

namespace ProjectManagement.Tests;

/// <summary>The voice tool flow: inputs checked first, identity verified by the system, branches, follow-on calls, and only chosen facts spoken.</summary>
public class VoiceFlowTests
{
    private const string Loan = """{"loan":{"id":"LN-778","number":"1234567890","status":"OVERDUE","outstanding":124999.5,"nextDue":"2026-11-05"},"customer":{"name":"Ravi","dob":"1990-04-12","pan":"ABCDE1234F"}}""";
    private const string Emi = """{"items":[{"amount":4850,"due":"2026-11-05"},{"amount":4850,"due":"2026-12-05"}]}""";

    private static VoiceFlow Flow() => new()
    {
        Inputs = [new() { Name = "loanNumber", Label = "Loan number", Type = "digits" }, new() { Name = "dob", Label = "Date of birth", Type = "date" }],
        RequiresVerifiedCaller = true,
        Steps =
        [
            new() { Type = "verify", Path = "main.customer.dob", Input = "dob", Compare = "date" },
            new() { Type = "chain", Connector = "emi_schedule", As = "emi", Args = new() { ["loanId"] = "main.loan.id" } },
            new() { Type = "branch", Path = "main.loan.status", Op = "eq", Value = "OVERDUE", Action = "say", Text = "Your account shows an overdue payment." },
        ],
        Fields =
        [
            new() { Key = "balance", Path = "main.loan.outstanding", Format = "inr" },
            new() { Key = "emiAmount", Path = "emi.items[0].amount", Format = "inr" },
            new() { Key = "emiDate", Path = "emi.items[0].due", Format = "date" },
            new() { Key = "loan", Path = "main.loan.number", Format = "mask4" },
        ],
        Templates = new() { ["en"] = "For loan {loan}, the balance is {balance}; the next EMI of {emiAmount} is due on {emiDate}." },
    };

    private static VoiceFlowRunner.CallApi Api(List<(string, IReadOnlyDictionary<string, string>)>? calls = null) => (name, args, _) =>
    {
        calls?.Add((name, args));
        return Task.FromResult(name == "emi_schedule" ? Emi : Loan);
    };

    [Fact]
    public async Task A_matching_caller_gets_only_the_chosen_facts_formatted_for_speech()
    {
        var calls = new List<(string, IReadOnlyDictionary<string, string>)>();
        var r = await VoiceFlowRunner.RunAsync(Flow(), new Dictionary<string, string> { ["loanNumber"] = "12345 67890", ["dob"] = "12/04/1990" }, "loan_details", false, "en", Api(calls), default);

        Assert.True(r.Ok);
        Assert.True(r.VerifiedNow);
        Assert.Equal("₹1,24,999.50", r.Facts["balance"]);
        Assert.Equal("₹4,850", r.Facts["emiAmount"]);
        Assert.Equal("5 November 2026", r.Facts["emiDate"]);
        Assert.Equal("ending 7890", r.Facts["loan"]);
        Assert.Equal("Your account shows an overdue payment. For loan ending 7890, the balance is ₹1,24,999.50; the next EMI of ₹4,850 is due on 5 November 2026.", r.Say);
        // The follow-on call got the id from the first answer, and the caller's digits were cleaned first.
        Assert.Equal("LN-778", calls.Single(c => c.Item1 == "emi_schedule").Item2["loanId"]);
        Assert.Equal("1234567890", calls.Single(c => c.Item1 == "loan_details").Item2["loanNumber"]);
        // What the agent sees never includes fields nobody chose (the PAN is in the raw answer only).
        Assert.DoesNotContain("ABCDE1234F", r.ForAgent());
        Assert.Contains("ABCDE1234F", r.Raw["main"]);
    }

    [Fact]
    public async Task A_wrong_date_of_birth_shares_nothing()
    {
        var r = await VoiceFlowRunner.RunAsync(Flow(), new Dictionary<string, string> { ["loanNumber"] = "1234567890", ["dob"] = "1991-04-12" }, "loan_details", false, "en", Api(), default);
        Assert.False(r.VerifiedNow);
        Assert.Empty(r.Facts);
        Assert.Equal("stop", r.Action);
        Assert.Contains(r.Trace, t => t.Status == "failed");
    }

    [Fact]
    public async Task Missing_or_invalid_inputs_are_asked_for_before_any_call()
    {
        var calls = new List<(string, IReadOnlyDictionary<string, string>)>();
        var r = await VoiceFlowRunner.RunAsync(Flow(), new Dictionary<string, string> { ["loanNumber"] = "abc" }, "loan_details", false, "en", Api(calls), default);
        Assert.False(r.Ok);
        Assert.Equal("ask", r.Action);
        Assert.Contains("loan number", r.Error);
        Assert.Empty(calls);
    }

    [Fact]
    public async Task A_branch_can_raise_a_ticket_or_stop_and_samples_replace_real_calls()
    {
        var f = Flow();
        f.Steps.Insert(0, new() { Type = "branch", Path = "main.loan.outstanding", Op = "gt", Value = "100000", Action = "ticket", Text = "High balance review", Priority = "High" });
        f.Samples["main"] = Loan; f.Samples["emi"] = Emi;
        var r = await VoiceFlowRunner.RunAsync(f, new Dictionary<string, string> { ["loanNumber"] = "1234567890", ["dob"] = "1990-04-12" }, "loan_details", false, "en",
            (_, _, _) => throw new InvalidOperationException("must not call"), default, f.Samples);
        Assert.Equal("ticket", r.Action);
        Assert.Equal("High", r.Priority);
        Assert.NotEmpty(r.Facts);

        f.Steps.Insert(0, new() { Type = "branch", Path = "main.loan.status", Op = "eq", Value = "overdue", Action = "stop", Text = "Please speak to the collections team." });
        var stopped = await VoiceFlowRunner.RunAsync(f, new Dictionary<string, string> { ["loanNumber"] = "1234567890", ["dob"] = "1990-04-12" }, "loan_details", true, "en", Api(), default, f.Samples);
        Assert.Equal("stop", stopped.Action);
        Assert.Empty(stopped.Facts);
    }

    [Fact]
    public void Validation_explains_every_problem_in_plain_words()
    {
        var f = new VoiceFlow
        {
            Inputs = [new() { Name = "1bad", Type = "text" }],
            Steps = [new() { Type = "chain", Connector = "missing", As = "x" }, new() { Type = "branch", Path = "main.a", Op = "eq", Action = "say" }],
            Fields = [new() { Key = "balance", Path = "main.b", Format = "inr" }],
            Templates = new() { ["en"] = "{balance} and {unknown}" },
        };
        var problems = VoiceFlowRunner.Validate(f, ["loanNumber"], ["emi_schedule"]);
        Assert.Contains(problems, p => p.Contains("1bad"));
        Assert.Contains(problems, p => p.Contains("{loanNumber}"));
        Assert.Contains(problems, p => p.Contains("another API"));
        Assert.Contains(problems, p => p.Contains("what to say"));
        Assert.Contains(problems, p => p.Contains("{unknown}"));
        Assert.Empty(VoiceFlowRunner.Validate(Flow(), ["loanNumber"], ["emi_schedule"]));
    }
}
