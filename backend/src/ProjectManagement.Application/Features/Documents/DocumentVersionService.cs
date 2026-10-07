using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Documents;

public record VersionDto(Guid Id, string Label, int Major, int Minor, bool IsDraft, bool IsCurrent, string? ChangeSummary, string? ChangeReason, DateTime? PublishedAt,
    UserRefDto? PublishedBy, string? RestoredFrom, string ContentHash, bool HasChanges);
public record VersionListDto(IReadOnlyList<VersionDto> Items, string? PublishedLabel, bool HasUnpublishedChanges, string NextLabelMinor, string NextLabelMajor);
public record VersionContentDto(VersionDto Version, IReadOnlyList<SectionDto> Sections);
public record PublishRequest(string ChangeSummary, string? ChangeReason, bool Major, int Revision);
public record RestoreRequest(string? Reason, bool DiscardChanges, int Revision);

/// <summary>
/// The history of a document. Publishing freezes the draft as the next version (1.0, then 1.1, or 2.0 for a major change) and starts a fresh draft from it;
/// nothing that was published is ever changed. Restoring an old version publishes a new version with its content, so the history shows both.
/// </summary>
public class DocumentVersionService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, DocumentAccessService rights, DocumentWorkflowService workflows, ProjectManagement.Application.Features.ApiDocs.ApiTransferService apiData, ProjectManagement.Application.Features.ApiDocs.ApiDocService apiDocs)
{
    public static string Label(int major, int minor) => $"{major}.{minor}";

    private async Task<Document> VisibleAsync(Guid id, CancellationToken ct, bool tracked = false) =>
        await (tracked ? db.Documents : db.Documents.AsNoTracking()).FirstOrDefaultAsync(d => d.Id == id, ct) ?? throw new NotFoundException("Document not found.");

    private async Task<Document> EditableAsync(Guid id, CancellationToken ct)
    {
        var doc = await VisibleAsync(id, ct, tracked: true);
        var r = await rights.RightsAsync(doc, ct);
        if (!r.Edit) throw new ForbiddenException(doc.Status == DocumentStatus.Archived ? "An archived document cannot be changed. Reopen it first." : "You can read this document but not change it.", "PERMISSION_DENIED");
        return doc;
    }

    // ------------------------------------------------------------------ reading

    public async Task<VersionListDto> ListAsync(Guid documentId, CancellationToken ct = default)
    {
        var doc = await VisibleAsync(documentId, ct);
        var canSeeDraft = (await rights.RightsAsync(doc, ct)).Edit || doc.PublishedVersionId is null;
        var rows = await db.DocumentVersions.AsNoTracking().Where(v => v.DocumentId == documentId && (!v.IsDraft || canSeeDraft)).ToListAsync(ct);
        var ids = rows.Where(r => r.PublishedBy != null).Select(r => r.PublishedBy!.Value).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => ids.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        var published = rows.Where(r => !r.IsDraft).OrderByDescending(r => r.Major).ThenByDescending(r => r.Minor).ToList();
        var latest = published.FirstOrDefault();
        var byId = rows.ToDictionary(r => r.Id);
        VersionDto Map(DocumentVersion v) => new(v.Id, v.IsDraft ? (latest is null ? "Draft" : $"Draft after {Label(latest.Major, latest.Minor)}") : Label(v.Major, v.Minor), v.Major, v.Minor, v.IsDraft, v.Id == doc.PublishedVersionId,
            v.ChangeSummary, v.ChangeReason, v.PublishedAt, v.PublishedBy is { } p ? new UserRefDto(p, names.GetValueOrDefault(p) ?? "Former member") : null,
            v.RestoredFromId is { } rf && byId.TryGetValue(rf, out var from) ? Label(from.Major, from.Minor) : null, v.ContentHash, v.IsDraft && latest is not null && v.ContentHash != latest.ContentHash || v.IsDraft && latest is null);
        var items = rows.Where(r => r.IsDraft).Select(Map).Concat(published.Select(Map)).ToList();
        var next = latest is null ? ("1.0", "1.0") : (Label(latest.Major, latest.Minor + 1), Label(latest.Major + 1, 0));
        var draft = rows.FirstOrDefault(r => r.IsDraft);
        var unpublished = canSeeDraft && draft is not null && (latest is null || draft.ContentHash != latest.ContentHash);
        return new VersionListDto(items, latest is null ? null : Label(latest.Major, latest.Minor), unpublished, next.Item1, next.Item2);
    }

