using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Vault;

public record VaultRequestDto(Guid Id, VaultRequestKind Kind, Guid CollectionId, string CollectionName, Guid? ItemId, string? ItemTitle, UserRefDto Requester, string Reason,
    VaultAccess Access, int Minutes, VaultRequestStatus Status, UserRefDto? DecidedBy, DateTime? DecidedAt, string? DecisionNote, DateTime? GrantedUntil, DateTime CreatedAt, bool CanDecide);
public record VaultRequestsDto(IReadOnlyList<VaultRequestDto> Mine, IReadOnlyList<VaultRequestDto> ToDecide);
public record VaultRequestableDto(Guid Id, string Name, string? Description, VaultCollectionKind Kind, bool Sealed);
public record VaultRequestInput(string? Reason, int Minutes, VaultAccess Access = VaultAccess.View);
public record VaultDecisionInput(string? Note);
public record VaultRotationRequest(string? Reason);
public record VaultDecoyInput(bool Decoy);
public record VaultDecoyDto(Guid ItemId, string Title, string CollectionName, int Triggered, DateTime? LastTriggeredAt);
public record VaultRisk(int Score, IReadOnlyList<string> Reasons);

/// <summary>
/// The controls around guarded values: decoys that raise the alarm when touched, the two-person rule with time-boxed approvals, just-in-time
/// access to collections, and a risk score (a new network, a new browser, the middle of the night, a first use) that asks for a fresh check.
/// </summary>
public partial class VaultService
{
    public static readonly int[] RevealMinutes = [15, 30, 60, 240];
    public static readonly int[] CollectionMinutes = [60, 240, 1440, 10080];
    public const int RiskThreshold = 50;
    private static readonly string[] NotHistory = ["vault.reveal_denied", "vault.unusual_activity", "vault.decoy_triggered"];
    private bool _tripped;
    private VaultRisk? _risk;

    // ------------------------------------------------------------------ decoys

