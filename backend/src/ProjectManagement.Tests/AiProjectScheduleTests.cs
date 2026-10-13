using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

public partial class AiWorkspaceTests
{
    [Fact]
    public async Task Matching_project_dates_return_saved_values_without_a_confirmation_or_write()
    {
        var o = await Setup();
        factory.WithDb(db => { var p = db.Projects.IgnoreQueryFilters().Single(p => p.Id == o.Project); p.StartDate = DateOnly.Parse("2026-09-12"); p.DueDate = DateOnly.Parse("2026-12-20"); db.SaveChanges(); return 0; });
        var version = factory.WithDb(db => db.Projects.IgnoreQueryFilters().Single(p => p.Id == o.Project).Version);
        Chat.Script.Enqueue(_ => FakeAiChat.UseTool("propose_update_project", new { project = "Atlas", start_date = "2026-09-12", due_date = "2026-12-20" }));
        Chat.Script.Enqueue(_ => FakeAiChat.Say("Those project dates are already saved. Stage plans are separate."));
        var result = await Ask(o.Owner, "Update Atlas project dates from 12-09-2026 to 20-12-2026");
        Assert.False(result.Has("action"));
        Assert.Contains("No change needed", ToolResult());
        Assert.Contains("2026-09-12", ToolResult()); Assert.Contains("2026-12-20", ToolResult());
        Assert.Contains("Stage planned dates", ToolResult());
        Assert.Equal(version, factory.WithDb(db => db.Projects.IgnoreQueryFilters().Single(p => p.Id == o.Project).Version));
    }

    [Fact]
    public async Task Changed_project_dates_are_confirmed_saved_and_do_not_move_stage_plans()
    {
        var o = await Setup();
        var before = factory.WithDb(db => db.ProjectStages.IgnoreQueryFilters().Where(s => s.ProjectId == o.Project).OrderBy(s => s.Id).Select(s => new { s.Id, s.PlannedStart, s.PlannedEnd }).ToList());
        Chat.Script.Enqueue(_ => FakeAiChat.UseTool("propose_update_project", new { project = "Atlas", start_date = "2026-09-12", due_date = "2026-12-20", reason = "Revised delivery agreement" }));
        Chat.Script.Enqueue(_ => FakeAiChat.Say("Prepared."));
        var result = await Ask(o.Owner, "Set Atlas project dates to 12 Sep through 20 Dec 2026", "standard");
        var card = result.Last("action")["action"]!;
        Assert.Contains("stage planned dates and task deadlines stay unchanged", S(card["summary"]));
        Assert.NotEqual(DateOnly.Parse("2026-09-12"), factory.WithDb(db => db.Projects.IgnoreQueryFilters().Single(p => p.Id == o.Project).StartDate));
        var confirmed = await o.Owner.Post($"/api/v1/ai/messages/{S(result.Done["id"])}/actions/{S(card["id"])}/confirm");
        Assert.Equal("done", S(confirmed.Data!["status"]));
        var project = factory.WithDb(db => db.Projects.IgnoreQueryFilters().Single(p => p.Id == o.Project));
        Assert.Equal(DateOnly.Parse("2026-09-12"), project.StartDate); Assert.Equal(DateOnly.Parse("2026-12-20"), project.DueDate);
        Assert.Equal(before, factory.WithDb(db => db.ProjectStages.IgnoreQueryFilters().Where(s => s.ProjectId == o.Project).OrderBy(s => s.Id).Select(s => new { s.Id, s.PlannedStart, s.PlannedEnd }).ToList()));
    }

    [Fact]
    public async Task A_stale_project_date_card_fails_without_overwriting_newer_dates()
    {
        var o = await Setup();
        Chat.Script.Enqueue(_ => FakeAiChat.UseTool("propose_update_project", new { project = "Atlas", start_date = Iso(-5) }));
        Chat.Script.Enqueue(_ => FakeAiChat.Say("Prepared."));
        var result = await Ask(o.Owner, "Change Atlas start date", "standard");
        var card = result.Last("action")["action"]!;
        factory.WithDb(db => { var p = db.Projects.IgnoreQueryFilters().Single(p => p.Id == o.Project); p.StartDate = DateOnly.Parse(Iso(-2)); p.Version++; db.SaveChanges(); return 0; });
        var confirmed = await o.Owner.Post($"/api/v1/ai/messages/{S(result.Done["id"])}/actions/{S(card["id"])}/confirm");
        Assert.Equal("failed", S(confirmed.Data!["status"]));
        Assert.Contains("changed after", S(confirmed.Data["error"]));
        Assert.Equal(DateOnly.Parse(Iso(-2)), factory.WithDb(db => db.Projects.IgnoreQueryFilters().Single(p => p.Id == o.Project).StartDate));
    }