    public async Task<VersionContentDto> GetAsync(Guid documentId, Guid versionId, CancellationToken ct = default)
    {
        var list = await ListAsync(documentId, ct);
        var v = list.Items.FirstOrDefault(x => x.Id == versionId) ?? throw new NotFoundException("Version not found.");
        var sections = await db.DocumentSections.AsNoTracking().Where(s => s.VersionId == versionId).OrderBy(s => s.SortOrder).ToListAsync(ct);
        return new VersionContentDto(v, sections.Select(s => new SectionDto(s.Key, s.Title, s.Kind, s.SortOrder, s.ContentJson)).ToList());
    }

    public async Task<VersionDiff> CompareAsync(Guid documentId, Guid fromId, Guid toId, CancellationToken ct = default)
    {
        var list = await ListAsync(documentId, ct);
        var from = list.Items.FirstOrDefault(x => x.Id == fromId) ?? throw new NotFoundException("Version not found.");
        var to = list.Items.FirstOrDefault(x => x.Id == toId) ?? throw new NotFoundException("Version not found.");
        async Task<List<DocumentDiff.Snapshot>> Load(Guid v) => (await db.DocumentSections.AsNoTracking().Where(s => s.VersionId == v).OrderBy(s => s.SortOrder).ToListAsync(ct))
            .Select(s => new DocumentDiff.Snapshot(s.Key, s.Title, s.Kind, s.SortOrder, s.ContentJson)).ToList();
        return DocumentDiff.Compare(new VersionRef(from.Id, from.Label, from.IsDraft, from.PublishedAt), await Load(fromId), new VersionRef(to.Id, to.Label, to.IsDraft, to.PublishedAt), await Load(toId));
    }

    // ------------------------------------------------------------------ publishing

