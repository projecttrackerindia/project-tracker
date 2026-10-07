using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.ApiDocs;

public record DefinitionDto(Guid Id, string Name, string? Description, string? BasePath, string? Version, ApiAuthScheme Auth, string? AuthNote, IReadOnlyList<string> Servers, int Endpoints, int SortOrder, ApiStage Stage = ApiStage.Draft);
public record ApiOverviewDto(IReadOnlyList<DefinitionDto> Definitions, int Endpoints, bool Live, string Reading, Guid? VersionId, bool CanEdit, long Limit, int Used);
public record EndpointItemDto(Guid Id, Guid DefinitionId, string Definition, string Method, string Path, string Summary, string? Tag, bool Deprecated, UserRefDto? Owner);
public record EndpointPageDto(IReadOnlyList<EndpointItemDto> Items, string? NextCursor, int? Total);
public record EndpointDto(EndpointItemDto Item, EndpointDetails Details, bool ReadOnly);
public record EndpointHitDto(Guid DocumentId, string DocumentKey, string DocumentTitle, string Definition, string Method, string Path, string Summary);
public record SaveDefinitionRequest(string Name, string? Description, string? BasePath, string? Version, ApiAuthScheme Auth, string? AuthNote, IReadOnlyList<string>? Servers, ApiStage? Stage = null);
public record SaveEndpointRequest(Guid DefinitionId, string Method, string Path, string? Summary, string? Tag, bool Deprecated, Guid? OwnerId, EndpointDetails? Details);
public record EndpointFilter(Guid? DefinitionId = null, string? Q = null, string? Method = null, string? Tag = null, Guid? VersionId = null);

/// <summary>Where API data is read from: the document's working copy, or a frozen published version.</summary>
public sealed record ApiSource(Guid? VersionId, string Label)
{
    public bool Live => VersionId is null;
}

/// <summary>
/// The API reference of a document: the APIs it describes, their endpoints, and search. People who may edit the document work on the live copy; everyone
/// else reads the latest published version (or the live copy while nothing is published). Lists are paged by path and capped, so a document with
/// thousands of endpoints opens by API and loads a page at a time. Any change counts as a change of the document: it voids a review in progress and
/// makes the draft differ from the published version.
/// </summary>
public class ApiDocService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, EntitlementService entitlements, DocumentAccessService rights, DocumentWorkflowService workflows)
{
    public const int PageSize = 50, MaxPageSize = 200, MaxDefinitions = 30, MaxHits = 50;

    // ------------------------------------------------------------------ opening a document

    public async Task<(Document Doc, DocumentRights Rights)> OpenAsync(Guid documentId, bool write, CancellationToken ct, bool tracked = false)
    {
        var doc = await (tracked || write ? db.Documents : db.Documents.AsNoTracking()).FirstOrDefaultAsync(d => d.Id == documentId, ct) ?? throw new NotFoundException("Document not found.");
        var r = await rights.RightsAsync(doc, ct);
        if (write && !r.Edit) throw new ForbiddenException(doc.Status == DocumentStatus.Archived ? "An archived document cannot be changed. Reopen it first." : "You can read this document but not change its API.", "PERMISSION_DENIED");
        return (doc, r);
    }

    public async Task<ApiSource> SourceAsync(Document doc, DocumentRights r, Guid? versionId, CancellationToken ct)
    {
        if (versionId is { } vid)
        {
            var v = await db.DocumentVersions.AsNoTracking().FirstOrDefaultAsync(x => x.Id == vid && x.DocumentId == doc.Id, ct) ?? throw new NotFoundException("Version not found.");
            if (v.IsDraft) return r.Edit ? new ApiSource(null, "Draft") : throw new NotFoundException("Version not found.");
            return new ApiSource(v.Id, DocumentVersionService.Label(v.Major, v.Minor));
        }
        if (!r.Edit && doc.PublishedVersionId is { } pv)
        {
            var v = await db.DocumentVersions.AsNoTracking().Where(x => x.Id == pv).Select(x => new { x.Major, x.Minor }).FirstAsync(ct);
            return new ApiSource(pv, DocumentVersionService.Label(v.Major, v.Minor));
        }
        return new ApiSource(null, "Draft");
    }

    /// <summary>A list row, read the same way from the working copy and from a frozen version. (A class with initializers, so EF can still filter and order the projection.)</summary>
    private sealed class Row
    {
        public Guid Id { get; init; }
        public Guid DefinitionId { get; init; }
        public ApiMethod Method { get; init; }
        public string Path { get; init; } = "";
        public string Summary { get; init; } = "";
        public string? Tag { get; init; }
        public bool Deprecated { get; init; }
        public Guid? OwnerId { get; init; }
    }

