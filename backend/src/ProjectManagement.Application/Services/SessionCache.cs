using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.ChangeTracking;
using Microsoft.Extensions.Caching.Distributed;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Services;

/// <summary>What the request pipeline needs to know about a signed-in session and the person behind it.</summary>
public record CachedSession(Guid UserId, bool IsActive, bool IsPlatformAdmin, bool MfaEnabled, bool MustChangePassword, string? TimeZone, Guid? SsoTenantId,
    string? AuthMethod, DateTime CreatedAt, int? PasswordLength, DateTime? LockedAt, DateTime? LastActivityAt, DateTime LastSeenAt, DateTime ExpiresAt,
    DateTime? RevokedAt, int? IdleMinutes, bool ZoneChosen);

/// <summary>A person's place in one workspace, as the request pipeline needs it.</summary>
public record CachedMembership(TenantRole Role, MemberStatus Status, WorkspaceType Type, ProjectVisibility ProjectVisibility, string? TimeZone);

/// <summary>
/// Remembers, for a few seconds, who a session belongs to and what the person may do in the workspace, so most requests skip the
/// database lookups that would otherwise run before the real work starts. Access is never allowed to outlive a change:
/// anything that ends a session, locks it, suspends or removes a member, changes a role or a security setting clears every remembered entry
/// the moment the change is committed (see <see cref="Affects"/> and AppDbContext), on every server (the "epoch" lives in the shared cache).
/// The short lifetime is only a safety net for a change made some way that does not pass through the database layer.
/// An entry is stored under the epoch read BEFORE the lookup, so a lookup that raced with a change lands under the old epoch and is never read.
/// A cache that is down or slow is treated as empty: it can only make things slower, never wrong or unavailable.
/// </summary>
public class SessionCache(IDistributedCache cache, IOptions<CacheOptions> options)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private const string EpochKey = "sec:epoch";

    public bool Enabled => options.Value.SessionSeconds > 0;

    private DistributedCacheEntryOptions Lifetime => new() { AbsoluteExpirationRelativeToNow = TimeSpan.FromSeconds(options.Value.SessionSeconds) };

    /// <summary>The current generation of remembered access. Changes whenever anything that grants or removes access is committed.</summary>
    private async Task<string> EpochAsync(CancellationToken ct)
    {
        try
        {
            var bytes = await cache.GetAsync(EpochKey, ct);
            if (bytes is not null) return System.Text.Encoding.UTF8.GetString(bytes);
            // A lost epoch must never fall back to an old value: start a new generation.
            var fresh = NewEpoch();
            await cache.SetAsync(EpochKey, System.Text.Encoding.UTF8.GetBytes(fresh), new DistributedCacheEntryOptions { SlidingExpiration = TimeSpan.FromDays(1) }, ct);
            return fresh;
        }
        catch (Exception ex) when (ex is not OperationCanceledException) { return NewEpoch(); }   // unreadable: nothing is shared, everything is a miss
    }

    private static string NewEpoch() => Guid.NewGuid().ToString("N");

    /// <summary>Forget everything remembered, on every server.</summary>
    public async Task InvalidateAllAsync(CancellationToken ct = default)
    {
        if (!Enabled) return;
        try { await cache.SetAsync(EpochKey, System.Text.Encoding.UTF8.GetBytes(NewEpoch()), new DistributedCacheEntryOptions { SlidingExpiration = TimeSpan.FromDays(1) }, ct); }
        catch (Exception ex) when (ex is not OperationCanceledException) { /* entries expire by themselves within the cache lifetime */ }
    }

    private async Task<T?> GetAsync<T>(string key, CancellationToken ct) where T : class
    {
        try { var bytes = await cache.GetAsync(key, ct); return bytes is null ? null : JsonSerializer.Deserialize<T>(bytes, Json); }
        catch (Exception ex) when (ex is not OperationCanceledException) { return null; }
    }

    private async Task SetAsync<T>(string key, T value, CancellationToken ct)
    {
        try { await cache.SetAsync(key, JsonSerializer.SerializeToUtf8Bytes(value, Json), Lifetime, ct); }
        catch (Exception ex) when (ex is not OperationCanceledException) { /* a missing entry only costs a query */ }
    }

    /// <summary>
    /// The session and its person. Revoked or expired sessions are returned as stored (the caller decides, against its own clock);
    /// a session that does not exist is null and is never remembered.
    /// </summary>
    public async Task<CachedSession?> SessionAsync(IAppDbContext db, Guid sessionId, Guid userId, CancellationToken ct)
    {
        if (!Enabled) return await QuerySessionAsync(db, sessionId, userId, ct);
        var epoch = await EpochAsync(ct);
        var key = $"sess:{epoch}:{sessionId:N}:{userId:N}";
        if (await GetAsync<CachedSession>(key, ct) is { } hit) return hit;
        var row = await QuerySessionAsync(db, sessionId, userId, ct);
        if (row is not null) await SetAsync(key, row, ct);
        return row;
    }

    private static Task<CachedSession?> QuerySessionAsync(IAppDbContext db, Guid sessionId, Guid userId, CancellationToken ct) =>
        (from s in db.UserSessions
         join u in db.Users on s.UserId equals u.Id
         where s.Id == sessionId && s.UserId == userId
         select new CachedSession(u.Id, u.IsActive, u.IsPlatformAdmin, u.MfaEnabled, u.MustChangePassword, u.TimeZone, s.SsoTenantId, s.AuthMethod, s.CreatedAt, u.PasswordLength,
             s.LockedAt, s.LastActivityAt, s.LastSeenAt, s.ExpiresAt, s.RevokedAt,
             // "Sign out after inactivity" of the session's own workspace (its settings row only; read before any workspace is resolved).
             db.TenantSecuritySettings.IgnoreQueryFilters().Where(t => t.TenantId == s.WorkspaceId).Select(t => (int?)t.IdleTimeoutMinutes).FirstOrDefault(),
             db.ReminderSettings.Any(r => r.UserId == u.Id && !r.FollowDeviceTimeZone)))
        .AsNoTracking().FirstOrDefaultAsync(ct);

    /// <summary>The person's place in a workspace, or null when they are not a member of an active workspace (never remembered).</summary>
    public async Task<CachedMembership?> MembershipAsync(IAppDbContext db, Guid userId, Guid workspaceId, CancellationToken ct)
    {
        if (!Enabled) return await QueryMembershipAsync(db, userId, workspaceId, ct);
        var epoch = await EpochAsync(ct);
        var key = $"mem:{epoch}:{userId:N}:{workspaceId:N}";
        if (await GetAsync<CachedMembership>(key, ct) is { } hit) return hit;
        var row = await QueryMembershipAsync(db, userId, workspaceId, ct);
        if (row is not null) await SetAsync(key, row, ct);
        return row;
    }

    private static Task<CachedMembership?> QueryMembershipAsync(IAppDbContext db, Guid userId, Guid workspaceId, CancellationToken ct) =>
        (from m in db.TenantMembers
         join t in db.Tenants on m.TenantId equals t.Id
         where m.UserId == userId && m.TenantId == workspaceId && t.Status == TenantStatus.Active
         select new CachedMembership(m.Role, m.Status, t.Type, t.ProjectVisibility, t.TimeZone)).AsNoTracking().FirstOrDefaultAsync(ct);

    // ------------------------------------------------------------------ what clears the cache

    private static readonly HashSet<string> SessionProps = [nameof(UserSession.RevokedAt), nameof(UserSession.ExpiresAt), nameof(UserSession.LockedAt),
        nameof(UserSession.SsoTenantId), nameof(UserSession.AuthMethod), nameof(UserSession.WorkspaceId), nameof(UserSession.UserId)];
    private static readonly HashSet<string> UserProps = [nameof(User.IsActive), nameof(User.IsPlatformAdmin), nameof(User.MfaEnabled), nameof(User.MustChangePassword),
        nameof(User.TimeZone), nameof(User.PasswordLength)];
    private static readonly HashSet<string> TenantProps = [nameof(Tenant.Status), nameof(Tenant.Type), nameof(Tenant.ProjectVisibility), nameof(Tenant.TimeZone), nameof(Tenant.IsDeleted)];

    /// <summary>
    /// Whether a pending change can alter who gets in or what they may do. Writes that only stamp activity (last seen, last sign-in, failed-attempt
    /// counters, audit-chain bookkeeping) are not: they happen all the time and would empty the cache for nothing.
    /// A new session is not one either: nothing can have remembered it yet.
    /// </summary>
    public static bool Affects(EntityEntry e)
    {
        var state = e.State;
        if (state is not (EntityState.Added or EntityState.Modified or EntityState.Deleted)) return false;
        bool Touched(HashSet<string> names) => state != EntityState.Modified || e.Properties.Any(p => p.IsModified && names.Contains(p.Metadata.Name));
        return e.Entity switch
        {
            UserSession => state == EntityState.Deleted || (state == EntityState.Modified && Touched(SessionProps)),
            User => state == EntityState.Deleted || Touched(UserProps),
            TenantMember => true,
            Tenant => Touched(TenantProps),
            TenantSecuritySettings => state != EntityState.Modified || e.Properties.Any(p => p.IsModified && !p.Metadata.Name.StartsWith("Chain", StringComparison.Ordinal)),
            ReminderSettings => state != EntityState.Modified || Touched([nameof(ReminderSettings.FollowDeviceTimeZone)]),
            _ => false,
        };
    }
}