    /// <summary>Touching a decoy: recorded, the admins told at once (and a webhook), and the request goes on as if it were real.</summary>
    private async Task TripwireAsync(VaultItem item, VaultCollection c, string field, CancellationToken ct)
    {
        if (!item.Decoy || _tripped) return;
        _tripped = true;
        var (tid, me) = Who();
        var who = await NameAsync(me, ct);
        recorder.Audit("vault.decoy_triggered", "VaultItem", item.Id, null, new { item = item.Title, collection = c.Name, field, ip = ctx.IpAddress, userAgent = Clip(ctx.UserAgent, 200) });
        db.Activities.Add(new Activity { TenantId = tid, ActorId = me, Action = "vault.decoy_triggered", EntityType = "VaultItem", EntityId = item.Id,
            Summary = $"Decoy credential “{item.Title}” in {c.Name} was used by {who}", IpAddress = ctx.IpAddress, CreatedAt = clock.Now });
        var admins = await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid && (m.Role == TenantRole.Owner || m.Role == TenantRole.Admin)).Select(m => m.UserId).ToListAsync(ct);
        // Told at once, then at most once an hour per person and decoy (every touch is still in the audit trail).
        var key = $"vault-decoy:{item.Id}:{me}:{clock.Now:yyyyMMddHH}";
        if (!await db.Notifications.AnyAsync(n => n.DedupeKey == key, ct))
            foreach (var a in admins)
                await notifications.AddAsync(a, NotificationType.Security, $"Decoy credential used: {who} opened “{item.Title}”", $"In {c.Name}{(ctx.IpAddress is { } ip ? $" from {ip}" : "")}. Nobody has a reason to use it: check what else they did.",
                    "/vault?view=admin", dedupeKey: key, toSelf: true, ct: ct);
        await db.SaveChangesAsync(ct);
    }

    public async Task<VaultDecoyDto> SetDecoyAsync(Guid id, VaultDecoyInput req, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        await permissions.RequireAsync(Permissions.VaultAdmin, ct);
        var (item, c, _) = await ItemAsync(id, VaultAccess.Manage, ct);
        RejectSealed(item);   // a sealed collection is fetched whole, so the server cannot tell which item was opened
        item.Decoy = req.Decoy;
        recorder.Audit(req.Decoy ? "vault.decoy_set" : "vault.decoy_cleared", "VaultItem", item.Id, null, new { item.Title, collection = c.Name });
        await db.SaveChangesAsync(ct);
        return (await DecoysAsync(ct)).FirstOrDefault(d => d.ItemId == id) ?? new VaultDecoyDto(id, item.Title, c.Name, 0, null);
    }

    /// <summary>For vault admins only: which items are decoys and how often they were touched. Nobody else can tell them apart.</summary>
    public async Task<IReadOnlyList<VaultDecoyDto>> DecoysAsync(CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        await permissions.RequireAsync(Permissions.VaultAdmin, ct);
        var (tid, _) = Who();
        var items = await db.VaultItems.AsNoTracking().Where(i => i.Decoy && i.DeletedAt == null).Select(i => new { i.Id, i.Title, i.CollectionId }).ToListAsync(ct);
        var ids = items.Select(i => i.Id).ToList();
        var cols = items.Select(i => i.CollectionId).Distinct().ToList();
        var names = await db.VaultCollections.AsNoTracking().Where(c => cols.Contains(c.Id)).ToDictionaryAsync(c => c.Id, c => c.Name, ct);
        var hits = await db.AuditLogs.AsNoTracking().Where(a => a.TenantId == tid && a.Action == "vault.decoy_triggered" && a.EntityId != null && ids.Contains(a.EntityId.Value))
            .GroupBy(a => a.EntityId!.Value).Select(g => new { g.Key, N = g.Count(), Last = g.Max(a => a.CreatedAt) }).ToListAsync(ct);
        return items.Select(i => { var h = hits.FirstOrDefault(x => x.Key == i.Id); return new VaultDecoyDto(i.Id, i.Title, names.GetValueOrDefault(i.CollectionId) ?? "", h?.N ?? 0, h?.Last); }).ToList();
    }

    // ------------------------------------------------------------------ the two-person rule

    private async Task<bool> HasApprovalAsync(VaultItem item, Guid me, CancellationToken ct) =>
        await db.VaultAccessRequests.AnyAsync(r => r.Kind == VaultRequestKind.Reveal && r.ItemId == item.Id && r.RequesterId == me && r.Status == VaultRequestStatus.Approved && r.GrantedUntil > clock.Now, ct);

    // ------------------------------------------------------------------ risk

    /// <summary>
    /// How unusual this use looks for this person, from what the audit trail already knows: a network or browser not seen from them in this
    /// workspace for 90 days, their own night-time hours, and a first use of this item. Judged only once they have a history.
    /// </summary>
    private async Task<VaultRisk> RiskAsync(VaultItem item, CancellationToken ct)
    {
        var (tid, me) = Who();
        var since = clock.Now.AddDays(-90);
        var reasons = new List<string>();
        var score = 0;
        // Refusals do not count as history: otherwise a refused attempt from a new network would make the next one look familiar.
        var history = db.AuditLogs.AsNoTracking().Where(a => a.TenantId == tid && a.UserId == me && a.CreatedAt > since && !NotHistory.Contains(a.Action));
        if (await history.CountAsync(ct) >= 3)
        {
            if (ctx.IpAddress is { } ip && !await history.AnyAsync(a => a.IpAddress == ip, ct)) { score += 40; reasons.Add("a network you have not used here before"); }
            if (ctx.UserAgent is { Length: > 0 } ua && !await history.AnyAsync(a => a.UserAgent == ua, ct)) { score += 20; reasons.Add("a new browser or device"); }
        }
        var zone = await db.Users.AsNoTracking().Where(u => u.Id == me).Select(u => u.TimeZone).FirstOrDefaultAsync(ct);
        var tz = TimeZoneInfo.TryFindSystemTimeZoneById(zone ?? "Asia/Kolkata", out var found) ? found : TimeZoneInfo.Utc;
        var hour = TimeZoneInfo.ConvertTimeFromUtc(clock.Now, tz).Hour;
        if (hour < 6 || hour >= 22) { score += 20; reasons.Add("late at night for you"); }
        if (!await db.AuditLogs.AnyAsync(a => a.TenantId == tid && a.UserId == me && a.EntityId == item.Id && UseActions.Contains(a.Action), ct)) { score += 10; reasons.Add("the first time you use this item"); }
        if (item.Class == SensitivityClass.Confidential) score += 10;
        return new VaultRisk(score, reasons);
    }

    private static string Sentence(IReadOnlyList<string> xs) => xs.Count switch { 0 => "", 1 => xs[0], _ => string.Join(", ", xs.Take(xs.Count - 1)) + " and " + xs[^1] };

    // ------------------------------------------------------------------ just-in-time requests

    private async Task<List<Guid>> DecidersAsync(VaultCollection c, Guid requester, CancellationToken ct)
    {
        var tid = c.TenantId;
        var managers = (await AccessByUserAsync(c, ct)).Where(x => x.Value == VaultAccess.Manage && x.Key != requester).Select(x => x.Key).ToList();
        if (managers.Count > 0) return managers;
        // Nobody else manages it: the workspace's vault admins decide.
        return await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid && (m.Role == TenantRole.Owner || m.Role == TenantRole.Admin) && m.UserId != requester).Select(m => m.UserId).ToListAsync(ct);
    }

    private async Task NotifyDecidersAsync(VaultAccessRequest r, VaultCollection c, string what, CancellationToken ct)
    {
        var who = await NameAsync(r.RequesterId, ct);
        foreach (var u in await DecidersAsync(c, r.RequesterId, ct))
            await notifications.AddAsync(u, NotificationType.Security, $"{who} asks for {what}", $"Reason: {Clip(r.Reason, 200)}", $"/vault?view=requests&request={r.Id}", dedupeKey: $"vault-request:{r.Id}", ct: ct);
    }

    /// <summary>Asks for one use window of an item under the two-person rule.</summary>
    public async Task<VaultRequestDto> RequestRevealAsync(Guid id, VaultRequestInput req, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (tid, me) = Who();
        var (item, c, _) = await ItemAsync(id, VaultAccess.UseOnly, ct);
        RejectSealed(item);
        if (!c.RequireApproval) throw new ConflictException("This item does not need anyone's approval.", "VAULT_NO_APPROVAL");
        if (!RevealMinutes.Contains(req.Minutes)) throw new ValidationException("minutes", "Choose 15, 30, 60 or 240 minutes.");
        var reason = CleanReason(req.Reason);
        var open = await db.VaultAccessRequests.FirstOrDefaultAsync(r => r.Kind == VaultRequestKind.Reveal && r.ItemId == id && r.RequesterId == me && r.Status == VaultRequestStatus.Pending, ct);
        if (open is not null) return await RequestDtoAsync(open, ct);
        var r = new VaultAccessRequest { TenantId = tid, Kind = VaultRequestKind.Reveal, CollectionId = c.Id, ItemId = id, RequesterId = me, Reason = reason, Minutes = req.Minutes, CreatedAt = clock.Now, CreatedBy = me };
        db.VaultAccessRequests.Add(r);
        recorder.Audit("vault.access_requested", "VaultItem", id, null, new { item = item.Title, collection = c.Name, minutes = req.Minutes, reason });
        db.Activities.Add(new Activity { TenantId = tid, ActorId = me, Action = "vault.access_requested", EntityType = "VaultItem", EntityId = id, Summary = $"Access to “{item.Title}” asked for {req.Minutes} minutes", CreatedAt = clock.Now });
        await NotifyDecidersAsync(r, c, $"“{item.Title}” for {req.Minutes} minutes", ct);
        await db.SaveChangesAsync(ct);
        return await RequestDtoAsync(r, ct);
    }

    /// <summary>Collections whose name members may see and ask to join for a while (only the ones they are not on).</summary>
    public async Task<IReadOnlyList<VaultRequestableDto>> RequestableAsync(CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var mine = (await ReachableAsync(ct)).Select(r => r.C.Id).ToHashSet();
        var rows = await db.VaultCollections.AsNoTracking().Where(c => c.Requestable && c.Kind != VaultCollectionKind.Personal && c.LockedAt == null && c.ArchivedAt == null).OrderBy(c => c.Name).ToListAsync(ct);
        return rows.Where(c => !mine.Contains(c.Id)).Select(c => new VaultRequestableDto(c.Id, c.Name, c.Description, c.Kind, c.Sealed)).ToList();
    }

    /// <summary>Asks to be on a requestable collection for a while.</summary>
    public async Task<VaultRequestDto> RequestCollectionAsync(Guid id, VaultRequestInput req, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (tid, me) = Who();
        var c = await db.VaultCollections.FirstOrDefaultAsync(x => x.Id == id && x.Requestable && x.Kind != VaultCollectionKind.Personal && x.LockedAt == null, ct)
            ?? throw new NotFoundException("Collection not found.", "VAULT_NOT_FOUND");
        if (!CollectionMinutes.Contains(req.Minutes)) throw new ValidationException("minutes", "Choose 1 hour, 4 hours, a day or a week.");
        if (req.Access is not (VaultAccess.UseOnly or VaultAccess.View)) throw new ValidationException("access", "Ask for use-only or view access; managing is given by the people who manage it.");
        var access = c.Sealed && req.Access == VaultAccess.UseOnly ? VaultAccess.View : req.Access;
        var reason = CleanReason(req.Reason);
        var open = await db.VaultAccessRequests.FirstOrDefaultAsync(r => r.Kind == VaultRequestKind.Collection && r.CollectionId == id && r.RequesterId == me && r.Status == VaultRequestStatus.Pending, ct);
        if (open is not null) return await RequestDtoAsync(open, ct);
        var r = new VaultAccessRequest { TenantId = tid, Kind = VaultRequestKind.Collection, CollectionId = id, RequesterId = me, Reason = reason, Access = access, Minutes = req.Minutes, CreatedAt = clock.Now, CreatedBy = me };
        db.VaultAccessRequests.Add(r);
        recorder.Audit("vault.access_requested", "VaultCollection", id, null, new { collection = c.Name, access = access.ToString(), minutes = req.Minutes, reason });
        db.Activities.Add(new Activity { TenantId = tid, ActorId = me, Action = "vault.access_requested", EntityType = "VaultCollection", EntityId = id, Summary = $"Access to {c.Name} asked for {Duration(req.Minutes)}", CreatedAt = clock.Now });
        await NotifyDecidersAsync(r, c, $"{access.ToString().ToLowerInvariant()} access to {c.Name} for {Duration(req.Minutes)}", ct);
        await db.SaveChangesAsync(ct);
        return await RequestDtoAsync(r, ct);
    }

    private static string CleanReason(string? reason)
    {
        var t = (reason ?? "").Trim();
        if (t.Length < 10) throw new ValidationException("reason", "Say why (at least a sentence): the person who decides reads it.");
        return t.Length > 500 ? t[..500] : t;
    }
    private static string Duration(int minutes) => minutes switch { < 60 => $"{minutes} minutes", 60 => "an hour", < 1440 => $"{minutes / 60} hours", 1440 => "a day", 10080 => "a week", _ => $"{minutes / 1440} days" };

    public async Task<VaultRequestsDto> RequestsAsync(CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (_, me) = Who();
        await ExpireRequestsAsync(ct);
        var mine = await db.VaultAccessRequests.AsNoTracking().Where(r => r.RequesterId == me).OrderByDescending(r => r.CreatedAt).Take(50).ToListAsync(ct);
        var pending = await db.VaultAccessRequests.AsNoTracking().Where(r => r.Status == VaultRequestStatus.Pending && r.RequesterId != me).OrderBy(r => r.CreatedAt).Take(200).ToListAsync(ct);
        var decide = new List<VaultAccessRequest>();
        foreach (var g in pending.GroupBy(r => r.CollectionId))
        {
            var c = await db.VaultCollections.AsNoTracking().FirstOrDefaultAsync(x => x.Id == g.Key, ct);
            if (c is null) continue;
            var managers = (await AccessByUserAsync(c, ct)).Where(x => x.Value == VaultAccess.Manage).Select(x => x.Key).ToList();
            var admins = await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == c.TenantId && (m.Role == TenantRole.Owner || m.Role == TenantRole.Admin)).Select(m => m.UserId).ToListAsync(ct);
            foreach (var r in g)
            {
                var others = managers.Where(m => m != r.RequesterId).ToList();
                if ((others.Count > 0 ? others : admins.Where(a => a != r.RequesterId).ToList()).Contains(me)) decide.Add(r);
            }
        }
        var dtos = new List<VaultRequestDto>();
        foreach (var r in mine) dtos.Add(await RequestDtoAsync(r, ct, false));
        var toDecide = new List<VaultRequestDto>();
        foreach (var r in decide) toDecide.Add(await RequestDtoAsync(r, ct, true));
        return new VaultRequestsDto(dtos, toDecide);
    }

    private async Task<VaultRequestDto> RequestDtoAsync(VaultAccessRequest r, CancellationToken ct, bool canDecide = false)
    {
        var c = await db.VaultCollections.AsNoTracking().Where(x => x.Id == r.CollectionId).Select(x => x.Name).FirstOrDefaultAsync(ct) ?? "";
        var title = r.ItemId is { } i ? await db.VaultItems.AsNoTracking().Where(x => x.Id == i).Select(x => x.Title).FirstOrDefaultAsync(ct) : null;
        var people = new[] { r.RequesterId, r.DecidedBy ?? Guid.Empty };
        var names = await db.Users.AsNoTracking().Where(u => people.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        return new VaultRequestDto(r.Id, r.Kind, r.CollectionId, c, r.ItemId, title, new UserRefDto(r.RequesterId, names.GetValueOrDefault(r.RequesterId) ?? "Former member"), r.Reason, r.Access, r.Minutes, r.Status,
            r.DecidedBy is { } d ? new UserRefDto(d, names.GetValueOrDefault(d) ?? "Former member") : null, r.DecidedAt, r.DecisionNote, r.GrantedUntil, r.CreatedAt, canDecide && r.Status == VaultRequestStatus.Pending);
    }

    /// <summary>Approve or refuse. Never one's own; only someone who manages the collection (or a vault admin when nobody else does).</summary>
    public async Task<VaultRequestDto> DecideAsync(Guid id, bool approve, VaultDecisionInput req, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (tid, me) = Who();
        var r = await db.VaultAccessRequests.FirstOrDefaultAsync(x => x.Id == id, ct) ?? throw new NotFoundException("Request not found.", "VAULT_NOT_FOUND");
        if (r.RequesterId == me) throw new ForbiddenException("Someone else must decide on your own request.", "VAULT_SELF_APPROVAL");
        if (r.Status != VaultRequestStatus.Pending) throw new ConflictException("That request was already decided.", "VAULT_DECIDED");
        var c = await db.VaultCollections.FirstOrDefaultAsync(x => x.Id == r.CollectionId, ct) ?? throw new NotFoundException("Collection not found.", "VAULT_NOT_FOUND");
        if (!(await DecidersAsync(c, r.RequesterId, ct)).Contains(me)) throw new ForbiddenException("Only people who manage this collection decide.", "VAULT_DENIED");
        r.Status = approve ? VaultRequestStatus.Approved : VaultRequestStatus.Denied;
        r.DecidedBy = me; r.DecidedAt = clock.Now; r.DecisionNote = Clip(req.Note, 300);
        if (approve)
        {
            r.GrantedUntil = clock.Now.AddMinutes(r.Minutes);
            if (r.Kind == VaultRequestKind.Collection)
                db.VaultShares.Add(new VaultShare { TenantId = tid, CollectionId = c.Id, PrincipalType = VaultPrincipal.User, PrincipalId = r.RequesterId, Access = r.Access, ExpiresAt = r.GrantedUntil, CreatedAt = clock.Now, CreatedBy = me });
        }
        recorder.Audit(approve ? "vault.access_approved" : "vault.access_denied", r.ItemId is null ? "VaultCollection" : "VaultItem", r.ItemId ?? c.Id, null,
            new { requester = r.RequesterId, collection = c.Name, minutes = r.Minutes, until = r.GrantedUntil, note = r.DecisionNote });
        var name = await NameAsync(me, ct);
        await notifications.AddAsync(r.RequesterId, NotificationType.Security,
            approve ? $"{name} approved your vault request ({Duration(r.Minutes)})" : $"{name} refused your vault request",
            r.DecisionNote ?? (approve ? (c.Sealed && r.Kind == VaultRequestKind.Collection ? "Its key reaches you when they open the collection." : "It ends by itself.") : null),
            r.ItemId is { } it ? $"/vault?item={it}" : $"/vault?c={c.Id}", ct: ct);
        await db.SaveChangesAsync(ct);
        return await RequestDtoAsync(r, ct);
    }

    public async Task CancelRequestAsync(Guid id, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (_, me) = Who();
        var r = await db.VaultAccessRequests.FirstOrDefaultAsync(x => x.Id == id && x.RequesterId == me, ct) ?? throw new NotFoundException("Request not found.", "VAULT_NOT_FOUND");
        if (r.Status == VaultRequestStatus.Pending) r.Status = VaultRequestStatus.Cancelled;
        else if (r.Status == VaultRequestStatus.Approved && r.GrantedUntil > clock.Now)
        {
            // Done early: give it back. A collection request also ends the share it made (and so, for a sealed one, the key at its next opening).
            var until = r.GrantedUntil;
            r.GrantedUntil = clock.Now;
            if (r.Kind == VaultRequestKind.Collection)
                foreach (var s in await db.VaultShares.Where(s => s.CollectionId == r.CollectionId && s.PrincipalType == VaultPrincipal.User && s.PrincipalId == me && s.ExpiresAt == until).ToListAsync(ct))
                    s.ExpiresAt = clock.Now;
        }
        recorder.Audit("vault.access_returned", "VaultCollection", r.CollectionId, null, new { request = r.Id });
        await db.SaveChangesAsync(ct);
    }

    // ------------------------------------------------------------------ asking for a new value

    /// <summary>
    /// Asks for an item to get a new value (it leaked, someone left, it is shared too widely): anyone who may use it can ask. The item is
    /// marked "to rotate" with who asked and why, and its owner and the people who manage it are told (once a day per person asking).
    /// </summary>
    public async Task<VaultItemSummaryDto> RequestRotationAsync(Guid id, VaultRotationRequest req, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (tid, me) = Who();
        var (item, c, access) = await ItemAsync(id, VaultAccess.UseOnly, ct);
        if (c.LockedAt != null) throw new ConflictException("This collection is locked.", "VAULT_LOCKED");
        var reason = CleanReason(req.Reason);
        var who = await NameAsync(me, ct);
        var name = item.Sealed || string.IsNullOrWhiteSpace(item.Title) ? $"an item in {c.Name}" : $"“{item.Title}”";
        if (item.RotationReason is null) { item.RotationReason = Clip($"{who} asked for a new value: {reason}", 300); item.UpdatedAt = clock.Now; }
        recorder.Audit("vault.rotation_requested", "VaultItem", id, null, new { item = item.Sealed ? null : item.Title, collection = c.Name, reason });
        db.Activities.Add(new Activity { TenantId = tid, ActorId = me, Action = "vault.rotation_requested", EntityType = "VaultItem", EntityId = id,
            Summary = $"A new value for {name} was asked for", CreatedAt = clock.Now });
        var tell = (await AccessByUserAsync(c, ct)).Where(x => x.Value == VaultAccess.Manage && x.Key != me).Select(x => x.Key).ToHashSet();
        if (item.OwnerUserId is { } owner && owner != me) tell.Add(owner);
        var key = $"vault-rotate:{id}:{me}:{clock.Today:yyyyMMdd}";
        if (!await db.Notifications.AnyAsync(n => n.DedupeKey == key, ct))
            foreach (var u in tell)
                await notifications.AddAsync(u, NotificationType.Security, $"{who} asks for a new value for {name}", $"Reason: {Clip(reason, 200)}", $"/vault?item={id}", dedupeKey: key, ct: ct);
        await db.SaveChangesAsync(ct);
        return Summary(item, (c, access), [], null);
    }

    /// <summary>
    /// Adds one person to a shared collection (or changes what they have), keeping everyone else as they are. Sealed collections are shared
    /// from the vault page only, where the manager's own browser hands over the key.
    /// </summary>
    public async Task<VaultCollectionDto> SharePersonAsync(Guid collectionId, Guid userId, VaultAccess access, DateTime? until, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (c, _) = await CollectionAsync(collectionId, VaultAccess.Manage, ct);
        if (c.Sealed) throw new ConflictException("Share a sealed collection from the vault page: only your browser can hand over its key.", "VAULT_SEALED");
        if (access is not (VaultAccess.UseOnly or VaultAccess.View)) throw new ValidationException("access", "Give use-only or view access here; managing is given on the vault page.");
        var current = await db.VaultShares.AsNoTracking().Where(s => s.CollectionId == collectionId).ToListAsync(ct);
        if (current.Any(s => s.PrincipalType == VaultPrincipal.User && s.PrincipalId == userId && s.Access == VaultAccess.Manage && s.ExpiresAt == null))
            throw new ConflictException("They already manage this collection.", "VAULT_ALREADY_MANAGES");
        if (until is { } u && u <= clock.Now) throw new ValidationException("until", "An end date must be in the future.");
        // Everyone else stays exactly as they are (shares that already ended are dropped, as the page does).
        var keep = current.Where(s => !(s.PrincipalType == VaultPrincipal.User && s.PrincipalId == userId) && !(s.ExpiresAt is { } e && e <= clock.Now))
            .Select(s => new VaultShareInput(s.PrincipalType, s.PrincipalId, s.Role, s.Access, s.ExpiresAt)).ToList();
        keep.Add(new VaultShareInput(VaultPrincipal.User, userId, null, access, until));
        return await SaveSharesAsync(collectionId, new SaveVaultSharesRequest(keep), ct);
    }

    /// <summary>Pending requests older than a week lapse.</summary>
    private async Task ExpireRequestsAsync(CancellationToken ct)
    {
        var cutoff = clock.Now.AddDays(-7);
        await db.VaultAccessRequests.Where(r => r.Status == VaultRequestStatus.Pending && r.CreatedAt < cutoff).ExecuteUpdateAsync(u => u.SetProperty(r => r.Status, VaultRequestStatus.Expired), ct);
    }
}
