using System.Net;
using System.Text.Json.Nodes;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Stages are the project's journey (Requirements → Development → …), each with an owner (a person or a team) and a date. Moving to the
/// next stage notifies its owner; handing a stage to someone else can take the previous owner's open tasks with it.
/// </summary>
[Collection("api")]
public class StageOwnershipTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();

    private async Task<(TestClient Owner, Guid Project, List<JsonNode> Stages)> Setup()
    {
        var c = await TestClient.RegisterAsync(factory);
        await c.CreateOrgAsync();
        await c.UpgradeAsync("BUSINESS");
        var project = await c.CreateProjectAsync("Journey");
        return (c, project, await Stages(c, project));
    }

    private static async Task<List<JsonNode>> Stages(TestClient c, Guid project) =>
        (await c.Get($"/api/v1/projects/{project}/stages")).Data!.AsArray().Select(s => s!).ToList();

    private static async Task<Guid> NewTask(TestClient c, Guid project, string title, Guid stage, Guid? assignee = null) =>
        Guid.Parse(S((await c.CreateTaskAsync(project, title, new { title, priority = "Medium", stageId = stage, assigneeId = assignee }))["id"]));

    private static async Task<bool> Notified(TestClient who, string contains) =>
        (await who.Get("/api/v1/notifications")).Data!["items"]!.AsArray().Any(n => S(n!["title"]).Contains(contains));

    [Fact]
    public async Task Moving_to_the_next_stage_completes_the_current_one_and_tells_the_next_owner()
    {
        var (c, project, stages) = await Setup();
        var dev = await c.AddMemberAsync(factory, TenantRole.Member, "Ravi");
        var first = stages[0]; var second = stages[1];
        var put = await c.Put($"/api/v1/projects/{project}/stages/{S(second["id"])}",
            new { name = S(second["name"]), status = "Pending", ownerId = dev.UserId, plannedStart = second["plannedStart"]?.GetValue<string>(), plannedEnd = second["plannedEnd"]?.GetValue<string>() });
        Assert.True(put.Ok, put.ToString());

        var task = await NewTask(c, project, "Collect requirements", Guid.Parse(S(first["id"])));
        // An open task blocks completing the stage unless it is carried along.
        var blocked = await c.Post($"/api/v1/projects/{project}/stages/advance", new { carryOpenTasks = false });
        Assert.Equal(HttpStatusCode.Conflict, blocked.Status);

        var moved = await c.Post($"/api/v1/projects/{project}/stages/advance", new { carryOpenTasks = true });
        Assert.True(moved.Ok, moved.ToString());
        Assert.Equal(1, moved.Data!["movedTasks"]!.GetValue<int>());
        var after = moved.Data!["stages"]!.AsArray();
        Assert.Equal("Completed", S(after[0]!["status"]));
        Assert.Equal("InProgress", S(after[1]!["status"]));
        Assert.Equal(S(second["id"]), S((await c.Get($"/api/v1/tasks/{task}")).Data!["task"]!["stageId"]));
        Assert.True(await Notified(dev, "is now in"));
    }

    [Fact]
    public async Task Reassigning_a_stage_can_move_the_previous_owners_open_tasks()
    {
        var (c, project, stages) = await Setup();
        var ravi = await c.AddMemberAsync(factory, TenantRole.Member, "Ravi");
        var shiva = await c.AddMemberAsync(factory, TenantRole.Member, "Shiva");
        foreach (var who in new[] { ravi, shiva })
            Assert.True((await c.Post($"/api/v1/projects/{project}/members", new { userId = who.UserId })).Ok);
        var stage = Guid.Parse(S(stages[0]["id"]));
        Assert.True((await c.Post($"/api/v1/projects/{project}/stages/{stage}/owner", new { ownerId = ravi.UserId })).Ok);
        var open = await NewTask(c, project, "Draft runbook", stage, ravi.UserId);

        var res = await c.Post($"/api/v1/projects/{project}/stages/{stage}/owner", new { ownerId = shiva.UserId, moveOpenTasks = true });
        Assert.True(res.Ok, res.ToString());
        Assert.Equal(1, res.Data!["movedTasks"]!.GetValue<int>());
        Assert.Equal(shiva.UserId.ToString(), S(res.Data!["stages"]!.AsArray()[0]!["owner"]!["id"]));
        Assert.Equal(shiva.UserId.ToString(), S((await c.Get($"/api/v1/tasks/{open}")).Data!["task"]!["assignee"]!["id"]));
        Assert.True(await Notified(shiva, "You own"));
        Assert.True(await Notified(ravi, "was handed to"));
    }

    [Fact]
    public async Task A_team_can_own_a_stage_and_its_members_are_told()
    {
        var (c, project, stages) = await Setup();
        var qa = await c.AddMemberAsync(factory, TenantRole.Member, "Anita");
        var team = Guid.Parse(S((await c.Post("/api/v1/teams", new { name = "QA team" })).Data!["team"]!["id"]));
        Assert.True((await c.Post($"/api/v1/teams/{team}/members", new { userId = qa.UserId, isLead = false })).Ok);
        var stage = Guid.Parse(S(stages[1]["id"]));

        var res = await c.Post($"/api/v1/projects/{project}/stages/{stage}/owner", new { teamId = team });
        Assert.True(res.Ok, res.ToString());
        var row = res.Data!["stages"]!.AsArray()[1]!;
        Assert.Equal("QA team", S(row["ownerTeamName"]));
        Assert.True(await Notified(qa, "You own"));
    }

    [Fact]
    public async Task Another_workspaces_team_cannot_own_a_stage()
    {
        var (c, project, stages) = await Setup();
        var other = await TestClient.RegisterAsync(factory);
        await other.CreateOrgAsync();
        var foreign = Guid.Parse(S((await other.Post("/api/v1/teams", new { name = "Elsewhere" })).Data!["team"]!["id"]));
        var res = await c.Post($"/api/v1/projects/{project}/stages/{S(stages[0]["id"])}/owner", new { teamId = foreign });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, res.Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Post($"/api/v1/projects/{project}/stages/{S(stages[0]["id"])}/owner", new { })).Status);
    }
}
