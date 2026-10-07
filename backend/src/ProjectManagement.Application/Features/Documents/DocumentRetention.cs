using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Documents;

/// <summary>
/// How long documents' history is kept, run nightly with the other clean-up. Deleted documents go for good after <see cref="RecoveryDays"/> days (with their
/// files). Superseded published versions go once they are older than the plan's history period (the same number as activity history), or the workspace's own
/// shorter one. Never removed: the newest published version, and the newest <see cref="KeepLatest"/> versions of each document, so a short period never leaves a
/// document without history. Each run writes one audit entry per workspace with counts only, never content.
/// </summary>
public class DocumentRetentionService(IAppDbContext db, EntitlementService entitlements, IFileStorage storage, AppClock clock, ILogger<DocumentRetentionService> log)
{
    public const int RecoveryDays = 30, KeepLatest = 3, Batch = 500;

    public record Result(int Versions, int Documents);

    public async Task<Result> PurgeAsync(CancellationToken ct = default)
    {
        var now = clock.Now;
        int versionsGone = 0, docsGone = 0;

        // 1. Documents deleted long enough ago.
        var cutoff = now.AddDays(-RecoveryDays);
        var gone = await db.Documents.IgnoreQueryFilters().Where(d => d.IsDeleted && d.DeletedAt != null && d.DeletedAt < cutoff).Select(d => new { d.Id, d.TenantId }).Take(200).ToListAsync(ct);
        foreach (var d in gone)
        {
            var keys = await db.DocumentFiles.IgnoreQueryFilters().Where(f => f.DocumentId == d.Id).Select(f => f.StorageKey).ToListAsync(ct);
            foreach (var k in keys)
            {
                try { await storage.DeleteAsync(k, ct); }
                catch (Exception ex) { log.LogWarning(ex, "Could not delete stored file {Key} of a removed document", k); }
            }
            await db.Documents.IgnoreQueryFilters().Where(x => x.Id == d.Id).ExecuteDeleteAsync(ct);   // versions, sections, tags, links, grants and files follow by cascade
            docsGone++;
        }
        foreach (var g in gone.GroupBy(x => x.TenantId)) Audit(g.Key, new { documents = g.Count() }, now);

        // 2. Old superseded versions, workspace by workspace.
        var tenants = await db.DocumentVersions.IgnoreQueryFilters().Where(v => !v.IsDraft).Select(v => v.TenantId).Distinct().ToListAsync(ct);
        foreach (var tenant in tenants)
        {
            var days = await RetentionDaysAsync(tenant, ct);
            if (days is null) continue;
            var limit = now.AddDays(-days.Value);
            var old = await db.DocumentVersions.IgnoreQueryFilters().Where(v => v.TenantId == tenant && !v.IsDraft && v.PublishedAt != null && v.PublishedAt < limit)
                .Select(v => new { v.Id, v.DocumentId }).Take(Batch).ToListAsync(ct);
            if (old.Count == 0) continue;
            var docIds = old.Select(o => o.DocumentId).Distinct().ToList();
            var all = (await db.DocumentVersions.IgnoreQueryFilters().Where(v => v.TenantId == tenant && !v.IsDraft && docIds.Contains(v.DocumentId))
                .Select(v => new { v.Id, v.DocumentId, v.Major, v.Minor }).ToListAsync(ct)).GroupBy(v => v.DocumentId);
            var newest = await db.Documents.IgnoreQueryFilters().Where(d => docIds.Contains(d.Id)).Select(d => new { d.Id, d.PublishedVersionId }).ToDictionaryAsync(d => d.Id, d => d.PublishedVersionId, ct);
            var protectedIds = new HashSet<Guid>();
            foreach (var g in all)
            {
                foreach (var v in g.OrderByDescending(v => v.Major).ThenByDescending(v => v.Minor).Take(KeepLatest)) protectedIds.Add(v.Id);
                if (newest.GetValueOrDefault(g.Key) is { } p) protectedIds.Add(p);
            }
            var doomed = old.Where(o => !protectedIds.Contains(o.Id)).Select(o => o.Id).ToList();
            if (doomed.Count == 0) continue;
            await db.DocumentVersions.IgnoreQueryFilters().Where(v => doomed.Contains(v.Id)).ExecuteDeleteAsync(ct);   // their sections follow by cascade
            versionsGone += doomed.Count;
            Audit(tenant, new { versions = doomed.Count, olderThanDays = days.Value }, now);
        }
        await db.SaveChangesAsync(ct);
        if (versionsGone + docsGone > 0) log.LogInformation("Document retention removed {Versions} old version(s) and {Documents} deleted document(s)", versionsGone, docsGone);
        return new Result(versionsGone, docsGone);
    }

    /// <summary>The plan's history period, shortened by the workspace's own policy; null when nothing limits it.</summary>
    private async Task<int?> RetentionDaysAsync(Guid tenant, CancellationToken ct)
    {
        var plan = (await entitlements.GetEntitlementsAsync(tenant, ct)).GetValueOrDefault(FeatureKeys.ActivityRetentionDays);
        var policy = await db.TenantDataPolicies.IgnoreQueryFilters().Where(p => p.TenantId == tenant).Select(p => p.ActivityRetentionDays).FirstOrDefaultAsync(ct);
        var options = new List<int>();
        if (plan > 0) options.Add((int)Math.Min(plan, int.MaxValue));
        if (policy is > 0) options.Add(policy.Value);
        return options.Count == 0 ? null : options.Min();
    }

    private void Audit(Guid tenant, object counts, DateTime now) =>
        db.AuditLogs.Add(new AuditLog { TenantId = tenant, Action = "document.retention_purged", EntityType = "Document", NewValue = JsonSerializer.Serialize(counts), CreatedAt = now });
}
