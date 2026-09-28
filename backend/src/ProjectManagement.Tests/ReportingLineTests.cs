using System.Net;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Managers see the work of the people who report to them in the organization chart (read-only).</summary>
[Collection("api")]
public class ReportingLineTests(ApiFactory factory)
{
    /// <summary>owner ── director ── lead ── dev1 / dev2, plus a peer who is outside the line.</summary>
    private record Org(TestClient Owner, TestClient Director, TestClient Lead, TestClient Dev1, TestClient Dev2, TestClient Peer, Guid Project);

    private async Task<Org> Build()
    {
        var owner = await TestClient.RegisterAsync(factory);
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var director = await owner.AddMemberAsync(factory, TenantRole.Member, "Director");
        var lead = await owner.AddMemberAsync(factory, TenantRole.Member, "Lead");
        var dev1 = await owner.AddMemberAsync(factory, TenantRole.Member, "Dev One");
        var dev2 = await owner.AddMemberAsync(factory, TenantRole.Member, "Dev Two");
        var peer = await owner.AddMemberAsync(factory, TenantRole.Member, "Peer");
        await Report(owner, lead, director); await Report(owner, dev1, lead); await Report(owner, dev2, lead);
        return new Org(owner, director, lead, dev1, dev2, peer, await owner.CreateProjectAsync("Atlas"));
    }

    private static async Task Report(TestClient owner, TestClient person, TestClient? boss)
    {
        var res = await owner.Put($"/api/v1/org/members/{person.UserId}/reports-to", new { reportsToUserId = boss?.UserId });
        Assert.Equal(HttpStatusCode.NoContent, res.Status);
    }

    private static async Task Assign(TestClient owner, Guid project, string title, TestClient who, string? due = null, string status = "Yet To Start")
    {
        var task = await owner.CreateTaskAsync(project, title, new { title, priority = "Medium", assigneeId = who.UserId, dueDate = due });
        if (status != "Yet To Start")
        {
            var statuses = (await owner.Get($"/api/v1/projects/{project}/statuses")).Data!.AsArray();
            var id = statuses.First(s => s!["name"]!.GetValue<string>() == status)!["id"]!.GetValue<string>();
            Assert.True((await owner.Send(HttpMethod.Patch, $"/api/v1/tasks/{task["id"]}/move", new { statusId = id })).Ok);
        }
    }

    [Fact]
    public async Task A_manager_sees_direct_and_indirect_reports_with_their_workload()
    {
        var o = await Build();
        var yesterday = DateTime.UtcNow.AddDays(-2).ToString("yyyy-MM-dd");
        await Assign(o.Owner, o.Project, "Late one", o.Dev1, yesterday);
        await Assign(o.Owner, o.Project, "Fine one", o.Dev1);
        await Assign(o.Owner, o.Project, "Stuck", o.Dev2, null, "In Progress");
        await Assign(o.Owner, o.Project, "Finished", o.Dev2, null, "Done");
        await Assign(o.Owner, o.Project, "Not mine to see", o.Peer);

        var team = (await o.Director.Get("/api/v1/my-team")).Data!;
        var people = team["members"]!.AsArray().ToDictionary(m => m!["name"]!.GetValue<string>(), m => m!);
        Assert.Equal(new[] { "Dev One", "Dev Two", "Lead" }, people.Keys.OrderBy(x => x));    // Peer is not in the director's line
        Assert.Equal(1, people["Lead"]["level"]!.GetValue<int>());
        Assert.Equal(2, people["Dev One"]["level"]!.GetValue<int>());
        Assert.Equal("Lead", people["Dev One"]["reportsTo"]!.GetValue<string>());
        Assert.Equal(2, people["Dev One"]["open"]!.GetValue<int>());
        Assert.Equal(1, people["Dev One"]["overdue"]!.GetValue<int>());
        Assert.Equal(1, people["Dev Two"]["open"]!.GetValue<int>());
        Assert.Null(people["Dev Two"]["blocked"]);   // there is no Blocked status any more
        Assert.Null(team["totals"]!["blocked"]);
        Assert.Equal(1, people["Dev Two"]["doneLast30Days"]!.GetValue<int>());
        Assert.Equal("Late one", people["Dev One"]["nextUp"]![0]!["title"]!.GetValue<string>()); // most urgent first
        Assert.Equal(3, team["totals"]!["people"]!.GetValue<int>());
        Assert.Equal(3, team["totals"]!["open"]!.GetValue<int>());

        // The lead only sees their own two developers.
        Assert.Equal(2, (await o.Lead.Get("/api/v1/my-team")).Data!["members"]!.AsArray().Count);
    }

