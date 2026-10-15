using System.IO.Compression;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Files;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Documents;

public record ArtifactFileDto(string FileName, string ContentType, long SizeBytes, string Sha256, bool IsZip);
public record ArtifactVersionDto(Guid Id, string Label, bool IsDraft, bool IsCurrent, DateTime? PublishedAt, UserRefDto? PublishedBy, ArtifactFileDto? File);
public record ArtifactVersionListDto(IReadOnlyList<ArtifactVersionDto> Items, string? PublishedLabel, bool HasUnpublishedChanges, string NextLabel);
public record PublishArtifactRequest(int Revision);

/// <summary>One entry's status between two builds: present only in the older one ("Removed"), only in the newer one ("Added"), present in both with a
/// different CRC-32 or size ("Changed"), or identical in both (never sent - only counted in <see cref="ArtifactCompareDto.Unchanged"/>).</summary>
public record ArtifactEntryDiff(string Path, string Change, long? FromCrc32, long? ToCrc32, long? FromSize, long? ToSize);

/// <summary>
/// Comparing two builds. Zip-based containers (.zip/.jar/.war/.ear or anything else whose bytes start with a zip signature) get a real entry-level
/// diff - added, removed and changed inner files, by path and CRC-32. Anything else cannot be opened as a container, so the comparison falls back to
/// what can honestly be said about two opaque files: whether their size, hash or date differ. <see cref="ComparableAsZip"/> tells the caller which
/// shape the rest of the response is in; a client must not render zip-entry chrome around a non-zip compare.
/// </summary>
public record ArtifactCompareDto(ArtifactVersionDto From, ArtifactVersionDto To, bool ComparableAsZip, int Added, int Removed, int Changed, int Unchanged,
    IReadOnlyList<ArtifactEntryDiff> Entries, bool SizeChanged, bool HashChanged, long FromSizeBytes, long ToSizeBytes, string FromSha256, string ToSha256);