    private Guid ScheduleStage(Org o) => factory.WithDb(db =>
    {
        var stage = db.ProjectStages.IgnoreQueryFilters().OrderBy(s => s.Order).First(s => s.ProjectId == o.Project && s.Status != StageStatus.Completed && s.Order >= 2);
        stage.PlannedStart = DateOnly.Parse(Iso(0)); stage.PlannedEnd = DateOnly.Parse(Iso(2));
        stage.Description = "Keep stage scope"; stage.OwnerId = o.Owner.UserId; stage.AssigneeId = o.Manager.UserId;
        db.SaveChanges(); return stage.Id;
    });

    private async Task<(JsonNode Message, JsonNode Card)> StageSuggestion(Org o, Guid stage)
    {
        Chat.Script.Enqueue(_ => FakeAiChat.UseTool("propose_update_stage_dates", new { project = "Atlas", stage = stage.ToString(), planned_start = Iso(3), planned_end = Iso(7), reason = "Approved revised stage schedule" }));
        Chat.Script.Enqueue(_ => FakeAiChat.Say("Prepared stage dates for confirmation."));
        var result = await Ask(o.Owner, "Update this stage's planned dates", "standard");
        return (result.Done, result.Last("action")["action"]!);
    }

    [Fact]
    public async Task A_stage_date_confirmation_preserves_actuals_ownership_status_locks_tasks_and_project_dates()
    {
        var o = await Setup(); var stageId = ScheduleStage(o);
        var stageBefore = factory.WithDb(db => db.ProjectStages.IgnoreQueryFilters().Single(s => s.Id == stageId));
        var projectBefore = factory.WithDb(db => db.Projects.IgnoreQueryFilters().Single(p => p.Id == o.Project));
        var task = await o.Owner.CreateTaskAsync(o.Project, "Stage work", new { title = "Stage work", priority = "Medium", stageId, dueDate = Iso(2) });
        var taskId = Guid.Parse(S(task["id"]));
        var stagesBefore = (await o.Owner.Get($"/api/v1/projects/{o.Project}/stages")).Data!.AsArray();
        Assert.True(stagesBefore.Single(s => S(s!["id"]) == stageId.ToString())!["locked"]!.GetValue<bool>());
        var proposal = await StageSuggestion(o, stageId);
        Assert.Equal("update_stage_dates", S(proposal.Card["kind"]));
        Assert.Equal(stageBefore.PlannedEnd, factory.WithDb(db => db.ProjectStages.IgnoreQueryFilters().Single(s => s.Id == stageId).PlannedEnd));
        var url = $"/api/v1/ai/messages/{S(proposal.Message["id"])}/actions/{S(proposal.Card["id"])}/confirm";
        var confirmed = await o.Owner.Post(url);
        Assert.Equal("done", S(confirmed.Data!["status"]));
        var after = factory.WithDb(db => db.ProjectStages.IgnoreQueryFilters().Single(s => s.Id == stageId));
        Assert.Equal(DateOnly.Parse(Iso(3)), after.PlannedStart); Assert.Equal(DateOnly.Parse(Iso(7)), after.PlannedEnd);
        Assert.Equal(stageBefore.ActualStart, after.ActualStart); Assert.Equal(stageBefore.ActualEnd, after.ActualEnd);
        Assert.Equal(stageBefore.Status, after.Status); Assert.Equal(stageBefore.OwnerId, after.OwnerId); Assert.Equal(stageBefore.AssigneeId, after.AssigneeId); Assert.Equal(stageBefore.Description, after.Description);
        var projectAfter = factory.WithDb(db => db.Projects.IgnoreQueryFilters().Single(p => p.Id == o.Project));
        Assert.Equal(projectBefore.StartDate, projectAfter.StartDate); Assert.Equal(projectBefore.DueDate, projectAfter.DueDate);
        Assert.Equal(DateOnly.Parse(Iso(2)), factory.WithDb(db => db.Tasks.IgnoreQueryFilters().Single(t => t.Id == taskId).DueDate));
        var stagesAfter = (await o.Owner.Get($"/api/v1/projects/{o.Project}/stages")).Data!.AsArray();
        Assert.Equal(stagesBefore.Select(s => s!["locked"]!.ToJsonString()), stagesAfter.Select(s => s!["locked"]!.ToJsonString()));
        Assert.Equal(HttpStatusCode.Conflict, (await o.Owner.Post(url)).Status);
    }

