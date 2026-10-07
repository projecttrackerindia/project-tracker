using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Documents;

/// <summary>What a person who cannot open a document may know about it: that it exists, its number and (unless private) its title, who owns it.</summary>
public record DocumentGateDto(Guid Id, string Key, string? Title, string? OwnerName, string? TeamName, bool CanRequest, AccessRequestDto? Pending, AccessRequestDto? Last);
public record AccessRequestDto(Guid Id, Guid DocumentId, string DocumentKey, string? DocumentTitle, UserRefDto Requester, DocAccessLevel Level, string Reason, int? DurationDays,
    AccessRequestStatus Status, UserRefDto? DecidedBy, DateTime? DecidedAt, string? DecisionNote, DocAccessLevel? GrantedLevel, DateTime? GrantedUntil, DateTime CreatedAt, bool CanDecide, bool Expired);
public record RequestAccessRequest(DocAccessLevel Level, string Reason, int? DurationDays);
public record DecideAccessRequest(bool Approve, DocAccessLevel? Level, int? DurationDays, string? Note);

/// <summary>
/// Asking for access to a document you cannot open. The request carries a reason and how long access is needed; the owner, the document's managers and the
/// organization's admins decide. An approval becomes an ordinary grant (with an end date when one was asked for), so the person can open the document at
/// once without signing in again, and loses it on the day it ends.
/// </summary>
public class DocumentAccessRequestService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, DocumentAccessService rights, DocumentNotifier notifier)
{
    public const int MaxDays = 365;

    private bool IsAdmin => ctx.Role is TenantRole.Owner or TenantRole.Admin;

    /// <summary>The document as someone who cannot open it may see it. Throws not-found when it does not exist for them at all (other workspace, deleted, guest, blocked).</summary>
    public async Task<DocumentGateDto> GateAsync(Guid documentId, CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        var me = ctx.RequireUserId();
        var doc = await db.Documents.IgnoreQueryFilters().FirstOrDefaultAsync(d => d.Id == documentId && d.TenantId == tid && !d.IsDeleted, ct);
        if (doc is null || ctx.Role == TenantRole.Guest || await rights.IsBlockedAsync(documentId, ct)) throw new NotFoundException("Document not found.");
        if (await db.Documents.AnyAsync(d => d.Id == documentId, ct)) throw new ConflictException("You can already open this document.", "ALREADY_ALLOWED");
        var owner = await db.Users.Where(u => u.Id == doc.OwnerId).Select(u => u.DisplayName).FirstOrDefaultAsync(ct);
        var teamId = doc.TeamId ?? (doc.ProjectId is { } p ? await db.Projects.IgnoreQueryFilters().Where(x => x.Id == p && x.TenantId == tid).Select(x => x.TeamId).FirstOrDefaultAsync(ct) : null);
        var team = teamId is { } t ? await db.Teams.IgnoreQueryFilters().Where(x => x.Id == t && x.TenantId == tid).Select(x => x.Name).FirstOrDefaultAsync(ct) : null;
        var mine = await db.AccessRequests.AsNoTracking().Where(r => r.DocumentId == documentId && r.RequesterId == me).OrderByDescending(r => r.CreatedAt).Take(5).ToListAsync(ct);
        var pending = mine.FirstOrDefault(r => r.Status == AccessRequestStatus.Pending);
        var last = mine.FirstOrDefault(r => r.Status != AccessRequestStatus.Pending);
        var key = DocumentService.KeyOf(doc.Number);
        var title = doc.Visibility == DocumentVisibility.Private ? null : doc.Title;
        return new DocumentGateDto(doc.Id, key, title, owner, team, pending is null,
            pending is null ? null : await ToDtoAsync(pending, doc, false, ct), last is null ? null : await ToDtoAsync(last, doc, false, ct));
    }