    private IQueryable<Row> Rows(Guid documentId, ApiSource src) => src.Live
        ? db.ApiEndpoints.AsNoTracking().Where(e => e.DocumentId == documentId).Select(e => new Row { Id = e.Id, DefinitionId = e.DefinitionId, Method = e.Method, Path = e.Path, Summary = e.Summary, Tag = e.Tag, Deprecated = e.Deprecated, OwnerId = e.OwnerId })
        : db.EndpointRevisions.AsNoTracking().Where(e => e.DocumentId == documentId && e.VersionId == src.VersionId).Select(e => new Row { Id = e.EndpointId, DefinitionId = e.DefinitionId, Method = e.Method, Path = e.Path, Summary = e.Summary, Tag = e.Tag, Deprecated = e.Deprecated, OwnerId = e.OwnerId });

    internal sealed record SnapDefinition(Guid Id, string Name, string? Description, string? BasePath, string? Version, ApiAuthScheme Auth, string? AuthNote, List<string> Servers, int SortOrder, ApiStage Stage = ApiStage.Draft);

    internal async Task<List<SnapDefinition>> DefinitionsAsync(Guid documentId, ApiSource src, CancellationToken ct)
    {
        if (src.Live)
            return (await db.ApiDefinitions.AsNoTracking().Where(d => d.DocumentId == documentId).OrderBy(d => d.SortOrder).ThenBy(d => d.Name).ToListAsync(ct))
                .Select(d => new SnapDefinition(d.Id, d.Name, d.Description, d.BasePath, d.Version, d.Auth, d.AuthNote, ApiJson.ReadServers(d.ServersJson), d.SortOrder, d.Stage)).ToList();
        var json = await db.ApiSnapshots.AsNoTracking().Where(s => s.VersionId == src.VersionId).Select(s => s.DefinitionsJson).FirstOrDefaultAsync(ct);
        return json is null ? [] : JsonSerializer.Deserialize<List<SnapDefinition>>(json, ApiJson.Options) ?? [];
    }

    // ------------------------------------------------------------------ reading

    public async Task<ApiOverviewDto> OverviewAsync(Guid documentId, Guid? versionId, CancellationToken ct = default)
    {
        var (doc, r) = await OpenAsync(documentId, false, ct);
        var src = await SourceAsync(doc, r, versionId, ct);
        var defs = await DefinitionsAsync(documentId, src, ct);
        var counts = src.Live
            ? await db.ApiEndpoints.AsNoTracking().Where(e => e.DocumentId == documentId).GroupBy(e => e.DefinitionId).Select(g => new { g.Key, N = g.Count() }).ToDictionaryAsync(x => x.Key, x => x.N, ct)
            : await db.EndpointRevisions.AsNoTracking().Where(e => e.DocumentId == documentId && e.VersionId == src.VersionId).GroupBy(e => e.DefinitionId).Select(g => new { g.Key, N = g.Count() }).ToDictionaryAsync(x => x.Key, x => x.N, ct);
        var limit = await entitlements.GetValueAsync(FeatureKeys.DocEndpointLimit, ct);
        var used = await db.ApiEndpoints.CountAsync(ct);
        return new ApiOverviewDto(defs.Select(d => new DefinitionDto(d.Id, d.Name, d.Description, d.BasePath, d.Version, d.Auth, d.AuthNote, d.Servers, counts.GetValueOrDefault(d.Id), d.SortOrder, d.Stage)).ToList(),
            counts.Values.Sum(), src.Live, src.Label, src.VersionId, r.Edit, limit, used);
    }

