using System.Security.Cryptography;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Auth;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Work;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Vault;

/// <summary>
/// When someone leaves the workspace: their own vault is locked at once (nobody can open it, and it is destroyed after 30 days), every share
/// naming them goes, and each credential they revealed, copied or took a code from in the last 90 days is marked "change it" with the reason,
/// and becomes an action item for the person who owns it (or someone who manages its collection). Nothing of theirs is handed to anyone.
/// </summary>
public class VaultOffboarding(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, NotificationService notifications)
{
    private static readonly string[] UseActions = ["vault.revealed", "vault.copied", "vault.totp_used", "vault.version_revealed", "vault.version_copied"];
    /// <summary>Fetching a sealed collection's ciphertext: with the key, everything in it can be read, so it counts as using every item.</summary>
    private const string SealedListed = "vault.sealed_listed";

    public async Task<int> OnLeavingAsync(Guid tenantId, Guid userId, string name, Guid? by, CancellationToken ct = default)
    {
        var now = clock.Now;
        foreach (var c in await db.VaultCollections.IgnoreQueryFilters().Where(c => c.TenantId == tenantId && c.Kind == VaultCollectionKind.Personal && c.OwnerUserId == userId && c.LockedAt == null).ToListAsync(ct))
            c.LockedAt = now;
        db.VaultShares.RemoveRange(await db.VaultShares.IgnoreQueryFilters().Where(s => s.TenantId == tenantId && s.PrincipalType == VaultPrincipal.User && s.PrincipalId == userId).ToListAsync(ct));
        // Their copies of sealed collection keys go now; every sealed collection they could open gets a new key when a manager next opens it.
        var envelopes = await db.VaultKeyEnvelopes.IgnoreQueryFilters().Where(v => v.TenantId == tenantId && v.RecipientUserId == userId).ToListAsync(ct);
        var keyed = envelopes.Select(v => v.CollectionId).Distinct().ToList();
        db.VaultKeyEnvelopes.RemoveRange(envelopes);
        foreach (var sc in await db.VaultCollections.IgnoreQueryFilters().Where(c => c.TenantId == tenantId && keyed.Contains(c.Id) && c.Kind != VaultCollectionKind.Personal).ToListAsync(ct))
            sc.RekeyNeeded = true;
        db.VaultUnlocks.RemoveRange(await db.VaultUnlocks.IgnoreQueryFilters().Where(u => u.TenantId == tenantId && u.UserId == userId).ToListAsync(ct));
        db.VaultIdentities.RemoveRange(await db.VaultIdentities.IgnoreQueryFilters().Where(i => i.TenantId == tenantId && i.UserId == userId).ToListAsync(ct));
        db.VaultDeviceLinks.RemoveRange(await db.VaultDeviceLinks.IgnoreQueryFilters().Where(l => l.TenantId == tenantId && l.UserId == userId).ToListAsync(ct));
        var sealedListed = await db.AuditLogs.IgnoreQueryFilters().Where(a => a.TenantId == tenantId && a.UserId == userId && a.Action == SealedListed && a.EntityId != null && a.CreatedAt > now.AddDays(-90))
            .Select(a => a.EntityId!.Value).Distinct().ToListAsync(ct);

        var since = now.AddDays(-90);
        var usedIds = await db.AuditLogs.IgnoreQueryFilters().Where(a => a.TenantId == tenantId && a.UserId == userId && a.EntityType == "VaultItem" && a.EntityId != null
                && a.CreatedAt > since && UseActions.Contains(a.Action)).Select(a => a.EntityId!.Value).Distinct().ToListAsync(ct);
        if (usedIds.Count == 0 && sealedListed.Count == 0) { recorder.Audit("vault.offboarded", "User", userId, null, new { name, flagged = 0 }, tenantId: tenantId, userId: by); return 0; }
        var items = await db.VaultItems.IgnoreQueryFilters().Where(i => i.TenantId == tenantId && i.DeletedAt == null
            && ((!i.Sealed && usedIds.Contains(i.Id)) || (i.Sealed && sealedListed.Contains(i.CollectionId)))).ToListAsync(ct);
        var collectionIds = items.Select(i => i.CollectionId).Distinct().ToList();
        var collections = await db.VaultCollections.IgnoreQueryFilters().Where(c => c.TenantId == tenantId && collectionIds.Contains(c.Id)).ToDictionaryAsync(c => c.Id, ct);
        var flagged = 0;
        int? number = null;   // one action item per credential, numbered in turn (nothing is saved until the caller saves)
        var sealedTasked = new HashSet<Guid>();
        foreach (var item in items)
        {
            var c = collections.GetValueOrDefault(item.CollectionId);
            if (c is null || c.Kind == VaultCollectionKind.Personal) continue;   // their own items are locked with their vault
            item.RotationReason = $"{name} could read it and left on {now:dd MMM yyyy}";
            // A sealed collection is read whole: one action item for the collection, every item in it flagged.
            if (item.Sealed && !sealedTasked.Add(c.Id)) { flagged++; continue; }
            var label = item.Sealed ? $"the credentials in sealed collection {c.Name}" : $"“{item.Title}”";
            var owner = item.OwnerUserId is { } o && o != userId ? o
                : await db.VaultShares.IgnoreQueryFilters().Where(s => s.CollectionId == c.Id && s.Access == VaultAccess.Manage && s.PrincipalType == VaultPrincipal.User && s.PrincipalId != userId)
                    .Select(s => s.PrincipalId).FirstOrDefaultAsync(ct) ?? by;
            var next = number is { } n ? n + 1 : await WorkTaskService.NextNumberAsync(db, tenantId, ct);
            number = next;
            db.WorkTasks.Add(new WorkTask
            {
                TenantId = tenantId, Kind = WorkTaskKind.ActionItem, Number = next, RelatedProjectId = c.ProjectId,
                Title = Clip($"Change the password of {label}", 200),
                Description = $"{name} left the workspace and had used this credential in the last 90 days (vault collection {c.Name}). Change it at the source, then save the new value in the vault.",
                AssigneeId = owner, ReporterId = by ?? owner ?? userId, Priority = Priority.High, Status = WorkTaskStatus.ToDo, DueDate = DateOnly.FromDateTime(now.AddDays(3)),
                CreatedAt = now, CreatedBy = by,
            });
            if (owner is { } who)
            {
                var title = Clip($"Change {label}: {name} could read it and left", 200);
                // Provisioning (SCIM) runs without a signed-in workspace; the notice is then written straight to the workspace's inbox.
                if (ctx.TenantId == tenantId) await notifications.AddAsync(who, NotificationType.Security, title, "An action item has been added for you.", $"/vault?item={item.Id}", toSelf: true, ct: ct);
                else db.Notifications.Add(new Notification { TenantId = tenantId, UserId = who, Type = NotificationType.Security, Title = title, Body = "An action item has been added for you.", Link = $"/vault?item={item.Id}", CreatedAt = now });
            }
            flagged++;
        }
        recorder.Audit("vault.offboarded", "User", userId, null, new { name, flagged }, tenantId: tenantId, userId: by);
        return flagged;
    }

