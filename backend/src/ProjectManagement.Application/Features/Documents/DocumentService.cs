using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Documents;

public record DocumentTypeDto(Guid Id, string Code, string Name, string? Description, string Icon, string Color, IReadOnlyList<SectionTemplate> Sections, int SortOrder);
public record DocumentCan(bool Edit, bool Delete, bool Link, bool Share = false, bool Publish = false);
public record DocumentItemDto(Guid Id, string Key, int Number, string Title, Guid TypeId, string TypeCode, string TypeName, string TypeColor, string TypeIcon,
    Guid? ProjectId, string? ProjectKey, string? ProjectName, Guid? TeamId, string? TeamName, UserRefDto Owner, DocumentStatus Status, DocumentVisibility Visibility,
    IReadOnlyList<string> Tags, DateTime UpdatedAt, DateTime CreatedAt, int LinkedCount);
public record DocumentPageDto(IReadOnlyList<DocumentItemDto> Items, string? NextCursor, int? Total);
public record SectionDto(string Key, string Title, SectionKind Kind, int SortOrder, string Content);
public record DocumentDto(DocumentItemDto Item, int Revision, string VersionLabel, IReadOnlyList<SectionDto> Sections, DocumentCan Can, string? PublishedLabel = null, bool HasUnpublishedChanges = false, bool ViewingPublished = false);

public record SectionInput(string Key, string? Content);
public record CreateDocumentRequest(string Title, Guid TypeId, Guid? ProjectId = null, Guid? TeamId = null, DocumentVisibility? Visibility = null,
    IReadOnlyList<string>? Tags = null, IReadOnlyList<SectionInput>? Sections = null);
public record UpdateDocumentRequest(string Title, DocumentVisibility Visibility, IReadOnlyList<string>? Tags, Guid? OwnerId, int Revision, Guid? TeamId = null);
public record SaveSectionsRequest(int Revision, IReadOnlyList<SectionInput> Sections);
public record DocumentFilter(Guid? ProjectId = null, Guid? TeamId = null, Guid? TypeId = null, DocumentStatus? Status = null, Guid? OwnerId = null, string? Tag = null, string? Q = null, bool? General = null);

/// <summary>
/// Documents: the stable record, its draft version and sections, who may open it. What a person may open is decided in the data layer (the
/// query filter on <see cref="Document"/>), so a document that is not visible simply does not exist for them on any screen or report.
/// </summary>
public class DocumentService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, PermissionService permissions, EntitlementService entitlements, ProjectAccess access, DocumentAccessService rights)
{
    public const int PageSize = 25, MaxPageSize = 100, MaxSections = 60, MaxTags = 12;

    // ------------------------------------------------------------------ types

    public async Task<IReadOnlyList<DocumentTypeDto>> ListTypesAsync(CancellationToken ct = default)
    {
        await EnsureTypesAsync(ct);
        var rows = await db.DocumentTypes.AsNoTracking().Where(t => t.IsActive).OrderBy(t => t.SortOrder).ThenBy(t => t.Name).ToListAsync(ct);
        return rows.Select(ToDto).ToList();
    }

    private static DocumentTypeDto ToDto(DocumentType t) => new(t.Id, t.Code, t.Name, t.Description, t.Icon, t.Color, DocumentTemplates.FromJson(t.TemplateJson), t.SortOrder);