    public async Task<EndpointPageDto> ListAsync(Guid documentId, EndpointFilter f, string? cursor, int? limit, CancellationToken ct = default)
    {
        var (doc, r) = await OpenAsync(documentId, false, ct);
        var src = await SourceAsync(doc, r, f.VersionId, ct);
        var size = Math.Clamp(limit ?? PageSize, 1, MaxPageSize);
        var q = Rows(documentId, src);
        if (f.DefinitionId is { } d) q = q.Where(x => x.DefinitionId == d);
        if (!string.IsNullOrWhiteSpace(f.Method) && Enum.TryParse<ApiMethod>(f.Method, true, out var m)) q = q.Where(x => x.Method == m);
        if (!string.IsNullOrWhiteSpace(f.Tag)) { var tag = f.Tag.Trim(); q = tag == "-" ? q.Where(x => x.Tag == null) : q.Where(x => x.Tag == tag); }
        if (!string.IsNullOrWhiteSpace(f.Q)) { var t = f.Q.Trim().ToLowerInvariant(); q = q.Where(x => x.Path.ToLower().Contains(t) || x.Summary.ToLower().Contains(t) || (x.Tag != null && x.Tag.ToLower().Contains(t))); }
        int? total = cursor is null ? await q.CountAsync(ct) : null;
        if (TryParseCursor(cursor, out var path, out var after)) q = q.Where(x => x.Path.CompareTo(path) > 0 || (x.Path == path && x.Id.CompareTo(after) > 0));
        var rows = await q.OrderBy(x => x.Path).ThenBy(x => x.Id).Take(size + 1).ToListAsync(ct);
        var more = rows.Count > size;
        if (more) rows.RemoveAt(size);
        var items = await ToItemsAsync(documentId, src, rows, ct);
        return new EndpointPageDto(items, more ? MakeCursor(rows[^1].Path, rows[^1].Id) : null, total);
    }

