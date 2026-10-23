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

public record UpdateWhatsAppNotifications(int Version, bool OptIn, string? AcceptedConsentVersion,
    bool TaskAssignments, bool Overdue, bool SupportUpdates, string? TimeZone, int QuietStartMinutes, int QuietEndMinutes,
    bool Reminders = false, bool Approvals = false);
public record WhatsAppNotificationPreferences(int Version, bool OptedIn, bool CanEnable, bool TaskAssignments,
    bool Overdue, bool SupportUpdates, string TimeZone, int QuietStartMinutes, int QuietEndMinutes,
    string RequiredConsentVersion, DateTimeOffset? ConsentAt, DateTimeOffset? ExpiresAt, bool DeliveryEnabled = false, bool Reminders = false, bool Approvals = false);

public class WhatsAppContactService(IAppDbContext db, CurrentContext ctx, AppClock clock, Recorder recorder,
    EntitlementService entitlements, ISecretProtector secrets, IOptions<WhatsAppOptions> options)
{
    public const string Consent = "whatsapp-account-link-v1";
    public const string NotificationConsent = "whatsapp-notifications-v1";
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
        ClearNotifications(r);
        r.PhoneProtected = ""; r.PhoneHash = null; r.ChallengeHash = null; r.ChallengeIssuedAt = null;
        r.ChallengeExpiresAt = null; r.VerifiedAt = null; r.ConsentVersion = null; r.ConsentAt = null;
    }
    private static void ClearNotifications(WhatsAppContactLink r)
    {
        if (r.NotificationConsentAt != null || r.NotifyTaskAssignments || r.NotifyOverdue || r.NotifySupportUpdates || r.NotifyReminders || r.NotifyApprovals)
            r.NotificationPreferencesVersion++;
        r.NotificationConsentVersion = null; r.NotificationConsentAt = null; r.NotificationConsentExpiresAt = null;
        r.NotifyTaskAssignments = false; r.NotifyOverdue = false; r.NotifySupportUpdates = false; r.NotifyReminders = false; r.NotifyApprovals = false;
        r.NotificationTimeZone = null; r.NotificationQuietStartMinutes = 1320; r.NotificationQuietEndMinutes = 480;
    }
    private bool CurrentLink(WhatsAppContactLink? r, WhatsAppConnection? c) => r is { VerifiedAt: not null, PhoneHash: not null }
        && c != null && r.ConnectionId == c.Id && r.ConnectionConnectedAt == c.ConnectedAt
        && r.ConfigurationHash == ConfigurationHash && r.VerifiedAt > clock.Now.AddDays(-30)
        && r.ConsentVersion == Consent && r.ConsentAt != null;
    private WhatsAppNotificationPreferences Preferences(WhatsAppContactLink? r, bool canEnable) => new(
        r?.NotificationPreferencesVersion ?? 0,
        r?.NotificationConsentVersion == NotificationConsent && r.NotificationConsentAt != null && r.NotificationConsentExpiresAt > clock.Now,
        canEnable, r?.NotifyTaskAssignments ?? false, r?.NotifyOverdue ?? false, r?.NotifySupportUpdates ?? false,
        r?.NotificationTimeZone ?? "UTC", r?.NotificationQuietStartMinutes ?? 1320, r?.NotificationQuietEndMinutes ?? 480,
        NotificationConsent, r?.NotificationConsentAt is { } at ? Utc(at) : null,
        r?.NotificationConsentExpiresAt is { } expiry ? Utc(expiry) : null,
        WhatsAppDeliveryService.Enabled(O)&&canEnable&&r?.NotificationConsentVersion==NotificationConsent&&r.NotificationConsentExpiresAt>clock.Now,
        r?.NotifyReminders ?? false, r?.NotifyApprovals ?? false);
    public async Task<WhatsAppNotificationPreferences> NotificationPreferencesAsync(CancellationToken ct)
    {
        if (!await db.Tenants.AnyAsync(x => x.Id == ctx.TenantId && x.Type == WorkspaceType.Organization, ct))
            return Preferences(null, false);
        await RequireMemberAsync(ct); var t = ctx.RequireTenantId(); var u = ctx.RequireUserId();
        await using var tx = await db.Database.BeginTransactionAsync(ct); await db.LockTenantLedgerAsync(t, ct);
        await RequireMemberAsync(ct);
        var r = await db.WhatsAppContactLinks.SingleOrDefaultAsync(x => x.TenantId == t && x.UserId == u, ct);
        var current = CurrentLink(r, await ConnectionAsync(ct));
        if (r?.NotificationConsentAt != null && (!current || r.NotificationConsentVersion != NotificationConsent
                || r.NotificationConsentExpiresAt == null || r.NotificationConsentExpiresAt <= clock.Now))
        { ClearNotifications(r); await db.SaveChangesAsync(ct); }
        var result = Preferences(r, Enabled && current && await EligibleAsync(t, ct));
        await tx.CommitAsync(ct); return result;
    }
    public async Task<WhatsAppNotificationPreferences> UpdateNotificationsAsync(UpdateWhatsAppNotifications request, CancellationToken ct)
    {
        await RequireMemberAsync(ct); var t = ctx.RequireTenantId(); var u = ctx.RequireUserId();
        await using var tx = await db.Database.BeginTransactionAsync(ct); await db.LockTenantLedgerAsync(t, ct);
        await RequireMemberAsync(ct);
        var r = await db.WhatsAppContactLinks.SingleOrDefaultAsync(x => x.TenantId == t && x.UserId == u, ct);
        if (request.Version < 0 || request.Version != (r?.NotificationPreferencesVersion ?? 0))
            throw new ConflictException("Preferences changed. Reload before saving.", "WHATSAPP_PREFERENCES_STALE");
        if (request.OptIn)
        {
            if (request.AcceptedConsentVersion != NotificationConsent)
                throw new ValidationException("acceptedConsentVersion", "Review and accept the current notification notice.");
            if (!request.TaskAssignments && !request.Overdue && !request.SupportUpdates && !request.Reminders && !request.Approvals)
                throw new ValidationException("notifications", "Select at least one notification category.");
            if (request.TimeZone is not { Length: > 0 and <= 100 }
                || NodaTime.DateTimeZoneProviders.Tzdb.GetZoneOrNull(request.TimeZone) == null)
                throw new ValidationException("timeZone", "Choose a valid IANA time zone.");
            if (request.QuietStartMinutes is < 0 or > 1439 || request.QuietEndMinutes is < 0 or > 1439
                || request.QuietStartMinutes == request.QuietEndMinutes)
                throw new ValidationException("quietHours", "Choose distinct quiet-hour times within one day.");
            if (!Enabled || !CurrentLink(r, await ConnectionAsync(ct)))
                throw new ConflictException("Verify your phone on the current business connection first.", "WHATSAPP_CONTACT_REQUIRED");
            if (!await EligibleAsync(t, ct))
                throw new ForbiddenException("Your plan does not include WhatsApp integration.", "WHATSAPP_PLAN_REQUIRED");
            r!.NotificationConsentVersion = NotificationConsent; r.NotificationConsentAt = clock.Now;
            // Updating preferences cannot extend the lifetime of the phone proof.
            r.NotificationConsentExpiresAt = r.VerifiedAt!.Value.AddDays(30);
            r.NotifyTaskAssignments = request.TaskAssignments; r.NotifyOverdue = request.Overdue; r.NotifySupportUpdates = request.SupportUpdates;
            r.NotifyReminders = request.Reminders; r.NotifyApprovals = request.Approvals;
            r.NotificationTimeZone = request.TimeZone; r.NotificationQuietStartMinutes = request.QuietStartMinutes;
            r.NotificationQuietEndMinutes = request.QuietEndMinutes; r.NotificationPreferencesVersion++;
            recorder.Audit("whatsapp.notifications.consent", "WhatsAppContactLink", r.Id);
        }
        else if (r != null)
        {
            var version = r.NotificationPreferencesVersion;
            ClearNotifications(r); r.NotificationPreferencesVersion = version + 1;
            recorder.Audit("whatsapp.notifications.revoked", "WhatsAppContactLink", r.Id);
        }
        await db.SaveChangesAsync(ct);
        var result = Preferences(r, Enabled && CurrentLink(r, await ConnectionAsync(ct)) && await EligibleAsync(t, ct));
        await tx.CommitAsync(ct); return result;
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
    /// <summary>
    /// The member whose current, verified link is this number, or null. Called only inside the gateway's signed, exact-installation, active-plan
    /// tenant transaction; guests are never matched.
    /// </summary>
    internal async Task<Guid?> VerifiedUserAsync(WhatsAppConnection c, string? sender, CancellationToken ct)
    {
        if (!Enabled || !PhoneDigits(sender)) return null;
        var ph = PhoneHash(c.TenantId, sender!);
        var r = await db.WhatsAppContactLinks.AsNoTracking().FirstOrDefaultAsync(x => x.TenantId == c.TenantId && x.PhoneHash == ph, ct);
        if (r is null || !CurrentLink(r, c)) return null;
        if (!await db.TenantMembers.AnyAsync(x => x.TenantId == c.TenantId && x.UserId == r.UserId && x.Role != TenantRole.Guest, ct)
            || !await db.Users.AnyAsync(x => x.Id == r.UserId && x.IsActive, ct)) return null;
        return r.UserId;
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
                .SetProperty(x => x.ConsentVersion, (string?)null).SetProperty(x => x.ConsentAt, (DateTime?)null)
                .SetProperty(x => x.NotificationPreferencesVersion, x => x.NotificationPreferencesVersion + 1)
                .SetProperty(x => x.NotificationConsentVersion, (string?)null).SetProperty(x => x.NotificationConsentAt, (DateTime?)null)
                .SetProperty(x => x.NotificationConsentExpiresAt, (DateTime?)null)
                .SetProperty(x => x.NotifyTaskAssignments, false).SetProperty(x => x.NotifyOverdue, false).SetProperty(x => x.NotifySupportUpdates, false)
                .SetProperty(x => x.NotificationTimeZone, (string?)null).SetProperty(x => x.NotificationQuietStartMinutes, 1320)
                .SetProperty(x => x.NotificationQuietEndMinutes, 480), ct);
        // Do not reveal another member's phone linkage through the anonymous callback.
        if (await db.WhatsAppContactLinks.AnyAsync(x => x.TenantId == c.TenantId && x.UserId != r.UserId && x.PhoneHash == ph, ct)) return;
        r.PhoneHash = ph; r.VerifiedAt = clock.Now; r.ChallengeHash = null; r.ChallengeIssuedAt = null; r.ChallengeExpiresAt = null;
        recorder.Audit("whatsapp.contact.verified", "WhatsAppContactLink", r.Id, userId: r.UserId);
        // Make the claim visible to later proofs in the same envelope, inside the existing transaction.
        await db.SaveChangesAsync(ct);
    }
}
