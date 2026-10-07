using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.ApiDocs;

public record ImportApiRequest(string Content, string? FileName, Guid? DefinitionId, string? NewDefinitionName, string? Mode, bool DryRun);
public record ImportResultDto(bool Success, bool Applied, string Format, string Definition, int Added, int Updated, int Unchanged, int Removed, IReadOnlyList<ImportIssue> Issues, ApiOverviewDto? Overview);
public record ChangeLabelDto(Guid? VersionId, string Label);
public record ApiChangesDto(ChangeLabelDto From, ChangeLabelDto To, IReadOnlyList<ApiChange> Items, int Breaking, int Warnings, int Info, int Added, int Removed, int Modified);
public sealed record ExportFile(string FileName, string ContentType, byte[] Bytes);

/// <summary>
/// Moving whole APIs in and out: OpenAPI 3 (JSON or YAML) and Postman collections come in, OpenAPI and Postman go out. An import says exactly what it would
/// do first (a dry run), reports problems with the line they are on, never leaves half an API behind (everything is saved together) and respects the
/// plan's endpoint limit. Also freezing the API when a version is published, and what changed between two versions.
/// </summary>
public class ApiTransferService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, EntitlementService entitlements, ApiDocService api)
{
    public const int MaxContentChars = 6_000_000;

    // ------------------------------------------------------------------ import

