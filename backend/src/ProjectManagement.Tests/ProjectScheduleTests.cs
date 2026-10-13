using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

[Collection("api")]
public class ProjectScheduleTests(ApiFactory factory)
{
    private static readonly DateOnly Start = new(2030, 1, 1);
    private static string Day(int days) => Start.AddDays(days).ToString("yyyy-MM-dd");
    private async Task<(TestClient Owner, Guid Id, Guid[] Stages)> Setup(StageScheduleMode mode = StageScheduleMode.FollowSchedule)
    {
        var owner = await TestClient.RegisterAsync(factory, "Schedule owner"); await owner.CreateOrgAsync(); await owner.UpgradeAsync("BUSINESS");
        var id = await owner.CreateProjectAsync("Connected delivery");
        var stages = factory.WithDb(db =>
        {
            db.ProjectStages.IgnoreQueryFilters().Where(s => s.ProjectId == id).ExecuteDelete();
            var project = db.Projects.IgnoreQueryFilters().Single(p => p.Id == id);
            project.StartDate = Start; project.DueDate = Start.AddDays(10); project.StageScheduleMode = mode;
            var rows = new[] { ("Created", 0, 0, true), ("Design", 4, 0, false), ("Build", 6, 4, false), ("Launch", 0, 10, false) }
                .Select((s, i) => new ProjectStage { TenantId = owner.WorkspaceId, ProjectId = id, Name = s.Item1, DurationDays = s.Item2,
                    PlannedStart = Start.AddDays(s.Item3), PlannedEnd = Start.AddDays(s.Item3 + s.Item2), Order = i,
                    Status = s.Item4 ? StageStatus.Completed : StageStatus.Pending, ActualStart = s.Item4 ? Start.AddDays(-1) : null, ActualEnd = s.Item4 ? Start.AddDays(-1) : null }).ToArray();
            db.ProjectStages.AddRange(rows); db.SaveChanges(); return rows.Select(s => s.Id).ToArray();
        });
        return (owner, id, stages);
    }
    private Project Project(Guid id) => factory.WithDb(db => db.Projects.IgnoreQueryFilters().AsNoTracking().Single(p => p.Id == id));
    private List<ProjectStage> Stages(Guid id) => factory.WithDb(db => db.ProjectStages.IgnoreQueryFilters().AsNoTracking().Where(s => s.ProjectId == id).OrderBy(s => s.Order).ToList());
    private object Schedule(Guid id, int designDays, string? reason = null, string mode = "FollowSchedule") => new
    {
        version = Project(id).Version, mode, startDate = Day(0), dueDate = Day(10), reason,
        durations = Stages(id).Select((s, i) => new { id = s.Id, durationDays = i == 1 ? designDays : s.DurationDays!.Value }).ToArray()
    };
    private object ProjectDates(Guid id, string start, string due, string? reason = null) => new
    {
        name = Project(id).Name, priority = "Medium", status = "Planning", ownerId = Project(id).OwnerId,
        startDate = start, dueDate = due, version = Project(id).Version, dueDateReason = reason
    };

    [Fact]
    public async Task Preview_is_read_only_extensions_need_reasons_and_save_aligns_the_entire_plan()
    {
        var (owner, id, stages) = await Setup(); var version = Project(id).Version;
        var preview = await owner.Post($"/api/v1/projects/{id}/schedule/preview", Schedule(id, 8));
        Assert.True(preview.Ok, preview.ToString()); Assert.Equal(Day(14), preview.Data!["dueDate"]!.GetValue<string>());
        Assert.Equal(Start.AddDays(10), Project(id).DueDate); Assert.Equal(4, Stages(id)[1].DurationDays);
        var rejected = await owner.Put($"/api/v1/projects/{id}/schedule", Schedule(id, 8));
        Assert.Equal(422, (int)rejected.Status); Assert.Equal(version, Project(id).Version); Assert.Equal(4, Stages(id)[1].DurationDays);
        var saved = await owner.Put($"/api/v1/projects/{id}/schedule", Schedule(id, 8, "Approved scope expansion"));
        Assert.True(saved.Ok, saved.ToString()); Assert.Equal(Start.AddDays(14), Project(id).DueDate); Assert.Equal(version + 1, Project(id).Version);
        var plan = Stages(id); Assert.Equal(Start.AddDays(8), plan[2].PlannedStart); Assert.Equal(Start.AddDays(14), plan[3].PlannedEnd);
        Assert.Equal(Start.AddDays(-1), plan[0].ActualStart); Assert.Equal(StageStatus.Completed, plan[0].Status);
        Assert.Equal(6, plan[2].DurationDays); Assert.Equal(stages, plan.Select(s => s.Id));
    }

