using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
namespace ProjectManagement.Application.Features.Integrations;

public record WhatsAppProviderHealth(bool? TokenValid, bool? ScopesPresent, bool? AssetsVerified,
    bool? AppSubscribed, bool? PhoneVerified, DateTime? TokenExpiresAt);
public interface IWhatsAppHealthProvider
{
    Task<WhatsAppProviderHealth> InspectAsync(string token, string businessAccountId, string phoneNumberId, CancellationToken ct);
}
public record WhatsAppHealthStatus(bool CheckEnabled, string State, DateTimeOffset? CheckedAt,
    bool? TokenValid, bool? ScopesPresent, bool? AssetsVerified, bool? AppSubscribed, bool? PhoneVerified,
    bool MessagingEnabled = false);

/// <summary>Bounded read-only provider inspection. A successful check cannot enable delivery.</summary>
public class WhatsAppHealthService(IAppDbContext db, CurrentContext ctx, AppClock clock, Recorder recorder,
    WhatsAppGatewayService gateway, ISecretProtector secrets, IOptions<WhatsAppOptions> options, IWhatsAppHealthProvider provider)
{
    private WhatsAppOptions O => options.Value;
    private bool Enabled => O.HealthChecksEnabled && O.InstallationConfigured;
    private string ConfigurationHash => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
        string.Join("|", O.AppId, O.AppSecret, O.ApiVersion, O.EmbeddedSignupConfigId, O.SignupVersion))));
    private bool Current(WhatsAppConnection? row) => row is { Active: true, AccessTokenProtected.Length: > 0 }
        && row.AppId == O.AppId && (row.TokenExpiresAt == null || row.TokenExpiresAt > clock.Now);
    public static void Clear(WhatsAppConnection row)
    {
        // Preserve the attempt timestamp: reconnecting must not reset the per-organization cooldown.
        row.HealthState = "unchecked"; row.HealthCheckedAt = null; row.HealthConfigurationHash = null;
        row.HealthLeaseId = null; row.HealthLeaseUntil = null; row.HealthTokenValid = null; row.HealthScopesPresent = null;
        row.HealthAssetsVerified = null; row.HealthAppSubscribed = null; row.HealthPhoneVerified = null;
    }
    private WhatsAppHealthStatus Status(WhatsAppConnection? row, bool eligible)
    {
        var state = row?.HealthState ?? "unchecked";
        if (row != null && row.HealthState == "checking" && (row.HealthLeaseUntil == null || row.HealthLeaseUntil <= clock.Now)) state = "unavailable";
        else if (row?.HealthCheckedAt != null && (!Current(row) || row.HealthConfigurationHash != ConfigurationHash
                || row.HealthCheckedAt <= clock.Now.AddMinutes(-5))) state = "stale";
        var show = state is "verified" or "attention";
        return new(Enabled && eligible && Current(row), state,
            row?.HealthCheckedAt is { } at ? new DateTimeOffset(DateTime.SpecifyKind(at, DateTimeKind.Utc)) : null,
            show ? row?.HealthTokenValid : null, show ? row?.HealthScopesPresent : null,
            show ? row?.HealthAssetsVerified : null, show ? row?.HealthAppSubscribed : null, show ? row?.HealthPhoneVerified : null);
    }
    public async Task<WhatsAppHealthStatus> StatusAsync(CancellationToken ct)
    {
        await gateway.RequireAdminAsync(ct);
        return Status(await db.WhatsAppConnections.AsNoTracking().SingleOrDefaultAsync(x => x.TenantId == ctx.TenantId, ct),
            await gateway.EligibleAsync(ctx.RequireTenantId(), ct));
    }
    private async Task RequireAccess(CancellationToken ct)
    {
        await gateway.RequireAdminAsync(ct);
        if (!await gateway.EligibleAsync(ctx.RequireTenantId(), ct))
            throw new ForbiddenException("An eligible active subscription is required.", "WHATSAPP_PLAN_REQUIRED");
        if (!Enabled) throw new ConflictException("Provider health checks are awaiting platform setup.", "WHATSAPP_HEALTH_DISABLED");
    }
    public async Task<WhatsAppHealthStatus> CheckAsync(CancellationToken ct)
    {
        await RequireAccess(ct); var tenant = ctx.RequireTenantId(); var lease = Guid.NewGuid(); var configuration = ConfigurationHash;
        WhatsAppConnection snapshot;
        await using (var claim = await db.Database.BeginTransactionAsync(ct))
        {
            await db.LockTenantLedgerAsync(tenant, ct); await RequireAccess(ct);
            var row = await db.WhatsAppConnections.AsNoTracking().SingleOrDefaultAsync(x => x.TenantId == tenant, ct);
            if (!Current(row)) throw new ConflictException("Connect a current business account first.", "WHATSAPP_NOT_CONNECTED");
            if (row!.HealthLeaseUntil > clock.Now) throw new ConflictException("A provider check is already running.", "WHATSAPP_HEALTH_CHECKING");
            if (row.HealthAttemptedAt > clock.Now.AddMinutes(-1)) throw new TooManyRequestsException("Wait a minute between provider checks.");
            await db.WhatsAppConnections.Where(x => x.Id == row.Id && x.TenantId == tenant).ExecuteUpdateAsync(s => s
                .SetProperty(x => x.HealthAttemptedAt, clock.Now).SetProperty(x => x.HealthLeaseId, lease)
                .SetProperty(x => x.HealthLeaseUntil, clock.Now.AddSeconds(30)).SetProperty(x => x.HealthState, "checking")
                .SetProperty(x => x.HealthCheckedAt, (DateTime?)null).SetProperty(x => x.HealthConfigurationHash, (string?)null)
                .SetProperty(x => x.HealthTokenValid, (bool?)null).SetProperty(x => x.HealthScopesPresent, (bool?)null)
                .SetProperty(x => x.HealthAssetsVerified, (bool?)null).SetProperty(x => x.HealthAppSubscribed, (bool?)null)
                .SetProperty(x => x.HealthPhoneVerified, (bool?)null), ct);
            await claim.CommitAsync(ct);
            snapshot = row;
        }
        // Capture immutable connection fields before network I/O; no database transaction spans provider requests.
        var id = snapshot.Id; var epoch = snapshot.ConnectedAt; var protectedToken = snapshot.AccessTokenProtected;
        var previousExpiry = snapshot.TokenExpiresAt;
        WhatsAppProviderHealth result;
        try { result = await provider.InspectAsync(secrets.Unprotect(protectedToken), snapshot.BusinessAccountId, snapshot.PhoneNumberId, ct); }
        catch (ConflictException) { result = new(null, null, null, null, null, null); }
        catch (CryptographicException) { result = new(null, null, null, null, null, null); }
        // Caller cancellation leaves the durable lease to expire; a late result cannot restore a disconnected mapping.
        await using var finish = await db.Database.BeginTransactionAsync(ct);
        await db.LockTenantLedgerAsync(tenant, ct); await RequireAccess(ct);
        // The claim used a detached snapshot: fetch the current row after network I/O.
        snapshot = await db.WhatsAppConnections.SingleOrDefaultAsync(x => x.Id == id && x.TenantId == tenant, ct)
            ?? throw new ConflictException("The connection was removed.", "WHATSAPP_HEALTH_STALE");
        if (!Current(snapshot) || snapshot.Id != id || snapshot.ConnectedAt != epoch || snapshot.AccessTokenProtected != protectedToken
            || snapshot.TokenExpiresAt != previousExpiry || snapshot.HealthLeaseId != lease || snapshot.HealthLeaseUntil <= clock.Now
            || ConfigurationHash != configuration)
            throw new ConflictException("The connection changed. Review integration status.", "WHATSAPP_HEALTH_STALE");
        snapshot.HealthTokenValid = result.TokenValid; snapshot.HealthScopesPresent = result.ScopesPresent;
        snapshot.HealthAssetsVerified = result.AssetsVerified; snapshot.HealthAppSubscribed = result.AppSubscribed;
        snapshot.HealthPhoneVerified = result.PhoneVerified; snapshot.HealthCheckedAt = clock.Now; snapshot.HealthConfigurationHash = configuration;
        snapshot.HealthState = result.TokenValid == null ? "unavailable"
            : result.TokenValid == true && result.ScopesPresent == true && result.AssetsVerified == true
                && result.AppSubscribed == true && result.PhoneVerified == true ? "verified" : "attention";
        snapshot.HealthLeaseId = null; snapshot.HealthLeaseUntil = null;
        // Only a verified token inspection may shorten a known expiry or establish a previously unknown expiry.
        if (result.TokenValid == true && result.TokenExpiresAt is { } expiry
            && (snapshot.TokenExpiresAt == null || expiry < snapshot.TokenExpiresAt)) snapshot.TokenExpiresAt = expiry;
        recorder.Audit("whatsapp.health.checked", "WhatsAppConnection", snapshot.Id);
        await db.SaveChangesAsync(ct); await finish.CommitAsync(ct); return Status(snapshot, true);
    }
}
