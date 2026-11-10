using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Application.Features.Load;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>How sure the forecast is (honest about thin evidence), who may be handed a late stage, and the scoreboard's rules: all without a database.</summary>
public class ForecastConfidenceTests
{
    private static readonly DateOnly Day = new(2026, 12, 22);
    private static ForecastEvidence Calm => new(3, 0, false, null, 0, 10);

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(4)]
    public void Fewer_than_five_verified_projects_is_an_early_estimate_with_no_percentage(int verified)
    {
        var c = ForecastConfidence.Compute(Day, Calm, new ForecastCalibration(verified, verified, 0.5, 0));
        Assert.Null(c.ConfidencePct);
        Assert.False(c.Calibrated);
        Assert.Equal("early", c.Band);
        Assert.Equal("Likely 22 Dec · early estimate", c.Label);
        Assert.DoesNotContain("%", c.Label);
    }

    [Fact]
    public void Even_a_perfect_record_gets_a_percentage_only_from_five_verified_projects()
    {
        Assert.Null(ForecastConfidence.Compute(Day, Calm, new ForecastCalibration(4, 4, 0, 0)).ConfidencePct);
        var five = ForecastConfidence.Compute(Day, Calm, new ForecastCalibration(5, 5, 0, 0));
        Assert.NotNull(five.ConfidencePct);
        Assert.True(five.Calibrated);
        // Five out of five is not certainty: the lower bound stays well below 100.
        Assert.InRange(five.ConfidencePct!.Value, 5, 95);
        Assert.True(five.ConfidencePct < 90);
    }

    [Fact]
    public void More_evidence_raises_the_lower_bound_and_misses_lower_it()
    {
        Assert.True(ForecastConfidence.WilsonLower(40, 40) > ForecastConfidence.WilsonLower(5, 5));
        Assert.True(ForecastConfidence.WilsonLower(3, 10) < ForecastConfidence.WilsonLower(9, 10));
        Assert.Equal(0, ForecastConfidence.WilsonLower(0, 0));
    }

    [Fact]
    public void An_overloaded_owner_and_slipping_stages_lower_the_band()
    {
        var past = new ForecastCalibration(40, 40, 0.5, 0);
        var calm = ForecastConfidence.Compute(Day, Calm, past);
        var shaky = ForecastConfidence.Compute(Day, new ForecastEvidence(3, 6, true, 150, 0, 10), past);
        Assert.Equal("high", calm.Band);
        Assert.NotEqual("high", shaky.Band);
        Assert.Contains(shaky.Evidence, e => e.Contains("overloaded"));
    }

    [Fact]
    public void No_forecast_says_so_and_invents_nothing()
    {
        var c = ForecastConfidence.Compute(null, Calm, new ForecastCalibration(50, 50, 0, 0));
        Assert.Equal("none", c.Band);
        Assert.Null(c.ConfidencePct);
    }

    [Fact]
    public void Scoring_uses_the_latest_forecast_taken_a_week_before_the_audited_completion_and_skips_reopened_projects()
    {
        var p = Guid.NewGuid(); var reopened = Guid.NewGuid();
        var finish = new DateTime(2026, 12, 20, 9, 0, 0, DateTimeKind.Utc);
        var snaps = new[]
        {
            new SnapshotPoint(p, finish.AddDays(-30), new DateOnly(2026, 12, 10)),
            new SnapshotPoint(p, finish.AddDays(-8), new DateOnly(2026, 12, 18)),
            new SnapshotPoint(p, finish.AddDays(-2), new DateOnly(2026, 12, 20)),   // too close to the finish to prove anything
            new SnapshotPoint(reopened, finish.AddDays(-9), new DateOnly(2026, 12, 18)),
        };
        var events = new[]
        {
            new StatusEvent(p, finish, "Completed"),
            new StatusEvent(reopened, finish, "Completed"), new StatusEvent(reopened, finish.AddDays(1), "Active"),
        };
        var scored = ForecastScoring.Score(snaps, events, d => DateOnly.FromDateTime(d));
        var one = Assert.Single(scored);
        Assert.Equal(p, one.ProjectId);
        Assert.Equal(2, one.ErrorDays);
        var summary = ForecastScoring.Summarise(scored);
        Assert.Equal(1, summary.Verified); Assert.Equal(1, summary.WithinWindow);
    }
}

public class SlipFixPlannerTests
{
    private static LoadFitPersonDto P(string name, string state, bool fits, int free, Guid? id = null) => new(id ?? Guid.NewGuid(), name, state, "", false, fits, free, false);

