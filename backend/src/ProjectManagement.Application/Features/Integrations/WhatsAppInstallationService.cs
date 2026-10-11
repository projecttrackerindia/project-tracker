using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Services;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Integrations;

public record WhatsAppConnectStart(string State, string BrowserProof, string AppId, string ConfigId, string ApiVersion, string SignupVersion);
public record WhatsAppConnectRequest(string State, string Code, string BusinessAccountId, string PhoneNumberId);
public record WhatsAppVerifiedInstallation(string AccessToken, string BusinessAccountId, string PhoneNumberId, string DisplayName, DateTime? TokenExpiresAt);
public interface IWhatsAppInstallationProvider
{
    Task<WhatsAppVerifiedInstallation> ExchangeAndVerifyAsync(string code, string businessAccountId, string phoneNumberId, CancellationToken ct);
}

/// <summary>Browser-bound, authenticated organization installation only. No contact access or messaging grant is inferred.</summary>
public class WhatsAppInstallationService(IAppDbContext db, CurrentContext ctx, AppClock clock, Recorder recorder,
    WhatsAppGatewayService gateway, IOptions<WhatsAppOptions> options, IWhatsAppInstallationProvider provider, ISecretProtector secrets)
{
    private const string Provider = "whatsapp";
    private WhatsAppOptions Options => options.Value;
    private static string Random() => Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
    private static string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
    private string ConfigurationHash() => Hash(string.Join("|", Options.AppId, Options.AppSecret, Options.EmbeddedSignupConfigId, Options.ApiVersion, Options.SignupVersion));
    private void RequireSameConfiguration(ProviderOAuthAttempt attempt)
    {
        try
        {
            var saved = secrets.Unprotect(attempt.VerifierProtected ?? "");
            if (!CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(saved), Encoding.ASCII.GetBytes(ConfigurationHash())))
                throw new ConflictException("WhatsApp configuration changed. Start installation again.", "WHATSAPP_CONFIGURATION_CHANGED");
        }
        catch (CryptographicException) { throw new ConflictException("Restart WhatsApp installation.", "WHATSAPP_CONFIGURATION_CHANGED"); }
    }
    private void RequireEnabled()
    {
        if (!Options.InstallationEnabled || !Options.InstallationConfigured)
            throw new ConflictException("WhatsApp installation is awaiting platform setup.", "WHATSAPP_INSTALLATION_DISABLED");
    }
    private async Task RequireAccessAsync(CancellationToken ct)
    {
        await gateway.RequireAdminAsync(ct);
        if (!await gateway.EligibleAsync(ctx.RequireTenantId(), ct))
            throw new ForbiddenException("WhatsApp requires an active subscription with integration access.", "WHATSAPP_PLAN_REQUIRED");
    }
    public async Task<WhatsAppConnectStart> StartAsync(CancellationToken ct)
    {
        await RequireAccessAsync(ct); RequireEnabled();
        var tenant = ctx.RequireTenantId(); var user = ctx.RequireUserId();
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        await db.LockTenantLedgerAsync(tenant, ct);
        await RequireAccessAsync(ct);
        if (await db.WhatsAppConnections.AnyAsync(x => x.TenantId == tenant && x.Active && (x.TokenExpiresAt == null || x.TokenExpiresAt > clock.Now), ct))
            throw new ConflictException("Disconnect the existing business connection before reconnecting.", "WHATSAPP_ALREADY_CONNECTED");
        await db.ProviderOAuthAttempts.Where(x => x.Provider == Provider && x.TenantId == tenant && x.ExpiresAt < clock.Now)
            .Take(100).ExecuteDeleteAsync(ct);
        if (await db.ProviderOAuthAttempts.CountAsync(x => x.Provider == Provider && x.TenantId == tenant
                && x.ConsumedAt == null && x.ExpiresAt > clock.Now, ct) >= 5)
            throw new TooManyRequestsException("Finish a pending WhatsApp installation or wait ten minutes.");
        var state = Random(); var proof = Random();
        db.ProviderOAuthAttempts.Add(new ProviderOAuthAttempt { Provider = Provider, TenantId = tenant, UserId = user,
            StateHash = Hash(state), BrowserHash = Hash(proof), VerifierProtected = secrets.Protect(ConfigurationHash()), ReturnPath = "/settings/whatsapp", ExpiresAt = clock.Now.AddMinutes(10) });
        await db.SaveChangesAsync(ct); await tx.CommitAsync(ct);
        return new(state, proof, Options.AppId!, Options.EmbeddedSignupConfigId!, Options.ApiVersion!, Options.SignupVersion!);
    }
    private async Task<ProviderOAuthAttempt> AttemptAsync(string? state, string? proof, CancellationToken ct)
    {
        var tenant = ctx.RequireTenantId(); var user = ctx.RequireUserId();
        if (state is not { Length: 64 } || proof is not { Length: 64 })
            throw new UnauthorizedException("Restart WhatsApp installation in the same browser.", "WHATSAPP_STATE_INVALID");
        var sh = Hash(state); var ph = Hash(proof);
        return await db.ProviderOAuthAttempts.AsNoTracking().SingleOrDefaultAsync(x => x.Provider == Provider
            && x.TenantId == tenant && x.UserId == user && x.StateHash == sh && x.BrowserHash == ph
            && x.ConsumedAt == null && x.ExpiresAt > clock.Now, ct)
            ?? throw new UnauthorizedException("WhatsApp installation expired or was already used.", "WHATSAPP_STATE_INVALID");
    }
    public async Task CancelAsync(string? state, string? proof, CancellationToken ct)
    {
        await gateway.RequireAdminAsync(ct);
        var attempt = await AttemptAsync(state, proof, ct);
        await db.ProviderOAuthAttempts.Where(x => x.Id == attempt.Id && x.ConsumedAt == null)
            .ExecuteUpdateAsync(s => s.SetProperty(x => x.ConsumedAt, clock.Now), ct);
    }
    public async Task CompleteAsync(WhatsAppConnectRequest request, string? proof, CancellationToken ct)
    {
        await RequireAccessAsync(ct); RequireEnabled();
        if (request.Code is not { Length: > 0 and <= 2000 } || request.Code.Any(char.IsControl)
            || !WhatsAppGatewayService.ProviderId(request.BusinessAccountId) || !WhatsAppGatewayService.ProviderId(request.PhoneNumberId))
            throw new ValidationException("installation", "Invalid WhatsApp installation result.");
        var attempt = await AttemptAsync(request.State, proof, ct);
        RequireSameConfiguration(attempt);
        if (await db.ProviderOAuthAttempts.Where(x => x.Id == attempt.Id && x.ConsumedAt == null && x.ExpiresAt > clock.Now)
                .ExecuteUpdateAsync(s => s.SetProperty(x => x.ConsumedAt, clock.Now), ct) != 1)
            throw new UnauthorizedException("WhatsApp installation was already used.", "WHATSAPP_STATE_INVALID");

        // Meta exchanges the code using this platform's configured app credentials. Asset hints still require provider read-back.
        var verified = await provider.ExchangeAndVerifyAsync(request.Code, request.BusinessAccountId, request.PhoneNumberId, ct);
        if (verified.BusinessAccountId != request.BusinessAccountId || verified.PhoneNumberId != request.PhoneNumberId
            || verified.AccessToken is not { Length: > 0 and <= 10000 } || verified.AccessToken.Any(char.IsControl)
            || verified.DisplayName is not { Length: > 0 and <= 200 } || verified.DisplayName.Any(char.IsControl)
            || verified.TokenExpiresAt is { } expiry && expiry <= clock.Now)
            throw new ConflictException("The provider did not verify the selected business connection.", "WHATSAPP_INSTALLATION_INVALID");

        var tenant = ctx.RequireTenantId(); var user = ctx.RequireUserId();
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        await db.LockTenantLedgerAsync(tenant, ct);
        RequireEnabled(); RequireSameConfiguration(attempt); await RequireAccessAsync(ct);
        // Disconnect deletes even consumed attempts: a late provider response cannot restore removed credentials.
        if (!await db.ProviderOAuthAttempts.AnyAsync(x => x.Id == attempt.Id && x.Provider == Provider
                && x.TenantId == tenant && x.UserId == user && x.ConsumedAt != null && x.ExpiresAt > clock.Now, ct))
            throw new UnauthorizedException("This installation was cancelled. Start again.", "WHATSAPP_STATE_INVALID");
        var row = await db.WhatsAppConnections.SingleOrDefaultAsync(x => x.TenantId == tenant, ct);
        if (row is not null && (row.Active && (row.TokenExpiresAt == null || row.TokenExpiresAt > clock.Now) || row.AppId != Options.AppId
                || row.BusinessAccountId != verified.BusinessAccountId || row.PhoneNumberId != verified.PhoneNumberId))
            throw new ConflictException("This organization has a reserved business mapping. Reconnect the same account or contact support.", "WHATSAPP_INSTALLATION_CONFLICT");
        // Exact installation metadata only: never inspect another organization's projects, contacts or messages.
        if (await db.WhatsAppConnections.IgnoreQueryFilters().AnyAsync(x => x.TenantId != tenant
                && x.AppId == Options.AppId && x.PhoneNumberId == verified.PhoneNumberId, ct))
            throw new ConflictException("This business phone already belongs to another organization.", "WHATSAPP_INSTALLATION_CONFLICT");
        if (row is null) { row = new WhatsAppConnection { TenantId = tenant }; db.WhatsAppConnections.Add(row); }
        row.AppId = Options.AppId!; row.BusinessAccountId = verified.BusinessAccountId; row.PhoneNumberId = verified.PhoneNumberId;
        row.DisplayName = verified.DisplayName; row.AccessTokenProtected = secrets.Protect(verified.AccessToken);
        row.InstalledBy = user; row.ConnectedAt = clock.Now; row.TokenExpiresAt = verified.TokenExpiresAt; row.Active = true;
        recorder.Audit("whatsapp.connected", "WhatsAppConnection", row.Id);
        try { await db.SaveChangesAsync(ct); await tx.CommitAsync(ct); }
        catch (DbUpdateException) { throw new ConflictException("Another installation completed first. Review organization settings.", "WHATSAPP_INSTALLATION_CONFLICT"); }
    }
}