    public async Task<AccessRequestDto> RequestAsync(Guid documentId, RequestAccessRequest req, CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        var me = ctx.RequireUserId();
        var gate = await GateAsync(documentId, ct);
        if (gate.Pending is not null) throw new ConflictException("You have already asked for access. The people who manage this document were told.", "REQUEST_PENDING");
        var reason = (req.Reason ?? "").Trim();
        if (reason.Length < 3) throw new ValidationException("reason", "Say why you need access.");
        if (reason.Length > 500) throw new ValidationException("reason", "Keep the reason under 500 characters.");
        if (req.Level is not (DocAccessLevel.Viewer or DocAccessLevel.Editor)) throw new ValidationException("level", "Ask to read or to edit.");
        if (req.DurationDays is < 1 or > MaxDays) throw new ValidationException("durationDays", $"Ask for between 1 and {MaxDays} days, or leave it open.");
        var doc = await db.Documents.IgnoreQueryFilters().FirstAsync(d => d.Id == documentId, ct);

        var row = new AccessRequest { TenantId = tid, DocumentId = documentId, RequesterId = me, Level = req.Level, Reason = reason, DurationDays = req.DurationDays, CreatedAt = clock.Now, CreatedBy = me };
        db.AccessRequests.Add(row);
        var who = await db.Users.Where(u => u.Id == me).Select(u => u.DisplayName).FirstAsync(ct);
        var key = DocumentService.KeyOf(doc.Number);
        await notifier.SendAsync(await DecidersAsync(doc, ct), doc, $"access-requested:{row.Id:N}", $"{who} asks for access to {key}",
            $"{(doc.Visibility == DocumentVisibility.Private ? "A private document" : doc.Title)} · {reason}", ct: ct);
        recorder.Audit("document.access_requested", "Document", doc.Id, null, new { request = row.Id, row.Level, row.DurationDays, reason });
        recorder.Activity("document.access_requested", "Document", doc.Id, $"{who} asked for access to {key}", doc.ProjectId);
        await db.SaveChangesAsync(ct);
        return await ToDtoAsync(row, doc, false, ct);
    }

    public async Task<AccessRequestDto> CancelAsync(Guid requestId, CancellationToken ct = default)
    {
        var row = await db.AccessRequests.FirstOrDefaultAsync(r => r.Id == requestId && r.RequesterId == ctx.UserId, ct) ?? throw new NotFoundException("Request not found.");
        if (row.Status != AccessRequestStatus.Pending) throw new ConflictException("This request was already decided.", "ALREADY_DECIDED");
        row.Status = AccessRequestStatus.Cancelled; row.DecidedAt = clock.Now; row.UpdatedAt = clock.Now;
        recorder.Audit("document.access_request_cancelled", "Document", row.DocumentId, null, new { request = row.Id });
        await db.SaveChangesAsync(ct);
        var doc = await db.Documents.IgnoreQueryFilters().FirstAsync(d => d.Id == row.DocumentId, ct);
        return await ToDtoAsync(row, doc, false, ct);
    }

    public async Task<IReadOnlyList<AccessRequestDto>> ForDocumentAsync(Guid documentId, CancellationToken ct = default)
    {
        var doc = await db.Documents.FirstOrDefaultAsync(d => d.Id == documentId, ct) ?? throw new NotFoundException("Document not found.");
        var can = (await rights.RightsAsync(doc, ct)).Share;
        var rows = await db.AccessRequests.AsNoTracking().Where(r => r.DocumentId == documentId && (can || r.RequesterId == ctx.UserId)).OrderByDescending(r => r.CreatedAt).Take(50).ToListAsync(ct);
        var list = new List<AccessRequestDto>();
        foreach (var r in rows) list.Add(await ToDtoAsync(r, doc, can, ct));
        return list;
    }

