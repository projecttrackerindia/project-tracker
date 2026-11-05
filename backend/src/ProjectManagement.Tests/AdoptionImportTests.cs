using System.Text;
using System.Text.Json.Nodes;
using ClosedXML.Excel;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Importing from Excel, Jira, Trello and Asana into a project, with status matching, owners by e-mail and undo.</summary>
[Collection("api")]
public class AdoptionImportTests(ApiFactory factory)
{
    private async Task<(TestClient C, Guid Project)> Setup()
    {
        var c = await TestClient.RegisterAsync(factory);
        await c.CreateOrgAsync();
        await c.UpgradeAsync("PRO");
        return (c, await c.CreateProjectAsync("Harbor"));
    }

    private static Task<ApiResult> Send(TestClient c, Guid project, string path, string name, byte[] bytes, string source, object? options = null)
    {
        var fields = new Dictionary<string, string> { ["source"] = source };
        if (options is not null) fields["options"] = System.Text.Json.JsonSerializer.Serialize(options);
        return c.Upload($"/api/v1/projects/{project}/import{path}", name, bytes, fields);
    }

    private static async Task<JsonArray> Tasks(TestClient c, Guid project) => (await c.Get($"/api/v1/projects/{project}/tasks?pageSize=200")).Data!["items"]!.AsArray();

    private static readonly object Lenient = new { skipInvalid = false, createMissingLabels = true, dateFormat = "dmy", matchStatuses = true, leaveUnknownOwners = true };

    [Fact]
    public async Task A_jira_export_imports_with_statuses_matched_by_meaning_and_owners_by_email()
    {
        var (c, project) = await Setup();
        var csv = $"Issue key,Summary,Status,Priority,Assignee Email,Due date,Labels,Labels\r\nHB-1,Set up the pipeline,Done,Highest,{c.Email},12/Nov/26 5:00 PM,infra,ci\r\nHB-2,Write the runbook,In Review,Minor,someone@else.invalid,,docs,\r\n";
        var preview = await Send(c, project, "/preview", "jira.csv", Encoding.UTF8.GetBytes(csv), "jira", Lenient);
        Assert.True(preview.Ok, preview.ToString());
        Assert.Equal(2, preview.Data!["validRows"]!.GetValue<int>());
        Assert.Contains("Title", preview.Data["headers"]!.AsArray().Select(h => h!.GetValue<string>()));

        var strict = await Send(c, project, "/preview", "jira.csv", Encoding.UTF8.GetBytes(csv), "jira");
        Assert.True(strict.Data!["invalidRows"]!.GetValue<int>() >= 1);   // without matching, "In Review" and the outside owner fail

        var res = await Send(c, project, "", "jira.csv", Encoding.UTF8.GetBytes(csv), "jira", Lenient);
        Assert.True(res.Ok, res.ToString());
        Assert.Equal(2, res.Data!["created"]!.GetValue<int>());
        Assert.NotNull(res.Data["batchId"]);
        var tasks = await Tasks(c, project);
        var first = tasks.Single(t => t!["title"]!.GetValue<string>() == "Set up the pipeline")!;
        Assert.Equal("2026-11-12", first["dueDate"]!.GetValue<string>());
        Assert.Equal("Critical", first["priority"]!.GetValue<string>());
        Assert.Equal(c.UserId.ToString(), first["assigneeId"]!.GetValue<string>());
        var second = tasks.Single(t => t!["title"]!.GetValue<string>() == "Write the runbook")!;
        Assert.Null(second["assigneeId"]?.GetValue<string>());
    }

    [Fact]
    public async Task A_trello_board_imports_open_cards_with_their_list_as_status()
    {
        var (c, project) = await Setup();
        var board = new JsonObject
        {
            ["lists"] = new JsonArray(new JsonObject { ["id"] = "l1", ["name"] = "Doing" }, new JsonObject { ["id"] = "l2", ["name"] = "Backlog" }),
            ["members"] = new JsonArray(new JsonObject { ["id"] = "m1", ["fullName"] = "Nobody Here" }),
            ["cards"] = new JsonArray(
                new JsonObject { ["name"] = "Sketch the hero", ["desc"] = "Two options", ["idList"] = "l1", ["idMembers"] = new JsonArray("m1"), ["due"] = "2026-12-01T10:00:00.000Z", ["labels"] = new JsonArray(new JsonObject { ["name"] = "Design" }) },
                new JsonObject { ["name"] = "Old idea", ["idList"] = "l2", ["closed"] = true },
                new JsonObject { ["name"] = "Pick a font", ["idList"] = "l2" }),
        };
        var res = await Send(c, project, "", "board.json", Encoding.UTF8.GetBytes(board.ToJsonString()), "trello", Lenient);
        Assert.True(res.Ok, res.ToString());
        Assert.Equal(2, res.Data!["created"]!.GetValue<int>());
        var tasks = await Tasks(c, project);
        Assert.DoesNotContain(tasks, t => t!["title"]!.GetValue<string>() == "Old idea");
        Assert.Equal("2026-12-01", tasks.Single(t => t!["title"]!.GetValue<string>() == "Sketch the hero")!["dueDate"]!.GetValue<string>());

        var bad = await Send(c, project, "/preview", "board.json", Encoding.UTF8.GetBytes("{\"nope\":1}"), "trello");
        Assert.False(bad.Ok);
    }

