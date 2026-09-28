using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Admin;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Consent;

public record MyConsentDto(bool UpToDate, IReadOnlyList<ConsentDocumentDto> Pending);
public record AcceptConsentRequest(IReadOnlyList<string> Types);

/// <summary>
/// Whether the signed-in person has accepted the current Terms of Service and Privacy Policy, and lets them do so.
/// The documents themselves are platform settings (PlatformService); this is the per-user acceptance trail.
/// </summary>
public class ConsentService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, PlatformSettingsCache platform)
{
    public async Task<IReadOnlyList<ConsentDocumentDto>> GetCurrentAsync(CancellationToken ct = default) =>
        await platform.GetConsentDocumentsAsync(ct);

    public async Task<MyConsentDto> GetMyStatusAsync(CancellationToken ct = default) => await StatusForAsync(ctx.RequireUserId(), ct);

    public async Task<MyConsentDto> StatusForAsync(Guid userId, CancellationToken ct = default)
    {
        var docs = await platform.GetConsentDocumentsAsync(ct);
        var mine = await db.UserConsents.AsNoTracking().Where(c => c.UserId == userId).ToListAsync(ct);
        // Version 0 is the unpublished placeholder (nobody has really been shown terms yet) - only a document an
        // administrator actually published can ever be "pending", so accounts that existed before this feature,
        // or seeded demo/admin accounts, are never retroactively blocked.
        var pending = docs.Where(d => d.Version > 0 && !mine.Any(m => m.DocumentType == d.Type && m.Version >= d.Version)).ToList();
        return new MyConsentDto(pending.Count == 0, pending);
    }

    public async Task<MyConsentDto> AcceptAsync(AcceptConsentRequest req, CancellationToken ct = default)
    {
        var userId = ctx.RequireUserId();
        var types = (req.Types ?? []).Where(ConsentTypes.All.Contains).Distinct().ToList();
        if (types.Count == 0) throw new ValidationException("types", "Choose at least one document.");
        await RecordAsync(userId, types, ctx.IpAddress, ct);
        return await StatusForAsync(userId, ct);
    }

    /// <summary>Used at registration: the sign-up form already required agreeing to the current documents.</summary>
    public async Task RecordCurrentAsync(Guid userId, string? ipAddress, CancellationToken ct)
    {
        var docs = await platform.GetConsentDocumentsAsync(ct);
        await RecordAsync(userId, docs.Select(d => d.Type).ToList(), ipAddress, ct);
    }

    private async Task RecordAsync(Guid userId, IReadOnlyList<string> types, string? ipAddress, CancellationToken ct)
    {
        var docs = await platform.GetConsentDocumentsAsync(ct);
        var existing = await db.UserConsents.Where(c => c.UserId == userId && types.Contains(c.DocumentType)).ToListAsync(ct);
        var recorded = new List<string>();
        foreach (var type in types)
        {
            var doc = docs.FirstOrDefault(d => d.Type == type);
            if (doc is null || doc.Version == 0 || existing.Any(e => e.DocumentType == type && e.Version >= doc.Version)) continue;
            db.UserConsents.Add(new UserConsent
            {
                UserId = userId, DocumentType = type, Version = doc.Version, ConsentedAt = clock.Now, IpAddress = ipAddress,
                CreatedAt = clock.Now, CreatedBy = userId,
            });
            recorded.Add(type);
        }
        if (recorded.Count == 0) return;
        recorder.Audit("consent.given", "User", userId, newValue: new { types = recorded }, userId: userId);
        await db.SaveChangesAsync(ct);
    }
}
