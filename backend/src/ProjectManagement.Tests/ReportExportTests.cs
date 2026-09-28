using System.Net;
using System.Text;
using ClosedXML.Excel;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Features.Reports;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Reports as CSV / Excel / PDF, generated in the background under the requester's own rights.</summary>
[Collection("api")]
public class ReportExportTests(ApiFactory factory)
{
    private async Task<(TestClient C, Guid Project)> Setup(string plan = "BUSINESS")
    {
        var c = await TestClient.RegisterAsync(factory);
        await c.CreateOrgAsync();
        if (plan != "FREE") await c.UpgradeAsync(plan);
        return (c, await c.CreateProjectAsync("Atlas"));
    }

    private async Task<int> RunWorkerAsync() => await factory.Services.GetRequiredService<ReportExportProcessor>().ProcessPendingAsync();

    private static async Task<Guid> Request(TestClient c, string kind, string format, Guid? project = null, int? days = null)
    {
        var res = await c.Post("/api/v1/reports/exports", new { kind, format, projectId = project, days });
        Assert.Equal(HttpStatusCode.Accepted, res.Status);
        Assert.Equal("Queued", res.Data!["status"]!.GetValue<string>());
        return Guid.Parse(res.Data["id"]!.GetValue<string>());
    }

    private static async Task<byte[]> Download(TestClient c, Guid id)
    {
        var res = await c.Raw($"/api/v1/reports/exports/{id}/file");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        return await res.Content.ReadAsByteArrayAsync();
    }

    [Fact]
    public async Task A_report_is_queued_then_built_in_the_background_and_downloaded()
    {
        var (c, project) = await Setup();
        await c.CreateTaskAsync(project, "Write the spec");
        var id = await Request(c, "Project", "Csv");

        // Nothing is built inside the request; it waits for the worker.
        Assert.Equal("Queued", (await c.Get($"/api/v1/reports/exports/{id}")).Data!["status"]!.GetValue<string>());
        Assert.Equal(HttpStatusCode.Conflict, (await c.Get($"/api/v1/reports/exports/{id}/file")).Status);

        Assert.True(await RunWorkerAsync() >= 1);
        var status = (await c.Get($"/api/v1/reports/exports/{id}")).Data!;
        Assert.Equal("Ready", status["status"]!.GetValue<string>());
        Assert.EndsWith(".csv", status["fileName"]!.GetValue<string>());

        var csv = Encoding.UTF8.GetString(await Download(c, id));
        Assert.Contains("Write the spec", csv);
        Assert.Matches(@"[A-Z]+-1,", csv);

        // Nothing left to do on the next tick, and the person got told.
        Assert.True(await RunWorkerAsync() >= 0);
        Assert.Contains("Your Project report is ready", (await c.Get("/api/v1/notifications?pageSize=50")).Data!.ToJsonString());
    }

    [Fact]
    public async Task Excel_and_pdf_files_are_valid()
    {
        var (c, project) = await Setup();
        await c.CreateTaskAsync(project, "Plain task");
        await c.CreateTaskAsync(project, "=HYPERLINK(\"http://evil\")");
        var xlsx = await Request(c, "Project", "Xlsx");
        var pdf = await Request(c, "Timesheet", "Pdf");
        await RunWorkerAsync();

        using (var wb = new XLWorkbook(new MemoryStream(await Download(c, xlsx))))
        {
            var ws = wb.Worksheet("Tasks");
            Assert.Equal("Key", ws.Cell(1, 1).GetString());
            var titles = ws.Column(2).CellsUsed().Select(x => x.GetString()).ToList();
            Assert.Contains("Plain task", titles);
            // A title that looks like a formula is stored as text, never executed.
            Assert.DoesNotContain(ws.Column(2).CellsUsed(), x => x.HasFormula);
            var risky = ws.Column(2).CellsUsed().Single(x => x.GetString().Contains("HYPERLINK"));
            Assert.Equal(XLDataType.Text, risky.DataType);
        }

        var bytes = await Download(c, pdf);
        var text = Encoding.Latin1.GetString(bytes);
        Assert.StartsWith("%PDF-1.4", text);
        Assert.Contains("%%EOF", text);
        Assert.Contains("Timesheet", text);
        Assert.Matches(@"Page 1 of [0-9]+", text);
    }

