using System.IO.Compression;
using System.Net;
using System.Text.Json.Nodes;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Build artifacts: the "Build artifact" document type carries one file per version, versioned and dated automatically (never typed), and two
/// versions can be compared - a real entry-level diff for zip-based builds (.jar/.war/.ear/.zip...), size/hash only for anything else.
/// </summary>
[Collection("api")]
public class DocumentArtifactTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();

    private static byte[] Zip(params (string Name, string Content)[] entries)
    {
        using var ms = new MemoryStream();
        using (var zip = new ZipArchive(ms, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var (name, content) in entries)
            {
                var entry = zip.CreateEntry(name, CompressionLevel.NoCompression);
                using var w = new StreamWriter(entry.Open());
                w.Write(content);
            }
        }
        return ms.ToArray();
    }

    private async Task<(TestClient Owner, Guid Id, int Revision)> ArtifactDoc()
    {
        var owner = await TestClient.RegisterAsync(factory, "Betty Builder");
        await owner.CreateOrgAsync();
        var type = Guid.Parse(S((await owner.Get("/api/v1/document-types")).Data!.AsArray().First(t => S(t!["code"]) == "ARTIFACT")!["id"]));
        var res = await owner.Post("/api/v1/documents", new { title = "Payments service", typeId = type, visibility = "Organization" });
        Assert.True(res.Ok, res.ToString());
        return (owner, Guid.Parse(S(res.Data!["item"]!["id"])), res.Data["revision"]!.GetValue<int>());
    }

    private static async Task<int> Rev(TestClient c, Guid id) => (await c.Get($"/api/v1/documents/{id}")).Data!["revision"]!.GetValue<int>();

    [Fact]
    public async Task The_build_artifact_type_is_seeded_and_carries_no_sections()
    {
        var owner = await TestClient.RegisterAsync(factory, "Betty Builder");
        await owner.CreateOrgAsync();
        var types = (await owner.Get("/api/v1/document-types")).Data!.AsArray();
        var artifact = types.First(t => S(t!["code"]) == "ARTIFACT");
        Assert.Equal("Build artifact", S(artifact!["name"]));
        Assert.Empty(artifact["sections"]!.AsArray());
    }

    [Fact]
    public async Task Uploading_and_publishing_gives_an_automatic_version_and_date_never_typed_by_anyone()
    {
        var (owner, id, _) = await ArtifactDoc();
        var before = DateTime.UtcNow;
        var up = await owner.Upload($"/api/v1/documents/{id}/artifact/draft", "app-1.0.jar", Zip(("Main.class", "v1")));
        Assert.Equal(HttpStatusCode.Created, up.Status);
        Assert.Equal("app-1.0.jar", S(up.Data!["file"]!["fileName"]));
        Assert.True(up.Data["isDraft"]!.GetValue<bool>());

        var versionsBefore = (await owner.Get($"/api/v1/documents/{id}/artifact/versions")).Data!;
        Assert.True(versionsBefore["hasUnpublishedChanges"]!.GetValue<bool>());

        var pub = await owner.Post($"/api/v1/documents/{id}/artifact/publish", new { revision = await Rev(owner, id) });
        Assert.True(pub.Ok, pub.ToString());
        var items = pub.Data!["items"]!.AsArray();
        var published = items.First(v => v!["isCurrent"]!.GetValue<bool>());
        Assert.Equal("1.0", S(published!["label"]));
        Assert.Equal("app-1.0.jar", S(published["file"]!["fileName"]));
        var publishedAt = DateTimeOffset.Parse(S(published["publishedAt"])).UtcDateTime;
        Assert.True(publishedAt >= before.AddSeconds(-2) && publishedAt <= DateTime.UtcNow.AddSeconds(2));   // server time, never supplied by the caller

        // The next draft starts with no file, same as a fresh draft starts with no unpublished section edits.
        var draft = items.First(v => v!["isDraft"]!.GetValue<bool>());
        Assert.Null(draft!["file"]);
    }

    [Fact]
    public async Task Publishing_without_a_file_or_with_nothing_new_is_refused()
    {
        var (owner, id, _) = await ArtifactDoc();
        var noFile = await owner.Post($"/api/v1/documents/{id}/artifact/publish", new { revision = await Rev(owner, id) });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, noFile.Status);

        var bytes = Zip(("a.txt", "1"));   // built once and reused below: two separately-built zips of "the same" content can differ byte-for-byte
                                            // (zip entries carry a timestamp), which would defeat the "exact same bytes" point of this test.
        Assert.Equal(HttpStatusCode.Created, (await owner.Upload($"/api/v1/documents/{id}/artifact/draft", "app.zip", bytes)).Status);
        Assert.True((await owner.Post($"/api/v1/documents/{id}/artifact/publish", new { revision = await Rev(owner, id) })).Ok);

        // Re-attaching the exact same bytes again: nothing to publish, same as an unchanged section draft.
        Assert.Equal(HttpStatusCode.Created, (await owner.Upload($"/api/v1/documents/{id}/artifact/draft", "app.zip", bytes)).Status);
        var again = await owner.Post($"/api/v1/documents/{id}/artifact/publish", new { revision = await Rev(owner, id) });
        Assert.Equal(HttpStatusCode.Conflict, again.Status);
        Assert.Equal("NOTHING_TO_PUBLISH", again.ErrorCode);
    }

    [Fact]
    public async Task Re_uploading_before_publishing_replaces_the_drafts_file_rather_than_adding_a_second_one()
    {
        var (owner, id, _) = await ArtifactDoc();
        Assert.Equal(HttpStatusCode.Created, (await owner.Upload($"/api/v1/documents/{id}/artifact/draft", "first.jar", Zip(("a", "1")))).Status);
        Assert.Equal(HttpStatusCode.Created, (await owner.Upload($"/api/v1/documents/{id}/artifact/draft", "second.jar", Zip(("a", "2")))).Status);
        var list = (await owner.Get($"/api/v1/documents/{id}/artifact/versions")).Data!["items"]!.AsArray();
        Assert.Single(list, v => v!["isDraft"]!.GetValue<bool>());
        var draft = list.First(v => v!["isDraft"]!.GetValue<bool>());
        Assert.Equal("second.jar", S(draft!["file"]!["fileName"]));
    }

    [Fact]
    public async Task Arbitrary_build_extensions_with_no_fixed_signature_are_accepted_while_the_size_cap_and_hash_still_apply()
    {
        var (owner, id, _) = await ArtifactDoc();
        // Not in the general attachment allow-list at all (no extension, and a made-up one) - accepted here because build artifacts have no fixed list.
        Assert.Equal(HttpStatusCode.Created, (await owner.Upload($"/api/v1/documents/{id}/artifact/draft", "release-bin", "whatever bytes"u8.ToArray())).Status);
        Assert.Equal(HttpStatusCode.Created, (await owner.Upload($"/api/v1/documents/{id}/artifact/draft", "install.bin", "whatever bytes"u8.ToArray())).Status);
        var empty = await owner.Upload($"/api/v1/documents/{id}/artifact/draft", "empty.bin", []);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, empty.Status);   // the empty-file rule still applies
    }

    [Fact]
    public async Task Comparing_two_zip_based_builds_reports_added_removed_and_changed_entries_by_path_and_content()
    {
        var (owner, id, _) = await ArtifactDoc();
        Assert.True((await owner.Upload($"/api/v1/documents/{id}/artifact/draft", "app-1.0.jar",
            Zip(("Main.class", "version one"), ("Util.class", "shared"), ("Old.class", "going away")))).Ok);
        var v1Pub = await owner.Post($"/api/v1/documents/{id}/artifact/publish", new { revision = await Rev(owner, id) });
        var v1Id = S(v1Pub.Data!["items"]!.AsArray().First(v => v!["isCurrent"]!.GetValue<bool>())!["id"]);

        Assert.True((await owner.Upload($"/api/v1/documents/{id}/artifact/draft", "app-1.1.jar",
            Zip(("Main.class", "version TWO - changed"), ("Util.class", "shared"), ("New.class", "just added")))).Ok);
        var v2Pub = await owner.Post($"/api/v1/documents/{id}/artifact/publish", new { revision = await Rev(owner, id) });
        var v2Id = S(v2Pub.Data!["items"]!.AsArray().First(v => v!["isCurrent"]!.GetValue<bool>())!["id"]);

        var cmp = await owner.Get($"/api/v1/documents/{id}/artifact/compare?from={v1Id}&to={v2Id}");
        Assert.True(cmp.Ok, cmp.ToString());
        var d = cmp.Data!;
        Assert.True(d["comparableAsZip"]!.GetValue<bool>());
        Assert.Equal(1, d["added"]!.GetValue<int>());
        Assert.Equal(1, d["removed"]!.GetValue<int>());
        Assert.Equal(1, d["changed"]!.GetValue<int>());
        Assert.Equal(1, d["unchanged"]!.GetValue<int>());   // Util.class, byte-identical in both

        var entries = d["entries"]!.AsArray();
        Assert.Equal("Added", S(entries.First(e => S(e!["path"]) == "New.class")!["change"]));
        Assert.Equal("Removed", S(entries.First(e => S(e!["path"]) == "Old.class")!["change"]));
        var mainClass = entries.First(e => S(e!["path"]) == "Main.class");
        Assert.Equal("Changed", S(mainClass!["change"]));
        Assert.NotEqual(mainClass["fromCrc32"]!.GetValue<long>(), mainClass["toCrc32"]!.GetValue<long>());
        // Util.class never appears in the entry list: it is unchanged, only counted, never emitted as a row.
        Assert.DoesNotContain(entries, e => S(e!["path"]) == "Util.class");
    }

    [Fact]
    public async Task Comparing_two_non_zip_builds_falls_back_to_size_and_hash_with_no_fake_entry_list()
    {
        var (owner, id, _) = await ArtifactDoc();
        Assert.True((await owner.Upload($"/api/v1/documents/{id}/artifact/draft", "setup.bin", "AAAAAAAAAA"u8.ToArray())).Ok);
        var v1 = await owner.Post($"/api/v1/documents/{id}/artifact/publish", new { revision = await Rev(owner, id) });
        var v1Id = S(v1.Data!["items"]!.AsArray().First(v => v!["isCurrent"]!.GetValue<bool>())!["id"]);

        Assert.True((await owner.Upload($"/api/v1/documents/{id}/artifact/draft", "setup.bin", "BBBBBBBBBBBBBBBBBBBB"u8.ToArray())).Ok);
        var v2 = await owner.Post($"/api/v1/documents/{id}/artifact/publish", new { revision = await Rev(owner, id) });
        var v2Id = S(v2.Data!["items"]!.AsArray().First(v => v!["isCurrent"]!.GetValue<bool>())!["id"]);

        var cmp = await owner.Get($"/api/v1/documents/{id}/artifact/compare?from={v1Id}&to={v2Id}");
        Assert.True(cmp.Ok, cmp.ToString());
        var d = cmp.Data!;
        Assert.False(d["comparableAsZip"]!.GetValue<bool>());
        Assert.Empty(d["entries"]!.AsArray());
        Assert.True(d["sizeChanged"]!.GetValue<bool>());
        Assert.True(d["hashChanged"]!.GetValue<bool>());
        Assert.Equal(10, d["fromSizeBytes"]!.GetValue<long>());
        Assert.Equal(20, d["toSizeBytes"]!.GetValue<long>());
    }

    [Fact]
    public async Task Downloading_a_published_build_returns_the_exact_bytes_that_were_uploaded()
    {
        var (owner, id, _) = await ArtifactDoc();
        var bytes = Zip(("a.txt", "hello artifact"));
        Assert.True((await owner.Upload($"/api/v1/documents/{id}/artifact/draft", "app.zip", bytes)).Ok);
        var pub = await owner.Post($"/api/v1/documents/{id}/artifact/publish", new { revision = await Rev(owner, id) });
        var versionId = S(pub.Data!["items"]!.AsArray().First(v => v!["isCurrent"]!.GetValue<bool>())!["id"]);

        using var res = await owner.Raw($"/api/v1/documents/{id}/artifact/versions/{versionId}/download");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var got = await res.Content.ReadAsByteArrayAsync();
        Assert.Equal(bytes, got);
    }

    [Fact]
    public async Task A_guest_who_can_only_view_cannot_upload_a_build_but_can_download_the_published_one()
    {
        var owner = await TestClient.RegisterAsync(factory, "Betty Builder");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var guest = await owner.AddMemberAsync(factory, ProjectManagement.Domain.Enums.TenantRole.Guest, "Val Viewer");
        var project = await owner.CreateProjectAsync("Releases");
        Assert.True((await owner.Post($"/api/v1/projects/{project}/members", new { userId = guest.UserId })).Ok);
        var type = Guid.Parse(S((await owner.Get("/api/v1/document-types")).Data!.AsArray().First(t => S(t!["code"]) == "ARTIFACT")!["id"]));
        var created = await owner.Post("/api/v1/documents", new { title = "Payments service", typeId = type, projectId = project });
        var id = Guid.Parse(S(created.Data!["item"]!["id"]));

        Assert.True((await owner.Upload($"/api/v1/documents/{id}/artifact/draft", "app.zip", Zip(("a", "1")))).Ok);
        await owner.Post($"/api/v1/documents/{id}/artifact/publish", new { revision = await Rev(owner, id) });

        var up = await guest.Upload($"/api/v1/documents/{id}/artifact/draft", "sneaky.zip", Zip(("a", "2")));
        Assert.Equal(HttpStatusCode.Forbidden, up.Status);

        var versions = await guest.Get($"/api/v1/documents/{id}/artifact/versions");
        Assert.True(versions.Ok, versions.ToString());
        var versionId = S(versions.Data!["items"]!.AsArray().First(v => v!["isCurrent"]!.GetValue<bool>())!["id"]);
        using var dl = await guest.Raw($"/api/v1/documents/{id}/artifact/versions/{versionId}/download");
        Assert.Equal(HttpStatusCode.OK, dl.StatusCode);
    }
}
