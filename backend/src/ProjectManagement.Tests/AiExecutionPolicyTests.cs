using System.Text.Json;
using ProjectManagement.Application.Features.Ai;

namespace ProjectManagement.Tests;

public class AiExecutionPolicyTests
{
    [Theory]
    [InlineData("Why can't we update the eight stages?", AiRequestIntent.Analyze, true)]
    [InlineData("How do we update the project?", AiRequestIntent.Ask, true)]
    [InlineData("Recommend a better timeline", AiRequestIntent.Recommend, true)]
    [InlineData("Update Atlas start date to 2030-01-03", AiRequestIntent.Execute, false)]
    [InlineData("Update Atlas start date to 2030-01-03 and explain what changed", AiRequestIntent.Combined, false)]
    public void Intent_separates_questions_and_recommendations_from_requested_changes(string text, AiRequestIntent intent, bool readOnly)
    {
        Assert.Equal(intent, AiExecutionPolicy.Classify(text)); Assert.Equal(readOnly, AiExecutionPolicy.IsReadOnlyRequest(text));
    }

    private static AiProposal Project(object? payload = null) => new("p", "update_project", "Update Atlas", "", JsonSerializer.Serialize(payload ?? new { key = "ATL", projectName = "Atlas" }));

    [Theory]
    [InlineData("Update Atlas start date to 2030-01-03", true)]
    [InlineData("Please update project Atlas start date to 03-01-2030 and explain what changed", true)]
    [InlineData("Can you update Atlas start date to 3 Jan 2030?", true)]
    [InlineData("How can we update Atlas start date to 2030-01-03?", false)]
    [InlineData("Update Atlas due date to 2030-01-03", false)]
    [InlineData("Update Borealis start date to 2030-01-03", false)]
    [InlineData("Update Atlas start date to 2030-01-04", false)]
    [InlineData("Update Atlas start date to 2030-01-03 after confirmation", false)]
    [InlineData("Update Atlas start date to 2030-01-03, don't save yet", false)]
    [InlineData("Preview: Update Atlas start date to 2030-01-03", false)]
    [InlineData("Update Atlas start date to 2030-01-03 and update Borealis start date to 2030-02-01", false)]
    [InlineData("Update Atlas start date to 2030-01-03 if the sponsor agrees", false)]
    [InlineData("Update Atlas start date to 2030-01-03, but wait for approval", false)]
    public void Only_explicit_matching_date_edits_are_authorized(string text, bool expected)
    {
        var input = JsonSerializer.Serialize(new { project = "Atlas", start_date = "2030-01-03" });
        Assert.Equal(expected, AiExecutionPolicy.CanAutoExecute(text, AiToolbox.UpdateProject, input, Project(), false));
    }

    [Fact]
    public void Model_arguments_cannot_add_status_changes_invent_a_reason_or_use_attachment_authority()
    {
        const string text = "Update Atlas start date to 2030-01-03 because approved kickoff";
        Assert.False(AiExecutionPolicy.CanAutoExecute(text, AiToolbox.UpdateProject, JsonSerializer.Serialize(new { project = "Atlas", start_date = "2030-01-03", status = "Completed" }), Project(), false));
        Assert.False(AiExecutionPolicy.CanAutoExecute(text, AiToolbox.UpdateProject, JsonSerializer.Serialize(new { project = "Atlas", start_date = "2030-01-03", reason = "Unrequested scope increase" }), Project(), false));
        Assert.False(AiExecutionPolicy.CanAutoExecute(text, AiToolbox.UpdateProject, JsonSerializer.Serialize(new { project = "Atlas", start_date = "2030-01-03" }), Project(), true));
        Assert.False(AiExecutionPolicy.CanAutoExecute(text, AiToolbox.UpdateProject, JsonSerializer.Serialize(new { project = "Atlas", start_date = "2030-01-03" }), Project(new { key = "BOR", projectName = "Borealis" }), false));
    }
}
