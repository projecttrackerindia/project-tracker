using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Common;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Documents;

public record ChainStatusDto(bool Intact, long Records, long VerifiedUpTo, DateTime? VerifiedAt, long? BrokenSeq, Guid? BrokenId, string? Reason);
public record DocumentSecurityDto(int RevealSeconds, bool Entitled, int KeyVersion, int ValuesTotal, int ValuesOnOldKeys, DateTime? LastRotatedAt, ChainStatusDto Chain);
public record SetRevealRequest(int Seconds);

/// <summary>
/// Tamper-evident audit trail. Every audit row carries a hash of its own content and of the row before it (see <see cref="AuditChain"/>), so editing or
/// removing a row breaks every hash after it. Verification walks the chain and names the first row that does not fit. Old rows can be purged by the
/// retention policy; the hash of the last purged row is kept as the new start, so what remains can still be verified.
/// </summary>
public class AuditChainService(IAppDbContext db, AppClock clock, ILogger<AuditChainService> log)
{
    private const int Batch = 2000;

    /// <summary>Checks the chain from the last verified point (or all of it with <paramref name="full"/>) and remembers the result.</summary>
    public async Task<ChainStatusDto> VerifyAsync(Guid tenantId, bool full, CancellationToken ct = default)
    {
        var s = await db.TenantSecuritySettings.IgnoreQueryFilters().FirstOrDefaultAsync(t => t.TenantId == tenantId, ct);
        if (s is null) db.TenantSecuritySettings.Add(s = new TenantSecuritySettings { TenantId = tenantId });

        long seq = s.ChainAnchorSeq ?? 0; var prev = s.ChainAnchorHash ?? AuditChain.Genesis;
        if (!full && s.ChainBrokenSeq is null && s.ChainVerifiedSeq is { } vs && s.ChainVerifiedHash is { } vh && vs >= seq) { seq = vs; prev = vh; }
        var startedAt = seq;

        long? brokenSeq = null; Guid? brokenId = null; string? reason = null; long checkedRows = 0;
        while (brokenSeq is null)
        {
            var from = seq;
            var rows = await db.AuditLogs.IgnoreQueryFilters().AsNoTracking().Where(a => a.TenantId == tenantId && a.Seq > from).OrderBy(a => a.Seq).Take(Batch).ToListAsync(ct);
            if (rows.Count == 0) break;
            foreach (var a in rows)
            {
                if (a.Seq != seq + 1) { brokenSeq = seq + 1; brokenId = a.Id; reason = "a record is missing before this one"; break; }
                if (a.PrevHash != prev) { brokenSeq = a.Seq; brokenId = a.Id; reason = "it does not follow the record before it"; break; }
                var h = AuditChain.Compute(a, prev);
                if (!string.Equals(a.Hash, h, StringComparison.Ordinal)) { brokenSeq = a.Seq; brokenId = a.Id; reason = "its content was changed"; break; }
                seq = a.Seq!.Value; prev = h; checkedRows++;
            }
        }
        // Removing the newest records leaves no gap to see, but the trail can never be shorter than what was verified before.
        if (brokenSeq is null && s.ChainVerifiedSeq is { } before && seq < before && !full) { brokenSeq = seq + 1; reason = "the newest records are missing"; }

        s.ChainVerifiedAt = clock.Now;
        if (brokenSeq is null) { s.ChainVerifiedSeq = seq; s.ChainVerifiedHash = prev; s.ChainBrokenSeq = null; s.ChainBrokenAt = null; }
        else
        {
            if (s.ChainBrokenSeq != brokenSeq) { s.ChainBrokenSeq = brokenSeq; s.ChainBrokenAt = clock.Now; log.LogError("Audit trail of workspace {Tenant} is broken at record {Seq}: {Reason}", tenantId, brokenSeq, reason); }
        }
        await db.SaveChangesAsync(ct);
        _ = startedAt; _ = checkedRows;
        return await StatusAsync(tenantId, ct, reason, brokenId);
    }

    public async Task<ChainStatusDto> StatusAsync(Guid tenantId, CancellationToken ct = default, string? reason = null, Guid? brokenId = null)
    {
        var s = await db.TenantSecuritySettings.IgnoreQueryFilters().AsNoTracking().FirstOrDefaultAsync(t => t.TenantId == tenantId, ct);
        var total = await db.AuditLogs.IgnoreQueryFilters().LongCountAsync(a => a.TenantId == tenantId && a.Seq != null, ct);
        if (s?.ChainBrokenSeq is { } b && brokenId is null)
        {
            brokenId = await db.AuditLogs.IgnoreQueryFilters().Where(a => a.TenantId == tenantId && a.Seq == b).Select(a => (Guid?)a.Id).FirstOrDefaultAsync(ct);
            reason ??= "it does not fit the chain";
        }
        return new ChainStatusDto(s?.ChainBrokenSeq is null, total, s?.ChainVerifiedSeq ?? s?.ChainAnchorSeq ?? 0, s?.ChainVerifiedAt, s?.ChainBrokenSeq, brokenId, s?.ChainBrokenSeq is null ? null : reason);
    }

