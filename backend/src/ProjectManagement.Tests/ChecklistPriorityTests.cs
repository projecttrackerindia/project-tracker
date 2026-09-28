using System.Net;
using System.Text.Json.Nodes;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Task checklists and workspace-specific priority names and colours.</summary>
[Collection("api")]
public class ChecklistPriorityTests(ApiFactory factory)
{
    private async Task<(TestClient C, Guid Project)> Setup(string plan = "PRO")
    {
        var c = await TestClient.RegisterAsync(factory);
        await c.CreateOrgAsync();
        if (plan != "FREE") await c.UpgradeAsync(plan);
        return (c, await c.CreateProjectAsync("Atlas"));
    }

    private static async Task<Guid> NewTask(TestClient c, Guid project, string title = "Task") =>
        Guid.Parse((await c.CreateTaskAsync(project, title))["id"]!.GetValue<string>());

    private static Task<ApiResult> AddItem(TestClient c, Guid task, string title) => c.Post($"/api/v1/tasks/{task}/checklist", new { title });

    private static Guid IdOf(JsonNode checklist, int index) => Guid.Parse(checklist["items"]![index]!["id"]!.GetValue<string>());

    // ------------------------------------------------------------------ checklists

    [Fact]
    public async Task Items_can_be_added_ticked_renamed_and_removed_and_progress_follows()
    {
        var (c, project) = await Setup("FREE");
        var task = await NewTask(c, project);
        Assert.Equal(0, (await c.Get($"/api/v1/tasks/{task}/checklist")).Data!["total"]!.GetValue<int>());

        await AddItem(c, task, "Write tests");
        var list = (await AddItem(c, task, "Update docs")).Data!;
        Assert.Equal(2, list["total"]!.GetValue<int>());

        var first = IdOf(list, 0);
        var ticked = await c.Put($"/api/v1/tasks/{task}/checklist/{first}", new { isDone = true });
        Assert.Equal(1, ticked.Data!["done"]!.GetValue<int>());
        Assert.Equal(50, ticked.Data["progress"]!.GetValue<int>());
        Assert.NotNull(ticked.Data["items"]![0]!["completedAt"]);

        var renamed = await c.Put($"/api/v1/tasks/{task}/checklist/{first}", new { title = "Write more tests" });
        Assert.Equal("Write more tests", renamed.Data!["items"]![0]!["title"]!.GetValue<string>());
        Assert.True(renamed.Data["items"]![0]!["isDone"]!.GetValue<bool>()); // renaming keeps it ticked

        var untick = await c.Put($"/api/v1/tasks/{task}/checklist/{first}", new { isDone = false });
        Assert.Null(untick.Data!["items"]![0]!["completedAt"]);

        var removed = await c.Delete($"/api/v1/tasks/{task}/checklist/{first}");
        Assert.Equal(1, removed.Data!["total"]!.GetValue<int>());
    }

    [Fact]
    public async Task Task_lists_carry_the_checklist_counts_and_finishing_it_is_logged()
    {
        var (c, project) = await Setup("FREE");
        var task = await NewTask(c, project);
        var a = IdOf((await AddItem(c, task, "One")).Data!, 0);
        var b = IdOf((await AddItem(c, task, "Two")).Data!, 1);
        await c.Put($"/api/v1/tasks/{task}/checklist/{a}", new { isDone = true });

        var dto = (await c.Get($"/api/v1/tasks/{task}")).Data!["task"]!;
        Assert.Equal(2, dto["checklistTotal"]!.GetValue<int>());
        Assert.Equal(1, dto["checklistDone"]!.GetValue<int>());

        await c.Put($"/api/v1/tasks/{task}/checklist/{b}", new { isDone = true });
        var activity = (await c.Get($"/api/v1/projects/{project}/activity")).Data!.ToJsonString();
        Assert.Contains("Finished every item of the checklist", activity);
    }

