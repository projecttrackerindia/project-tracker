using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

public partial class AiWorkspaceTests
{
    private Guid EnableAutomaticSchedule(Org o) => factory.WithDb(db =>
    {
        var p = db.Projects.IgnoreQueryFilters().Single(p => p.Id == o.Project);
        var stages = db.ProjectStages.IgnoreQueryFilters().Where(s => s.ProjectId == o.Project).OrderBy(s => s.Order).ToList();
        var cursor = DateOnly.Parse(Iso(0));
        foreach (var s in stages)
        {
            s.DurationDays = s.Order == 0 ? 0 : s.Order == 1 ? 2 : 1;
            s.PlannedStart = cursor; s.PlannedEnd = cursor.AddDays(s.DurationDays.Value); cursor = s.PlannedEnd.Value;
            s.Status = s.Order == 0 ? StageStatus.Completed : StageStatus.Pending;
        }
        p.StartDate = DateOnly.Parse(Iso(0)); p.DueDate = cursor; p.StageScheduleMode = StageScheduleMode.FollowSchedule;
        db.SaveChanges(); return stages[1].Id;
    });

    [Fact]
    public async Task Agent_project_date_card_previews_and_verifies_automatic_downstream_dates()
    {
        var o = await Setup(); EnableAutomaticSchedule(o);
        var before = factory.WithDb(db => db.Projects.IgnoreQueryFilters().Single(p => p.Id == o.Project).DueDate!.Value);
        Chat.Script.Enqueue(_ => FakeAiChat.UseTool("propose_update_project", new { project = "Atlas", start_date = Iso(2), reason = "Kickoff approved two days later" }));
        Chat.Script.Enqueue(_ => FakeAiChat.Say("Review the connected timeline."));
        var result = await Ask(o.Owner, "Move the project kickoff two days later", "standard"); var card = result.Last("action")["action"]!;
        Assert.Contains("stage plans recalculated", S(card["summary"])); Assert.Contains(before.AddDays(2).ToString("yyyy-MM-dd"), S(card["preview"]));
        Assert.Equal(before, factory.WithDb(db => db.Projects.IgnoreQueryFilters().Single(p => p.Id == o.Project).DueDate));
        var confirmed = await o.Owner.Post($"/api/v1/ai/messages/{S(result.Done["id"])}/actions/{S(card["id"])}/confirm");
        Assert.Equal("done", S(confirmed.Data!["status"]));
        Assert.Equal(before.AddDays(2), factory.WithDb(db => db.Projects.IgnoreQueryFilters().Single(p => p.Id == o.Project).DueDate));
        Assert.Equal(DateOnly.Parse(Iso(2)), factory.WithDb(db => db.ProjectStages.IgnoreQueryFilters().Where(s => s.ProjectId == o.Project && s.Order == 1).Single().PlannedStart));
    }

    [Fact]
    public async Task Agent_duration_card_moves_successors_and_requires_an_extension_reason()
    {
        var o = await Setup(); var stage = EnableAutomaticSchedule(o);
        var before = factory.WithDb(db => db.Projects.IgnoreQueryFilters().Single(p => p.Id == o.Project).DueDate!.Value);
        Assert.Contains("needs a reason", await RunTool(o.Owner, "propose_update_stage_dates", new { project = "Atlas", stage = stage.ToString(), duration_days = 4 }));
        Chat.Script.Enqueue(_ => FakeAiChat.UseTool("propose_update_stage_dates", new { project = "Atlas", stage = stage.ToString(), duration_days = 4, reason = "Extra review agreed" }));
        Chat.Script.Enqueue(_ => FakeAiChat.Say("Please confirm the new allocation."));
        var result = await Ask(o.Owner, "Allocate four days to this stage", "standard"); var card = result.Last("action")["action"]!;
        Assert.Contains("stage plans recalculated", S(card["summary"])); Assert.Contains("4 calendar days", S(card["preview"]));
        var confirmed = await o.Owner.Post($"/api/v1/ai/messages/{S(result.Done["id"])}/actions/{S(card["id"])}/confirm");
        Assert.Equal("done", S(confirmed.Data!["status"]));
        Assert.Equal(before.AddDays(2), factory.WithDb(db => db.Projects.IgnoreQueryFilters().Single(p => p.Id == o.Project).DueDate));
        Assert.Equal(4, factory.WithDb(db => db.ProjectStages.IgnoreQueryFilters().Single(s => s.Id == stage).DurationDays));
        Assert.Equal(DateOnly.Parse(Iso(4)), factory.WithDb(db => db.ProjectStages.IgnoreQueryFilters().Single(s => s.ProjectId == o.Project && s.Order == 2).PlannedStart));
    }

    [Fact]
    public async Task A_stage_card_cannot_apply_over_a_newer_automatic_project_schedule()
    {
        var o = await Setup(); var stage = EnableAutomaticSchedule(o);
        Chat.Script.Enqueue(_ => FakeAiChat.UseTool("propose_update_stage_dates", new { project = "Atlas", stage = stage.ToString(), duration_days = 3, reason = "Additional review" }));
        Chat.Script.Enqueue(_ => FakeAiChat.Say("Prepared."));
        var result = await Ask(o.Owner, "Change the allocation", "standard"); var card = result.Last("action")["action"]!;
        factory.WithDb(db => { var p = db.Projects.IgnoreQueryFilters().Single(p => p.Id == o.Project); p.Version++; db.SaveChanges(); return 0; });
        var confirmed = await o.Owner.Post($"/api/v1/ai/messages/{S(result.Done["id"])}/actions/{S(card["id"])}/confirm");
        Assert.Equal("failed", S(confirmed.Data!["status"]));
        Assert.Equal(2, factory.WithDb(db => db.ProjectStages.IgnoreQueryFilters().Single(s => s.Id == stage).DurationDays));
    }

    [Fact]
    public async Task A_rejected_agent_schedule_does_not_persist_dirty_allocations_when_the_failure_card_is_saved()
    {
        var o = await Setup(); var stage = EnableAutomaticSchedule(o);
        Chat.Script.Enqueue(_ => FakeAiChat.UseTool("propose_update_stage_dates", new { project = "Atlas", stage = stage.ToString(), duration_days = 5, reason = "More design work" }));
        Chat.Script.Enqueue(_ => FakeAiChat.Say("Prepared."));
        var result = await Ask(o.Owner, "Extend design", "standard"); var card = result.Last("action")["action"]!;
        var due = factory.WithDb(db => db.Projects.IgnoreQueryFilters().Single(p => p.Id == o.Project).DueDate);
        factory.WithDb(db => { db.ProjectStages.IgnoreQueryFilters().Where(s => s.ProjectId == o.Project && s.Order == 2).ExecuteUpdate(s => s.SetProperty(x => x.Status, StageStatus.Completed)); return 0; });
        var confirmed = await o.Owner.Post($"/api/v1/ai/messages/{S(result.Done["id"])}/actions/{S(card["id"])}/confirm");
        Assert.Equal("failed", S(confirmed.Data!["status"])); Assert.Contains("overlap", S(confirmed.Data["error"]));
        Assert.Equal(2, factory.WithDb(db => db.ProjectStages.IgnoreQueryFilters().Single(s => s.Id == stage).DurationDays));
        Assert.Equal(due, factory.WithDb(db => db.Projects.IgnoreQueryFilters().Single(p => p.Id == o.Project).DueDate));
        Assert.Equal(DateOnly.Parse(Iso(2)), factory.WithDb(db => db.ProjectStages.IgnoreQueryFilters().Single(s => s.Id == stage).PlannedEnd));
    }
}
