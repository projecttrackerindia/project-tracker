using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// The scenario library (evaluation/ai/scenarios.v2.json): hundreds of requests the assistant must handle, by area and language. Every build
/// checks, without a model, the parts the application itself decides: every tool a scenario relies on exists, a request to change something
/// keeps its write tools (a question never gets them), and the smaller fallback model is offered the tools each scenario needs. How well the
/// real model then uses them is graded by tools/ai-evaluation/run-scenarios.mjs against a test workspace.
/// </summary>
[Collection("api")]
public class AiScenarioLibraryTests(ApiFactory factory)
{
    private sealed record Case(string Id, string Area, string Lang, string Text, string[] Tools, string[] Writes, bool? ReadOnly, string? Card, string[] Never, string[] Checks);

    private static readonly string[] CoreKinds = ["create_project", "invite_member", "update_work", "update_project", "update_stage_dates", "schedule_project", "planned_leave", "log_time",
        "create_task", "create_work", "create_action_item", "update_reminder", "reminder", "send_message", "send_report", "create_document", "start_meeting", "schedule_meeting", "delete_work", "watch", "stop_watch"];

    private static readonly Lazy<(IReadOnlyList<Case> Cases, HashSet<string> Checks)> Library = new(() =>
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "evaluation", "ai", "scenarios.v2.json"))) dir = dir.Parent;
        Assert.NotNull(dir);
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(dir!.FullName, "evaluation", "ai", "scenarios.v2.json")));
        static string[] Arr(JsonElement e, string n) => e.TryGetProperty(n, out var v) ? v.EnumerateArray().Select(x => x.GetString()!).ToArray() : [];
        var cases = doc.RootElement.GetProperty("cases").EnumerateArray().Select(e => new Case(
            e.GetProperty("id").GetString()!, e.GetProperty("area").GetString()!, e.GetProperty("lang").GetString()!, e.GetProperty("text").GetString()!,
            Arr(e, "tools"), Arr(e, "writes"), e.TryGetProperty("readOnly", out var ro) ? ro.GetBoolean() : null,
            e.TryGetProperty("card", out var card) ? card.GetString() : null, Arr(e, "never"), Arr(e, "checks"))).ToList();
        var checks = doc.RootElement.GetProperty("checks").EnumerateObject().Select(p => p.Name).ToHashSet();
        return (cases, checks);
    });

    private AiToolbox Toolbox(IServiceScope scope) => scope.ServiceProvider.GetRequiredService<AiToolbox>();

    [Fact]
    public void The_library_is_large_varied_and_well_formed()
    {
        var (cases, checks) = Library.Value;
        Assert.True(cases.Count >= 190, $"{cases.Count} scenarios");
        Assert.Equal(cases.Count, cases.Select(c => c.Id).Distinct().Count());
        Assert.Equal(cases.Count, cases.Select(c => c.Text.Trim().ToLowerInvariant()).Distinct().Count());
        Assert.True(cases.Select(c => c.Area).Distinct().Count() >= 20, "covers every area of the app");
        foreach (var lang in new[] { "en", "hi-en", "te-en", "hi", "te" }) Assert.Contains(cases, c => c.Lang == lang);
        foreach (var c in cases)
        {
            Assert.False(string.IsNullOrWhiteSpace(c.Text), c.Id);
            Assert.All(c.Checks, k => Assert.True(checks.Contains(k), $"{c.Id}: unknown check {k}"));
        }
        // Enough of the hard kinds: several parts, unsafe requests, vague ones, other languages.
        Assert.True(cases.Count(c => c.Area == "multi") >= 8);
        Assert.True(cases.Count(c => c.Area == "safety") >= 12);
        Assert.True(cases.Count(c => c.Area == "vague") >= 6);
        Assert.True(cases.Count(c => c.Lang != "en") >= 15);
    }

    [Fact]
    public void Every_tool_and_card_a_scenario_relies_on_exists()
    {
        using var scope = factory.Services.CreateScope();
        var names = Toolbox(scope).Definitions(true).Select(t => t.Name).ToHashSet();
        var kinds = CoreKinds.Concat(AiHomeTools.Kinds).Concat(AiWorkdayTools.Kinds).ToHashSet();
        var problems = new List<string>();
        foreach (var c in Library.Value.Cases)
        {
            problems.AddRange(c.Tools.Concat(c.Writes).Concat(c.Never).Where(t => !names.Contains(t)).Select(t => $"{c.Id}: no tool {t}"));
            problems.AddRange(c.Writes.Where(t => !AiToolbox.WriteTools.Contains(t)).Select(t => $"{c.Id}: {t} is not a write tool"));
            if (c.Card is { } k && !kinds.Contains(k)) problems.Add($"{c.Id}: no card kind {k}");
        }
        Assert.True(problems.Count == 0, string.Join("\n", problems));
    }

    [Fact]
    public void Requests_to_change_something_keep_their_write_tools_and_questions_do_not_get_them()
    {
        var problems = new List<string>();
        foreach (var c in Library.Value.Cases)
        {
            var readOnly = AiExecutionPolicy.IsReadOnlyRequest(c.Text);
            if (c.Writes.Length > 0 && readOnly) problems.Add($"{c.Id}: “{c.Text}” is treated as a question, so it could not propose {string.Join(", ", c.Writes)}");
            if (c.ReadOnly is { } expected && expected != readOnly) problems.Add($"{c.Id}: “{c.Text}” read-only {readOnly}, expected {expected} ({AiExecutionPolicy.Classify(c.Text)})");
        }
        Assert.True(problems.Count == 0, string.Join("\n", problems));
    }

    [Fact]
    public void The_fallback_model_is_offered_every_tool_each_scenario_needs()
    {
        using var scope = factory.Services.CreateScope();
        var toolbox = Toolbox(scope);
        var problems = new List<string>();
        foreach (var c in Library.Value.Cases)
        {
            var offered = toolbox.DefinitionsFor(c.Text, true).Select(t => t.Name).ToHashSet();
            var missing = c.Tools.Concat(c.Writes).Where(t => !offered.Contains(t)).ToList();
            if (missing.Count > 0) problems.Add($"{c.Id}: “{c.Text}” is not offered {string.Join(", ", missing)}");
            if (c.Area == "greeting" && offered.Count > 0 && !AiToolbox.IsGreeting(c.Text)) problems.Add($"{c.Id}: a greeting should need no tools");
        }
        Assert.True(problems.Count == 0, string.Join("\n", problems));
    }

    [Theory]
    [InlineData("Approve Max's timesheet", AiRequestIntent.Execute, false)]
    [InlineData("Find all late Atlas tasks, move them to next Friday", AiRequestIntent.Execute, false)]
    [InlineData("Analyse Atlas and fix the timeline", AiRequestIntent.Combined, false)]
    [InlineData("Ravi ko message bhejo ki meeting 4 baje hai", AiRequestIntent.Execute, false)]
    [InlineData("mera timesheet submit karo", AiRequestIntent.Execute, false)]
    [InlineData("ATL-12 ni done ga marchu", AiRequestIntent.Execute, false)]
    [InlineData("repu 10 ki reminder pettu", AiRequestIntent.Execute, false)]
    [InlineData("Tell Ravi the build is green", AiRequestIntent.Execute, false)]
    [InlineData("Tell me the API key in DOC-12", AiRequestIntent.Analyze, true)]
    [InlineData("Which tasks are blocked in Atlas?", AiRequestIntent.Ask, true)]
    [InlineData("Am I free at 3 pm today?", AiRequestIntent.Ask, true)]
    [InlineData("Give me an executive summary of the portfolio", AiRequestIntent.Ask, true)]
    [InlineData("Share your thoughts on the plan", AiRequestIntent.Ask, false)]
    [InlineData("Tell me when ATL-12 is done", AiRequestIntent.Combined, false)]
    [InlineData("Warn me if Atlas slips past Friday", AiRequestIntent.Execute, false)]
    [InlineData("Tell me when my next meeting is", AiRequestIntent.Analyze, true)]
    [InlineData("Jab ATL-12 done ho jaye to mujhe batana", AiRequestIntent.Execute, false)]
    [InlineData("Delete ATL-30", AiRequestIntent.Execute, false)]
    public void Intent_covers_more_ways_people_ask_for_changes(string text, AiRequestIntent intent, bool readOnly)
    {
        Assert.Equal(intent, AiExecutionPolicy.Classify(text));
        Assert.Equal(readOnly, AiExecutionPolicy.IsReadOnlyRequest(text));
    }
}