    private static string Clip(string s, int max) => s.Length > max ? s[..max] : s;
}

/// <summary>
/// Nightly: reminders before credentials expire (owner, or the collection's managers), a webhook event for each, breach checks for passwords
/// not checked in 30 days, emptying the bin after 30 days and destroying locked personal vaults after 30 days (their item keys go with them).
/// Work that tells people runs inside each workspace in turn, as that workspace.
/// </summary>
public class VaultJobs(IAppDbContext db, AppClock clock, VaultCrypto crypto, PasswordBreachCheck breaches, Recorder recorder, ILogger<VaultJobs> log)
{
    public const int BreachChecksPerNight = 200, ExpiryWarnDays = 7;

    public async Task RunAsync(IServiceProvider services, CancellationToken ct = default)
    {
        await RemindAsync(services, ct);
        await RecheckBreachesAsync(services, ct);
        await PurgeAsync(ct);
    }

    private async Task EachWorkspaceAsync(IServiceProvider services, IEnumerable<Guid> tenants, Func<IServiceProvider, IAppDbContext, Guid, Task> work, CancellationToken ct)
    {
        foreach (var tenant in tenants.Distinct())
        {
            using var scope = services.CreateScope();
            var sp = scope.ServiceProvider;
            var cc = sp.GetRequiredService<CurrentContext>();
            cc.TenantId = tenant; cc.Role = TenantRole.Owner; cc.WorkspaceType = WorkspaceType.Organization;
            try { await work(sp, sp.GetRequiredService<IAppDbContext>(), tenant); }
            catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested) { log.LogError(e, "Vault job failed for workspace {Tenant}; carrying on", tenant); }
        }
    }

    public async Task<int> RemindAsync(IServiceProvider services, CancellationToken ct = default)
    {
        var now = clock.Now; var soon = now.AddDays(ExpiryWarnDays);
        var tenants = await db.VaultItems.IgnoreQueryFilters().Where(i => i.DeletedAt == null && i.ExpiresAt != null && i.ExpiresAt <= soon
            && (i.ExpiryNotifiedAt == null || (i.ExpiresAt <= now && i.ExpiryNotifiedAt < i.ExpiresAt))).Select(i => i.TenantId).Distinct().Take(200).ToListAsync(ct);
        var total = 0;
        await EachWorkspaceAsync(services, tenants, async (sp, sdb, _) =>
        {
            var notifications = sp.GetRequiredService<NotificationService>();
            var due = await sdb.VaultItems.Where(i => i.DeletedAt == null && i.ExpiresAt != null && i.ExpiresAt <= soon
                && (i.ExpiryNotifiedAt == null || (i.ExpiresAt <= now && i.ExpiryNotifiedAt < i.ExpiresAt))).Take(500).ToListAsync(ct);
            foreach (var i in due)
            {
                var expired = i.ExpiresAt <= now;
                var personal = await sdb.VaultCollections.Where(c => c.Id == i.CollectionId).Select(c => c.Kind == VaultCollectionKind.Personal ? c.OwnerUserId : null).FirstOrDefaultAsync(ct);
                List<Guid> to = personal is { } p ? [p] : i.OwnerUserId is { } o ? [o] : await sdb.VaultShares
                    .Where(s => s.CollectionId == i.CollectionId && s.Access == VaultAccess.Manage && s.PrincipalType == VaultPrincipal.User && s.PrincipalId != null)
                    .Select(s => s.PrincipalId!.Value).Distinct().ToListAsync(ct);
                var what = i.Sealed ? "A sealed item" : $"“{i.Title}”";
                foreach (var u in to)
                    await notifications.AddAsync(u, NotificationType.Security, expired ? $"{what} has expired: change it" : $"{what} should be changed by {i.ExpiresAt:dd MMM}",
                        "Change it at the source, then save the new value in the vault.", $"/vault?item={i.Id}", dedupeKey: $"vault-expiry:{i.Id}:{(expired ? "expired" : "soon")}", toSelf: true, ct: ct);
                i.ExpiryNotifiedAt = now;
                // The webhook event says which credential and when, never anything secret.
                sdb.Activities.Add(new Activity { TenantId = i.TenantId, Action = "vault.rotation_due", EntityType = "VaultItem", EntityId = i.Id,
                    Summary = $"{what} {(expired ? "has expired" : $"should be changed by {i.ExpiresAt:dd MMM yyyy}")}", CreatedAt = now });
            }
            await sdb.SaveChangesAsync(ct);
            total += due.Count;
        }, ct);
        return total;
    }

    public async Task<int> RecheckBreachesAsync(IServiceProvider services, CancellationToken ct = default)
    {
        var cutoff = clock.Now.AddDays(-30);
        var rows = await db.VaultItems.IgnoreQueryFilters().AsNoTracking().Where(i => i.DeletedAt == null && i.PasswordFingerprint != null && (i.BreachCheckedAt == null || i.BreachCheckedAt < cutoff))
            .OrderBy(i => i.BreachCheckedAt).Take(BreachChecksPerNight).Select(i => new { i.Id, i.TenantId }).ToListAsync(ct);
        var found = 0;
        await EachWorkspaceAsync(services, rows.Select(r => r.TenantId), async (sp, sdb, tenant) =>
        {
            var notifications = sp.GetRequiredService<NotificationService>();
            var ids = rows.Where(r => r.TenantId == tenant).Select(r => r.Id).ToList();
            foreach (var i in await sdb.VaultItems.Where(i => ids.Contains(i.Id)).ToListAsync(ct))
            {
                try
                {
                    var values = await crypto.OpenAsync(i.TenantId, i.Id, i.Cipher, i.WrappedItemKey, i.KeyVersion, ct);
                    var password = values.GetValueOrDefault("password") ?? values.GetValueOrDefault("key") ?? values.GetValueOrDefault("pin");
                    if (password is null) { i.BreachCheckedAt = clock.Now; continue; }
                    var seen = await breaches.TimesSeenAsync(password, ct);
                    if (seen > 0 && i.BreachCount is null or 0)
                    {
                        found++;
                        i.RotationReason ??= "Its password was found in a public breach";
                        if (i.OwnerUserId is { } o)
                            await notifications.AddAsync(o, NotificationType.Security, $"The password of “{i.Title}” is in a public breach list", "Change it now.", $"/vault?item={i.Id}", toSelf: true, ct: ct);
                    }
                    i.BreachCount = seen; i.BreachCheckedAt = clock.Now;
                }
                catch (Exception e) when (e is CryptographicException or FormatException or InvalidOperationException) { i.BreachCheckedAt = clock.Now; }
            }
            await sdb.SaveChangesAsync(ct);
        }, ct);
        return found;
    }

    public async Task<int> PurgeAsync(CancellationToken ct = default)
    {
        var cutoff = clock.Now.AddDays(-VaultService.BinDays);
        var binned = await db.VaultItems.IgnoreQueryFilters().Where(i => i.DeletedAt != null && i.DeletedAt < cutoff).Select(i => i.Id).Take(1000).ToListAsync(ct);
        var locked = await db.VaultCollections.IgnoreQueryFilters().Where(c => c.LockedAt != null && c.LockedAt < cutoff).ToListAsync(ct);
        var lockedIds = locked.Select(c => c.Id).ToList();
        var lockedItems = lockedIds.Count == 0 ? [] : await db.VaultItems.IgnoreQueryFilters().Where(i => lockedIds.Contains(i.CollectionId)).Select(i => i.Id).ToListAsync(ct);
        var all = binned.Concat(lockedItems).Distinct().ToList();
        if (all.Count > 0)
        {
            await db.VaultAttachments.IgnoreQueryFilters().Where(a => all.Contains(a.ItemId)).ExecuteDeleteAsync(ct);
            await db.VaultItemVersions.IgnoreQueryFilters().Where(v => all.Contains(v.ItemId)).ExecuteDeleteAsync(ct);
            await db.VaultItems.IgnoreQueryFilters().Where(i => all.Contains(i.Id)).ExecuteDeleteAsync(ct);
        }
        if (lockedIds.Count > 0)
        {
            await db.VaultShares.IgnoreQueryFilters().Where(s => lockedIds.Contains(s.CollectionId)).ExecuteDeleteAsync(ct);
            await db.VaultCollections.IgnoreQueryFilters().Where(c => lockedIds.Contains(c.Id)).ExecuteDeleteAsync(ct);
        }
        foreach (var t in locked.Select(c => c.TenantId).Distinct())
            recorder.Audit("vault.destroyed", "VaultCollection", null, null, new { personalVaults = locked.Count(c => c.TenantId == t) }, tenantId: t, userId: null);
        await db.SaveChangesAsync(ct);
        if (all.Count > 0) log.LogInformation("Vault: destroyed {Count} item(s) from the bin and locked personal vaults", all.Count);
        return all.Count;
    }

    /// <summary>After a workspace key rotation: re-wraps item keys (of items, earlier values and files) with the active key. Values are untouched.</summary>
    public async Task<int> RewrapAsync(Guid tenantId, int activeVersion, int max, CancellationToken ct = default)
    {
        var moved = 0;
        foreach (var i in await db.VaultItems.IgnoreQueryFilters().Where(i => i.TenantId == tenantId && !i.Sealed && i.KeyVersion != activeVersion).Take(max).ToListAsync(ct))
            if (await crypto.RewrapAsync(tenantId, i.Id, i.WrappedItemKey, i.KeyVersion, ct) is { } w) { i.WrappedItemKey = w.WrappedKey; i.KeyVersion = w.KeyVersion; moved++; }
        foreach (var v in await db.VaultItemVersions.IgnoreQueryFilters().Where(v => v.TenantId == tenantId && !v.Sealed && v.KeyVersion != activeVersion).Take(max).ToListAsync(ct))
            if (await crypto.RewrapAsync(tenantId, v.ItemId, v.WrappedItemKey, v.KeyVersion, ct) is { } w) { v.WrappedItemKey = w.WrappedKey; v.KeyVersion = w.KeyVersion; moved++; }
        await db.SaveChangesAsync(ct);
        // Files: only the key columns are read and written (their encrypted contents, up to 2 MB each, stay where they are).
        var files = await db.VaultAttachments.IgnoreQueryFilters().AsNoTracking().Where(a => a.TenantId == tenantId && !a.Sealed && a.KeyVersion != activeVersion).Take(max)
            .Select(a => new { a.Id, a.ItemId, a.WrappedItemKey, a.KeyVersion }).ToListAsync(ct);
        foreach (var a in files)
            if (await crypto.RewrapAsync(tenantId, a.ItemId, a.WrappedItemKey, a.KeyVersion, ct) is { } w)
            {
                await db.VaultAttachments.IgnoreQueryFilters().Where(x => x.Id == a.Id && x.KeyVersion == a.KeyVersion)
                    .ExecuteUpdateAsync(u => u.SetProperty(x => x.WrappedItemKey, w.WrappedKey).SetProperty(x => x.KeyVersion, w.KeyVersion), ct);
                moved++;
            }
        return moved;
    }
}
