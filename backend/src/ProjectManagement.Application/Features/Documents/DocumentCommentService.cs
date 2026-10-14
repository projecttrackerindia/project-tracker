using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Documents;

public record DocumentCommentDto(Guid Id, UserRefDto User, string Body, DateTime CreatedAt, DateTime? EditedAt, bool Mine);
public record AddCommentRequest(string Body);

/// <summary>
/// Comments on a document: a running conversation anyone who may open the document can read and add to, same view permission as reading the
/// document itself (the controller's module check, plus the document's own visibility query filter - a document that is not visible does not
/// exist for this person on this screen either, so there is nothing extra to check here). Distinct from an <see cref="ApprovalDecision"/>'s
/// comment, which belongs to one reviewer's decision on one approval step, not to the document as a whole. Adding a comment notifies the
/// document's owner and anyone else who has already commented (never the person commenting now, never the same comment twice).
/// </summary>
public class DocumentCommentService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, DocumentNotifier notifier)
{
    public const int MaxBodyChars = 4000, MaxListed = 500;

    private async Task<Document> OpenAsync(Guid documentId, CancellationToken ct) =>
        await db.Documents.AsNoTracking().FirstOrDefaultAsync(d => d.Id == documentId, ct) ?? throw new NotFoundException("Document not found.");

    public async Task<IReadOnlyList<DocumentCommentDto>> ListAsync(Guid documentId, CancellationToken ct = default)
    {
        await OpenAsync(documentId, ct);
        var rows = await db.DocumentComments.AsNoTracking().Where(c => c.DocumentId == documentId).OrderBy(c => c.CreatedAt).Take(MaxListed).ToListAsync(ct);
        var names = await NamesAsync(rows.Select(r => r.UserId), ct);
        return rows.Select(c => ToDto(c, names)).ToList();
    }

    public async Task<DocumentCommentDto> AddAsync(Guid documentId, AddCommentRequest req, CancellationToken ct = default)
    {
        var doc = await OpenAsync(documentId, ct);
        var uid = ctx.RequireUserId();
        var body = CleanBody(req.Body);
        var now = clock.Now;
        var c = new DocumentComment { TenantId = doc.TenantId, DocumentId = documentId, UserId = uid, Body = body, CreatedAt = now, CreatedBy = uid };
        db.DocumentComments.Add(c);
        recorder.Activity("document.comment_added", "Document", documentId, $"Commented on {DocumentService.KeyOf(doc.Number)}", doc.ProjectId);
        recorder.Audit("document.comment_added", "Document", documentId, null, new { commentId = c.Id, length = body.Length });   // the words themselves never go in the audit row

        // Notify the owner and everyone else who has already commented - never the person commenting now.
        var priorCommenters = await db.DocumentComments.AsNoTracking().Where(x => x.DocumentId == documentId && x.UserId != uid).Select(x => x.UserId).Distinct().ToListAsync(ct);
        var people = priorCommenters.Append(doc.OwnerId).Distinct().Where(u => u != uid).ToList();
        var snippet = body.Length > 140 ? body[..140] + "…" : body;
        await notifier.SendAsync(people, doc, $"comment:{c.Id:N}", $"New comment on {DocumentService.KeyOf(doc.Number)}", snippet, ct: ct);

        await db.SaveChangesAsync(ct);
        return ToDto(c, await NamesAsync([uid], ct));
    }

    private DocumentCommentDto ToDto(DocumentComment c, Dictionary<Guid, string> names) =>
        new(c.Id, new UserRefDto(c.UserId, names.GetValueOrDefault(c.UserId) ?? "Former member"), c.Body, c.CreatedAt, c.EditedAt, c.UserId == ctx.UserId);

    private async Task<Dictionary<Guid, string>> NamesAsync(IEnumerable<Guid> ids, CancellationToken ct)
    {
        var list = ids.Distinct().ToList();
        return await db.Users.AsNoTracking().Where(u => list.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
    }

    private static string CleanBody(string? body)
    {
        var b = (body ?? "").Replace("\r\n", "\n").Trim();
        if (b.Length == 0) throw new ValidationException("body", "Write something first.");
        if (b.Length > MaxBodyChars) throw new ValidationException("body", $"A comment can be at most {MaxBodyChars:N0} characters.");
        return b;
    }
}
