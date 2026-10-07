using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Issues;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Documents;

/// <summary>One thing a document is linked to, as the person asking may see it. A target they cannot open is shown as restricted, with no title.</summary>
public record LinkedItemDto(Guid LinkId, LinkTarget TargetType, Guid TargetId, LinkRelation Relation, bool Restricted, string Key, string Title, string Status,
    bool Done, DateOnly? DueDate, bool Overdue, Guid? ProjectId, string? Assignee);
public record LinkedWorkDto(IReadOnlyList<LinkedItemDto> Items, int Total, int Done, int Overdue, int Open, int Restricted);
public record LinkedDocumentDto(Guid LinkId, LinkRelation Relation, DocumentItemDto Document);
public record LinkedDocumentsDto(IReadOnlyList<LinkedDocumentDto> Items, int Restricted);
public record AddLinkRequest(LinkTarget TargetType, Guid TargetId, LinkRelation Relation = LinkRelation.Describes);

/// <summary>
/// Links in both directions from one table: a document shows the work it is linked to (with live progress), and a task, issue, work item, sprint or
/// project shows its documents. A link never grants access to either side: each side is read through its own visibility filter.
/// </summary>
public class DocumentLinkService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, PermissionService permissions, DocumentService documents)
{
    public const int MaxLinksPerDocument = 500;

    public async Task<LinkedWorkDto> ForDocumentAsync(Guid documentId, CancellationToken ct = default)
    {
        if (!await db.Documents.AnyAsync(d => d.Id == documentId, ct)) throw new NotFoundException("Document not found.");
        var links = await db.DocumentLinks.AsNoTracking().Where(l => l.DocumentId == documentId).OrderBy(l => l.CreatedAt).Take(MaxLinksPerDocument).ToListAsync(ct);
        var today = DateOnly.FromDateTime(clock.Now);
        var resolved = new Dictionary<(LinkTarget, Guid), Resolved>();
        foreach (var g in links.GroupBy(l => l.TargetType))
            foreach (var (id, r) in await ResolveAsync(g.Key, g.Select(l => l.TargetId).Distinct().ToList(), today, ct)) resolved[(g.Key, id)] = r;

        var items = links.Select(l => resolved.TryGetValue((l.TargetType, l.TargetId), out var r)
            ? new LinkedItemDto(l.Id, l.TargetType, l.TargetId, l.Relation, false, r.Key, r.Title, r.Status, r.Done, r.Due, r.Overdue, r.ProjectId, r.Assignee)
            // Not visible to this person: no title, no id of the thing, nothing to learn from it.
            : new LinkedItemDto(l.Id, l.TargetType, Guid.Empty, l.Relation, true, "", "", "", false, null, false, null, null)).ToList();
        var counted = items.Where(i => !i.Restricted && i.TargetType is LinkTarget.Task or LinkTarget.WorkItem or LinkTarget.Issue).ToList();
        return new LinkedWorkDto(items, counted.Count, counted.Count(i => i.Done), counted.Count(i => i.Overdue), counted.Count(i => !i.Done), items.Count(i => i.Restricted));
    }

    public async Task<LinkedDocumentsDto> ForTargetAsync(LinkTarget type, Guid targetId, CancellationToken ct = default)
    {
        // The target must be one this person can open; otherwise it does not exist for them.
        var today = DateOnly.FromDateTime(clock.Now);
        if (!(await ResolveAsync(type, [targetId], today, ct)).ContainsKey(targetId)) throw new NotFoundException("Not found.");
        var links = await db.DocumentLinks.AsNoTracking().Where(l => l.TargetType == type && l.TargetId == targetId).Take(MaxLinksPerDocument).ToListAsync(ct);
        var ids = links.Select(l => l.DocumentId).Distinct().ToList();
        var visible = await db.Documents.AsNoTracking().Where(d => ids.Contains(d.Id)).OrderByDescending(d => d.UpdatedAt).ToListAsync(ct);
        var page = await documents.ListByIdsAsync(visible.Select(d => d.Id).ToList(), ct);
        var byId = page.ToDictionary(d => d.Id);
        var items = links.Where(l => byId.ContainsKey(l.DocumentId)).Select(l => new LinkedDocumentDto(l.Id, l.Relation, byId[l.DocumentId])).ToList();
        return new LinkedDocumentsDto(items, links.Count(l => !byId.ContainsKey(l.DocumentId)));
    }

    public async Task<LinkedWorkDto> AddAsync(Guid documentId, AddLinkRequest req, CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        await permissions.RequireModuleAsync(Modules.Documents, AccessLevel.Edit, ct);
        var doc = await db.Documents.FirstOrDefaultAsync(d => d.Id == documentId, ct) ?? throw new NotFoundException("Document not found.");
        var today = DateOnly.FromDateTime(clock.Now);
        var target = (await ResolveAsync(req.TargetType, [req.TargetId], today, ct)).GetValueOrDefault(req.TargetId) ?? throw new NotFoundException("The item to link was not found.");
        if (await db.DocumentLinks.AnyAsync(l => l.DocumentId == documentId, ct) && await db.DocumentLinks.CountAsync(l => l.DocumentId == documentId, ct) >= MaxLinksPerDocument)
            throw new ValidationException("targetId", $"A document can be linked to at most {MaxLinksPerDocument} items.");
        if (await db.DocumentLinks.AnyAsync(l => l.DocumentId == documentId && l.TargetType == req.TargetType && l.TargetId == req.TargetId && l.Relation == req.Relation, ct))
            throw new ConflictException("This document is already linked to that item.", "LINK_EXISTS");
        db.DocumentLinks.Add(new DocumentLink { TenantId = tid, DocumentId = documentId, TargetType = req.TargetType, TargetId = req.TargetId, Relation = req.Relation, CreatedAt = clock.Now, CreatedBy = ctx.UserId });
        recorder.Activity("document.linked", "Document", doc.Id, $"Linked {DocumentService.KeyOf(doc.Number)} to {target.Key}", doc.ProjectId);
        recorder.Audit("document.linked", "Document", doc.Id, null, new { req.TargetType, req.TargetId, req.Relation });
        await db.SaveChangesAsync(ct);
        return await ForDocumentAsync(documentId, ct);
    }