    /// <summary>Requests the signed-in person may decide (their pending ones on documents they manage) and the ones they made themselves.</summary>
    public async Task<(IReadOnlyList<AccessRequestDto> ToDecide, IReadOnlyList<AccessRequestDto> Mine)> InboxAsync(CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var pending = await db.AccessRequests.AsNoTracking().Where(r => r.Status == AccessRequestStatus.Pending && r.RequesterId != me).OrderByDescending(r => r.CreatedAt).Take(200).ToListAsync(ct);
        var ids = pending.Select(r => r.DocumentId).Distinct().ToList();
        var docs = await db.Documents.AsNoTracking().Where(d => ids.Contains(d.Id)).ToDictionaryAsync(d => d.Id, ct);
        var decide = new List<AccessRequestDto>();
        var can = new Dictionary<Guid, bool>();
        foreach (var r in pending)
        {
            if (!docs.TryGetValue(r.DocumentId, out var d)) continue;
            if (!can.TryGetValue(d.Id, out var ok)) can[d.Id] = ok = (await rights.RightsAsync(d, ct)).Share;
            if (ok) decide.Add(await ToDtoAsync(r, d, true, ct));
        }
        var own = await db.AccessRequests.AsNoTracking().Where(r => r.RequesterId == me).OrderByDescending(r => r.CreatedAt).Take(30).ToListAsync(ct);
        var mine = new List<AccessRequestDto>();
        foreach (var r in own)
        {
            var d = await db.Documents.IgnoreQueryFilters().FirstOrDefaultAsync(x => x.Id == r.DocumentId && !x.IsDeleted, ct);
            if (d is not null) mine.Add(await ToDtoAsync(r, d, false, ct));
        }
        return (decide, mine);
    }

    public async Task<AccessRequestDto> DecideAsync(Guid requestId, DecideAccessRequest req, CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        var row = await db.AccessRequests.FirstOrDefaultAsync(r => r.Id == requestId, ct) ?? throw new NotFoundException("Request not found.");
        var doc = await db.Documents.FirstOrDefaultAsync(d => d.Id == row.DocumentId, ct) ?? throw new NotFoundException("Request not found.");
        if (!(await rights.RightsAsync(doc, ct)).Share) throw new ForbiddenException("Only the owner, a manager of this document and the organization's admins can decide this.", "PERMISSION_DENIED");
        if (row.Status != AccessRequestStatus.Pending) throw new ConflictException("This request was already decided.", "ALREADY_DECIDED");
        var note = string.IsNullOrWhiteSpace(req.Note) ? null : req.Note.Trim();
        if (note is { Length: > 500 }) throw new ValidationException("note", "Keep the note under 500 characters.");
        var now = clock.Now;
        var key = DocumentService.KeyOf(doc.Number);
        row.DecidedBy = ctx.UserId; row.DecidedAt = now; row.DecisionNote = note; row.UpdatedAt = now;

        if (!req.Approve)
        {
            row.Status = AccessRequestStatus.Rejected;
            await notifier.SendAsync([row.RequesterId], doc, $"access-decided:{row.Id:N}", $"Your request for {key} was declined", note, withLink: false, ct: ct);
            recorder.Audit("document.access_request_rejected", "Document", doc.Id, null, new { request = row.Id, requester = row.RequesterId, note });
            recorder.Activity("document.access_request_rejected", "Document", doc.Id, $"Declined a request for access to {key}", doc.ProjectId);
        }
        else
        {
            var level = req.Level ?? row.Level;
            if (level is not (DocAccessLevel.Viewer or DocAccessLevel.Editor)) throw new ValidationException("level", "Give read or edit access.");
            var days = req.DurationDays ?? row.DurationDays;
            if (days is < 1 or > MaxDays) throw new ValidationException("durationDays", $"Give access for between 1 and {MaxDays} days, or leave it open.");
            var until = days is { } d ? now.AddDays(d) : (DateTime?)null;
            // An approval is an ordinary grant: it never narrows what the person already has, and shows in the document's sharing list.
            var grant = await db.DocumentGrants.FirstOrDefaultAsync(g => g.DocumentId == doc.Id && g.PrincipalType == GrantPrincipal.User && g.PrincipalId == row.RequesterId && !g.Deny, ct);
            if (grant is null)
            {
                grant = new DocumentGrant { TenantId = tid, DocumentId = doc.Id, PrincipalType = GrantPrincipal.User, PrincipalId = row.RequesterId, Level = level, ExpiresAt = until, Note = "Access request", CreatedAt = now, CreatedBy = ctx.UserId };
                db.DocumentGrants.Add(grant);
            }
            else
            {
                grant.Level = (DocAccessLevel)Math.Max((int)grant.Level, (int)level);
                grant.ExpiresAt = grant.ExpiresAt is null || until is null ? null : (grant.ExpiresAt > until ? grant.ExpiresAt : until);
                grant.UpdatedAt = now;
            }
            row.Status = AccessRequestStatus.Approved; row.GrantedLevel = level; row.GrantedUntil = until; row.GrantId = grant.Id;
            await notifier.SendAsync([row.RequesterId], doc, $"access-decided:{row.Id:N}", $"You now have access to {key}",
                $"{doc.Title}{(until is { } u ? $" · until {u:dd MMM yyyy}" : "")}", ct: ct);
            recorder.Audit("document.access_request_approved", "Document", doc.Id, null, new { request = row.Id, requester = row.RequesterId, level, until, note });
            recorder.Activity("document.access_request_approved", "Document", doc.Id, $"Gave access to {key} after a request", doc.ProjectId);
        }
        await db.SaveChangesAsync(ct);
        return await ToDtoAsync(row, doc, true, ct);
    }

