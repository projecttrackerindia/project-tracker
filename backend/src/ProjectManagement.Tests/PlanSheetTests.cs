using System.Net;
using System.Text.Json.Nodes;
using ClosedXML.Excel;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Portfolio › Plan sheet: one grid of projects, tasks, sub-items and dependencies; bulk edits that go through each row's own path (one reason for
/// every due date that moves later, errors per row, version conflicts per row); paste from Excel as a dry run and then a commit (title match updates,
/// fuzzy owner names, bad rows never saved); the export as a real .xlsx and a .csv; and the timeline's forecast with how it was worked out.
/// Fictional data only.
/// </summary>
[Collection("api")]
public class PlanSheetTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private static string Iso(DateOnly d) => d.ToString("yyyy-MM-dd");
    private static DateOnly Today => DateOnly.FromDateTime(DateTime.UtcNow);

    private sealed record Seed(TestClient C, Guid Project, string Key, Guid A, Guid B, Guid Sub, Guid Other);

    private async Task<Seed> SeedAsync()
    {
        var c = await TestClient.RegisterAsync(factory, "Asha Rao");
        await c.CreateOrgAsync();
        await c.UpgradeAsync("BUSINESS");
        var created = await c.Post("/api/v1/projects", new { name = "Card Vault", priority = "Medium", ownerId = c.UserId, startDate = Iso(Today.AddDays(-20)), dueDate = Iso(Today.AddDays(40)) });
        Assert.True(created.Ok, created.ToString());
        var project = Guid.Parse(S(created.Data!["project"]!["id"]));
        var key = S(created.Data!["project"]!["key"]);
        var a = Guid.Parse(S((await c.CreateTaskAsync(project, "Tokenise stored cards", new { title = "Tokenise stored cards", priority = "Medium", assigneeId = c.UserId, startDate = Iso(Today.AddDays(-10)), dueDate = Iso(Today.AddDays(5)) }))["id"]));
        var b = Guid.Parse(S((await c.CreateTaskAsync(project, "PCI evidence pack", new { title = "PCI evidence pack", priority = "Medium", dueDate = Iso(Today.AddDays(-2)) }))["id"]));
        var sub = Guid.Parse(S((await c.CreateTaskAsync(project, "HSM key ceremony", new { title = "HSM key ceremony", priority = "Medium", parentTaskId = a, dueDate = Iso(Today.AddDays(3)) }))["id"]));
        var other = Guid.Parse(S((await c.CreateTaskAsync(project, "Re-encrypt archive", new { title = "Re-encrypt archive", priority = "Medium", dueDate = Iso(Today.AddDays(9)) }))["id"]));
        Assert.True((await c.Post($"/api/v1/tasks/{other}/dependencies", new { dependsOnTaskId = a })).Ok);
        return new Seed(c, project, key, a, b, sub, other);
    }

    private static async Task<int> Version(TestClient c, Guid id) => (await c.Get($"/api/v1/work-items/{id}")).Data!["version"]!.GetValue<int>();

    [Fact]
    public async Task The_sheet_groups_project_task_and_sub_items_with_dependencies_and_late_rows()
    {
        var s = await SeedAsync();
        var res = await s.C.Get("/api/v1/portfolio/sheet");
        Assert.True(res.Ok, res.ToString());
        var rows = res.Data!["rows"]!.AsArray();
        var project = rows.Single(r => S(r!["kind"]) == "project" && S(r["id"]) == s.Project.ToString())!;
        Assert.Equal(s.Key, S(project["key"]));
        var sub = rows.Single(r => S(r!["id"]) == s.Sub.ToString())!;
        Assert.Equal("subtask", S(sub["kind"]));
        Assert.Equal(s.A.ToString(), S(sub["parentId"]));
        Assert.Equal(2, sub["level"]!.GetValue<int>());
        var other = rows.Single(r => S(r!["id"]) == s.Other.ToString())!;
        Assert.Contains(other["dependsOn"]!.AsArray(), d => S(d).StartsWith(s.Key + "-"));
        Assert.True(rows.Single(r => S(r!["id"]) == s.B.ToString())!["late"]!.GetValue<bool>(), "a due date in the past is late");
        // Children come right after their parent.
        var ids = rows.Select(r => S(r!["id"])).ToList();
        Assert.Equal(ids.IndexOf(s.A.ToString()) + 1, ids.IndexOf(s.Sub.ToString()));
        Assert.Contains(res.Data!["people"]!.AsArray(), p => S(p!["id"]) == s.C.UserId.ToString());
        Assert.Contains(res.Data!["scopes"]!.AsArray(), x => S(x!["id"]) == "managed" && !x["allowed"]!.GetValue<bool>());
        Assert.Equal(0, (await s.C.Get($"/api/v1/portfolio/sheet?ownerId={Guid.NewGuid()}")).Data!["rows"]!.AsArray().Count);
    }

    [Fact]
    public async Task Bulk_edit_asks_one_reason_for_later_due_dates_and_reports_each_row()
    {
        var s = await SeedAsync();
        var later = Iso(Today.AddDays(20));
        // Without a reason, moving due dates later fails for each of those rows only; the start date change on the other row is saved.
        var first = await s.C.Post("/api/v1/portfolio/sheet/bulk", new
        {
            changes = new object[]
            {
                new { id = s.A, version = await Version(s.C, s.A), dueDate = later },
                new { id = s.Other, version = await Version(s.C, s.Other), startDate = Iso(Today.AddDays(1)) },
            },
        });
        Assert.True(first.Ok, first.ToString());
        var rows = first.Data!["rows"]!.AsArray();
        Assert.Equal(1, first.Data!["changed"]!.GetValue<int>());
        var refused = rows.Single(r => S(r!["id"]) == s.A.ToString())!;
        Assert.False(refused["ok"]!.GetValue<bool>());
        Assert.Equal("dueDateReason", S(refused["field"]));
        Assert.True(rows.Single(r => S(r!["id"]) == s.Other.ToString())!["ok"]!.GetValue<bool>());

        // With one reason for the batch: both due dates move and the reason is recorded; a stale version and an unknown id fail on their own.
        var stale = await Version(s.C, s.Other) - 1;
        var second = await s.C.Post("/api/v1/portfolio/sheet/bulk", new
        {
            dueDateReason = "Vendor slot moved",
            changes = new object[]
            {
                new { id = s.A, version = await Version(s.C, s.A), dueDate = later, dueTime = "18:00" },
                new { id = s.B, version = await Version(s.C, s.B), dueDate = later, assigneeId = s.C.UserId },
                new { id = s.Other, version = stale, dueDate = later },
                new { id = Guid.NewGuid(), dueDate = later },
            },
        });
        Assert.True(second.Ok, second.ToString());
        Assert.Equal(2, second.Data!["changed"]!.GetValue<int>());
        Assert.Equal(2, second.Data!["failed"]!.GetValue<int>());
        var r2 = second.Data!["rows"]!.AsArray();
        Assert.Equal("VERSION_CONFLICT", S(r2.Single(r => S(r!["id"]) == s.Other.ToString())!["code"]));
        Assert.Equal(later, S((await s.C.Get($"/api/v1/work-items/{s.A}")).Data!["dueDate"]));
        Assert.Equal(s.C.UserId.ToString(), S((await s.C.Get($"/api/v1/work-items/{s.B}")).Data!["assignee"]!["id"]));
        var status = (await s.C.Get($"/api/v1/project-status/projects/{s.Project}")).Data!;
        Assert.Contains(status["changes"]!.AsArray(), ch => ch!["reason"]?.GetValue<string>() == "Vendor slot moved");

        // A project row: owner and dates through the project's own update, with the same reason rule.
        var pv = (await s.C.Get($"/api/v1/projects/{s.Project}")).Data!["project"]!["version"]!.GetValue<int>();
        var moved = await s.C.Post("/api/v1/portfolio/sheet/bulk", new { dueDateReason = "Scope changed", changes = new[] { new { id = s.Project, version = pv, dueDate = Iso(Today.AddDays(50)) } } });
        Assert.True(moved.Data!["rows"]![0]!["ok"]!.GetValue<bool>(), moved.ToString());
        Assert.Equal(Iso(Today.AddDays(50)), S((await s.C.Get($"/api/v1/projects/{s.Project}")).Data!["project"]!["dueDate"]));
        Assert.Equal(422, (int)(await s.C.Post("/api/v1/portfolio/sheet/bulk", new { changes = Array.Empty<object>() })).Status);
    }

    [Fact]
    public async Task Progress_and_notes_are_edited_on_the_sheet_and_kept_with_the_task()
    {
        var s = await SeedAsync();
        var res = await s.C.Post("/api/v1/portfolio/sheet/bulk", new { changes = new object[] { new { id = s.B, version = await Version(s.C, s.B), progress = 45, notes = "Waiting on @Lena for the auditor letter" } } });
        Assert.True(res.Ok, res.ToString());
        Assert.True(res.Data!["rows"]![0]!["ok"]!.GetValue<bool>(), res.ToString());
        var row = (await s.C.Get("/api/v1/portfolio/sheet")).Data!["rows"]!.AsArray().Single(r => S(r!["id"]) == s.B.ToString())!;
        Assert.Equal(45, row["progress"]!.GetValue<int>());
        Assert.True(row["manualProgress"]!.GetValue<bool>());
        Assert.Equal("Waiting on @Lena for the auditor letter", S(row["notes"]));
        // Out of range is refused for that row; clearing goes back to the worked-out value.
        var bad = await s.C.Post("/api/v1/portfolio/sheet/bulk", new { changes = new object[] { new { id = s.B, version = await Version(s.C, s.B), progress = 140 } } });
        Assert.False(bad.Data!["rows"]![0]!["ok"]!.GetValue<bool>());
        var clear = await s.C.Post("/api/v1/portfolio/sheet/bulk", new { changes = new object[] { new { id = s.B, version = await Version(s.C, s.B), clearProgress = true } } });
        Assert.True(clear.Data!["rows"]![0]!["ok"]!.GetValue<bool>(), clear.ToString());
        row = (await s.C.Get("/api/v1/portfolio/sheet")).Data!["rows"]!.AsArray().Single(r => S(r!["id"]) == s.B.ToString())!;
        Assert.False(row["manualProgress"]!.GetValue<bool>());
        // Slip: the due date moved 5 days later than it first was (the date history).
        var later = await s.C.Post("/api/v1/portfolio/sheet/bulk", new { dueDateReason = "Auditor slot moved", changes = new object[] { new { id = s.B, version = await Version(s.C, s.B), dueDate = Iso(Today.AddDays(3)) } } });
        Assert.True(later.Data!["rows"]![0]!["ok"]!.GetValue<bool>(), later.ToString());
        row = (await s.C.Get("/api/v1/portfolio/sheet")).Data!["rows"]!.AsArray().Single(r => S(r!["id"]) == s.B.ToString())!;
        Assert.Equal(5, row["slipDays"]!.GetValue<int>());
    }

    [Fact]
    public async Task A_dragged_row_moves_within_its_project_or_into_another_one()
    {
        var s = await SeedAsync();
        // Reorder: B dropped before A.
        var res = await s.C.Post("/api/v1/portfolio/sheet/move", new { id = s.B, beforeId = s.A, version = await Version(s.C, s.B) });
        Assert.True(res.Ok, res.ToString());
        Assert.False(res.Data!["movedProject"]!.GetValue<bool>());
        var ids = (await s.C.Get("/api/v1/portfolio/sheet")).Data!["rows"]!.AsArray().Where(r => S(r!["projectId"]) == s.Project.ToString() && S(r!["kind"]) == "task").Select(r => S(r!["id"])).ToList();
        Assert.True(ids.IndexOf(s.B.ToString()) < ids.IndexOf(s.A.ToString()), string.Join(",", ids));

        // Into another project: next number and key there.
        var other = await s.C.Post("/api/v1/projects", new { name = "Bureau Bridge", priority = "Medium", ownerId = s.C.UserId, startDate = Iso(Today), dueDate = Iso(Today.AddDays(30)) });
        var target = Guid.Parse(S(other.Data!["project"]!["id"]));
        var targetKey = S(other.Data!["project"]!["key"]);
        var moved = await s.C.Post("/api/v1/portfolio/sheet/move", new { id = s.B, projectId = target, version = await Version(s.C, s.B) });
        Assert.True(moved.Ok, moved.ToString());
        Assert.True(moved.Data!["movedProject"]!.GetValue<bool>());
        Assert.Equal($"{targetKey}-1", S(moved.Data!["key"]));
        var row = (await s.C.Get("/api/v1/portfolio/sheet")).Data!["rows"]!.AsArray().Single(r => S(r!["id"]) == s.B.ToString())!;
        Assert.Equal(target.ToString(), S(row["projectId"]));

        // A task with dependencies (or sub-items) stays: dependencies live inside one project.
        var refused = await s.C.Post("/api/v1/portfolio/sheet/move", new { id = s.Other, projectId = target });
        Assert.Equal(422, (int)refused.Status);
        var parent = await s.C.Post("/api/v1/portfolio/sheet/move", new { id = s.A, projectId = target });
        Assert.Equal(422, (int)parent.Status);
        // A stale version is a conflict.
        Assert.Equal(409, (int)(await s.C.Post("/api/v1/portfolio/sheet/move", new { id = s.A, afterId = s.Other, version = await Version(s.C, s.A) + 5 })).Status);
    }

    [Fact]
    public async Task Paste_from_Excel_is_a_dry_run_first_then_saves_only_the_ready_rows()
    {
        var s = await SeedAsync();
        var before = (await s.C.Get("/api/v1/portfolio/sheet")).Data!["rows"]!.AsArray().Count;
        var body = new
        {
            projectId = s.Project,
            rows = new object[]
            {
                new { title = "Load test mandate API", owner = "Asha Rao", start = Iso(Today.AddDays(2)), due = Iso(Today.AddDays(6)), status = "Not started" },
                new { title = "Tokenise stored cards", owner = "asha r", due = Iso(Today.AddDays(12)) },
                new { title = "Ops handover", owner = "ops team", start = "11/31", status = "Not started" },
            },
        };
        var dry = await s.C.Post("/api/v1/portfolio/sheet/paste", body);
        Assert.True(dry.Ok, dry.ToString());
        var rows = dry.Data!["rows"]!.AsArray();
        Assert.Equal("create", S(rows[0]!["action"]));
        Assert.Equal("exact", S(rows[0]!["ownerMatch"]));
        Assert.Equal("update", S(rows[1]!["action"]));
        Assert.Equal("fuzzy", S(rows[1]!["ownerMatch"]));
        Assert.Equal(s.A.ToString(), S(rows[1]!["matchedId"]));
        Assert.True(rows[1]!["needsReason"]!.GetValue<bool>());
        Assert.Equal("error", S(rows[2]!["action"]));
        Assert.False(rows[2]!["ready"]!.GetValue<bool>());
        Assert.Equal(2, rows[2]!["problems"]!.AsArray().Count);   // owner unknown and the date is not a date
        Assert.Equal(2, dry.Data!["ready"]!.GetValue<int>());
        Assert.Equal(before, (await s.C.Get("/api/v1/portfolio/sheet")).Data!["rows"]!.AsArray().Count);   // the dry run saved nothing

        // Commit: the update moves a due date later, so a reason is needed; then the two ready rows are saved and the bad one is not.
        Assert.Equal(422, (int)(await s.C.Post("/api/v1/portfolio/sheet/paste", new { body.projectId, body.rows, commit = true })).Status);
        var saved = await s.C.Post("/api/v1/portfolio/sheet/paste", new { body.projectId, body.rows, commit = true, include = new[] { 0, 1, 2 }, dueDateReason = "Client asked for more time" });
        Assert.True(saved.Ok, saved.ToString());
        Assert.Equal(2, saved.Data!["saved"]!.GetValue<int>());
        Assert.False(saved.Data!["rows"]![2]!["saved"]!.GetValue<bool>());
        var after = (await s.C.Get("/api/v1/portfolio/sheet")).Data!["rows"]!.AsArray();
        Assert.Equal(before + 1, after.Count);
        Assert.Contains(after, r => S(r!["title"]) == "Load test mandate API" && S(r["ownerId"]) == s.C.UserId.ToString());
        Assert.Equal(Iso(Today.AddDays(12)), S((await s.C.Get($"/api/v1/work-items/{s.A}")).Data!["dueDate"]));
    }

    [Fact]
    public async Task Export_is_a_real_workbook_with_outline_levels_and_a_csv()
    {
        var s = await SeedAsync();
        using (var res = await s.C.Raw("/api/v1/portfolio/sheet/export?format=xlsx&columns=Key,Title,Owner,Due,Status"))
        {
            Assert.Equal(HttpStatusCode.OK, res.StatusCode);
            Assert.Contains("spreadsheetml", res.Content.Headers.ContentType!.MediaType);
            var bytes = await res.Content.ReadAsByteArrayAsync();
            using var wb = new XLWorkbook(new MemoryStream(bytes));
            var ws = wb.Worksheet("Plan sheet");
            Assert.Equal("Key", ws.Cell(1, 1).GetString());
            Assert.Equal("Status", ws.Cell(1, 5).GetString());
            Assert.True(ws.Cell(1, 6).IsEmpty(), "only the visible columns");
            var used = ws.RowsUsed().ToList();
            Assert.Contains(used, r => r.Cell(2).GetString() == "HSM key ceremony" && r.OutlineLevel == 2);
            Assert.Contains(used, r => r.Cell(2).GetString() == "Card Vault" && r.OutlineLevel == 0);
            Assert.Contains(used, r => r.Cell(1).GetString().Contains("dates in", StringComparison.Ordinal));
        }
        using (var csv = await s.C.Raw("/api/v1/portfolio/sheet/export?format=csv"))
        {
            Assert.Equal(HttpStatusCode.OK, csv.StatusCode);
            var text = await csv.Content.ReadAsStringAsync();
            Assert.StartsWith("Key,Title,Owner", text.TrimStart('﻿'));
            Assert.Contains("PCI evidence pack", text);
        }
        Assert.Equal(422, (int)(await s.C.Get("/api/v1/portfolio/sheet/export?format=pdf")).Status);
    }

    [Fact]
    public async Task The_timeline_carries_the_forecast_and_how_it_was_worked_out()
    {
        var s = await SeedAsync();
        var line = (await s.C.Get("/api/v1/portfolio/timeline")).Data!["projects"]!.AsArray().Single(p => S(p!["id"]) == s.Project.ToString())!;
        Assert.Equal(s.C.UserId.ToString(), S(line["ownerId"]));
        Assert.Equal("Asha Rao", S(line["owner"]));
        Assert.True(line["version"]!.GetValue<int>() > 0);
        Assert.Equal(4, line["openTasks"]!.GetValue<int>());
        Assert.False(string.IsNullOrWhiteSpace(line["forecastBasis"]?.GetValue<string>()));

        // The arithmetic: open tasks over the pace of the last 4 weeks.
        var today = new DateOnly(2026, 10, 29);
        var (finish, slip, confidence) = AiPortfolio.Forecast(10, 7, today, new DateOnly(2026, 11, 21));
        Assert.Equal(today.AddDays(40), finish);   // 7 finished in 28 days = one every 4 days; 10 open = 40 days
        Assert.Equal(17, slip);
        Assert.Equal("medium", confidence);
        Assert.Equal(17, TimelineForecast.Slip(new DateOnly(2026, 11, 21), finish));
        Assert.Equal(0, TimelineForecast.Slip(new DateOnly(2026, 12, 31), finish));
        Assert.StartsWith("From pace, 4 wks: 7 done in 28 days, 10 open", TimelineForecast.Basis(confidence, 7, 10));
        Assert.Contains("nothing finished in 4 weeks", TimelineForecast.Basis("low", 0, 10));
        Assert.Equal("No open work left", TimelineForecast.Basis("high", 3, 0));
    }

    [Fact]
    public void Sheet_arithmetic_cadence_dates_owners_and_status_words()
    {
        var now = new DateTime(2026, 10, 29, 12, 0, 0, DateTimeKind.Utc);
        Assert.Equal(("Daily", (DateTime?)new DateTime(2026, 10, 30, 4, 0, 0, DateTimeKind.Utc)), PlanSheetMath.Cadence("FREQ=DAILY", new DateTime(2026, 10, 1, 4, 0, 0, DateTimeKind.Utc), now));
        Assert.Equal("Weekly", PlanSheetMath.Cadence("RRULE:FREQ=WEEKLY;BYDAY=MO", new DateTime(2026, 10, 5, 5, 30, 0, DateTimeKind.Utc), now).Cadence);
        Assert.Equal(new DateTime(2026, 11, 2, 5, 30, 0, DateTimeKind.Utc), PlanSheetMath.Cadence("RRULE:FREQ=WEEKLY;BYDAY=MO", new DateTime(2026, 10, 5, 5, 30, 0, DateTimeKind.Utc), now).Next);
        Assert.Equal("Monthly", PlanSheetMath.Cadence("FREQ=MONTHLY", new DateTime(2026, 9, 2, 10, 30, 0, DateTimeKind.Utc), now).Cadence);
        Assert.Equal(new DateTime(2026, 11, 2, 10, 30, 0, DateTimeKind.Utc), PlanSheetMath.Cadence("FREQ=MONTHLY", new DateTime(2026, 9, 2, 10, 30, 0, DateTimeKind.Utc), now).Next);
        Assert.Null(PlanSheetMath.Cadence("FREQ=DAILY;COUNT=3", new DateTime(2026, 10, 1, 4, 0, 0, DateTimeKind.Utc), now).Next);
        Assert.Equal(("Ad hoc", (DateTime?)null), PlanSheetMath.Cadence(null, new DateTime(2026, 10, 1, 4, 0, 0, DateTimeKind.Utc), now));

        var today = new DateOnly(2026, 10, 29);
        Assert.Equal(new DateOnly(2026, 11, 7), PlanSheetMath.ParseDate("7 Nov", today, out var bad1)); Assert.False(bad1);
        Assert.Equal(new DateOnly(2026, 11, 7), PlanSheetMath.ParseDate("7/11/2026", today, out _));
        Assert.Equal(new DateOnly(2026, 11, 7), PlanSheetMath.ParseDate("2026-11-07", today, out _));
        Assert.Null(PlanSheetMath.ParseDate("11/31", today, out var bad2)); Assert.True(bad2);
        Assert.Null(PlanSheetMath.ParseDate("  ", today, out var bad3)); Assert.False(bad3);

        var people = new[] { new PortfolioChoiceDto(Guid.NewGuid(), "Ravi Menon"), new PortfolioChoiceDto(Guid.NewGuid(), "Asha Rao"), new PortfolioChoiceDto(Guid.NewGuid(), "Ravi Kumar") };
        Assert.Equal("exact", PlanSheetMath.MatchOwner("asha  rao", people).Match);
        Assert.Equal(("Ravi Menon", "fuzzy"), (PlanSheetMath.MatchOwner("“Ravi M”", people).Name, PlanSheetMath.MatchOwner("“Ravi M”", people).Match));
        Assert.Equal("none", PlanSheetMath.MatchOwner("Ravi", people).Match);   // two Ravis: not a guess
        Assert.Equal("empty", PlanSheetMath.MatchOwner("", people).Match);

        var cols = new List<(Guid, string, StatusCategory)> { (Guid.NewGuid(), "To do", StatusCategory.Todo), (Guid.NewGuid(), "In progress", StatusCategory.Active), (Guid.NewGuid(), "Done", StatusCategory.Done) };
        Assert.Equal("To do", PlanSheetMath.MatchStatus("Not started", cols)!.Value.Name);
        Assert.Equal("In progress", PlanSheetMath.MatchStatus("in progress", cols)!.Value.Name);
        Assert.Null(PlanSheetMath.MatchStatus("Waiting", cols));

        Assert.Equal(100, PlanSheetMath.Progress(StatusCategory.Done, null, 0, 0));
        Assert.Equal(30, PlanSheetMath.Progress(StatusCategory.Active, (10, 3), 0, 0));
        Assert.Equal(50, PlanSheetMath.Progress(StatusCategory.Active, null, 2, 1));
        Assert.Equal(65, PlanSheetMath.Progress(StatusCategory.Active, (10, 3), 0, 0, 65));   // set by hand wins over the checklist
        Assert.Equal(100, PlanSheetMath.Progress(StatusCategory.Done, null, 0, 0, 40));
        Assert.Equal(1536, PlanSheetMath.Between(1024, 2048, 9000));
        Assert.Equal(3072, PlanSheetMath.Between(2048, null, 9000));
        Assert.Equal(10024, PlanSheetMath.Between(null, null, 9000));
        Assert.Equal("New note\nSecond line", PlanSheetMath.ReplaceFirstLine("Old note\nSecond line", "New note"));
        Assert.Equal("Only", PlanSheetMath.ReplaceFirstLine(null, " Only "));
        Assert.True(PlanSheetMath.AtRisk(today.AddDays(2), today, 40));
        Assert.False(PlanSheetMath.AtRisk(today.AddDays(2), today, 80));
        Assert.False(PlanSheetMath.AtRisk(today.AddDays(10), today, 0));
    }
}