    public async Task RemoveAsync(Guid documentId, Guid linkId, CancellationToken ct = default)
    {
        await permissions.RequireModuleAsync(Modules.Documents, AccessLevel.Edit, ct);
        var doc = await db.Documents.FirstOrDefaultAsync(d => d.Id == documentId, ct) ?? throw new NotFoundException("Document not found.");
        var link = await db.DocumentLinks.FirstOrDefaultAsync(l => l.Id == linkId && l.DocumentId == documentId, ct) ?? throw new NotFoundException("Link not found.");
        db.DocumentLinks.Remove(link);
        recorder.Activity("document.unlinked", "Document", doc.Id, $"Removed a link from {DocumentService.KeyOf(doc.Number)}", doc.ProjectId);
        recorder.Audit("document.unlinked", "Document", doc.Id, new { link.TargetType, link.TargetId, link.Relation });
        await db.SaveChangesAsync(ct);
    }

    // ------------------------------------------------------------------ resolving targets (through each target's own visibility filter)

    private sealed record Resolved(string Key, string Title, string Status, bool Done, DateOnly? Due, bool Overdue, Guid? ProjectId, string? Assignee);

    private async Task<Dictionary<Guid, Resolved>> ResolveAsync(LinkTarget type, List<Guid> ids, DateOnly today, CancellationToken ct)
    {
        switch (type)
        {
            case LinkTarget.Project:
                return (await db.Projects.AsNoTracking().Where(p => ids.Contains(p.Id)).Select(p => new { p.Id, p.Key, p.Name, p.Status, p.DueDate }).ToListAsync(ct))
                    .ToDictionary(p => p.Id, p =>
                    {
                        var done = p.Status is ProjectStatus.Completed or ProjectStatus.Cancelled or ProjectStatus.Archived;
                        return new Resolved(p.Key, p.Name, p.Status.ToString(), done, p.DueDate, !done && p.DueDate < today, p.Id, null);
                    });
            case LinkTarget.Task:
                return (await db.Tasks.AsNoTracking().Where(t => ids.Contains(t.Id))
                        .Select(t => new { t.Id, Key = t.Project!.Key, t.Number, t.Title, Status = t.Status!.Name, Cat = t.Status.Category, t.DueDate, t.ProjectId, Who = t.Assignee != null ? t.Assignee.DisplayName : null }).ToListAsync(ct))
                    .ToDictionary(t => t.Id, t =>
                    {
                        var done = t.Cat is StatusCategory.Done or StatusCategory.Cancelled;
                        return new Resolved($"{t.Key}-{t.Number}", t.Title, t.Status, done, t.DueDate, !done && t.DueDate < today, t.ProjectId, t.Who);
                    });
            case LinkTarget.WorkItem:
                return (await db.WorkTasks.AsNoTracking().Where(t => ids.Contains(t.Id)).Select(t => new { t.Id, t.Kind, t.Number, t.Title, t.Status, t.DueDate, t.RelatedProjectId }).ToListAsync(ct))
                    .ToDictionary(t => t.Id, t =>
                    {
                        var done = t.Status is WorkTaskStatus.Completed or WorkTaskStatus.Cancelled;
                        return new Resolved($"{(t.Kind == WorkTaskKind.ActionItem ? "AI" : "WT")}-{t.Number}", t.Title, t.Status.ToString(), done, t.DueDate, !done && t.DueDate < today, t.RelatedProjectId, null);
                    });
            case LinkTarget.Issue:
                return (await db.StageIssues.AsNoTracking().Where(i => ids.Contains(i.Id)).Select(i => new { i.Id, i.Number, i.Title, i.Status, i.ProjectId }).ToListAsync(ct))
                    .Join(await db.Projects.AsNoTracking().Where(p => true).Select(p => new { p.Id, p.Key }).ToListAsync(ct), i => i.ProjectId, p => p.Id, (i, p) => new { i, p.Key })
                    .ToDictionary(x => x.i.Id, x =>
                    {
                        var done = x.i.Status is IssueStatus.Fixed or IssueStatus.Resolved;
                        return new Resolved(IssueService.KeyOf(x.Key, x.i.Number), x.i.Title, x.i.Status.ToString(), done, null, false, x.i.ProjectId, null);
                    });
            case LinkTarget.Sprint:
                return (await db.Sprints.AsNoTracking().Where(s => ids.Contains(s.Id)).Select(s => new { s.Id, s.Name, s.Status, s.EndDate, s.ProjectId }).ToListAsync(ct))
                    .ToDictionary(s => s.Id, s => new Resolved("Sprint", s.Name, s.Status.ToString(), s.Status == SprintStatus.Completed, s.EndDate, s.Status != SprintStatus.Completed && s.EndDate < today, s.ProjectId, null));
            default: return [];
        }
    }
}
