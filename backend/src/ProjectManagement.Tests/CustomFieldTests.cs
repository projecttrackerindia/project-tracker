using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Features.Reports;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Workspace-defined custom fields on tasks: definitions, typed values, exports and CSV import.</summary>
[Collection("api")]
public class CustomFieldTests(ApiFactory factory)
{
    private async Task<(TestClient C, Guid Project)> Setup(string plan = "PRO")
    {
        var c = await TestClient.RegisterAsync(factory);
        await c.CreateOrgAsync();
        if (plan != "FREE") await c.UpgradeAsync(plan);
        return (c, await c.CreateProjectAsync("Atlas"));
    }

    private static async Task<Guid> Field(TestClient c, string name, string type, string[]? options = null)
    {
        var res = await c.Post("/api/v1/custom-fields", new { name, type, options });
        Assert.Equal(HttpStatusCode.Created, res.Status);
        return Guid.Parse(res.Data!["id"]!.GetValue<string>());
    }

    private static async Task<Guid> NewTask(TestClient c, Guid project, string title = "Task") =>
        Guid.Parse((await c.CreateTaskAsync(project, title))["id"]!.GetValue<string>());

    private static Task<ApiResult> SetValues(TestClient c, Guid task, params (Guid Field, string? Value)[] values) =>
        c.Put($"/api/v1/tasks/{task}/custom-fields", new { values = values.ToDictionary(v => v.Field.ToString(), v => v.Value) });

    private static string? ValueOf(JsonNode? list, Guid field) =>
        list!.AsArray().FirstOrDefault(v => v!["fieldId"]!.GetValue<string>() == field.ToString())?["value"]?.GetValue<string>();

    // ------------------------------------------------------------------ definitions

