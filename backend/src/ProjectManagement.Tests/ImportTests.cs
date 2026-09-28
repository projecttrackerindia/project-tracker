using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using ProjectManagement.Application.Common;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Importing tasks from CSV files: parsing, column mapping, validation and the import itself.</summary>
[Collection("api")]
public class ImportTests(ApiFactory factory)
{
    private async Task<(TestClient C, Guid Project)> Setup(string plan = "PRO")
    {
        var c = await TestClient.RegisterAsync(factory);
        await c.CreateOrgAsync();
        if (plan != "FREE") await c.UpgradeAsync(plan);
        return (c, await c.CreateProjectAsync("Atlas"));
    }

    private static Task<ApiResult> Send(TestClient c, Guid project, string path, string csv, object? mapping = null, object? options = null)
    {
        var fields = new Dictionary<string, string>();
        if (mapping is not null) fields["mapping"] = System.Text.Json.JsonSerializer.Serialize(mapping);
        if (options is not null) fields["options"] = System.Text.Json.JsonSerializer.Serialize(options);
        return c.Upload($"/api/v1/projects/{project}/import{path}", "tasks.csv", new UTF8Encoding(true).GetPreamble().Concat(Encoding.UTF8.GetBytes(csv)).ToArray(), fields);
    }

    private static Task<ApiResult> Preview(TestClient c, Guid project, string csv, object? mapping = null, object? options = null) => Send(c, project, "/preview", csv, mapping, options);
    private static Task<ApiResult> Import(TestClient c, Guid project, string csv, object? mapping = null, object? options = null) => Send(c, project, "", csv, mapping, options);

    private static async Task<JsonArray> Tasks(TestClient c, Guid project) => (await c.Get($"/api/v1/projects/{project}/tasks?pageSize=200")).Data!["items"]!.AsArray();

    // ------------------------------------------------------------------ the CSV reader

    [Fact]
    public void Csv_reader_handles_quotes_line_breaks_bom_and_regional_separators()
    {
        var t = CsvParser.Parse("﻿Title,Notes\r\n\"Fix \"\"login\"\", now\",\"line one\nline two\"\r\n\r\nPlain,x\n", 100);
        Assert.Equal(new[] { "Title", "Notes" }, t.Headers);
        Assert.Equal(2, t.Rows.Count);                       // the blank line is not a row
        Assert.Equal("Fix \"login\", now", t.Rows[0][0]);
        Assert.Equal("line one\nline two", t.Rows[0][1]);

        var semi = CsvParser.Parse("Title;Due\nA;2026-01-02\n", 100);
        Assert.Equal(';', semi.Delimiter);
        Assert.Equal("2026-01-02", semi.Rows[0][1]);
        Assert.Equal('\t', CsvParser.Parse("a\tb\n1\t2\n", 100).Delimiter);

        Assert.Throws<CsvException>(() => CsvParser.Parse("Title\n\"never closed\n", 100));
        Assert.Throws<CsvException>(() => CsvParser.Parse("", 100));
        Assert.Throws<CsvException>(() => CsvParser.Parse("h\n1\n2\n3\n", 2));
    }

    // ------------------------------------------------------------------ preview

    [Fact]
    public async Task Preview_suggests_a_mapping_from_the_headers_and_validates_every_row()
    {
        var (c, project) = await Setup();
        var csv = "Name,Status,Priority,Due date,Hours\nGood,Done,High,2026-10-01,3\n,Yet To Start,Low,2026-10-02,1\nBad status,Nope,Low,,\nBad date,Done,Low,31/02/2026,\n";
        var res = await Preview(c, project, csv);
        Assert.True(res.Ok, res.ToString());
        var d = res.Data!;
        Assert.Equal(4, d["totalRows"]!.GetValue<int>());
        Assert.Equal(0, d["suggestedMapping"]!["title"]!.GetValue<int>());
        Assert.Equal(1, d["suggestedMapping"]!["status"]!.GetValue<int>());
        Assert.Equal(4, d["suggestedMapping"]!["estimatedHours"]!.GetValue<int>());
        Assert.Equal(1, d["validRows"]!.GetValue<int>());
        Assert.Equal(3, d["invalidRows"]!.GetValue<int>());
        var messages = d["errors"]!.AsArray().Select(e => $"{e!["row"]}:{e["field"]}").ToList();
        Assert.Contains("3:title", messages);      // row 3 in a spreadsheet: the empty title
        Assert.Contains("4:status", messages);
        Assert.Contains("5:dueDate", messages);
        Assert.Empty(await Tasks(c, project));      // a preview never writes anything
    }