    // ------------------------------------------------------------------ helpers

    /// <summary>The people told about a request: the owner and the people the document is shared with as manager; the organization's owners and admins when there is nobody else.</summary>
    private async Task<List<Guid>> DecidersAsync(Document doc, CancellationToken ct)
    {
        var now = clock.Now;
        var tid = ctx.RequireTenantId();
        var people = new HashSet<Guid>();
        if (await db.TenantMembers.AnyAsync(m => m.TenantId == tid && m.UserId == doc.OwnerId, ct)) people.Add(doc.OwnerId);
        foreach (var u in await db.DocumentGrants.Where(g => g.DocumentId == doc.Id && !g.Deny && g.Level == DocAccessLevel.Manager && g.PrincipalType == GrantPrincipal.User && (g.ExpiresAt == null || g.ExpiresAt > now)).Select(g => g.PrincipalId).ToListAsync(ct)) people.Add(u);
        if (people.Count == 0)
            foreach (var u in await db.TenantMembers.Where(m => m.TenantId == tid && (m.Role == TenantRole.Owner || m.Role == TenantRole.Admin)).Select(m => m.UserId).Take(10).ToListAsync(ct)) people.Add(u);
        return people.ToList();
    }

    private async Task<AccessRequestDto> ToDtoAsync(AccessRequest r, Document doc, bool canDecide, CancellationToken ct)
    {
        var ids = new List<Guid> { r.RequesterId }; if (r.DecidedBy is { } d) ids.Add(d);
        var names = await db.Users.AsNoTracking().Where(u => ids.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        string Name(Guid id) => names.GetValueOrDefault(id) ?? "Former member";
        var title = doc.Visibility == DocumentVisibility.Private && !canDecide ? null : doc.Title;
        return new AccessRequestDto(r.Id, r.DocumentId, DocumentService.KeyOf(doc.Number), title, new UserRefDto(r.RequesterId, Name(r.RequesterId)), r.Level, r.Reason, r.DurationDays, r.Status,
            r.DecidedBy is { } by ? new UserRefDto(by, Name(by)) : null, r.DecidedAt, r.DecisionNote, r.GrantedLevel, r.GrantedUntil, r.CreatedAt,
            canDecide && r.Status == AccessRequestStatus.Pending, r.Status == AccessRequestStatus.Approved && r.GrantedUntil is { } g && g <= clock.Now);
    }
}