    /// <summary>Nightly: checks (from where the last check ended) every workspace whose trail has grown, a few at a time.</summary>
    public async Task<int> VerifyRecentAsync(CancellationToken ct = default)
    {
        var tenants = await db.AuditLogs.IgnoreQueryFilters().Where(a => a.Seq != null && a.TenantId != null && a.CreatedAt > clock.Now.AddDays(-2)).Select(a => a.TenantId!.Value).Distinct().Take(200).ToListAsync(ct);
        var broken = 0;
        foreach (var t in tenants) if (!(await VerifyAsync(t, false, ct)).Intact) broken++;
        return broken;
    }

    /// <summary>Deletes chained rows older than the cutoff (only an unbroken oldest stretch) and keeps the last one's hash as the new start.</summary>
    public async Task<int> PurgeAsync(Guid tenantId, DateTime cutoff, CancellationToken ct = default)
    {
        var status = await VerifyAsync(tenantId, false, ct);   // never discard evidence of tampering
        if (!status.Intact) return 0;
        var oldest = await db.AuditLogs.IgnoreQueryFilters().Where(a => a.TenantId == tenantId && a.Seq != null && a.CreatedAt >= cutoff).OrderBy(a => a.Seq).Select(a => (long?)a.Seq).FirstOrDefaultAsync(ct);
        var lastOld = await db.AuditLogs.IgnoreQueryFilters().Where(a => a.TenantId == tenantId && a.Seq != null && (oldest == null || a.Seq < oldest) && a.CreatedAt < cutoff)
            .OrderByDescending(a => a.Seq).Select(a => new { a.Seq, a.Hash }).FirstOrDefaultAsync(ct);
        if (lastOld is null) return 0;
        var s = await db.TenantSecuritySettings.IgnoreQueryFilters().FirstAsync(t => t.TenantId == tenantId, ct);
        var upTo = lastOld.Seq!.Value;

        await using var tx = await db.Database.BeginTransactionAsync(ct);
        await db.AllowAuditPurgeAsync(ct);   // PostgreSQL: lets this one retention transaction past the no-delete rule
        var n = await db.AuditLogs.IgnoreQueryFilters().Where(a => a.TenantId == tenantId && a.Seq != null && a.Seq <= upTo).ExecuteDeleteAsync(ct);
        s.ChainAnchorSeq = upTo; s.ChainAnchorHash = lastOld.Hash;
        if (s.ChainVerifiedSeq is null || s.ChainVerifiedSeq < upTo) { s.ChainVerifiedSeq = upTo; s.ChainVerifiedHash = lastOld.Hash; }
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return n;
    }
}

/// <summary>Moving every value to a new data key, in batches, so a rotation never blocks reads: old keys keep working until the last value has moved.</summary>
public class KeyRotationService(IAppDbContext db, AppClock clock, EnvelopeCrypto crypto, ILogger<KeyRotationService> log)
{
    public const int Batch = 500;

    private static string Aad(SensitiveValue v) => $"{v.TenantId:N}|{v.DocumentId:N}|{v.Id:N}";

    /// <summary>Re-encrypts up to <paramref name="max"/> values still on an older key. Returns how many moved.</summary>
    public async Task<int> ReencryptAsync(Guid tenantId, int max, CancellationToken ct = default)
    {
        var active = await crypto.ActiveKeyAsync(tenantId, ct);
        var moved = 0;
        while (moved < max)
        {
            var rows = await db.SensitiveValues.IgnoreQueryFilters().Where(v => v.TenantId == tenantId && v.KeyVersion != active.Version).OrderBy(v => v.Id).Take(Math.Min(Batch, max - moved)).ToListAsync(ct);
            if (rows.Count == 0) break;
            foreach (var v in rows)
            {
                var plain = crypto.Decrypt(await crypto.KeyAsync(tenantId, v.KeyVersion, ct), v.Cipher, Aad(v));
                v.Cipher = crypto.Encrypt(active, plain, Aad(v)); v.KeyVersion = active.Version; v.ReencryptedAt = clock.Now;
            }
            await db.SaveChangesAsync(ct);
            moved += rows.Count;
        }
        if (moved > 0) log.LogInformation("Moved {Count} sensitive value(s) of workspace {Tenant} to data key {Version}", moved, tenantId, active.Version);
        return moved;
    }

