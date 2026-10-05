using System.Net;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>"What if it slips, we add people, we cut scope": the arithmetic, the endpoint, and who may ask about which project.</summary>
[Collection("api")]
public class ScenarioTests(ApiFactory factory)
{
    private static readonly DateOnly Today = new(2026, 10, 5);

    [Fact]
    public void A_later_start_moves_the_finish_by_the_same_number_of_days()
    {
        var (b, s, _, _) = AiPortfolio.Simulate(open: 7, finishedLast28: 7, contributors: 1, Today, due: Today.AddDays(14), slipDays: 5, addPeople: 0, cutTasks: 0);
        Assert.Equal(Today.AddDays(28), b.Finish);                 // 7 left at a quarter of a task a day
        Assert.Equal(14, b.SlipDays);
        Assert.Equal(Today.AddDays(33), s.Finish);
        Assert.Equal(19, s.SlipDays);
    }

    [Fact]
    public void Added_people_count_for_less_than_a_full_person_and_cut_tasks_shorten_the_plan()
    {
        var (_, withPeople, _, notes) = AiPortfolio.Simulate(7, 7, 1, Today, Today.AddDays(14), 0, addPeople: 1, cutTasks: 0);
        Assert.Equal(Today.AddDays(17), withPeople.Finish);        // 7 / (0.25 x 1.7) = 16.5 days, rounded up
        Assert.Equal("medium", withPeople.Confidence);             // never "high": a bigger team is a guess about the future
        Assert.Contains(notes, n => n.Contains("70%"));

        var (_, cut, _, _) = AiPortfolio.Simulate(7, 7, 1, Today, Today.AddDays(14), 0, 0, cutTasks: 3);
        Assert.Equal(Today.AddDays(16), cut.Finish);               // 4 left
        Assert.Equal(4, cut.OpenTasks);

        var (_, all, _, _) = AiPortfolio.Simulate(7, 7, 1, Today, Today.AddDays(14), slipDays: 2, 0, cutTasks: 7);
        Assert.Equal(Today.AddDays(2), all.Finish);                // nothing left to do: only the delay remains
    }

    [Fact]
    public void It_says_what_it_would_take_to_still_meet_the_due_date()
    {
        var (_, _, need, _) = AiPortfolio.Simulate(7, 7, 1, Today, Today.AddDays(14), 0, 0, 0);
        Assert.Equal(4, need!.CutTasks);                           // 14 days at a quarter of a task a day is 3 tasks
        Assert.Equal(2, need.AddPeople);                           // 0.5 a day is double the pace; one more person is worth 0.7
        Assert.Contains("take out 4 tasks, or add 2 people", need.Note);

        Assert.Equal("At the current pace the due date is still met.", AiPortfolio.Simulate(2, 7, 1, Today, Today.AddDays(30), 0, 0, 0).Need!.Note);
        Assert.Contains("passed", AiPortfolio.Simulate(7, 7, 1, Today, Today.AddDays(-3), 0, 0, 0).Need!.Note);
        Assert.Contains("no time left", AiPortfolio.Simulate(7, 7, 1, Today, Today.AddDays(14), slipDays: 20, 0, 0).Need!.Note);
    }

    [Fact]
    public void With_no_finished_work_there_is_no_pace_to_forecast_from_and_it_says_so()
    {
        var (b, s, need, notes) = AiPortfolio.Simulate(5, 0, 1, Today, Today.AddDays(30), 3, 2, 0);
        Assert.Null(b.Finish); Assert.Null(s.Finish); Assert.Equal("none", s.Confidence); Assert.Null(need);
        Assert.Contains(notes, n => n.Contains("no pace"));
    }

    private async Task<(TestClient Owner, Guid Project)> Project()
    {
        var owner = await TestClient.RegisterAsync(factory, "Olivia Owner");
        await owner.CreateOrgAsync();
        var project = await owner.CreateProjectAsync("Atlas");
        for (var i = 0; i < 7; i++) await owner.CreateTaskAsync(project, $"Delivered {i}", new { title = $"Delivered {i}", priority = "Medium" });
        for (var i = 0; i < 7; i++) await owner.CreateTaskAsync(project, $"Open {i}", new { title = $"Open {i}", priority = "Medium" });
        factory.WithDb(db =>
        {
            var done = db.WorkflowStatuses.IgnoreQueryFilters().First(s => s.ProjectId == project && s.Category == StatusCategory.Done).Id;
            foreach (var t in db.Tasks.IgnoreQueryFilters().Where(t => t.ProjectId == project && t.Title.StartsWith("Delivered")).ToList()) { t.StatusId = done; t.CompletedAt = DateTime.UtcNow.AddDays(-5); }
            db.Projects.IgnoreQueryFilters().First(p => p.Id == project).DueDate = DateOnly.FromDateTime(DateTime.UtcNow).AddDays(14);
            db.SaveChanges(); return 0;
        });
        return (owner, project);
    }

    [Fact]
    public async Task The_endpoint_answers_for_a_project_the_person_can_open_and_only_that()
    {
        var (owner, project) = await Project();
        var res = await owner.Post("/api/v1/ai/portfolio/scenario", new { projectId = project, slipDays = 5, addPeople = 0, cutTasks = 0 });
        Assert.True(res.Ok, res.ToString());
        var d = res.Data!;
        Assert.Equal(7, d["openTasks"]!.GetValue<int>());
        Assert.Equal(7, d["finishedLast28Days"]!.GetValue<int>());
        Assert.Equal(14, d["baseline"]!["slipDays"]!.GetValue<int>());
        Assert.Equal(19, d["scenario"]!["slipDays"]!.GetValue<int>());
        Assert.Equal(5, d["changeDays"]!.GetValue<int>());
        Assert.Equal(5, d["toMeetDue"]!["cutTasks"]!.GetValue<int>());   // 9 days are left once the delay is counted: 2 tasks fit, 5 must go

        // Someone from another organization cannot ask about it, nor learn that it exists.
        var other = await TestClient.RegisterAsync(factory, "Ivan Intruder");
        await other.CreateOrgAsync();
        Assert.Equal(HttpStatusCode.NotFound, (await other.Post("/api/v1/ai/portfolio/scenario", new { projectId = project })).Status);

        // Absurd inputs are held to sensible limits instead of producing nonsense.
        var capped = (await owner.Post("/api/v1/ai/portfolio/scenario", new { projectId = project, slipDays = 99999, addPeople = -4, cutTasks = 500 })).Data!;
        Assert.Equal(365, capped["slipDays"]!.GetValue<int>());
        Assert.Equal(0, capped["addPeople"]!.GetValue<int>());
        Assert.Equal(7, capped["cutTasks"]!.GetValue<int>());
    }
}
