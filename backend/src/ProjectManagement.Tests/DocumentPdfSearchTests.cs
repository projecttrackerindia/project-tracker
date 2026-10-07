using System.Diagnostics;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Application.Features.Reports;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>PDF export, full-text search and the overview numbers of documents (release D6).</summary>
[Collection("api")]
public class DocumentPdfSearchTests(ApiFactory factory) : IAsyncLifetime
{
    public Task InitializeAsync() => Task.CompletedTask;
    public Task DisposeAsync()
    {
        factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Where(n => (n.Type == NotificationType.Document || n.Type == NotificationType.ReportReady) && (n.EmailPending || n.PushPending)).ExecuteUpdate(s => s.SetProperty(n => n.EmailPending, false).SetProperty(n => n.PushPending, false)));
        return Task.CompletedTask;
    }

    private static string S(JsonNode? n) => n!.GetValue<string>();
    private static string Text(string t) => $$"""{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"{{t}}"}]}]}""";

    private async Task<(TestClient Owner, Guid Brd)> Org(string plan = "BUSINESS")
    {
        var owner = await TestClient.RegisterAsync(factory, "Olive Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync(plan, 20);
        return (owner, Guid.Parse(S((await owner.Get("/api/v1/document-types")).Data!.AsArray().First(t => S(t!["code"]) == "BRD")!["id"])));
    }

    private static async Task<Guid> Make(TestClient c, Guid type, string title, Guid? project = null, string? visibility = null)
    {
        var res = await c.Post("/api/v1/documents", new { title, typeId = type, projectId = project, visibility });
        Assert.True(res.Ok, res.ToString());
        return Guid.Parse(S(res.Data!["item"]!["id"]));
    }

    private static async Task Write(TestClient c, Guid doc, string text, string section = "scope")
    {
        var rev = (await c.Get($"/api/v1/documents/{doc}")).Data!["revision"]!.GetValue<int>();
        var res = await c.Put($"/api/v1/documents/{doc}/sections", new { revision = rev, sections = new[] { new { key = section, content = Text(text) } } });
        Assert.True(res.Ok, res.ToString());
    }

    private static async Task Publish(TestClient c, Guid doc, string summary = "First version")
    {
        var rev = (await c.Get($"/api/v1/documents/{doc}")).Data!["revision"]!.GetValue<int>();
        var res = await c.Post($"/api/v1/documents/{doc}/publish", new { changeSummary = summary, major = false, revision = rev });
        Assert.True(res.Ok, res.ToString());
    }

    private static async Task<List<string>> Found(TestClient c, string q) =>
        (await c.Get($"/api/v1/documents?q={Uri.EscapeDataString(q)}")).Data!["items"]!.AsArray().Select(i => S(i!["title"])).ToList();

    /// <summary>The text a PDF reader would extract: every string drawn with Tj, unescaped.</summary>
    private static string Extract(byte[] pdf)
    {
        var raw = Encoding.Latin1.GetString(pdf);
        return string.Join('\n', Regex.Matches(raw, @"\(((?:[^()\\]|\\.)*)\) Tj").Select(m => Regex.Replace(m.Groups[1].Value, @"\\(.)", "$1")));
    }

    private async Task<byte[]> ExportAsync(TestClient c, Guid doc, Guid? version = null)
    {
        var res = await c.Post($"/api/v1/documents/{doc}/export", new { versionId = version });
        Assert.True(res.Ok, res.ToString());
        Assert.Equal("Queued", S(res.Data!["status"]));   // the request returns at once; nothing is rendered in it
        var id = S(res.Data["id"]);
        await factory.Services.GetRequiredService<ReportExportProcessor>().ProcessPendingAsync();
        var status = (await c.Get($"/api/v1/documents/{doc}/exports/{id}")).Data!;
        Assert.True(S(status["status"]) == "Ready", status.ToJsonString());
        Assert.EndsWith(".pdf", S(status["fileName"]));
        var file = await c.Raw($"/api/v1/documents/{doc}/exports/{id}/file");
        Assert.Equal(HttpStatusCode.OK, file.StatusCode);
        return await file.Content.ReadAsByteArrayAsync();
    }

    // ------------------------------------------------------------------ PDF

    [Fact]
    public async Task A_pdf_holds_the_document_its_approval_its_tables_its_api_and_its_history_but_never_a_secret()
    {
        var (owner, brd) = await Org();
        var project = await owner.CreateProjectAsync("Atlas");
        var reviewer = await owner.AddMemberAsync(factory, TenantRole.Member, "Rita Reviewer");
        await owner.Post("/api/v1/document-workflows", new { name = "Sign-off", isActive = true, remind = false, steps = new[] { new { name = "Business owner", kind = "User", principalId = reviewer.UserId, rule = "Any", dueDays = (int?)null } } });
        var doc = await Make(owner, brd, "Payments requirements", project);
        await Write(owner, doc, "Customers can pay by card and by bank transfer.");
        await owner.Post($"/api/v1/documents/{doc}/requirements", new { titles = new[] { "Refunds within 5 days" } });
        var def = await owner.Post($"/api/v1/documents/{doc}/api/definitions", new { name = "Payments API", auth = "Bearer", version = "v1" });
        await owner.Post($"/api/v1/documents/{doc}/api/endpoints", new { definitionId = S(def.Data!["definitions"]![0]!["id"]), method = "GET", path = "/payments/{id}", summary = "Get a payment", deprecated = false, details = new { } });
        Assert.True((await owner.Post($"/api/v1/documents/{doc}/secrets", new { label = "Gateway key", value = "sk_live_PDF-LEAK-CHECK" })).Ok);
        var rev = (await owner.Get($"/api/v1/documents/{doc}")).Data!["revision"]!.GetValue<int>();
        Assert.True((await owner.Post($"/api/v1/documents/{doc}/submit", new { changeSummary = "Ready", major = false, revision = rev })).Ok);
        Assert.True((await reviewer.Post($"/api/v1/documents/{doc}/approve", new { comment = "Looks right" })).Ok);
        Assert.True((await owner.Post($"/api/v1/documents/{doc}/publish", new { changeSummary = "Approved text", major = false, revision = (await owner.Get($"/api/v1/documents/{doc}")).Data!["revision"]!.GetValue<int>() })).Ok);

        var pdf = await ExportAsync(owner, doc);
        Assert.StartsWith("%PDF-1.4", Encoding.Latin1.GetString(pdf, 0, 8));
        var text = Extract(pdf);
        foreach (var expected in new[] { "Payments requirements", "Contents", "Customers can pay by card", "Refunds within 5 days", "API: Payments API", "GET /payments/{id}", "Get a payment",
                     "Revision history", "Ready", "Approved (Sign-off)", "Rita Reviewer", "Looks right", "Atlas", "Olive Owner", "1.0" })
            Assert.Contains(expected, text);
        Assert.Contains("Gateway key", text);                        // the name is listed
        Assert.DoesNotContain("sk_live_PDF-LEAK-CHECK", text);       // the value never is
        Assert.DoesNotContain("sk_live_PDF-LEAK-CHECK", Encoding.Latin1.GetString(pdf));
        Assert.Matches(@"Page \d+ of \d+", text);
        Assert.Matches(@"Customers can pay.*", text);

        // The table of contents has page numbers that point at the pages the headings are really on.
        var pages = Regex.Split(Encoding.Latin1.GetString(pdf), @"/Type /Page /Parent").Skip(1).Count();
        Assert.True(pages >= 3);
        Assert.Equal(1, Audit(owner.WorkspaceId, "document.export_requested").Count);
    }

    private List<AuditLog> Audit(Guid tenant, string action) => factory.WithDb(db => db.AuditLogs.IgnoreQueryFilters().Where(a => a.TenantId == tenant && a.Action == action).ToList());

    [Fact]
    public async Task Only_people_who_may_open_a_document_can_export_it_and_the_plan_decides_who_may_export()
    {
        var (owner, brd) = await Org();
        var doc = await Make(owner, brd, "Private plans", null, "Private");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member);
        Assert.Equal(HttpStatusCode.NotFound, (await member.Post($"/api/v1/documents/{doc}/export", new { })).Status);

        var (free, fbrd) = await Org("FREE");
        var fdoc = await Make(free, fbrd, "Free doc");
        var denied = await free.Post($"/api/v1/documents/{fdoc}/export", new { });
        Assert.Equal(HttpStatusCode.Forbidden, denied.Status);
        Assert.Equal("FEATURE_NOT_AVAILABLE", denied.ErrorCode);
    }

    [Fact]
    public async Task A_reader_gets_the_published_version_not_the_draft()
    {
        var (owner, brd) = await Org();
        var doc = await Make(owner, brd, "Draft or published");
        await Write(owner, doc, "Published sentence about ferrets.");
        await Publish(owner, doc);
        await Write(owner, doc, "Unpublished sentence about badgers.");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member);
        await owner.Post($"/api/v1/documents/{doc}/grants", new { principalType = "User", principalId = member.UserId, level = "Viewer" });
        var text = Extract(await ExportAsync(member, doc));
        Assert.Contains("ferrets", text); Assert.DoesNotContain("badgers", text);
        Assert.Contains("badgers", Extract(await ExportAsync(owner, doc)));   // the editor's own copy shows the working draft
    }

    [Fact]
    public void A_hundred_page_document_renders_in_seconds_with_a_working_table_of_contents()
    {
        var blocks = new List<PdfBlock>();
        for (var s = 0; s < 60; s++)
        {
            blocks.Add(new PdfHeading(1, $"Chapter {s + 1}"));
            for (var p = 0; p < 12; p++) blocks.Add(new PdfPara(string.Join(' ', Enumerable.Repeat($"Requirement paragraph {s}.{p} describes behaviour that the system must provide under load.", 6))));
            blocks.Add(new PdfHeading(2, $"Details {s + 1}"));
            blocks.Add(new PdfTable(["ID", "Name", "Notes"], Enumerable.Range(0, 20).Select(i => (IReadOnlyList<string>)[$"R-{s}-{i}", $"Item {i}", string.Join(' ', Enumerable.Repeat("note", 12))]).ToList()));
        }
        var sw = Stopwatch.StartNew();
        var (file, pages) = new DocumentPdfRenderer().Render(new PdfDocModel("Org", "Big", "DOC-1", "1.0", [("Status", "Published")], blocks, "DOC-1 · Big · 1.0"));
        sw.Stop();
        Assert.InRange(pages, 100, 600);
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(30), $"took {sw.Elapsed}");
        var text = Extract(file);
        var toc = Regex.Match(text, @"Chapter 60.*?\n.*?\n");
        Assert.Contains("Chapter 60", text);
        // Chapter 60's entry lists the page its heading is on: find that heading's page by counting page breaks before it.
        var raw = Encoding.Latin1.GetString(file);
        var pageObjects = Regex.Split(raw, @"\d+ 0 obj\n<< /Length ").Skip(1).ToList();
        var onPage = pageObjects.FindIndex(p => p.Contains("(Chapter 60) Tj") && p.Contains("/F2 17 Tf")) + 1;
        Assert.Matches($@"\(Chapter 60\) Tj ET\nBT[^\n]*\({onPage}\) Tj", raw);
    }

    [Fact]
    public void A_document_of_more_than_600_pages_is_refused_with_a_clear_message()
    {
        var blocks = Enumerable.Range(0, 1000).Select(i => (PdfBlock)new PdfPara(string.Join(' ', Enumerable.Repeat("word", 700)))).ToList();
        var e = Assert.Throws<PdfTooLongException>(() => new DocumentPdfRenderer().Render(new PdfDocModel("O", "T", "K", "1", [], blocks, "f")));
        Assert.Contains("600", e.Message);
        Assert.Contains("split it", e.Message);
    }

    // ------------------------------------------------------------------ search

    [Fact]
    public async Task Search_finds_words_in_the_text_and_never_a_document_the_person_cannot_open()
    {
        var (owner, brd) = await Org();
        var project = await owner.CreateProjectAsync("Atlas");
        var open = await Make(owner, brd, "Open plan", project);
        await Write(owner, open, "The migration uses zebrafish encoding for every record.");
        var hidden = await Make(owner, brd, "Hidden plan", null, "Private");
        await Write(owner, hidden, "A private note that mentions zebrafish too.");
        var gone = await Make(owner, brd, "Deleted plan");
        await Write(owner, gone, "zebrafish in a deleted document");
        await owner.Delete($"/api/v1/documents/{gone}");

        Assert.Equal(["Hidden plan", "Open plan"], (await Found(owner, "zebrafish")).Order().ToList());
        var member = await owner.AddMemberAsync(factory, TenantRole.Member);
        await owner.Post($"/api/v1/documents/{open}/grants", new { principalType = "User", principalId = member.UserId, level = "Viewer" });
        Assert.Equal(["Open plan"], await Found(member, "zebrafish"));
        var other = await TestClient.RegisterAsync(factory, "Other");
        await other.CreateOrgAsync();
        Assert.Empty(await Found(other, "zebrafish"));
        Assert.Empty(await Found(member, "private note"));
    }

    [Fact]
    public async Task Search_matches_every_word_ignores_case_and_treats_wildcards_as_text()
    {
        var (owner, brd) = await Org();
        var a = await Make(owner, brd, "Alpha"); await Write(owner, a, "Refund policy for 100% of customers_eu");
        var b = await Make(owner, brd, "Beta"); await Write(owner, b, "Refund process only");
        Assert.Equal(["Alpha", "Beta"], (await Found(owner, "REFUND")).Order().ToList());
        Assert.Equal(["Alpha"], await Found(owner, "refund policy"));
        Assert.Empty(await Found(owner, "refund policy process"));
        Assert.Equal(["Alpha"], await Found(owner, "100%"));
        Assert.Equal(["Alpha"], await Found(owner, "customers_eu"));
        Assert.Empty(await Found(owner, "100_"));
        Assert.Equal(["Alpha"], await Found(owner, "%"));   // a literal percent sign, not "everything"
        Assert.Empty(await Found(owner, "5%"));
        Assert.Equal(["Alpha"], await Found(owner, $"DOC-{(await owner.Get($"/api/v1/documents/{a}")).Data!["item"]!["number"]}"));
    }

    [Fact]
    public async Task Readers_search_what_they_can_read_not_the_unpublished_draft()
    {
        var (owner, brd) = await Org();
        var doc = await Make(owner, brd, "Roadmap");
        await Write(owner, doc, "Published content about otters.");
        await Publish(owner, doc);
        await Write(owner, doc, "Draft edit about walruses.");
        Assert.Equal(["Roadmap"], await Found(owner, "otters"));
        Assert.Empty(await Found(owner, "walruses"));   // not found until it is published, so a search never reveals draft words
        await Publish(owner, doc, "Second");
        Assert.Equal(["Roadmap"], await Found(owner, "walruses"));
    }

    [Fact]
    public async Task Secret_values_are_not_searchable()
    {
        var (owner, brd) = await Org();
        var doc = await Make(owner, brd, "Credentials");
        await owner.Post($"/api/v1/documents/{doc}/secrets", new { label = "Gateway", value = "uniquesecretvalue123" });
        await Write(owner, doc, "See the secrets panel.");
        Assert.Empty(await Found(owner, "uniquesecretvalue123"));
    }

    [Fact]
    public async Task The_nightly_sweep_indexes_documents_that_existed_before_search()
    {
        var (owner, brd) = await Org();
        var doc = await Make(owner, brd, "Old document");
        await Write(owner, doc, "Content about capybaras.");
        factory.WithDb(db => { db.Documents.IgnoreQueryFilters().Where(d => d.Id == doc).ExecuteUpdate(s => s.SetProperty(d => d.SearchText, (string?)null).SetProperty(d => d.SearchIndexedAt, (DateTime?)null)); return 0; });
        Assert.Empty(await Found(owner, "capybaras"));
        using (var scope = factory.Services.CreateScope())
        {
            var indexer = scope.ServiceProvider.GetRequiredService<DocumentSearchIndexer>();
            var total = 0; int n;
            while ((n = await indexer.SweepAsync()) > 0 && total < 5000) total += n;   // other tests share this database; keep going until nothing is left
            Assert.True(total >= 1);
        }
        Assert.Equal(["Old document"], await Found(owner, "capybaras"));
    }

    // ------------------------------------------------------------------ dashboard

    [Fact]
    public async Task The_overview_numbers_equal_the_documents_each_person_can_open_whatever_the_permissions()
    {
        var (owner, brd) = await Org();
        var people = new List<TestClient> { owner };
        for (var i = 0; i < 3; i++) people.Add(await owner.AddMemberAsync(factory, i == 0 ? TenantRole.Admin : TenantRole.Member, $"Person {i}"));
        var project = await owner.CreateProjectAsync("Atlas");
        var rnd = new Random(7);
        var visibilities = new[] { "Private", "Project", "Organization" };
        for (var i = 0; i < 24; i++)
        {
            var who = people[rnd.Next(people.Count)];
            var vis = visibilities[rnd.Next(visibilities.Length)];
            var res = await who.Post("/api/v1/documents", new { title = $"Doc {i}", typeId = brd, projectId = (Guid?)(vis == "Project" ? project : null), visibility = vis == "Project" ? "Project" : vis });
            if (!res.Ok) continue;
            var id = Guid.Parse(S(res.Data!["item"]!["id"]));
            if (rnd.Next(3) == 0) await who.Post($"/api/v1/documents/{id}/grants", new { principalType = "User", principalId = people[rnd.Next(people.Count)].UserId, level = "Viewer" });
            if (rnd.Next(4) == 0) await who.Delete($"/api/v1/documents/{id}");
        }
        foreach (var p in people)
        {
            var list = await p.Get("/api/v1/documents?limit=100");
            var dash = (await p.Get("/api/v1/documents/dashboard")).Data!;
            var total = list.Data!["total"]!.GetValue<int>();
            Assert.Equal(total, dash["total"]!.GetValue<int>());
            Assert.Equal(total, dash["byStatus"]!.AsArray().Sum(x => x!["count"]!.GetValue<int>()));
            Assert.Equal(total, dash["byType"]!.AsArray().Sum(x => x!["count"]!.GetValue<int>()));
            Assert.True(dash["recent"]!.AsArray().Count <= 5);
        }
    }

    // ------------------------------------------------------------------ speed

    [Fact]
    public async Task Search_stays_fast_over_many_documents()
    {
        var (owner, brd) = await Org();
        var tenant = owner.WorkspaceId;
        var count = int.TryParse(Environment.GetEnvironmentVariable("PM_PERF_DOCS"), out var n) ? n : 10_000;
        var words = new[] { "invoice", "refund", "gateway", "customer", "latency", "schema", "payment", "report", "ledger", "audit", "queue", "cache" };
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<ProjectManagement.Infrastructure.Persistence.AppDbContext>();
            var owner0 = owner.UserId;
            var rnd = new Random(1);
            var maxNo = db.Documents.IgnoreQueryFilters().Where(d => d.TenantId == tenant).Max(d => (int?)d.Number) ?? 0;
            for (var i = 0; i < count; i++)
            {
                db.Documents.Add(new Document
                {
                    TenantId = tenant, Number = maxNo + i + 1, Title = $"Bulk {i} {words[rnd.Next(words.Length)]}", TypeId = brd, OwnerId = owner0, Status = DocumentStatus.Published, Visibility = DocumentVisibility.Organization,
                    SearchText = string.Join(' ', Enumerable.Range(0, 60).Select(_ => words[rnd.Next(words.Length)] + rnd.Next(1000))), SearchIndexedAt = DateTime.UtcNow, CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow,
                });
                if (i % 2000 == 1999) { await db.SaveChangesAsync(); db.ChangeTracker.Clear(); }
            }
            await db.SaveChangesAsync();
        }
        var times = new List<double>();
        foreach (var q in new[] { "refund123", "ledger 42", "gateway9", "audit queue", "latency77", "cache5", "report3", "schema88", "payment1", "customer20", "invoice9 refund", "zzzzzz" })
            for (var r = 0; r < 3; r++)
            {
                var sw = Stopwatch.StartNew();
                var res = await owner.Get($"/api/v1/documents?q={Uri.EscapeDataString(q)}");
                sw.Stop();
                Assert.True(res.Ok, res.ToString());
                times.Add(sw.Elapsed.TotalMilliseconds);
            }
        times.Sort();
        var p95 = times[(int)(times.Count * 0.95) - 1];
        Assert.True(p95 < 400, $"p95 {p95:0} ms over {count:N0} documents");
    }
}