    public async Task<VersionListDto> PublishAsync(Guid documentId, PublishRequest req, CancellationToken ct = default)
    {
        var doc = await EditableAsync(documentId, ct);
        if (doc.Revision != req.Revision) throw new ConflictException("Someone else changed this document while you were editing. Reload it to see their changes.", "DOCUMENT_CHANGED");
        // With an approval workflow a document is published only from Approved, with the summary it was submitted with.
        var approval = await workflows.RequireApprovedAsync(doc, (await db.DocumentVersions.AsNoTracking().FirstAsync(v => v.Id == doc.DraftVersionId, ct)).ContentHash, ct);
        if (approval is not null) req = new PublishRequest(approval.Summary, approval.Reason, approval.Major, req.Revision);
        if (DocumentStateMachine.Next(doc.Status, DocAction.Publish, doc.PublishedVersionId is not null, approval is not null) is not { } after)
            throw new ConflictException("This document cannot be published from its current status.", "ILLEGAL_TRANSITION");
        var summary = (req.ChangeSummary ?? "").Trim();
        if (summary.Length == 0) throw new ValidationException("changeSummary", "Say in a sentence what changed.");
        if (summary.Length > 500) throw new ValidationException("changeSummary", "Keep the summary under 500 characters.");
        var reason = string.IsNullOrWhiteSpace(req.ChangeReason) ? null : req.ChangeReason.Trim();
        if (reason is { Length: > 500 }) throw new ValidationException("changeReason", "Keep the reason under 500 characters.");

        var draft = await db.DocumentVersions.FirstAsync(v => v.Id == doc.DraftVersionId, ct);
        var latest = await LatestPublishedAsync(documentId, ct);
        if (latest is not null && latest.ContentHash == draft.ContentHash) throw new ConflictException("There is nothing new to publish: the draft is the same as the last published version.", "NOTHING_TO_PUBLISH");
        var (major, minor) = latest is null ? (1, 0) : req.Major ? (latest.Major + 1, 0) : (latest.Major, latest.Minor + 1);

        var sections = await db.DocumentSections.Where(s => s.VersionId == draft.Id).OrderBy(s => s.SortOrder).ToListAsync(ct);
        var now = clock.Now;
        // The draft row becomes the published version (its sections stay as they are); a fresh draft is started from the same content.
        var frozen = draft;
        frozen.Major = major; frozen.Minor = minor; frozen.IsDraft = false; frozen.ChangeSummary = summary; frozen.ChangeReason = reason; frozen.PublishedAt = now; frozen.PublishedBy = ctx.UserId; frozen.UpdatedAt = now;
        var next = StartDraft(doc, frozen, sections, now);
        await apiData.SnapshotAsync(doc, frozen.Id, ct);   // the API as published, kept with the version
        doc.PublishedVersionId = frozen.Id; doc.DraftVersionId = next.Id; doc.Status = after; Touch(doc);
        recorder.Activity("document.published", "Document", doc.Id, $"Published {DocumentService.KeyOf(doc.Number)} version {Label(major, minor)}", doc.ProjectId, newValue: summary);
        recorder.Audit("document.published", "Document", doc.Id, latest is null ? null : new { version = Label(latest.Major, latest.Minor) }, new { version = Label(major, minor), summary, reason, hash = frozen.ContentHash });
        await workflows.OnPublishedAsync(doc, approval, Label(major, minor), summary, ct);
        await SaveAsync(ct);
        return await ListAsync(documentId, ct);
    }

