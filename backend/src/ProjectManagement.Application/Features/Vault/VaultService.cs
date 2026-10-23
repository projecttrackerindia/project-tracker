using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Auth;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Vault;

// ------------------------------------------------------------------ what goes over the wire (never a secret value, except a reveal)

public record VaultFieldDto(string Key, string Label, string Type, bool Secret, string? Value);
public record VaultFieldInput(string Key, string? Label, string? Type, bool Secret, string? Value, bool Keep = false);
public record VaultLinkDto(string Kind, Guid Id, string Label);
public record VaultItemSummaryDto(Guid Id, Guid CollectionId, string CollectionName, VaultItemKind Kind, string Title, string? Url, string? UsernameHint,
    IReadOnlyList<string> Tags, SensitivityClass Class, bool UseOnly, UserRefDto? Owner, bool HasTotp, int? Strength, bool Breached, bool Reused,
    DateTime? ExpiresAt, bool Expired, string? RotationReason, DateTime? ValueChangedAt, DateTime? LastUsedAt, VaultAccess MyAccess, IReadOnlyList<string> Health);
public record VaultVersionDto(Guid Id, DateTime At, UserRefDto? By, string? Reason);
public record VaultAttachmentDto(Guid Id, string FileName, string ContentType, long SizeBytes, DateTime At);
public record VaultItemDto(VaultItemSummaryDto Item, IReadOnlyList<VaultFieldDto> Fields, IReadOnlyList<VaultLinkDto> Links, IReadOnlyList<VaultVersionDto> Versions,
    IReadOnlyList<VaultAttachmentDto> Attachments, bool CanReveal, bool CanCopy, bool CanManage, bool NeedsStepUp, int? RotateEveryDays, DateTime CreatedAt, UserRefDto? CreatedBy);
public record VaultShareDto(Guid Id, VaultPrincipal PrincipalType, Guid? PrincipalId, TenantRole? Role, string Name, VaultAccess Access, DateTime? ExpiresAt);
public record VaultCollectionDto(Guid Id, string Name, string? Description, VaultCollectionKind Kind, Guid? ProjectId, string? ProjectName, Guid? TeamId, string? TeamName,
    VaultAccess MyAccess, int Items, int AtRisk, bool RequireStepUp, int? RotateEveryDays, bool Locked, IReadOnlyList<VaultShareDto>? Shares,
    bool Sealed = false, bool RekeyNeeded = false, int KeyVersion = 0, bool RequireApproval = false, bool Requestable = false);
public record VaultPolicyDto(bool StepUpAlways, int ClipboardSeconds, int RevealSeconds, bool SharedAdminsOnly);
public record VaultHealthDto(int Total, int Weak, int Reused, int Breached, int Expired, int Old, int ToRotate, int Score);
public record VaultOverviewDto(IReadOnlyList<VaultCollectionDto> Collections, VaultPolicyDto Policy, bool CanAdmin, bool CanCreateShared, VaultHealthDto Health, bool MfaEnabled,
    VaultIdentityDto? Identity = null, bool HasPasskeys = false);
public record VaultRevealDto(string Value, int RevealSeconds, int ClipboardSeconds);
public record VaultTotpDto(string Code, int SecondsLeft, int Period, int Digits);
public record VaultCheckDto(int Strength, int BreachCount);
public record VaultActivityDto(DateTime At, string Action, UserRefDto? By, string? Field, string? IpAddress);

public record SaveVaultCollectionRequest(string? Name, string? Description, VaultCollectionKind Kind, Guid? ProjectId, Guid? TeamId, bool RequireStepUp = false,
    int? RotateEveryDays = null, VaultAccess? ShareWithMembers = null, bool Sealed = false, bool RequireApproval = false, bool Requestable = false);
public record VaultShareInput(VaultPrincipal PrincipalType, Guid? PrincipalId, TenantRole? Role, VaultAccess Access, DateTime? ExpiresAt);
public record SaveVaultSharesRequest(IReadOnlyList<VaultShareInput>? Shares);
public record SaveVaultItemRequest(Guid CollectionId, VaultItemKind Kind, string? Title, string? Url, IReadOnlyList<string>? Tags, SensitivityClass Class,
    bool UseOnly, Guid? OwnerUserId, int? RotateEveryDays, DateTime? ExpiresAt, IReadOnlyList<VaultFieldInput>? Fields, IReadOnlyList<VaultLinkDto>? Links, string? Reason);
public record VaultRevealRequest(string? Field, string? StepUp, bool Copy = false, bool ForEdit = false);
public record VaultStepUpRequest(string? StepUp);
public record VaultAdminAccessRequest(string? Reason, string? StepUp);
public record VaultImportRow(string? Title, string? Url, string? Username, string? Password, string? Totp, string? Notes);
public record VaultImportRequest(Guid CollectionId, IReadOnlyList<VaultImportRow>? Rows);
public record VaultImportResult(int Imported, int Skipped, int Weak);
public record VaultCheckRequest(string? Password);
public record VaultPolicyRequest(bool StepUpAlways, int ClipboardSeconds, bool SharedAdminsOnly);
public record VaultAccessReviewDto(UserRefDto Person, IReadOnlyList<VaultAccessReviewCollection> Collections, IReadOnlyList<VaultAccessReviewUse> Used);
public record VaultAccessReviewCollection(Guid Id, string Name, VaultAccess Access, int Items);
public record VaultAccessReviewUse(Guid ItemId, string Title, string Collection, int Times, DateTime Last);