/// <summary>
/// The build file carried by one version of a Build Artifact document (see <see cref="DocumentVersionArtifact"/>). This reuses Documents' existing
/// version machinery almost entirely: <see cref="DocumentVersionService.PublishAsync"/> freezes the draft version row in place exactly as it does for
/// every other document type, and the only thing specific to this type is that a draft's "content" is the one file attached to it rather than its
/// sections - so its <see cref="DocumentVersion.ContentHash"/> is set here to the file's own SHA-256 (<see cref="UploadDraftAsync"/>), which is all
/// <see cref="DocumentVersionService.PublishAsync"/> needs to tell whether the draft has anything new to publish. Permission is the same Documents
/// module tier everything else in Documents uses (view = download, create/edit = upload a new build, delete = nothing extra here, matching the brief).
/// </summary>
public class ArtifactVersionService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, AttachmentService attachments, IFileStorage storage,
    DocumentAccessService rights, DocumentVersionService versions, EnvelopeCrypto crypto, ILogger<ArtifactVersionService> log)
{
    public const string ArtifactTypeCode = "ARTIFACT";

    private static bool RequiresEncryption(DocumentClassification c) => c is DocumentClassification.Confidential or DocumentClassification.Restricted;
    private static string Aad(Guid tenant, Guid version, Guid id) => $"{tenant:N}|{version:N}|{id:N}";
    private static string FormatBytes(long b) => b >= 1024 * 1024 ? $"{b / (1024.0 * 1024):0.#} MB" : $"{Math.Max(1, b / 1024.0):0} KB";

    private async Task<Document> LoadAsync(Guid id, CancellationToken ct, bool tracked = false) =>
        await (tracked ? db.Documents : db.Documents.AsNoTracking()).FirstOrDefaultAsync(d => d.Id == id, ct) ?? throw new NotFoundException("Document not found.");

    private async Task RequireArtifactTypeAsync(Document doc, CancellationToken ct)
    {
        var code = await db.DocumentTypes.AsNoTracking().Where(t => t.Id == doc.TypeId).Select(t => t.Code).FirstOrDefaultAsync(ct);
        if (code != ArtifactTypeCode) throw new ValidationException("documentId", "This is not a Build Artifact document.");
    }

    // ------------------------------------------------------------------ reading

    public async Task<ArtifactVersionListDto> ListAsync(Guid documentId, CancellationToken ct = default)
    {
        await LoadAsync(documentId, ct);
        var baseList = await versions.ListAsync(documentId, ct);
        var ids = baseList.Items.Select(v => v.Id).ToList();
        var files = await db.DocumentVersionArtifacts.AsNoTracking().Where(a => ids.Contains(a.VersionId)).ToListAsync(ct);
        var byVersion = files.ToDictionary(f => f.VersionId);
        ArtifactVersionDto Map(VersionDto v) => new(v.Id, v.Label, v.IsDraft, v.IsCurrent, v.PublishedAt, v.PublishedBy,
            byVersion.TryGetValue(v.Id, out var f) ? new ArtifactFileDto(f.FileName, f.ContentType, f.SizeBytes, f.Sha256, f.IsZip) : null);
        return new ArtifactVersionListDto(baseList.Items.Select(Map).ToList(), baseList.PublishedLabel, baseList.HasUnpublishedChanges, baseList.NextLabelMinor);
    }

    // ------------------------------------------------------------------ upload / publish

    /// <summary>Attaches (or replaces) the file on the document's current draft. Nobody ever types a version number or a date here: the version is
    /// whichever draft this becomes once published, and the date is always <see cref="AppClock.Now"/> - never anything the caller sends.</summary>
    public async Task<ArtifactVersionDto> UploadDraftAsync(Guid documentId, string? fileName, Stream content, long length, CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        var doc = await LoadAsync(documentId, ct, tracked: true);
        if (!(await rights.RightsAsync(doc, ct)).Edit) throw new ForbiddenException("You can read this document but not add a build to it.", "PERMISSION_DENIED");
        await RequireArtifactTypeAsync(doc, ct);
        var draftId = doc.DraftVersionId ?? throw new ConflictException("This document has no draft to attach a file to.", "NO_DRAFT");
        var draft = await db.DocumentVersions.FirstAsync(v => v.Id == draftId, ct);

        if (!content.CanSeek) throw new InvalidOperationException("Uploads must be seekable streams.");
        content.Position = 0;
        var head = new byte[4];
        var got = length > 0 ? await content.ReadAsync(head.AsMemory(0, (int)Math.Min(4, length)), ct) : 0;
        content.Position = 0;
        var isZip = got >= 4 && head[0] == 0x50 && head[1] == 0x4B && (head[2] == 0x03 || head[2] == 0x05) && (head[3] == 0x04 || head[3] == 0x06);

        var fileId = Guid.CreateVersion7();
        var encrypt = RequiresEncryption(doc.Classification);
        DataKey? dataKey = encrypt ? await crypto.ActiveKeyAsync(tid, ct) : null;
        var stored = await attachments.StoreAsync(fileName, content, length, ct,
            beforeStore: encrypt
                ? async (plain, c) =>
                {
                    using var buffer = new MemoryStream();
                    await plain.CopyToAsync(buffer, c);
                    var cipher = crypto.EncryptBytes(dataKey!, buffer.ToArray(), Aad(tid, draftId, fileId));
                    return new MemoryStream(cipher);
                }
                : null,
            allowUnknownExtension: true);   // build artifacts have no fixed extension list - see FileRules.TryDescribe

        var existing = await db.DocumentVersionArtifacts.FirstOrDefaultAsync(a => a.VersionId == draftId, ct);
        var oldKey = existing?.StorageKey;
        if (existing is not null) db.DocumentVersionArtifacts.Remove(existing);
        var now = clock.Now;
        db.DocumentVersionArtifacts.Add(new DocumentVersionArtifact
        {
            Id = fileId, TenantId = tid, VersionId = draftId, DocumentId = doc.Id, FileName = stored.Name, ContentType = stored.ContentType, SizeBytes = length,
            StorageKey = stored.Key, Sha256 = stored.Sha256, Encrypted = encrypt, KeyVersion = encrypt ? dataKey!.Version : 0, IsZip = isZip, CreatedAt = now, CreatedBy = ctx.UserId,
        });
        // The draft's content hash now tracks its attached file, the same way it tracks section text for every other document type - this is the
        // only line that makes DocumentVersionService.PublishAsync's "nothing new to publish" and "unpublished changes" checks mean the right thing
        // here, with no change needed to that service at all.
        draft.ContentHash = stored.Sha256; draft.UpdatedAt = now; draft.UpdatedBy = ctx.UserId;
        recorder.Activity("document.artifact_uploaded", "Document", doc.Id, $"Attached build “{stored.Name}” to {DocumentService.KeyOf(doc.Number)}", doc.ProjectId);
        recorder.Audit("document.artifact_uploaded", "Document", doc.Id, null, new { stored.Name, length, encrypted = encrypt });
        try { await db.SaveChangesAsync(ct); }
        catch { await storage.DeleteAsync(stored.Key, CancellationToken.None); throw; }
        if (oldKey is not null) { try { await storage.DeleteAsync(oldKey, ct); } catch (Exception ex) { log.LogWarning(ex, "Could not delete the replaced build file {Key}", oldKey); } }

        var list = await ListAsync(documentId, ct);
        return list.Items.First(v => v.Id == draftId);
    }

    /// <summary>Freezes the draft's attached file as the next version. The change summary is generated, never typed, from the file itself.</summary>
    public async Task<ArtifactVersionListDto> PublishAsync(Guid documentId, PublishArtifactRequest req, CancellationToken ct = default)
    {
        var doc = await LoadAsync(documentId, ct);
        await RequireArtifactTypeAsync(doc, ct);
        var draftId = doc.DraftVersionId ?? throw new ConflictException("This document has no draft.", "NO_DRAFT");
        var artifact = await db.DocumentVersionArtifacts.AsNoTracking().FirstOrDefaultAsync(a => a.VersionId == draftId, ct)
            ?? throw new ValidationException("file", "Attach a build before publishing.");
        var summary = $"Uploaded {artifact.FileName} ({FormatBytes(artifact.SizeBytes)})";
        await versions.PublishAsync(documentId, new PublishRequest(summary, null, false, req.Revision), ct);
        return await ListAsync(documentId, ct);
    }

    // ------------------------------------------------------------------ download

    public async Task<(DocumentVersionArtifact File, Stream Content)> OpenAsync(Guid documentId, Guid versionId, CancellationToken ct = default)
    {
        var doc = await LoadAsync(documentId, ct);
        await rights.RightsAsync(doc, ct);   // a NotFoundException already happened above if the document itself is not visible
        var f = await db.DocumentVersionArtifacts.AsNoTracking().FirstOrDefaultAsync(a => a.VersionId == versionId && a.DocumentId == documentId, ct)
            ?? throw new NotFoundException("No build file for this version.");
        var stream = await storage.OpenReadAsync(f.StorageKey, ct);
        if (stream is null)
        {
            log.LogError("Build artifact {Id} is missing from storage ({Key})", f.Id, f.StorageKey);
            throw new NotFoundException("This file is no longer available.");
        }
        if (f.Encrypted)
        {
            using var cipherStream = stream;
            using var buffer = new MemoryStream();
            await cipherStream.CopyToAsync(buffer, ct);
            byte[] plain;
            try { plain = crypto.DecryptBytes(await crypto.KeyAsync(f.TenantId, f.KeyVersion, ct), buffer.ToArray(), Aad(f.TenantId, f.VersionId, f.Id)); }
            catch (Exception e) when (e is System.Security.Cryptography.CryptographicException or FormatException or InvalidOperationException)
            {
                log.LogError(e, "Build artifact {Id} could not be decrypted (damaged content or missing key)", f.Id);
                throw new ConflictException("This file cannot be read (its key or its data was damaged).", "FILE_UNREADABLE");
            }
            stream = new MemoryStream(plain);
        }
        recorder.Audit("document.artifact_downloaded", "Document", doc.Id, null, new { f.FileName });
        await db.SaveChangesAsync(ct);
        return (f, stream);
    }

    // ------------------------------------------------------------------ compare

    private sealed record ZipEntryInfo(long Crc32, long Size);

    public async Task<ArtifactCompareDto> CompareAsync(Guid documentId, Guid fromId, Guid toId, CancellationToken ct = default)
    {
        var doc = await LoadAsync(documentId, ct);
        await rights.RightsAsync(doc, ct);
        var list = await ListAsync(documentId, ct);
        var from = list.Items.FirstOrDefault(v => v.Id == fromId) ?? throw new NotFoundException("Version not found.");
        var to = list.Items.FirstOrDefault(v => v.Id == toId) ?? throw new NotFoundException("Version not found.");
        if (from.File is null || to.File is null) throw new ValidationException("version", "Both versions need an attached build to compare.");

        if (!from.File.IsZip || !to.File.IsZip)
            return new ArtifactCompareDto(from, to, false, 0, 0, 0, 0, [], from.File.SizeBytes != to.File.SizeBytes, from.File.Sha256 != to.File.Sha256,
                from.File.SizeBytes, to.File.SizeBytes, from.File.Sha256, to.File.Sha256);

        var fromEntries = await ReadZipEntriesAsync(documentId, fromId, ct);
        var toEntries = await ReadZipEntriesAsync(documentId, toId, ct);
        var paths = fromEntries.Keys.Union(toEntries.Keys).OrderBy(p => p, StringComparer.Ordinal).ToList();
        var diffs = new List<ArtifactEntryDiff>();
        int added = 0, removed = 0, changed = 0, unchanged = 0;
        foreach (var p in paths)
        {
            var inFrom = fromEntries.TryGetValue(p, out var f1);
            var inTo = toEntries.TryGetValue(p, out var f2);
            if (inFrom && !inTo) { removed++; diffs.Add(new ArtifactEntryDiff(p, "Removed", f1!.Crc32, null, f1.Size, null)); }
            else if (!inFrom && inTo) { added++; diffs.Add(new ArtifactEntryDiff(p, "Added", null, f2!.Crc32, null, f2.Size)); }
            else if (f1!.Crc32 != f2!.Crc32 || f1.Size != f2.Size) { changed++; diffs.Add(new ArtifactEntryDiff(p, "Changed", f1.Crc32, f2.Crc32, f1.Size, f2.Size)); }
            else unchanged++;
        }
        return new ArtifactCompareDto(from, to, true, added, removed, changed, unchanged, diffs, false, false, from.File.SizeBytes, to.File.SizeBytes, from.File.Sha256, to.File.Sha256);
    }

    private async Task<Dictionary<string, ZipEntryInfo>> ReadZipEntriesAsync(Guid documentId, Guid versionId, CancellationToken ct)
    {
        var (_, content) = await OpenAsync(documentId, versionId, ct);
        using var stream = content;
        using var ms = new MemoryStream();
        await stream.CopyToAsync(ms, ct);
        ms.Position = 0;
        using var zip = new ZipArchive(ms, ZipArchiveMode.Read, leaveOpen: true);
        var dict = new Dictionary<string, ZipEntryInfo>();
        foreach (var e in zip.Entries)
        {
            if (e.FullName.EndsWith('/')) continue;   // directory marker entries carry no content of their own
            dict[e.FullName] = new ZipEntryInfo(e.Crc32, e.Length);
        }
        return dict;
    }
}