    [Fact]
    public async Task People_without_reports_see_an_empty_team_and_cannot_look_at_others()
    {
        var o = await Build();
        Assert.Empty((await o.Dev1.Get("/api/v1/my-team")).Data!["members"]!.AsArray());
        // A peer, a boss (upwards) and a stranger are not "my reports".
        Assert.Equal(HttpStatusCode.NotFound, (await o.Peer.Get($"/api/v1/my-team/{o.Dev1.UserId}")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await o.Dev1.Get($"/api/v1/my-team/{o.Lead.UserId}")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await o.Lead.Get($"/api/v1/my-team/{o.Director.UserId}")).Status);
    }

    [Fact]
    public async Task A_manager_can_open_one_report_and_sees_all_their_open_tasks()
    {
        var o = await Build();
        for (var i = 0; i < 7; i++) await Assign(o.Owner, o.Project, $"Task {i}", o.Dev1);
        var person = (await o.Director.Get($"/api/v1/my-team/{o.Dev1.UserId}")).Data!;
        Assert.Equal("Dev One", person["person"]!["name"]!.GetValue<string>());
        Assert.Equal(7, person["openTasks"]!.AsArray().Count);          // the summary card shows 5; the detail shows everything
        Assert.Equal(5, person["person"]!["nextUp"]!.AsArray().Count);
        Assert.Equal("Atlas", person["openTasks"]![0]!["projectName"]!.GetValue<string>());
    }

    [Fact]
    public async Task Following_the_line_survives_moves_and_cannot_loop()
    {
        var o = await Build();
        // Move the lead under the peer: the director no longer sees the lead's people, the peer now does.
        await Report(o.Owner, o.Lead, o.Peer);
        Assert.Empty((await o.Director.Get("/api/v1/my-team")).Data!["members"]!.AsArray());
        Assert.Equal(3, (await o.Peer.Get("/api/v1/my-team")).Data!["members"]!.AsArray().Count);

        // Making the peer report to their own subordinate is refused by the chart (a loop), so it cannot get in.
        Assert.Equal(HttpStatusCode.Conflict, (await o.Owner.Put($"/api/v1/org/members/{o.Peer.UserId}/reports-to", new { reportsToUserId = o.Dev1.UserId })).Status);
    }

