using System.Security.Cryptography;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Files;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Documents;

public record DocumentFileDto(Guid Id, string FileName, string ContentType, long SizeBytes, bool IsImage, UserRefDto? UploadedBy, DateTime CreatedAt, bool CanDelete);

/// <summary>
/// Files attached to a document (pictures that sit in its text, specifications, spreadsheets). The same rules as every other file in the product
/// apply (type by extension and content, the plan's size and storage limits); who may see one is who may open the document.
///
/// Confidential and Restricted documents (<see cref="DocumentClassification"/>) get their file bytes encrypted at rest with the same AES-256-GCM
/// envelope encryption <see cref="SecretService"/> already uses for secret values (<see cref="EnvelopeCrypto"/>) - a file's ciphertext is bound to
/// its own row (AAD = tenant|document|file id), so copied ciphertext opens nowhere else. The encryption decision is made once, at upload time, from
/// the document's classification at that moment; changing the document's classification afterward does not retroactively re-encrypt or decrypt
/// files already stored (each file's own <see cref="DocumentFile.Encrypted"/>/<see cref="DocumentFile.KeyVersion"/> drive how it's read, not the
/// document's current classification). Encrypted files cannot use the normal presigned-URL download shortcut (object storage only ever holds
/// ciphertext) - they're always read back through this service so the bytes can be decrypted server-side before streaming to the caller.
/// </summary>
public class DocumentFileService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, AttachmentService attachments, IFileStorage storage,
    DocumentAccessService rights, EnvelopeCrypto crypto, ILogger<DocumentFileService> log)
{
    public const int MaxPerDocument = 100;

    private static bool RequiresEncryption(DocumentClassification c) => c is DocumentClassification.Confidential or DocumentClassification.Restricted;
    private static string Aad(Guid tenant, Guid document, Guid id) => $"{tenant:N}|{document:N}|{id:N}";

    private async Task<Document> VisibleAsync(Guid id, CancellationToken ct) =>
        await db.Documents.AsNoTracking().FirstOrDefaultAsync(d => d.Id == id, ct) ?? throw new NotFoundException("Document not found.");

    public async Task<IReadOnlyList<DocumentFileDto>> ListAsync(Guid documentId, CancellationToken ct = default)
    {
        var doc = await VisibleAsync(documentId, ct);
        var r = await rights.RightsAsync(doc, ct);
        var rows = await db.DocumentFiles.AsNoTracking().Where(f => f.DocumentId == documentId).OrderByDescending(f => f.CreatedAt).Take(MaxPerDocument).ToListAsync(ct);
        var ids = rows.Where(f => f.CreatedBy != null).Select(f => f.CreatedBy!.Value).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => ids.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        return rows.Select(f => new DocumentFileDto(f.Id, f.FileName, f.ContentType, f.SizeBytes, FileRules.IsImage(f.ContentType),
            f.CreatedBy is { } u ? new UserRefDto(u, names.GetValueOrDefault(u) ?? "Former member") : null, f.CreatedAt, r.Edit && (f.CreatedBy == ctx.UserId || doc.OwnerId == ctx.UserId || r.Delete))).ToList();
    }

    public async Task<DocumentFileDto> UploadAsync(Guid documentId, string? fileName, Stream content, long length, CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        var doc = await VisibleAsync(documentId, ct);
        if (!(await rights.RightsAsync(doc, ct)).Edit) throw new ForbiddenException("You can read this document but not add files to it.", "PERMISSION_DENIED");
        if (await db.DocumentFiles.CountAsync(f => f.DocumentId == documentId, ct) >= MaxPerDocument) throw new ValidationException("file", $"A document can have up to {MaxPerDocument} files.");

        var fileId = Guid.CreateVersion7();   // generated up front so it's available for the encryption AAD below, matching the entity base class's own id generation
        var encrypt = RequiresEncryption(doc.Classification);
        DataKey? dataKey = encrypt ? await crypto.ActiveKeyAsync(tid, ct) : null;
        var stored = await attachments.StoreAsync(fileName, content, length, ct, beforeStore: encrypt
            ? async (plain, c) =>
            {
                using var buffer = new MemoryStream();
                await plain.CopyToAsync(buffer, c);
                var cipher = crypto.EncryptBytes(dataKey!, buffer.ToArray(), Aad(tid, documentId, fileId));
                return new MemoryStream(cipher);
            }
            : null);
        var file = new DocumentFile
        {
            Id = fileId, TenantId = tid, DocumentId = documentId, FileName = stored.Name, ContentType = stored.ContentType, SizeBytes = length,
            StorageKey = stored.Key, Sha256 = stored.Sha256, Encrypted = encrypt, KeyVersion = encrypt ? dataKey!.Version : 0, CreatedAt = clock.Now, CreatedBy = ctx.UserId,
        };
        db.DocumentFiles.Add(file);
        recorder.Activity("document.file_added", "Document", doc.Id, $"Attached “{stored.Name}” to {DocumentService.KeyOf(doc.Number)}", doc.ProjectId);
        recorder.Audit("document.file_added", "Document", doc.Id, null, new { stored.Name, encrypted = encrypt });
        try { await db.SaveChangesAsync(ct); }
        catch { await storage.DeleteAsync(stored.Key, CancellationToken.None); throw; }
        return (await ListAsync(documentId, ct)).First(f => f.Id == file.Id);
    }

    public async Task<(DocumentFile File, Stream Content)> OpenAsync(Guid documentId, Guid fileId, CancellationToken ct = default)
    {
        var doc = await VisibleAsync(documentId, ct);
        // Checked and audited as its own action, distinct from viewing the document's metadata/content in the
        // reader — today every visible document's files are downloadable (there is no separate "view but don't
        // download" grant in the schema yet), but the check and the audit event are now explicit rather than
        // implicit, so a future per-grant download restriction has a real enforcement point to extend, and so
        // a download is distinguishable from an ordinary read in the audit trail.
        await rights.RightsAsync(doc, ct);
        var f = await db.DocumentFiles.AsNoTracking().FirstOrDefaultAsync(x => x.Id == fileId && x.DocumentId == documentId, ct) ?? throw new NotFoundException("File not found.");
        var stream = await storage.OpenReadAsync(f.StorageKey, ct);
        if (stream is null) { log.LogError("Document file {Id} is missing from storage ({Key})", f.Id, f.StorageKey); throw new NotFoundException("This file is no longer available."); }
        if (f.Encrypted)
        {
            // Object storage only ever holds ciphertext for an encrypted file, so there is no presigned-URL shortcut here - decrypt fully in
            // memory and hand back a plaintext stream. Never written to local disk at any point.
            using var cipherStream = stream;
            using var buffer = new MemoryStream();
            await cipherStream.CopyToAsync(buffer, ct);
            byte[] plain;
            try { plain = crypto.DecryptBytes(await crypto.KeyAsync(f.TenantId, f.KeyVersion, ct), buffer.ToArray(), Aad(f.TenantId, documentId, f.Id)); }
            catch (Exception e) when (e is CryptographicException or FormatException or InvalidOperationException)
            {
                log.LogError(e, "Document file {Id} could not be decrypted (damaged content or missing key)", f.Id);
                recorder.Audit("document.file_unreadable", "Document", doc.Id, null, new { f.FileName });
                await db.SaveChangesAsync(ct);
                throw new ConflictException("This file cannot be read (its key or its data was damaged).", "FILE_UNREADABLE");
            }
            stream = new MemoryStream(plain);
        }
        recorder.Audit("document.file_downloaded", "Document", doc.Id, null, new { f.FileName });
        await db.SaveChangesAsync(ct);
        return (f, stream);
    }

    public async Task DeleteAsync(Guid documentId, Guid fileId, CancellationToken ct = default)
    {
        var doc = await VisibleAsync(documentId, ct);
        var r = await rights.RightsAsync(doc, ct);
        var f = await db.DocumentFiles.FirstOrDefaultAsync(x => x.Id == fileId && x.DocumentId == documentId, ct) ?? throw new NotFoundException("File not found.");
        if (!r.Edit || !(f.CreatedBy == ctx.UserId || doc.OwnerId == ctx.UserId || r.Delete)) throw new ForbiddenException("You can only remove files you added.", "PERMISSION_DENIED");
        db.DocumentFiles.Remove(f);
        recorder.Activity("document.file_removed", "Document", doc.Id, $"Removed “{f.FileName}” from {DocumentService.KeyOf(doc.Number)}", doc.ProjectId);
        recorder.Audit("document.file_removed", "Document", doc.Id, new { f.FileName, f.SizeBytes });
        await db.SaveChangesAsync(ct);
        try { await storage.DeleteAsync(f.StorageKey, ct); }
        catch (Exception ex) { log.LogWarning(ex, "Could not delete stored file {Key}", f.StorageKey); }
    }
}