    [Fact]
    public async Task Manual_stage_start_moves_in_both_directions_and_end_edits_change_allocation()
    {
        var (owner, id, stages) = await Setup();
        var forward = await owner.Put($"/api/v1/projects/{id}/stages/{stages[1]}", new { name = "Design", plannedStart = Day(3), projectVersion = Project(id).Version, scheduleReason = "Dependency moved" });
        Assert.True(forward.Ok, forward.ToString()); Assert.Equal(Start.AddDays(13), Project(id).DueDate); Assert.Equal(Start.AddDays(7), Stages(id)[2].PlannedStart);
        var backward = await owner.Put($"/api/v1/projects/{id}/stages/{stages[1]}", new { name = "Design", plannedStart = Day(1), projectVersion = Project(id).Version });
        Assert.True(backward.Ok, backward.ToString()); Assert.Equal(Start.AddDays(11), Project(id).DueDate); Assert.Equal(4, Stages(id)[1].DurationDays);
        var end = await owner.Put($"/api/v1/projects/{id}/stages/{stages[1]}", new { name = "Design", plannedEnd = Day(8), projectVersion = Project(id).Version, scheduleReason = "Extra design review" });
        Assert.True(end.Ok, end.ToString()); Assert.Equal(7, Stages(id)[1].DurationDays); Assert.Equal(Start.AddDays(14), Project(id).DueDate);
        Assert.Equal(Start.AddDays(8), Stages(id)[2].PlannedStart); Assert.Equal(6, Stages(id)[2].DurationDays);
    }

    [Fact]
    public async Task Fixed_deadline_overflow_and_predecessor_overlap_reject_without_partial_writes()
    {
        var (owner, id, stages) = await Setup(StageScheduleMode.FixedDeadline); var version = Project(id).Version;
        var overflow = await owner.Put($"/api/v1/projects/{id}/schedule", Schedule(id, 8, "Not sufficient", "FixedDeadline"));
        Assert.Equal(422, (int)overflow.Status); Assert.Contains("4 day(s)", overflow.ToString());
        var overlap = await owner.Put($"/api/v1/projects/{id}/stages/{stages[2]}", new { name = "Build", plannedStart = Day(2), projectVersion = version });
        Assert.Equal(422, (int)overlap.Status); Assert.Contains("predecessor", overlap.ToString());
        Assert.Equal(version, Project(id).Version); Assert.Equal(Start.AddDays(4), Stages(id)[2].PlannedStart); Assert.Equal(Start.AddDays(10), Project(id).DueDate);
    }

