using System.Text;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Documents;

/// <summary>
/// Full-text search of documents. Each document keeps the lower-case text of what its readers see (<see cref="Document.SearchText"/>), and a search matches
/// every word of the query against title, number, tags and that text. Only the documents the person may open are ever searched: the search is one more
/// condition on the same query that lists documents, so it cannot return a document the list would hide. On PostgreSQL a trigram index makes the
/// substring match fast; elsewhere it is a scan.
/// </summary>
public class DocumentSearchIndexer(IAppDbContext db, AppClock clock)
{
    public const int MaxChars = 200_000, MaxTerms = 6, SweepBatch = 300;

    /// <summary>The text to index: titles of sections and everything written in them, lower-case, capped.</summary>
    public static string BuildText(string docTitle, IEnumerable<string> tags, IEnumerable<(string Title, SectionKind Kind, string Content)> sections)
    {
        var sb = new StringBuilder();
        sb.Append(docTitle).Append('\n').AppendJoin(' ', tags).Append('\n');
        foreach (var (title, kind, content) in sections)
        {
            sb.Append(title).Append('\n');
            if (kind == SectionKind.Table) { var (_, rows) = DocumentDiff.ReadTable(content); foreach (var r in rows) sb.AppendJoin(' ', r).Append('\n'); }
            else foreach (var l in DocumentDiff.TextLines(content)) sb.Append(l.Text).Append('\n');
            if (sb.Length >= MaxChars) break;
        }
        var text = sb.ToString().ToLowerInvariant();
        return text.Length > MaxChars ? text[..MaxChars] : text;
    }

    /// <summary>Brings one document's search text up to date (what readers see now). Does not touch the document's revision or its update time.</summary>
    public async Task IndexAsync(Guid documentId, CancellationToken ct = default)
    {
        var doc = await db.Documents.IgnoreQueryFilters().AsNoTracking().Where(d => d.Id == documentId).Select(d => new { d.Id, d.Title, d.PublishedVersionId, d.DraftVersionId }).FirstOrDefaultAsync(ct);
        if (doc is null) return;
        var vid = doc.PublishedVersionId ?? doc.DraftVersionId;
        var tags = await db.DocumentTags.IgnoreQueryFilters().AsNoTracking().Where(t => t.DocumentId == documentId).Select(t => t.Tag).ToListAsync(ct);
        var text = BuildText(doc.Title, tags, []);
        if (vid is { } v)
        {
            var rows = await db.DocumentSections.IgnoreQueryFilters().AsNoTracking().Where(s => s.VersionId == v).OrderBy(s => s.SortOrder).Select(s => new { s.Title, s.Kind, s.ContentJson }).ToListAsync(ct);
            text = BuildText(doc.Title, tags, rows.Select(r => (r.Title, r.Kind, r.ContentJson)));
        }
        var now = clock.Now;
        await db.Documents.IgnoreQueryFilters().Where(d => d.Id == documentId).ExecuteUpdateAsync(s => s.SetProperty(d => d.SearchText, text).SetProperty(d => d.SearchIndexedAt, now), ct);
    }

    /// <summary>Nightly: documents never indexed, or changed since, are indexed in small batches (also the one-time fill for documents that existed before search).</summary>
    public async Task<int> SweepAsync(CancellationToken ct = default)
    {
        var ids = await db.Documents.IgnoreQueryFilters().AsNoTracking().Where(d => d.SearchIndexedAt == null || d.SearchIndexedAt < d.UpdatedAt).OrderBy(d => d.SearchIndexedAt ?? DateTime.MinValue).ThenBy(d => d.Id).Take(SweepBatch).Select(d => d.Id).ToListAsync(ct);
        foreach (var id in ids) await IndexAsync(id, ct);
        return ids.Count;
    }

    private static string Escape(string term) => term.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_");

    /// <summary>Adds the search condition: every word must appear in the title, number, a tag or the text.</summary>
    public static IQueryable<Document> Match(IQueryable<Document> q, IAppDbContext db, string query)
    {
        var terms = query.Trim().ToLowerInvariant().Split([' ', '\t', '\n'], StringSplitOptions.RemoveEmptyEntries).Distinct().Take(MaxTerms).ToList();
        foreach (var raw in terms)
        {
            var term = raw;
            var num = term.StartsWith("doc-") && int.TryParse(term[4..], out var n) ? n : (int?)null;
            var pattern = "%" + Escape(term) + "%";
            // One indexable condition (title, tags and text are all in SearchText); an OR with scans of other columns would stop the index being used.
            q = num is { } number ? q.Where(d => d.Number == number || EF.Functions.Like(d.SearchText!, pattern, "\\")) : q.Where(d => EF.Functions.Like(d.SearchText!, pattern, "\\"));
        }
        return q;
    }
}

public record DocumentDashboardDto(int Total, IReadOnlyList<DashboardCount> ByStatus, IReadOnlyList<DashboardCount> ByType, int Mine, int WaitingForMe, int UpdatedThisWeek, int NotUpdatedIn90Days, int Unpublished, IReadOnlyList<DocumentItemDto> Recent);
public record DashboardCount(string Key, string Label, int Count);

/// <summary>The numbers on the Documents overview. Every number is a count over the documents the person may open (the same query as the list), so they always agree with it.</summary>
public class DocumentDashboardService(IAppDbContext db, ICurrentContext ctx, AppClock clock, DocumentService documents, DocumentWorkflowService workflows)
{
    public async Task<DocumentDashboardDto> GetAsync(CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var q = db.Documents.AsNoTracking();
        var now = clock.Now; var week = now.AddDays(-7); var stale = now.AddDays(-90);
        var byStatus = await q.GroupBy(d => d.Status).Select(g => new { g.Key, N = g.Count() }).ToListAsync(ct);
        var byType = await q.GroupBy(d => d.TypeId).Select(g => new { g.Key, N = g.Count() }).ToListAsync(ct);
        var typeNames = await db.DocumentTypes.AsNoTracking().ToDictionaryAsync(t => t.Id, t => t.Name, ct);
        var total = byStatus.Sum(x => x.N);
        var (toDecide, _) = await workflows.InboxAsync(ct);
        var recent = await documents.ListAsync(new DocumentFilter(), null, 5, ct);
        return new DocumentDashboardDto(total,
            byStatus.OrderBy(x => x.Key).Select(x => new DashboardCount(x.Key.ToString(), x.Key.ToString(), x.N)).ToList(),
            byType.OrderByDescending(x => x.N).Select(x => new DashboardCount(x.Key.ToString(), typeNames.GetValueOrDefault(x.Key) ?? "Other", x.N)).ToList(),
            await q.CountAsync(d => d.OwnerId == me, ct), toDecide.Count,
            await q.CountAsync(d => d.UpdatedAt >= week, ct), await q.CountAsync(d => d.UpdatedAt < stale, ct),
            await q.CountAsync(d => d.PublishedVersionId == null, ct), recent.Items);
    }
}