    [Fact]
    public async Task An_asana_export_and_an_excel_sheet_import_and_an_import_can_be_undone()
    {
        var (c, project) = await Setup();
        var asana = $"Task ID,Name,Section/Column,Assignee Email,Start Date,Due Date,Completed At,Notes,Tags\r\n1,Brief the client,To do,{c.Email},2026-11-01,2026-11-03,,Agenda,client\r\n2,Kick-off,To do,,,,2026-10-30,,\r\n";
        var a = await Send(c, project, "", "asana.csv", Encoding.UTF8.GetBytes(asana), "asana", Lenient);
        Assert.True(a.Ok, a.ToString());
        Assert.Equal(2, a.Data!["created"]!.GetValue<int>());

        using var wb = new XLWorkbook();
        var ws = wb.Worksheets.Add("Tasks");
        ws.Cell(1, 1).Value = "Task"; ws.Cell(1, 2).Value = "Owner"; ws.Cell(1, 3).Value = "Due";
        ws.Cell(2, 1).Value = "Order the banners"; ws.Cell(2, 2).Value = c.Email; ws.Cell(2, 3).Value = new DateTime(2026, 11, 20);
        ws.Cell(3, 1).Value = "Confirm the venue";
        using var ms = new MemoryStream();
        wb.SaveAs(ms);
        var x = await Send(c, project, "", "plan.xlsx", ms.ToArray(), "excel", Lenient);
        Assert.True(x.Ok, x.ToString());
        Assert.Equal(2, x.Data!["created"]!.GetValue<int>());
        Assert.Equal("2026-11-20", (await Tasks(c, project)).Single(t => t!["title"]!.GetValue<string>() == "Order the banners")!["dueDate"]!.GetValue<string>());

        var batches = await c.Get($"/api/v1/projects/{project}/import/batches");
        Assert.True(batches.Ok, batches.ToString());
        Assert.Equal(2, batches.Data!.AsArray().Count);
        var latest = batches.Data[0]!;
        Assert.Equal("excel", latest["source"]!.GetValue<string>());
        Assert.True(latest["canUndo"]!.GetValue<bool>());

        var undo = await c.Post($"/api/v1/projects/{project}/import/batches/{latest["id"]}/undo");
        Assert.True(undo.Ok, undo.ToString());
        var left = await Tasks(c, project);
        Assert.DoesNotContain(left, t => t!["title"]!.GetValue<string>() == "Order the banners");
        Assert.Contains(left, t => t!["title"]!.GetValue<string>() == "Brief the client");
        Assert.Equal("IMPORT_ALREADY_UNDONE", (await c.Post($"/api/v1/projects/{project}/import/batches/{latest["id"]}/undo")).ErrorCode);
    }

    [Fact]
    public async Task Reading_from_jira_only_calls_atlassian_sites()
    {
        var (c, project) = await Setup();
        var res = await c.Post($"/api/v1/projects/{project}/import/fetch", new { source = "jira", site = "evil.example.com/x", email = "a@b.c", token = "t" });
        Assert.False(res.Ok);
        Assert.Equal("acme.atlassian.net", ProjectManagement.Application.Features.Import.ImportSources.JiraHost("https://acme.atlassian.net/"));
        Assert.Equal("acme.atlassian.net", ProjectManagement.Application.Features.Import.ImportSources.JiraHost("acme"));
        Assert.Throws<ProjectManagement.Application.Exceptions.ValidationException>(() => ProjectManagement.Application.Features.Import.ImportSources.JiraHost("acme.atlassian.net.evil.com"));
    }
}
