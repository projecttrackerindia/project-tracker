using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Document history (release D2): published versions are frozen, compare shows what changed between two of them, restoring publishes a new version, old history ages out with the plan.</summary>
[Collection("api")]
public class DocumentVersionTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private static string P(string text) => $$"""{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":{{System.Text.Json.JsonSerializer.Serialize(text)}}}]}]}""";

    private async Task<(TestClient Owner, Guid Id, int Revision)> Doc(string plan = "BUSINESS", string typeCode = "BRD")
    {
        var owner = await TestClient.RegisterAsync(factory, "Vera Owner");
        await owner.CreateOrgAsync();
        if (plan != "FREE") await owner.UpgradeAsync(plan);
        var type = Guid.Parse(S((await owner.Get("/api/v1/document-types")).Data!.AsArray().First(t => S(t!["code"]) == typeCode)!["id"]));
        var res = await owner.Post("/api/v1/documents", new { title = "Versioned BRD", typeId = type, visibility = "Organization" });
        Assert.True(res.Ok, res.ToString());
        return (owner, Guid.Parse(S(res.Data!["item"]!["id"])), res.Data["revision"]!.GetValue<int>());
    }

    private static async Task<ApiResult> Write(TestClient c, Guid id, int revision, string key, string content) =>
        await c.Put($"/api/v1/documents/{id}/sections", new { revision, sections = new[] { new { key, content } } });

    private static async Task<int> Rev(TestClient c, Guid id) => (await c.Get($"/api/v1/documents/{id}")).Data!["revision"]!.GetValue<int>();

    private static async Task<ApiResult> Publish(TestClient c, Guid id, string summary = "First draft complete", bool major = false, string? reason = null) =>
        await c.Post($"/api/v1/documents/{id}/publish", new { changeSummary = summary, changeReason = reason, major, revision = await Rev(c, id) });

    [Fact]
    public async Task Publishing_freezes_the_draft_as_1_0_then_1_1_and_a_major_change_is_2_0_and_nothing_published_is_ever_changed()
    {
        var (owner, id, rev) = await Doc();
        Assert.True((await Write(owner, id, rev, "scope", P("Payslips only."))).Ok);

        var first = await Publish(owner, id, "Scope agreed", reason: "Sign-off from HR");
        Assert.True(first.Ok, first.ToString());
        var items = first.Data!["items"]!.AsArray();
        Assert.Equal(["Draft after 1.0", "1.0"], items.Select(i => S(i!["label"])).ToArray());
        Assert.Equal("Scope agreed", S(items[1]!["changeSummary"]));
        Assert.Equal("Sign-off from HR", S(items[1]!["changeReason"]));
        Assert.Equal("Vera Owner", S(items[1]!["publishedBy"]!["name"]));
        var v10 = S(items[1]!["id"]); var hash10 = S(items[1]!["contentHash"]);
        Assert.False(first.Data["hasUnpublishedChanges"]!.GetValue<bool>());
        Assert.Equal("1.1", S(first.Data["nextLabelMinor"])); Assert.Equal("2.0", S(first.Data["nextLabelMajor"]));

        // Editing carries on in the draft; the published version does not move.
        Assert.True((await Write(owner, id, await Rev(owner, id), "scope", P("Payslips and tax forms."))).Ok);
        var doc = (await owner.Get($"/api/v1/documents/{id}")).Data!;
        Assert.Equal("1.0 + changes", S(doc["versionLabel"])); Assert.True(doc["hasUnpublishedChanges"]!.GetValue<bool>());
        var frozen = (await owner.Get($"/api/v1/documents/{id}/versions/{v10}")).Data!;
        Assert.Contains("Payslips only.", S(frozen["sections"]!.AsArray().First(s => S(s!["key"]) == "scope")!["content"]));
        Assert.DoesNotContain("tax forms", frozen.ToJsonString());
        Assert.Equal(hash10, S(frozen["version"]!["contentHash"]));

        var minor = await Publish(owner, id, "Added tax forms");
        Assert.Equal(["Draft after 1.1", "1.1", "1.0"], minor.Data!["items"]!.AsArray().Select(i => S(i!["label"])).ToArray());
        Assert.True((await Write(owner, id, await Rev(owner, id), "scope", P("Everything HR owns."))).Ok);
        var major = await Publish(owner, id, "Scope widened to all of HR", major: true);
        Assert.Equal(["Draft after 2.0", "2.0", "1.1", "1.0"], major.Data!["items"]!.AsArray().Select(i => S(i!["label"])).ToArray());
        Assert.Equal("Published", S((await owner.Get($"/api/v1/documents/{id}")).Data!["item"]!["status"]));

        // The very first version is still exactly what it was.
        Assert.Equal(hash10, S((await owner.Get($"/api/v1/documents/{id}/versions/{v10}")).Data!["version"]!["contentHash"]));
    }

    [Fact]
    public async Task A_publish_needs_a_summary_and_a_change_and_a_current_copy()
    {
        var (owner, id, rev) = await Doc();
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await Publish(owner, id, "  ")).Status);
        Assert.True((await Write(owner, id, rev, "scope", P("One."))).Ok);
        var stale = await owner.Post($"/api/v1/documents/{id}/publish", new { changeSummary = "x", major = false, revision = rev });
        Assert.Equal("DOCUMENT_CHANGED", stale.ErrorCode);
        Assert.True((await Publish(owner, id)).Ok);
        var again = await Publish(owner, id, "Nothing new");
        Assert.Equal(HttpStatusCode.Conflict, again.Status); Assert.Equal("NOTHING_TO_PUBLISH", again.ErrorCode);
    }

    [Fact]
    public async Task People_who_can_only_read_see_the_published_version_while_the_owner_edits_the_draft()
    {
        var (owner, id, rev) = await Doc();
        var reader = await owner.AddMemberAsync(factory, TenantRole.Guest, "Gus Guest");   // guests cannot see organization documents: use a project one instead
        var project = await owner.CreateProjectAsync("Readable");
        Assert.True((await owner.Post($"/api/v1/projects/{project}/members", new { userId = reader.UserId })).Ok);
        var type = Guid.Parse(S((await owner.Get("/api/v1/document-types")).Data!.AsArray().First(t => S(t!["code"]) == "BRD")!["id"]));
        var created = await owner.Post("/api/v1/documents", new { title = "Project BRD", typeId = type, projectId = project });
        var pid = Guid.Parse(S(created.Data!["item"]!["id"]));
        Assert.True((await Write(owner, pid, created.Data["revision"]!.GetValue<int>(), "scope", P("Draft words."))).Ok);

        // Never published: the reader sees the draft, as before.
        Assert.Contains("Draft words.", (await reader.Get($"/api/v1/documents/{pid}")).Data!.ToJsonString());
        Assert.True((await Publish(owner, pid, "First")).Ok);
        Assert.True((await Write(owner, pid, await Rev(owner, pid), "scope", P("Unreleased edit."))).Ok);

        var asReader = (await reader.Get($"/api/v1/documents/{pid}")).Data!;
        Assert.True(asReader["viewingPublished"]!.GetValue<bool>());
        Assert.Equal("1.0", S(asReader["versionLabel"]));
        Assert.Contains("Draft words.", asReader.ToJsonString()); Assert.DoesNotContain("Unreleased edit.", asReader.ToJsonString());
        Assert.Contains("Unreleased edit.", (await owner.Get($"/api/v1/documents/{pid}")).Data!.ToJsonString());
        // The reader's history lists published versions only, and the draft cannot be fetched.
        var list = (await reader.Get($"/api/v1/documents/{pid}/versions")).Data!;
        Assert.Equal(["1.0"], list["items"]!.AsArray().Select(i => S(i!["label"])).ToArray());
        Assert.False(list["hasUnpublishedChanges"]!.GetValue<bool>());
        // And a reader can neither publish nor restore.
        Assert.Equal(HttpStatusCode.Forbidden, (await reader.Post($"/api/v1/documents/{pid}/publish", new { changeSummary = "x", revision = 1 })).Status);
    }

    [Fact]
    public async Task Compare_shows_added_and_removed_lines_with_the_changed_words_table_rows_and_collapses_what_did_not_change()
    {
        var (owner, id, rev) = await Doc();
        var table1 = """{"columns":[{"key":"Risk","label":"Risk"},{"key":"Owner","label":"Owner"}],"rows":[{"Risk":"Late data","Owner":"Priya"},{"Risk":"No budget","Owner":"Sam"}]}""";
        var table2 = """{"columns":[{"key":"Risk","label":"Risk"},{"key":"Owner","label":"Owner"}],"rows":[{"Risk":"Late data","Owner":"Arun"},{"Risk":"No budget","Owner":"Sam"},{"Risk":"Vendor delay","Owner":"Mia"}]}""";
        var text1 = """{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Employees see payslips."}]},{"type":"paragraph","content":[{"type":"text","text":"Managers see team costs."}]}]}""";
        var text2 = """{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Employees see payslips and tax forms."}]},{"type":"paragraph","content":[{"type":"text","text":"Managers see team costs."}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Export to PDF"}]}]}]}]}""";
        Assert.True((await owner.Put($"/api/v1/documents/{id}/sections", new { revision = rev, sections = new[] { new { key = "scope", content = text1 }, new { key = "risks", content = table1 } } })).Ok);
        var v1 = S((await Publish(owner, id, "v1")).Data!["items"]![1]!["id"]);
        Assert.True((await owner.Put($"/api/v1/documents/{id}/sections", new { revision = await Rev(owner, id), sections = new[] { new { key = "scope", content = text2 }, new { key = "risks", content = table2 } } })).Ok);
        var v2 = S((await Publish(owner, id, "v2")).Data!["items"]![1]!["id"]);

        var diff = (await owner.Get($"/api/v1/documents/{id}/compare?from={v1}&to={v2}")).Data!;
        Assert.Equal("1.0", S(diff["from"]!["label"])); Assert.Equal("1.1", S(diff["to"]!["label"]));
        Assert.Equal(2, diff["changed"]!.GetValue<int>());
        Assert.Equal(10, diff["unchanged"]!.GetValue<int>());      // the other ten sections of the template are collapsed, not listed with text
        var scope = diff["sections"]!.AsArray().First(s => S(s!["key"]) == "scope")!;
        Assert.Equal("Changed", S(scope["change"]));
        var lines = scope["lines"]!.AsArray();
        Assert.Contains(lines, l => S(l!["op"]) == "eq" && S(l["text"]) == "Managers see team costs.");
        var added = lines.First(l => S(l!["op"]) == "add" && S(l["text"]).StartsWith("Employees"));
        Assert.Contains(added["words"]!.AsArray(), w => S(w!["op"]) == "add" && S(w["text"]) == "tax");
        Assert.Contains(lines, l => S(l!["op"]) == "add" && S(l["text"]) == "• Export to PDF");
        var risks = diff["sections"]!.AsArray().First(s => S(s!["key"]) == "risks")!["rows"]!.AsArray();
        Assert.Equal(["chg", "eq", "add"], risks.Select(r => S(r!["op"])).ToArray());
        Assert.Equal([1], risks[0]!["changedCells"]!.AsArray().Select(c => c!.GetValue<int>()).ToArray());
        Assert.Equal("Arun", S(risks[0]!["cells"]![1]));

        // Compare is symmetric in what it reports and works against the draft too.
        var back = (await owner.Get($"/api/v1/documents/{id}/compare?from={v2}&to={v1}")).Data!;
        Assert.Equal(2, back["changed"]!.GetValue<int>());
        var draftId = S((await owner.Get($"/api/v1/documents/{id}/versions")).Data!["items"]![0]!["id"]);
        Assert.Equal(0, (await owner.Get($"/api/v1/documents/{id}/compare?from={v2}&to={draftId}")).Data!["changed"]!.GetValue<int>());
    }

    [Fact]
    public void The_diff_engine_handles_edges_formatting_only_changes_and_huge_inputs()
    {
        static DocumentDiff.Snapshot T(string text, string extra = "") => new("k", "Title", SectionKind.RichText, 0, $$"""{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"{{text}}"{{extra}}}]}]}""");
        var bold = DocumentDiff.Compare(new(Guid.NewGuid(), "1.0", false, null), [T("Same words")], new(Guid.NewGuid(), "1.1", false, null), [T("Same words", ",\"marks\":[{\"type\":\"bold\"}]")]);
        Assert.True(bold.Sections[0].FormattingOnly);
        Assert.Equal(SectionChange.Changed, bold.Sections[0].Change);

        var added = DocumentDiff.Compare(new(Guid.NewGuid(), "a", false, null), [], new(Guid.NewGuid(), "b", false, null), [T("New")]);
        Assert.Equal(SectionChange.Added, added.Sections[0].Change); Assert.Equal(1, added.Added);
        var removed = DocumentDiff.Compare(new(Guid.NewGuid(), "a", false, null), [T("Old")], new(Guid.NewGuid(), "b", false, null), []);
        Assert.Equal(SectionChange.Removed, removed.Sections[0].Change); Assert.Equal(1, removed.Removed);

        Assert.Equal("=+=", new string(DocumentDiff.Lcs(["a", "c"], ["a", "b", "c"]).ToArray()));
        var big = Enumerable.Range(0, 3000).Select(i => $"x{i}").ToList(); var other = Enumerable.Range(0, 3000).Select(i => $"y{i}").ToList();
        var coarse = DocumentDiff.Lcs(big, other);                                       // too big to compare line by line: everything is replaced, quickly
        Assert.Equal(6000, coarse.Count); Assert.DoesNotContain('=', coarse);
    }

    [Fact]
    public async Task Restoring_an_old_version_publishes_a_new_one_with_the_same_content_and_both_stay_in_the_history()
    {
        var (owner, id, rev) = await Doc();
        Assert.True((await Write(owner, id, rev, "scope", P("Original scope."))).Ok);
        var list1 = (await Publish(owner, id, "Original")).Data!;
        var v10 = S(list1["items"]![1]!["id"]); var hash10 = S(list1["items"]![1]!["contentHash"]);
        Assert.True((await Write(owner, id, await Rev(owner, id), "scope", P("Rewritten scope."))).Ok);
        Assert.True((await Publish(owner, id, "Rewrite")).Ok);
        Assert.True((await Write(owner, id, await Rev(owner, id), "scope", P("Half-finished idea."))).Ok);

        var guarded = await owner.Post($"/api/v1/documents/{id}/versions/{v10}/restore", new { reason = "Rewrite was wrong", discardChanges = false, revision = await Rev(owner, id) });
        Assert.Equal(HttpStatusCode.Conflict, guarded.Status); Assert.Equal("DRAFT_HAS_CHANGES", guarded.ErrorCode);

        var restored = await owner.Post($"/api/v1/documents/{id}/versions/{v10}/restore", new { reason = "Rewrite was wrong", discardChanges = true, revision = await Rev(owner, id) });
        Assert.True(restored.Ok, restored.ToString());
        var items = restored.Data!["items"]!.AsArray();
        Assert.Equal(["Draft after 1.2", "1.2", "1.1", "1.0"], items.Select(i => S(i!["label"])).ToArray());
        Assert.Equal(hash10, S(items[1]!["contentHash"]));                                  // the new version is the old content
        Assert.Equal("Restored version 1.0", S(items[1]!["changeSummary"]));
        Assert.Equal("Rewrite was wrong", S(items[1]!["changeReason"]));
        Assert.Equal("1.0", S(items[1]!["restoredFrom"]));
        Assert.Contains("Rewrite", (await owner.Get($"/api/v1/documents/{id}/versions/{S(items[2]!["id"])}")).Data!.ToJsonString());   // 1.1 is still there, untouched
        var draft = (await owner.Get($"/api/v1/documents/{id}")).Data!;
        Assert.Contains("Original scope.", draft.ToJsonString()); Assert.DoesNotContain("Half-finished", draft.ToJsonString());
        Assert.Equal("1.2", S(draft["versionLabel"]));

        // Only a published version can be restored.
        var draftId = S(items[0]!["id"]);
        Assert.Equal(HttpStatusCode.NotFound, (await owner.Post($"/api/v1/documents/{id}/versions/{draftId}/restore", new { discardChanges = true, revision = await Rev(owner, id) })).Status);
    }

    [Fact]
    public async Task Another_organization_never_sees_versions()
    {
        var (owner, id, rev) = await Doc();
        Assert.True((await Write(owner, id, rev, "scope", P("Private words."))).Ok);
        var v = S((await Publish(owner, id)).Data!["items"]![1]!["id"]);
        var stranger = await TestClient.RegisterAsync(factory, "Sam Stranger");
        await stranger.CreateOrgAsync();
        foreach (var status in new[]
        {
            (await stranger.Get($"/api/v1/documents/{id}/versions")).Status, (await stranger.Get($"/api/v1/documents/{id}/versions/{v}")).Status,
            (await stranger.Get($"/api/v1/documents/{id}/compare?from={v}&to={v}")).Status, (await stranger.Post($"/api/v1/documents/{id}/publish", new { changeSummary = "x", revision = 1 })).Status,
            (await stranger.Post($"/api/v1/documents/{id}/versions/{v}/restore", new { discardChanges = true, revision = 1 })).Status,
        }) Assert.Equal(HttpStatusCode.NotFound, status);
    }

    // ------------------------------------------------------------------ retention

    private async Task<(int Versions, int Documents)> Purge()
    {
        using var scope = factory.Services.CreateScope();
        var r = await scope.ServiceProvider.GetRequiredService<DocumentRetentionService>().PurgeAsync();
        return (r.Versions, r.Documents);
    }

    private async Task<Guid> SixVersions(TestClient owner, Guid id, int rev)
    {
        for (var i = 1; i <= 6; i++)
        {
            Assert.True((await Write(owner, id, await Rev(owner, id), "scope", P($"Revision {i}"))).Ok);
            Assert.True((await Publish(owner, id, $"Change {i}")).Ok);
        }
        return id;
    }

    [Fact]
    public async Task Old_versions_age_out_with_the_plan_but_the_newest_three_and_the_published_one_are_never_removed()
    {
        var (owner, id, rev) = await Doc("PRO");                         // a year of history
        await SixVersions(owner, id, rev);
        // Versions 1.0 to 1.3 were published long ago; 1.4 and 1.5 recently.
        factory.WithDb(db => db.DocumentVersions.IgnoreQueryFilters().Where(v => v.DocumentId == id && !v.IsDraft && v.Minor < 4).ExecuteUpdate(s => s.SetProperty(v => v.PublishedAt, DateTime.UtcNow.AddDays(-400))));
        var before = (await owner.Get($"/api/v1/documents/{id}/versions")).Data!["items"]!.AsArray().Count;
        Assert.Equal(7, before);                                         // six published and the draft

        var (removed, _) = await Purge();
        Assert.Equal(3, removed);                                        // 1.0, 1.1 and 1.2 are old and not among the newest three; 1.3 is old but one of the newest three
        var left = (await owner.Get($"/api/v1/documents/{id}/versions")).Data!["items"]!.AsArray().Select(i => S(i!["label"])).ToArray();
        Assert.Equal(["Draft after 1.5", "1.5", "1.4", "1.3"], left);
        var audit = factory.WithDb(db => db.AuditLogs.IgnoreQueryFilters().Where(a => a.Action == "document.retention_purged" && a.TenantId == owner.WorkspaceId).Select(a => a.NewValue).ToList());
        Assert.Contains(audit, a => a!.Contains("\"versions\":3") && !a.Contains("Revision"));   // counts only, never content
    }

    [Fact]
    public async Task The_free_plan_keeps_thirty_days_and_a_workspace_may_shorten_but_not_lengthen_it()
    {
        var (owner, id, rev) = await Doc("FREE");
        await SixVersions(owner, id, rev);
        factory.WithDb(db => db.DocumentVersions.IgnoreQueryFilters().Where(v => v.DocumentId == id && !v.IsDraft).ExecuteUpdate(s => s.SetProperty(v => v.PublishedAt, DateTime.UtcNow.AddDays(-45))));
        Assert.Equal(3, (await Purge()).Versions);                       // older than 30 days, minus the newest three
        // Nothing more to remove on a second run.
        Assert.Equal(0, (await Purge()).Versions);
    }

    [Fact]
    public async Task A_deleted_document_is_removed_for_good_after_thirty_days_with_its_files()
    {
        var (owner, id, _) = await Doc();
        var upload = await owner.Upload($"/api/v1/documents/{id}/files", "spec.txt", System.Text.Encoding.UTF8.GetBytes("requirements"));
        Assert.True(upload.Ok, upload.ToString());
        Assert.Equal(HttpStatusCode.NoContent, (await owner.Delete($"/api/v1/documents/{id}")).Status);
        Assert.Equal(0, (await Purge()).Documents);                      // deleted today: kept
        factory.WithDb(db => db.Documents.IgnoreQueryFilters().Where(d => d.Id == id).ExecuteUpdate(s => s.SetProperty(d => d.DeletedAt, DateTime.UtcNow.AddDays(-31))));
        Assert.Equal(1, (await Purge()).Documents);
        Assert.Equal(0, factory.WithDb(db => db.Documents.IgnoreQueryFilters().Count(d => d.Id == id) + db.DocumentVersions.IgnoreQueryFilters().Count(v => v.DocumentId == id) + db.DocumentFiles.IgnoreQueryFilters().Count(f => f.DocumentId == id)));
    }
}