    /// <summary>A workspace gets the built-in kinds the first time anyone looks; later releases add any kind that is missing.</summary>
    private async Task EnsureTypesAsync(CancellationToken ct)
    {
        var tid = ctx.RequireTenantId();
        var have = await db.DocumentTypes.Select(t => t.Code).ToListAsync(ct);
        var missing = DocumentTemplates.All.Where(b => !have.Contains(b.Code)).ToList();
        if (missing.Count == 0) return;
        var order = have.Count;
        foreach (var b in missing)
            db.DocumentTypes.Add(new DocumentType
            {
                TenantId = tid, Code = b.Code, Name = b.Name, Description = b.Description, Icon = b.Icon, Color = b.Color, IsSystem = true, IsActive = true,
                TemplateJson = DocumentTemplates.ToJson(b.Sections), SortOrder = order++, CreatedAt = clock.Now,
            });
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateException) { throw new ConflictException("Document types were being set up at the same moment. Please try again.", "DOCUMENT_TYPES_BUSY"); }
    }

    // ------------------------------------------------------------------ reading

    private IQueryable<Document> Base() => db.Documents.AsNoTracking();

    public async Task<DocumentPageDto> ListAsync(DocumentFilter f, string? cursor, int? limit, CancellationToken ct = default)
    {
        ctx.RequireTenantId();
        var size = Math.Clamp(limit ?? PageSize, 1, MaxPageSize);
        var q = Base();
        if (f.ProjectId is { } p) q = q.Where(d => d.ProjectId == p);
        if (f.General == true) q = q.Where(d => d.ProjectId == null);
        if (f.TeamId is { } t) q = q.Where(d => d.TeamId == t || (d.Project != null && d.Project.TeamId == t));
        if (f.TypeId is { } ty) q = q.Where(d => d.TypeId == ty);
        if (f.Status is { } s) q = q.Where(d => d.Status == s);
        if (f.OwnerId is { } o) q = q.Where(d => d.OwnerId == o);
        if (!string.IsNullOrWhiteSpace(f.Tag)) { var tag = f.Tag.Trim().ToLowerInvariant(); q = q.Where(d => db.DocumentTags.Any(x => x.DocumentId == d.Id && x.Tag == tag)); }
        if (!string.IsNullOrWhiteSpace(f.Q))
        {
            var text = f.Q.Trim().ToLowerInvariant();
            var num = text.StartsWith("doc-") && int.TryParse(text[4..], out var n) ? n : (int?)null;
            q = q.Where(d => d.Title.ToLower().Contains(text) || (num != null && d.Number == num)
                             || db.DocumentTags.Any(x => x.DocumentId == d.Id && x.Tag.Contains(text)));
        }
        int? total = cursor is null ? await q.CountAsync(ct) : null;

        if (Cursor.TryParse(cursor, out var at, out var after))
            q = q.Where(d => d.UpdatedAt < at || (d.UpdatedAt == at && d.Id.CompareTo(after) < 0));
        var rows = await q.OrderByDescending(d => d.UpdatedAt).ThenByDescending(d => d.Id).Take(size + 1).ToListAsync(ct);
        var more = rows.Count > size;
        if (more) rows.RemoveAt(size);
        var items = await ToItemsAsync(rows, ct);
        var next = more ? Cursor.Make(rows[^1].UpdatedAt ?? rows[^1].CreatedAt, rows[^1].Id) : null;
        return new DocumentPageDto(items, next, total);
    }

    /// <summary>The visible documents among <paramref name="ids"/>, newest first (the ones the person cannot open are simply missing).</summary>
    public async Task<IReadOnlyList<DocumentItemDto>> ListByIdsAsync(IReadOnlyList<Guid> ids, CancellationToken ct = default)
    {
        var rows = await Base().Where(d => ids.Contains(d.Id)).OrderByDescending(d => d.UpdatedAt).ThenByDescending(d => d.Id).Take(MaxPageSize).ToListAsync(ct);
        return await ToItemsAsync(rows, ct);
    }

    private async Task<IReadOnlyList<DocumentItemDto>> ToItemsAsync(List<Document> rows, CancellationToken ct)
    {
        if (rows.Count == 0) return [];
        var ids = rows.Select(r => r.Id).ToList();
        var typeIds = rows.Select(r => r.TypeId).Distinct().ToList();
        var types = await db.DocumentTypes.AsNoTracking().Where(t => typeIds.Contains(t.Id)).ToDictionaryAsync(t => t.Id, ct);
        var projectIds = rows.Where(r => r.ProjectId != null).Select(r => r.ProjectId!.Value).Distinct().ToList();
        var projects = await db.Projects.AsNoTracking().Where(p => projectIds.Contains(p.Id)).Select(p => new { p.Id, p.Key, p.Name, p.TeamId }).ToDictionaryAsync(p => p.Id, ct);
        var teamIds = rows.Select(r => r.TeamId ?? (r.ProjectId != null && projects.TryGetValue(r.ProjectId.Value, out var pr) ? pr.TeamId : null)).Where(x => x != null).Select(x => x!.Value).Distinct().ToList();
        var teams = await db.Teams.AsNoTracking().Where(t => teamIds.Contains(t.Id)).ToDictionaryAsync(t => t.Id, t => t.Name, ct);
        var ownerIds = rows.Select(r => r.OwnerId).Distinct().ToList();
        var owners = await db.Users.AsNoTracking().Where(u => ownerIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        var tags = (await db.DocumentTags.AsNoTracking().Where(x => ids.Contains(x.DocumentId)).Select(x => new { x.DocumentId, x.Tag }).ToListAsync(ct))
            .GroupBy(x => x.DocumentId).ToDictionary(g => g.Key, g => (IReadOnlyList<string>)g.Select(x => x.Tag).OrderBy(x => x).ToList());
        var linked = await db.DocumentLinks.AsNoTracking().Where(l => ids.Contains(l.DocumentId)).GroupBy(l => l.DocumentId).Select(g => new { g.Key, N = g.Count() }).ToDictionaryAsync(x => x.Key, x => x.N, ct);

        return rows.Select(r =>
        {
            var ty = types.GetValueOrDefault(r.TypeId);
            projects.TryGetValue(r.ProjectId ?? Guid.Empty, out var pr);
            var teamId = r.TeamId ?? pr?.TeamId;
            return new DocumentItemDto(r.Id, KeyOf(r.Number), r.Number, r.Title, r.TypeId, ty?.Code ?? "", ty?.Name ?? "Document", ty?.Color ?? "#8b5cf6", ty?.Icon ?? "file",
                r.ProjectId, pr?.Key, pr?.Name, teamId, teamId is { } tid ? teams.GetValueOrDefault(tid) : null,
                new UserRefDto(r.OwnerId, owners.GetValueOrDefault(r.OwnerId) ?? "Former member"), r.Status, r.Visibility,
                tags.GetValueOrDefault(r.Id) ?? [], r.UpdatedAt ?? r.CreatedAt, r.CreatedAt, linked.GetValueOrDefault(r.Id));
        }).ToList();
    }

    public static string KeyOf(int number) => $"DOC-{number}";

    public async Task<DocumentDto> GetAsync(Guid id, CancellationToken ct = default)
    {
        var doc = await Base().FirstOrDefaultAsync(d => d.Id == id, ct) ?? throw new NotFoundException("Document not found.");
        return await ToDtoAsync(doc, ct);
    }

    private async Task<DocumentDto> ToDtoAsync(Document doc, CancellationToken ct)
    {
        var item = (await ToItemsAsync([doc], ct))[0];
        var can = await CanAsync(doc, ct);
        var published = doc.PublishedVersionId is { } pv ? await db.DocumentVersions.AsNoTracking().Where(x => x.Id == pv).Select(x => new { x.Major, x.Minor, x.ContentHash }).FirstOrDefaultAsync(ct) : null;
        var draft = doc.DraftVersionId is { } dv ? await db.DocumentVersions.AsNoTracking().Where(x => x.Id == dv).Select(x => new { x.ContentHash }).FirstOrDefaultAsync(ct) : null;
        // People who may edit work on the draft; people who may only read see the newest published version (the draft only until there is one).
        var showPublished = !can.Edit && published is not null;
        var vid = showPublished ? doc.PublishedVersionId : doc.DraftVersionId;
        var sections = vid is { } id ? await db.DocumentSections.AsNoTracking().Where(s => s.VersionId == id).OrderBy(s => s.SortOrder).ToListAsync(ct) : [];
        var publishedLabel = published is null ? null : DocumentVersionService.Label(published.Major, published.Minor);
        var unpublished = draft is not null && (published is null || draft.ContentHash != published.ContentHash);
        var label = publishedLabel is null ? "Draft" : showPublished ? publishedLabel : unpublished ? $"{publishedLabel} + changes" : publishedLabel;
        return new DocumentDto(item, doc.Revision, label, sections.Select(s => new SectionDto(s.Key, s.Title, s.Kind, s.SortOrder, s.ContentJson)).ToList(), can, publishedLabel, unpublished && (can.Edit || published is null), showPublished);
    }

    private async Task<DocumentCan> CanAsync(Document doc, CancellationToken ct)
    {
        var r = await rights.RightsAsync(doc, ct);
        return new DocumentCan(r.Edit, r.Delete, r.Link, r.Share, r.Edit);
    }

    // ------------------------------------------------------------------ writing

    public async Task<DocumentDto> CreateAsync(CreateDocumentRequest req, CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        var uid = ctx.RequireUserId();
        await permissions.RequireModuleAsync(Modules.Documents, AccessLevel.Edit, ct);
        await permissions.RequireAsync(Permissions.DocsCreate, ct);
        var title = CleanTitle(req.Title);
        await EnsureTypesAsync(ct);
        var type = await db.DocumentTypes.FirstOrDefaultAsync(t => t.Id == req.TypeId && t.IsActive, ct) ?? throw new ValidationException("typeId", "Choose a document type.");

        // The plan counts every document of the workspace, not only the ones this person may open.
        var count = await db.Documents.IgnoreQueryFilters().CountAsync(d => d.TenantId == tid && !d.IsDeleted, ct);
        await entitlements.EnsureWithinLimitAsync(FeatureKeys.DocumentLimit, count, 1, ct);

        Project? project = null; Guid? teamId = req.TeamId;
        if (req.ProjectId is { } pid) { project = await access.GetProjectAsync(pid, ct); teamId = project.TeamId; }
        var visibility = await ResolveVisibilityAsync(req.Visibility, project, teamId, ct);

        var now = clock.Now;
        var doc = new Document
        {
            TenantId = tid, Title = title, TypeId = type.Id, ProjectId = project?.Id, TeamId = project is null ? teamId : null, OwnerId = uid,
            Visibility = visibility, Status = DocumentStatus.Draft, CreatedAt = now, UpdatedAt = now, CreatedBy = uid,
            Number = await NextNumberAsync(tid, ct),
        };
        var version = new DocumentVersion { TenantId = tid, DocumentId = doc.Id, Major = 0, Minor = 0, IsDraft = true, CreatedAt = now, CreatedBy = uid };
        var given = (req.Sections ?? []).Where(s => !string.IsNullOrEmpty(s.Key)).GroupBy(s => s.Key).ToDictionary(g => g.Key, g => g.Last().Content);
        var order = 0;
        foreach (var t in DocumentTemplates.FromJson(type.TemplateJson).Take(MaxSections))
        {
            version.Sections.Add(new DocumentSection
            {
                TenantId = tid, Key = t.Key, Title = t.Title, Kind = t.Kind, SortOrder = order++, CreatedAt = now,
                ContentJson = SectionContent.Normalize(t.Kind, given.GetValueOrDefault(t.Key), $"sections.{t.Key}"),
            });
        }
        version.ContentHash = Hash(version.Sections);
        doc.DraftVersionId = version.Id;
        db.Documents.Add(doc);
        db.DocumentVersions.Add(version);
        foreach (var tag in CleanTags(req.Tags)) db.DocumentTags.Add(new DocumentTag { TenantId = tid, DocumentId = doc.Id, Tag = tag, CreatedAt = now });
        recorder.Activity("document.created", "Document", doc.Id, $"Created {KeyOf(doc.Number)} \"{title}\"", project?.Id);
        recorder.Audit("document.created", "Document", doc.Id, null, new { doc.Number, title, type = type.Code, project = project?.Key, visibility = visibility.ToString() });
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateException)
        {
            // Two people created a document at the same moment and drew the same number: take the next free one.
            throw new ConflictException("Another document was created at the same moment. Please try again.", "DOCUMENT_NUMBER_TAKEN");
        }
        return await GetAsync(doc.Id, ct);
    }

    private async Task<int> NextNumberAsync(Guid tenantId, CancellationToken ct) =>
        (await db.Documents.IgnoreQueryFilters().Where(d => d.TenantId == tenantId).MaxAsync(d => (int?)d.Number, ct) ?? 0) + 1;

    private async Task<DocumentVisibility> ResolveVisibilityAsync(DocumentVisibility? wanted, Project? project, Guid? teamId, CancellationToken ct)
    {
        if (project is not null)
        {
            // A document of a project is never visible beyond the project's own people.
            var v = wanted ?? DocumentVisibility.Project;
            if (v is not (DocumentVisibility.Project or DocumentVisibility.Private)) throw new ValidationException("visibility", "A project's document can be visible to the project or private.");
            return v;
        }
        var visibility = wanted ?? (teamId is not null ? DocumentVisibility.Team : DocumentVisibility.Organization);
        if (visibility == DocumentVisibility.Project) throw new ValidationException("visibility", "Choose a project, or make the document visible to a team, the organization, or only you.");
        if (visibility == DocumentVisibility.Team)
        {
            if (teamId is not { } t) throw new ValidationException("teamId", "Choose the team that can see this document.");
            var exists = await db.Teams.AnyAsync(x => x.Id == t, ct);
            if (!exists) throw new ValidationException("teamId", "Team not found.");
            if (ctx.Role is not (TenantRole.Owner or TenantRole.Admin) && !await db.TeamMembers.AnyAsync(m => m.TeamId == t && m.UserId == ctx.UserId, ct))
                throw new ForbiddenException("You can share a document only with a team you belong to.", "TEAM_NOT_YOURS");
        }
        return visibility;
    }

    public async Task<DocumentDto> UpdateAsync(Guid id, UpdateDocumentRequest req, CancellationToken ct = default)
    {
        var doc = await RequireEditableAsync(id, ct);
        if (doc.Revision != req.Revision) throw Changed();
        var title = CleanTitle(req.Title);
        var before = new { doc.Title, visibility = doc.Visibility.ToString(), doc.OwnerId };
        Project? project = doc.ProjectId is { } pid ? await db.Projects.FirstOrDefaultAsync(p => p.Id == pid, ct) : null;
        var teamId = project is null ? (req.TeamId ?? doc.TeamId) : null;
        var visibility = await ResolveVisibilityAsync(req.Visibility, project, teamId, ct);
        if (req.OwnerId is { } owner && owner != doc.OwnerId)
        {
            if (doc.OwnerId != ctx.UserId && !await permissions.HasAsync(Permissions.DocsEdit, ct)) throw new ForbiddenException("Only the owner can hand a document over.", "PERMISSION_DENIED");
            await access.EnsureTenantMemberAsync(owner, "ownerId", ct);
            doc.OwnerId = owner;
        }
        doc.Title = title; doc.Visibility = visibility; doc.TeamId = teamId;
        await SetTagsAsync(doc.Id, req.Tags, ct);
        Touch(doc);
        recorder.Activity("document.updated", "Document", doc.Id, $"Updated {KeyOf(doc.Number)} \"{title}\"", doc.ProjectId);
        recorder.Audit("document.updated", "Document", doc.Id, before, new { Title = title, visibility = visibility.ToString(), doc.OwnerId });
        await SaveAsync(ct);
        return await GetAsync(id, ct);
    }

    public async Task<DocumentDto> SaveSectionsAsync(Guid id, SaveSectionsRequest req, CancellationToken ct = default)
    {
        var doc = await RequireEditableAsync(id, ct);
        if (doc.Revision != req.Revision) throw Changed();
        var vid = doc.DraftVersionId ?? throw new ConflictException("This document has no draft to edit.", "NO_DRAFT");
        var sections = await db.DocumentSections.Where(s => s.VersionId == vid).ToListAsync(ct);
        var images = (await db.DocumentFiles.Where(f => f.DocumentId == doc.Id && f.ContentType.StartsWith("image/")).Select(f => f.Id).ToListAsync(ct)).ToHashSet();
        var now = clock.Now;
        foreach (var input in req.Sections)
        {
            var s = sections.FirstOrDefault(x => x.Key == input.Key) ?? throw new ValidationException("sections", $"There is no section \"{input.Key}\" in this document.");
            s.ContentJson = SectionContent.Normalize(s.Kind, input.Content, $"sections.{s.Key}", images);
            s.UpdatedAt = now;
        }
        var version = await db.DocumentVersions.FirstAsync(v => v.Id == vid, ct);
        version.ContentHash = Hash(sections); version.UpdatedAt = now;
        Touch(doc);
        recorder.Activity("document.edited", "Document", doc.Id, $"Edited {KeyOf(doc.Number)} \"{doc.Title}\"", doc.ProjectId);
        await SaveAsync(ct);
        return await GetAsync(id, ct);
    }

    public async Task<DocumentDto> SetArchivedAsync(Guid id, bool archived, CancellationToken ct = default)
    {
        var doc = await db.Documents.FirstOrDefaultAsync(d => d.Id == id, ct) ?? throw new NotFoundException("Document not found.");
        if (!(await CanAsync(doc, ct)).Edit && !(doc.Status == DocumentStatus.Archived && (await CanAsync(doc, ct)).Delete)) throw new ForbiddenException("You cannot change this document.", "PERMISSION_DENIED");
        doc.Status = archived ? DocumentStatus.Archived : doc.PublishedVersionId is not null ? DocumentStatus.Published : DocumentStatus.Draft;
        Touch(doc);
        recorder.Activity(archived ? "document.archived" : "document.unarchived", "Document", doc.Id, $"{(archived ? "Archived" : "Reopened")} {KeyOf(doc.Number)} \"{doc.Title}\"", doc.ProjectId);
        recorder.Audit(archived ? "document.archived" : "document.unarchived", "Document", doc.Id);
        await SaveAsync(ct);
        return await GetAsync(id, ct);
    }

    public async Task DeleteAsync(Guid id, CancellationToken ct = default)
    {
        var doc = await db.Documents.FirstOrDefaultAsync(d => d.Id == id, ct) ?? throw new NotFoundException("Document not found.");
        if (!(await CanAsync(doc, ct)).Delete) throw new ForbiddenException("You cannot delete this document.", "PERMISSION_DENIED");
        doc.IsDeleted = true; doc.DeletedAt = clock.Now; doc.DeletedBy = ctx.UserId;
        recorder.Activity("document.deleted", "Document", doc.Id, $"Deleted {KeyOf(doc.Number)} \"{doc.Title}\"", doc.ProjectId);
        recorder.Audit("document.deleted", "Document", doc.Id, new { doc.Number, doc.Title });
        await db.SaveChangesAsync(ct);
    }

    /// <summary>Deleted documents can be brought back for 30 days, by whoever deleted them and by the organization's owners and admins.</summary>
    public async Task<DocumentDto> RestoreAsync(Guid id, CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        var doc = await db.Documents.IgnoreQueryFilters().FirstOrDefaultAsync(d => d.Id == id && d.TenantId == tid && d.IsDeleted, ct) ?? throw new NotFoundException("Document not found.");
        var admin = ctx.Role is TenantRole.Owner or TenantRole.Admin;
        if (!admin && doc.DeletedBy != ctx.UserId) throw new NotFoundException("Document not found.");
        if (doc.DeletedAt is { } at && clock.Now - at > TimeSpan.FromDays(RecoveryDays)) throw new ConflictException($"Documents can be restored for {RecoveryDays} days after they are deleted.", "RECOVERY_EXPIRED");
        var count = await db.Documents.IgnoreQueryFilters().CountAsync(d => d.TenantId == tid && !d.IsDeleted, ct);
        await entitlements.EnsureWithinLimitAsync(FeatureKeys.DocumentLimit, count, 1, ct);
        doc.IsDeleted = false; doc.DeletedAt = null; doc.DeletedBy = null; Touch(doc);
        recorder.Activity("document.restored", "Document", doc.Id, $"Restored {KeyOf(doc.Number)} \"{doc.Title}\"", doc.ProjectId);
        recorder.Audit("document.restored", "Document", doc.Id);
        await db.SaveChangesAsync(ct);
        return await GetAsync(id, ct);
    }

    public const int RecoveryDays = 30;

    // ------------------------------------------------------------------ helpers

    private async Task<Document> RequireEditableAsync(Guid id, CancellationToken ct)
    {
        var doc = await db.Documents.FirstOrDefaultAsync(d => d.Id == id, ct) ?? throw new NotFoundException("Document not found.");
        if (!(await CanAsync(doc, ct)).Edit)
            throw new ForbiddenException(doc.Status == DocumentStatus.Archived ? "An archived document cannot be edited. Reopen it first." : "You can read this document but not change it.", "PERMISSION_DENIED");
        return doc;
    }

    private void Touch(Document doc) { doc.Revision++; doc.UpdatedAt = clock.Now; doc.UpdatedBy = ctx.UserId; }

    private async Task SaveAsync(CancellationToken ct)
    {
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateConcurrencyException) { throw Changed(); }
    }

    private static ConflictException Changed() => new("Someone else changed this document while you were editing. Reload it to see their changes.", "DOCUMENT_CHANGED");

    private async Task SetTagsAsync(Guid docId, IReadOnlyList<string>? tags, CancellationToken ct)
    {
        var wanted = CleanTags(tags);
        var existing = await db.DocumentTags.Where(t => t.DocumentId == docId).ToListAsync(ct);
        db.DocumentTags.RemoveRange(existing.Where(t => !wanted.Contains(t.Tag)));
        foreach (var tag in wanted.Where(w => existing.All(e => e.Tag != w)))
            db.DocumentTags.Add(new DocumentTag { TenantId = ctx.RequireTenantId(), DocumentId = docId, Tag = tag, CreatedAt = clock.Now });
    }

    public static List<string> CleanTags(IReadOnlyList<string>? tags) =>
        (tags ?? []).Select(t => (t ?? "").Trim().ToLowerInvariant()).Where(t => t.Length is > 0 and <= 40 && t.All(c => char.IsLetterOrDigit(c) || c is '-' or '_' or ' ' or '.' or '/'))
            .Distinct().Take(MaxTags).ToList();

    private static string CleanTitle(string? title)
    {
        var t = (title ?? "").Trim();
        if (t.Length == 0) throw new ValidationException("title", "Give the document a title.");
        if (t.Length > 200) throw new ValidationException("title", "Keep the title under 200 characters.");
        return t;
    }

    private static string Hash(IEnumerable<DocumentSection> sections)
    {
        var sb = new StringBuilder();
        foreach (var s in sections.OrderBy(x => x.SortOrder)) sb.Append(s.Key).Append('\n').Append(s.ContentJson).Append('\n');
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(sb.ToString()))).ToLowerInvariant();
    }

    /// <summary>Opaque paging position: the time and id of the last row of the previous page.</summary>
    internal static class Cursor
    {
        public static string Make(DateTime at, Guid id) => Convert.ToBase64String(Encoding.UTF8.GetBytes($"{at.Ticks}|{id}")).Replace('+', '-').Replace('/', '_').TrimEnd('=');

        public static bool TryParse(string? cursor, out DateTime at, out Guid id)
        {
            at = default; id = default;
            if (string.IsNullOrEmpty(cursor)) return false;
            try
            {
                var s = cursor.Replace('-', '+').Replace('_', '/'); s = s.PadRight(s.Length + (4 - s.Length % 4) % 4, '=');
                var parts = Encoding.UTF8.GetString(Convert.FromBase64String(s)).Split('|');
                if (parts.Length != 2 || !long.TryParse(parts[0], out var ticks) || !Guid.TryParse(parts[1], out id)) return false;
                at = new DateTime(ticks, DateTimeKind.Utc); return true;
            }
            catch (FormatException) { return false; }
        }
    }
}