    [Fact]
    public async Task Fields_can_be_created_renamed_reordered_and_deleted()
    {
        var (c, _) = await Setup();
        var customer = await Field(c, "Customer", "Text");
        var size = await Field(c, "Size", "Dropdown", ["S", "M", "L"]);

        var list = (await c.Get("/api/v1/custom-fields")).Data!.AsArray();
        Assert.Equal(new[] { "Customer", "Size" }, list.Select(f => f!["name"]!.GetValue<string>()));
        Assert.Equal(new[] { "S", "M", "L" }, list[1]!["options"]!.AsArray().Select(o => o!.GetValue<string>()));

        var renamed = await c.Put($"/api/v1/custom-fields/{customer}", new { name = "Client", type = "Text" });
        Assert.Equal("Client", renamed.Data!["name"]!.GetValue<string>());

        var reordered = await c.Put("/api/v1/custom-fields/order", new { ids = new[] { size, customer } });
        Assert.Equal("Size", reordered.Data![0]!["name"]!.GetValue<string>());

        Assert.Equal(HttpStatusCode.NoContent, (await c.Delete($"/api/v1/custom-fields/{size}")).Status);
        Assert.Single((await c.Get("/api/v1/custom-fields")).Data!.AsArray());
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Put("/api/v1/custom-fields/order", new { ids = new[] { size } })).Status);
    }

    [Fact]
    public async Task Definitions_are_validated()
    {
        var (c, _) = await Setup();
        await Field(c, "Customer", "Text");
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Post("/api/v1/custom-fields", new { name = "", type = "Text" })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Post("/api/v1/custom-fields", new { name = new string('x', 41), type = "Text" })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Post("/api/v1/custom-fields", new { name = "D", type = "Dropdown" })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Post("/api/v1/custom-fields", new { name = "D", type = "Dropdown", options = new[] { "A", "a" } })).Status);
        Assert.Equal(HttpStatusCode.Conflict, (await c.Post("/api/v1/custom-fields", new { name = "customer", type = "Number" })).Status);

        var number = await Field(c, "Points", "Number");
        var typeChange = await c.Put($"/api/v1/custom-fields/{number}", new { name = "Points", type = "Text" });
        Assert.Equal(HttpStatusCode.Conflict, typeChange.Status);
        Assert.Equal("TYPE_LOCKED", typeChange.ErrorCode);

        for (var i = 0; i < 18; i++) await Field(c, $"Extra {i}", "Text");
        var over = await c.Post("/api/v1/custom-fields", new { name = "One too many", type = "Text" });
        Assert.Equal(HttpStatusCode.Conflict, over.Status);
        Assert.Equal("LIMIT_REACHED", over.ErrorCode);
    }

    [Fact]
    public async Task Fields_need_the_plan_feature_and_the_workflow_permission_but_everyone_can_read_them()
    {
        var (free, _) = await Setup("FREE");
        Assert.Equal(HttpStatusCode.Forbidden, (await free.Post("/api/v1/custom-fields", new { name = "X", type = "Text" })).Status);
        Assert.True((await free.Get("/api/v1/custom-fields")).Ok);

        var (c, _) = await Setup("PRO");
        var member = await c.AddMemberAsync(factory, TenantRole.Member, "Mem");
        Assert.False((await member.Post("/api/v1/custom-fields", new { name = "X", type = "Text" })).Ok);
        var id = await Field(c, "Customer", "Text");
        Assert.False((await member.Delete($"/api/v1/custom-fields/{id}")).Ok);
        Assert.Single((await member.Get("/api/v1/custom-fields")).Data!.AsArray());
    }

    [Fact]
    public async Task Fields_belong_to_one_workspace()
    {
        var (a, _) = await Setup();
        var (b, _) = await Setup();
        var id = await Field(a, "Secret", "Text");
        Assert.Empty((await b.Get("/api/v1/custom-fields")).Data!.AsArray());
        Assert.Equal(HttpStatusCode.NotFound, (await b.Delete($"/api/v1/custom-fields/{id}")).Status);
    }

    // ------------------------------------------------------------------ values

    [Fact]
    public async Task Values_are_typed_normalised_and_can_be_cleared()
    {
        var (c, project) = await Setup();
        var text = await Field(c, "Customer", "Text"); var number = await Field(c, "Points", "Number"); var date = await Field(c, "Ship date", "Date");
        var choice = await Field(c, "Size", "Dropdown", ["Small", "Large"]); var flag = await Field(c, "Approved", "Checkbox");
        var task = await NewTask(c, project);

        var set = await SetValues(c, task, (text, "  Acme  "), (number, "3.50"), (date, "2026-12-31"), (choice, "large"), (flag, "yes"));
        Assert.True(set.Ok, set.ToString());
        Assert.Equal("Acme", ValueOf(set.Data, text));
        Assert.Equal("3.5", ValueOf(set.Data, number));
        Assert.Equal("2026-12-31", ValueOf(set.Data, date));
        Assert.Equal("Large", ValueOf(set.Data, choice));   // matched to the canonical choice
        Assert.Equal("true", ValueOf(set.Data, flag));
        Assert.Equal(5, (await c.Get($"/api/v1/tasks/{task}/custom-fields")).Data!.AsArray().Count);

        var cleared = await SetValues(c, task, (text, ""), (number, null));
        Assert.Null(ValueOf(cleared.Data, text));
        Assert.Null(ValueOf(cleared.Data, number));
        Assert.Equal(3, cleared.Data!.AsArray().Count);
    }

    [Fact]
    public async Task Bad_values_are_refused()
    {
        var (c, project) = await Setup();
        var number = await Field(c, "Points", "Number"); var date = await Field(c, "Ship date", "Date");
        var choice = await Field(c, "Size", "Dropdown", ["Small", "Large"]); var flag = await Field(c, "Approved", "Checkbox"); var text = await Field(c, "Note", "Text");
        var task = await NewTask(c, project);

        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await SetValues(c, task, (number, "lots"))).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await SetValues(c, task, (number, "1e20"))).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await SetValues(c, task, (date, "31/12/2026"))).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await SetValues(c, task, (choice, "Medium"))).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await SetValues(c, task, (flag, "maybe"))).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await SetValues(c, task, (text, new string('x', 501)))).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await SetValues(c, task, (Guid.NewGuid(), "x"))).Status);
        // A rejected request changes nothing, even for the valid entries in it.
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await SetValues(c, task, (text, "kept?"), (number, "nope"))).Status);
        Assert.Empty((await c.Get($"/api/v1/tasks/{task}/custom-fields")).Data!.AsArray());
    }

    [Fact]
    public async Task Changing_values_is_logged_and_bumps_the_task_version()
    {
        var (c, project) = await Setup();
        var text = await Field(c, "Customer", "Text");
        var task = await NewTask(c, project);
        var before = (await c.Get($"/api/v1/tasks/{task}")).Data!["task"]!["version"]!.GetValue<int>();

        await SetValues(c, task, (text, "Acme"));
        await SetValues(c, task, (text, "Acme")); // no change: no second entry, no version bump
        Assert.Equal(before + 1, (await c.Get($"/api/v1/tasks/{task}")).Data!["task"]!["version"]!.GetValue<int>());
        var activity = (await c.Get($"/api/v1/projects/{project}/activity")).Data!.ToJsonString();
        Assert.Contains("Customer = Acme", activity);
    }

    [Fact]
    public async Task Values_need_edit_rights_and_visible_tasks_and_go_away_with_their_field()
    {
        var (c, project) = await Setup();
        var text = await Field(c, "Customer", "Text");
        var task = await NewTask(c, project);
        await SetValues(c, task, (text, "Acme"));

        var guest = await c.AddMemberAsync(factory, TenantRole.Guest, "Guest");
        Assert.False((await SetValues(guest, task, (text, "Nope"))).Ok);
        var stranger = await TestClient.RegisterAsync(factory);
        Assert.Equal(HttpStatusCode.NotFound, (await stranger.Get($"/api/v1/tasks/{task}/custom-fields")).Status);

        await c.Delete($"/api/v1/custom-fields/{text}");
        Assert.Empty((await c.Get($"/api/v1/tasks/{task}/custom-fields")).Data!.AsArray());
    }

    // ------------------------------------------------------------------ exports and import

    [Fact]
    public async Task Exports_carry_a_column_per_field()
    {
        var (c, project) = await Setup();
        var customer = await Field(c, "Customer", "Text"); var approved = await Field(c, "Approved", "Checkbox");
        var task = await NewTask(c, project, "Has values");
        await NewTask(c, project, "Has none");
        await SetValues(c, task, (customer, "Acme"), (approved, "true"));

        var res = await c.Post("/api/v1/reports/exports", new { kind = "Project", format = "Csv" });
        var id = Guid.Parse(res.Data!["id"]!.GetValue<string>());
        await factory.Services.GetRequiredService<ReportExportProcessor>().ProcessPendingAsync();
        var csv = Encoding.UTF8.GetString(await (await c.Raw($"/api/v1/reports/exports/{id}/file")).Content.ReadAsByteArrayAsync());
        var lines = csv.Split("\r\n").Where(l => l.Length > 0).ToList();
        // The Project report's "Projects" section also has a Key column - anchor on "Key,Title," (the Tasks section) specifically.
        var header = lines.First(l => l.StartsWith("Key,Title,"));
        Assert.EndsWith(",Customer,Approved", header);
        Assert.Contains(lines, l => l.Contains("Has values") && l.EndsWith(",Acme,Yes"));
        Assert.Contains(lines, l => l.Contains("Has none") && l.EndsWith(",,"));
    }

    [Fact]
    public async Task Csv_import_can_fill_custom_fields()
    {
        var (c, project) = await Setup();
        var customer = await Field(c, "Customer", "Text"); var ship = await Field(c, "Ship date", "Date");
        var points = await Field(c, "Points", "Number"); var size = await Field(c, "Size", "Dropdown", ["Small", "Large"]);

        var csv = "Title,Customer,Ship date,Points,Size\nA,Acme,15/03/2026,\"2,5\",small\nB,Beta,,,\n";
        var res = await c.Upload($"/api/v1/projects/{project}/import", "t.csv", Encoding.UTF8.GetBytes(csv), new Dictionary<string, string>());
        Assert.Equal(HttpStatusCode.Created, res.Status); // headers matching a field name are mapped automatically

        var tasks = (await c.Get($"/api/v1/projects/{project}/tasks?pageSize=50")).Data!["items"]!.AsArray();
        var a = Guid.Parse(tasks.Single(t => t!["title"]!.GetValue<string>() == "A")!["id"]!.GetValue<string>());
        var values = (await c.Get($"/api/v1/tasks/{a}/custom-fields")).Data;
        Assert.Equal("Acme", ValueOf(values, customer));
        Assert.Equal("2026-03-15", ValueOf(values, ship));
        Assert.Equal("2.5", ValueOf(values, points));
        Assert.Equal("Small", ValueOf(values, size));

        // A value that does not fit the field is reported on its row.
        var bad = await c.Upload($"/api/v1/projects/{project}/import/preview", "t.csv", Encoding.UTF8.GetBytes("Title,Size\nC,Huge\n"), new Dictionary<string, string>());
        Assert.Equal(1, bad.Data!["invalidRows"]!.GetValue<int>());
        Assert.Contains("Huge", bad.Data["errors"]![0]!["message"]!.GetValue<string>());
    }
}