    [Fact]
    public async Task Project_boundary_changes_rebase_forward_and_backward_and_an_impossible_end_is_rejected()
    {
        var (owner, id, _) = await Setup();
        Assert.True((await owner.Put($"/api/v1/projects/{id}", ProjectDates(id, Day(2), Day(10), "Later kickoff"))).Ok);
        Assert.Equal(Start.AddDays(2), Stages(id)[1].PlannedStart); Assert.Equal(Start.AddDays(12), Project(id).DueDate);
        Assert.True((await owner.Put($"/api/v1/projects/{id}", ProjectDates(id, Day(2), Day(15), "Later final release"))).Ok);
        Assert.Equal(Start.AddDays(5), Stages(id)[1].PlannedStart); Assert.Equal(Start.AddDays(15), Project(id).DueDate);
        var invalid = await owner.Put($"/api/v1/projects/{id}", ProjectDates(id, Day(2), Day(9)));
        Assert.Equal(422, (int)invalid.Status); Assert.Equal(Start.AddDays(15), Project(id).DueDate);
        Assert.True((await owner.Put($"/api/v1/projects/{id}", ProjectDates(id, Day(1), Day(15)))).Ok);
        Assert.Equal(Start.AddDays(4), Stages(id)[1].PlannedStart); Assert.Equal(Start.AddDays(14), Project(id).DueDate);
        Assert.Equal(Start.AddDays(-1), Stages(id)[0].ActualEnd);
    }