    [Fact]
    public async Task Items_can_be_reordered_and_bad_orders_are_refused()
    {
        var (c, project) = await Setup("FREE");
        var task = await NewTask(c, project);
        await AddItem(c, task, "A"); await AddItem(c, task, "B");
        var list = (await AddItem(c, task, "C")).Data!;
        var ids = new[] { IdOf(list, 0), IdOf(list, 1), IdOf(list, 2) };

        var res = await c.Put($"/api/v1/tasks/{task}/checklist/order", new { itemIds = new[] { ids[2], ids[0], ids[1] } });
        Assert.True(res.Ok, res.ToString());
        Assert.Equal(new[] { "C", "A", "B" }, res.Data!["items"]!.AsArray().Select(i => i!["title"]!.GetValue<string>()));
        Assert.Equal("C", (await c.Get($"/api/v1/tasks/{task}/checklist")).Data!["items"]![0]!["title"]!.GetValue<string>());

        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Put($"/api/v1/tasks/{task}/checklist/order", new { itemIds = new[] { ids[0], ids[1] } })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Put($"/api/v1/tasks/{task}/checklist/order", new { itemIds = new[] { ids[0], ids[1], Guid.NewGuid() } })).Status);
    }

    [Fact]
    public async Task Checklist_input_is_validated_and_limited()
    {
        var (c, project) = await Setup("FREE");
        var task = await NewTask(c, project);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await AddItem(c, task, "   ")).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await AddItem(c, task, new string('x', 201))).Status);
        for (var i = 0; i < 100; i++) Assert.True((await AddItem(c, task, $"Item {i}")).Ok);
        Assert.Equal(HttpStatusCode.Conflict, (await AddItem(c, task, "One too many")).Status);
    }

    [Fact]
    public async Task Checklists_stay_inside_their_task_and_need_edit_rights()
    {
        var (c, project) = await Setup("PRO");
        var task = await NewTask(c, project); var other = await NewTask(c, project, "Other");
        var item = IdOf((await AddItem(c, task, "Mine")).Data!, 0);
        // An item id from another task is not found through this one.
        Assert.Equal(HttpStatusCode.NotFound, (await c.Put($"/api/v1/tasks/{other}/checklist/{item}", new { isDone = true })).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await c.Delete($"/api/v1/tasks/{other}/checklist/{item}")).Status);

        var guest = await c.AddMemberAsync(factory, TenantRole.Guest, "Guest");
        Assert.False((await AddItem(guest, task, "Nope")).Ok);
        var stranger = await TestClient.RegisterAsync(factory);
        Assert.Equal(HttpStatusCode.NotFound, (await stranger.Get($"/api/v1/tasks/{task}/checklist")).Status);
    }

    // ------------------------------------------------------------------ priorities

    private static JsonNode Level(JsonNode list, string level) => list.AsArray().First(p => p!["level"]!.GetValue<string>() == level)!;

    [Fact]
    public async Task Priorities_default_to_the_standard_names_and_can_be_renamed_and_recoloured()
    {
        var (c, project) = await Setup("PRO");
        var defaults = (await c.Get("/api/v1/priorities")).Data!;
        Assert.Equal(new[] { "Critical", "High", "Medium", "Low" }, defaults.AsArray().Select(p => p!["name"]!.GetValue<string>()));
        Assert.All(defaults.AsArray(), p => Assert.False(p!["isCustom"]!.GetValue<bool>()));

        var set = await c.Put("/api/v1/priorities", new { items = new object[] { new { level = "Critical", name = "P0", color = "#DC2626" }, new { level = "High", name = "P1", color = "#f97316" } } });
        Assert.True(set.Ok, set.ToString());
        Assert.Equal("P0", Level(set.Data!, "Critical")["name"]!.GetValue<string>());
        Assert.Equal("#dc2626", Level(set.Data!, "Critical")["color"]!.GetValue<string>());
        Assert.True(Level(set.Data!, "Critical")["isCustom"]!.GetValue<bool>());
        Assert.Equal("Medium", Level(set.Data!, "Medium")["name"]!.GetValue<string>()); // untouched levels keep their defaults

        // The task keeps its level; only the display changes, so sorting and reports still mean the same.
        var task = await c.CreateTaskAsync(project, "Urgent", new { title = "Urgent", priority = "Critical" });
        Assert.Equal("Critical", task["priority"]!.GetValue<string>());

        var reset = await c.Delete("/api/v1/priorities");
        Assert.Equal("Critical", Level(reset.Data!, "Critical")["name"]!.GetValue<string>());
    }

    [Fact]
    public async Task Priority_names_and_colours_are_validated()
    {
        var (c, _) = await Setup("PRO");
        object One(string name, string color, string level = "Critical") => new { items = new[] { new { level, name, color } } };
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Put("/api/v1/priorities", One("", "#ff0000"))).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Put("/api/v1/priorities", One(new string('x', 21), "#ff0000"))).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Put("/api/v1/priorities", One("Ok", "red"))).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Put("/api/v1/priorities", One("Ok", "#ff0000; background:url(x)"))).Status);
        // Two levels cannot end up with the same name (also against the defaults of the untouched ones).
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Put("/api/v1/priorities", One("low", "#ff0000"))).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Put("/api/v1/priorities", new { items = new object[] { new { level = "Critical", name = "Same", color = "#ff0000" }, new { level = "High", name = "same", color = "#00ff00" } } })).Status);
    }

    [Fact]
    public async Task Custom_priorities_need_the_plan_feature_and_the_right_to_manage_workflow()
    {
        var (free, _) = await Setup("FREE");
        Assert.Equal(HttpStatusCode.Forbidden, (await free.Put("/api/v1/priorities", new { items = new[] { new { level = "Critical", name = "P0", color = "#ff0000" } } })).Status);
        Assert.True((await free.Get("/api/v1/priorities")).Ok); // everyone can read them

        var (c, _) = await Setup("PRO");
        var member = await c.AddMemberAsync(factory, TenantRole.Member, "Mem");
        Assert.False((await member.Put("/api/v1/priorities", new { items = new[] { new { level = "Critical", name = "P0", color = "#ff0000" } } })).Ok);
        Assert.True((await member.Get("/api/v1/priorities")).Ok);
    }

    [Fact]
    public async Task Priority_settings_are_private_to_each_workspace()
    {
        var (a, _) = await Setup("PRO");
        var (b, _) = await Setup("PRO");
        await a.Put("/api/v1/priorities", new { items = new[] { new { level = "Critical", name = "Blocker", color = "#111111" } } });
        Assert.Equal("Critical", Level((await b.Get("/api/v1/priorities")).Data!, "Critical")["name"]!.GetValue<string>());
        Assert.Equal("Blocker", Level((await a.Get("/api/v1/priorities")).Data!, "Critical")["name"]!.GetValue<string>());
    }
}
