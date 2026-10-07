using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Documents;

public record RequirementDto(Guid Id, string Key, int Number, string Title, string? Detail, Priority Priority, int Implementing, int Verifying);
public record SaveRequirementRequest(string Title, string? Detail = null, Priority? Priority = null);
public record AddRequirementsRequest(IReadOnlyList<string> Titles);
public record CoverageItemDto(Guid LinkId, LinkTarget TargetType, Guid TargetId, bool Restricted, string Key, string Title, string Status, bool Done, bool Failing, string? Assignee);
public record CoverageRowDto(RequirementDto Requirement, string State, IReadOnlyList<CoverageItemDto> Implementing, IReadOnlyList<CoverageItemDto> Verifying);
public record CoverageDto(IReadOnlyList<CoverageRowDto> Rows, int Requirements, int Covered, int WithoutTask, int WithoutTest, int FailingTests, int WorkWithoutTest, int Restricted);

/// <summary>
/// Requirements and what covers them. A document keeps a numbered list of requirements (REQ-1 ...); work is linked to a requirement as "implements" and
/// as "verifies". The coverage report counts, straight from those links, which requirements have no work, which work has no test, and which tests fail
/// (a test issue that is not fixed yet). Work the reader cannot open is counted but never named.
/// </summary>
public class DocumentTraceService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, DocumentAccessService rights, DocumentLinkService links)
{
    public const int MaxRequirements = 500;

    public static string KeyOf(int n) => $"REQ-{n}";

    private async Task<Document> ReadableAsync(Guid id, CancellationToken ct) =>
        await db.Documents.AsNoTracking().FirstOrDefaultAsync(d => d.Id == id, ct) ?? throw new NotFoundException("Document not found.");

    private async Task<Document> EditableAsync(Guid id, CancellationToken ct)
    {
        var doc = await db.Documents.FirstOrDefaultAsync(d => d.Id == id, ct) ?? throw new NotFoundException("Document not found.");
        if (!(await rights.RightsAsync(doc, ct)).Edit) throw new ForbiddenException("You can read this document but not change its requirements.", "PERMISSION_DENIED");
        return doc;
    }

    // ------------------------------------------------------------------ the list

    public async Task<IReadOnlyList<RequirementDto>> ListAsync(Guid documentId, CancellationToken ct = default)
    {
        await ReadableAsync(documentId, ct);
        var rows = await db.DocumentRequirements.AsNoTracking().Where(r => r.DocumentId == documentId).OrderBy(r => r.SortOrder).ThenBy(r => r.Number).ToListAsync(ct);
        var counts = (await db.DocumentLinks.AsNoTracking().Where(l => l.DocumentId == documentId && l.RequirementId != null).Select(l => new { l.RequirementId, l.Relation }).ToListAsync(ct))
            .GroupBy(l => l.RequirementId!.Value).ToDictionary(g => g.Key, g => (Impl: g.Count(x => x.Relation == LinkRelation.Implements), Ver: g.Count(x => x.Relation == LinkRelation.Verifies)));
        return rows.Select(r => Map(r, counts.GetValueOrDefault(r.Id))).ToList();
    }

    private static RequirementDto Map(DocumentRequirement r, (int Impl, int Ver) c) => new(r.Id, KeyOf(r.Number), r.Number, r.Title, r.Detail, r.Priority, c.Impl, c.Ver);

    public async Task<IReadOnlyList<RequirementDto>> AddAsync(Guid documentId, AddRequirementsRequest req, CancellationToken ct = default)
    {
        var doc = await EditableAsync(documentId, ct);
        var titles = (req.Titles ?? []).Select(t => (t ?? "").Trim()).Where(t => t.Length > 0).ToList();
        if (titles.Count == 0) throw new ValidationException("titles", "Write at least one requirement.");
        if (titles.Any(t => t.Length > 300)) throw new ValidationException("titles", "A requirement is at most 300 characters. Put the detail in the document.");
        var have = await db.DocumentRequirements.Where(r => r.DocumentId == documentId).Select(r => new { r.Number, r.SortOrder }).ToListAsync(ct);
        if (have.Count + titles.Count > MaxRequirements) throw new ValidationException("titles", $"A document can have at most {MaxRequirements} requirements.");
        var number = have.Count == 0 ? 0 : have.Max(h => h.Number); var order = have.Count == 0 ? 0 : have.Max(h => h.SortOrder);
        foreach (var t in titles)
            db.DocumentRequirements.Add(new DocumentRequirement { TenantId = doc.TenantId, DocumentId = documentId, Number = ++number, SortOrder = ++order, Title = t, CreatedAt = clock.Now, CreatedBy = ctx.UserId });
        recorder.Activity("document.requirements_added", "Document", doc.Id, $"Added {titles.Count} requirement(s) to {DocumentService.KeyOf(doc.Number)}", doc.ProjectId);
        recorder.Audit("document.requirements_added", "Document", doc.Id, null, new { count = titles.Count, first = KeyOf(number - titles.Count + 1), last = KeyOf(number) });
        await db.SaveChangesAsync(ct);
        return await ListAsync(documentId, ct);
    }