    [Fact]
    public void Never_picks_an_over_capacity_stretched_leave_or_off_person()
    {
        var free = P("Free", LoadMath.Free, true, 600); var over = P("Over", LoadMath.Overloaded, true, 900); var stretched = P("Stretched", LoadMath.Stretched, true, 800);
        var leave = P("Leave", LoadMath.Leave, true, 900); var off = P("Off", LoadMath.Off, true, 900); var noFit = P("NoFit", LoadMath.Free, false, 900);
        var all = new[] { over, stretched, leave, off, noFit, free };
        var eligible = all.Select(p => p.UserId).ToHashSet();
        Assert.Equal(free.UserId, SlipFixPlanner.PickAssignee(all, eligible, Guid.NewGuid())!.UserId);
        Assert.Null(SlipFixPlanner.PickAssignee(new[] { over, stretched, leave, off, noFit }, eligible, null));
    }

    [Fact]
    public void Never_picks_someone_who_is_not_an_active_project_member_or_the_current_owner()
    {
        var suspended = P("Suspended", LoadMath.Free, true, 900); var current = P("Current", LoadMath.Free, true, 800); var member = P("Member", LoadMath.Balanced, true, 100);
        var eligible = new HashSet<Guid> { current.UserId, member.UserId };   // the suspended person is not in the active set
        var pick = SlipFixPlanner.PickAssignee(new[] { suspended, current, member }, eligible, current.UserId);
        Assert.Equal(member.UserId, pick!.UserId);
        Assert.Null(SlipFixPlanner.PickAssignee(new[] { suspended }, eligible, null));
    }

    [Fact]
    public void The_most_room_wins_and_ties_break_by_name()
    {
        var a = P("Asha", LoadMath.Free, true, 300); var b = P("Bala", LoadMath.Free, true, 300); var c = P("Chitra", LoadMath.Balanced, true, 500);
        var eligible = new[] { a, b, c }.Select(p => p.UserId).ToHashSet();
        Assert.Equal("Chitra", SlipFixPlanner.PickAssignee(new[] { a, b, c }, eligible, null)!.Name);
        Assert.Equal("Asha", SlipFixPlanner.PickAssignee(new[] { b, a }, eligible, null)!.Name);
    }

    [Fact]
    public void A_date_move_reason_is_never_empty()
    {
        var reason = SlipFixPlanner.DateMoveReason(new DateOnly(2026, 12, 10), new DateOnly(2026, 12, 22), null, "Likely 22 Dec · early estimate");
        Assert.True(reason.Length >= 8);
        Assert.Contains("12 days", reason);
    }

    [Fact]
    public void A_slip_fix_notice_gets_a_confirm_button_and_other_overdue_notices_do_not()
    {
        var link = $"/projects/{Guid.NewGuid()}?fix={Guid.NewGuid()}.0a1b2c3d";
        Assert.Equal(["confirm", "open"], QuickActions.For(NotificationType.Overdue, link, "PRJ is likely to miss 10 Dec"));
        Assert.DoesNotContain("confirm", QuickActions.For(NotificationType.Overdue, $"/projects/{Guid.NewGuid()}?task={Guid.NewGuid()}", "Task is overdue"));
        Assert.DoesNotContain("confirm", QuickActions.For(NotificationType.Comment, link, "x"));
    }
}