    public async Task<ImportResultDto> ImportAsync(Guid documentId, ImportApiRequest req, CancellationToken ct = default)
    {
        var (doc, _) = await api.OpenAsync(documentId, true, ct);
        var text = req.Content ?? "";
        if (text.Length == 0) throw new ValidationException("content", "Choose a file to import.");
        if (text.Length > MaxContentChars) throw new ValidationException("content", "That file is too large to import (6 MB at most).");
        var fallback = Path.GetFileNameWithoutExtension(req.FileName ?? "") is { Length: > 0 } fn ? fn : "Imported API";

        var probe = new List<ImportIssue>();
        string format; ParseResult parsed;
        var node = ApiCurl.Looks(text) ? null : ApiOpenApi.ParseText(text, probe);
        if (ApiCurl.Looks(text)) { format = "curl"; parsed = ApiCurl.Import(text, fallback); }
        else if (node is null) { parsed = new ParseResult(null, probe); format = "unknown"; }
        else if (ApiPostman.Looks(node)) { format = "postman"; parsed = ApiPostman.Import(node, text, fallback); }
        else { format = "openapi"; parsed = ApiOpenApi.Import(text, fallback); }

        if (parsed.Api is null)
            return new ImportResultDto(false, false, format, "", 0, 0, 0, 0, parsed.Issues, null);
        var imported = parsed.Api;
        var replace = string.Equals(req.Mode, "replace", StringComparison.OrdinalIgnoreCase);

        // the API they land in
        ApiDefinition? def = null;
        if (req.DefinitionId is { } did) def = await db.ApiDefinitions.FirstOrDefaultAsync(d => d.Id == did && d.DocumentId == documentId, ct) ?? throw new NotFoundException("API not found.");
        var name = def?.Name ?? (string.IsNullOrWhiteSpace(req.NewDefinitionName) ? imported.Name : req.NewDefinitionName.Trim());
        if (name.Length > 80) name = name[..80];
        if (def is null)
        {
            var taken = (await db.ApiDefinitions.Where(d => d.DocumentId == documentId).Select(d => d.Name).ToListAsync(ct)).ToHashSet();
            var baseName = name; var i = 2; while (taken.Contains(name)) name = $"{(baseName.Length > 74 ? baseName[..74] : baseName)} ({i++})";
            if (taken.Count >= ApiDocService.MaxDefinitions) throw new ValidationException("definitionId", $"A document describes at most {ApiDocService.MaxDefinitions} APIs.");
        }

        var existing = def is null ? [] : await db.ApiEndpoints.Where(e => e.DefinitionId == def.Id).ToListAsync(ct);
        var byKey = existing.ToDictionary(e => $"{e.Method.ToString().ToUpperInvariant()} {e.Path}", e => e);
        var plan = new List<(ImportedEndpoint Item, ApiEndpoint? Existing, string Hash, ApiMethod Method)>();
        foreach (var item in imported.Endpoints)
        {
            var method = Enum.Parse<ApiMethod>(item.Method, true);
            byKey.TryGetValue($"{item.Method} {item.Path}", out var ex);
            plan.Add((item, ex, ApiDocService.HashOf(method, item.Path, item.Summary, item.Tag, item.Deprecated, ex?.OwnerId, ApiJson.Write(item.Details)), method));
        }
        var added = plan.Count(p => p.Existing is null);
        var updated = plan.Count(p => p.Existing is not null && p.Existing.Hash != p.Hash);
        var unchanged = plan.Count(p => p.Existing is not null && p.Existing.Hash == p.Hash);
        var keep = plan.Where(p => p.Existing is not null).Select(p => p.Existing!.Id).ToHashSet();
        var removals = replace ? existing.Where(e => !keep.Contains(e.Id)).ToList() : [];

        var issues = parsed.Issues;
        if (req.DryRun) return new ImportResultDto(true, false, format, name, added, updated, unchanged, removals.Count, issues, null);

        var current = await db.ApiEndpoints.CountAsync(ct);
        await entitlements.EnsureWithinLimitAsync(FeatureKeys.DocEndpointLimit, current - removals.Count, added, ct);

        var now = clock.Now;
        if (def is null)
        {
            def = new ApiDefinition { TenantId = doc.TenantId, DocumentId = documentId, Name = name, Description = imported.Description, Version = imported.Version, Auth = imported.Auth, ServersJson = ApiJson.WriteServers(imported.Servers), CreatedAt = now, CreatedBy = ctx.UserId, SortOrder = await db.ApiDefinitions.CountAsync(d => d.DocumentId == documentId, ct) };
            db.ApiDefinitions.Add(def);
        }
        else
        {
            if (def.Description is null && imported.Description is not null) def.Description = imported.Description;
            if (def.Version is null && imported.Version is not null) def.Version = imported.Version;
            if (def.Auth == ApiAuthScheme.None && imported.Auth != ApiAuthScheme.None) def.Auth = imported.Auth;
            if (def.ServersJson == "[]" && imported.Servers.Count > 0) def.ServersJson = ApiJson.WriteServers(imported.Servers);
            def.UpdatedAt = now;
        }
        foreach (var (item, ex, _, method) in plan)
        {
            var e = ex;
            if (e is null) { e = new ApiEndpoint { TenantId = doc.TenantId, DocumentId = documentId, CreatedAt = now, CreatedBy = ctx.UserId }; db.ApiEndpoints.Add(e); }
            else if (e.Hash == ApiDocService.HashOf(method, item.Path, item.Summary, item.Tag, item.Deprecated, e.OwnerId, ApiJson.Write(item.Details))) continue;
            ApiDocService.Apply(e, def.Id, method, item.Path, item.Summary, item.Tag, item.Deprecated, e.OwnerId, item.Details);
            e.UpdatedAt = now;
        }
        db.ApiEndpoints.RemoveRange(removals);
        recorder.Activity("document.api_imported", "Document", doc.Id, $"Imported {added + updated} endpoint(s) into the API \"{name}\" of {DocumentService.KeyOf(doc.Number)}", doc.ProjectId);
        recorder.Audit("document.api_imported", "Document", doc.Id, null, new { format, api = name, added, updated, unchanged, removed = removals.Count, issues = issues.Count, file = req.FileName });
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateException) { throw new ConflictException("Someone changed this API while it was being imported. Please try again.", "API_CHANGED"); }
        await api.AfterChangeAsync(doc, ct);
        return new ImportResultDto(true, true, format, name, added, updated, unchanged, removals.Count, issues, await api.OverviewAsync(documentId, null, ct));
    }

    // ------------------------------------------------------------------ export

    public async Task<ExportFile> ExportAsync(Guid documentId, string? format, Guid? definitionId, Guid? versionId, CancellationToken ct = default)
    {
        var (doc, r) = await api.OpenAsync(documentId, false, ct);
        var src = await api.SourceAsync(doc, r, versionId, ct);
        var defs = await api.DefinitionsAsync(documentId, src, ct);
        if (defs.Count == 0) throw new ConflictException("This document does not describe an API yet.", "NO_API");
        var def = definitionId is { } did ? defs.FirstOrDefault(d => d.Id == did) ?? throw new NotFoundException("API not found.") : defs.Count == 1 ? defs[0] : throw new ValidationException("definitionId", "Choose which API to export.");
        var rows = await LoadAsync(documentId, src, def.Id, ct);
        var safe = new string(def.Name.Select(c => char.IsLetterOrDigit(c) ? c : '-').ToArray()).Trim('-');
        if (safe.Length == 0) safe = "api";
        var fmt = (format ?? "openapi").ToLowerInvariant();
        recorder.Audit("document.api_exported", "Document", doc.Id, null, new { format = fmt, api = def.Name, endpoints = rows.Count, version = src.Label });
        await db.SaveChangesAsync(ct);
        if (fmt == "postman")
        {
            var json = ApiPostman.Export(def.Name, def.Description, def.Servers, rows.Select(x => (x.Method, x.Path, x.Summary, x.Tag, x.Details)));
            return new ExportFile($"{safe}.postman_collection.json", "application/json", Encoding.UTF8.GetBytes(ApiOpenApi.ToJsonText(json)));
        }
        if (fmt != "openapi") throw new ValidationException("format", "Export as openapi or postman.");
        var spec = ApiOpenApi.Export(def.Name, new ApiOpenApi.ImportedApiHeader(def.Description, def.Version, def.Auth, def.Servers), rows.Select(x => (x.Method, x.Path, x.Summary, x.Tag, x.Deprecated, x.Details)));
        return new ExportFile($"{safe}.openapi.json", "application/json", Encoding.UTF8.GetBytes(ApiOpenApi.ToJsonText(spec)));
    }

    private sealed record Loaded(string Method, string Path, string Summary, string? Tag, bool Deprecated, EndpointDetails Details);

    private async Task<List<Loaded>> LoadAsync(Guid documentId, ApiSource src, Guid definitionId, CancellationToken ct)
    {
        var rows = src.Live
            ? await db.ApiEndpoints.AsNoTracking().Where(e => e.DefinitionId == definitionId).Select(e => new { e.Method, e.Path, e.Summary, e.Tag, e.Deprecated, e.DetailsJson }).ToListAsync(ct)
            : await db.EndpointRevisions.AsNoTracking().Where(e => e.VersionId == src.VersionId && e.DefinitionId == definitionId).Select(e => new { e.Method, e.Path, e.Summary, e.Tag, e.Deprecated, e.DetailsJson }).ToListAsync(ct);
        return rows.Select(e => new Loaded(e.Method.ToString().ToUpperInvariant(), e.Path, e.Summary, e.Tag, e.Deprecated, ApiJson.Read(e.DetailsJson))).ToList();
    }

    // ------------------------------------------------------------------ freezing and restoring with a version

    /// <summary>Called as a version is published (before saving): keeps a copy of the API data as it is now, so the version can be read, compared and restored later.</summary>
    public async Task SnapshotAsync(Document doc, Guid versionId, CancellationToken ct = default)
    {
        var defs = await db.ApiDefinitions.AsNoTracking().Where(d => d.DocumentId == doc.Id).OrderBy(d => d.SortOrder).ToListAsync(ct);
        if (defs.Count == 0) return;
        var names = defs.ToDictionary(d => d.Id, d => d.Name);
        var count = 0;
        var rows = await db.ApiEndpoints.AsNoTracking().Where(e => e.DocumentId == doc.Id).ToListAsync(ct);
        foreach (var e in rows)
        {
            db.EndpointRevisions.Add(new EndpointRevision
            {
                TenantId = doc.TenantId, DocumentId = doc.Id, VersionId = versionId, DefinitionId = e.DefinitionId, DefinitionName = names.GetValueOrDefault(e.DefinitionId) ?? "", EndpointId = e.Id, Method = e.Method, Path = e.Path,
                Summary = e.Summary, Tag = e.Tag, Deprecated = e.Deprecated, OwnerId = e.OwnerId, DetailsJson = e.DetailsJson, CreatedAt = clock.Now,
            });
            count++;
        }
        db.ApiSnapshots.Add(new ApiSnapshot
        {
            TenantId = doc.TenantId, DocumentId = doc.Id, VersionId = versionId, EndpointCount = count, CreatedAt = clock.Now,
            DefinitionsJson = JsonSerializer.Serialize(defs.Select(d => new ApiDocService.SnapDefinition(d.Id, d.Name, d.Description, d.BasePath, d.Version, d.Auth, d.AuthNote, ApiJson.ReadServers(d.ServersJson), d.SortOrder, d.Stage)), ApiJson.Options),
        });
    }

    /// <summary>A version made by restoring an old one carries the same API data as that old one.</summary>
    public async Task SnapshotAfterRestoreAsync(Document doc, Guid newVersionId, Guid oldVersionId, CancellationToken ct = default)
    {
        var snap = await db.ApiSnapshots.AsNoTracking().FirstOrDefaultAsync(s => s.VersionId == oldVersionId, ct);
        if (snap is null) return;
        db.ApiSnapshots.Add(new ApiSnapshot { TenantId = doc.TenantId, DocumentId = doc.Id, VersionId = newVersionId, DefinitionsJson = snap.DefinitionsJson, EndpointCount = snap.EndpointCount, CreatedAt = clock.Now });
        foreach (var e in await db.EndpointRevisions.AsNoTracking().Where(e => e.VersionId == oldVersionId).ToListAsync(ct))
            db.EndpointRevisions.Add(new EndpointRevision
            {
                TenantId = doc.TenantId, DocumentId = doc.Id, VersionId = newVersionId, DefinitionId = e.DefinitionId, DefinitionName = e.DefinitionName, EndpointId = e.EndpointId, Method = e.Method, Path = e.Path,
                Summary = e.Summary, Tag = e.Tag, Deprecated = e.Deprecated, OwnerId = e.OwnerId, DetailsJson = e.DetailsJson, CreatedAt = clock.Now,
            });
    }

    /// <summary>Puts the API data of an old version back as the working copy (all or nothing, with the rest of the restore). A version with no API clears it.</summary>
    public async Task RestoreAsync(Document doc, Guid versionId, CancellationToken ct = default)
    {
        db.ApiEndpoints.RemoveRange(await db.ApiEndpoints.Where(e => e.DocumentId == doc.Id).ToListAsync(ct));
        db.ApiDefinitions.RemoveRange(await db.ApiDefinitions.Where(d => d.DocumentId == doc.Id).ToListAsync(ct));
        var snap = await db.ApiSnapshots.AsNoTracking().FirstOrDefaultAsync(s => s.VersionId == versionId, ct);
        if (snap is not null)
        {
            var defs = JsonSerializer.Deserialize<List<ApiDocService.SnapDefinition>>(snap.DefinitionsJson, ApiJson.Options) ?? [];
            var map = new Dictionary<Guid, Guid>();
            foreach (var d in defs)
            {
                var nd = new ApiDefinition { TenantId = doc.TenantId, DocumentId = doc.Id, Name = d.Name, Description = d.Description, BasePath = d.BasePath, Version = d.Version, Auth = d.Auth, Stage = d.Stage, AuthNote = d.AuthNote, ServersJson = ApiJson.WriteServers(d.Servers), SortOrder = d.SortOrder, CreatedAt = clock.Now };
                db.ApiDefinitions.Add(nd); map[d.Id] = nd.Id;
            }
            foreach (var e in await db.EndpointRevisions.AsNoTracking().Where(e => e.VersionId == versionId).ToListAsync(ct))
            {
                if (!map.TryGetValue(e.DefinitionId, out var def)) continue;
                var ne = new ApiEndpoint { TenantId = doc.TenantId, DocumentId = doc.Id, CreatedAt = clock.Now };
                ApiDocService.Apply(ne, def, e.Method, e.Path, e.Summary, e.Tag, e.Deprecated, e.OwnerId, ApiJson.Read(e.DetailsJson));
                db.ApiEndpoints.Add(ne);
            }
        }
    }

    // ------------------------------------------------------------------ what changed

    /// <summary>Compares the API of two states: a published version or "draft" (the working copy). Breaking changes are listed first.</summary>
    public async Task<ApiChangesDto> ChangesAsync(Guid documentId, Guid? from, Guid? to, CancellationToken ct = default)
    {
        var (doc, r) = await api.OpenAsync(documentId, false, ct);
        var a = await api.SourceAsync(doc, r, from, ct);
        var b = await api.SourceAsync(doc, r, to, ct);
        var before = await ViewsAsync(documentId, a, ct);
        var after = await ViewsAsync(documentId, b, ct);
        var c = ApiChangeDetector.Compare(before, after);
        return new ApiChangesDto(new ChangeLabelDto(a.VersionId, a.Label), new ChangeLabelDto(b.VersionId, b.Label), c.Items, c.Breaking, c.Warnings, c.Info, c.Added, c.Removed, c.Modified);
    }

    internal async Task<List<EndpointView>> ViewsAsync(Guid documentId, ApiSource src, CancellationToken ct)
    {
        var defs = (await api.DefinitionsAsync(documentId, src, ct)).ToDictionary(d => d.Id);
        var rows = src.Live
            ? (await db.ApiEndpoints.AsNoTracking().Where(e => e.DocumentId == documentId).Select(e => new { e.DefinitionId, e.Method, e.Path, e.Summary, e.Deprecated, e.DetailsJson }).ToListAsync(ct))
            : (await db.EndpointRevisions.AsNoTracking().Where(e => e.VersionId == src.VersionId).Select(e => new { e.DefinitionId, e.Method, e.Path, e.Summary, e.Deprecated, e.DetailsJson }).ToListAsync(ct));
        return rows.Select(e =>
        {
            var d = ApiJson.Read(e.DetailsJson);
            defs.TryGetValue(e.DefinitionId, out var def);
            var auth = d.Auth == "inherit" ? (def?.Auth ?? ApiAuthScheme.None).ToString() : d.Auth == "none" ? "None" : d.Auth;
            return new EndpointView(def?.Name ?? "", e.Method.ToString().ToUpperInvariant(), e.Path, e.Summary, e.Deprecated, auth, d);
        }).ToList();
    }
}