    [Fact]
    public async Task A_stage_schedule_change_after_proposal_is_not_overwritten()
    {
        var o = await Setup(); var stage = ScheduleStage(o); var proposal = await StageSuggestion(o, stage);
        factory.WithDb(db => { db.ProjectStages.IgnoreQueryFilters().Where(s => s.Id == stage).ExecuteUpdate(s => s.SetProperty(x => x.PlannedEnd, DateOnly.Parse(Iso(9)))); return 0; });
        var confirmed = await o.Owner.Post($"/api/v1/ai/messages/{S(proposal.Message["id"])}/actions/{S(proposal.Card["id"])}/confirm");
        Assert.Equal("failed", S(confirmed.Data!["status"])); Assert.Contains("changed after", S(confirmed.Data["error"]));
        Assert.Equal(DateOnly.Parse(Iso(9)), factory.WithDb(db => db.ProjectStages.IgnoreQueryFilters().Single(s => s.Id == stage).PlannedEnd));
    }

    [Fact]
    public async Task A_stage_completed_after_proposal_keeps_its_history_on_confirmation()
    {
        var o = await Setup(); var stage = ScheduleStage(o); var proposal = await StageSuggestion(o, stage);
        factory.WithDb(db => { db.ProjectStages.IgnoreQueryFilters().Where(s => s.Id == stage).ExecuteUpdate(s => s.SetProperty(x => x.Status, StageStatus.Completed)); return 0; });
        var confirmed = await o.Owner.Post($"/api/v1/ai/messages/{S(proposal.Message["id"])}/actions/{S(proposal.Card["id"])}/confirm");
        Assert.Equal("failed", S(confirmed.Data!["status"]));
        var after = factory.WithDb(db => db.ProjectStages.IgnoreQueryFilters().Single(s => s.Id == stage));
        Assert.Equal(StageStatus.Completed, after.Status); Assert.Equal(DateOnly.Parse(Iso(2)), after.PlannedEnd);
    }

    [Fact]
    public async Task Stage_dates_validate_order_delay_reason_access_and_already_saved_values()
    {
        var o = await Setup(); var stage = ScheduleStage(o);
        Assert.Contains("before planned start", await RunTool(o.Owner, "propose_update_stage_dates", new { project = "Atlas", stage = stage.ToString(), planned_start = Iso(3), planned_end = Iso(1) }));
        Assert.Contains("needs a reason", await RunTool(o.Owner, "propose_update_stage_dates", new { project = "Atlas", stage = stage.ToString(), planned_end = Iso(4) }));
        Assert.Contains("No change needed", await RunTool(o.Owner, "propose_update_stage_dates", new { project = "Atlas", stage = stage.ToString(), planned_start = Iso(0), planned_end = Iso(2) }));
        Assert.Contains("does not allow", await RunTool(o.Guest, "propose_update_stage_dates", new { project = "Atlas", stage = stage.ToString(), planned_end = Iso(1) }));
        var foreign = await TestClient.RegisterAsync(factory, "Other organization owner"); await foreign.CreateOrgAsync(); await foreign.UpgradeAsync("BUSINESS");
        Assert.Contains("No such project", await RunTool(foreign, "propose_update_stage_dates", new { project = o.Project.ToString(), stage = stage.ToString(), planned_end = Iso(1) }));
        Assert.DoesNotContain(stage.ToString(), await RunTool(foreign, "project_report", new { project = o.Project.ToString() }));
        Assert.Contains(stage.ToString(), await RunTool(o.Owner, "project_report", new { project = "Atlas" }));
        factory.WithDb(db => { db.ProjectStages.IgnoreQueryFilters().Where(s => s.Id == stage).ExecuteUpdate(s => s.SetProperty(x => x.Status, StageStatus.Completed)); return 0; });
        Assert.Contains("completed", await RunTool(o.Owner, "propose_update_stage_dates", new { project = "Atlas", stage = stage.ToString(), planned_end = Iso(1) }));
    }
}
