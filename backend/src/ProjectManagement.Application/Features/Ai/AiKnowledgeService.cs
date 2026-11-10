using System.Globalization;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Application.Features.WorkItems;
using ProjectManagement.Application.Features.Work;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Ai;

public record AiKnowledgeReference(string Kind, Guid Id, string Key, string Title, string Link, string Version, DateTime EvidenceAt,
    Guid? ProjectId = null, Guid? OwnerId = null, string? Status = null);
/// <summary>One line of the ask bar's "found by meaning" list: a short excerpt and where it opens in the app.</summary>
public record AiMeaningResultDto(string Kind, Guid Id, string Title, string? Key, string Link, string Excerpt, string Via, DateTime? At);
public record AiMeaningSearchDto(IReadOnlyList<AiMeaningResultDto> Items, bool Meaning);

/// <param name="Via">How it was found: "words", "meaning" or "both". Null for a source read directly.</param>
public record AiKnowledgeExcerpt(AiKnowledgeReference Source, string Text, int? NextOffset = null, string? Via = null);
public record AiKnowledgeSearch(string Query, IReadOnlyList<AiKnowledgeExcerpt> Items, bool Truncated, string Methodology);

/// <summary>Authorized relational and indexed document evidence. Source text never grants authority or supplies SQL.</summary>
public class AiKnowledgeService(ICurrentContext ctx, AppClock clock, ProjectAccess access,
    PermissionService permissions, DocumentService documents, WorkItemService workItems, SupportResolutionService resolutions, AiSemanticIndex semantic, AiSemanticSources sources, IAppDbContext db)
{
    private static string Trim(string? value, int limit) => value is null ? "" : value.Length <= limit ? value : value[..limit];

    /// <summary>The most results one search returns, and how many of them may come from meaning alone.</summary>
    public const int MaxResults = 14, MaxByMeaning = 8;
    private const double RrfK = 60;

    /// <summary>One result with where it ranked in the word search and in the meaning search (nothing when it was not in that list).</summary>
    private sealed class Candidate(AiKnowledgeExcerpt item) { public AiKnowledgeExcerpt Item = item; public int? Words; public int? Meaning; public int Order; }

    /// <summary>
    /// Words and meaning together. The word search (projects, work, pages) and the meaning search (pages, work, chat messages, meeting notes,
    /// project mail) each give an ordered list; the two are merged by reciprocal rank, so something both lists like comes first. Every result is
    /// opened with the reader's own access right now: a hit they may not open is left out, whichever list it came from. When there is no
    /// embedding model, or it fails, the result is the word search alone and nobody is told of an error.
    /// </summary>
    public async Task<AiKnowledgeSearch> SearchAsync(string query, CancellationToken ct)
    {
        ctx.RequireTenantId(); ctx.RequireUserId(); query = (query ?? "").Trim();
        if (query.Length is < 1 or > 200) throw new ValidationException("query", "Use search keywords from 1 to 200 characters.");
        var text = query.ToLowerInvariant(); var truncated = false;
        var pool = new Dictionary<Guid, Candidate>();
        void Add(AiKnowledgeExcerpt item, int rank, bool byMeaning)
        {
            if (!pool.TryGetValue(item.Source.Id, out var c)) pool[item.Source.Id] = c = new Candidate(item) { Order = pool.Count };
            if (byMeaning) c.Meaning ??= rank; else c.Words ??= rank;
        }
        if (await permissions.LevelAsync(Modules.Projects, ct) >= AccessLevel.View)
        {
            var projects = await access.VisibleProjects().AsNoTracking().Where(p => p.Key.ToLower().Contains(text) || p.Name.ToLower().Contains(text)
                || p.Description != null && p.Description.ToLower().Contains(text)).OrderBy(p => p.Key).Take(6).ToListAsync(ct);
            truncated |= projects.Count > 5;
            var rank = 0;
            foreach (var p in projects.Take(5))
                Add(new(new("project", p.Id, p.Key, p.Name, $"/projects/{p.Id}", p.Version.ToString(CultureInfo.InvariantCulture), clock.Now, p.Id, p.OwnerId, p.Status.ToString()),
                    $"Status: {p.Status}; due: {p.DueDate?.ToString("yyyy-MM-dd") ?? "not set"}. {Trim(p.Description, 800)}"), rank++, false);
        }
        var work = await workItems.ListAsync(new(Q: query, OpenOnly: false, Limit: 6), WorkItemScope.Caller, ct);
        truncated |= work.Count > 5;
        var workRank = 0;
        foreach (var w in work.Take(5)) Add(new(WorkReference(w), $"{w.Key}: {w.Title}; status: {w.Status}; due: {w.DueDate?.ToString("yyyy-MM-dd") ?? "not set"}."), workRank++, false);
        var docsAllowed = await permissions.LevelAsync(Modules.Documents, ct) >= AccessLevel.View;
        if (docsAllowed)
        {
            var page = await documents.ListAsync(new(Q: query), null, 5, ct); truncated |= page.NextCursor is not null;
            var rank = 0;
            foreach (var item in page.Items)
            {
                // Reuse published/draft visibility and explicit deny grants; the search index never substitutes for authorization.
                var doc = await documents.GetAsync(item.Id, ct);
                Add(new(DocumentReference(doc), Trim(DocumentText(doc), 2000)), rank++, false);
            }
        }

        // By meaning as well as by words: "refund rule" finds "Returns policy", a Hindi or Telugu question finds an English page, and a chat
        // message, meeting minutes or project mail can be found too. Every hit is opened through the services that decide the reader's own
        // access; one they may not see is simply left out. Any failure here leaves the word results exactly as they were.
        var byMeaning = 0; var meaningRank = 0;
        if (semantic.Enabled)
        {
            IReadOnlyList<AiSemanticHit> hits = [];
            try { hits = await semantic.SearchAsync(query, 24, ct); }
            catch (Exception ex) when (ex is not OperationCanceledException) { hits = []; }
            foreach (var hit in hits)
            {
                if (byMeaning >= MaxByMeaning) { truncated = true; break; }
                try
                {
                    var found = await OpenHitAsync(hit, query, docsAllowed, ct);
                    if (found is null) continue;
                    var isNew = !pool.ContainsKey(found.Source.Id);
                    Add(found, meaningRank++, true);
                    if (isNew) byMeaning++;
                }
                catch (AppException) { /* not the reader's to see */ }
            }
        }
        var ranked = pool.Values.Select(c =>
            {
                var score = (c.Words is { } w ? 1 / (RrfK + w) : 0) + (c.Meaning is { } m ? 1 / (RrfK + m) : 0);
                return (Cand: c, Score: score);
            })
            .OrderByDescending(x => x.Score).ThenBy(x => x.Cand.Order).ToList();
        truncated |= ranked.Count > MaxResults;
        var items = ranked.Take(MaxResults).Select(x => x.Cand.Item with { Via = x.Cand.Words is not null && x.Cand.Meaning is not null ? "both" : x.Cand.Meaning is not null ? "meaning" : "words" }).ToList();
        return new(query, items, truncated, byMeaning > 0 || meaningRank > 0
            ? $"authorized-hybrid-v3; words and meaning ranked together ({byMeaning} found by meaning alone); every source opened with the reader's current access; bounded excerpts; related matches, not proof of a claim"
            : "authorized-keyword-v1; relational records and existing document index; bounded excerpts; not semantic similarity or proof of a claim");
    }

    /// <summary>Where a result opens in the app (the app's own routes, not the references' API-side links).</summary>
    public static string AppLink(AiKnowledgeReference r) => r.Kind switch
    {
        "project" => $"/work/projects/{r.Id}",
        "document" => $"/library/docs/{r.Id}",
        "workitem" => $"/work?item={r.Id}",
        _ => r.Link,
    };

    /// <summary>
    /// The ask bar's list: the same hybrid search the assistant's search_knowledge uses, with short excerpts and links. Never fails for want of
    /// the embedding model (it then lists word matches only); a query too short to mean anything lists nothing.
    /// </summary>
    public async Task<AiMeaningSearchDto> FindAsync(string query, CancellationToken ct)
    {
        query = (query ?? "").Trim();
        if (query.Length < 3) return new([], false);
        if (query.Length > 200) query = query[..200];
        var result = await SearchAsync(query, ct);
        var items = result.Items.Select(i => new AiMeaningResultDto(i.Source.Kind, i.Source.Id, i.Source.Title, i.Source.Key, AppLink(i.Source),
            AiSemanticSources.Excerpt(i.Text, query, 220), i.Via ?? "words", i.Source.Kind is "chat" or "mail" or "minutes" or "transcript" ? i.Source.EvidenceAt : null)).ToList();
        return new(items, items.Any(i => i.Via is "meaning" or "both"));
    }

    /// <summary>Opens one meaning hit as the reader; null when it is not theirs to see.</summary>
    private async Task<AiKnowledgeExcerpt?> OpenHitAsync(AiSemanticHit hit, string query, bool docsAllowed, CancellationToken ct)
    {
        if (hit.SourceKind == "document")
        {
            if (!docsAllowed) return null;
            var doc = await documents.GetAsync(hit.SourceId, ct);
            return new(DocumentReference(doc), Trim(DocumentText(doc), 2000));
        }
        if (AiSemanticSources.Handles(hit.SourceKind))
        {
            var opened = await sources.OpenAsync(hit.SourceKind, hit.SourceId, ct);
            if (opened is null) return null;
            return new(new(opened.Kind, opened.Id, opened.Key, opened.Title, opened.Link, opened.Version, clock.Now, opened.ProjectId),
                AiSemanticSources.Excerpt(opened.Text, query, 500));
        }
        var key = hit.SourceKind == "task" ? hit.Title.Split(' ', 2)[0]
            : await db.WorkTasks.AsNoTracking().Where(w => w.Id == hit.SourceId).Select(w => new { w.Kind, w.Number }).FirstOrDefaultAsync(ct) is { } w ? WorkItemService.KeyOf(w.Kind, w.Number) : null;
        if (key is null) return null;
        var match = (await workItems.ListAsync(new(Q: key, OpenOnly: false, Limit: 20), WorkItemScope.Caller, ct)).FirstOrDefault(x => x.Id == hit.SourceId);
        if (match is null) return null;
        return new(WorkReference(match), $"{match.Key}: {match.Title}; status: {match.Status}; due: {match.DueDate?.ToString("yyyy-MM-dd") ?? "not set"}. {Trim(hit.Text, 600)}");
    }

    public async Task<AiKnowledgeExcerpt> ReadAsync(string kind, Guid id, string? key, string? expectedVersion, int offset, CancellationToken ct)
    {
        ctx.RequireTenantId(); ctx.RequireUserId();
        if (offset is < 0 or > 200000) throw new ValidationException("offset", "Use an excerpt offset from 0 to 200000.");
        AiKnowledgeReference source; string text;
        if (kind == "document")
        {
            await permissions.RequireModuleAsync(Modules.Documents, AccessLevel.View, ct);
            var doc = await documents.GetAsync(id, ct); source = DocumentReference(doc); text = DocumentText(doc);
        }
        else if (kind == "project")
        {
            await permissions.RequireModuleAsync(Modules.Projects, AccessLevel.View, ct);
            var p = await access.VisibleProjects().AsNoTracking().FirstOrDefaultAsync(p => p.Id == id, ct) ?? throw new NotFoundException("Source not found.");
            source = new("project", p.Id, p.Key, p.Name, $"/projects/{p.Id}", p.Version.ToString(CultureInfo.InvariantCulture), clock.Now, p.Id, p.OwnerId, p.Status.ToString());
            text = $"{p.Key}: {p.Name}\nStatus: {p.Status}\nStart: {p.StartDate?.ToString("yyyy-MM-dd") ?? "not set"}\nDue: {p.DueDate?.ToString("yyyy-MM-dd") ?? "not set"}\n{Trim(p.Description, 16000)}";
        }
        else if (kind == "workitem")
        {
            if (string.IsNullOrWhiteSpace(key) || key.Length > 200) throw new ValidationException("key", "Supply the work key returned by search_knowledge.");
            var matches = await workItems.ListAsync(new(Q: key, OpenOnly: false, Limit: 100), WorkItemScope.Caller, ct);
            var item = matches.FirstOrDefault(w => w.Id == id && w.Key == key) ?? throw new NotFoundException("Source not found.");
            source = WorkReference(item); text = $"{item.Key}: {item.Title}\nStatus: {item.Status}\nDue: {item.DueDate?.ToString("yyyy-MM-dd") ?? "not set"}\nAssignee: {item.Assignee?.Name ?? "unassigned"}\nProject: {item.ProjectName ?? "not linked"}";
            if (item.Kind == WorkItemKind.Operational)
            {
                var resolution = await resolutions.GetAsync(id, ct);
                if (resolution.Current && resolution.AcceptedAt != null)
                {
                    text += $"\nReporter-acknowledged resolution ({resolution.AcceptedAt:O}):\n{resolution.Note}";
                }
            }
        }
        else if (kind is "chat" or "minutes" or "transcript" or "mail")
        {
            // Opened through the rule that decides who may read it anywhere else; the same answer whether it exists or not.
            var opened = await sources.OpenAsync(kind, id, ct) ?? throw new NotFoundException("Source not found.");
            source = new(opened.Kind, opened.Id, opened.Key, opened.Title, opened.Link, opened.Version, clock.Now, opened.ProjectId); text = opened.Text;
        }
        else throw new ValidationException("kind", "Choose project, document, workitem, chat, minutes, transcript or mail.");
        if (expectedVersion is { Length: > 128 }) throw new ValidationException("expectedVersion", "Use the version returned by search_knowledge.");
        if (!string.IsNullOrWhiteSpace(expectedVersion) && source.Version != expectedVersion)
            throw new ConflictException("This evidence changed. Retrieve the current source before continuing.", "AI_SOURCE_CHANGED");
        var chunk = offset >= text.Length ? "" : text.Substring(offset, Math.Min(4000, text.Length - offset));
        return new(source, chunk, offset + chunk.Length < text.Length ? offset + chunk.Length : null);
    }

    public AiKnowledgeReference DocumentReference(DocumentDto doc) => new("document", doc.Item.Id, doc.Item.Key, doc.Item.Title,
        $"/documents/{doc.Item.Id}", $"{doc.Revision}:{doc.VersionLabel}:{(doc.ViewingPublished ? "published" : "draft")}", clock.Now,
        doc.Item.ProjectId, doc.Item.Owner.Id, doc.Item.Status.ToString());

    public static string DocumentText(DocumentDto doc) => string.Join("\n", doc.Sections.Select(s => s.Title + "\n" + (s.Kind == SectionKind.Table
        ? string.Join("\n", DocumentDiff.ReadTable(s.Content).Item2.Select(row => string.Join(" | ", row)))
        : string.Join("\n", DocumentDiff.TextLines(s.Content).Select(line => line.Text)))));

    private AiKnowledgeReference WorkReference(WorkItemDto work)
    {
        var link = work.Kind switch
        {
            WorkItemKind.Task => $"/projects/{work.ProjectId}?task={work.Id}",
            WorkItemKind.Issue => $"/projects/{work.ProjectId}?tab=issues&issue={work.Id}",
            WorkItemKind.ActionItem => $"/projects/{work.ProjectId}?tab=actions&action={work.Id}",
            _ => $"/operations?task={work.Id}"
        };
        return new("workitem", work.Id, work.Key, work.Title, link, work.UpdatedAt.Ticks.ToString(CultureInfo.InvariantCulture), clock.Now,
            work.ProjectId, null, work.Status);
    }
}
