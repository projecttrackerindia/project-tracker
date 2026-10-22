using System.Net;
using ProjectManagement.Application.Features.Tasks;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Suggestions for a new task come from finished work in the workspace, with the facts behind them, and no model call.</summary>
[Collection("api")]
public class TaskSuggestionTests(ApiFactory factory)
{
    [Fact]
    public async Task Similar_finished_work_gives_an_estimate_range_a_due_date_and_ranked_people()
    {
        var owner = await TestClient.RegisterAsync(factory, "Priya Planner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var pid = (await owner.CreateProjectAsync("Payments")).ToString();
        var done = (await owner.Get($"/api/v1/projects/{pid}/statuses")).Data?.AsArray().FirstOrDefault(x => x!["category"]?.GetValue<string>() == "Done")?["id"]?.GetValue<string>();

        foreach (var (title, hours) in new[] { ("Bank statement API integration", 5m), ("CIBIL report API integration", 7m), ("UPI refund API integration", 9m), ("Office party", 2m) })
        {
            var t = await owner.Post($"/api/v1/projects/{pid}/tasks", new { title, priority = "High", estimatedHours = hours });
            Assert.True(t.Ok, t.ToString());
            if (done is not null)
            {
                var id = t.Data!["id"]!.GetValue<string>();
                var moved = await owner.Put($"/api/v1/tasks/{id}", new { title, statusId = done, priority = "High", estimatedHours = hours, actualHours = hours, version = t.Data["version"]!.GetValue<int>() });
                Assert.True(moved.Ok, moved.ToString());
            }
        }

        var s = await owner.Get($"/api/v1/projects/{pid}/tasks/suggest?title={Uri.EscapeDataString("CRIF HIGHMARK API integration")}");
        Assert.True(s.Ok, s.ToString());
        var d = s.Data!;
        Assert.NotEmpty(d["assignees"]!.AsArray());
        if (done is not null)
        {
            Assert.Equal(3, d["similar"]!.AsArray().Count);                       // the three API integrations, not the office party
            Assert.Equal(7m, d["estimate"]!.GetValue<decimal>());
            Assert.Contains("5, 7, 9", d["estimateWhy"]!.GetValue<string>());
            Assert.NotNull(d["dueDate"]);
            Assert.Equal("High", d["priority"]!.GetValue<string>());
        }
    }

    [Fact]
    public async Task Another_workspace_cannot_ask_for_suggestions_on_a_project_it_cannot_see()
    {
        var owner = await TestClient.RegisterAsync(factory, "Ana Owner");
        await owner.CreateOrgAsync();
        var pid = await owner.CreateProjectAsync("Secret");
        var stranger = await TestClient.RegisterAsync(factory, "Sam Stranger");
        await stranger.CreateOrgAsync();
        var res = await stranger.Get($"/api/v1/projects/{pid}/tasks/suggest?title=anything");
        Assert.Equal(HttpStatusCode.NotFound, res.Status);
    }

    [Fact]
    public void Working_days_skip_the_weekend()
    {
        var friday = new DateOnly(2026, 10, 23);
        Assert.Equal(new DateOnly(2026, 10, 26), TaskSuggestionService.AddWorkingDays(friday, 1));
        Assert.Equal(new DateOnly(2026, 10, 30), TaskSuggestionService.AddWorkingDays(friday, 5));
    }
}
