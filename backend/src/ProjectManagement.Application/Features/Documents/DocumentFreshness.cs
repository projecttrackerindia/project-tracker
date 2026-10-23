using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Documents;

/// <param name="Kind">task, project, sprint, work or page.</param>
public record FreshnessReasonDto(string Kind, string Key, string Title, string Detail, DateTime At, string Link);
public record DocumentFreshnessDto(bool Stale, DateTime? Since, IReadOnlyList<FreshnessReasonDto> Reasons, DateTime LastEditedAt, DateTime? VerifiedAt, string? VerifiedBy,
    bool CanVerify, string Summary);
public record VerifyDocumentRequest(string? Note);

/// <summary>
/// Docs that stay true. A page linked to tasks, a project, a sprint or operational work, or mentioning tasks and other pages, "may be out of
/// date" when that work changes after the page was last edited or verified. The owner is told once and asked to confirm it; a confirmed page
/// carries a verified badge with the date. Editing the page clears the warning too.
/// </summary>
public partial class DocumentFreshnessService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, DocumentAccessService rights, DocumentNotifier notifier,
    ILogger<DocumentFreshnessService> log)
{
    [GeneratedRegex("\"kind\":\"(task|page)\",\"id\":\"([0-9a-fA-F-]{36})\"")] private static partial Regex MentionRef();

    public async Task<DocumentFreshnessDto> GetAsync(Guid documentId, CancellationToken ct = default)
    {
        var doc = await db.Documents.AsNoTracking().FirstOrDefaultAsync(d => d.Id == documentId, ct) ?? throw new NotFoundException("Document not found.");
        var (edited, reasons) = await ReasonsAsync(doc, ct);
        var verifiedBy = doc.VerifiedBy is { } vb ? await db.Users.AsNoTracking().Where(u => u.Id == vb).Select(u => u.DisplayName).FirstOrDefaultAsync(ct) : null;
        var can = (await rights.RightsAsync(doc, ct)).Edit || doc.OwnerId == ctx.UserId;
        return new DocumentFreshnessDto(reasons.Count > 0, reasons.Count > 0 ? reasons.Min(r => r.At) : null, reasons, edited, doc.VerifiedAt, verifiedBy, can, Describe(reasons));
    }

    public async Task<DocumentFreshnessDto> VerifyAsync(Guid documentId, VerifyDocumentRequest req, CancellationToken ct = default)
    {
        var doc = await db.Documents.FirstOrDefaultAsync(d => d.Id == documentId, ct) ?? throw new NotFoundException("Document not found.");
        if (!(await rights.RightsAsync(doc, ct)).Edit && doc.OwnerId != ctx.UserId) throw new ForbiddenException("Only the owner or an editor can confirm this page is still right.", "PERMISSION_DENIED");
        var note = string.IsNullOrWhiteSpace(req.Note) ? null : req.Note.Trim()[..Math.Min(300, req.Note.Trim().Length)];
        doc.VerifiedAt = clock.Now; doc.VerifiedBy = ctx.UserId;
        doc.StaleSince = null; doc.StaleReason = null; doc.StaleNotifiedAt = null;
        recorder.Activity("document.verified", "Document", doc.Id, $"Confirmed {DocumentService.KeyOf(doc.Number)} \"{doc.Title}\" is still right{(note is null ? "" : $": {note}")}", doc.ProjectId);
        recorder.Audit("document.verified", "Document", doc.Id, null, new { note });
        await db.SaveChangesAsync(ct);
        return await GetAsync(documentId, ct);
    }

    /// <summary>When the page's text last changed (its draft), and what changed in its linked or mentioned work since then or since it was verified.</summary>
    private async Task<(DateTime Edited, List<FreshnessReasonDto> Reasons)> ReasonsAsync(Document doc, CancellationToken ct)
    {
        var draft = doc.DraftVersionId is { } dv ? await db.DocumentVersions.AsNoTracking().Where(v => v.Id == dv).Select(v => new { v.UpdatedAt, v.CreatedAt }).FirstOrDefaultAsync(ct) : null;
        var edited = draft is null ? doc.CreatedAt : draft.UpdatedAt ?? draft.CreatedAt;
        var since = doc.VerifiedAt is { } v2 && v2 > edited ? v2 : edited;
        var reasons = new List<FreshnessReasonDto>();

        var links = await db.DocumentLinks.AsNoTracking().Where(l => l.DocumentId == doc.Id).Select(l => new { l.TargetType, l.TargetId }).ToListAsync(ct);
        var taskIds = links.Where(l => l.TargetType == LinkTarget.Task).Select(l => l.TargetId).ToHashSet();
        var pageIds = new HashSet<Guid>();
        if (doc.DraftVersionId is { } vid)
        {
            var bodies = await db.DocumentSections.AsNoTracking().Where(s => s.VersionId == vid).Select(s => s.ContentJson).ToListAsync(ct);
            foreach (var body in bodies)
                foreach (Match m in MentionRef().Matches(body))
                    if (Guid.TryParse(m.Groups[2].Value, out var id)) (m.Groups[1].Value == "task" ? taskIds : pageIds).Add(id);
        }
        pageIds.Remove(doc.Id);

        if (taskIds.Count > 0)
        {
            var ids = taskIds.Take(200).ToList();
            var tasks = await db.Tasks.AsNoTracking().Where(t => ids.Contains(t.Id) && (t.UpdatedAt ?? t.CreatedAt) > since)
                .OrderByDescending(t => t.UpdatedAt).Take(20)
                .Select(t => new { t.Id, t.Number, t.Title, Key = t.Project!.Key, Status = t.Status!.Name, At = t.UpdatedAt ?? t.CreatedAt }).ToListAsync(ct);
            reasons.AddRange(tasks.Select(t => new FreshnessReasonDto("task", $"{t.Key}-{t.Number}", t.Title, $"now {t.Status}", t.At, $"/tasks/{t.Id}")));
        }
        var projectIds = links.Where(l => l.TargetType == LinkTarget.Project).Select(l => l.TargetId).ToList();
        if (projectIds.Count > 0)
        {
            var projects = await db.Projects.AsNoTracking().Where(p => projectIds.Contains(p.Id) && p.UpdatedAt != null && p.UpdatedAt > since)
                .Select(p => new { p.Id, p.Key, p.Name, p.Status, At = p.UpdatedAt!.Value }).ToListAsync(ct);
            reasons.AddRange(projects.Select(p => new FreshnessReasonDto("project", p.Key, p.Name, $"project changed ({p.Status})", p.At, $"/projects/{p.Id}")));
        }
        var sprintIds = links.Where(l => l.TargetType == LinkTarget.Sprint).Select(l => l.TargetId).ToList();
        if (sprintIds.Count > 0)
        {
            var sprints = await db.Sprints.AsNoTracking().Where(s => sprintIds.Contains(s.Id) && s.UpdatedAt != null && s.UpdatedAt > since)
                .Select(s => new { s.ProjectId, s.Name, s.Status, At = s.UpdatedAt!.Value }).ToListAsync(ct);
            reasons.AddRange(sprints.Select(s => new FreshnessReasonDto("sprint", s.Name, s.Name, $"sprint {s.Status.ToString().ToLowerInvariant()}", s.At, $"/projects/{s.ProjectId}?tab=sprints")));
        }
        var workIds = links.Where(l => l.TargetType == LinkTarget.WorkItem).Select(l => l.TargetId).ToList();
        if (workIds.Count > 0)
        {
            var work = await db.WorkTasks.AsNoTracking().Where(w => workIds.Contains(w.Id) && w.UpdatedAt != null && w.UpdatedAt > since)
                .Select(w => new { w.Id, w.Number, w.Title, w.Status, At = w.UpdatedAt!.Value }).ToListAsync(ct);
            reasons.AddRange(work.Select(w => new FreshnessReasonDto("work", $"WT-{w.Number}", w.Title, $"now {w.Status}", w.At, $"/operations?open={w.Id}")));
        }
        if (pageIds.Count > 0)
        {
            var ids = pageIds.Take(100).ToList();
            var pages = await (from d in db.Documents.AsNoTracking()
                               join v in db.DocumentVersions.AsNoTracking() on d.DraftVersionId equals v.Id
                               where ids.Contains(d.Id) && (v.UpdatedAt ?? v.CreatedAt) > since
                               select new { d.Id, d.Number, d.Title, At = v.UpdatedAt ?? v.CreatedAt }).Take(20).ToListAsync(ct);
            reasons.AddRange(pages.Select(p => new FreshnessReasonDto("page", DocumentService.KeyOf(p.Number), p.Title, "linked page changed", p.At, $"/documents/{p.Id}")));
        }
        return (edited, reasons.OrderByDescending(r => r.At).ToList());
    }

    public static string Describe(IReadOnlyList<FreshnessReasonDto> reasons)
    {
        if (reasons.Count == 0) return "Nothing it is linked to has changed since it was last edited.";
        var first = reasons[0];
        var lead = $"{first.Key} “{(first.Title.Length > 60 ? first.Title[..60] + "…" : first.Title)}” {first.Detail}";
        return reasons.Count == 1 ? $"{lead} after this page was last edited." : $"{lead}, and {reasons.Count - 1} more changed after this page was last edited.";
    }

    /// <summary>
    /// Nightly: pages with linked or mentioned work are checked; a page that went out of date is marked (for the badge in lists) and its owner is
    /// told once, until it is edited or verified. Runs per workspace with that workspace as the context, like a person opening each page.
    /// </summary>
    public async Task<int> SweepAsync(IServiceProvider services, CancellationToken ct = default)
    {
        var now = clock.Now;
        var candidates = await db.Documents.IgnoreQueryFilters().AsNoTracking()
            .Where(d => !d.IsDeleted && d.Status != DocumentStatus.Archived && d.StaleNotifiedAt == null
                && (db.DocumentLinks.IgnoreQueryFilters().Any(l => l.DocumentId == d.Id) || db.DocumentSections.IgnoreQueryFilters().Any(s => s.VersionId == d.DraftVersionId && s.ContentJson.Contains("\"mention\""))))
            .OrderBy(d => d.UpdatedAt).Select(d => new { d.Id, d.TenantId }).Take(2000).ToListAsync(ct);
        var marked = 0;
        foreach (var group in candidates.GroupBy(c => c.TenantId))
        {
            using var scope = Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.CreateScope(services);
            var sp = scope.ServiceProvider;
            var cc = Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.GetRequiredService<CurrentContext>(sp);
            cc.TenantId = group.Key; cc.Role = TenantRole.Owner; cc.WorkspaceType = WorkspaceType.Organization;   // the workspace sees all its documents; nobody is told about their own work twice
            var sdb = Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.GetRequiredService<IAppDbContext>(sp);
            var me = Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.GetRequiredService<DocumentFreshnessService>(sp);
            var notify = Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.GetRequiredService<DocumentNotifier>(sp);
            foreach (var c in group)
            {
                try
                {
                    var doc = await sdb.Documents.FirstOrDefaultAsync(d => d.Id == c.Id, ct);
                    if (doc is null) continue;
                    var (_, reasons) = await me.ReasonsAsync(doc, ct);
                    if (reasons.Count == 0) continue;
                    doc.StaleSince = reasons.Min(r => r.At);
                    var text = Describe(reasons);
                    doc.StaleReason = text.Length > 500 ? text[..500] : text;
                    doc.StaleNotifiedAt = now;
                    await notify.SendAsync([doc.OwnerId], doc, $"stale:{doc.Id:N}:{now:yyyyMMdd}", $"{DocumentService.KeyOf(doc.Number)} may be out of date", doc.StaleReason, ct: ct);
                    await sdb.SaveChangesAsync(ct);
                    marked++;
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    log.LogWarning(ex, "Freshness check of document {Document} failed", c.Id);
                }
            }
        }
        return marked;
    }
}