    [Fact]
    public async Task Preview_reports_a_missing_title_column_and_unreadable_files()
    {
        var (c, project) = await Setup();
        var noTitle = await Preview(c, project, "Foo,Bar\n1,2\n");
        Assert.Equal(0, noTitle.Data!["validRows"]!.GetValue<int>());
        Assert.Contains("title", noTitle.Data["errors"]![0]!["message"]!.GetValue<string>());

        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await Preview(c, project, "Title\n\"open quote\n")).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Upload($"/api/v1/projects/{project}/import/preview", "x.csv", [])).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await Preview(c, project, "Title\nA\n", new { title = 5 })).Status);          // no such column
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await Preview(c, project, "Title,B\nA,1\n", new { title = 0, status = 0 })).Status); // column used twice
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await Preview(c, project, "Title\nA\n", new { bogus = 0 })).Status);
    }

    // ------------------------------------------------------------------ import

    [Fact]
    public async Task Import_creates_tasks_with_all_mapped_fields()
    {
        var (c, project) = await Setup();
        var member = await c.AddMemberAsync(factory, TenantRole.Member, "Priya Sharma");
        await c.Post("/api/v1/labels", new { name = "Backend", color = "#ff0000" });
        var milestone = (await c.Post($"/api/v1/projects/{project}/milestones", new { name = "Beta", status = "Pending" })).Data![0]!["id"]!.GetValue<string>();

        var csv = "Task;Details;State;Importance;Owner;Start;Deadline;Estimate;Tags;Release\n" +
                  $"Build API;\"Multi\nline\";In Progress;high;{member.Email};01/10/2026;15/10/2026;8,5;\"Backend, New \";Beta\n" +
                  "Write docs;;;;Priya Sharma;;;;;\n";
        var res = await Import(c, project, csv, new { title = 0, description = 1, status = 2, priority = 3, assignee = 4, startDate = 5, dueDate = 6, estimatedHours = 7, labels = 8, milestone = 9 });
        Assert.Equal(HttpStatusCode.Created, res.Status);
        Assert.Equal(2, res.Data!["created"]!.GetValue<int>());
        Assert.Equal(1, res.Data["labelsCreated"]!.GetValue<int>()); // "New" is created, "Backend" already existed

        var tasks = await Tasks(c, project);
        var api = tasks.Single(t => t!["title"]!.GetValue<string>() == "Build API")!;
        Assert.Equal("Multi\nline", api["description"]!.GetValue<string>());
        Assert.Equal("In Progress", api["statusName"]!.GetValue<string>());
        Assert.Equal("High", api["priority"]!.GetValue<string>());
        Assert.Equal(member.UserId.ToString(), api["assignee"]!["id"]!.GetValue<string>());
        Assert.Equal("2026-10-01", api["startDate"]!.GetValue<string>());
        Assert.Equal("2026-10-15", api["dueDate"]!.GetValue<string>());
        Assert.Equal(8.5m, api["estimatedHours"]!.GetValue<decimal>());
        Assert.Equal(new[] { "Backend", "New" }, api["labels"]!.AsArray().Select(l => l!["name"]!.GetValue<string>()).OrderBy(x => x));
        Assert.Equal("Beta", api["milestoneName"]!.GetValue<string>());
        // Defaults for a sparse row, and the person was matched by name.
        var docs = tasks.Single(t => t!["title"]!.GetValue<string>() == "Write docs")!;
        Assert.Equal("Medium", docs["priority"]!.GetValue<string>());
        Assert.Equal("Yet To Start", docs["statusName"]!.GetValue<string>());
        Assert.Equal(member.UserId.ToString(), docs["assignee"]!["id"]!.GetValue<string>());
        Assert.NotEqual(api["number"]!.GetValue<int>(), docs["number"]!.GetValue<int>());

        Assert.Contains("Imported 2 tasks", (await c.Get($"/api/v1/projects/{project}/activity")).Data!.ToJsonString());
    }

    [Fact]
    public async Task Invalid_rows_stop_the_import_unless_they_are_skipped()
    {
        var (c, project) = await Setup();
        var csv = "Title,Status\nGood,Done\nBad,Nonsense\nAlso good,\n";
        var strict = await Import(c, project, csv);
        Assert.Equal(HttpStatusCode.Conflict, strict.Status);
        Assert.Equal("IMPORT_INVALID_ROWS", strict.ErrorCode);
        Assert.Empty(await Tasks(c, project));   // all or nothing

        var lenient = await Import(c, project, csv, options: new { skipInvalid = true, createMissingLabels = true, dateFormat = "dmy" });
        Assert.Equal(HttpStatusCode.Created, lenient.Status);
        Assert.Equal(2, lenient.Data!["created"]!.GetValue<int>());
        Assert.Equal(1, lenient.Data["skipped"]!.GetValue<int>());
        Assert.Contains("Nonsense", lenient.Data["errors"]![0]!["message"]!.GetValue<string>());
        Assert.Equal(2, (await Tasks(c, project)).Count);

        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await Import(c, project, "Title\n\n", options: new { skipInvalid = true, createMissingLabels = true, dateFormat = "dmy" })).Status); // nothing valid
    }

    [Fact]
    public async Task Dates_follow_the_chosen_format_and_labels_can_be_required_to_exist()
    {
        var (c, project) = await Setup();
        var csv = "Title,Due,Tags\nA,03/04/2026,Ghost\n";
        var mdy = await Import(c, project, csv, new { title = 0, dueDate = 1 }, new { skipInvalid = false, createMissingLabels = true, dateFormat = "mdy" });
        Assert.True(mdy.Ok, mdy.ToString());
        Assert.Equal("2026-03-04", (await Tasks(c, project))[0]!["dueDate"]!.GetValue<string>());

        var dmy = await Import(c, project, csv.Replace("A,", "B,"), new { title = 0, dueDate = 1 }, new { skipInvalid = false, createMissingLabels = true, dateFormat = "dmy" });
        Assert.True(dmy.Ok);
        Assert.Equal("2026-04-03", (await Tasks(c, project)).Single(t => t!["title"]!.GetValue<string>() == "B")!["dueDate"]!.GetValue<string>());

        var strictLabels = await Import(c, project, csv.Replace("A,", "C,"), new { title = 0, labels = 2 }, new { skipInvalid = false, createMissingLabels = false, dateFormat = "dmy" });
        Assert.Equal(HttpStatusCode.Conflict, strictLabels.Status);
    }

    [Fact]
    public async Task Custom_priority_names_are_understood_and_numbering_continues()
    {
        var (c, project) = await Setup();
        await c.Put("/api/v1/priorities", new { items = new[] { new { level = "Critical", name = "P0", color = "#ff0000" } } });
        var existing = await c.CreateTaskAsync(project, "Existing");
        var res = await Import(c, project, "Title,Priority\nUrgent,P0\nNormal,low\n", new { title = 0, priority = 1 });
        Assert.True(res.Ok, res.ToString());
        var tasks = await Tasks(c, project);
        Assert.Equal("Critical", tasks.Single(t => t!["title"]!.GetValue<string>() == "Urgent")!["priority"]!.GetValue<string>());
        Assert.Equal("Low", tasks.Single(t => t!["title"]!.GetValue<string>() == "Normal")!["priority"]!.GetValue<string>());
        var numbers = tasks.Select(t => t!["number"]!.GetValue<int>()).OrderBy(x => x).ToList();
        Assert.Equal(Enumerable.Range(numbers[0], 3), numbers);
        Assert.Equal(existing["number"]!.GetValue<int>(), numbers[0]);
    }

    [Fact]
    public async Task Import_respects_plan_limits_permissions_and_project_state()
    {
        var (free, freeProject) = await Setup("FREE");
        var rows = string.Join("\n", Enumerable.Range(1, 501).Select(i => $"Task {i}"));
        var over = await Import(free, freeProject, "Title\n" + rows + "\n");
        Assert.False(over.Ok);                       // the Free plan holds 500 tasks
        Assert.Empty(await Tasks(free, freeProject));

        var (c, project) = await Setup();
        var guest = await c.AddMemberAsync(factory, TenantRole.Guest, "Guest");
        Assert.False((await Import(guest, project, "Title\nA\n")).Ok);
        var stranger = await TestClient.RegisterAsync(factory);
        Assert.Equal(HttpStatusCode.NotFound, (await Preview(stranger, project, "Title\nA\n")).Status);

        // Archived projects are read-only.
        Assert.True((await c.Send(HttpMethod.Patch, $"/api/v1/projects/{project}/move", new { status = "Archived" })).Ok);
        var archived = await Import(c, project, "Title\nA\n");
        Assert.Equal(HttpStatusCode.Conflict, archived.Status);
        Assert.Equal("PROJECT_ARCHIVED", archived.ErrorCode);
    }

    [Fact]
    public async Task Formula_like_cells_are_stored_as_plain_text_and_large_files_are_refused()
    {
        var (c, project) = await Setup();
        var res = await Import(c, project, "Title\n=cmd|' /C calc'!A0\n");
        Assert.True(res.Ok, res.ToString());
        Assert.Equal("=cmd|' /C calc'!A0", (await Tasks(c, project))[0]!["title"]!.GetValue<string>()); // kept as typed; exports neutralise it

        var big = "Title\n" + new string('x', 2 * 1024 * 1024 + 10);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await Preview(c, project, big)).Status);
    }
}
