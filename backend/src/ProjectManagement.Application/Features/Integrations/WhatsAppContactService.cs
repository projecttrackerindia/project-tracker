using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
namespace ProjectManagement.Application.Features.Integrations;

public record StartWhatsAppContact(string Phone, bool Acknowledged);
public record WhatsAppContactChallenge(string Message, DateTimeOffset ExpiresAt);
public record WhatsAppContactStatus(bool Enabled, bool Eligible, string? BusinessName, string Status,
    string? MaskedPhone, DateTimeOffset? ExpiresAt, DateTimeOffset? VerifiedAt, string? ConsentVersion, bool OutboundEnabled = false);

public class WhatsAppContactService(IAppDbContext db, CurrentContext ctx, AppClock clock, Recorder recorder,
    EntitlementService entitlements, ISecretProtector secrets, IOptions<WhatsAppOptions> options)
{
    public const string Consent = "whatsapp-account-link-v1";
    private WhatsAppOptions O => options.Value;
    private bool Enabled => O.ContactLinkingEnabled && O.WebhookReceptionEnabled && O.Configured;
    private static string Hash(string s) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(s)));
    private string ConfigurationHash => Hash(O.AppId + "|" + O.AppSecret);
    private string PhoneHash(Guid tenant, string digits) => Convert.ToHexString(HMACSHA256.HashData(
        Encoding.UTF8.GetBytes(O.AppSecret!), Encoding.UTF8.GetBytes("contact:v1:" + tenant + ":" + digits)));
    private static DateTimeOffset Utc(DateTime d) => new(DateTime.SpecifyKind(d, DateTimeKind.Utc));
    internal static bool PhoneDigits(string? s) => s is { Length: >= 8 and <= 15 } && s[0] != '0' && s.All(c => c is >= '0' and <= '9');
    private static DateTime Seconds(DateTime d) => new(d.Ticks - d.Ticks % TimeSpan.TicksPerSecond, DateTimeKind.Utc);
    private static void Clear(WhatsAppContactLink r)
    {
        r.PhoneProtected = ""; r.PhoneHash = null; r.ChallengeHash = null; r.ChallengeIssuedAt = null;
        r.ChallengeExpiresAt = null; r.VerifiedAt = null; r.ConsentVersion = null; r.ConsentAt = null;
    }
    private async Task RequireMemberAsync(CancellationToken ct)
    {
        var t = ctx.RequireTenantId(); var u = ctx.RequireUserId();
        if (!await db.TenantMembers.AnyAsync(x => x.TenantId == t && x.UserId == u, ct)
            || !await db.Users.AnyAsync(x => x.Id == u && x.IsActive && !x.MustChangePassword, ct)
            || !await db.Tenants.AnyAsync(x => x.Id == t && x.Type == WorkspaceType.Organization, ct))
            throw new ForbiddenException("An active organization membership is required.");
    }
    internal async Task<bool> EligibleAsync(Guid t, CancellationToken ct)
    {
        entitlements.Forget(t);
        var sub = await db.Subscriptions.AsNoTracking().Include(x => x.Plan).SingleOrDefaultAsync(x => x.TenantId == t, ct);
        return sub is { Status: SubscriptionStatus.Active, Plan.IsActive: true }
            && (sub.CurrentPeriodEnd == null || sub.CurrentPeriodEnd > clock.Now)
            && (await entitlements.GetEntitlementsAsync(t, ct)).GetValueOrDefault(FeatureKeys.WhatsAppIntegration) > 0;
    }
    private Task<WhatsAppConnection?> ConnectionAsync(CancellationToken ct) => db.WhatsAppConnections.AsNoTracking()
        .SingleOrDefaultAsync(x => x.TenantId == ctx.TenantId && x.Active && x.AppId == O.AppId
            && (x.TokenExpiresAt == null || x.TokenExpiresAt > clock.Now), ct);
    public async Task<WhatsAppContactStatus> StatusAsync(CancellationToken ct)
    {
        if (!await db.Tenants.AnyAsync(x => x.Id == ctx.TenantId && x.Type == WorkspaceType.Organization, ct))
            return new(false, false, null, "unavailable", null, null, null, null);
        await RequireMemberAsync(ct); var t = ctx.RequireTenantId(); var u = ctx.RequireUserId();
        await using var tx = await db.Database.BeginTransactionAsync(ct); await db.LockTenantLedgerAsync(t, ct);
        var eligible = await EligibleAsync(t, ct); var c = await ConnectionAsync(ct);
        var r = await db.WhatsAppContactLinks.SingleOrDefaultAsync(x => x.TenantId == t && x.UserId == u, ct);
        if (r is not null && (c is null || r.ConnectionId != c.Id || r.ConnectionConnectedAt != c.ConnectedAt
                || r.ConfigurationHash != ConfigurationHash || r.VerifiedAt <= clock.Now.AddDays(-30)
                || r.ChallengeHash != null && r.ChallengeExpiresAt <= clock.Now))
        { Clear(r); await db.SaveChangesAsync(ct); }
        string? masked = null;
        if (r?.PhoneProtected.Length > 0)
        {
            try { var phone = secrets.Unprotect(r.PhoneProtected); if (PhoneDigits(phone)) masked = "\u2022\u2022\u2022\u2022 " + phone[^4..]; }
            catch (CryptographicException) { Clear(r); await db.SaveChangesAsync(ct); }
        }
        await tx.CommitAsync(ct);
        var state = r?.VerifiedAt != null ? "verified" : r?.ChallengeHash != null ? "pending" : "unlinked";
        return new(Enabled && c is not null, eligible, c?.DisplayName, state, masked,
            r?.ChallengeExpiresAt is { } expiry ? Utc(expiry) : null, r?.VerifiedAt is { } verified ? Utc(verified) : null, r?.ConsentVersion);
    }
    public async Task<WhatsAppContactChallenge> StartAsync(StartWhatsAppContact request, CancellationToken ct)
    {
        await RequireMemberAsync(ct);
        if (!request.Acknowledged) throw new ValidationException("acknowledged", "Review and accept the account-link notice.");
        if (request.Phone is not { Length: >= 9 and <= 16 } || request.Phone[0] != '+' || !PhoneDigits(request.Phone[1..]))
            throw new ValidationException("phone", "Use + followed by your country code and number, without spaces.");
        var t = ctx.RequireTenantId(); var u = ctx.RequireUserId();
        await using var tx = await db.Database.BeginTransactionAsync(ct); await db.LockTenantLedgerAsync(t, ct);
        await RequireMemberAsync(ct);
        if (!Enabled) throw new ConflictException("Phone linking is awaiting platform setup.", "WHATSAPP_CONTACT_DISABLED");
        if (!await EligibleAsync(t, ct)) throw new ForbiddenException("Your plan does not include WhatsApp integration.", "WHATSAPP_PLAN_REQUIRED");
        var c = await ConnectionAsync(ct) ?? throw new ConflictException("Ask an administrator to connect the business account.", "WHATSAPP_NOT_CONNECTED");
        var r = await db.WhatsAppContactLinks.SingleOrDefaultAsync(x => x.TenantId == t && x.UserId == u, ct);
        if (r is null) { r = new() { TenantId = t, UserId = u }; db.WhatsAppContactLinks.Add(r); }
        if (r.RateWindowAt <= clock.Now.AddHours(-1)) { r.RateWindowAt = clock.Now; r.ChallengesIssued = 0; }
        if (r.ChallengesIssued >= 5) throw new TooManyRequestsException("Too many phone-link attempts. Wait before trying again.");
        Clear(r); r.ChallengesIssued++; r.ConnectionId = c.Id; r.ConnectionConnectedAt = c.ConnectedAt;
        r.ConfigurationHash = ConfigurationHash; r.PhoneProtected = secrets.Protect(request.Phone[1..]);
        var message = "PT-LINK " + Convert.ToHexString(RandomNumberGenerator.GetBytes(16));
        r.ChallengeHash = Hash(message); r.ChallengeIssuedAt = clock.Now; r.ChallengeExpiresAt = clock.Now.AddMinutes(10);
        r.ConsentVersion = Consent; r.ConsentAt = clock.Now;
        recorder.Audit("whatsapp.contact.challenge", "WhatsAppContactLink", r.Id);
        await db.SaveChangesAsync(ct); await tx.CommitAsync(ct);
        return new(message, Utc(r.ChallengeExpiresAt.Value));
    }
    public async Task UnlinkAsync(CancellationToken ct)
    {
        await RequireMemberAsync(ct); var t = ctx.RequireTenantId(); var u = ctx.RequireUserId();
        await using var tx = await db.Database.BeginTransactionAsync(ct); await db.LockTenantLedgerAsync(t, ct);
        var r = await db.WhatsAppContactLinks.SingleOrDefaultAsync(x => x.TenantId == t && x.UserId == u, ct);
        if (r is not null) { Clear(r); recorder.Audit("whatsapp.contact.unlinked", "WhatsAppContactLink", r.Id); await db.SaveChangesAsync(ct); }
        await tx.CommitAsync(ct);
    }
    // Called only inside the gateway's signed, exact-installation, active-plan tenant transaction.
    internal async Task TryVerifyAsync(WhatsAppConnection c, string? sender, string? message, DateTime stamp, CancellationToken ct)
    {
        if (!Enabled || !PhoneDigits(sender) || message is not { Length: 40 } || !message.StartsWith("PT-LINK ", StringComparison.Ordinal)
            || !message[8..].All(x => x is >= '0' and <= '9' or >= 'A' and <= 'F')) return;
        var h = Hash(message);
        var r = await db.WhatsAppContactLinks.SingleOrDefaultAsync(x => x.TenantId == c.TenantId && x.ConnectionId == c.Id
            && x.ConnectionConnectedAt == c.ConnectedAt && x.ChallengeHash == h && x.ChallengeExpiresAt > clock.Now, ct);
        if (r is null || r.ConfigurationHash != ConfigurationHash || r.ConsentVersion != Consent || r.ConsentAt == null
            || r.ChallengeIssuedAt is not { } issued || stamp < Seconds(issued) || stamp > clock.Now.AddSeconds(30)
            || !await db.TenantMembers.AnyAsync(x => x.TenantId == c.TenantId && x.UserId == r.UserId, ct)
            || !await db.Users.AnyAsync(x => x.Id == r.UserId && x.IsActive && !x.MustChangePassword, ct)) return;
        string expected;
        try { expected = secrets.Unprotect(r.PhoneProtected); }
        catch (CryptographicException) { Clear(r); return; }
        if (!CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(sender!), Encoding.ASCII.GetBytes(expected))) return;
        var ph = PhoneHash(c.TenantId, sender!);
        // Release only expired/stale fingerprints in this tenant; preserve admission counters.
        await db.WhatsAppContactLinks.Where(x => x.TenantId == c.TenantId && x.UserId != r.UserId && x.PhoneHash == ph
            && (x.VerifiedAt <= clock.Now.AddDays(-30) || x.ConfigurationHash != ConfigurationHash
                || x.ConnectionId != c.Id || x.ConnectionConnectedAt != c.ConnectedAt))
            .ExecuteUpdateAsync(s => s.SetProperty(x => x.PhoneProtected, "").SetProperty(x => x.PhoneHash, (string?)null)
                .SetProperty(x => x.ChallengeHash, (string?)null).SetProperty(x => x.ChallengeIssuedAt, (DateTime?)null)
                .SetProperty(x => x.ChallengeExpiresAt, (DateTime?)null).SetProperty(x => x.VerifiedAt, (DateTime?)null)
                .SetProperty(x => x.ConsentVersion, (string?)null).SetProperty(x => x.ConsentAt, (DateTime?)null), ct);
        // Do not reveal another member's phone linkage through the anonymous callback.
        if (await db.WhatsAppContactLinks.AnyAsync(x => x.TenantId == c.TenantId && x.UserId != r.UserId && x.PhoneHash == ph, ct)) return;
        r.PhoneHash = ph; r.VerifiedAt = clock.Now; r.ChallengeHash = null; r.ChallengeIssuedAt = null; r.ChallengeExpiresAt = null;
        recorder.Audit("whatsapp.contact.verified", "WhatsAppContactLink", r.Id, userId: r.UserId);
        // Make the claim visible to later proofs in the same envelope, inside the existing transaction.
        await db.SaveChangesAsync(ct);
    }
}