    public async Task<VersionListDto> RestoreAsync(Guid documentId, Guid versionId, RestoreRequest req, CancellationToken ct = default)
    {
        var doc = await EditableAsync(documentId, ct);
        if (doc.Revision != req.Revision) throw new ConflictException("Someone else changed this document while you were editing. Reload it to see their changes.", "DOCUMENT_CHANGED");
        var old = await db.DocumentVersions.FirstOrDefaultAsync(v => v.Id == versionId && v.DocumentId == documentId && !v.IsDraft, ct) ?? throw new NotFoundException("Only a published version can be restored.");
        var draft = await db.DocumentVersions.FirstAsync(v => v.Id == doc.DraftVersionId, ct);
        var latest = (await LatestPublishedAsync(documentId, ct))!;
        if (draft.ContentHash != latest.ContentHash && !req.DiscardChanges)
            throw new ConflictException("The draft has changes that are not published. Restoring replaces them.", "DRAFT_HAS_CHANGES");

        var (major, minor) = (latest.Major, latest.Minor + 1);
        var source = await db.DocumentSections.AsNoTracking().Where(s => s.VersionId == old.Id).OrderBy(s => s.SortOrder).ToListAsync(ct);
        var now = clock.Now;
        if (await workflows.AppliesAsync(doc, ct))
        {
            // With an approval workflow nothing becomes a published version without a review: the old words are loaded into the draft, to be submitted.
            await workflows.OnContentChangedAsync(doc, ct);
            db.DocumentSections.RemoveRange(await db.DocumentSections.Where(s => s.VersionId == draft.Id).ToListAsync(ct));
            foreach (var s in source) db.DocumentSections.Add(Copy(s, draft.Id, now));
            draft.ContentHash = old.ContentHash; draft.UpdatedAt = now;
            await apiData.RestoreAsync(doc, old.Id, ct);
            Touch(doc);
            recorder.Activity("document.version_loaded", "Document", doc.Id, $"Loaded version {Label(old.Major, old.Minor)} of {DocumentService.KeyOf(doc.Number)} into the draft", doc.ProjectId);
            recorder.Audit("document.version_loaded", "Document", doc.Id, new { replaced = Label(latest.Major, latest.Minor) }, new { loaded = Label(old.Major, old.Minor), reason = req.Reason });
            await SaveAsync(ct);
            await apiDocs.AfterChangeAsync(doc, ct);
            return await ListAsync(documentId, ct);
        }
        var restored = new DocumentVersion
        {
            TenantId = doc.TenantId, DocumentId = doc.Id, Major = major, Minor = minor, IsDraft = false, PublishedAt = now, PublishedBy = ctx.UserId, RestoredFromId = old.Id,
            ChangeSummary = $"Restored version {Label(old.Major, old.Minor)}", ChangeReason = string.IsNullOrWhiteSpace(req.Reason) ? null : req.Reason.Trim(), CreatedAt = now, CreatedBy = ctx.UserId, ContentHash = old.ContentHash,
        };
        db.DocumentVersions.Add(restored);
        foreach (var s in source) db.DocumentSections.Add(Copy(s, restored.Id, now));

        // The working draft takes the restored content, so editing carries on from it.
        db.DocumentSections.RemoveRange(await db.DocumentSections.Where(s => s.VersionId == draft.Id).ToListAsync(ct));
        foreach (var s in source) db.DocumentSections.Add(Copy(s, draft.Id, now));
        draft.ContentHash = old.ContentHash; draft.Major = major; draft.Minor = minor; draft.UpdatedAt = now;
        await apiData.RestoreAsync(doc, old.Id, ct);
        await apiData.SnapshotAfterRestoreAsync(doc, restored.Id, old.Id, ct);
        doc.PublishedVersionId = restored.Id; doc.Status = DocumentStatus.Published; Touch(doc);
        recorder.Activity("document.restored_version", "Document", doc.Id, $"Restored {DocumentService.KeyOf(doc.Number)} to version {Label(old.Major, old.Minor)} as {Label(major, minor)}", doc.ProjectId);
        recorder.Audit("document.version_restored", "Document", doc.Id, new { replaced = Label(latest.Major, latest.Minor) }, new { restored = Label(old.Major, old.Minor), now = Label(major, minor) });
        await SaveAsync(ct);
        await apiDocs.AfterChangeAsync(doc, ct);
        return await ListAsync(documentId, ct);
    }

    // ------------------------------------------------------------------ helpers

    private async Task<DocumentVersion?> LatestPublishedAsync(Guid documentId, CancellationToken ct) =>
        await db.DocumentVersions.AsNoTracking().Where(v => v.DocumentId == documentId && !v.IsDraft).OrderByDescending(v => v.Major).ThenByDescending(v => v.Minor).FirstOrDefaultAsync(ct);

    private DocumentVersion StartDraft(Document doc, DocumentVersion basis, IEnumerable<DocumentSection> sections, DateTime now)
    {
        var next = new DocumentVersion { TenantId = doc.TenantId, DocumentId = doc.Id, Major = basis.Major, Minor = basis.Minor, IsDraft = true, ContentHash = basis.ContentHash, CreatedAt = now, CreatedBy = ctx.UserId };
        db.DocumentVersions.Add(next);
        foreach (var s in sections) db.DocumentSections.Add(Copy(s, next.Id, now));
        return next;
    }

    private static DocumentSection Copy(DocumentSection s, Guid versionId, DateTime now) =>
        new() { TenantId = s.TenantId, VersionId = versionId, Key = s.Key, Title = s.Title, Kind = s.Kind, SortOrder = s.SortOrder, ContentJson = s.ContentJson, CreatedAt = now };

    private void Touch(Document doc) { doc.Revision++; doc.UpdatedAt = clock.Now; doc.UpdatedBy = ctx.UserId; }

    private async Task SaveAsync(CancellationToken ct)
    {
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateConcurrencyException) { throw new ConflictException("Someone else changed this document while you were editing. Reload it to see their changes.", "DOCUMENT_CHANGED"); }
    }
}
