using System.Reflection;
using ProjectManagement.Application.Features.Ai;

namespace ProjectManagement.Tests;

/// <summary>
/// "No tool, no ship": every area of the app that people use has at least one assistant tool, so the assistant never has to say it cannot reach
/// a screen. When a new area ships, add its row here together with its tool (reading and, where people change things, proposing).
/// </summary>
public class AiToolCoverageTests
{
    private static HashSet<string> AllToolNames() =>
        new[] { typeof(AiToolbox), typeof(AiPowerTools), typeof(AiWorkdayTools), typeof(AiHomeTools) }
            .SelectMany(t => t.GetFields(BindingFlags.Public | BindingFlags.Static | BindingFlags.FlattenHierarchy))
            .Where(f => f.IsLiteral && f.FieldType == typeof(string) && f.GetRawConstantValue() is string s && s.Length > 2 && s.All(c => char.IsLower(c) || c == '_'))
            .Select(f => (string)f.GetRawConstantValue()!).ToHashSet();

    [Theory]
    [InlineData("Load page: who has room", "team_load")]
    [InlineData("Load-aware assigning", "who_has_room")]
    [InlineData("Load-aware assigning (change)", "propose_reassign_by_load")]
    [InlineData("Stages as the project journey", "project_stages")]
    [InlineData("Stages: move on", "propose_advance_stage")]
    [InlineData("Stages: owners", "propose_reassign_stage")]
    [InlineData("Calendar and agenda", "my_schedule")]
    [InlineData("Project meetings", "list_project_meetings")]
    [InlineData("Time entries", "list_my_time_entries")]
    [InlineData("Approvals", "list_my_approvals")]
    [InlineData("Reminders", "list_reminders")]
    [InlineData("Mail", "mail_inbox")]
    [InlineData("Vault", "vault_find")]
    [InlineData("Documents", "search_documents")]
    [InlineData("Forecast and portfolio", "portfolio_brief")]
    [InlineData("Why is it late", "why_late")]
    public void Every_area_has_an_assistant_tool(string area, string tool) =>
        Assert.True(AllToolNames().Contains(tool), $"{area}: the assistant has no tool named {tool}.");

    [Fact]
    public void Load_and_stage_changes_are_proposals_the_person_confirms()
    {
        foreach (var t in new[] { AiPowerTools.ReassignByLoad, AiPowerTools.AdvanceStage, AiPowerTools.ReassignStage }) Assert.Contains(t, AiPowerTools.WriteTools);
        foreach (var t in new[] { AiPowerTools.TeamLoad, AiPowerTools.WhoHasRoom, AiPowerTools.ProjectStagesRead }) Assert.Contains(t, AiPowerTools.ReadTools);
        foreach (var k in new[] { "reassign_by_load", "advance_stage", "reassign_stage" }) Assert.Contains(k, AiPowerTools.Kinds);
    }
}
