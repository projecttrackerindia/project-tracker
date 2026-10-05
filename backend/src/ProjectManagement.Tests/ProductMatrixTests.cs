using System.Net;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// The product as a whole across its dimensions: every plan, several organizations side by side, every access level, teams, and
/// both project-visibility modes. One crawl calls every readable endpoint as every person and fails on a server error, on anything of another
/// organization, and (where teams are separate) on anything of another team. This is the safety net for changes that touch many screens.
/// </summary>
[Collection("api")]
public class ProductMatrixTests(ApiFactory factory)
{
    private static string S(System.Text.Json.Nodes.JsonNode? n) => n!.GetValue<string>();

    private sealed record Org(string Plan, string Marker, TestClient Owner, List<(TenantRole Role, TestClient Client)> People, Guid? TeamA, Guid? TeamB, Guid ProjectA, Guid? ProjectB, List<string> HiddenIds);

    private async Task<Org> Build(string plan, string marker)
    {
        var owner = await TestClient.RegisterAsync(factory, $"Owner {marker}");
        await owner.CreateOrgAsync($"Org {marker}");
        if (plan == "ENTERPRISE")   // custom-priced: sales sets it up, so the test does too
            factory.WithDb(db =>
            {
                var enterprise = db.Plans.Single(x => x.Code == "ENTERPRISE");
                var sub = db.Subscriptions.Single(x => x.TenantId == owner.WorkspaceId);
                sub.PlanId = enterprise.Id; sub.Status = SubscriptionStatus.Active; db.SaveChanges(); return 0;
            });
        else if (plan != "FREE") await owner.UpgradeAsync(plan);
        var people = new List<(TenantRole, TestClient)> { (TenantRole.Owner, owner) };
        if (plan != "FREE")
            foreach (var role in new[] { TenantRole.Admin, TenantRole.Manager, TenantRole.Member, TenantRole.Guest })
                people.Add((role, await owner.AddMemberAsync(factory, role, $"{role} {marker}")));

        // Teams where the plan allows them (Free allows one).
        Guid? teamA = null, teamB = null;
        var a = await owner.Post("/api/v1/teams", new { name = $"{marker} Alpha" });
        if (a.Ok) teamA = Guid.Parse(S(a.Data!["team"]!["id"]));
        var b = await owner.Post("/api/v1/teams", new { name = $"{marker} Bravo" });
        if (b.Ok) teamB = Guid.Parse(S(b.Data!["team"]!["id"]));
        if (plan == "FREE") Assert.False(b.Ok, "the Free plan allows one team only");
        else
        {
            Assert.True(a.Ok && b.Ok, $"{plan}: two teams should be allowed");
            var members = people.Where(p => p.Item1 is TenantRole.Manager or TenantRole.Member).ToList();
            await owner.Post($"/api/v1/teams/{teamA}/members", new { userId = members[0].Item2.UserId, isLead = true });
            await owner.Post($"/api/v1/teams/{teamB}/members", new { userId = members[1].Item2.UserId, isLead = true });
        }

        async Task<Guid> Project(string name, Guid? team)
        {
            var res = await owner.Post("/api/v1/projects", new { name, priority = "High", teamId = team, status = "Active", startDate = "2026-09-01", dueDate = "2026-12-01" });
            Assert.True(res.Ok, res.ToString());
            return Guid.Parse(S(res.Data!["project"]!["id"]));
        }
        var projectA = await Project($"{marker} Programme A", teamA);
        Guid? projectB = plan == "FREE" ? null : await Project($"{marker} Programme B", teamB);
        var hidden = new List<string> { projectA.ToString() };
        var t = await owner.CreateTaskAsync(projectA, $"{marker} task", new { title = $"{marker} task", priority = "High", dueDate = "2026-09-20" });
        hidden.Add(S(t["id"]));
        if (projectB is { } pb)
        {
            var tb = await owner.CreateTaskAsync(pb, $"{marker} bravo task", new { title = $"{marker} bravo task", priority = "High" });
            hidden.Add(pb.ToString()); hidden.Add(S(tb["id"]));
            await owner.Post($"/api/v1/projects/{pb}/action-items", new { title = $"{marker} bravo action", dueDate = "2026-09-25", priority = "High" });
        }
        await owner.Post("/api/v1/work-tasks", new { title = $"{marker} operational" });
        return new Org(plan, marker, owner, people, teamA, teamB, projectA, projectB, hidden);
    }

    private List<string> Routes()
    {
        var endpoints = factory.Services.GetServices<EndpointDataSource>().SelectMany(d => d.Endpoints).OfType<RouteEndpoint>();
        return endpoints
            .Where(e => e.Metadata.GetMetadata<HttpMethodMetadata>()?.HttpMethods.Contains("GET") == true)
            .Select(e => e.RoutePattern.RawText!)
            .Where(r => r.StartsWith("api/v1/") && !Regex.IsMatch(r, "^api/v1/(admin|platform|dev|auth|webhooks|push|invitations|reminder-actions|consent|me/)") && !r.Contains('{') && !r.Contains("export") && !r.Contains("download") && !r.Contains("content"))
            .Distinct().OrderBy(r => r).ToList();
    }

    private async Task Sweep(IEnumerable<(string Who, TestClient Client)> people, IReadOnlyCollection<string> routes, IReadOnlyCollection<string> foreign, List<string> problems, Func<string, bool>? skip = null)
    {
        foreach (var (who, client) in people)
            foreach (var route in routes)
            {
                var res = await client.Get(route);
                var body = res.Data?.ToJsonString() ?? "";
                if (res.Status == HttpStatusCode.InternalServerError) problems.Add($"{who} GET /{route} → 500");
                foreach (var f in foreign) if (body.Contains(f, StringComparison.OrdinalIgnoreCase)) problems.Add($"{who} GET /{route} shows {f}");
            }
    }