[Collection("api")]
public class SlipFixJobTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();

    private async Task<(TestClient Owner, Guid Project)> LateProjectAsync(string name, string? level = null)
    {
        var owner = await TestClient.RegisterAsync(factory, $"{name} Owner");
        await owner.CreateOrgAsync(); await owner.UpgradeAsync("BUSINESS");
        if (level is not null) Assert.True((await owner.Put("/api/v1/ai/control/agents/project", new { level })).Ok);
        var project = await owner.CreateProjectAsync(name);
        var due = AppDay.Today.AddDays(-6);
        factory.WithDb(db =>
        {
            db.Projects.IgnoreQueryFilters().Where(p => p.Id == project).ExecuteUpdate(s => s.SetProperty(p => p.DueDate, due).SetProperty(p => p.StageScheduleMode, StageScheduleMode.Manual));
            db.ProjectStages.IgnoreQueryFilters().Where(s => s.ProjectId == project).ExecuteUpdate(s => s.SetProperty(x => x.PlannedEnd, due));
            return 0;
        });
        return (owner, project);
    }

    private async Task<int> RunAsync(Guid workspace)
    {
        using var scope = factory.Services.CreateScope();
        return await scope.ServiceProvider.GetRequiredService<SlipFixService>().RunWorkspaceAsync(workspace);
    }

    private List<AiMessage> Cards(Guid workspace) => factory.WithDb(db => db.AiMessages.IgnoreQueryFilters().Where(m => m.TenantId == workspace && m.Model == SlipFixOwnerRun.Model).ToList());

    [Fact]
    public async Task A_late_project_gets_one_card_and_running_again_changes_nothing()
    {
        var (owner, project) = await LateProjectAsync("Slip once");
        Assert.Equal(1, await RunAsync(owner.WorkspaceId));
        Assert.Equal(0, await RunAsync(owner.WorkspaceId));
        var cards = Cards(owner.WorkspaceId);
        Assert.Single(cards);
        var card = JsonNode.Parse(cards[0].ActionsJson!)!.AsArray()[0]!;
        Assert.Equal("proposed", S(card["status"]));
        Assert.Equal("move_promised_date", S(card["kind"]));
        // Nothing changed by itself: the promised date is still the old one.
        Assert.Equal(AppDay.Today.AddDays(-6), factory.WithDb(db => db.Projects.IgnoreQueryFilters().Single(p => p.Id == project).DueDate));
        var notices = (await owner.Get("/api/v1/notifications")).Data!["items"]!.AsArray();
        Assert.Single(notices, n => S(n!["title"]).Contains("likely to miss") && S(n["link"]).Contains("?fix="));
    }

    [Fact]
    public async Task The_agent_being_off_prepares_nothing()
    {
        var (owner, _) = await LateProjectAsync("Slip off", "off");
        Assert.Equal(0, await RunAsync(owner.WorkspaceId));
        Assert.Empty(Cards(owner.WorkspaceId));
    }

    [Fact]
    public async Task At_auto_a_date_move_still_waits_for_a_person_and_carries_its_reason()
    {
        var (owner, project) = await LateProjectAsync("Slip auto", "auto");
        Assert.Equal(1, await RunAsync(owner.WorkspaceId));
        var message = Cards(owner.WorkspaceId).Single();
        var card = JsonNode.Parse(message.ActionsJson!)!.AsArray()[0]!;
        Assert.Equal("proposed", S(card["status"]));
        Assert.Equal(AppDay.Today.AddDays(-6), factory.WithDb(db => db.Projects.IgnoreQueryFilters().Single(p => p.Id == project).DueDate));
        var payload = JsonNode.Parse(S(card["payloadJson"]))!;
        Assert.True(S(payload["reason"]).Length >= 8);
    }

    [Fact]
    public async Task Only_the_owner_can_confirm_and_confirming_moves_the_date_with_the_reason_on_record()
    {
        var (owner, project) = await LateProjectAsync("Slip confirm");
        var other = await owner.AddMemberAsync(factory, TenantRole.Admin, "Other lead");
        Assert.Equal(1, await RunAsync(owner.WorkspaceId));
        var message = Cards(owner.WorkspaceId).Single();
        var card = JsonNode.Parse(message.ActionsJson!)!.AsArray()[0]!;
        var url = $"/api/v1/ai/messages/{message.Id}/actions/{S(card["id"])}/confirm";

        var stranger = await other.Post(url);
        Assert.False(stranger.Ok, stranger.ToString());
        Assert.Equal(AppDay.Today.AddDays(-6), factory.WithDb(db => db.Projects.IgnoreQueryFilters().Single(p => p.Id == project).DueDate));

        var done = await owner.Post(url);
        Assert.True(done.Ok, done.ToString());
        Assert.True(factory.WithDb(db => db.Projects.IgnoreQueryFilters().Single(p => p.Id == project).DueDate) > AppDay.Today.AddDays(-6));
    }

    [Fact]
    public async Task The_scoreboard_stays_hidden_until_enough_completions_are_verified()
    {
        var (owner, _) = await LateProjectAsync("Slip scoreboard");
        var board = await owner.Get("/api/v1/ai/operations/forecasts/scoreboard");
        Assert.True(board.Ok, board.ToString());
        Assert.False(board.Data!["visible"]!.GetValue<bool>());
        Assert.Null(board.Data["meanAbsoluteErrorDays"]);
        Assert.Null(board.Data["percentWithinDays"]);
        Assert.Contains("Heuristic", S(board.Data["note"]));
    }

    [Fact]
    public async Task The_project_forecast_says_early_estimate_without_a_percentage_in_a_new_workspace()
    {
        var (owner, project) = await LateProjectAsync("Slip confidence");
        var detail = await owner.Get($"/api/v1/projects/{project}");
        Assert.True(detail.Ok, detail.ToString());
        var confidence = detail.Data!["forecast"]!["confidence"]!;
        Assert.Equal("early", S(confidence["band"]));
        Assert.Null(confidence["confidencePct"]);
        Assert.Contains("early estimate", S(confidence["label"]));
    }
}
