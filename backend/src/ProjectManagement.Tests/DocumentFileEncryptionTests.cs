using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Confidential/Restricted documents get their file attachments encrypted at rest (AES-256-GCM, via the same envelope encryption
/// <see cref="ProjectManagement.Application.Features.Documents.SecretService"/> already uses for secret values) - gap closure for the enterprise-DMS
/// spec's "encrypt sensitive document content and files at rest" requirement, which the existing Documents module only met for small structured
/// secret fields, not for the document's own file attachments.
/// </summary>
[Collection("api")]
public class DocumentFileEncryptionTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private static byte[] Png() => Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==");

    private async Task<(TestClient Owner, Guid Brd)> Org(string plan = "BUSINESS", int seats = 10)
    {
        var owner = await TestClient.RegisterAsync(factory, "Sheila Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync(plan, seats);
        var brd = Guid.Parse(S((await owner.Get("/api/v1/document-types")).Data!.AsArray().First(t => S(t!["code"]) == "BRD")!["id"]));
        return (owner, brd);
    }

    private static async Task<Guid> Make(TestClient c, Guid type, string title, string classification)
    {
        var res = await c.Post("/api/v1/documents", new { title, typeId = type, visibility = "Organization", classification });
        Assert.True(res.Ok, res.ToString());
        return Guid.Parse(S(res.Data!["item"]!["id"]));
    }

    private byte[] RawStoredBytes(string storageKey)
    {
        using var scope = factory.Services.CreateScope();
        var storage = scope.ServiceProvider.GetRequiredService<IFileStorage>();
        using var stream = storage.OpenReadAsync(storageKey).GetAwaiter().GetResult()!;
        using var buffer = new MemoryStream();
        stream.CopyTo(buffer);
        return buffer.ToArray();
    }

    [Fact]
    public async Task A_confidential_documents_file_is_stored_encrypted_and_downloads_back_to_the_original_bytes()
    {
        var (owner, brd) = await Org();
        var doc = await Make(owner, brd, "Pricing strategy", "Confidential");
        var plain = Png();

        var up = await owner.Upload($"/api/v1/documents/{doc}/files", "diagram.png", plain);
        Assert.Equal(HttpStatusCode.Created, up.Status);
        var fileId = S(up.Data!["id"]);

        var row = factory.WithDb(db => db.DocumentFiles.IgnoreQueryFilters().First(f => f.Id == Guid.Parse(fileId)));
        Assert.True(row.Encrypted);
        Assert.True(row.KeyVersion > 0);

        // The bytes actually sitting in storage are ciphertext, not the original PNG - this is the whole point of the feature, not an
        // implementation detail: encryption has to happen before the write, not be something the download path merely pretends to undo.
        var onDisk = RawStoredBytes(row.StorageKey);
        Assert.NotEqual(plain, onDisk);

        using var res = await owner.Raw($"/api/v1/documents/{doc}/files/{fileId}/download");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal(plain, await res.Content.ReadAsByteArrayAsync());
    }

    [Theory]
    [InlineData("Public")]
    [InlineData("Internal")]
    public async Task A_public_or_internal_documents_file_is_stored_as_plain_bytes(string classification)
    {
        var (owner, brd) = await Org();
        var doc = await Make(owner, brd, "Team handbook", classification);
        var plain = Encoding.UTF8.GetBytes("nothing sensitive here");

        var up = await owner.Upload($"/api/v1/documents/{doc}/files", "notes.txt", plain);
        Assert.Equal(HttpStatusCode.Created, up.Status);
        var fileId = S(up.Data!["id"]);

        var row = factory.WithDb(db => db.DocumentFiles.IgnoreQueryFilters().First(f => f.Id == Guid.Parse(fileId)));
        Assert.False(row.Encrypted);
        Assert.Equal(0, row.KeyVersion);
        Assert.Equal(plain, RawStoredBytes(row.StorageKey));   // unchanged behavior for non-sensitive documents
    }

    [Fact]
    public async Task Ciphertext_moved_to_another_files_row_does_not_open_there()
    {
        var (owner, brd) = await Org();
        var docA = await Make(owner, brd, "Doc A", "Restricted");
        var docB = await Make(owner, brd, "Doc B", "Restricted");
        var upA = await owner.Upload($"/api/v1/documents/{docA}/files", "a.txt", Encoding.UTF8.GetBytes("secret A"));
        var fileIdA = Guid.Parse(S(upA.Data!["id"]));
        var upB = await owner.Upload($"/api/v1/documents/{docB}/files", "b.txt", Encoding.UTF8.GetBytes("secret B"));
        var fileIdB = Guid.Parse(S(upB.Data!["id"]));

        // Copy A's ciphertext/key-version onto B's row directly in the database - exactly the "ciphertext moved to another row" attack
        // SecretService's own AAD binding already defends against for secret values; file encryption must refuse it the same way.
        var (rowAKey, rowAVersion) = factory.WithDb(db => { var a = db.DocumentFiles.IgnoreQueryFilters().First(f => f.Id == fileIdA); return (a.StorageKey, a.KeyVersion); });
        factory.WithDb(db =>
        {
            var b = db.DocumentFiles.IgnoreQueryFilters().First(f => f.Id == fileIdB);
            b.StorageKey = rowAKey; b.KeyVersion = rowAVersion;
            return db.SaveChanges();
        });

        using var res = await owner.Raw($"/api/v1/documents/{docB}/files/{fileIdB}/download");
        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);   // FILE_UNREADABLE, not a 500 and not A's plaintext leaking through B's download
    }

    [Fact]
    public async Task Changing_classification_later_does_not_retroactively_encrypt_or_decrypt_files_already_stored()
    {
        var (owner, brd) = await Org();
        var doc = await Make(owner, brd, "Starts public", "Public");
        var plain = Encoding.UTF8.GetBytes("uploaded while public");
        var up = await owner.Upload($"/api/v1/documents/{doc}/files", "notes.txt", plain);
        var fileId = Guid.Parse(S(up.Data!["id"]));
        var rowBefore = factory.WithDb(db => db.DocumentFiles.IgnoreQueryFilters().First(f => f.Id == fileId));
        Assert.False(rowBefore.Encrypted);

        var rev = (await owner.Get($"/api/v1/documents/{doc}")).Data!["revision"]!.GetValue<int>();
        var update = await owner.Put($"/api/v1/documents/{doc}", new { title = "Starts public", visibility = "Organization", tags = Array.Empty<string>(), revision = rev, classification = "Restricted" });
        Assert.True(update.Ok, update.ToString());

        // The document is Restricted now, but the file that was already there when it was Public stays exactly as it was stored -
        // this is a documented limitation (see DocumentFileService's class doc comment), not a bug: retroactive re-encryption on a
        // classification change is a separate, larger piece of work (akin to key rotation) that this change deliberately doesn't attempt.
        var rowAfter = factory.WithDb(db => db.DocumentFiles.IgnoreQueryFilters().First(f => f.Id == fileId));
        Assert.False(rowAfter.Encrypted);
        Assert.Equal(plain, RawStoredBytes(rowAfter.StorageKey));

        using var res = await owner.Raw($"/api/v1/documents/{doc}/files/{fileId}/download");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal(plain, await res.Content.ReadAsByteArrayAsync());
    }

    [Fact]
    public async Task A_file_uploaded_after_the_classification_change_is_encrypted()
    {
        var (owner, brd) = await Org();
        var doc = await Make(owner, brd, "Starts public", "Public");
        var rev = (await owner.Get($"/api/v1/documents/{doc}")).Data!["revision"]!.GetValue<int>();
        await owner.Put($"/api/v1/documents/{doc}", new { title = "Starts public", visibility = "Organization", tags = Array.Empty<string>(), revision = rev, classification = "Confidential" });

        var plain = Encoding.UTF8.GetBytes("uploaded after the change");
        var up = await owner.Upload($"/api/v1/documents/{doc}/files", "notes.txt", plain);
        var fileId = Guid.Parse(S(up.Data!["id"]));
        var row = factory.WithDb(db => db.DocumentFiles.IgnoreQueryFilters().First(f => f.Id == fileId));
        Assert.True(row.Encrypted);
        Assert.NotEqual(plain, RawStoredBytes(row.StorageKey));
    }

    [Fact]
    public async Task Downloading_an_encrypted_file_is_audited_distinctly_from_viewing_the_document()
    {
        var (owner, brd) = await Org();
        var doc = await Make(owner, brd, "Audited", "Confidential");
        var up = await owner.Upload($"/api/v1/documents/{doc}/files", "a.txt", Encoding.UTF8.GetBytes("x"));
        var fileId = S(up.Data!["id"]);

        await owner.Get($"/api/v1/documents/{doc}");   // a plain read of the document itself
        using (await owner.Raw($"/api/v1/documents/{doc}/files/{fileId}/download")) { }

        var actions = factory.WithDb(db => db.AuditLogs.IgnoreQueryFilters().Where(a => a.EntityId == doc).Select(a => a.Action).ToList());
        Assert.Contains("document.file_added", actions);
        Assert.Contains("document.file_downloaded", actions);   // its own event, not folded into a generic "viewed" entry
    }
}