    [Fact]
    public async Task Every_plan_and_role_gets_working_screens_and_never_sees_another_organization_or_another_team()
    {
        var plans = new[] { "FREE", "PRO", "BUSINESS", "ENTERPRISE" };
        var orgs = new List<Org>();
        foreach (var plan in plans) orgs.Add(await Build(plan, $"ZEBRA{plan[..3]}{Guid.NewGuid():N}"[..14]));
        var routes = Routes();
        Assert.True(routes.Count > 40, $"only {routes.Count} routes");
        var problems = new List<string>();

        // 1. Organizations side by side: nobody sees another organization's markers, whatever the plan, role or visibility mode.
        foreach (var mode in new[] { "organization", "teams" })
        {
            foreach (var org in orgs.Where(o => o.Plan != "FREE")) Assert.True((await org.Owner.Put("/api/v1/workspace/project-visibility", new { mode })).Ok);
            foreach (var org in orgs)
            {
                var foreign = orgs.Where(o => o != org).Select(o => o.Marker).ToList();
                await Sweep(org.People.Select(p => ($"{org.Plan}/{p.Role}/{mode}", p.Client)), routes, foreign, problems);
            }
        }

        // 2. Another organization's ids are not addressable either.
        var probe = new[] { "projects/{0}", "tasks/{0}", "project-status/projects/{0}", "projects/{0}/tasks", "projects/{0}/action-items", "tasks/{0}/comments" };
        foreach (var org in orgs)
            foreach (var other in orgs.Where(o => o != org))
                foreach (var id in other.HiddenIds.Take(3))
                    foreach (var p in probe)
                    {
                        var res = await org.Owner.Get($"/api/v1/{string.Format(p, id)}");
                        if (res.Ok && (res.Data?.ToJsonString().Contains(other.Marker, StringComparison.OrdinalIgnoreCase) ?? false)) problems.Add($"{org.Plan} reads {other.Plan}'s {p}");
                        if (res.Status == HttpStatusCode.InternalServerError) problems.Add($"{org.Plan} GET {p} → 500");
                    }

        // 3. Where teams are separate, a team member sees nothing of the other team, with or without the lens.
        foreach (var org in orgs.Where(o => o.Plan != "FREE"))
        {
            Assert.True((await org.Owner.Put("/api/v1/workspace/project-visibility", new { mode = "teams" })).Ok);
            var alpha = org.People.First(p => p.Role == TenantRole.Manager).Client;     // lead of Alpha
            var bravo = org.People.First(p => p.Role == TenantRole.Member).Client;      // lead of Bravo
            foreach (var lens in new Guid?[] { null, org.TeamA, org.TeamB })
            {
                alpha.TeamLens = lens;
                await Sweep([($"{org.Plan}/alpha lead/lens {lens}", alpha)], routes, [$"{org.Marker} Programme B", $"{org.Marker} bravo task", $"{org.Marker} bravo action"], problems);   // team names are a directory everyone may see; the work is not
            }
            alpha.TeamLens = null;
            Assert.Equal(HttpStatusCode.NotFound, (await alpha.Get($"/api/v1/projects/{org.ProjectB}")).Status);
            Assert.True((await bravo.Get($"/api/v1/projects/{org.ProjectB}")).Ok);
            var guest = org.People.First(p => p.Role == TenantRole.Guest).Client;
            Assert.Empty((await guest.Get("/api/v1/projects?pageSize=50")).Data!["items"]!.AsArray());
        }

        Assert.True(problems.Count == 0, string.Join("\n", problems.Distinct().Take(25)));
    }

    [Fact]
    public async Task One_person_in_two_organizations_sees_each_organization_separately_and_a_team_of_one_does_not_exist_in_the_other()
    {
        var a = await Build("BUSINESS", $"AMBER{Guid.NewGuid():N}"[..12]);
        var b = await Build("PRO", $"BASIL{Guid.NewGuid():N}"[..12]);
        // The owner of A is invited to B as a Member and uses both.
        var shared = a.Owner;
        var inv = await b.Owner.Post("/api/v1/workspace/invitations", new { email = shared.Email, role = "Member" });
        Assert.True(inv.Ok, inv.ToString());
        var token = await shared.MailboxToken("invite");
        Assert.True((await shared.Post("/api/v1/invitations/accept", new { token })).Ok);

        async Task<string[]> Names() => (await shared.Get("/api/v1/projects?pageSize=50")).Data!["items"]!.AsArray().Select(p => S(p!["name"])).ToArray();
        await shared.SwitchToAsync(a.Owner.WorkspaceId);
        Assert.All(await Names(), n => Assert.Contains(a.Marker, n));
        await shared.SwitchToAsync(b.Owner.WorkspaceId);
        var inB = await Names();
        Assert.All(inB, n => Assert.Contains(b.Marker, n));

        // A team of the other organization is not a team here: the lens ignores it and the dashboard refuses it.
        shared.TeamLens = a.TeamA;
        Assert.Equal(inB.Length, (await Names()).Length);
        Assert.Equal(HttpStatusCode.NotFound, (await shared.Get($"/api/v1/dashboard?teamId={a.TeamA}")).Status);
        shared.TeamLens = null;
    }
}
