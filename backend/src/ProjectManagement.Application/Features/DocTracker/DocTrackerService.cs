using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.ApiDocs;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.DocTracker;

public record DtEndpoint(Guid Id, Guid DocumentId, Guid DefinitionId, string Definition, string Method, string Path, string Summary, string? Tag, bool Deprecated,
    int Score, IReadOnlyList<string> Gaps, string Stage, DateTime? UpdatedAt);
public record DtDefinition(Guid Id, Guid DocumentId, string Name, string? Version, string Stage, string Auth, IReadOnlyList<string> Servers);
public record DtDocument(Guid Id, string Key, string Title, string TypeCode, string TypeName, string TypeColor, DocumentStatus Status, DocumentClassification Classification, DateTime UpdatedAt, bool IsApi);
public record DtProject(Guid? Id, string? Key, string Name, IReadOnlyList<DtEndpoint> Endpoints, IReadOnlyList<DtDefinition> Definitions, IReadOnlyList<DtDocument> Documents, int Diagrams);
public record DtCatalog(IReadOnlyList<DtProject> Projects, bool CanCreate, bool IsAdmin, int Truncated);
public record DtDiagram(string Key, string Title, string Kind, JsonNode Data);
public record DtArchitecture(Guid? ProjectId, IReadOnlyList<DtDiagram> Diagrams, string? Notes, bool CanEdit, DateTime? UpdatedAt, string? UpdatedBy);
public record SaveArchitectureRequest(IReadOnlyList<DtDiagram>? Diagrams, string? Notes);
public record DtApiHome(Guid DocumentId, Guid DefinitionId);