    public async Task<IReadOnlyList<RequirementDto>> UpdateAsync(Guid documentId, Guid requirementId, SaveRequirementRequest req, CancellationToken ct = default)
    {
        var doc = await EditableAsync(documentId, ct);
        var r = await db.DocumentRequirements.FirstOrDefaultAsync(x => x.Id == requirementId && x.DocumentId == documentId, ct) ?? throw new NotFoundException("Requirement not found.");
        var title = (req.Title ?? "").Trim();
        if (title.Length is 0 or > 300) throw new ValidationException("title", "Write the requirement in up to 300 characters.");
        var detail = string.IsNullOrWhiteSpace(req.Detail) ? null : req.Detail.Trim();
        if (detail is { Length: > 2000 }) throw new ValidationException("detail", "Keep the detail under 2000 characters.");
        var before = new { r.Title, r.Detail, r.Priority };
        r.Title = title; r.Detail = detail; if (req.Priority is { } p && Enum.IsDefined(p)) r.Priority = p; r.UpdatedAt = clock.Now;
        recorder.Activity("document.requirement_changed", "Document", doc.Id, $"Changed {KeyOf(r.Number)} of {DocumentService.KeyOf(doc.Number)}", doc.ProjectId);
        recorder.Audit("document.requirement_changed", "Document", doc.Id, before, new { r.Title, r.Detail, r.Priority, key = KeyOf(r.Number) });
        await db.SaveChangesAsync(ct);
        return await ListAsync(documentId, ct);
    }

    public async Task<IReadOnlyList<RequirementDto>> DeleteAsync(Guid documentId, Guid requirementId, CancellationToken ct = default)
    {
        var doc = await EditableAsync(documentId, ct);
        var r = await db.DocumentRequirements.FirstOrDefaultAsync(x => x.Id == requirementId && x.DocumentId == documentId, ct) ?? throw new NotFoundException("Requirement not found.");
        // The links stay, as links of the whole document, so no work is silently unlinked.
        foreach (var l in await db.DocumentLinks.Where(l => l.RequirementId == requirementId).ToListAsync(ct)) l.RequirementId = null;
        db.DocumentRequirements.Remove(r);
        recorder.Activity("document.requirement_removed", "Document", doc.Id, $"Removed {KeyOf(r.Number)} from {DocumentService.KeyOf(doc.Number)}", doc.ProjectId);
        recorder.Audit("document.requirement_removed", "Document", doc.Id, new { r.Title, key = KeyOf(r.Number) });
        await db.SaveChangesAsync(ct);
        return await ListAsync(documentId, ct);
    }

    // ------------------------------------------------------------------ coverage

    public async Task<CoverageDto> CoverageAsync(Guid documentId, CancellationToken ct = default)
    {
        await ReadableAsync(documentId, ct);
        var reqs = await db.DocumentRequirements.AsNoTracking().Where(r => r.DocumentId == documentId).OrderBy(r => r.SortOrder).ThenBy(r => r.Number).ToListAsync(ct);
        var linkRows = await db.DocumentLinks.AsNoTracking().Where(l => l.DocumentId == documentId && l.RequirementId != null && (l.Relation == LinkRelation.Implements || l.Relation == LinkRelation.Verifies)).ToListAsync(ct);
        var today = DateOnly.FromDateTime(clock.Now);
        var resolved = new Dictionary<(LinkTarget, Guid), DocumentLinkService.Resolved>();
        foreach (var g in linkRows.GroupBy(l => l.TargetType))
            foreach (var (id, r) in await links.ResolveAsync(g.Key, g.Select(l => l.TargetId).Distinct().ToList(), today, ct)) resolved[(g.Key, id)] = r;

        CoverageItemDto Item(DocumentLink l)
        {
            if (!resolved.TryGetValue((l.TargetType, l.TargetId), out var r)) return new CoverageItemDto(l.Id, l.TargetType, Guid.Empty, true, "", "", "", false, false, null);
            // A test that is a raised issue is failing until it is fixed.
            var failing = l.Relation == LinkRelation.Verifies && l.TargetType == LinkTarget.Issue && !r.Done;
            return new CoverageItemDto(l.Id, l.TargetType, l.TargetId, false, r.Key, r.Title, r.Status, r.Done, failing, r.Assignee);
        }

        var rows = new List<CoverageRowDto>();
        var untested = new HashSet<(LinkTarget, Guid)>();
        var failingTests = new HashSet<(LinkTarget, Guid)>();
        foreach (var r in reqs)
        {
            var mine = linkRows.Where(l => l.RequirementId == r.Id).ToList();
            var impl = mine.Where(l => l.Relation == LinkRelation.Implements).Select(Item).ToList();
            var ver = mine.Where(l => l.Relation == LinkRelation.Verifies).Select(Item).ToList();
            var failing = ver.Any(v => v.Failing);
            var state = impl.Count == 0 ? "NoTask" : failing ? "Failing" : ver.Count == 0 ? "NoTest" : "Covered";
            if (impl.Count > 0 && ver.Count == 0) foreach (var l in mine.Where(l => l.Relation == LinkRelation.Implements)) untested.Add((l.TargetType, l.TargetId));
            foreach (var l in mine.Where(l => l.Relation == LinkRelation.Verifies && Item(l).Failing)) failingTests.Add((l.TargetType, l.TargetId));
            rows.Add(new CoverageRowDto(Map(r, (impl.Count, ver.Count)), state, impl, ver));
        }
        return new CoverageDto(rows, reqs.Count, rows.Count(r => r.State == "Covered"), rows.Count(r => r.State == "NoTask"), rows.Count(r => r.State == "NoTest"), failingTests.Count, untested.Count,
            rows.Sum(r => r.Implementing.Count(i => i.Restricted) + r.Verifying.Count(i => i.Restricted)));
    }
}
