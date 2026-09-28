using System.Net;
using System.Text.Json.Nodes;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>The projects board: columns are project statuses; cross-column drops change status, in-column drops only reorder.</summary>
[Collection("api")]
public class ProjectBoardTests(ApiFactory factory)
{
    private static async Task<JsonNode> Move(TestClient c, Guid id, string status, double? position = null)
    {
        var res = await c.Send(HttpMethod.Patch, $"/api/v1/projects/{id}/move", new { status, position });
        Assert.True(res.Ok, res.ToString());
        return res.Data!;
    }

    private static async Task<List<(string Id, string Status)>> Board(TestClient c) =>
        (await c.Get("/api/v1/projects?sort=position&pageSize=100&includeArchived=true")).Data!["items"]!.AsArray()
            .Select(p => (p!["id"]!.GetValue<string>(), p["status"]!.GetValue<string>())).ToList();

    [Fact]
    public async Task Dropping_in_another_column_changes_status_and_dropping_in_the_same_column_only_reorders()
    {
        var c = await TestClient.RegisterAsync(factory);
        var a = await c.CreateProjectAsync("Alpha");
        var b = await c.CreateProjectAsync("Beta");
        var d = await c.CreateProjectAsync("Gamma");

        // New projects are ordered by creation and start in Planning.
        Assert.Equal([a, b, d], (await Board(c)).Select(x => Guid.Parse(x.Id)).ToArray());
        Assert.All(await Board(c), x => Assert.Equal("Planning", x.Status));

        // Cross-column drop: status changes.
        var moved = await Move(c, a, "Active");
        Assert.Equal("Active", moved["status"]!.GetValue<string>());
        Assert.Contains("Active", (await Board(c)).Where(x => x.Id == a.ToString()).Select(x => x.Status));

        // Same-column drop: put Gamma before Beta by giving it a smaller position. Status must not change.
        var posB = (await c.Get($"/api/v1/projects/{b}")).Data!["project"]!["position"]!.GetValue<double>();
        var reordered = await Move(c, d, "Planning", posB - 1);
        Assert.Equal("Planning", reordered["status"]!.GetValue<string>());
        var order = (await Board(c)).Where(x => x.Status == "Planning").Select(x => Guid.Parse(x.Id)).ToArray();
        Assert.Equal([d, b], order);

        // Moving without a position sends the card to the end of the board.
        await Move(c, d, "Planning");
        Assert.Equal([b, d], (await Board(c)).Where(x => x.Status == "Planning").Select(x => Guid.Parse(x.Id)).ToArray());
    }

    [Fact]
    public async Task Projects_can_be_dragged_into_completed_cancelled_and_archived_and_back()
    {
        var c = await TestClient.RegisterAsync(factory);
        var id = await c.CreateProjectAsync("Journey");
        foreach (var status in new[] { "Active", "OnHold", "Completed", "Cancelled", "Archived", "Planning" })
        {
            var moved = await Move(c, id, status);
            Assert.Equal(status, moved["status"]!.GetValue<string>());
        }

        var bad = await c.Send(HttpMethod.Patch, $"/api/v1/projects/{id}/move", new { status = "Nonsense" });
        Assert.Equal(HttpStatusCode.BadRequest, bad.Status);
    }

    [Fact]
    public async Task Restoring_an_archived_project_by_dragging_respects_the_plan_limit()
    {
        var c = await TestClient.RegisterAsync(factory); // Free plan: 5 active projects
        var first = await c.CreateProjectAsync("To archive");
        await Move(c, first, "Archived");
        for (var i = 0; i < 5; i++) await c.CreateProjectAsync($"Fill {i}");

        var restore = await c.Send(HttpMethod.Patch, $"/api/v1/projects/{first}/move", new { status = "Planning" });
        Assert.Equal(HttpStatusCode.Forbidden, restore.Status);
        Assert.Equal("PLAN_LIMIT_REACHED", restore.ErrorCode);
    }

    [Fact]
    public async Task Only_people_who_may_edit_a_project_can_move_it()
    {
        var owner = await TestClient.RegisterAsync(factory);
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("PRO");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Mo");
        var guest = await owner.AddMemberAsync(factory, TenantRole.Guest, "Gus");

        var ownersProject = await owner.CreateProjectAsync("Owner's");
        var membersProject = await member.CreateProjectAsync("Member's");
        await owner.Post($"/api/v1/projects/{ownersProject}/members", new { userId = guest.UserId });

        // Members hold no general "edit projects" permission, but may move projects they own.
        var denied = await member.Send(HttpMethod.Patch, $"/api/v1/projects/{ownersProject}/move", new { status = "Active" });
        Assert.Equal(HttpStatusCode.Forbidden, denied.Status);
        Assert.Equal("Active", (await Move(member, membersProject, "Active"))["status"]!.GetValue<string>());

        // Guests cannot move anything, and cannot even see projects they are not part of.
        Assert.Equal(HttpStatusCode.Forbidden, (await guest.Send(HttpMethod.Patch, $"/api/v1/projects/{ownersProject}/move", new { status = "Active" })).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await guest.Send(HttpMethod.Patch, $"/api/v1/projects/{membersProject}/move", new { status = "Active" })).Status);

        // The owner (with the edit permission) can move any project; the move is recorded in the activity feed.
        Assert.Equal("Completed", (await Move(owner, membersProject, "Completed"))["status"]!.GetValue<string>());
        var activity = (await owner.Get($"/api/v1/projects/{membersProject}/activity")).Data!["items"]!.AsArray();
        Assert.Contains(activity, a => a!["action"]!.GetValue<string>() == "project.status_changed");
    }
}