/// <summary>
/// DocTracker: the documentation workspace organised like DocTracker - every project with its APIs (endpoints grouped by tag, with a
/// documentation score), its other documents, and its architecture and request-flow diagrams. It reads through the existing document and
/// API services, so who may see what (document visibility, grants, published versus draft) is exactly the same as everywhere else.
/// </summary>
public class DocTrackerService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, PermissionService permissions, DocumentService documents,
    ApiDocService api)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    public const int MaxEndpoints = 3000;

    private bool IsAdmin => ctx.Role is TenantRole.Owner or TenantRole.Admin;

    public async Task<DtCatalog> CatalogAsync(CancellationToken ct)
    {
        ctx.RequireTenantId();
        // Projects the person can see (the projects filter), plus "General" for documents outside any project.
        var projects = await db.Projects.AsNoTracking().OrderBy(p => p.Name).Select(p => new { p.Id, p.Key, p.Name }).Take(500).ToListAsync(ct);
        // Documents they may open (the documents filter enforces visibility and grants).
        var docs = await (from d in db.Documents.AsNoTracking()
                          join t in db.DocumentTypes.AsNoTracking() on d.TypeId equals t.Id
                          where d.Status != DocumentStatus.Archived
                          select new { d.Id, d.Number, d.Title, d.ProjectId, d.Status, d.Classification, Updated = d.UpdatedAt ?? d.CreatedAt, t.Code, t.Name, t.Color }).Take(5000).ToListAsync(ct);
        var docIds = docs.Select(d => d.Id).ToList();
        var defs = await db.ApiDefinitions.AsNoTracking().Where(x => docIds.Contains(x.DocumentId)).OrderBy(x => x.SortOrder).ToListAsync(ct);
        var apiDocIds = defs.Select(x => x.DocumentId).Distinct().ToList();

        // Endpoints as each person reads them (drafts for editors, the published version otherwise), through the API service.
        var endpoints = new List<(Guid Doc, EndpointItemDto Item)>();
        var truncated = 0;
        foreach (var docId in apiDocIds)
        {
            string? cursor = null;
            do
            {
                EndpointPageDto page;
                try { page = await api.ListAsync(docId, new EndpointFilter(null, null, null, null, null), cursor, ApiDocService.MaxPageSize, ct); }
                catch (AppException) { break; }
                foreach (var i in page.Items) { if (endpoints.Count >= MaxEndpoints) { truncated++; continue; } endpoints.Add((docId, i)); }
                cursor = page.NextCursor;
            } while (cursor is not null && endpoints.Count < MaxEndpoints);
        }
        var epIds = endpoints.Select(e => e.Item.Id).ToList();
        var details = await db.ApiEndpoints.AsNoTracking().Where(e => epIds.Contains(e.Id)).Select(e => new { e.Id, e.DetailsJson, Updated = e.UpdatedAt ?? e.CreatedAt }).ToDictionaryAsync(e => e.Id, ct);
        var defById = defs.ToDictionary(d => d.Id);

        DtEndpoint ToEp((Guid Doc, EndpointItemDto Item) e)
        {
            var def = defById.GetValueOrDefault(e.Item.DefinitionId);
            var d = details.GetValueOrDefault(e.Item.Id);
            var (score, gaps) = Score(e.Item, d is null ? new EndpointDetails() : ApiJson.Read(d.DetailsJson), def?.Auth ?? ApiAuthScheme.None);
            return new DtEndpoint(e.Item.Id, e.Doc, e.Item.DefinitionId, e.Item.Definition, e.Item.Method, e.Item.Path, e.Item.Summary, e.Item.Tag, e.Item.Deprecated, score, gaps,
                (def?.Stage ?? ApiStage.Draft).ToString(), d?.Updated);
        }

        var diagramCounts = await db.ProjectArchitectures.AsNoTracking().Select(a => new { a.ProjectId, a.DiagramsJson }).ToListAsync(ct);
        int Diagrams(Guid pid) => diagramCounts.FirstOrDefault(a => a.ProjectId == pid) is { } a ? (JsonNode.Parse(a.DiagramsJson) as JsonArray)?.Count ?? 0 : 0;

        DtProject Build(Guid? pid, string? key, string name)
        {
            var mine = docs.Where(d => d.ProjectId == pid).ToList();
            var mineIds = mine.Select(d => d.Id).ToHashSet();
            return new DtProject(pid, key, name,
                endpoints.Where(e => mineIds.Contains(e.Doc)).Select(ToEp).OrderBy(e => e.Tag ?? "~").ThenBy(e => e.Path).ToList(),
                defs.Where(x => mineIds.Contains(x.DocumentId)).Select(x => new DtDefinition(x.Id, x.DocumentId, x.Name, x.Version, x.Stage.ToString(), x.Auth.ToString(), ApiJson.ReadServers(x.ServersJson))).ToList(),
                mine.OrderByDescending(d => d.Updated).Select(d => new DtDocument(d.Id, DocumentService.KeyOf(d.Number), d.Title, d.Code, d.Name, d.Color, d.Status, d.Classification, d.Updated, apiDocIds.Contains(d.Id))).ToList(),
                Diagrams(pid ?? Guid.Empty));
        }
        var list = projects.Select(p => Build(p.Id, p.Key, p.Name)).ToList();
        list.Add(Build(null, null, "General"));
        return new DtCatalog(list, await permissions.HasAsync(Permissions.DocsCreate, ct), IsAdmin, truncated);
    }

    /// <summary>How well an endpoint is documented (0-100) and what is missing, the way DocTracker scores it.</summary>
    public static (int Score, IReadOnlyList<string> Gaps) Score(EndpointItemDto item, EndpointDetails d, ApiAuthScheme apiAuth)
    {
        var gaps = new List<string>(); var score = 0;
        if (!string.IsNullOrWhiteSpace(item.Summary)) score += 15; else gaps.Add("No summary");
        if (!string.IsNullOrWhiteSpace(d.Description)) score += 15; else gaps.Add("No description");
        var auth = d.Auth == "inherit" ? apiAuth.ToString() : d.Auth;
        if (!string.Equals(auth, "None", StringComparison.OrdinalIgnoreCase)) score += 15; else gaps.Add("No authentication");
        if (d.Parameters.All(p => !string.IsNullOrWhiteSpace(p.Description))) score += 15; else gaps.Add("Parameters without a description");
        var needsBody = item.Method is "POST" or "PUT" or "PATCH";
        if (!needsBody || !string.IsNullOrWhiteSpace(d.RequestBody?.Example)) score += 15; else gaps.Add("No request example");
        if (d.Responses.Any(r => r.Status.StartsWith('2') && !string.IsNullOrWhiteSpace(r.Example))) score += 15; else gaps.Add("No success response example");
        if (d.Errors.Count > 0 || d.Responses.Any(r => r.Status.StartsWith('4') || r.Status.StartsWith('5'))) score += 10; else gaps.Add("No error cases");
        return (score, gaps);
    }

    // ------------------------------------------------------------------ architecture

    private async Task<bool> CanEditArchitectureAsync(CancellationToken ct) => IsAdmin || await permissions.HasAsync(Permissions.DocsEdit, ct) || await permissions.HasAsync(Permissions.DocsCreate, ct);

    private async Task RequireProjectAsync(Guid? projectId, CancellationToken ct)
    {
        if (projectId is { } pid && !await db.Projects.AnyAsync(p => p.Id == pid, ct)) throw new NotFoundException("Project not found.");
    }

    public async Task<DtArchitecture> ArchitectureAsync(Guid? projectId, CancellationToken ct)
    {
        await RequireProjectAsync(projectId, ct);
        var key = projectId ?? Guid.Empty;
        var row = await db.ProjectArchitectures.AsNoTracking().FirstOrDefaultAsync(a => a.ProjectId == key, ct);
        var diagrams = row is null ? [] : (JsonSerializer.Deserialize<List<DtDiagram>>(row.DiagramsJson, Json) ?? []);
        var by = row?.UpdatedBy ?? row?.CreatedBy;
        var name = by is { } u ? await db.Users.AsNoTracking().Where(x => x.Id == u).Select(x => x.DisplayName).FirstOrDefaultAsync(ct) : null;
        return new DtArchitecture(projectId, diagrams, row?.Notes, await CanEditArchitectureAsync(ct), row?.UpdatedAt ?? row?.CreatedAt, name);
    }

    private static readonly Regex DiagramKey = new("^[a-z0-9\\-]{1,40}$", RegexOptions.Compiled);

    public async Task<DtArchitecture> SaveArchitectureAsync(Guid? projectId, SaveArchitectureRequest req, CancellationToken ct)
    {
        await RequireProjectAsync(projectId, ct);
        if (!await CanEditArchitectureAsync(ct)) throw new ForbiddenException("You can't change this project's architecture.", "PERMISSION_DENIED");
        var diagrams = new List<DtDiagram>(); var keys = new HashSet<string>();
        foreach (var d in (req.Diagrams ?? []).Take(12))
        {
            var key = (d.Key ?? "").Trim().ToLowerInvariant();
            if (!DiagramKey.IsMatch(key) || !keys.Add(key)) throw new ValidationException("diagrams", "Each diagram needs its own short key.");
            var title = (d.Title ?? "").Trim(); if (title.Length == 0) title = d.Kind == "flow" ? "Request flow" : "Architecture"; if (title.Length > 120) title = title[..120];
            diagrams.Add(new DtDiagram(key, title, d.Kind == "flow" ? "flow" : "architecture", ArchDiagram.Clean(d.Data)));
        }
        var notes = (req.Notes ?? "").Trim(); if (notes.Length > 8000) throw new ValidationException("notes", "Keep the notes under 8,000 characters.");
        var pid = projectId ?? Guid.Empty;
        var row = await db.ProjectArchitectures.FirstOrDefaultAsync(a => a.ProjectId == pid, ct);
        if (row is null) { row = new ProjectArchitecture { TenantId = ctx.RequireTenantId(), ProjectId = pid, CreatedAt = clock.Now, CreatedBy = ctx.UserId }; db.ProjectArchitectures.Add(row); }
        else { row.UpdatedAt = clock.Now; row.UpdatedBy = ctx.UserId; }
        row.DiagramsJson = JsonSerializer.Serialize(diagrams, Json);
        if (row.DiagramsJson.Length > 600_000) throw new ValidationException("diagrams", "These diagrams are too large. Split them or remove some boxes.");
        row.Notes = notes.Length == 0 ? null : notes;
        recorder.Audit("doctracker.architecture_saved", "ProjectArchitecture", row.Id, null, new { project = projectId, diagrams = diagrams.Select(d => new { d.Key, nodes = d.Data["nodes"]?.AsArray().Count ?? 0 }) });
        await db.SaveChangesAsync(ct);
        return await ArchitectureAsync(projectId, ct);
    }

    // ------------------------------------------------------------------ the project's API document

    /// <summary>
    /// Where a new endpoint of this project goes: its API document (the newest one with an API), created with a first API definition when
    /// the project has none yet - so "New endpoint" works from the project without making a document first.
    /// </summary>
    public async Task<DtApiHome> ApiHomeAsync(Guid? projectId, CancellationToken ct)
    {
        await RequireProjectAsync(projectId, ct);
        var existing = await (from def in db.ApiDefinitions.AsNoTracking()
                              join d in db.Documents.AsNoTracking() on def.DocumentId equals d.Id
                              where d.ProjectId == projectId && d.Status != DocumentStatus.Archived
                              orderby d.UpdatedAt descending, def.SortOrder
                              select new { def.Id, def.DocumentId }).FirstOrDefaultAsync(ct);
        if (existing is not null) return new DtApiHome(existing.DocumentId, existing.Id);
        var types = await documents.ListTypesAsync(ct);
        var apiType = types.FirstOrDefault(t => t.Code == "API") ?? throw new ConflictException("The API document type is switched off in this workspace.");
        var name = projectId is { } pid ? await db.Projects.AsNoTracking().Where(p => p.Id == pid).Select(p => p.Name).FirstAsync(ct) : "General";
        var doc = await documents.CreateAsync(new CreateDocumentRequest($"{name} APIs", apiType.Id, projectId, null, projectId is null ? DocumentVisibility.Organization : DocumentVisibility.Project), ct);
        var overview = await api.SaveDefinitionAsync(doc.Item.Id, null, new SaveDefinitionRequest($"{name} API", null, null, "v1", ApiAuthScheme.ApiKey, null, []), ct);
        return new DtApiHome(doc.Item.Id, overview.Definitions[0].Id);
    }
}
