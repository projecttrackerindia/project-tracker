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
/// </summary>
public class DocumentFileService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, AttachmentService attachments, IFileStorage storage,
    DocumentAccessService rights, ILogger<DocumentFileService> log)
{
    public const int MaxPerDocument = 100;

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

        var stored = await attachments.StoreAsync(fileName, content, length, ct);
        var file = new DocumentFile { TenantId = tid, DocumentId = documentId, FileName = stored.Name, ContentType = stored.ContentType, SizeBytes = length, StorageKey = stored.Key, Sha256 = stored.Sha256, CreatedAt = clock.Now, CreatedBy = ctx.UserId };
        db.DocumentFiles.Add(file);
        recorder.Activity("document.file_added", "Document", doc.Id, $"Attached “{stored.Name}” to {DocumentService.KeyOf(doc.Number)}", doc.ProjectId);
        try { await db.SaveChangesAsync(ct); }
        catch { await storage.DeleteAsync(stored.Key, CancellationToken.None); throw; }
        return (await ListAsync(documentId, ct)).First(f => f.Id == file.Id);
    }

    public async Task<(DocumentFile File, Stream Content)> OpenAsync(Guid documentId, Guid fileId, CancellationToken ct = default)
    {
        await VisibleAsync(documentId, ct);
        var f = await db.DocumentFiles.AsNoTracking().FirstOrDefaultAsync(x => x.Id == fileId && x.DocumentId == documentId, ct) ?? throw new NotFoundException("File not found.");
        var stream = await storage.OpenReadAsync(f.StorageKey, ct);
        if (stream is null) { log.LogError("Document file {Id} is missing from storage ({Key})", f.Id, f.StorageKey); throw new NotFoundException("This file is no longer available."); }
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