    /// <summary>For the nightly job: finish rotations that were cut short, in every workspace that still has values on an old key.</summary>
    public async Task<int> ContinueAllAsync(CancellationToken ct = default)
    {
        var tenants = await db.SensitiveValues.IgnoreQueryFilters().Join(db.DocumentKeys.IgnoreQueryFilters().Where(k => k.Active), v => v.TenantId, k => k.TenantId, (v, k) => new { v.TenantId, v.KeyVersion, Active = k.Version })
            .Where(x => x.KeyVersion != x.Active).Select(x => x.TenantId).Distinct().Take(50).ToListAsync(ct);
        var total = 0;
        foreach (var t in tenants) total += await ReencryptAsync(t, 5000, ct);
        return total;
    }
}

/// <summary>The workspace-level controls: how long a revealed value stays visible, key rotation, and the audit trail check. Owners and admins only; the Business plan.</summary>
public class DocumentSecurityService(IAppDbContext db, ICurrentContext ctx, Recorder recorder, EntitlementService entitlements, EnvelopeCrypto crypto, KeyRotationService rotation, AuditChainService chain)
{
    public static readonly int[] Presets = [10, 15, 30, 60];
    public const int MinSeconds = 5, MaxSeconds = 300, RotateInlineMax = 20_000;

    private void RequireManage()
    {
        if (ctx.Role is not (TenantRole.Owner or TenantRole.Admin)) throw new ForbiddenException("Only owners and admins can change document security.", "PERMISSION_DENIED");
    }

    public async Task<DocumentSecurityDto> GetAsync(CancellationToken ct = default)
    {
        RequireManage();
        var tid = ctx.RequireTenantId();
        var s = await db.TenantSecuritySettings.AsNoTracking().FirstOrDefaultAsync(t => t.TenantId == tid, ct);
        var keys = await db.DocumentKeys.AsNoTracking().OrderByDescending(k => k.Version).ToListAsync(ct);
        var active = keys.FirstOrDefault(k => k.Active);
        var total = await db.SensitiveValues.CountAsync(ct);
        var old = active is null ? 0 : await db.SensitiveValues.CountAsync(v => v.KeyVersion != active.Version, ct);
        return new DocumentSecurityDto(s is { RevealSeconds: > 0 } ? s.RevealSeconds : SecretService.DefaultRevealSeconds, await entitlements.GetValueAsync(FeatureKeys.AdvancedSecurity, ct) > 0,
            active?.Version ?? 0, total, old, keys.Count > 1 ? keys.Where(k => k.Active).Select(k => (DateTime?)k.CreatedAt).FirstOrDefault() : null, await chain.StatusAsync(tid, ct));
    }

    public async Task<DocumentSecurityDto> SetRevealAsync(SetRevealRequest req, CancellationToken ct = default)
    {
        RequireManage();
        await entitlements.EnsureFeatureAsync(FeatureKeys.AdvancedSecurity, ct);
        if (req.Seconds is < MinSeconds or > MaxSeconds) throw new ValidationException("seconds", $"Choose between {MinSeconds} and {MaxSeconds} seconds.");
        var tid = ctx.RequireTenantId();
        var row = await db.TenantSecuritySettings.FirstOrDefaultAsync(t => t.TenantId == tid, ct);
        if (row is null) db.TenantSecuritySettings.Add(row = new TenantSecuritySettings { TenantId = tid });
        var before = row.RevealSeconds;
        row.RevealSeconds = req.Seconds;
        recorder.Audit("org.reveal_duration_changed", "Tenant", tid, new { seconds = before }, new { seconds = req.Seconds }, tenantId: tid);
        await db.SaveChangesAsync(ct);
        return await GetAsync(ct);
    }

    public async Task<DocumentSecurityDto> RotateAsync(CancellationToken ct = default)
    {
        RequireManage();
        await entitlements.EnsureFeatureAsync(FeatureKeys.AdvancedSecurity, ct);
        var tid = ctx.RequireTenantId();
        await crypto.ActiveKeyAsync(tid, ct);   // a workspace without a key gets its first one
        var key = await crypto.RotateAsync(tid, ct);
        recorder.Audit("org.data_key_rotated", "Tenant", tid, null, new { version = key.Version }, tenantId: tid);
        await db.SaveChangesAsync(ct);
        await rotation.ReencryptAsync(tid, RotateInlineMax, ct);   // anything beyond that is finished by the nightly job; reads work on both keys meanwhile
        return await GetAsync(ct);
    }

    public async Task<ChainStatusDto> VerifyChainAsync(CancellationToken ct = default)
    {
        RequireManage();
        await entitlements.EnsureFeatureAsync(FeatureKeys.AdvancedSecurity, ct);
        var tid = ctx.RequireTenantId();
        var result = await chain.VerifyAsync(tid, true, ct);
        recorder.Audit("org.audit_chain_verified", "Tenant", tid, null, new { result.Intact, result.Records, result.BrokenSeq }, tenantId: tid);
        await db.SaveChangesAsync(ct);
        return result;
    }
}
