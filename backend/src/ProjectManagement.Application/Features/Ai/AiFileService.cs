using System.Text;
using ClosedXML.Excel;
using DocumentFormat.OpenXml.Packaging;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Files;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Ai;

/// <summary>
/// Files a person attaches to a question: images and documents the assistant should read. Only the owner can see or use them. The type
/// has to match the file's first bytes, sizes follow the plan and the AI settings, and a spreadsheet or Word file is turned into text here
/// so any model reads it the same way. Files that are never sent with a question are cleared after a day.
/// </summary>
public class AiFileService(IAppDbContext db, ICurrentContext ctx, EntitlementService entitlements, IFileStorage storage, IOptions<AiOptions> options,
    AppClock clock, ILogger<AiFileService> log)
{
    /// <summary>What can be attached: pictures and PDFs go to the model as they are, the rest as extracted text.</summary>
    public static readonly string[] Extensions = ["png", "jpg", "jpeg", "gif", "webp", "pdf", "txt", "md", "csv", "docx", "xlsx"];
    private const int MaxPending = 12;

    private AiChatOptions Opt => options.Value.Chat;

    private async Task RequireAllowedAsync(CancellationToken ct)
    {
        await entitlements.EnsureFeatureAsync(FeatureKeys.AiAssistant, ct);
        await entitlements.EnsureFeatureAsync(FeatureKeys.AiAttachments, ct);
        var tid = ctx.RequireTenantId();
        if (await db.Tenants.Where(t => t.Id == tid).Select(t => t.AiDisabled).FirstOrDefaultAsync(ct))
            throw new ForbiddenException("The AI assistant is switched off for this workspace.", "AI_DISABLED");
    }

    // ------------------------------------------------------------------ upload

    public async Task<AiAttachmentDto> UploadAsync(string? fileName, Stream content, long length, CancellationToken ct = default)
    {
        await RequireAllowedAsync(ct);
        var uid = ctx.RequireUserId(); var tid = ctx.RequireTenantId();
        var name = FileRules.CleanName(fileName);
        var ext = Path.GetExtension(name).TrimStart('.').ToLowerInvariant();
        if (name.Length == 0 || !Extensions.Contains(ext) || !FileRules.TryDescribe(name, out var contentType, out var kind))
            throw new ValidationException("file", $"The assistant can read {string.Join(", ", Extensions.Select(e => "." + e))} files.");
        EnsureSupported(contentType);
        var isImage = FileRules.IsImage(contentType);

        var limit = (long)(isImage ? Opt.MaxImageMb : Opt.MaxDocumentMb) * FileRules.Mb;
        var plan = await entitlements.GetValueAsync(FeatureKeys.MaxFileSizeMb, ct);
        if (plan >= 0) limit = Math.Min(limit, plan * FileRules.Mb);
        if (length > limit) throw new ValidationException("file", $"That file is too large. The limit here is {limit / FileRules.Mb} MB.");

        // The file is read into memory under the limit (never trusting the declared length), then checked against its own first bytes.
        using var buffer = new MemoryStream();
        var chunk = new byte[81920]; int n;
        while ((n = await content.ReadAsync(chunk, ct)) > 0)
        {
            if (buffer.Length + n > limit) throw new ValidationException("file", $"That file is too large. The limit here is {limit / FileRules.Mb} MB.");
            buffer.Write(chunk, 0, n);
        }
        if (buffer.Length == 0) throw new ValidationException("file", "That file is empty.");
        var bytes = buffer.ToArray();
        if (!FileRules.LooksLike(kind, bytes.AsSpan(0, Math.Min(bytes.Length, 16)))) throw new ValidationException("file", "The file does not look like a ." + ext + " file.");

        await ClearStaleAsync(uid, ct);
        if (await db.AiAttachments.CountAsync(a => a.UserId == uid && a.MessageId == null, ct) >= MaxPending)
            throw new ValidationException("file", "Send or remove the files you already added first.");

        var text = isImage || ext == "pdf" ? null : Extract(ext, bytes);
        var key = $"ai/{tid:N}/{Guid.NewGuid():N}";
        await using (var ms = new MemoryStream(bytes)) await storage.SaveAsync(key, ms, ct);
        var row = new AiAttachment { UserId = uid, FileName = name, ContentType = contentType, SizeBytes = bytes.Length, StorageKey = key, ExtractedText = text };
        db.AiAttachments.Add(row);
        await db.SaveChangesAsync(ct);
        return ToDto(row);
    }

    public async Task<(AiAttachment File, Stream Content)> OpenAsync(Guid id, CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var row = await db.AiAttachments.AsNoTracking().FirstOrDefaultAsync(a => a.Id == id && a.UserId == uid, ct) ?? throw new NotFoundException("File not found.");
        var stream = await storage.OpenReadAsync(row.StorageKey, ct) ?? throw new NotFoundException("File not found.");
        return (row, stream);
    }

    public async Task RemovePendingAsync(Guid id, CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var row = await db.AiAttachments.FirstOrDefaultAsync(a => a.Id == id && a.UserId == uid && a.MessageId == null, ct) ?? throw new NotFoundException("File not found.");
        await DeleteAsync([row], ct);
    }

    // ------------------------------------------------------------------ with a question

    /// <summary>Checks the files a question names (the sender's own, not yet sent, within the limits) and returns them.</summary>
    public async Task<List<AiAttachment>> ForQuestionAsync(IReadOnlyList<Guid>? ids, CancellationToken ct)
    {
        if (ids is null || ids.Count == 0) return [];
        await RequireAllowedAsync(ct);
        var uid = ctx.RequireUserId();
        var distinct = ids.Distinct().ToList();
        if (distinct.Count > Opt.MaxFilesPerMessage) throw new ValidationException("attachments", $"Attach up to {Opt.MaxFilesPerMessage} files to one question.");
        var rows = await db.AiAttachments.Where(a => distinct.Contains(a.Id) && a.UserId == uid && a.MessageId == null).ToListAsync(ct);
        if (rows.Count != distinct.Count) throw new ValidationException("attachments", "One of the files is no longer available. Add it again.");
        foreach (var row in rows) EnsureSupported(row.ContentType);
        if (rows.Sum(r => r.SizeBytes) > (long)Opt.MaxTotalMb * FileRules.Mb) throw new ValidationException("attachments", $"Keep the files of one question under {Opt.MaxTotalMb} MB together.");
        return rows;
    }

    public IReadOnlyList<string> SupportedExtensions => Extensions.Where(ext => FileRules.TryDescribe("file." + ext, out var type, out _) && Supports(type)).ToList();

    public bool Supports(string contentType) => options.Value.UsesAnthropic ||
        contentType != "application/pdf" && (!FileRules.IsImage(contentType) || options.Value.Fallback.SupportsImages);

    private void EnsureSupported(string contentType)
    {
        if (!Supports(contentType))
            throw new AppException(422, "AI_ATTACHMENT_UNSUPPORTED", "The configured model cannot read this image or PDF. Paste its text or attach a text, Word, or spreadsheet file.");
    }

    /// <summary>The content the model receives for a file: pictures and PDFs as they are, anything else as its text.</summary>
    public async Task<AiBlock> BlockAsync(AiAttachment a, CancellationToken ct)
    {
        if (FileRules.IsImage(a.ContentType) || a.ContentType == "application/pdf")
        {
            await using var s = await storage.OpenReadAsync(a.StorageKey, ct) ?? throw new NotFoundException("A file could not be read.");
            using var ms = new MemoryStream();
            await s.CopyToAsync(ms, ct);
            return a.ContentType == "application/pdf" ? new AiPdf(ms.ToArray(), a.FileName) : new AiImage(a.ContentType, ms.ToArray());
        }
        return new AiText($"<document name=\"{a.FileName.Replace("\"", "'")}\">\n{a.ExtractedText ?? "(no readable text)"}\n</document>");
    }

    public async Task DeleteForConversationAsync(Guid conversationId, CancellationToken ct)
    {
        var rows = await db.AiAttachments.Where(a => a.ConversationId == conversationId).ToListAsync(ct);
        await DeleteAsync(rows, ct);
    }

    private async Task ClearStaleAsync(Guid uid, CancellationToken ct)
    {
        var cutoff = clock.Now.AddDays(-1);
        var stale = await db.AiAttachments.Where(a => a.UserId == uid && a.MessageId == null && a.CreatedAt < cutoff).ToListAsync(ct);
        if (stale.Count > 0) await DeleteAsync(stale, ct);
    }

    private async Task DeleteAsync(List<AiAttachment> rows, CancellationToken ct)
    {
        foreach (var r in rows)
        {
            try { await storage.DeleteAsync(r.StorageKey, ct); }
            catch (Exception ex) when (ex is not OperationCanceledException) { log.LogWarning(ex, "Could not delete the stored AI file {Key}", r.StorageKey); }
        }
        db.AiAttachments.RemoveRange(rows);
        await db.SaveChangesAsync(ct);
    }

    public static AiAttachmentDto ToDto(AiAttachment a) => new(a.Id, a.FileName, a.ContentType, a.SizeBytes, FileRules.IsImage(a.ContentType));

    // ------------------------------------------------------------------ text of documents

    private string Extract(string ext, byte[] bytes)
    {
        try
        {
            var text = ext switch
            {
                "txt" or "md" or "csv" => Encoding.UTF8.GetString(bytes).TrimStart('﻿'),
                "docx" => ExtractDocx(bytes),
                "xlsx" => ExtractXlsx(bytes),
                _ => "",
            };
            text = text.Replace("\r", "").Trim();
            if (text.Length == 0) throw new ValidationException("file", "There is no readable text in that file.");
            return text.Length > Opt.MaxDocumentChars ? text[..Opt.MaxDocumentChars] + "\n[…the rest of the document was left out]" : text;
        }
        catch (ValidationException) { throw; }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            log.LogInformation(ex, "Could not read an attached .{Ext} file", ext);
            throw new ValidationException("file", "That file could not be read. Is it damaged or password-protected?");
        }
    }

    private static string ExtractDocx(byte[] bytes)
    {
        using var ms = new MemoryStream(bytes);
        using var doc = WordprocessingDocument.Open(ms, false);
        var body = doc.MainDocumentPart?.Document?.Body;
        if (body is null) return "";
        // One line per paragraph; a table row becomes one line with its cells separated by " | ".
        var lines = new List<string>();
        foreach (var el in body.Elements())
        {
            if (el is DocumentFormat.OpenXml.Wordprocessing.Table table)
                foreach (var row in table.Elements<DocumentFormat.OpenXml.Wordprocessing.TableRow>())
                    lines.Add(string.Join(" | ", row.Elements<DocumentFormat.OpenXml.Wordprocessing.TableCell>().Select(c => c.InnerText.Trim())));
            else lines.Add(el.InnerText);
        }
        return string.Join("\n", lines.Where(l => !string.IsNullOrWhiteSpace(l)));
    }

    private static string ExtractXlsx(byte[] bytes)
    {
        using var ms = new MemoryStream(bytes);
        using var wb = new XLWorkbook(ms);
        var sb = new StringBuilder();
        foreach (var sheet in wb.Worksheets.Take(8))
        {
            var range = sheet.RangeUsed();
            if (range is null) continue;
            sb.Append("## Sheet: ").AppendLine(sheet.Name);
            foreach (var row in range.Rows().Take(1000))
                sb.AppendLine(string.Join(" | ", row.Cells().Take(40).Select(c => c.GetFormattedString().Trim())));
        }
        return sb.ToString();
    }
}