    [Fact]
    public async Task Schedule_updates_require_access_and_a_current_version_in_each_tenant()
    {
        var (owner, id, _) = await Setup(); var stale = Schedule(id, 4);
        Assert.True((await owner.Put($"/api/v1/projects/{id}/schedule", stale)).Ok);
        Assert.Equal(HttpStatusCode.Conflict, (await owner.Put($"/api/v1/projects/{id}/schedule", stale)).Status);
        var guest = await owner.AddMemberAsync(factory, TenantRole.Guest, "Read only schedule guest");
        factory.WithDb(db => { db.ProjectMembers.Add(new ProjectMember { TenantId = owner.WorkspaceId, ProjectId = id, UserId = guest.UserId }); db.SaveChanges(); return 0; });
        Assert.Equal(HttpStatusCode.Forbidden, (await guest.Put($"/api/v1/projects/{id}/schedule", Schedule(id, 4))).Status);
        var foreign = await TestClient.RegisterAsync(factory); await foreign.CreateOrgAsync();
        Assert.Equal(HttpStatusCode.NotFound, (await foreign.Post($"/api/v1/projects/{id}/schedule/preview", Schedule(id, 4))).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await foreign.Put($"/api/v1/projects/{id}/schedule", Schedule(id, 4))).Status);
    }

    [Fact]
    public async Task Completed_plans_and_duplicate_allocations_are_validated_and_manual_mode_can_be_restored()
    {
        var (owner, id, stages) = await Setup();
        var invalid = await owner.Put($"/api/v1/projects/{id}/stages/{stages[0]}", new { name = "Created", plannedStart = Day(2), projectVersion = Project(id).Version });
        Assert.Equal(422, (int)invalid.Status); Assert.Equal(Start, Stages(id)[0].PlannedStart);
        var duplicates = await owner.Post($"/api/v1/projects/{id}/schedule/preview", new { version = Project(id).Version, mode = "FollowSchedule", startDate = Day(0), dueDate = Day(10), durations = stages.Select(_ => new { id = stages[1], durationDays = 4 }).ToArray() });
        Assert.Equal(422, (int)duplicates.Status);
        var manual = await owner.Put($"/api/v1/projects/{id}", new { name = Project(id).Name, priority = "Medium", status = "Planning", startDate = Day(0), dueDate = Day(10), version = Project(id).Version, stageScheduleMode = "Manual" });
        Assert.True(manual.Ok, manual.ToString()); Assert.Equal(StageScheduleMode.Manual, Project(id).StageScheduleMode);
    }

    [Fact]
    public async Task New_dated_projects_have_allocations_and_follow_the_final_stage_by_default()
    {
        var owner = await TestClient.RegisterAsync(factory); await owner.CreateOrgAsync();
        var created = await owner.Post("/api/v1/projects", new { name = "New scheduled project", priority = "Medium", startDate = Day(0), dueDate = Day(30) });
        Assert.True(created.Ok, created.ToString()); Assert.Equal("FollowSchedule", created.Data!["project"]!["stageScheduleMode"]!.GetValue<string>());
        var stages = created.Data["stages"]!.AsArray(); Assert.NotEmpty(stages);
        Assert.Equal(30, stages.Sum(s => s!["durationDays"]!.GetValue<int>()));
        Assert.Equal(Day(30), stages.Last()!["plannedEnd"]!.GetValue<string>());
    }

    [Fact]
    public async Task A_preview_expires_when_a_stage_completes_even_without_a_project_version_change()
    {
        var (owner, id, stages) = await Setup();
        var body = JsonSerializerNode(Schedule(id, 4));
        var preview = await owner.Post($"/api/v1/projects/{id}/schedule/preview", body);
        Assert.True(preview.Ok, preview.ToString()); body["expectedFingerprint"] = preview.Data!["fingerprint"]!.GetValue<string>();
        factory.WithDb(db => { db.ProjectStages.IgnoreQueryFilters().Where(s => s.Id == stages[1]).ExecuteUpdate(s => s.SetProperty(x => x.Status, StageStatus.Completed)); return 0; });
        var expired = await owner.Put($"/api/v1/projects/{id}/schedule", body);
        Assert.Equal(HttpStatusCode.Conflict, expired.Status); Assert.Contains("after your preview", expired.ToString());
        Assert.Equal(StageStatus.Completed, Stages(id)[1].Status);
    }
    private static JsonObject JsonSerializerNode(object value) => System.Text.Json.JsonSerializer.SerializeToNode(value, new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web))!.AsObject();

    [Fact]
    public async Task Inserting_deleting_and_reordering_stages_keep_the_plan_connected()
    {
        var (owner, id, stages) = await Setup();
        var insert = await owner.Post($"/api/v1/projects/{id}/stages", new { name = "Security review", order = 2, durationDays = 3, projectVersion = Project(id).Version, scheduleReason = "Required security sign-off" });
        Assert.True(insert.Ok, insert.ToString()); Assert.Equal(Start.AddDays(13), Project(id).DueDate);
        var plan = Stages(id); Assert.Equal(Start.AddDays(7), plan[3].PlannedStart);
        Assert.True((await owner.Delete($"/api/v1/projects/{id}/stages/{plan[2].Id}?projectVersion={Project(id).Version}")).Ok);
        Assert.Equal(Start.AddDays(10), Project(id).DueDate);
        var reordered = await owner.Put($"/api/v1/projects/{id}/stages/order", new { stageIds = new[] { stages[0], stages[2], stages[1], stages[3] }, projectVersion = Project(id).Version });
        Assert.True(reordered.Ok, reordered.ToString()); Assert.Equal(Start.AddDays(6), Stages(id)[2].PlannedStart);
        Assert.Equal(Start.AddDays(10), Project(id).DueDate);
    }

    [Fact]
    public async Task Editing_the_studio_end_date_schedules_backward_without_compressing_durations()
    {
        var (owner, id, _) = await Setup();
        var body = JsonSerializerNode(Schedule(id, 4, "Release date revised")); body["dueDate"] = Day(15);
        var preview = await owner.Post($"/api/v1/projects/{id}/schedule/preview", body);
        Assert.True(preview.Ok, preview.ToString()); Assert.Equal(Day(5), preview.Data!["stages"]![1]!["start"]!.GetValue<string>());
        body["expectedFingerprint"] = preview.Data["fingerprint"]!.GetValue<string>();
        Assert.True((await owner.Put($"/api/v1/projects/{id}/schedule", body)).Ok); Assert.Equal(Start.AddDays(15), Project(id).DueDate);
        var earlier = JsonSerializerNode(Schedule(id, 4)); earlier["dueDate"] = Day(12);
        Assert.True((await owner.Put($"/api/v1/projects/{id}/schedule", earlier)).Ok);
        Assert.Equal(Start.AddDays(2), Stages(id)[1].PlannedStart); Assert.Equal(4, Stages(id)[1].DurationDays); Assert.Equal(6, Stages(id)[2].DurationDays);
        Assert.Equal(Start.AddDays(12), Project(id).DueDate);
    }
}
