using System.Net;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.Routing.Patterns;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// A workspace may limit people to the projects of their own teams. Then a person in one team learns nothing about another team's projects,
/// tasks or anything that hangs off them - on any screen, report, search or assistant answer - and the rule is enforced once, in the data
/// layer. The crawl below is the safety net: it calls every readable endpoint of the API as a person of team A while team B's secrets exist,
/// and fails if a single response mentions one.
/// </summary>
[Collection("api")]
public class TeamScopeTests(ApiFactory factory)
{
    private const string Secret = "BRAVO-SECRET";

    private sealed record Setup(TestClient Owner, TestClient Alice, TestClient Bob, TestClient Carol, TestClient Dave, Guid ProjectA, Guid ProjectB, Guid TaskA, Guid TaskB, Guid TeamA, Guid TeamB, List<string> HiddenIds);

    private static string S(System.Text.Json.Nodes.JsonNode? n) => n!.GetValue<string>();

    private async Task<Setup> Seed(bool teamsMode = true)
    {
        var owner = await TestClient.RegisterAsync(factory, "Olivia Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var alice = await owner.AddMemberAsync(factory, TenantRole.Member, "Alice Alpha");
        var bob = await owner.AddMemberAsync(factory, TenantRole.Member, "Bob Bravo");
        var carol = await owner.AddMemberAsync(factory, TenantRole.Manager, "Carol Alpha");
        var dave = await owner.AddMemberAsync(factory, TenantRole.Member, "Dave Nobody");
        var teamA = Guid.Parse(S((await owner.Post("/api/v1/teams", new { name = "Alpha team" })).Data!["team"]!["id"]));
        var teamB = Guid.Parse(S((await owner.Post("/api/v1/teams", new { name = "Bravo team" })).Data!["team"]!["id"]));
        foreach (var (team, who) in new[] { (teamA, alice), (teamA, carol), (teamB, bob) })
            Assert.True((await owner.Post($"/api/v1/teams/{team}/members", new { userId = who.UserId, isLead = false })).Ok);

        async Task<Guid> Project(string name, Guid team, TestClient? creator = null)
        {
            var res = await (creator ?? owner).Post("/api/v1/projects", new { name, priority = "High", teamId = team, status = "Active", startDate = "2026-09-01", dueDate = "2026-12-01" });
            Assert.True(res.Ok, res.ToString());
            return Guid.Parse(S(res.Data!["project"]!["id"]));
        }
        var projectA = await Project("Alpha Programme", teamA);
        var projectB = await Project($"{Secret} Programme", teamB);
        var taskA = Guid.Parse(S((await owner.CreateTaskAsync(projectA, "Alpha task"))["id"]));
        var tb = await owner.CreateTaskAsync(projectB, $"{Secret} task", new { title = $"{Secret} task", priority = "High", dueDate = "2026-09-20", assigneeId = bob.UserId });
        var taskB = Guid.Parse(S(tb["id"]));
        var hidden = new List<string> { projectB.ToString(), taskB.ToString() };

        var comment = await owner.Post($"/api/v1/tasks/{taskB}/comments", new { body = $"{Secret} comment" });
        if (comment.Ok) hidden.Add(S(comment.Data!["id"]));
        var milestone = await owner.Post($"/api/v1/projects/{projectB}/milestones", new { name = $"{Secret} milestone", dueDate = "2026-10-15", status = "Pending" });
        if (milestone.Ok) hidden.Add(S(milestone.Data![0]!["id"]));
        var sprint = await owner.Post($"/api/v1/projects/{projectB}/sprints", new { name = $"{Secret} sprint", goal = "secret goal", startDate = "2026-10-01", endDate = "2026-10-14" });
        if (sprint.Ok) hidden.Add(S(sprint.Data!["id"]));
        var action = await owner.Post($"/api/v1/projects/{projectB}/action-items", new { title = $"{Secret} action", assigneeId = bob.UserId, dueDate = "2026-09-25", priority = "High" });
        if (action.Ok) hidden.Add(S(action.Data!["id"]));
        await owner.Post("/api/v1/work-tasks", new { title = $"{Secret} operational", relatedProjectId = projectB });
        var issue = await owner.Post($"/api/v1/projects/{projectB}/issues", new { title = $"{Secret} issue", details = "secret details", severity = "High" });
        if (issue.Ok) hidden.Add(S(issue.Data!["id"] ?? issue.Data["issue"]?["id"]));
        var logged = await bob.Post($"/api/v1/tasks/{taskB}/time", new { minutes = 45, note = "worked on it" });
        if (logged.Ok) hidden.Add(S(logged.Data!["id"]));
        var chats = await bob.Get("/api/v1/chat/conversations");
        foreach (var c in chats.Data?.AsArray() ?? []) if (c?["id"] is { } cid) hidden.Add(S(cid));

        if (teamsMode) Assert.True((await owner.Put("/api/v1/workspace/project-visibility", new { mode = "teams" })).Ok);
        return new Setup(owner, alice, bob, carol, dave, projectA, projectB, taskA, taskB, teamA, teamB, hidden);
    }

    [Fact]
    public async Task People_see_their_own_teams_projects_and_not_another_teams()
    {
        var s = await Seed();
        // Before the setting nothing changes for anyone: the default is the whole organization.
        async Task<string[]> Names(TestClient c) => (await c.Get("/api/v1/projects?pageSize=50")).Data!["items"]!.AsArray().Select(p => S(p!["name"])).OrderBy(n => n).ToArray();

        Assert.Equal(["Alpha Programme"], await Names(s.Alice));
        Assert.Equal([$"{Secret} Programme"], await Names(s.Bob));
        Assert.Empty(await Names(s.Dave));                                    // in no team and added to nothing
        Assert.Equal(2, (await Names(s.Owner)).Length);                        // owners see everything
        Assert.Equal(HttpStatusCode.NotFound, (await s.Alice.Get($"/api/v1/projects/{s.ProjectB}")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await s.Alice.Get($"/api/v1/tasks/{s.TaskB}")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await s.Alice.Get($"/api/v1/project-status/projects/{s.ProjectB}")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await s.Alice.Post($"/api/v1/projects/{s.ProjectB}/tasks", new { title = "intruder", priority = "Low" })).Status);

        // Being added to the project is enough, whichever team the person is in.
        Assert.True((await s.Owner.Post($"/api/v1/projects/{s.ProjectB}/members", new { userId = s.Dave.UserId })).Ok);
        Assert.Equal([$"{Secret} Programme"], await Names(s.Dave));
        // A job-level exception: the Manager role is switched to "see every team's projects".
        Assert.Equal(["Alpha Programme"], await Names(s.Carol));
        var set = await s.Owner.Put("/api/v1/workspace/permissions", new { role = "Manager", permission = "projects.viewall", allowed = true });
        Assert.True(set.Ok, set.ToString());
        Assert.Equal(2, (await Names(s.Carol)).Length);
        // And back to the whole organization.
        Assert.True((await s.Owner.Put("/api/v1/workspace/project-visibility", new { mode = "organization" })).Ok);
        Assert.Equal(2, (await Names(s.Alice)).Length);
        Assert.Equal(HttpStatusCode.Forbidden, (await s.Alice.Put("/api/v1/workspace/project-visibility", new { mode = "teams" })).Status);   // only owners and admins decide
    }

    [Fact]
    public async Task Every_readable_endpoint_keeps_another_teams_work_out_of_a_team_members_answers()
    {
        var (leaks, asked) = await Crawl(await Seed());
        Assert.True(asked > 200, $"only {asked} requests were made");
        Assert.Empty(leaks);
    }

    /// <summary>The control: with the limit off the same crawl finds the secrets, so an empty result above means something.</summary>
    [Fact]
    public async Task The_crawl_does_find_the_secrets_when_the_workspace_is_not_limited_to_teams()
    {
        var (leaks, _) = await Crawl(await Seed(teamsMode: false));
        Assert.True(leaks.Count > 5, $"the crawl only noticed {leaks.Count} mentions");
    }

    private async Task<(List<string> Leaks, int Asked)> Crawl(Setup s)
    {
        var data = factory.Services.GetServices<EndpointDataSource>().SelectMany(d => d.Endpoints).OfType<RouteEndpoint>();
        var routes = data
            .Where(e => e.Metadata.GetMetadata<Microsoft.AspNetCore.Routing.HttpMethodMetadata>()?.HttpMethods.Contains("GET") == true)
            .Select(e => e.RoutePattern.RawText!)
            .Where(r => r.StartsWith("api/v1/") && !Regex.IsMatch(r, "^api/v1/(admin|platform|dev|auth|webhooks|push|billing|invitations|reminder-actions|consent)")
                        && !r.Contains("{**") && !r.Contains("export") && !r.Contains("download") && !r.Contains("content"))
            .Distinct().OrderBy(r => r).ToList();
        Assert.True(routes.Count > 40, $"only {routes.Count} routes found");

        var leaks = new List<string>();
        var asked = 0;
        async Task Probe(TestClient who, string url)
        {
            asked++;
            var res = await who.Get(url);
            var body = res.Data?.ToJsonString() ?? res.ToString();
            if (body.Contains(Secret, StringComparison.OrdinalIgnoreCase))
                leaks.Add($"{who.Email} GET /{url} → {(int)res.Status}: contains {Secret}");
            if (res.Status == HttpStatusCode.InternalServerError) leaks.Add($"GET /{url} → 500");
        }

        foreach (var who in new[] { s.Alice, s.Dave })
            foreach (var route in routes)
            {
                var parameters = Regex.Matches(route, @"\{(\w+)(:[^}]*)?\}").Select(m => m.Value).Distinct().ToList();
                if (parameters.Count == 0) { await Probe(who, route); continue; }
                foreach (var id in s.HiddenIds)
                {
                    var url = route;
                    foreach (var p in parameters) url = url.Replace(p, Regex.IsMatch(p, "(?i)guid|id") ? id : "x");
                    await Probe(who, url);
                }
            }
        // Common list screens with the filters people actually use.
        foreach (var url in new[] { "api/v1/projects?pageSize=100", $"api/v1/projects?teamId={s.TeamB}", "api/v1/work-tasks?pageSize=100", "api/v1/my-work", "api/v1/me/work", "api/v1/reports/summary", "api/v1/project-status/overview", "api/v1/project-status", "api/v1/ai/portfolio/brief", "api/v1/ai/insights", "api/v1/chat/conversations", "api/v1/notifications", "api/v1/reminders", $"api/v1/search?q={Secret}", $"api/v1/projects?q={Secret}" })
            foreach (var who in new[] { s.Alice, s.Dave }) await Probe(who, url);
        return (leaks, asked);
    }

    [Fact]
    public async Task Giving_someone_from_another_team_a_task_shares_the_project_with_them_and_nothing_else()
    {
        var s = await Seed();
        Assert.Equal(HttpStatusCode.NotFound, (await s.Bob.Get($"/api/v1/projects/{s.ProjectA}")).Status);
        var task = await s.Alice.Post($"/api/v1/projects/{s.ProjectA}/tasks", new { title = "Review the Alpha design", priority = "Medium", assigneeId = s.Bob.UserId });
        Assert.True(task.Ok, task.ToString());
        Assert.True((await s.Bob.Get($"/api/v1/projects/{s.ProjectA}")).Ok);                      // the project they were given work on
        Assert.Equal(HttpStatusCode.NotFound, (await s.Dave.Get($"/api/v1/projects/{s.ProjectA}")).Status);   // nobody else is affected
        Assert.Equal(HttpStatusCode.NotFound, (await s.Alice.Get($"/api/v1/projects/{s.ProjectB}")).Status);
    }
}
