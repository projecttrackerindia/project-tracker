using System.Net;
using System.Text.Json.Nodes;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// The portfolio board: a project heading late becomes a decision with options and their effect; an option becomes proposals approved in
/// the project's Agent tab (a new date moves the project, scope cut goes to "Out of scope"); money against budget with a forecast and a
/// warning; who is over 100% in the next four weeks; the timeline; filters; and the export for the board meeting.
/// </summary>
[Collection("api")]
public class PortfolioBoardTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private static string Iso(DateOnly d) => d.ToString("yyyy-MM-dd");
    private static DateOnly Today => DateOnly.FromDateTime(DateTime.UtcNow);

    private async Task<(TestClient C, Guid Project, List<JsonNode> Tasks)> LateProject()
    {
        var c = await TestClient.RegisterAsync(factory, "Lead Person");
        await c.CreateOrgAsync();
        await c.UpgradeAsync("BUSINESS");
        var created = await c.Post("/api/v1/projects", new { name = "Refunds", priority = "Medium", ownerId = c.UserId, startDate = Iso(Today.AddDays(-30)), dueDate = Iso(Today.AddDays(7)) });
        Assert.True(created.Ok, created.ToString());
        var project = Guid.Parse(S(created.Data!["project"]!["id"]));
        Assert.Equal(Iso(Today.AddDays(7)), S((await c.Get($"/api/v1/projects/{project}")).Data!["project"]!["dueDate"]));
        var tasks = new List<JsonNode>();
        for (var i = 0; i < 10; i++)
            tasks.Add(await c.CreateTaskAsync(project, $"Task {i}", new { title = $"Task {i}", priority = i < 6 ? "Low" : "High", assigneeId = c.UserId, dueDate = Iso(Today.AddDays(5)), estimatedHours = 30 }));
        var done = S((await c.Get($"/api/v1/projects/{project}/statuses")).Data!.AsArray().First(s => S(s!["name"]) == "Done")!["id"]);
        for (var i = 8; i < 10; i++) await c.Send(HttpMethod.Patch, $"/api/v1/tasks/{tasks[i]["id"]}/move", new { statusId = done });
        return (c, project, tasks);
    }

    [Fact]
    public async Task A_late_project_is_a_decision_with_options_that_become_proposals()
    {
        var (c, project, tasks) = await LateProject();
        var board = (await c.Get("/api/v1/portfolio/board")).Data!;
        var decision = board["decisions"]!.AsArray().Single(d => S(d!["projectId"]) == project.ToString())!;
        Assert.Contains("finishes", S(decision["headline"]));
        Assert.True(decision["slipDays"]!.GetValue<int>() > 0);
        var options = decision["options"]!.AsArray();
        var cut = options.Single(o => S(o!["kind"]) == "cut_scope")!;
        Assert.All(cut["steps"]!.AsArray(), s => Assert.Contains("(Low)", S(s)));
        var accept = options.Single(o => S(o!["kind"]) == "accept_date")!;
        Assert.Contains("active project", S(board["summary"]));

        // Accept the new date: one proposal, approved in the Agent tab, moves the project's due date with the reason recorded.
        var applied = await c.Post($"/api/v1/portfolio/decisions/{project}/apply", new { option = "accept_date" });
        Assert.True(applied.Ok, applied.ToString());
        Assert.Equal(1, applied.Data!["proposals"]!.GetValue<int>());
        var made = applied.Data!["findingIds"]!.AsArray();   // so "Accept" on the portfolio can approve what it proposed, in one tap
        Assert.Single(made);
        Assert.Equal(409, (int)(await c.Post($"/api/v1/portfolio/decisions/{project}/apply", new { option = "cut_scope" })).Status);   // one set at a time
        var findings = (await c.Get($"/api/v1/projects/{project}/agent/findings?status=Proposed")).Data!["items"]!.AsArray();
        var date = findings.Single(f => S(f!["kind"]) == "Decision")!;
        Assert.Equal(S(made[0]), S(date["id"]));
        Assert.True((await c.Post($"/api/v1/agent/findings/{date["id"]}/approve")).Ok);
        Assert.Equal(S(accept["finish"]), S((await c.Get($"/api/v1/projects/{project}")).Data!["project"]!["dueDate"]));

        // Cutting scope: each task is a proposal; approving one moves it to a new "Out of scope" column.
        board = (await c.Get("/api/v1/portfolio/board")).Data!;
        var again = board["decisions"]!.AsArray().FirstOrDefault(d => S(d!["projectId"]) == project.ToString());
        if (again is not null && again["options"]!.AsArray().Any(o => S(o!["kind"]) == "cut_scope"))
        {
            var cutApplied = (await c.Post($"/api/v1/portfolio/decisions/{project}/apply", new { option = "cut_scope" })).Data!;
            Assert.True(cutApplied["proposals"]!.GetValue<int>() >= 1);
            var one = (await c.Get($"/api/v1/projects/{project}/agent/findings?status=Proposed")).Data!["items"]!.AsArray().First(f => S(f!["kind"]) == "UpdateTask")!;
            var approved = await c.Post($"/api/v1/agent/findings/{one["id"]}/approve");
            Assert.True(approved.Ok, approved.ToString());
            Assert.Equal("Out of scope", S((await c.Get($"/api/v1/tasks/{one["taskId"]}")).Data!["task"]!["statusName"]));
        }
    }

    [Fact]
    public async Task Money_capacity_timeline_filters_and_export()
    {
        var (c, project, tasks) = await LateProject();
        Assert.True((await c.Put($"/api/v1/resources/rates/{c.UserId}", new { weeklyCapacityHours = 40, costRate = 100 })).Ok);
        Assert.True((await c.Put($"/api/v1/resources/projects/{project}/budget", new { isBillable = false, budgetHours = 100, budgetAmount = 20000 })).Ok);
        var log = await c.Post($"/api/v1/tasks/{tasks[0]["id"]}/time", new { minutes = 600, workDate = Iso(Today.AddDays(-1)) });
        Assert.True(log.Ok, log.ToString());

        var board = (await c.Get("/api/v1/portfolio/board")).Data!;
        var money = board["money"]!;
        Assert.True(money["showMoney"]!.GetValue<bool>());
        var row = money["projects"]!.AsArray().Single(p => S(p!["projectId"]) == project.ToString())!;
        Assert.Equal(1000m, row["spent"]!.GetValue<decimal>());
        Assert.True(row["forecast"]!.GetValue<decimal>() > 20000m);   // 1,000 spent + 8 open tasks x 30 h x 100
        Assert.Contains("over the", S(row["warning"]));
        Assert.Equal(1, money["overrunning"]!.GetValue<int>());
        Assert.Equal(6, money["burn"]!.AsArray().Count);

        // 8 open tasks x 30 h due within a week: far over 100%.
        var cap = board["capacity"]!;
        var me = cap["over"]!.AsArray().Single(p => S(p!["userId"]) == c.UserId.ToString())!;
        Assert.True(me["load"]!.GetValue<int>() > 100);
        Assert.Contains(cap["projectsAtRisk"]!.AsArray(), p => S(p!["projectId"]) == project.ToString());

        // Filters: by owner, by health, and nothing for someone else.
        Assert.Contains(board["owners"]!.AsArray(), o => S(o!["id"]) == c.UserId.ToString());
        Assert.Equal(1, (await c.Get($"/api/v1/portfolio/board?ownerId={c.UserId}")).Data!["brief"]!["projects"]!.GetValue<int>());
        Assert.Equal(0, (await c.Get($"/api/v1/portfolio/board?ownerId={Guid.NewGuid()}")).Data!["brief"]!["projects"]!.GetValue<int>());
        Assert.Equal(0, (await c.Get($"/api/v1/portfolio/board?dueFrom={Iso(Today.AddDays(100))}")).Data!["brief"]!["projects"]!.GetValue<int>());

        var timeline = (await c.Get("/api/v1/portfolio/timeline")).Data!;
        var line = timeline["projects"]!.AsArray().Single(p => S(p!["id"]) == project.ToString())!;
        Assert.Equal(Iso(Today.AddDays(7)), S(line["due"]));
        Assert.NotNull(line["forecast"]);

        foreach (var (format, type) in new[] { ("xlsx", "spreadsheetml"), ("pdf", "pdf") })
        {
            using var res = await c.Raw($"/api/v1/portfolio/export?format={format}");
            Assert.Equal(HttpStatusCode.OK, res.StatusCode);
            Assert.Contains(type, res.Content.Headers.ContentType!.MediaType);
            Assert.True((await res.Content.ReadAsByteArrayAsync()).Length > 500);
        }
        Assert.Equal(422, (int)(await c.Get("/api/v1/portfolio/export?format=csv")).Status);
    }
}
