using System.Diagnostics;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;
using Xunit.Abstractions;

namespace ProjectManagement.Tests;

/// <summary>
/// How the screens behave with a large organization: many teams, projects and tasks, seen by a leader (everything) and by a team member
/// (only their team, through the data-layer filters). Not part of the normal run - it takes a minute and is only meaningful on PostgreSQL:
///   PM_SCALE=1 PM_TEST_POSTGRES="Host=127.0.0.1;Port=5433;Username=postgres" dotnet test --filter ScaleTests
/// Prints the time of each screen's main request and fails if one is slower than a generous bound.
/// </summary>
[Collection("api")]
public class ScaleTests(ApiFactory factory, ITestOutputHelper output)
{
    private static int Env(string name, int fallback) => int.TryParse(Environment.GetEnvironmentVariable(name), out var v) ? v : fallback;

    [Fact]
    public async Task A_large_organization_stays_fast_for_leaders_and_for_team_members()
    {
        if (Environment.GetEnvironmentVariable("PM_SCALE") is null) return;
        int teams = Env("PM_SCALE_TEAMS", 10), projectsPerTeam = Env("PM_SCALE_PROJECTS", 100), tasksPerProject = Env("PM_SCALE_TASKS", 150);

        var owner = await TestClient.RegisterAsync(factory, "Scale Owner");
        await owner.CreateOrgAsync("Scale Org");
        await owner.UpgradeAsync("BUSINESS");
        var people = new List<TestClient>();
        for (var i = 0; i < teams; i++) people.Add(await owner.AddMemberAsync(factory, TenantRole.Member, $"Member {i}"));
        var teamIds = new List<Guid>();
        for (var i = 0; i < teams; i++)
        {
            var made = await owner.Post("/api/v1/teams", new { name = $"Team {i}" });
            teamIds.Add(Guid.Parse(made.Data!["team"]!["id"]!.GetValue<string>()));
            await owner.Post($"/api/v1/teams/{teamIds[i]}/members", new { userId = people[i].UserId, isLead = true });
        }
        var template = await owner.CreateProjectAsync("Template");
        await owner.CreateTaskAsync(template, "Template task");

        // Clone the template into teams x projects x tasks directly in the database (the API would take hours for this many rows).
        var sw = Stopwatch.StartNew();
        factory.WithDb(db =>
        {
            db.ChangeTracker.AutoDetectChangesEnabled = false;
            var tid = owner.WorkspaceId;
            var proj = db.Projects.IgnoreQueryFilters().Single(p => p.Id == template);
            var statuses = db.WorkflowStatuses.IgnoreQueryFilters().Where(s => s.ProjectId == template).ToList();
            var rnd = new Random(7);
            var key = 0;
            for (var t = 0; t < teams; t++)
                for (var p = 0; p < projectsPerTeam; p++)
                {
                    var np = new Project(); db.Entry(np).CurrentValues.SetValues(proj);
                    np.Id = Guid.NewGuid(); np.Key = $"S{key++}"; np.Name = $"Scale project {t}-{p}"; np.TeamId = teamIds[t]; np.Position = key;
                    db.Projects.Add(np);
                    var map = new Dictionary<Guid, Guid>();
                    foreach (var s in statuses) { var ns = new WorkflowStatus(); db.Entry(ns).CurrentValues.SetValues(s); ns.Id = Guid.NewGuid(); ns.ProjectId = np.Id; map[s.Id] = ns.Id; db.WorkflowStatuses.Add(ns); }
                    var ids = map.Values.ToArray();
                    for (var n = 1; n <= tasksPerProject; n++)
                    {
                        var st = statuses[rnd.Next(statuses.Count)];
                        db.Tasks.Add(new TaskItem
                        {
                            TenantId = tid, ProjectId = np.Id, Number = n, Title = $"Task {n} of {np.Name}", StatusId = map[st.Id], Priority = (Priority)rnd.Next(4),
                            AssigneeId = people[rnd.Next(people.Count)].UserId, ReporterId = owner.UserId, DueDate = DateOnly.FromDateTime(DateTime.UtcNow.AddDays(rnd.Next(-20, 60))),
                            Position = n * 1000, CreatedAt = DateTime.UtcNow, CompletedAt = st.Category == StatusCategory.Done ? DateTime.UtcNow.AddDays(-rnd.Next(0, 25)) : null,
                        });
                    }
                    if (key % 100 == 0) { db.SaveChanges(); db.ChangeTracker.Clear(); db.ChangeTracker.AutoDetectChangesEnabled = false; proj = db.Projects.IgnoreQueryFilters().Single(x => x.Id == template); statuses = db.WorkflowStatuses.IgnoreQueryFilters().Where(s => s.ProjectId == template).ToList(); }
                }
            db.SaveChanges();
            return 0;
        });
        output.WriteLine($"seeded {teams * projectsPerTeam} projects and {teams * projectsPerTeam * tasksPerProject} tasks in {sw.Elapsed.TotalSeconds:F1}s");
        factory.WithDb(db => { db.Database.ExecuteSqlRaw(db.Database.IsNpgsql() ? "ANALYZE" : "ANALYZE"); return 0; });

        var one = people[0];
        var firstProject = factory.WithDb(db => db.Projects.IgnoreQueryFilters().First(p => p.TeamId == teamIds[0]).Id);
        var slow = new List<string>();
        async Task Time(string who, TestClient c, string url, int limitMs)
        {
            await c.Get(url);                                       // warm-up (query plans, JIT)
            var t = Stopwatch.StartNew(); var res = await c.Get(url); t.Stop();
            output.WriteLine($"{who,-22} {url,-46} {(int)res.Status} {t.ElapsedMilliseconds,5} ms");
            if ((!res.Ok && res.Status != System.Net.HttpStatusCode.Forbidden) || t.ElapsedMilliseconds > limitMs) slow.Add($"{who} {url}: {res.Status} {t.ElapsedMilliseconds} ms");
        }
        var urls = new[] { "/api/v1/dashboard", "/api/v1/projects?pageSize=50", "/api/v1/project-status/groups", "/api/v1/ai/portfolio/brief", "/api/v1/reports/summary?days=30", "/api/v1/my-work", "/api/v1/calendar?from=2026-10-01&to=2026-10-31", $"/api/v1/projects/{firstProject}/tasks", "/api/v1/workload", "/api/v1/lens/teams" };

        // Everyone sees everything (the default).
        foreach (var u in urls) await Time("leader, all teams", owner, u, 8000);
        owner.TeamLens = teamIds[0];
        foreach (var u in urls.Take(6)) await Time("leader, one team", owner, u, 8000);
        owner.TeamLens = null;
        // Teams are separate: a member's queries go through the team filters.
        Assert.True((await owner.Put("/api/v1/workspace/project-visibility", new { mode = "teams" })).Ok);
        foreach (var u in urls) await Time("member, own team", one, u, 8000);

        Assert.True(slow.Count == 0, string.Join("\n", slow));
    }
}
