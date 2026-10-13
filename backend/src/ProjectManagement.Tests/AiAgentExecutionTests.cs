using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

public partial class AiWorkspaceTests
{
    [Fact]
    public async Task A_question_about_stage_updates_cannot_be_turned_into_an_unrequested_write()
    {
        var o = await Setup(); EnableAutomaticSchedule(o);
        var before = factory.WithDb(db => db.Projects.IgnoreQueryFilters().Single(p => p.Id == o.Project).Version);
        Chat.Script.Enqueue(request =>
        {
            Assert.DoesNotContain(request.Tools, t => AiToolbox.WriteTools.Contains(t.Name));
            Assert.Contains(request.Tools, t => t.Name == AiToolbox.ProjectReport);
            return FakeAiChat.UseTool(AiToolbox.UpdateProject, new { project = "Atlas", start_date = Iso(3), reason = "Made up" });
        });
        Chat.Script.Enqueue(_ => FakeAiChat.UseTool(AiToolbox.ProjectReport, new { project = "Atlas" }));
        Chat.Script.Enqueue(request =>
        {
            Assert.Contains("stageScheduleMode", string.Join(" ", request.Turns.SelectMany(t => t.Blocks).OfType<AiToolResult>().Select(t => t.Content)));
            return FakeAiChat.Say("Atlas already has automatic stage scheduling. Its planned dates follow recorded calendar-day allocations.");
        });
        var result = await Ask(o.Owner, "Why can't we update the eight stages in Atlas?", "standard");
        Assert.False(result.Has("action")); Assert.Contains("automatic stage scheduling", S(result.Done["content"]));
        Assert.Equal(before, factory.WithDb(db => db.Projects.IgnoreQueryFilters().Single(p => p.Id == o.Project).Version));
    }

    [Fact]
    public async Task Explicit_date_edit_executes_verifies_and_answers_combined_analysis_without_repeat_confirmation()
    {
        var o = await Setup(); EnableAutomaticSchedule(o);
        var due = factory.WithDb(db => db.Projects.IgnoreQueryFilters().Single(p => p.Id == o.Project).DueDate!.Value);
        const string reason = "Kickoff approved two days later";
        Chat.Script.Enqueue(_ => FakeAiChat.UseTool(AiToolbox.UpdateProject, new { project = "Atlas", start_date = Iso(2), reason }, "I will inspect the result."));
        Chat.Script.Enqueue(request =>
        {
            Assert.Contains("Saved and verified", string.Join(" ", request.Turns.SelectMany(t => t.Blocks).OfType<AiToolResult>().Select(t => t.Content)));
            return FakeAiChat.Say("The recorded allocations were preserved; the later kickoff moved the unfinished stage plans two days later.");
        });
        var text = $"Update Atlas start date to {Iso(2)} because {reason} and explain what changed.";
        var result = await Ask(o.Owner, text, "standard"); var card = result.Last("action")["action"]!;
        Assert.Equal("done", S(card["status"])); Assert.NotNull(card["lifecycle"]!["approvedAt"]);
        Assert.Contains("Saved and verified", S(result.Done["content"])); Assert.Contains("allocations were preserved", S(result.Done["content"]));
        Assert.DoesNotContain("Awaiting confirmation", S(result.Done["content"]));
        Assert.Equal(due.AddDays(2), factory.WithDb(db => db.Projects.IgnoreQueryFilters().Single(p => p.Id == o.Project).DueDate));
        var version = factory.WithDb(db => db.Projects.IgnoreQueryFilters().Single(p => p.Id == o.Project).Version);
        Chat.Script.Enqueue(_ => FakeAiChat.UseTool(AiToolbox.UpdateProject, new { project = "Atlas", start_date = Iso(2), reason }));
        Chat.Script.Enqueue(_ => FakeAiChat.Say("Those values are saved."));
        var repeated = await Ask(o.Owner, text, "standard", result.Conversation);
        Assert.False(repeated.Has("action")); Assert.Contains("No change needed", S(repeated.Done["content"]));
        Assert.DoesNotContain("No action was completed", S(repeated.Done["content"]));
        Assert.Equal(version, factory.WithDb(db => db.Projects.IgnoreQueryFilters().Single(p => p.Id == o.Project).Version));
    }