    [Fact]
    public void Long_reports_span_pages_and_survive_awkward_text()
    {
        var rows = Enumerable.Range(1, 200).Select(i => (IReadOnlyList<object?>)new object?[] { $"T-{i}", $"Task (with) \\ odd “quotes” – and ünïcode 日本 {i}", i, 1.5m, DateOnly.FromDayNumber(739000 + i) }).ToList();
        var doc = new ReportDocument("Big", "test", [new ReportSection("Rows", ["Key", "Title", "N", "Hours", "Due"], rows)]);
        var pdf = Encoding.Latin1.GetString(ReportWriter.Write(doc, ReportFormat.Pdf).Content);
        Assert.Matches(@"Page 1 of [2-9]", pdf);
        Assert.Contains("/Count", pdf);
        // Every xref offset must point at an object: check the last entry's start.
        var xref = int.Parse(System.Text.RegularExpressions.Regex.Match(pdf, @"startxref\n(\d+)").Groups[1].Value);
        Assert.StartsWith("xref", pdf[xref..]);
    }

    [Fact]
    public async Task Timesheet_and_project_scoped_reports_only_contain_what_they_should()
    {
        var (c, project) = await Setup();
        var other = await c.CreateProjectAsync("Other");
        await c.CreateTaskAsync(project, "In Atlas");
        await c.CreateTaskAsync(other, "In Other");
        var task = Guid.Parse((await c.CreateTaskAsync(project, "Timed"))["id"]!.GetValue<string>());
        await c.Post($"/api/v1/tasks/{task}/time", new { minutes = 90, note = "Deep work" });

        var scoped = await Request(c, "Project", "Csv", project);
        var sheet = await Request(c, "Timesheet", "Csv", null, 7);
        var sheetScoped = await Request(c, "Timesheet", "Csv", project, 7);
        await RunWorkerAsync();

        var csv = Encoding.UTF8.GetString(await Download(c, scoped));
        Assert.Contains("In Atlas", csv);
        Assert.DoesNotContain("In Other", csv);
        var time = Encoding.UTF8.GetString(await Download(c, sheet));
        Assert.Contains("Deep work", time);
        Assert.Contains("1.5", time);

        // A timesheet CAN be narrowed to a project - "team/project-wise working hours".
        var scopedTime = Encoding.UTF8.GetString(await Download(c, sheetScoped));
        Assert.Contains("Deep work", scopedTime);

        // A workload report cannot be narrowed to a project - it is per person, not per project.
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Post("/api/v1/reports/exports", new { kind = "Workload", format = "Csv", projectId = project })).Status);
    }

    [Fact]
    public async Task Workload_and_timesheet_reports_can_target_one_person_but_only_within_reach()
    {
        var (owner, project) = await Setup();
        var manager = await owner.AddMemberAsync(factory, TenantRole.Manager, "Mgr");
        var report = await owner.AddMemberAsync(factory, TenantRole.Member, "Rep");
        var stranger = await owner.AddMemberAsync(factory, TenantRole.Member, "Str");
        Assert.Equal(HttpStatusCode.NoContent, (await owner.Put($"/api/v1/org/members/{report.UserId}/reports-to", new { reportsToUserId = manager.UserId })).Status);
        var task = Guid.Parse((await owner.CreateTaskAsync(project, "Rep's task", new { title = "Rep's task", priority = "Medium", assigneeId = report.UserId }))["id"]!.GetValue<string>());
        await report.Post($"/api/v1/tasks/{task}/time", new { minutes = 45, note = "Report's own work" });

        // The manager can target their own report...
        var forReport = await manager.Post("/api/v1/reports/exports", new { kind = "Timesheet", format = "Csv", targetUserId = report.UserId, days = 7 });
        Assert.Equal(HttpStatusCode.Accepted, forReport.Status);
        // ...but not a stranger outside their line.
        var forStranger = await manager.Post("/api/v1/reports/exports", new { kind = "Timesheet", format = "Csv", targetUserId = stranger.UserId, days = 7 });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, forStranger.Status);
        var workloadForStranger = await manager.Post("/api/v1/reports/exports", new { kind = "Workload", format = "Csv", targetUserId = stranger.UserId });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, workloadForStranger.Status);
        // The owner (broad reports access) can target anyone.
        Assert.Equal(HttpStatusCode.Accepted, (await owner.Post("/api/v1/reports/exports", new { kind = "Timesheet", format = "Csv", targetUserId = stranger.UserId, days = 7 })).Status);

        // With no target at all, the manager's timesheet report covers their team, not the whole workspace.
        var teamWide = await manager.Post("/api/v1/reports/exports", new { kind = "Timesheet", format = "Csv", days = 7 });
        Assert.Equal(HttpStatusCode.Accepted, teamWide.Status);
        await RunWorkerAsync();
        var csv = Encoding.UTF8.GetString(await Download(manager, Guid.Parse(teamWide.Data!["id"]!.GetValue<string>())));
        Assert.Contains("Report's own work", csv);
    }

    [Fact]
    public async Task Spreadsheets_and_pdfs_need_the_advanced_reports_feature_but_csv_does_not()
    {
        var (c, _) = await Setup("FREE");
        Assert.Equal(HttpStatusCode.Forbidden, (await c.Post("/api/v1/reports/exports", new { kind = "Project", format = "Xlsx" })).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await c.Post("/api/v1/reports/exports", new { kind = "Workload", format = "Pdf" })).Status);
        Assert.Equal(HttpStatusCode.Accepted, (await c.Post("/api/v1/reports/exports", new { kind = "Workload", format = "Csv" })).Status);
    }

    [Fact]
    public async Task Reports_belong_to_the_person_who_asked_and_need_the_reports_permission()
    {
        var (c, _) = await Setup();
        var id = await Request(c, "Project", "Csv");
        await RunWorkerAsync();

        var admin = await c.AddMemberAsync(factory, TenantRole.Admin, "Adm");
        Assert.Equal(HttpStatusCode.NotFound, (await admin.Get($"/api/v1/reports/exports/{id}")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await admin.Get($"/api/v1/reports/exports/{id}/file")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await admin.Delete($"/api/v1/reports/exports/{id}")).Status);
        Assert.Empty((await admin.Get("/api/v1/reports/exports")).Data!.AsArray());

        var guest = await c.AddMemberAsync(factory, TenantRole.Guest, "Guest");
        Assert.False((await guest.Post("/api/v1/reports/exports", new { kind = "Project", format = "Csv" })).Ok);
        var stranger = await TestClient.RegisterAsync(factory);
        Assert.Equal(HttpStatusCode.NotFound, (await stranger.Get($"/api/v1/reports/exports/{id}")).Status);
    }

    [Fact]
    public async Task Access_is_checked_again_when_the_report_is_built()
    {
        var (c, _) = await Setup();
        var member = await c.AddMemberAsync(factory, TenantRole.Manager, "Mgr");
        var id = await Request(member, "Project", "Csv");

        // They leave the workspace before the worker gets to it: no data is produced.
        factory.WithDb(db => { db.TenantMembers.IgnoreQueryFilters().Where(m => m.UserId == member.UserId && m.TenantId == c.WorkspaceId).ExecuteDelete(); return 0; });
        await RunWorkerAsync();
        var (status, file) = factory.WithDb(db => { var e = db.ReportExports.IgnoreQueryFilters().Single(x => x.Id == id); return (e.Status, e.StorageKey); });
        Assert.Equal(ReportExportStatus.Failed, status);
        Assert.Null(file);
    }

    [Fact]
    public async Task Only_a_few_reports_can_wait_at_once_and_they_can_be_deleted()
    {
        var (c, _) = await Setup();
        var ids = new List<Guid>();
        for (var i = 0; i < 3; i++) ids.Add(await Request(c, "Workload", "Csv"));
        var fourth = await c.Post("/api/v1/reports/exports", new { kind = "Workload", format = "Csv" });
        Assert.Equal(HttpStatusCode.Conflict, fourth.Status);
        Assert.Equal("TOO_MANY_PENDING", fourth.ErrorCode);

        await RunWorkerAsync();
        Assert.Equal(HttpStatusCode.NoContent, (await c.Delete($"/api/v1/reports/exports/{ids[0]}")).Status);
        Assert.Equal(2, (await c.Get("/api/v1/reports/exports")).Data!.AsArray().Count);
        Assert.Equal(HttpStatusCode.Accepted, (await c.Post("/api/v1/reports/exports", new { kind = "Workload", format = "Csv" })).Status);
    }

    [Fact]
    public async Task Expired_reports_are_removed_with_their_files()
    {
        var (c, _) = await Setup();
        var id = await Request(c, "Project", "Csv");
        await RunWorkerAsync();
        var key = factory.WithDb(db => db.ReportExports.IgnoreQueryFilters().Single(e => e.Id == id).StorageKey!);
        var path = Path.Combine(factory.FilesPath, key.Replace('/', Path.DirectorySeparatorChar));
        Assert.True(File.Exists(path));

        factory.WithDb(db => { db.ReportExports.IgnoreQueryFilters().Where(e => e.Id == id).ExecuteUpdate(s => s.SetProperty(e => e.ExpiresAt, DateTime.UtcNow.AddDays(-1))); return 0; });
        Assert.Equal(HttpStatusCode.NotFound, (await c.Get($"/api/v1/reports/exports/{id}/file")).Status);

        using var scope = factory.Services.CreateScope();
        Assert.Equal(1, await scope.ServiceProvider.GetRequiredService<ReportExportService>().PurgeExpiredAsync());
        Assert.False(File.Exists(path));
        Assert.Equal(HttpStatusCode.NotFound, (await c.Get($"/api/v1/reports/exports/{id}")).Status);
    }
}