    private async Task<List<EndpointItemDto>> ToItemsAsync(Guid documentId, ApiSource src, List<Row> rows, CancellationToken ct)
    {
        if (rows.Count == 0) return [];
        var defs = (await DefinitionsAsync(documentId, src, ct)).ToDictionary(d => d.Id, d => d.Name);
        var owners = rows.Where(x => x.OwnerId != null).Select(x => x.OwnerId!.Value).Distinct().ToList();
        var names = owners.Count == 0 ? [] : await db.Users.AsNoTracking().Where(u => owners.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        return rows.Select(x => new EndpointItemDto(x.Id, x.DefinitionId, defs.GetValueOrDefault(x.DefinitionId) ?? "", x.Method.ToString().ToUpperInvariant(), x.Path, x.Summary, x.Tag, x.Deprecated,
            x.OwnerId is { } o ? new UserRefDto(o, names.GetValueOrDefault(o) ?? "Former member") : null)).ToList();
    }

    public async Task<EndpointDto> GetAsync(Guid documentId, Guid endpointId, Guid? versionId, CancellationToken ct = default)
    {
        var (doc, r) = await OpenAsync(documentId, false, ct);
        var src = await SourceAsync(doc, r, versionId, ct);
        var row = await Rows(documentId, src).FirstOrDefaultAsync(x => x.Id == endpointId, ct) ?? throw new NotFoundException("Endpoint not found.");
        var json = src.Live ? await db.ApiEndpoints.AsNoTracking().Where(e => e.Id == endpointId).Select(e => e.DetailsJson).FirstAsync(ct)
            : await db.EndpointRevisions.AsNoTracking().Where(e => e.VersionId == src.VersionId && e.EndpointId == endpointId).Select(e => e.DetailsJson).FirstAsync(ct);
        return new EndpointDto((await ToItemsAsync(documentId, src, [row], ct))[0], ApiJson.Read(json), !src.Live || !r.Edit);
    }

    /// <summary>Published endpoints whose path, summary or group contains the text, in documents the person may open. Drafts are not searched: they are read in their document.</summary>
    public async Task<IReadOnlyList<EndpointHitDto>> SearchAsync(string? q, Guid? projectId, int? limit, CancellationToken ct = default)
    {
        ctx.RequireTenantId();
        var text = (q ?? "").Trim().ToLowerInvariant();
        if (text.Length < 2) throw new ValidationException("q", "Type at least two characters.");
        var take = Math.Clamp(limit ?? 20, 1, MaxHits);
        var hits = await (from e in db.EndpointRevisions.AsNoTracking()
                          join d in db.Documents.AsNoTracking() on e.DocumentId equals d.Id
                          where d.PublishedVersionId == e.VersionId && (projectId == null || d.ProjectId == projectId)
                                && (e.Path.ToLower().Contains(text) || e.Summary.ToLower().Contains(text) || (e.Tag != null && e.Tag.ToLower().Contains(text)))
                          orderby e.Path, d.Number
                          select new { d.Id, d.Number, d.Title, e.DefinitionName, e.Method, e.Path, e.Summary }).Take(take).ToListAsync(ct);
        return hits.Select(h => new EndpointHitDto(h.Id, DocumentService.KeyOf(h.Number), h.Title, h.DefinitionName, h.Method.ToString().ToUpperInvariant(), h.Path, h.Summary)).ToList();
    }

    // ------------------------------------------------------------------ writing: definitions

    public async Task<ApiOverviewDto> SaveDefinitionAsync(Guid documentId, Guid? id, SaveDefinitionRequest req, CancellationToken ct = default)
    {
        var (doc, _) = await OpenAsync(documentId, true, ct);
        var name = (req.Name ?? "").Trim();
        if (name.Length is 0 or > 80) throw new ValidationException("name", "Name the API (up to 80 characters).");
        if (!Enum.IsDefined(req.Auth)) throw new ValidationException("auth", "Choose how callers authenticate.");
        ApiDefinition def;
        if (id is { } did)
        {
            def = await db.ApiDefinitions.FirstOrDefaultAsync(d => d.Id == did && d.DocumentId == documentId, ct) ?? throw new NotFoundException("API not found.");
            if (await db.ApiDefinitions.AnyAsync(d => d.DocumentId == documentId && d.Name == name && d.Id != did, ct)) throw new ConflictException("This document already describes an API with that name.", "API_EXISTS");
        }
        else
        {
            if (await db.ApiDefinitions.CountAsync(d => d.DocumentId == documentId, ct) >= MaxDefinitions) throw new ValidationException("name", $"A document describes at most {MaxDefinitions} APIs.");
            if (await db.ApiDefinitions.AnyAsync(d => d.DocumentId == documentId && d.Name == name, ct)) throw new ConflictException("This document already describes an API with that name.", "API_EXISTS");
            def = new ApiDefinition { TenantId = doc.TenantId, DocumentId = documentId, CreatedAt = clock.Now, CreatedBy = ctx.UserId, SortOrder = await db.ApiDefinitions.CountAsync(d => d.DocumentId == documentId, ct) };
            db.ApiDefinitions.Add(def);
        }
        string? Cut(string? s, int max, string f) { var t = string.IsNullOrWhiteSpace(s) ? null : s.Trim(); if (t is { } x && x.Length > max) throw new ValidationException(f, $"Keep this under {max} characters."); return t; }
        var before = id is null ? null : new { def.Name, def.Version, def.Auth };
        def.Name = name; def.Description = Cut(req.Description, 2000, "description"); def.BasePath = Cut(req.BasePath, 200, "basePath"); def.Version = Cut(req.Version, 40, "version");
        if (req.Stage is { } st) { if (!Enum.IsDefined(st)) throw new ValidationException("stage", "Choose where the API is in its life."); def.Stage = st; }
        def.Auth = req.Auth; def.AuthNote = Cut(req.AuthNote, 500, "authNote"); def.ServersJson = ApiJson.WriteServers(req.Servers); def.UpdatedAt = clock.Now;
        recorder.Activity(id is null ? "document.api_added" : "document.api_changed", "Document", doc.Id, $"{(id is null ? "Added" : "Changed")} the API \"{name}\" in {DocumentService.KeyOf(doc.Number)}", doc.ProjectId);
        recorder.Audit(id is null ? "document.api_added" : "document.api_changed", "Document", doc.Id, before, new { name, req.Version, req.Auth });
        await db.SaveChangesAsync(ct);
        await AfterChangeAsync(doc, ct);
        return await OverviewAsync(documentId, null, ct);
    }

    public async Task<ApiOverviewDto> DeleteDefinitionAsync(Guid documentId, Guid id, CancellationToken ct = default)
    {
        var (doc, _) = await OpenAsync(documentId, true, ct);
        var def = await db.ApiDefinitions.FirstOrDefaultAsync(d => d.Id == id && d.DocumentId == documentId, ct) ?? throw new NotFoundException("API not found.");
        var n = await db.ApiEndpoints.CountAsync(e => e.DefinitionId == id, ct);
        await db.ApiEndpoints.Where(e => e.DefinitionId == id).ExecuteDeleteAsync(ct);
        db.ApiDefinitions.Remove(def);
        recorder.Activity("document.api_removed", "Document", doc.Id, $"Removed the API \"{def.Name}\" ({n} endpoints) from {DocumentService.KeyOf(doc.Number)}", doc.ProjectId);
        recorder.Audit("document.api_removed", "Document", doc.Id, new { def.Name, endpoints = n });
        await db.SaveChangesAsync(ct);
        await AfterChangeAsync(doc, ct);
        return await OverviewAsync(documentId, null, ct);
    }

    // ------------------------------------------------------------------ writing: endpoints

    public async Task<EndpointDto> SaveEndpointAsync(Guid documentId, Guid? id, SaveEndpointRequest req, CancellationToken ct = default)
    {
        var (doc, _) = await OpenAsync(documentId, true, ct);
        var def = await db.ApiDefinitions.AsNoTracking().FirstOrDefaultAsync(d => d.Id == req.DefinitionId && d.DocumentId == documentId, ct) ?? throw new ValidationException("definitionId", "Choose the API this endpoint belongs to.");
        if (!Enum.TryParse<ApiMethod>(req.Method ?? "", true, out var method)) throw new ValidationException("method", "Choose GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS or TRACE.");
        var path = ApiJson.NormalizePath(req.Path);
        var summary = (req.Summary ?? "").Trim();
        if (summary.Length > 300) throw new ValidationException("summary", "Keep the summary under 300 characters.");
        var tag = string.IsNullOrWhiteSpace(req.Tag) ? null : req.Tag.Trim();
        if (tag is { Length: > 80 }) throw new ValidationException("tag", "A group name is at most 80 characters.");
        if (req.OwnerId is { } owner && !await db.TenantMembers.AnyAsync(m => m.TenantId == doc.TenantId && m.UserId == owner, ct)) throw new ValidationException("ownerId", "That person is not in this workspace.");
        var details = ApiJson.Clean(req.Details ?? new EndpointDetails());
        var duplicate = await db.ApiEndpoints.AnyAsync(e => e.DefinitionId == req.DefinitionId && e.Path == path && e.Method == method && e.Id != id, ct);
        if (duplicate) throw new ConflictException($"{method.ToString().ToUpperInvariant()} {path} is already described in this API.", "ENDPOINT_EXISTS");

        ApiEndpoint e;
        object? before = null;
        if (id is { } eid)
        {
            e = await db.ApiEndpoints.FirstOrDefaultAsync(x => x.Id == eid && x.DocumentId == documentId, ct) ?? throw new NotFoundException("Endpoint not found.");
            before = new { e.Method, e.Path, e.Summary, e.Deprecated };
        }
        else
        {
            await entitlements.EnsureWithinLimitAsync(FeatureKeys.DocEndpointLimit, await db.ApiEndpoints.CountAsync(ct), 1, ct);
            e = new ApiEndpoint { TenantId = doc.TenantId, DocumentId = documentId, CreatedAt = clock.Now, CreatedBy = ctx.UserId };
            db.ApiEndpoints.Add(e);
        }
        Apply(e, req.DefinitionId, method, path, summary, tag, req.Deprecated, req.OwnerId, details);
        e.UpdatedAt = clock.Now;
        var label = $"{method.ToString().ToUpperInvariant()} {path}";
        recorder.Activity(id is null ? "document.endpoint_added" : "document.endpoint_changed", "Document", doc.Id, $"{(id is null ? "Added" : "Changed")} {label} in {DocumentService.KeyOf(doc.Number)}", doc.ProjectId);
        recorder.Audit(id is null ? "document.endpoint_added" : "document.endpoint_changed", "Document", doc.Id, before, new { api = def.Name, endpoint = label, summary, req.Deprecated });
        await db.SaveChangesAsync(ct);
        await AfterChangeAsync(doc, ct);
        return await GetAsync(documentId, e.Id, null, ct);
    }

    internal static void Apply(ApiEndpoint e, Guid definitionId, ApiMethod method, string path, string summary, string? tag, bool deprecated, Guid? owner, EndpointDetails details)
    {
        e.DefinitionId = definitionId; e.Method = method; e.Path = path; e.Summary = summary; e.Tag = tag; e.Deprecated = deprecated; e.OwnerId = owner;
        e.DetailsJson = ApiJson.Write(details);
        e.Hash = HashOf(method, path, summary, tag, deprecated, owner, e.DetailsJson);
    }

    public static string HashOf(ApiMethod method, string path, string summary, string? tag, bool deprecated, Guid? owner, string detailsJson) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes($"{method}|{path}|{summary}|{tag}|{deprecated}|{owner}|{detailsJson}"))).ToLowerInvariant();

    public async Task DeleteEndpointAsync(Guid documentId, Guid id, CancellationToken ct = default)
    {
        var (doc, _) = await OpenAsync(documentId, true, ct);
        var e = await db.ApiEndpoints.FirstOrDefaultAsync(x => x.Id == id && x.DocumentId == documentId, ct) ?? throw new NotFoundException("Endpoint not found.");
        db.ApiEndpoints.Remove(e);
        var label = $"{e.Method.ToString().ToUpperInvariant()} {e.Path}";
        recorder.Activity("document.endpoint_removed", "Document", doc.Id, $"Removed {label} from {DocumentService.KeyOf(doc.Number)}", doc.ProjectId);
        recorder.Audit("document.endpoint_removed", "Document", doc.Id, new { endpoint = label, e.Summary });
        await db.SaveChangesAsync(ct);
        await AfterChangeAsync(doc, ct);
    }

    // ------------------------------------------------------------------ the document's fingerprint

    /// <summary>
    /// After any change to the API data: works out the document's API fingerprint again, folds it into the draft's content hash (so the draft now differs
    /// from the published version) and, when the document was in review or approved, cancels that, because the words and the API are one document.
    /// </summary>
    public async Task AfterChangeAsync(Document doc, CancellationToken ct)
    {
        var tracked = await db.Documents.FirstAsync(d => d.Id == doc.Id, ct);
        var apiHash = await ComputeHashAsync(doc.Id, ct);
        if (apiHash == tracked.ApiHash) return;
        tracked.ApiHash = apiHash;
        var draft = tracked.DraftVersionId is { } dv ? await db.DocumentVersions.FirstOrDefaultAsync(v => v.Id == dv, ct) : null;
        if (draft is not null)
        {
            var sections = await db.DocumentSections.AsNoTracking().Where(s => s.VersionId == draft.Id).OrderBy(s => s.SortOrder).ToListAsync(ct);
            draft.ContentHash = DocumentService.Combine(DocumentService.Hash(sections), apiHash); draft.UpdatedAt = clock.Now;
        }
        await workflows.OnContentChangedAsync(tracked, ct);
        tracked.UpdatedAt = clock.Now; tracked.UpdatedBy = ctx.UserId;
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateConcurrencyException) { throw new ConflictException("Someone else changed this document while you were editing. Reload it to see their changes.", "DOCUMENT_CHANGED"); }
    }

    public async Task<string> ComputeHashAsync(Guid documentId, CancellationToken ct)
    {
        var defs = await db.ApiDefinitions.AsNoTracking().Where(d => d.DocumentId == documentId).OrderBy(d => d.Name).ToListAsync(ct);
        var rows = await db.ApiEndpoints.AsNoTracking().Where(e => e.DocumentId == documentId).Select(e => new { e.DefinitionId, e.Method, e.Path, e.Hash }).ToListAsync(ct);
        if (defs.Count == 0 && rows.Count == 0) return "";
        var names = defs.ToDictionary(d => d.Id, d => d.Name);
        var sb = new StringBuilder();
        foreach (var d in defs) sb.Append("D|").Append(d.Name).Append('|').Append(d.Description).Append('|').Append(d.BasePath).Append('|').Append(d.Version).Append('|').Append(d.Auth).Append('|').Append(d.Stage).Append('|').Append(d.AuthNote).Append('|').Append(d.ServersJson).Append('\n');
        foreach (var r in rows.OrderBy(r => names.GetValueOrDefault(r.DefinitionId), StringComparer.Ordinal).ThenBy(r => r.Path, StringComparer.Ordinal).ThenBy(r => r.Method.ToString(), StringComparer.Ordinal))
            sb.Append("E|").Append(names.GetValueOrDefault(r.DefinitionId)).Append('|').Append(r.Method).Append('|').Append(r.Path).Append('|').Append(r.Hash).Append('\n');
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(sb.ToString()))).ToLowerInvariant();
    }

    // ------------------------------------------------------------------ paging

    private static string MakeCursor(string path, Guid id) => Convert.ToBase64String(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new object[] { path, id }))).Replace('+', '-').Replace('/', '_').TrimEnd('=');

    private static bool TryParseCursor(string? cursor, out string path, out Guid id)
    {
        path = ""; id = default;
        if (string.IsNullOrEmpty(cursor)) return false;
        try
        {
            var s = cursor.Replace('-', '+').Replace('_', '/'); s = s.PadRight(s.Length + (4 - s.Length % 4) % 4, '=');
            using var doc = JsonDocument.Parse(Convert.FromBase64String(s));
            path = doc.RootElement[0].GetString() ?? ""; id = doc.RootElement[1].GetGuid();
            return true;
        }
        catch (Exception e) when (e is FormatException or JsonException or InvalidOperationException or KeyNotFoundException) { return false; }
    }
}