    [Fact]
    public async Task Explicit_stage_allocation_executes_using_the_same_downstream_engine()
    {
        var o = await Setup(); var stageId = EnableAutomaticSchedule(o);
        var stageName = factory.WithDb(db => db.ProjectStages.IgnoreQueryFilters().Single(s => s.Id == stageId).Name);
        var due = factory.WithDb(db => db.Projects.IgnoreQueryFilters().Single(p => p.Id == o.Project).DueDate!.Value);
        Chat.Script.Enqueue(_ => FakeAiChat.UseTool(AiToolbox.UpdateStagePlan, new { project = "Atlas", stage = stageName, duration_days = 4, reason = "Additional design approved" }));
        Chat.Script.Enqueue(_ => FakeAiChat.Say("The allocation is saved."));
        var result = await Ask(o.Owner, $"Update Atlas stage {stageName} duration to 4 days because Additional design approved", "standard");
        Assert.Equal("done", S(result.Last("action")["action"]!["status"]));
        Assert.Equal(4, factory.WithDb(db => db.ProjectStages.IgnoreQueryFilters().Single(s => s.Id == stageId).DurationDays));
        Assert.Equal(due.AddDays(2), factory.WithDb(db => db.Projects.IgnoreQueryFilters().Single(p => p.Id == o.Project).DueDate));
    }

    [Fact]
    public async Task Whole_project_scheduling_previews_every_stage_once_and_verifies_the_confirmed_plan()
    {
        var o = await Setup(); EnableAutomaticSchedule(o);
        factory.WithDb(db => { db.Projects.IgnoreQueryFilters().Where(p => p.Id == o.Project).ExecuteUpdate(s => s.SetProperty(p => p.StageScheduleMode, StageScheduleMode.Manual)); return 0; });
        Chat.Script.Enqueue(_ => FakeAiChat.UseTool(AiToolbox.ScheduleProject, new { project = "Atlas" }));
        Chat.Script.Enqueue(_ => FakeAiChat.Say("Review all stage dates."));
        var first = await Ask(o.Owner, "Enable automatic scheduling for all Atlas stages", "standard"); var card = first.Last("action")["action"]!;
        Assert.Equal("proposed", S(card["status"]));
        var count = factory.WithDb(db => db.ProjectStages.IgnoreQueryFilters().Count(s => s.ProjectId == o.Project));
        Assert.Contains($"{count} stages", S(card["summary"]));
        Assert.Equal(StageScheduleMode.Manual, factory.WithDb(db => db.Projects.IgnoreQueryFilters().Single(p => p.Id == o.Project).StageScheduleMode));
        Chat.Script.Enqueue(_ => FakeAiChat.UseTool(AiToolbox.ScheduleProject, new { project = "Atlas" }));
        Chat.Script.Enqueue(_ => FakeAiChat.Say("Use the existing card."));
        var repeat = await Ask(o.Owner, "Enable automatic scheduling for all Atlas stages", "standard", first.Conversation);
        Assert.False(repeat.Has("action"));
        Assert.Contains("no duplicate proposal", string.Join(" ", Chat.Requests.Last().Turns.SelectMany(t => t.Blocks).OfType<AiToolResult>().Select(t => t.Content)));
        var confirmed = await o.Owner.Post($"/api/v1/ai/messages/{S(first.Done["id"])}/actions/{S(card["id"])}/confirm");
        Assert.Equal("done", S(confirmed.Data!["status"]));
        Assert.Equal(StageScheduleMode.FollowSchedule, factory.WithDb(db => db.Projects.IgnoreQueryFilters().Single(p => p.Id == o.Project).StageScheduleMode));
        Assert.Contains("No change needed", await RunTool(o.Owner, AiToolbox.ScheduleProject, new { project = "Atlas" }, "Schedule all Atlas stages"));
        Assert.Contains("does not allow", await RunTool(o.Guest, AiToolbox.ScheduleProject, new { project = "Atlas" }, "Schedule all Atlas stages"));
    }
}
