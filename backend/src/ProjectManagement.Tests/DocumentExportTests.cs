using System.IO.Compression;
using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Features.Reports;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// The workspace GDPR/data export (<see cref="ProjectManagement.Application.Features.Compliance.WorkspaceExporter"/>) used to include nothing
/// about documents at all - gap closure for the enterprise-DMS spec's data-portability requirement. A document's metadata, versions, sections
/// and file attachments (decrypted, if the document was Confidential/Restricted) now export; a document's own secret values never do.
/// </summary>
[Collection("api")]
public class DocumentExportTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();

    [Fact]
    public async Task A_workspace_export_includes_documents_their_files_decrypted_but_never_a_documents_secret_values()
    {
        var owner = await TestClient.RegisterAsync(factory, "Olivia Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var brd = Guid.Parse(S((await owner.Get("/api/v1/document-types")).Data!.AsArray().First(t => S(t!["code"]) == "BRD")!["id"]));
        var doc = Guid.Parse(S((await owner.Post("/api/v1/documents", new { title = "Export me", typeId = brd, visibility = "Organization", classification = "Confidential" })).Data!["item"]!["id"]));

        var fileContent = Encoding.UTF8.GetBytes("this plaintext must survive the round trip through encryption and export");
        await owner.Upload($"/api/v1/documents/{doc}/files", "notes.txt", fileContent);
        const string secretValue = "sk-definitely-not-exported-1234567890";
        await owner.Post($"/api/v1/documents/{doc}/secrets", new { label = "API key", value = secretValue });

        var req = await owner.Post("/api/v1/reports/exports", new { kind = "WorkspaceExport", format = "Zip" });
        Assert.True(req.Ok, req.ToString());
        await factory.Services.GetRequiredService<ReportExportProcessor>().ProcessPendingAsync();
        var id = S(req.Data!["id"]);
        Assert.Equal("Ready", S((await owner.Get($"/api/v1/reports/exports/{id}")).Data!["status"]));
        var file = await owner.Raw($"/api/v1/reports/exports/{id}/file");

        using var zip = new ZipArchive(new MemoryStream(await file.Content.ReadAsByteArrayAsync()));
        var names = zip.Entries.Select(e => e.FullName).ToList();
        foreach (var n in new[] { "documents.json", "document-versions.json", "document-sections.json", "attachments.json" }) Assert.Contains(n, names);

        string Read(string n) { using var r = new StreamReader(zip.GetEntry(n)!.Open()); return r.ReadToEnd(); }
        Assert.Contains("Export me", Read("documents.json"));
        Assert.Contains("Confidential", Read("documents.json"));

        // The file is listed and actually included (decrypted - its plaintext, not ciphertext, is what's in the zip).
        var attachments = JsonNode.Parse(Read("attachments.json"))!.AsArray();
        var row = attachments.First(a => S(a!["fileName"]) == "notes.txt");
        Assert.True(row!["included"]!.GetValue<bool>());
        var path = S(row["path"]);
        using var entryStream = zip.GetEntry(path)!.Open();
        using var buffer = new MemoryStream();
        await entryStream.CopyToAsync(buffer);
        Assert.Equal(fileContent, buffer.ToArray());

        // Nothing in the whole zip ever contains the secret's actual value, or an encrypted document's ciphertext passed through unencrypted.
        foreach (var entry in zip.Entries)
        {
            using var s = entry.Open();
            using var b = new MemoryStream();
            await s.CopyToAsync(b);
            if (entry.FullName.EndsWith(".json", StringComparison.Ordinal))
            {
                var text = Encoding.UTF8.GetString(b.ToArray());
                Assert.DoesNotContain(secretValue, text);
            }
        }
    }
}