/// <summary>
/// The team vault. Who may do what is decided in one place (<see cref="AccessAsync"/>): a personal collection is its owner's alone (an admin
/// cannot open it either); a shared one follows its access list (a person, a team, everyone at or above a role, everyone in a project), where
/// a share can end by itself. Values leave the server only through <see cref="RevealAsync"/>, one field at a time, after these checks in order:
/// enough access (a use-only share or item can copy but never show), a fresh two-step check when the item is confidential, its collection asks
/// for one or the workspace always does, at most 60 a minute, and a pause with a fresh two-step check when someone opens many different items
/// quickly (and the admins are told). Every reveal, copy, one-time code and refusal is written to the tamper-evident audit trail with the
/// field's name, never its value.
/// </summary>
public partial class VaultService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, PermissionService permissions, VaultCrypto crypto,
    StepUpService stepUp, PasswordBreachCheck breaches, NotificationService notifications, ProjectAccess projects)
{
    public const int MaxItemsPerCollection = 2000, MaxFields = 30, MaxValueChars = 8000, MaxVersions = 10, MaxImport = 500, MaxAttachments = 5;
    public const long MaxAttachmentBytes = 2 * 1024 * 1024;
    public const int RevealsPerMinute = 60, UnusualDistinctItems = 15, UnusualWindowMinutes = 10, BinDays = 30;
    private static readonly string[] UseActions = ["vault.revealed", "vault.copied", "vault.totp_used", "vault.version_revealed", "vault.version_copied", "vault.link_created"];
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    // ------------------------------------------------------------------ the fields each kind starts with

    private sealed record FieldDef(string Key, string Label, string Type, bool Secret);
    private static readonly Dictionary<VaultItemKind, FieldDef[]> Template = new()
    {
        [VaultItemKind.Login] = [new("username", "User name", "text", false), new("password", "Password", "password", true), new("totp", "One-time code (2FA)", "totp", true), new("note", "Notes", "note", true)],
        [VaultItemKind.ApiKey] = [new("key", "API key", "password", true), new("secret", "Secret", "password", true), new("note", "Notes", "note", true)],
        [VaultItemKind.Server] = [new("host", "Host", "text", false), new("port", "Port", "text", false), new("username", "User name", "text", false), new("password", "Password", "password", true), new("privateKey", "Private key", "key", true), new("note", "Notes", "note", true)],
        [VaultItemKind.Database] = [new("host", "Host", "text", false), new("port", "Port", "text", false), new("database", "Database", "text", false), new("username", "User name", "text", false), new("password", "Password", "password", true), new("connectionString", "Connection string", "password", true), new("note", "Notes", "note", true)],
        [VaultItemKind.Card] = [new("holder", "Name on card", "text", false), new("number", "Card number", "password", true), new("expiry", "Expiry (MM/YY)", "text", false), new("cvv", "CVV", "password", true), new("pin", "PIN", "password", true), new("note", "Notes", "note", true)],
        [VaultItemKind.Note] = [new("note", "Secure note", "note", true)],
        [VaultItemKind.Other] = [],
    };
    private static readonly HashSet<string> Types = ["text", "password", "totp", "note", "key", "url"];

    // ------------------------------------------------------------------ who may do what

    private (Guid Tenant, Guid Me) Who() => (ctx.RequireTenantId(), ctx.RequireUserId());

    private async Task RequireUseAsync(CancellationToken ct)
    {
        if (ctx.Role is null or TenantRole.Guest) throw new ForbiddenException("Guests cannot use the vault.", "VAULT_DENIED");
        if (ctx.ViaApiKey) throw new ForbiddenException("The vault is not open to API keys. Machines get secrets through their own short-lived identity.", "VAULT_DENIED");
        await permissions.RequireAsync(Permissions.VaultUse, ct);
    }

    private sealed record Membership(HashSet<Guid> Teams, HashSet<Guid> Projects, TenantRole Role);

    private async Task<Membership> MembershipAsync(Guid me, CancellationToken ct)
    {
        var teams = await db.TeamMembers.AsNoTracking().Where(t => t.UserId == me).Select(t => t.TeamId).ToListAsync(ct);
        var mine = await db.ProjectMembers.AsNoTracking().Where(p => p.UserId == me).Select(p => p.ProjectId).ToListAsync(ct);
        var owned = await db.Projects.AsNoTracking().Where(p => p.OwnerId == me).Select(p => p.Id).ToListAsync(ct);
        return new Membership([.. teams], [.. mine, .. owned], ctx.Role ?? TenantRole.Guest);
    }

    private VaultAccess Evaluate(VaultCollection c, IEnumerable<VaultShare> shares, Guid me, Membership m)
    {
        if (c.LockedAt is not null || c.ArchivedAt is not null || m.Role == TenantRole.Guest) return VaultAccess.None;
        if (c.Kind == VaultCollectionKind.Personal) return c.OwnerUserId == me ? VaultAccess.Manage : VaultAccess.None;
        var now = clock.Now;
        var best = VaultAccess.None;
        foreach (var s in shares)
        {
            if (s.CollectionId != c.Id || s.ExpiresAt is { } e && e <= now) continue;
            var applies = s.PrincipalType switch
            {
                VaultPrincipal.User => s.PrincipalId == me,
                VaultPrincipal.Team => s.PrincipalId is { } t && m.Teams.Contains(t),
                VaultPrincipal.Project => s.PrincipalId is { } p && m.Projects.Contains(p),
                VaultPrincipal.Role => s.Role is { } r && m.Role >= r,
                _ => false,
            };
            if (applies && s.Access > best) best = s.Access;
        }
        return best;
    }

    /// <summary>The caller's access to every collection that is not closed to them.</summary>
    private async Task<List<(VaultCollection C, VaultAccess A)>> ReachableAsync(CancellationToken ct)
    {
        var (_, me) = Who();
        var m = await MembershipAsync(me, ct);
        var collections = await db.VaultCollections.AsNoTracking().Where(c => c.LockedAt == null && c.ArchivedAt == null
            && (c.Kind != VaultCollectionKind.Personal || c.OwnerUserId == me)).ToListAsync(ct);
        var ids = collections.Select(c => c.Id).ToList();
        var shares = ids.Count == 0 ? [] : await db.VaultShares.AsNoTracking().Where(s => ids.Contains(s.CollectionId)).ToListAsync(ct);
        return collections.Select(c => (c, Evaluate(c, shares, me, m))).Where(x => x.Item2 > VaultAccess.None).ToList();
    }

    private async Task<(VaultCollection C, VaultAccess A)> CollectionAsync(Guid id, VaultAccess needed, CancellationToken ct)
    {
        var (_, me) = Who();
        var c = await db.VaultCollections.FirstOrDefaultAsync(x => x.Id == id, ct) ?? throw new NotFoundException("Collection not found.", "VAULT_NOT_FOUND");
        var shares = await db.VaultShares.AsNoTracking().Where(s => s.CollectionId == id).ToListAsync(ct);
        var access = Evaluate(c, shares, me, await MembershipAsync(me, ct));
        if (access == VaultAccess.None) throw new NotFoundException("Collection not found.", "VAULT_NOT_FOUND");   // not even its existence is confirmed
        if (access < needed) throw new ForbiddenException(needed == VaultAccess.Manage ? "Only people who manage this collection can do that." : "Your access to this collection does not allow that.", "VAULT_DENIED");
        return (c, access);
    }

    private async Task<(VaultItem Item, VaultCollection C, VaultAccess A)> ItemAsync(Guid id, VaultAccess needed, CancellationToken ct, bool includeBin = false)
    {
        var item = await db.VaultItems.FirstOrDefaultAsync(i => i.Id == id, ct) ?? throw new NotFoundException("Item not found.", "VAULT_NOT_FOUND");
        if (item.DeletedAt is not null && !includeBin) throw new NotFoundException("Item not found.", "VAULT_NOT_FOUND");
        var (c, a) = await CollectionAsync(item.CollectionId, needed, ct);
        return (item, c, a);
    }

    private async Task<VaultPolicyDto> PolicyAsync(CancellationToken ct)
    {
        var (tid, _) = Who();
        var s = await db.TenantSecuritySettings.AsNoTracking().FirstOrDefaultAsync(t => t.TenantId == tid, ct);
        return new VaultPolicyDto(s?.VaultStepUpAlways ?? false, s is { VaultClipboardSeconds: > 0 } ? s.VaultClipboardSeconds : 30,
            s is { RevealSeconds: > 0 } ? s.RevealSeconds : SecretService.DefaultRevealSeconds, s?.VaultSharedAdminsOnly ?? false);
    }

    private bool NeedsStepUp(VaultItem i, VaultCollection c, VaultPolicyDto p) => i.Class == SensitivityClass.Confidential || c.RequireStepUp || p.StepUpAlways;

    // ------------------------------------------------------------------ overview

    public async Task<VaultOverviewDto> OverviewAsync(CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (_, me) = Who();
        await EnsurePersonalAsync(ct);
        var reach = await ReachableAsync(ct);
        var ids = reach.Select(r => r.C.Id).ToList();
        var all = ids.Count == 0 ? [] : await db.VaultItems.AsNoTracking().Where(i => ids.Contains(i.CollectionId) && i.DeletedAt == null).ToListAsync(ct);
        // Sealed items are measured in the browser (only it can read them); here they count, and only their dates and change flags show.
        var items = all.Where(i => !i.Sealed).ToList();
        var reused = ReusedSet(items);
        var flags = all.ToDictionary(i => i.Id, i => HealthOf(i, reused));
        var projectIds = reach.Where(r => r.C.ProjectId != null).Select(r => r.C.ProjectId!.Value).Distinct().ToList();
        var teamIds = reach.Where(r => r.C.TeamId != null).Select(r => r.C.TeamId!.Value).Distinct().ToList();
        var pNames = projectIds.Count == 0 ? [] : await db.Projects.AsNoTracking().Where(p => projectIds.Contains(p.Id)).ToDictionaryAsync(p => p.Id, p => p.Name, ct);
        var tNames = teamIds.Count == 0 ? [] : await db.Teams.AsNoTracking().Where(t => teamIds.Contains(t.Id)).ToDictionaryAsync(t => t.Id, t => t.Name, ct);
        var collections = reach.OrderBy(r => r.C.Kind != VaultCollectionKind.Personal).ThenBy(r => r.C.Name)
            .Select(r => new VaultCollectionDto(r.C.Id, r.C.Name, r.C.Description, r.C.Kind, r.C.ProjectId, r.C.ProjectId is { } p ? pNames.GetValueOrDefault(p) : null,
                r.C.TeamId, r.C.TeamId is { } t ? tNames.GetValueOrDefault(t) : null, r.A, all.Count(i => i.CollectionId == r.C.Id),
                all.Count(i => i.CollectionId == r.C.Id && flags[i.Id].Count > 0), r.C.RequireStepUp, r.C.RotateEveryDays, r.C.LockedAt != null, null,
                r.C.Sealed, r.C.RekeyNeeded, r.C.SealedKeyVersion, r.C.RequireApproval, r.C.Requestable)).ToList();
        var policy = await PolicyAsync(ct);
        var canAdmin = await permissions.HasAsync(Permissions.VaultAdmin, ct);
        var mfa = await db.Users.AsNoTracking().Where(u => u.Id == me).Select(u => u.MfaEnabled).FirstOrDefaultAsync(ct);
        var guardedFlags = items.ToDictionary(i => i.Id, i => flags[i.Id]);
        return new VaultOverviewDto(collections, policy, canAdmin, !policy.SharedAdminsOnly || canAdmin, Health(items, guardedFlags), mfa,
            await db.VaultIdentities.AsNoTracking().Where(i => i.UserId == me).Select(i => (VaultIdentityDto?)new VaultIdentityDto(i.UserId, i.X25519Public, i.MlKemPublic, i.Ed25519Public, i.SelfSignature, i.Fingerprint, i.Generation)).FirstOrDefaultAsync(ct),
            await db.PasskeyCredentials.AsNoTracking().AnyAsync(p => p.UserId == me, ct));
    }

    /// <summary>Everyone who can use the vault has a personal collection; it is made the first time they open it.</summary>
    private async Task EnsurePersonalAsync(CancellationToken ct)
    {
        var (tid, me) = Who();
        if (await db.VaultCollections.AnyAsync(c => c.Kind == VaultCollectionKind.Personal && c.OwnerUserId == me && c.LockedAt == null, ct)) return;
        db.VaultCollections.Add(new VaultCollection { TenantId = tid, Name = "My vault", Kind = VaultCollectionKind.Personal, OwnerUserId = me, CreatedAt = clock.Now, CreatedBy = me });
        await db.SaveChangesAsync(ct);
    }

    private static VaultHealthDto Health(IReadOnlyList<VaultItem> items, IReadOnlyDictionary<Guid, List<string>> flags)
    {
        int Count(string f) => flags.Values.Count(x => x.Contains(f));
        var total = items.Count;
        var healthy = flags.Values.Count(x => x.Count == 0);
        return new VaultHealthDto(total, Count("weak"), Count("reused"), Count("breached"), Count("expired"), Count("old"), Count("rotate"),
            total == 0 ? 100 : (int)Math.Round(100.0 * healthy / total));
    }

    private static HashSet<Guid> ReusedSet(IEnumerable<VaultItem> items) =>
        items.Where(i => i.PasswordFingerprint != null).GroupBy(i => i.PasswordFingerprint).Where(g => g.Count() > 1).SelectMany(g => g.Select(i => i.Id)).ToHashSet();

    private List<string> HealthOf(VaultItem i, HashSet<Guid> reused)
    {
        var f = new List<string>();
        if (i.Strength is < 2) f.Add("weak");
        if (reused.Contains(i.Id)) f.Add("reused");
        if (i.BreachCount is > 0) f.Add("breached");
        if (i.ExpiresAt is { } e && e <= clock.Now) f.Add("expired");
        if (i.ValueChangedAt is { } v && v < clock.Now.AddDays(-365) && i.Kind is VaultItemKind.Login or VaultItemKind.ApiKey or VaultItemKind.Database or VaultItemKind.Server) f.Add("old");
        if (i.RotationReason is not null) f.Add("rotate");
        return f;
    }

    // ------------------------------------------------------------------ collections and sharing

    public async Task<VaultCollectionDto> CreateCollectionAsync(SaveVaultCollectionRequest req, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (tid, me) = Who();
        if (req.Kind == VaultCollectionKind.Personal) throw new ValidationException("kind", "Everyone already has their own vault; make a shared collection instead.");
        if (!Enum.IsDefined(req.Kind)) throw new ValidationException("kind", "Choose who the collection is for.");
        var policy = await PolicyAsync(ct);
        if (policy.SharedAdminsOnly && !await permissions.HasAsync(Permissions.VaultAdmin, ct))
            throw new ForbiddenException("In this workspace only vault admins create shared collections.", "VAULT_DENIED");
        var name = CleanName(req.Name);
        var c = new VaultCollection
        {
            TenantId = tid, Name = name, Description = Clip(req.Description, 300), Kind = req.Kind, RequireStepUp = req.RequireStepUp,
            RotateEveryDays = CleanDays(req.RotateEveryDays), CreatedAt = clock.Now, CreatedBy = me, Sealed = req.Sealed, SealedKeyVersion = req.Sealed ? 1 : 0,
            RequireApproval = req.RequireApproval, Requestable = req.Requestable,
        };
        if (req.Sealed && req.RequireApproval) throw new ValidationException("requireApproval", "The two-person rule needs a guarded collection: in a sealed one, whoever holds the key can read without asking.");
        if (req.Sealed && !await db.VaultIdentities.AnyAsync(i => i.UserId == me, ct)) throw new ConflictException("Set up your vault keys first: a sealed collection is opened with them.", "VAULT_NO_KEYS");
        if (req.Kind == VaultCollectionKind.Project)
        {
            if (req.ProjectId is not { } pid || !await projects.VisibleProjects().AnyAsync(p => p.Id == pid, ct)) throw new ValidationException("projectId", "Choose a project you can see.");
            c.ProjectId = pid;
        }
        if (req.Kind == VaultCollectionKind.Team)
        {
            if (req.TeamId is not { } team || !await db.Teams.AnyAsync(t => t.Id == team, ct)) throw new ValidationException("teamId", "Choose a team.");
            c.TeamId = team;
        }
        db.VaultCollections.Add(c);
        db.VaultShares.Add(new VaultShare { TenantId = tid, CollectionId = c.Id, PrincipalType = VaultPrincipal.User, PrincipalId = me, Access = VaultAccess.Manage, CreatedAt = clock.Now, CreatedBy = me });
        if (req.ShareWithMembers is { } access && access > VaultAccess.None)
        {
            if (c.Sealed && access == VaultAccess.UseOnly) access = VaultAccess.View;   // whoever holds a sealed key can read the value
            if (c.ProjectId is { } p) db.VaultShares.Add(new VaultShare { TenantId = tid, CollectionId = c.Id, PrincipalType = VaultPrincipal.Project, PrincipalId = p, Access = Cap(access), CreatedAt = clock.Now, CreatedBy = me });
            if (c.TeamId is { } t) db.VaultShares.Add(new VaultShare { TenantId = tid, CollectionId = c.Id, PrincipalType = VaultPrincipal.Team, PrincipalId = t, Access = Cap(access), CreatedAt = clock.Now, CreatedBy = me });
        }
        recorder.Audit("vault.collection_created", "VaultCollection", c.Id, null, new { name, kind = req.Kind.ToString() });
        await db.SaveChangesAsync(ct);
        return await CollectionDtoAsync(c.Id, ct);
    }

    private static VaultAccess Cap(VaultAccess a) => a > VaultAccess.Manage ? VaultAccess.Manage : a;

    public async Task<VaultCollectionDto> UpdateCollectionAsync(Guid id, SaveVaultCollectionRequest req, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (c, _) = await CollectionAsync(id, VaultAccess.Manage, ct);
        var before = new { c.Name, c.RequireStepUp, c.RotateEveryDays };
        if (c.Sealed && req.RequireApproval) throw new ValidationException("requireApproval", "The two-person rule needs a guarded collection: in a sealed one, whoever holds the key can read without asking.");
        if (c.Kind == VaultCollectionKind.Personal && req.Requestable) throw new ValidationException("requestable", "Nobody can ask for a personal vault.");
        c.Name = CleanName(req.Name); c.Description = Clip(req.Description, 300); c.RequireStepUp = req.RequireStepUp; c.RotateEveryDays = CleanDays(req.RotateEveryDays);
        c.RequireApproval = req.RequireApproval; c.Requestable = req.Requestable;
        c.UpdatedAt = clock.Now; c.UpdatedBy = ctx.UserId;
        recorder.Audit("vault.collection_changed", "VaultCollection", c.Id, before, new { c.Name, c.RequireStepUp, c.RotateEveryDays });
        await db.SaveChangesAsync(ct);
        return await CollectionDtoAsync(c.Id, ct);
    }

    public async Task DeleteCollectionAsync(Guid id, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (c, _) = await CollectionAsync(id, VaultAccess.Manage, ct);
        if (c.Kind == VaultCollectionKind.Personal) throw new ConflictException("Your own vault cannot be deleted.", "VAULT_PERSONAL");
        if (await db.VaultItems.AnyAsync(i => i.CollectionId == id, ct)) throw new ConflictException("Move or delete its items first (including the bin).", "VAULT_NOT_EMPTY");
        db.VaultShares.RemoveRange(await db.VaultShares.Where(s => s.CollectionId == id).ToListAsync(ct));
        db.VaultCollections.Remove(c);
        recorder.Audit("vault.collection_deleted", "VaultCollection", c.Id, new { c.Name });
        await db.SaveChangesAsync(ct);
    }

    public async Task<VaultCollectionDto> CollectionDtoAsync(Guid id, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (c, access) = await CollectionAsync(id, VaultAccess.UseOnly, ct);
        var items = await db.VaultItems.AsNoTracking().Where(i => i.CollectionId == id && i.DeletedAt == null).ToListAsync(ct);
        var reused = ReusedSet(items.Where(i => !i.Sealed));
        var shares = access == VaultAccess.Manage ? await SharesAsync(c, ct) : null;
        var pName = c.ProjectId is { } p ? await db.Projects.AsNoTracking().Where(x => x.Id == p).Select(x => x.Name).FirstOrDefaultAsync(ct) : null;
        var tName = c.TeamId is { } t ? await db.Teams.AsNoTracking().Where(x => x.Id == t).Select(x => x.Name).FirstOrDefaultAsync(ct) : null;
        return new VaultCollectionDto(c.Id, c.Name, c.Description, c.Kind, c.ProjectId, pName, c.TeamId, tName, access, items.Count, items.Count(i => HealthOf(i, reused).Count > 0),
            c.RequireStepUp, c.RotateEveryDays, c.LockedAt != null, shares, c.Sealed, c.RekeyNeeded, c.SealedKeyVersion, c.RequireApproval, c.Requestable);
    }

    private async Task<List<VaultShareDto>> SharesAsync(VaultCollection c, CancellationToken ct)
    {
        var rows = await db.VaultShares.AsNoTracking().Where(s => s.CollectionId == c.Id).OrderByDescending(s => s.Access).ToListAsync(ct);
        var people = rows.Where(r => r.PrincipalType == VaultPrincipal.User && r.PrincipalId != null).Select(r => r.PrincipalId!.Value).ToList();
        var teams = rows.Where(r => r.PrincipalType == VaultPrincipal.Team && r.PrincipalId != null).Select(r => r.PrincipalId!.Value).ToList();
        var projs = rows.Where(r => r.PrincipalType == VaultPrincipal.Project && r.PrincipalId != null).Select(r => r.PrincipalId!.Value).ToList();
        var pn = people.Count == 0 ? [] : await db.Users.AsNoTracking().Where(u => people.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        var tn = teams.Count == 0 ? [] : await db.Teams.AsNoTracking().Where(x => teams.Contains(x.Id)).ToDictionaryAsync(x => x.Id, x => x.Name, ct);
        var prn = projs.Count == 0 ? [] : await db.Projects.AsNoTracking().Where(x => projs.Contains(x.Id)).ToDictionaryAsync(x => x.Id, x => x.Name, ct);
        return rows.Select(r => new VaultShareDto(r.Id, r.PrincipalType, r.PrincipalId, r.Role, r.PrincipalType switch
        {
            VaultPrincipal.User => r.PrincipalId is { } u ? pn.GetValueOrDefault(u) ?? "Former member" : "?",
            VaultPrincipal.Team => r.PrincipalId is { } t ? $"Team {tn.GetValueOrDefault(t) ?? "?"}" : "?",
            VaultPrincipal.Project => r.PrincipalId is { } p ? $"Everyone in {prn.GetValueOrDefault(p) ?? "a project"}" : "?",
            _ => $"Every {r.Role} and above",
        }, r.Access, r.ExpiresAt)).ToList();
    }

    /// <summary>Replaces a collection's access list. It can never be left without someone who manages it, and people given access are told.</summary>
    public async Task<VaultCollectionDto> SaveSharesAsync(Guid id, SaveVaultSharesRequest req, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (tid, me) = Who();
        var (c, _) = await CollectionAsync(id, VaultAccess.Manage, ct);
        if (c.Kind == VaultCollectionKind.Personal) throw new ConflictException("Your own vault is yours alone. Move items to a shared collection to share them.", "VAULT_PERSONAL");
        var list = (req.Shares ?? []).Take(100).ToList();
        foreach (var s in list)
        {
            if (!Enum.IsDefined(s.PrincipalType) || !Enum.IsDefined(s.Access) || s.Access == VaultAccess.None) throw new ValidationException("shares", "Each entry needs who and what access.");
            if (s.PrincipalType == VaultPrincipal.Role ? s.Role is null or TenantRole.Guest : s.PrincipalId is null) throw new ValidationException("shares", "Choose the person, team, project or role.");
            if (s.ExpiresAt is { } e && e <= clock.Now) throw new ValidationException("shares", "An end date must be in the future.");
            if (c.Sealed && s.Access == VaultAccess.UseOnly) throw new ValidationException("shares", "A sealed collection cannot have use-only access: whoever holds its key can read the values. Use a guarded collection for that.");
        }
        var managers = list.Where(s => s.Access == VaultAccess.Manage && (s.ExpiresAt is null)).ToList();
        if (managers.Count == 0) throw new ConflictException("Keep at least one person or group who manages the collection without an end date.", "VAULT_NO_MANAGER");
        // People must be in this workspace; teams and projects must exist here.
        var userIds = list.Where(s => s.PrincipalType == VaultPrincipal.User).Select(s => s.PrincipalId!.Value).Distinct().ToList();
        var known = await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid && userIds.Contains(m.UserId) && m.Role != TenantRole.Guest).Select(m => m.UserId).ToListAsync(ct);
        if (known.Count != userIds.Count) throw new ValidationException("shares", "Share only with members of this workspace (guests cannot use the vault).");
        var teamIds = list.Where(s => s.PrincipalType == VaultPrincipal.Team).Select(s => s.PrincipalId!.Value).Distinct().ToList();
        if (teamIds.Count > 0 && await db.Teams.CountAsync(t => teamIds.Contains(t.Id), ct) != teamIds.Count) throw new ValidationException("shares", "One of the teams was not found.");
        var projIds = list.Where(s => s.PrincipalType == VaultPrincipal.Project).Select(s => s.PrincipalId!.Value).Distinct().ToList();
        if (projIds.Count > 0 && await projects.VisibleProjects().CountAsync(p => projIds.Contains(p.Id), ct) != projIds.Count) throw new ValidationException("shares", "One of the projects was not found.");

        var old = await db.VaultShares.Where(s => s.CollectionId == id).ToListAsync(ct);
        var before = old.Select(o => new { o.PrincipalType, o.PrincipalId, o.Role, o.Access, o.ExpiresAt }).ToList();
        db.VaultShares.RemoveRange(old);
        foreach (var s in list)
            db.VaultShares.Add(new VaultShare { TenantId = tid, CollectionId = id, PrincipalType = s.PrincipalType, PrincipalId = s.PrincipalType == VaultPrincipal.Role ? null : s.PrincipalId,
                Role = s.PrincipalType == VaultPrincipal.Role ? s.Role : null, Access = Cap(s.Access), ExpiresAt = s.ExpiresAt, CreatedAt = clock.Now, CreatedBy = me });
        recorder.Audit("vault.access_changed", "VaultCollection", id, before, list.Select(s => new { s.PrincipalType, s.PrincipalId, s.Role, s.Access, s.ExpiresAt }));
        if (c.Sealed)
        {
            // Whoever lost access loses their copy of the key now, and the collection gets a new key the next time a manager opens it.
            await db.SaveChangesAsync(ct);
            await DropStaleEnvelopesAsync(c, await AccessByUserAsync(c, ct), ct);
        }
        var sender = await db.Users.AsNoTracking().Where(u => u.Id == me).Select(u => u.DisplayName).FirstOrDefaultAsync(ct) ?? "Someone";
        foreach (var u in userIds.Where(u => u != me && !old.Any(o => o.PrincipalType == VaultPrincipal.User && o.PrincipalId == u)))
            await notifications.AddAsync(u, NotificationType.Security, $"{sender} gave you access to the vault collection {c.Name}", "Every use of it is recorded.", $"/vault?c={c.Id}", ct: ct);
        await db.SaveChangesAsync(ct);
        return await CollectionDtoAsync(id, ct);
    }

    /// <summary>
    /// Break-glass for vault admins: a day of managing access to a shared collection they are not on, after a fresh two-step check and with a
    /// reason. Everyone who manages it is told. A personal collection is never opened this way.
    /// </summary>
    public async Task<VaultCollectionDto> AdminAccessAsync(Guid id, VaultAdminAccessRequest req, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (tid, me) = Who();
        await permissions.RequireAsync(Permissions.VaultAdmin, ct);
        var c = await db.VaultCollections.FirstOrDefaultAsync(x => x.Id == id, ct) ?? throw new NotFoundException("Collection not found.", "VAULT_NOT_FOUND");
        if (c.Kind == VaultCollectionKind.Personal || c.LockedAt is not null) throw new ForbiddenException("A personal vault is its owner's alone.", "VAULT_PERSONAL");
        var reason = (req.Reason ?? "").Trim();
        if (reason.Length < 10) throw new ValidationException("reason", "Say why you need access (at least a sentence). The people who manage it will read it.");
        if (!await stepUp.IsFreshAsync(me, req.StepUp, ct)) throw new ForbiddenException("Confirm with your authenticator first.", "STEP_UP_REQUIRED");
        var until = clock.Now.AddHours(24);
        db.VaultShares.Add(new VaultShare { TenantId = tid, CollectionId = id, PrincipalType = VaultPrincipal.User, PrincipalId = me, Access = VaultAccess.Manage, ExpiresAt = until, CreatedAt = clock.Now, CreatedBy = me });
        recorder.Audit("vault.admin_access", "VaultCollection", id, null, new { reason = Clip(reason, 500), until });
        var sender = await db.Users.AsNoTracking().Where(u => u.Id == me).Select(u => u.DisplayName).FirstOrDefaultAsync(ct) ?? "An admin";
        var shares = await db.VaultShares.AsNoTracking().Where(s => s.CollectionId == id && s.Access == VaultAccess.Manage && s.PrincipalType == VaultPrincipal.User && s.PrincipalId != me).Select(s => s.PrincipalId!.Value).ToListAsync(ct);
        foreach (var u in shares.Distinct())
            await notifications.AddAsync(u, NotificationType.Security, $"{sender} took admin access to {c.Name} for 24 hours", $"Reason: {Clip(reason, 200)}", $"/vault?c={c.Id}", ct: ct);
        await db.SaveChangesAsync(ct);
        return await CollectionDtoAsync(id, ct);
    }

    // ------------------------------------------------------------------ items

    public async Task<IReadOnlyList<VaultItemSummaryDto>> ItemsAsync(Guid? collectionId, string? q, VaultItemKind? kind, string? health, bool bin = false, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var reach = await ReachableAsync(ct);
        if (collectionId is { } cid) reach = reach.Where(r => r.C.Id == cid).ToList();
        if (bin) reach = reach.Where(r => r.A == VaultAccess.Manage).ToList();
        var ids = reach.Select(r => r.C.Id).ToList();
        if (ids.Count == 0) return [];
        var rows = await db.VaultItems.AsNoTracking().Where(i => ids.Contains(i.CollectionId) && !i.Sealed && (bin ? i.DeletedAt != null : i.DeletedAt == null)).ToListAsync(ct);
        var reused = ReusedSet(rows);
        var text = (q ?? "").Trim();
        var list = rows.Where(i => kind is null || i.Kind == kind)
            .Where(i => text.Length == 0 || Contains(i.Title, text) || Contains(i.Url, text) || Contains(i.UsernameHint, text) || Contains(i.Tags, text))
            .Select(i => Summary(i, reach.First(r => r.C.Id == i.CollectionId), reused, null)).ToList();
        if (!string.IsNullOrWhiteSpace(health)) list = list.Where(i => health == "any" ? i.Health.Count > 0 : i.Health.Contains(health)).ToList();
        var owners = list.Where(i => i.Owner != null).Select(i => i.Owner!.Id).Distinct().ToList();
        var names = owners.Count == 0 ? [] : await db.Users.AsNoTracking().Where(u => owners.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        return list.Select(i => i.Owner is { } o ? i with { Owner = new UserRefDto(o.Id, names.GetValueOrDefault(o.Id) ?? "Former member") } : i)
            .OrderByDescending(i => i.Health.Count > 0).ThenBy(i => i.Title, StringComparer.OrdinalIgnoreCase).Take(1000).ToList();
    }

    private static bool Contains(string? hay, string needle) => hay is not null && hay.Contains(needle, StringComparison.OrdinalIgnoreCase);

    private VaultItemSummaryDto Summary(VaultItem i, (VaultCollection C, VaultAccess A) r, HashSet<Guid> reused, string? ownerName) =>
        new(i.Id, i.CollectionId, r.C.Name, i.Kind, i.Title, i.Url, i.UsernameHint, SplitTags(i.Tags), i.Class, i.UseOnly,
            i.OwnerUserId is { } o ? new UserRefDto(o, ownerName ?? "") : null, i.HasTotp, i.Strength, i.BreachCount is > 0, reused.Contains(i.Id),
            i.ExpiresAt, i.ExpiresAt is { } e && e <= clock.Now, i.RotationReason, i.ValueChangedAt, i.LastUsedAt, r.A, HealthOf(i, reused));

    private static IReadOnlyList<string> SplitTags(string? tags) => (tags ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    public async Task<VaultItemDto> GetAsync(Guid id, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (tid, _) = Who();
        var (item, c, access) = await ItemAsync(id, VaultAccess.UseOnly, ct, includeBin: true);
        if (item.DeletedAt is not null && access < VaultAccess.Manage) throw new NotFoundException("Item not found.", "VAULT_NOT_FOUND");
        RejectSealed(item);
        var defs = ReadDefs(item.FieldsJson);
        Dictionary<string, string> values;
        try { values = await crypto.OpenAsync(tid, item.Id, item.Cipher, item.WrappedItemKey, item.KeyVersion, ct); }
        catch (Exception e) when (e is CryptographicException or FormatException or InvalidOperationException or JsonException) { values = []; }
        // Only fields that are not secret travel with the item (a user name, a host); secret ones come one at a time through a reveal.
        var fields = defs.Select(d => new VaultFieldDto(d.Key, d.Label, d.Type, d.Secret, d.Secret ? null : values.GetValueOrDefault(d.Key))).ToList();
        // "Reused" only counts items this person can open: it must never hint that someone else's vault holds the same password.
        var reachable = item.PasswordFingerprint is null ? [] : (await ReachableAsync(ct)).Select(r => r.C.Id).ToList();
        var siblings = reachable.Count == 0 ? [] : await db.VaultItems.AsNoTracking().Where(i => i.PasswordFingerprint != null && i.PasswordFingerprint == item.PasswordFingerprint && i.Id != item.Id
            && i.DeletedAt == null && reachable.Contains(i.CollectionId)).Select(i => i.Id).Take(1).ToListAsync(ct);
        var reused = siblings.Count > 0 ? new HashSet<Guid> { item.Id } : [];
        var people = new List<Guid?> { item.OwnerUserId, item.CreatedBy }.Where(x => x != null).Select(x => x!.Value).ToList();
        var versions = access == VaultAccess.Manage ? await db.VaultItemVersions.AsNoTracking().Where(v => v.ItemId == id).OrderByDescending(v => v.CreatedAt).Take(MaxVersions).ToListAsync(ct) : [];
        people.AddRange(versions.Where(v => v.CreatedBy != null).Select(v => v.CreatedBy!.Value));
        var names = await db.Users.AsNoTracking().Where(u => people.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        UserRefDto? Ref(Guid? u) => u is { } x ? new UserRefDto(x, names.GetValueOrDefault(x) ?? "Former member") : null;
        var files = await db.VaultAttachments.AsNoTracking().Where(a => a.ItemId == id).OrderBy(a => a.CreatedAt)
            .Select(a => new VaultAttachmentDto(a.Id, a.FileName, a.ContentType, a.SizeBytes, a.CreatedAt)).ToListAsync(ct);
        var policy = await PolicyAsync(ct);
        var summary = Summary(item, (c, access), reused, item.OwnerUserId is { } o ? names.GetValueOrDefault(o) : null);
        return new VaultItemDto(summary, fields, ReadLinks(item.LinksJson), versions.Select(v => new VaultVersionDto(v.Id, v.CreatedAt, Ref(v.CreatedBy), v.Reason)).ToList(), files,
            CanReveal: access >= VaultAccess.View && !item.UseOnly, CanCopy: access >= VaultAccess.UseOnly, CanManage: access == VaultAccess.Manage,
            NeedsStepUp: NeedsStepUp(item, c, policy), item.RotateEveryDays, item.CreatedAt, Ref(item.CreatedBy));
    }

    public async Task<VaultItemDto> CreateItemAsync(SaveVaultItemRequest req, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (tid, me) = Who();
        var (c, _) = await CollectionAsync(req.CollectionId, VaultAccess.Manage, ct);
        if (c.Sealed) throw new ConflictException("This collection is sealed: items are encrypted in your browser.", "VAULT_SEALED");
        if (await db.VaultItems.CountAsync(i => i.CollectionId == c.Id && i.DeletedAt == null, ct) >= MaxItemsPerCollection)
            throw new ValidationException("collectionId", $"A collection holds at most {MaxItemsPerCollection:N0} items.");
        var item = new VaultItem { TenantId = tid, CollectionId = c.Id, CreatedAt = clock.Now, CreatedBy = me, OwnerUserId = me };
        var (defs, values) = Merge(req, null, []);
        await ApplyAsync(item, c, req, defs, values, true, ct);
        db.VaultItems.Add(item);
        recorder.Audit("vault.item_created", "VaultItem", item.Id, null, new { item.Title, collection = c.Name, kind = item.Kind.ToString(), item.Class, item.UseOnly });
        await db.SaveChangesAsync(ct);
        return await GetAsync(item.Id, ct);
    }

    public async Task<VaultItemDto> UpdateItemAsync(Guid id, SaveVaultItemRequest req, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (tid, me) = Who();
        var (item, c, _) = await ItemAsync(id, VaultAccess.Manage, ct);
        RejectSealed(item);
        if (req.CollectionId != item.CollectionId)
        {
            // Moving it: the person must manage both collections. Moving out of a personal vault shares it, which is what they asked for.
            var (target, _) = await CollectionAsync(req.CollectionId, VaultAccess.Manage, ct);
            if (target.Sealed) throw new ConflictException("Seal it by copying it into the sealed collection (it is encrypted in your browser there).", "VAULT_SEALED");
            recorder.Audit("vault.item_moved", "VaultItem", item.Id, new { from = c.Name }, new { to = target.Name });
            item.CollectionId = target.Id; c = target;
        }
        var old = await crypto.OpenAsync(tid, item.Id, item.Cipher, item.WrappedItemKey, item.KeyVersion, ct);
        var (defs, values) = Merge(req, ReadDefs(item.FieldsJson), old);
        var secretChanged = defs.Where(d => d.Secret).Any(d => values.GetValueOrDefault(d.Key) != old.GetValueOrDefault(d.Key))
            || old.Keys.Except(values.Keys).Any(k => ReadDefs(item.FieldsJson).Any(d => d.Key == k && d.Secret));
        var anyChanged = secretChanged || values.Count != old.Count || values.Any(kv => old.GetValueOrDefault(kv.Key) != kv.Value);
        if (secretChanged)
        {
            db.VaultItemVersions.Add(new VaultItemVersion { TenantId = tid, ItemId = item.Id, Cipher = item.Cipher, WrappedItemKey = item.WrappedItemKey, KeyVersion = item.KeyVersion,
                Reason = Clip(req.Reason, 200) ?? (item.RotationReason is not null ? "Changed after: " + item.RotationReason : "Changed"), CreatedAt = clock.Now, CreatedBy = me });
            var extra = await db.VaultItemVersions.Where(v => v.ItemId == item.Id).OrderByDescending(v => v.CreatedAt).Skip(MaxVersions - 1).ToListAsync(ct);
            db.VaultItemVersions.RemoveRange(extra);   // the oldest ones go, and their keys with them
        }
        var before = new { item.Title, item.Class, item.UseOnly, item.OwnerUserId, item.ExpiresAt };
        await ApplyAsync(item, c, req, defs, values, anyChanged, ct, secretChanged);
        item.UpdatedAt = clock.Now; item.UpdatedBy = me;
        recorder.Audit("vault.item_changed", "VaultItem", item.Id, before, new { item.Title, item.Class, item.UseOnly, item.OwnerUserId, item.ExpiresAt, valueChanged = secretChanged });
        await db.SaveChangesAsync(ct);
        return await GetAsync(item.Id, ct);
    }

    /// <summary>The item's fields after this request: the kind's fields and any added ones, with values typed now or kept from before.</summary>
    private (List<FieldDef> Defs, Dictionary<string, string> Values) Merge(SaveVaultItemRequest req, List<FieldDef>? existing, Dictionary<string, string> old)
    {
        if (!Enum.IsDefined(req.Kind)) throw new ValidationException("kind", "Choose what kind of item this is.");
        var input = (req.Fields ?? []).ToList();
        if (input.Count > MaxFields) throw new ValidationException("fields", $"An item has at most {MaxFields} fields.");
        var defs = new List<FieldDef>();
        foreach (var t in Template[req.Kind]) defs.Add(t);
        foreach (var f in input)
        {
            var key = (f.Key ?? "").Trim();
            if (!FieldKey().IsMatch(key)) throw new ValidationException("fields", "A field's key is letters and numbers only.");
            if (defs.Any(d => d.Key == key)) continue;
            var type = Types.Contains(f.Type ?? "") ? f.Type! : (f.Secret ? "password" : "text");
            var label = Clip(f.Label, 60) ?? key;
            defs.Add(new FieldDef(key, label, type, f.Secret || type is "password" or "totp" or "key"));
        }
        var values = new Dictionary<string, string>();
        foreach (var d in defs)
        {
            var f = input.FirstOrDefault(x => x.Key == d.Key);
            string? v = f is null || f.Keep ? old.GetValueOrDefault(d.Key) : f.Value;
            if (v is { Length: > MaxValueChars }) throw new ValidationException("fields", $"A value can be up to {MaxValueChars:N0} characters.");
            if (d.Type == "totp" && !string.IsNullOrWhiteSpace(v) && VaultTotp.Parse(v) is null)
                throw new ValidationException("fields", "That one-time-code secret is not valid. Paste the setup key (letters A-Z and 2-7) or the otpauth:// address.");
            if (!string.IsNullOrEmpty(v)) values[d.Key] = v;
        }
        // Fields with nothing in them and not part of the kind are dropped.
        defs = defs.Where(d => Template[req.Kind].Any(t => t.Key == d.Key) || values.ContainsKey(d.Key)).ToList();
        _ = existing;
        return (defs, values);
    }

    private async Task ApplyAsync(VaultItem item, VaultCollection c, SaveVaultItemRequest req, List<FieldDef> defs, Dictionary<string, string> values, bool reseal, CancellationToken ct, bool secretChanged = true)
    {
        var (tid, _) = Who();
        var title = (req.Title ?? "").Trim();
        if (title.Length is 0 or > 120) throw new ValidationException("title", "Name it (up to 120 characters), for example \"AWS root account\".");
        if (!Enum.IsDefined(req.Class)) throw new ValidationException("class", "Choose how it is protected.");
        var url = Clip(req.Url, 500);
        if (url is not null && !Uri.TryCreate(url.Contains("://") ? url : "https://" + url, UriKind.Absolute, out _)) throw new ValidationException("url", "That address does not look right.");
        if (req.OwnerUserId is { } owner && !await db.TenantMembers.AnyAsync(m => m.TenantId == tid && m.UserId == owner && m.Role != TenantRole.Guest, ct))
            throw new ValidationException("ownerUserId", "The owner must be a member of this workspace.");
        var tags = (req.Tags ?? []).Select(t => t.Trim()).Where(t => t.Length is > 0 and <= 30 && !t.Contains(',')).Distinct(StringComparer.OrdinalIgnoreCase).Take(10).ToList();
        var links = (req.Links ?? []).Where(l => l.Kind is "task" or "document" or "project" or "work").Take(20).Select(l => new VaultLinkDto(l.Kind, l.Id, Clip(l.Label, 80) ?? "")).ToList();

        item.Kind = req.Kind; item.Title = title; item.Url = url; item.Tags = tags.Count == 0 ? null : string.Join(",", tags);
        item.Class = req.Class; item.UseOnly = req.UseOnly; item.OwnerUserId = req.OwnerUserId ?? item.OwnerUserId;
        item.LinksJson = JsonSerializer.Serialize(links, Json);
        item.FieldsJson = JsonSerializer.Serialize(defs.Select(d => new { key = d.Key, label = d.Label, type = d.Type, secret = d.Secret }), Json);
        item.UsernameHint = Hint(values.GetValueOrDefault("username") ?? values.GetValueOrDefault("holder"));
        item.HasTotp = defs.Any(d => d.Type == "totp" && values.ContainsKey(d.Key));
        item.RotateEveryDays = CleanDays(req.RotateEveryDays) ?? c.RotateEveryDays;
        if (reseal)
        {
            var sealedValue = await crypto.SealAsync(tid, item.Id, values, ct);
            item.Cipher = sealedValue.Cipher; item.WrappedItemKey = sealedValue.WrappedKey; item.KeyVersion = sealedValue.KeyVersion;
        }
        if (secretChanged)
        {
            item.ValueChangedAt = clock.Now; item.RotationReason = null; item.ExpiryNotifiedAt = null;
            var password = values.GetValueOrDefault("password") ?? values.GetValueOrDefault("key") ?? values.GetValueOrDefault("pin");
            if (password is not null)
            {
                item.Strength = PasswordStrength.Score(password);
                item.PasswordFingerprint = await crypto.FingerprintAsync(tid, password, ct);
                item.BreachCount = await breaches.TimesSeenAsync(password, ct); item.BreachCheckedAt = clock.Now;
            }
            else { item.Strength = null; item.PasswordFingerprint = null; item.BreachCount = null; item.BreachCheckedAt = null; }
        }
        // An end date typed by hand wins; otherwise the rotation rule sets it from the last change.
        item.ExpiresAt = req.ExpiresAt is { } exp ? DateTime.SpecifyKind(exp, DateTimeKind.Utc)
            : item.RotateEveryDays is { } days && item.ValueChangedAt is { } changed ? changed.AddDays(days) : null;
    }

    public async Task DeleteItemAsync(Guid id, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (item, c, _) = await ItemAsync(id, VaultAccess.Manage, ct);
        item.DeletedAt = clock.Now; item.DeletedBy = ctx.UserId;
        recorder.Audit("vault.item_deleted", "VaultItem", item.Id, new { item.Title, collection = c.Name });
        await db.SaveChangesAsync(ct);
    }

    public async Task<VaultItemDto?> RestoreItemAsync(Guid id, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (item, c, _) = await ItemAsync(id, VaultAccess.Manage, ct, includeBin: true);
        item.DeletedAt = null; item.DeletedBy = null;
        recorder.Audit("vault.item_restored", "VaultItem", item.Id, null, new { item.Title, collection = c.Name });
        await db.SaveChangesAsync(ct);
        return item.Sealed ? null : await GetAsync(id, ct);
    }

    // ------------------------------------------------------------------ revealing, copying, one-time codes

    /// <summary>
    /// Releases one field's value. A copy is allowed to a use-only share or item (the screen puts it on the clipboard without showing it);
    /// showing needs view access and an item that is not use-only.
    /// </summary>
    public async Task<VaultRevealDto> RevealAsync(Guid id, VaultRevealRequest req, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (tid, me) = Who();
        var (item, c, access) = await ItemAsync(id, VaultAccess.UseOnly, ct);
        RejectSealed(item);
        var key = (req.Field ?? "").Trim();
        await TripwireAsync(item, c, key, ct);
        var def = ReadDefs(item.FieldsJson).FirstOrDefault(d => d.Key == key) ?? throw new NotFoundException("That field is not on this item.", "VAULT_NOT_FOUND");
        var action = req.Copy ? "vault.copied" : "vault.revealed";
        if (!req.Copy && (item.UseOnly || access < VaultAccess.View))
            throw await DenyAsync(item, c, key, item.UseOnly ? "use only" : "use-only access",
                new ForbiddenException(item.UseOnly ? "This item is use-only: it can be copied into a form but never shown." : "Your access lets you copy this value, not see it.", "VAULT_USE_ONLY"), ct);
        await GuardAsync(item, c, key, req.StepUp, ct);

        string? value;
        try { value = (await crypto.OpenAsync(tid, item.Id, item.Cipher, item.WrappedItemKey, item.KeyVersion, ct)).GetValueOrDefault(key); }
        catch (Exception e) when (e is CryptographicException or FormatException or InvalidOperationException or JsonException)
        {
            recorder.Audit("vault.unreadable", "VaultItem", item.Id, null, new { item.Title, item.KeyVersion });
            await db.SaveChangesAsync(ct);
            throw new ConflictException("This item cannot be read (its key or data is damaged). Enter the value again.", "VAULT_UNREADABLE");
        }
        if (string.IsNullOrEmpty(value)) throw new NotFoundException("That field is empty.", "VAULT_EMPTY");
        item.LastUsedAt = clock.Now; item.LastUsedBy = me;
        // The app shows a value only in the edit screen (to someone who can manage the item); everywhere else it is copied, never drawn.
        recorder.Audit(action, "VaultItem", item.Id, null, new { item = item.Title, collection = c.Name, field = def.Label, risk = _risk?.Score, inEditor = !req.Copy && req.ForEdit && access == VaultAccess.Manage });
        await db.SaveChangesAsync(ct);
        var policy = await PolicyAsync(ct);
        return new VaultRevealDto(value, policy.RevealSeconds, policy.ClipboardSeconds);
    }

    /// <summary>The current one-time code (the seed never leaves the server for this).</summary>
    public async Task<VaultTotpDto> TotpAsync(Guid id, VaultStepUpRequest req, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (tid, me) = Who();
        var (item, c, _) = await ItemAsync(id, VaultAccess.UseOnly, ct);
        RejectSealed(item);
        var def = ReadDefs(item.FieldsJson).FirstOrDefault(d => d.Type == "totp") ?? throw new NotFoundException("This item has no one-time code.", "VAULT_NOT_FOUND");
        await GuardAsync(item, c, def.Key, req.StepUp, ct);
        var seed = (await crypto.OpenAsync(tid, item.Id, item.Cipher, item.WrappedItemKey, item.KeyVersion, ct)).GetValueOrDefault(def.Key);
        var spec = VaultTotp.Parse(seed) ?? throw new ConflictException("The one-time-code secret saved here is not valid. Set it again.", "VAULT_TOTP_INVALID");
        var (code, left) = VaultTotp.Now(spec, clock.Now);
        item.LastUsedAt = clock.Now; item.LastUsedBy = me;
        recorder.Audit("vault.totp_used", "VaultItem", item.Id, null, new { item = item.Title, collection = c.Name });
        await db.SaveChangesAsync(ct);
        return new VaultTotpDto(code, left, spec.Period, spec.Digits);
    }

    /// <summary>An earlier value (managers only, with the same checks, and always a fresh two-step check).</summary>
    public async Task<VaultRevealDto> RevealVersionAsync(Guid id, Guid versionId, VaultRevealRequest req, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (tid, me) = Who();
        var (item, c, _) = await ItemAsync(id, VaultAccess.Manage, ct);
        RejectSealed(item);
        var v = await db.VaultItemVersions.AsNoTracking().FirstOrDefaultAsync(x => x.Id == versionId && x.ItemId == id, ct) ?? throw new NotFoundException("That version was not found.", "VAULT_NOT_FOUND");
        if (!await stepUp.IsFreshAsync(me, req.StepUp, ct))
            throw await DenyAsync(item, c, req.Field ?? "", "earlier value without a two-step check", new ForbiddenException("Earlier values need a fresh two-step check.", "STEP_UP_REQUIRED"), ct);
        await GuardAsync(item, c, req.Field ?? "", req.StepUp, ct);
        var value = (await crypto.OpenAsync(tid, item.Id, v.Cipher, v.WrappedItemKey, v.KeyVersion, ct)).GetValueOrDefault((req.Field ?? "").Trim())
            ?? throw new NotFoundException("That field was empty then.", "VAULT_EMPTY");
        recorder.Audit(req.Copy ? "vault.version_copied" : "vault.version_revealed", "VaultItem", item.Id, null, new { item = item.Title, collection = c.Name, field = req.Field, version = v.CreatedAt });
        await db.SaveChangesAsync(ct);
        var policy = await PolicyAsync(ct);
        return new VaultRevealDto(value, policy.RevealSeconds, policy.ClipboardSeconds);
    }

    /// <summary>The checks every release of a value goes through (after access): two-step when asked for, the rate, and unusual activity.</summary>
    private async Task GuardAsync(VaultItem item, VaultCollection c, string field, string? stepUpToken, CancellationToken ct)
    {
        var (tid, me) = Who();
        await TripwireAsync(item, c, field, ct);
        var policy = await PolicyAsync(ct);
        var fresh = await stepUp.IsFreshAsync(me, stepUpToken, ct);
        if (c.RequireApproval && !await HasApprovalAsync(item, me, ct))
            throw await DenyAsync(item, c, field, "no approval (two-person rule)", new ForbiddenException("Someone else must approve this first (the two-person rule). Ask for access: it ends by itself.", "VAULT_APPROVAL_REQUIRED"), ct);
        if (NeedsStepUp(item, c, policy) && !fresh)
            throw await DenyAsync(item, c, field, "no fresh two-step check", new ForbiddenException("This needs a fresh two-step check. Confirm it is you first.", "STEP_UP_REQUIRED"), ct);
        _risk = await RiskAsync(item, ct);
        if (_risk.Score >= RiskThreshold && !fresh)
            throw await DenyAsync(item, c, field, $"unusual: {Sentence(_risk.Reasons)}", new ForbiddenException($"This looks unusual — {Sentence(_risk.Reasons)}. Confirm it is you.", "STEP_UP_REQUIRED"), ct);
        var minute = clock.Now.AddMinutes(-1);
        if (await db.AuditLogs.CountAsync(a => a.TenantId == tid && a.UserId == me && a.CreatedAt > minute && a.EntityType == "VaultItem" && (UseActions.Contains(a.Action) || a.Action == "vault.reveal_denied"), ct) >= RevealsPerMinute)
            throw new TooManyRequestsException("Too many in a minute. Wait a moment.", "VAULT_LIMITED");
        // Many different items in a few minutes looks like someone emptying the vault: pause until a fresh two-step check, and tell the admins once.
        var window = clock.Now.AddMinutes(-UnusualWindowMinutes);
        var distinct = await db.AuditLogs.Where(a => a.TenantId == tid && a.UserId == me && a.CreatedAt > window && a.EntityType == "VaultItem" && UseActions.Contains(a.Action) && a.EntityId != item.Id)
            .Select(a => a.EntityId).Distinct().CountAsync(ct);
        if (distinct + 1 >= UnusualDistinctItems && !fresh)
        {
            var told = await db.AuditLogs.AnyAsync(a => a.TenantId == tid && a.UserId == me && a.CreatedAt > window && a.Action == "vault.unusual_activity", ct);
            recorder.Audit("vault.unusual_activity", "VaultItem", item.Id, null, new { items = distinct + 1, minutes = UnusualWindowMinutes });
            if (!told) await TellAdminsAsync($"Unusual vault use: {await NameAsync(me, ct)} opened {distinct + 1} items in {UnusualWindowMinutes} minutes", "Further use is paused for them until they confirm with their authenticator.", ct);
            await db.SaveChangesAsync(ct);
            throw new ForbiddenException("That is a lot of items in a few minutes. Confirm with your authenticator to carry on.", "STEP_UP_REQUIRED");
        }
    }

    private async Task<Exception> DenyAsync(VaultItem item, VaultCollection c, string field, string reason, Exception e, CancellationToken ct)
    {
        recorder.Audit("vault.reveal_denied", "VaultItem", item.Id, null, new { item = item.Title, collection = c.Name, field, reason });
        await db.SaveChangesAsync(ct);
        return e;
    }

    private async Task TellAdminsAsync(string title, string body, CancellationToken ct)
    {
        var (tid, me) = Who();
        var admins = await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid && (m.Role == TenantRole.Owner || m.Role == TenantRole.Admin) && m.UserId != me).Select(m => m.UserId).ToListAsync(ct);
        foreach (var a in admins) await notifications.AddAsync(a, NotificationType.Security, title, body, "/vault?tab=access", ct: ct);
    }

    private async Task<string> NameAsync(Guid id, CancellationToken ct) => await db.Users.AsNoTracking().Where(u => u.Id == id).Select(u => u.DisplayName).FirstOrDefaultAsync(ct) ?? "Someone";

    /// <summary>Who did what with an item: reveals, copies, codes, refusals and changes (managers only).</summary>
    public async Task<IReadOnlyList<VaultActivityDto>> ActivityAsync(Guid id, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        await ItemAsync(id, VaultAccess.Manage, ct, includeBin: true);
        var (tenant, _) = Who();
        var rows = await db.AuditLogs.AsNoTracking().Where(a => a.TenantId == tenant && a.EntityType == "VaultItem" && a.EntityId == id).OrderByDescending(a => a.CreatedAt).Take(200)
            .Select(a => new { a.CreatedAt, a.Action, a.UserId, a.NewValue, a.IpAddress }).ToListAsync(ct);
        var ids = rows.Where(r => r.UserId != null).Select(r => r.UserId!.Value).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => ids.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        return rows.Select(r => new VaultActivityDto(r.CreatedAt, r.Action, r.UserId is { } u ? new UserRefDto(u, names.GetValueOrDefault(u) ?? "Former member") : null, FieldOf(r.NewValue), MaskIp(r.IpAddress))).ToList();
    }

    private static string? FieldOf(string? json)
    {
        if (string.IsNullOrEmpty(json)) return null;
        try { using var d = JsonDocument.Parse(json); return d.RootElement.ValueKind == JsonValueKind.Object && d.RootElement.TryGetProperty("field", out var f) && f.ValueKind == JsonValueKind.String ? f.GetString() : null; }
        catch (JsonException) { return null; }
    }

    private static string? MaskIp(string? ip) => ip is null ? null : ip.Contains('.') ? string.Join('.', ip.Split('.').Take(3)) + ".x" : ip.Length > 12 ? ip[..12] + "…" : ip;

    // ------------------------------------------------------------------ attachments

    public async Task<VaultAttachmentDto> AddAttachmentAsync(Guid id, string fileName, string? contentType, Stream content, long length, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (tid, me) = Who();
        var (item, c, _) = await ItemAsync(id, VaultAccess.Manage, ct);
        RejectSealed(item);
        if (length > MaxAttachmentBytes) throw new ValidationException("file", "A file kept in the vault can be up to 2 MB.");
        if (await db.VaultAttachments.CountAsync(a => a.ItemId == id, ct) >= MaxAttachments) throw new ValidationException("file", $"An item keeps at most {MaxAttachments} files.");
        using var ms = new MemoryStream();
        await content.CopyToAsync(ms, ct);
        if (ms.Length > MaxAttachmentBytes) throw new ValidationException("file", "A file kept in the vault can be up to 2 MB.");
        var name = Path.GetFileName((fileName ?? "file").Replace('\\', '/'));
        name = new string(name.Where(ch => !char.IsControl(ch)).ToArray());
        if (name.Length == 0) name = "file";
        if (name.Length > 120) name = name[^120..];
        var att = new VaultAttachment { TenantId = tid, ItemId = id, FileName = name, ContentType = Clip(contentType, 100) ?? "application/octet-stream", SizeBytes = ms.Length,
            WrappedItemKey = item.WrappedItemKey, KeyVersion = item.KeyVersion, CreatedAt = clock.Now, CreatedBy = me };
        att.Cipher = await crypto.SealFileAsync(tid, item.Id, att.Id, item.WrappedItemKey, item.KeyVersion, ms.ToArray(), ct);
        db.VaultAttachments.Add(att);
        recorder.Audit("vault.file_added", "VaultItem", item.Id, null, new { item = item.Title, collection = c.Name, file = name });
        await db.SaveChangesAsync(ct);
        return new VaultAttachmentDto(att.Id, att.FileName, att.ContentType, att.SizeBytes, att.CreatedAt);
    }

    public async Task<(string Name, string Type, byte[] Bytes)> DownloadAttachmentAsync(Guid attachmentId, string? stepUpToken, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (tid, _) = Who();
        var att = await db.VaultAttachments.AsNoTracking().FirstOrDefaultAsync(a => a.Id == attachmentId, ct) ?? throw new NotFoundException("File not found.", "VAULT_NOT_FOUND");
        var (item, c, access) = await ItemAsync(att.ItemId, VaultAccess.View, ct);
        RejectSealed(item);
        if (item.UseOnly) throw new ForbiddenException("Files of a use-only item cannot be downloaded.", "VAULT_USE_ONLY");
        await GuardAsync(item, c, att.FileName, stepUpToken, ct);
        var bytes = await crypto.OpenFileAsync(tid, item.Id, att.Id, att.WrappedItemKey, att.KeyVersion, att.Cipher, ct);
        recorder.Audit("vault.revealed", "VaultItem", item.Id, null, new { item = item.Title, collection = c.Name, field = "file: " + att.FileName });
        await db.SaveChangesAsync(ct);
        _ = access;
        return (att.FileName, att.ContentType, bytes);
    }

    public async Task DeleteAttachmentAsync(Guid attachmentId, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var att = await db.VaultAttachments.FirstOrDefaultAsync(a => a.Id == attachmentId, ct) ?? throw new NotFoundException("File not found.", "VAULT_NOT_FOUND");
        var (item, c, _) = await ItemAsync(att.ItemId, VaultAccess.Manage, ct);
        db.VaultAttachments.Remove(att);
        recorder.Audit("vault.file_removed", "VaultItem", item.Id, null, new { item = item.Title, collection = c.Name, file = att.FileName });
        await db.SaveChangesAsync(ct);
    }

    // ------------------------------------------------------------------ import, checks, policy, access review

    /// <summary>Rows from another password manager's export (Bitwarden, 1Password, LastPass, Chrome), already read in the browser. Each becomes a login.</summary>
    public async Task<VaultImportResult> ImportAsync(VaultImportRequest req, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (tid, me) = Who();
        var (c, _) = await CollectionAsync(req.CollectionId, VaultAccess.Manage, ct);
        if (c.Sealed) throw new ConflictException("This collection is sealed: the import is encrypted in your browser.", "VAULT_SEALED");
        var rows = (req.Rows ?? []).ToList();
        if (rows.Count == 0) throw new ValidationException("rows", "Nothing to import.");
        if (rows.Count > MaxImport) throw new ValidationException("rows", $"Import at most {MaxImport} at once.");
        if (await db.VaultItems.CountAsync(i => i.CollectionId == c.Id && i.DeletedAt == null, ct) + rows.Count > MaxItemsPerCollection)
            throw new ValidationException("rows", $"A collection holds at most {MaxItemsPerCollection:N0} items.");
        int imported = 0, skipped = 0, weak = 0;
        foreach (var r in rows)
        {
            var title = Clip(r.Title, 120) ?? Clip(HostOf(r.Url), 120);
            if (title is null || (string.IsNullOrEmpty(r.Password) && string.IsNullOrEmpty(r.Notes))) { skipped++; continue; }
            var values = new Dictionary<string, string>();
            if (!string.IsNullOrEmpty(r.Username)) values["username"] = Clip(r.Username, 300)!;
            if (!string.IsNullOrEmpty(r.Password)) values["password"] = r.Password.Length > MaxValueChars ? r.Password[..MaxValueChars] : r.Password;
            if (!string.IsNullOrEmpty(r.Totp) && VaultTotp.Parse(r.Totp) is not null) values["totp"] = r.Totp.Trim();
            if (!string.IsNullOrEmpty(r.Notes)) values["note"] = r.Notes.Length > MaxValueChars ? r.Notes[..MaxValueChars] : r.Notes;
            var item = new VaultItem { TenantId = tid, CollectionId = c.Id, Kind = VaultItemKind.Login, Title = title, Url = Clip(r.Url, 500), OwnerUserId = me, CreatedAt = clock.Now, CreatedBy = me,
                FieldsJson = JsonSerializer.Serialize(Template[VaultItemKind.Login].Select(d => new { key = d.Key, label = d.Label, type = d.Type, secret = d.Secret }), Json),
                UsernameHint = Hint(values.GetValueOrDefault("username")), HasTotp = values.ContainsKey("totp"), ValueChangedAt = clock.Now, RotateEveryDays = c.RotateEveryDays };
            var sealedValue = await crypto.SealAsync(tid, item.Id, values, ct);
            item.Cipher = sealedValue.Cipher; item.WrappedItemKey = sealedValue.WrappedKey; item.KeyVersion = sealedValue.KeyVersion;
            if (values.GetValueOrDefault("password") is { } pw)
            {
                item.Strength = PasswordStrength.Score(pw); item.PasswordFingerprint = await crypto.FingerprintAsync(tid, pw, ct);
                if (item.Strength < 2) weak++;
            }
            if (item.RotateEveryDays is { } d) item.ExpiresAt = clock.Now.AddDays(d);
            db.VaultItems.Add(item);   // breach checks run overnight for imported items, so a big import is quick
            imported++;
        }
        recorder.Audit("vault.imported", "VaultCollection", c.Id, null, new { collection = c.Name, imported, skipped });
        await db.SaveChangesAsync(ct);
        return new VaultImportResult(imported, skipped, weak);
    }

    /// <summary>How strong a password is and whether it is in public breaches (k-anonymity), for the generator and the editor. Nothing is kept or logged.</summary>
    public async Task<VaultCheckDto> CheckAsync(VaultCheckRequest req, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var p = req.Password ?? "";
        if (p.Length is 0 or > 500) throw new ValidationException("password", "Enter a password to check.");
        return new VaultCheckDto(PasswordStrength.Score(p), await breaches.TimesSeenAsync(p, ct));
    }

    public async Task<VaultPolicyDto> SavePolicyAsync(VaultPolicyRequest req, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        await permissions.RequireAsync(Permissions.VaultAdmin, ct);
        if (req.ClipboardSeconds is < 10 or > 300) throw new ValidationException("clipboardSeconds", "Clear the clipboard after 10 to 300 seconds.");
        var (tid, _) = Who();
        var s = await db.TenantSecuritySettings.FirstOrDefaultAsync(t => t.TenantId == tid, ct);
        if (s is null) db.TenantSecuritySettings.Add(s = new TenantSecuritySettings { TenantId = tid });
        var before = new { s.VaultStepUpAlways, s.VaultClipboardSeconds, s.VaultSharedAdminsOnly };
        s.VaultStepUpAlways = req.StepUpAlways; s.VaultClipboardSeconds = req.ClipboardSeconds; s.VaultSharedAdminsOnly = req.SharedAdminsOnly;
        recorder.Audit("vault.policy_changed", "Tenant", tid, before, new { req.StepUpAlways, req.ClipboardSeconds, req.SharedAdminsOnly }, tenantId: tid);
        await db.SaveChangesAsync(ct);
        return await PolicyAsync(ct);
    }

    /// <summary>For vault admins: which shared collections a person can open, and what they used in the last 90 days (never personal vaults).</summary>
    public async Task<VaultAccessReviewDto> AccessReviewAsync(Guid userId, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        await permissions.RequireAsync(Permissions.VaultAdmin, ct);
        var (tid, _) = Who();
        var member = await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid && m.UserId == userId).Select(m => new { m.Role, Name = m.User!.DisplayName }).FirstOrDefaultAsync(ct)
            ?? throw new NotFoundException("Member not found.");
        var teams = await db.TeamMembers.AsNoTracking().Where(t => t.UserId == userId).Select(t => t.TeamId).ToListAsync(ct);
        var mine = await db.ProjectMembers.AsNoTracking().Where(p => p.UserId == userId).Select(p => p.ProjectId).ToListAsync(ct);
        var owned = await db.Projects.AsNoTracking().Where(p => p.OwnerId == userId).Select(p => p.Id).ToListAsync(ct);
        var m = new Membership([.. teams], [.. mine, .. owned], member.Role);
        var shared = await db.VaultCollections.AsNoTracking().Where(c => c.Kind != VaultCollectionKind.Personal && c.LockedAt == null && c.ArchivedAt == null).ToListAsync(ct);
        var ids = shared.Select(c => c.Id).ToList();
        var shares = await db.VaultShares.AsNoTracking().Where(s => ids.Contains(s.CollectionId)).ToListAsync(ct);
        var counts = await db.VaultItems.AsNoTracking().Where(i => ids.Contains(i.CollectionId) && i.DeletedAt == null).GroupBy(i => i.CollectionId).Select(g => new { g.Key, N = g.Count() }).ToListAsync(ct);
        var access = shared.Select(c => (c, Evaluate(c, shares, userId, m))).Where(x => x.Item2 > VaultAccess.None)
            .Select(x => new VaultAccessReviewCollection(x.c.Id, x.c.Name, x.Item2, counts.FirstOrDefault(k => k.Key == x.c.Id)?.N ?? 0)).OrderByDescending(x => x.Access).ToList();
        var since = clock.Now.AddDays(-90);
        var used = await db.AuditLogs.AsNoTracking().Where(a => a.TenantId == tid && a.UserId == userId && a.EntityType == "VaultItem" && UseActions.Contains(a.Action) && a.CreatedAt > since && a.EntityId != null)
            .GroupBy(a => a.EntityId!.Value).Select(g => new { Item = g.Key, Times = g.Count(), Last = g.Max(a => a.CreatedAt) }).ToListAsync(ct);
        var itemIds = used.Select(u => u.Item).ToList();
        var items = await db.VaultItems.AsNoTracking().Where(i => itemIds.Contains(i.Id)).Select(i => new { i.Id, i.Title, i.CollectionId }).ToListAsync(ct);
        var usedIn = items.Select(i => i.CollectionId).Distinct().ToList();
        var cNames = await db.VaultCollections.AsNoTracking().Where(c => usedIn.Contains(c.Id)).ToDictionaryAsync(c => c.Id, c => c.Kind == VaultCollectionKind.Personal ? "(their own vault)" : c.Name, ct);
        var useList = used.Select(u => (u, items.FirstOrDefault(i => i.Id == u.Item))).Where(x => x.Item2 is not null)
            .Select(x => new VaultAccessReviewUse(x.u.Item, cNames.GetValueOrDefault(x.Item2!.CollectionId) == "(their own vault)" ? "(a personal item)" : x.Item2.Title,
                cNames.GetValueOrDefault(x.Item2.CollectionId) ?? "", x.u.Times, x.u.Last)).OrderByDescending(x => x.Last).ToList();
        recorder.Audit("vault.access_reviewed", "User", userId, null, new { member.Name });
        await db.SaveChangesAsync(ct);
        return new VaultAccessReviewDto(new UserRefDto(userId, member.Name), access, useList);
    }

    // ------------------------------------------------------------------ small helpers

    private static string CleanName(string? name)
    {
        var n = (name ?? "").Trim();
        if (n.Length is 0 or > 80) throw new ValidationException("name", "Name the collection (up to 80 characters).");
        return n;
    }

    private static int? CleanDays(int? days) => days is null or 0 ? null : days is < 7 or > 1095 ? throw new ValidationException("rotateEveryDays", "Change every 7 to 1095 days, or leave it empty.") : days;

    private static string? Clip(string? s, int max)
    {
        var t = s?.Trim();
        return string.IsNullOrEmpty(t) ? null : t.Length > max ? t[..max] : t;
    }

    /// <summary>"ravi@fivestar.in" → "r***@fivestar.in"; "administrator" → "a***r".</summary>
    public static string? Hint(string? username)
    {
        var u = username?.Trim();
        if (string.IsNullOrEmpty(u)) return null;
        var at = u.IndexOf('@');
        if (at > 0) return u[0] + "***" + u[at..];
        return u.Length <= 2 ? u[0] + "*" : u[0] + "***" + u[^1];
    }

    private static string? HostOf(string? url) => Uri.TryCreate(url?.Contains("://") == true ? url : "https://" + url, UriKind.Absolute, out var u) && !string.IsNullOrEmpty(u.Host) ? u.Host : null;

    private static List<FieldDef> ReadDefs(string json)
    {
        try
        {
            using var d = JsonDocument.Parse(string.IsNullOrEmpty(json) ? "[]" : json);
            return d.RootElement.EnumerateArray().Select(e => new FieldDef(e.GetProperty("key").GetString() ?? "", e.GetProperty("label").GetString() ?? "",
                e.GetProperty("type").GetString() ?? "text", e.GetProperty("secret").GetBoolean())).ToList();
        }
        catch (Exception e) when (e is JsonException or KeyNotFoundException or InvalidOperationException) { return []; }
    }

    private static List<VaultLinkDto> ReadLinks(string json)
    {
        try { return JsonSerializer.Deserialize<List<VaultLinkDto>>(string.IsNullOrEmpty(json) ? "[]" : json, Json) ?? []; }
        catch (JsonException) { return []; }
    }

    [GeneratedRegex("^[A-Za-z][A-Za-z0-9]{0,29}$")] private static partial Regex FieldKey();
}