    [Fact]
    public async Task A_manager_can_read_a_reports_timesheet_but_a_peer_cannot()
    {
        var o = await Build();
        var task = Guid.Parse((await o.Owner.CreateTaskAsync(o.Project, "Timed"))["id"]!.GetValue<string>());
        // Give the developer the task and let them log time.
        Assert.True((await o.Owner.Put($"/api/v1/tasks/{task}", new
        {
            title = "Timed", statusId = (await o.Owner.Get($"/api/v1/tasks/{task}")).Data!["task"]!["statusId"]!.GetValue<string>(), priority = "Medium",
            assigneeId = o.Dev1.UserId, version = (await o.Owner.Get($"/api/v1/tasks/{task}")).Data!["task"]!["version"]!.GetValue<int>(), labelIds = Array.Empty<Guid>(),
        })).Ok);
        Assert.True((await o.Dev1.Post($"/api/v1/tasks/{task}/time", new { minutes = 75, note = "Pairing" })).Ok);

        var sheet = await o.Lead.Get($"/api/v1/time?userId={o.Dev1.UserId}");
        Assert.True(sheet.Ok, sheet.ToString());
        Assert.Equal(75, sheet.Data!["totalMinutes"]!.GetValue<int>());
        Assert.True((await o.Director.Get($"/api/v1/time?userId={o.Dev1.UserId}")).Ok);          // indirect report
        Assert.Equal(HttpStatusCode.Forbidden, (await o.Peer.Get($"/api/v1/time?userId={o.Dev1.UserId}")).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await o.Dev2.Get($"/api/v1/time?userId={o.Dev1.UserId}")).Status);
        Assert.Equal(75, (await o.Director.Get("/api/v1/my-team")).Data!["members"]!.AsArray().Single(m => m!["name"]!.GetValue<string>() == "Dev One")!["loggedMinutesLast7Days"]!.GetValue<int>());
    }

    [Fact]
    public async Task A_manager_can_open_a_reports_calendar_but_a_peer_cannot()
    {
        var o = await Build();
        await Assign(o.Owner, o.Project, "Dev1 task", o.Dev1, "2027-07-10");

        var forLead = await o.Lead.Get($"/api/v1/calendar?from=2027-07-01&to=2027-07-31&userId={o.Dev1.UserId}");
        Assert.True(forLead.Ok, forLead.ToString());
        Assert.Contains(forLead.Data!.AsArray(), e => e!["title"]!.GetValue<string>() == "Dev1 task");
        Assert.True((await o.Director.Get($"/api/v1/calendar?from=2027-07-01&to=2027-07-31&userId={o.Dev1.UserId}")).Ok);   // indirect report
        Assert.Equal(HttpStatusCode.Forbidden, (await o.Peer.Get($"/api/v1/calendar?from=2027-07-01&to=2027-07-31&userId={o.Dev1.UserId}")).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await o.Dev2.Get($"/api/v1/calendar?from=2027-07-01&to=2027-07-31&userId={o.Dev1.UserId}")).Status);
    }

    [Fact]
    public async Task A_managers_default_calendar_is_their_team_while_a_peer_only_sees_their_own()
    {
        var o = await Build();
        await Assign(o.Owner, o.Project, "Dev1 task", o.Dev1, "2027-08-10");
        await Assign(o.Owner, o.Project, "Peer task", o.Peer, "2027-08-11");
        await o.Owner.Post($"/api/v1/projects/{o.Project}/milestones", new { name = "Ship", dueDate = "2027-08-15", status = "Pending" });

        // The lead's default view (no userId, no "mine") includes their reports' tasks and workspace-level events, but not the peer's task.
        var leadView = (await o.Lead.Get("/api/v1/calendar?from=2027-08-01&to=2027-08-31")).Data!.AsArray();
        Assert.Contains(leadView, e => e!["title"]!.GetValue<string>() == "Dev1 task");
        Assert.DoesNotContain(leadView, e => e!["title"]!.GetValue<string>() == "Peer task");
        Assert.Contains(leadView, e => e!["title"]!.GetValue<string>() == "Ship");

        // A peer with nobody reporting to them only ever sees their own tasks by default, but still sees workspace-level events.
        var peerView = (await o.Peer.Get("/api/v1/calendar?from=2027-08-01&to=2027-08-31")).Data!.AsArray();
        Assert.DoesNotContain(peerView, e => e!["title"]!.GetValue<string>() == "Dev1 task");
        Assert.Contains(peerView, e => e!["title"]!.GetValue<string>() == "Peer task");
        Assert.Contains(peerView, e => e!["title"]!.GetValue<string>() == "Ship");
    }

    [Fact]
    public async Task The_context_knows_how_many_people_report_to_me_and_the_menu_signal_updates()
    {
        var o = await Build();
        Assert.True((await o.Lead.Get("/api/v1/me")).Data!["current"]!["reportCount"]!.GetValue<int>() >= 2);
        Assert.Equal(0, (await o.Peer.Get("/api/v1/me")).Data!["current"]!["reportCount"]!.GetValue<int>());

        var before = (await o.Peer.Get("/api/v1/me/fingerprint")).Data!["fingerprint"]!.GetValue<string>();
        await Report(o.Owner, o.Dev2, o.Peer);
        Assert.NotEqual(before, (await o.Peer.Get("/api/v1/me/fingerprint")).Data!["fingerprint"]!.GetValue<string>());
        Assert.Equal(1, (await o.Peer.Get("/api/v1/me")).Data!["current"]!["reportCount"]!.GetValue<int>());
    }

    [Fact]
    public async Task Reporting_lines_do_not_cross_workspaces()
    {
        var a = await Build();
        var b = await Build();
        Assert.Empty((await b.Director.Get("/api/v1/my-team")).Data!["members"]!.AsArray().Where(m => m!["name"]!.GetValue<string>() == "Dev One" && m["userId"]!.GetValue<string>() == a.Dev1.UserId.ToString()));
        Assert.Equal(HttpStatusCode.NotFound, (await b.Director.Get($"/api/v1/my-team/{a.Dev1.UserId}")).Status);
    }
}
