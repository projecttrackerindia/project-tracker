using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Documents;

/// <param name="ParentId">Set on a reply: the thread's first comment.</param>
/// <param name="AnchorId">The comment mark on the selected text the thread is about (first comment only).</param>
public record DocumentCommentDto(Guid Id, UserRefDto User, string Body, DateTime CreatedAt, DateTime? EditedAt, bool Mine, Guid? ParentId = null, string? AnchorId = null,
    string? Quote = null, DateTime? ResolvedAt = null, string? ResolvedBy = null, bool CanResolve = false);
/// <param name="ParentId">Reply in this thread.</param>
/// <param name="AnchorId">Start a thread on selected text: the id of its comment mark in the page.</param>
public record AddCommentRequest(string Body, Guid? ParentId = null, string? AnchorId = null, string? Quote = null);
public record ResolveCommentRequest(bool Resolved);

/// <summary>
/// Comments on a document: a running conversation anyone who may open the document can read and add to, same view permission as reading the
/// document itself (the controller's module check, plus the document's own visibility query filter - a document that is not visible does not
/// exist for this person on this screen either, so there is nothing extra to check here). Distinct from an <see cref="ApprovalDecision"/>'s
/// comment, which belongs to one reviewer's decision on one approval step, not to the document as a whole. Adding a comment notifies the
/// document's owner and anyone else who has already commented (never the person commenting now, never the same comment twice).
/// </summary>
public class DocumentCommentService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, DocumentNotifier notifier, DocumentAccessService rights)
{
    public const int MaxBodyChars = 4000, MaxListed = 500;

    private async Task<Document> OpenAsync(Guid documentId, CancellationToken ct) =>
        await db.Documents.AsNoTracking().FirstOrDefaultAsync(d => d.Id == documentId, ct) ?? throw new NotFoundException("Document not found.");

    public async Task<IReadOnlyList<DocumentCommentDto>> ListAsync(Guid documentId, CancellationToken ct = default)
    {
        var doc = await OpenAsync(documentId, ct);
        var rows = await db.DocumentComments.AsNoTracking().Where(c => c.DocumentId == documentId).OrderBy(c => c.CreatedAt).Take(MaxListed).ToListAsync(ct);
        var names = await NamesAsync(rows.Select(r => r.UserId).Concat(rows.Where(r => r.ResolvedBy != null).Select(r => r.ResolvedBy!.Value)), ct);
        var edit = (await rights.RightsAsync(doc, ct)).Edit || doc.OwnerId == ctx.UserId;
        return rows.Select(c => ToDto(c, names, edit)).ToList();
    }

    public async Task<DocumentCommentDto> AddAsync(Guid documentId, AddCommentRequest req, CancellationToken ct = default)
    {
        var doc = await OpenAsync(documentId, ct);
        var uid = ctx.RequireUserId();
        var body = CleanBody(req.Body);
        var now = clock.Now;
        DocumentComment? parent = null;
        if (req.ParentId is { } pid)
        {
            parent = await db.DocumentComments.FirstOrDefaultAsync(x => x.Id == pid && x.DocumentId == documentId, ct) ?? throw new ValidationException("parentId", "The comment you reply to was not found.");
            if (parent.ParentId is { } root) parent = await db.DocumentComments.FirstAsync(x => x.Id == root, ct);   // a reply to a reply joins the same thread
            if (parent.ResolvedAt is not null) { parent.ResolvedAt = null; parent.ResolvedBy = null; }               // a reply reopens a resolved thread
        }
        var anchor = parent is null && !string.IsNullOrWhiteSpace(req.AnchorId) ? req.AnchorId.Trim() : null;
        if (anchor is not null && (anchor.Length > 40 || !anchor.All(ch => char.IsLetterOrDigit(ch) || ch == '-'))) throw new ValidationException("anchorId", "The selected text could not be marked.");
        var quote = anchor is null || string.IsNullOrWhiteSpace(req.Quote) ? null : req.Quote.Trim().Length > 500 ? req.Quote.Trim()[..500] : req.Quote.Trim();
        var c = new DocumentComment { TenantId = doc.TenantId, DocumentId = documentId, UserId = uid, Body = body, CreatedAt = now, CreatedBy = uid, ParentId = parent?.Id, AnchorId = anchor, Quote = quote };
        db.DocumentComments.Add(c);
        recorder.Activity("document.comment_added", "Document", documentId, $"Commented on {DocumentService.KeyOf(doc.Number)}", doc.ProjectId);
        recorder.Audit("document.comment_added", "Document", documentId, null, new { commentId = c.Id, length = body.Length });   // the words themselves never go in the audit row

        // Notify the owner and everyone else who has already commented - never the person commenting now.
        // A reply goes to the people in that thread; a new comment to everyone who has commented on the document.
        var priorCommenters = parent is not null
            ? await db.DocumentComments.AsNoTracking().Where(x => (x.Id == parent.Id || x.ParentId == parent.Id) && x.UserId != uid).Select(x => x.UserId).Distinct().ToListAsync(ct)
            : await db.DocumentComments.AsNoTracking().Where(x => x.DocumentId == documentId && x.UserId != uid).Select(x => x.UserId).Distinct().ToListAsync(ct);
        var people = priorCommenters.Append(doc.OwnerId).Distinct().Where(u => u != uid).ToList();
        var snippet = body.Length > 140 ? body[..140] + "…" : body;
        await notifier.SendAsync(people, doc, $"comment:{c.Id:N}", $"New comment on {DocumentService.KeyOf(doc.Number)}", snippet, ct: ct);

        await db.SaveChangesAsync(ct);
        return ToDto(c, await NamesAsync([uid], ct), true);
    }

    /// <summary>Marks a thread resolved (or open again). Its author, the document's owner and its editors can.</summary>
    public async Task<DocumentCommentDto> ResolveAsync(Guid documentId, Guid commentId, ResolveCommentRequest req, CancellationToken ct = default)
    {
        var doc = await OpenAsync(documentId, ct);
        var uid = ctx.RequireUserId();
        var c = await db.DocumentComments.FirstOrDefaultAsync(x => x.Id == commentId && x.DocumentId == documentId, ct) ?? throw new NotFoundException("Comment not found.");
        if (c.ParentId is not null) throw new ValidationException("commentId", "Resolve the thread from its first comment.");
        if (c.UserId != uid && doc.OwnerId != uid && !(await rights.RightsAsync(doc, ct)).Edit)
            throw new ForbiddenException("The person who started the thread, the owner or an editor can resolve it.", "PERMISSION_DENIED");
        c.ResolvedAt = req.Resolved ? clock.Now : null;
        c.ResolvedBy = req.Resolved ? uid : null;
        recorder.Audit(req.Resolved ? "document.comment_resolved" : "document.comment_reopened", "Document", documentId, null, new { commentId });
        await db.SaveChangesAsync(ct);
        return ToDto(c, await NamesAsync([c.UserId, uid], ct), true);
    }

    private DocumentCommentDto ToDto(DocumentComment c, Dictionary<Guid, string> names, bool canResolveAny) =>
        new(c.Id, new UserRefDto(c.UserId, names.GetValueOrDefault(c.UserId) ?? "Former member"), c.Body, c.CreatedAt, c.EditedAt, c.UserId == ctx.UserId,
            c.ParentId, c.AnchorId, c.Quote, c.ResolvedAt, c.ResolvedBy is { } rb ? names.GetValueOrDefault(rb) ?? "Former member" : null,
            c.ParentId is null && (canResolveAny || c.UserId == ctx.UserId));

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
