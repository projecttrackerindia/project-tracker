using System.Text.Json;
using ProjectManagement.Application.Features.Ai;

namespace ProjectManagement.Tests;
public sealed class AiPlatformUnitTests
{
    [Fact]
    public async Task Database_counters_isolate_parallel_scopes_and_aggregate_nested_operations()
    {
        var counters = new AiDatabaseTelemetry();
        using var parent = counters.Begin();
        await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => Task.Run(() =>
        {
            using var child = counters.Begin(); counters.Record(TimeSpan.FromMilliseconds(2));
            Assert.Equal(1, child.Snapshot().Commands);
        })));
        Assert.Equal(8, parent.Snapshot().Commands); Assert.Equal(16, parent.Snapshot().DurationMs);
        counters.Record(TimeSpan.FromMilliseconds(1), true); Assert.Equal(1, parent.Snapshot().FailedCommands);
    }
    [Theory]
    [InlineData("{\"recipient\":123,\"body\":\"Hi\"}")]
    [InlineData("{\"body\":\"Hi\"}")]
    [InlineData("{\"recipient\":\"Siva Reddy\",\"body\":null}")]
    public void Schema_validation_rejects_invalid_types_or_required_fields(string input)
    {
        var tool = new AiToolDef("send", "", """{"type":"object","properties":{"recipient":{"type":"string"},"body":{"type":"string"}},"required":["recipient","body"]}""");
        using var arguments = JsonDocument.Parse(input); Assert.NotNull(AiToolInputValidator.Validate(tool, arguments.RootElement));
    }
    [Theory]
    [InlineData("rename project ATLAS to Launch", "rename_project")]
    [InlineData("assign ATLAS-12 to Siva Reddy", "assign_task")]
    [InlineData("mark ATLAS-12 as Done", "update_task_status")]
    [InlineData("list people", "list_people")]
    public void Typed_planner_recognizes_known_single_commands(string text, string expected) => Assert.Equal(expected, AiCommandPlanner.ParseSimple(text)!.Value.Intent);
    [Fact]
    public void Planner_preserves_multi_step_requests_for_the_reasoning_agent() => Assert.Null(AiCommandPlanner.ParseSimple("Rename project ATLAS to Launch and assign ATLAS-12 to Siva Reddy"));
    [Fact]
    public void Complete_failure_is_distinct_from_partial_success()
    {
        var action = new AiProposal("one", "send_message", "", "", "{}");
        Assert.Equal("failed", AiActionPlan.Outcome([action with { Status = "failed" }]));
        Assert.Equal("partial", AiActionPlan.Outcome([action with { Status = "failed" }, action with { Id = "two", Status = "done" }]));
    }
    [Fact]
    public void Schema_choice_errors_retain_actionable_business_choices()
    {
        var tool = new AiToolDef("invite", "", """{"type":"object","properties":{"role":{"type":"string","enum":["Guest","Member","Manager"]}},"required":["role"]}""");
        using var input = JsonDocument.Parse("""{"role":"Owner"}""");
        Assert.Contains("Guest, Member or Manager", AiToolInputValidator.Validate(tool, input.RootElement));
    }

}
