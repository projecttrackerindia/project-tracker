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
public record AiKnowledgeExcerpt(AiKnowledgeReference Source, string Text, int? NextOffset = null);
public record AiKnowledgeSearch(string Query, IReadOnlyList<AiKnowledgeExcerpt> Items, bool Truncated, string Methodology);

/// <summary>Authorized relational and indexed document evidence. Source text never grants authority or supplies SQL.</summary>
public class AiKnowledgeService(ICurrentContext ctx, AppClock clock, ProjectAccess access,
    PermissionService permissions, DocumentService documents, WorkItemService workItems, SupportResolutionService resolutions)
{
    private static string Trim(string? value, int limit) => value is null ? "" : value.Length <= limit ? value : value[..limit];

    public async Task<AiKnowledgeSearch> SearchAsync(string query, CancellationToken ct)
    {
        ctx.RequireTenantId(); ctx.RequireUserId(); query = (query ?? "").Trim();
        if (query.Length is < 1 or > 200) throw new ValidationException("query", "Use search keywords from 1 to 200 characters.");
        var text = query.ToLowerInvariant(); var items = new List<AiKnowledgeExcerpt>(); var truncated = false;
        if (await permissions.LevelAsync(Modules.Projects, ct) >= AccessLevel.View)
        {
            var projects = await access.VisibleProjects().AsNoTracking().Where(p => p.Key.ToLower().Contains(text) || p.Name.ToLower().Contains(text)
                || p.Description != null && p.Description.ToLower().Contains(text)).OrderBy(p => p.Key).Take(6).ToListAsync(ct);
            truncated |= projects.Count > 5;
            items.AddRange(projects.Take(5).Select(p => new AiKnowledgeExcerpt(new("project", p.Id, p.Key, p.Name, $"/projects/{p.Id}",
                p.Version.ToString(CultureInfo.InvariantCulture), clock.Now, p.Id, p.OwnerId, p.Status.ToString()),
                $"Status: {p.Status}; due: {p.DueDate?.ToString("yyyy-MM-dd") ?? "not set"}. {Trim(p.Description, 800)}")));
        }
        var work = await workItems.ListAsync(new(Q: query, OpenOnly: false, Limit: 6), WorkItemScope.Caller, ct);
        truncated |= work.Count > 5;
        items.AddRange(work.Take(5).Select(w => new AiKnowledgeExcerpt(WorkReference(w), $"{w.Key}: {w.Title}; status: {w.Status}; due: {w.DueDate?.ToString("yyyy-MM-dd") ?? "not set"}.")));
        if (await permissions.LevelAsync(Modules.Documents, ct) >= AccessLevel.View)
        {
            var page = await documents.ListAsync(new(Q: query), null, 5, ct); truncated |= page.NextCursor is not null;
            foreach (var item in page.Items)
            {
                // Reuse published/draft visibility and explicit deny grants; the search index never substitutes for authorization.
                var doc = await documents.GetAsync(item.Id, ct);
                items.Add(new(DocumentReference(doc), Trim(DocumentText(doc), 2000)));
            }
        }
        return new(query, items, truncated, "authorized-keyword-v1; relational records and existing document index; bounded excerpts; not semantic similarity or proof of a claim");
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
        else throw new ValidationException("kind", "Choose project, document or workitem.");
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
