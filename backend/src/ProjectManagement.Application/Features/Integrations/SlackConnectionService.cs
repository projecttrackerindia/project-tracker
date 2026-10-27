using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
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

public class SlackOptions
{
    public const string Section = "Slack";
    public string? ClientId { get; set; }
    public string? ClientSecret { get; set; }
    public string? SigningSecret { get; set; }
    public string? RedirectUri { get; set; }
    public string? AppId { get; set; }
    /// <summary>Also ask Slack for channel reading at install (channels:history, groups:history), so project agents can read a linked channel.
    /// Off by default; an existing installation has to be connected again to gain it.</summary>
    public bool AgentChannels { get; set; }
    public bool Configured => !string.IsNullOrWhiteSpace(ClientId) && !string.IsNullOrWhiteSpace(ClientSecret)
        && !string.IsNullOrWhiteSpace(SigningSecret) && !string.IsNullOrWhiteSpace(AppId)
        && Uri.TryCreate(RedirectUri, UriKind.Absolute, out var uri) && uri.Scheme == "https";
}

public record SlackStatusDto(bool Configured, bool Eligible, bool Connected, string? TeamId, string? TeamName,
    DateTime? ConnectedAt, string? LastError, bool InteractiveEnabled = false);
public record SlackConnectStart(string Url, string BrowserProof);

/// <summary>Installation foundation only. No Slack identity is granted access to business data by installing the app.</summary>
public class SlackConnectionService(IAppDbContext db, CurrentContext ctx, EntitlementService entitlements,
    AppClock clock, Recorder recorder, IOptions<SlackOptions> options, IHttpClientFactory http, ISecretProtector secrets,
    ProjectManagement.Application.Features.Platform.DataLocationService dataLocation)
{
    private readonly SlackOptions _o = options.Value;
    public const string Scopes = "chat:write,app_mentions:read,im:history,im:write,users:read";
    /// <summary>What is asked for at install: the required scopes, plus channel reading for the project agent when that is switched on.</summary>
    private string RequestedScopes => _o.AgentChannels ? Scopes + ",channels:history,groups:history" : Scopes;
    private static string Hash(string raw) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(raw)));
    private static string Random() => Convert.ToHexString(RandomNumberGenerator.GetBytes(32));

    private async Task RequireAdminAsync(Guid tenant, Guid user, CancellationToken ct)
    {
        var role = await db.TenantMembers.AsNoTracking().Where(x => x.TenantId == tenant && x.UserId == user).Select(x => (TenantRole?)x.Role).SingleOrDefaultAsync(ct);
        if (role is not (TenantRole.Owner or TenantRole.Admin)
            || !await db.Users.AnyAsync(x => x.Id == user && x.IsActive && !x.MustChangePassword, ct)
            || !await db.Tenants.AnyAsync(x => x.Id == tenant && x.Type == WorkspaceType.Organization, ct))
            throw new ForbiddenException("Only an organization owner or administrator can manage Slack.");
    }

    public async Task<bool> EligibleAsync(Guid tenant, CancellationToken ct)
    {
        var sub = await db.Subscriptions.AsNoTracking().Include(x => x.Plan).SingleOrDefaultAsync(x => x.TenantId == tenant, ct);
        return sub is { Status: SubscriptionStatus.Active, Plan.IsActive: true }
            && (sub.CurrentPeriodEnd is null || sub.CurrentPeriodEnd > clock.Now)
            && (await entitlements.GetEntitlementsAsync(tenant, ct)).GetValueOrDefault(FeatureKeys.SlackIntegration) > 0;
    }

    private async Task RequireEligibleAsync(Guid tenant, CancellationToken ct)
    {
        if (!await EligibleAsync(tenant, ct)) throw new ForbiddenException("Slack requires an active subscription with Slack integration enabled. Review your plan.", "SLACK_PLAN_REQUIRED");
    }

    public async Task<SlackStatusDto> StatusAsync(CancellationToken ct)
    {
        var tenant = ctx.RequireTenantId(); await RequireAdminAsync(tenant, ctx.RequireUserId(), ct);
        var c = await db.SlackConnections.AsNoTracking().SingleOrDefaultAsync(x => x.TenantId == tenant, ct);
        return new(_o.Configured, await EligibleAsync(tenant, ct), c?.Active == true, c?.TeamId, c?.TeamName, c?.ConnectedAt, c?.LastError);
    }

    public async Task<SlackConnectStart> StartAsync(CancellationToken ct)
    {
        var tenant = ctx.RequireTenantId(); var user = ctx.RequireUserId();
        await RequireAdminAsync(tenant, user, ct); await RequireEligibleAsync(tenant, ct);
        await dataLocation.EnsureAllowedAsync("slack", ct);
        if (!_o.Configured) throw new ConflictException("Slack OAuth is not configured by the platform administrator.", "SLACK_NOT_CONFIGURED");
        if (await db.SlackConnections.AnyAsync(x => x.TenantId == tenant, ct))
            throw new ConflictException("Disconnect this organization's existing workspace before connecting another.", "SLACK_ALREADY_CONNECTED");
        // Bounded cleanup and admission. States contain hashes only; browser proof is held in an HttpOnly cookie.
        await db.SlackOAuthAttempts.Where(x => x.ExpiresAt < clock.Now).Take(100).ExecuteDeleteAsync(ct);
        await db.SlackEventReceipts.Where(x => x.ReceivedAt < clock.Now.AddDays(-30)).Take(100).ExecuteDeleteAsync(ct);
        if (await db.SlackOAuthAttempts.CountAsync(x => x.TenantId == tenant && x.ExpiresAt > clock.Now && x.ConsumedAt == null, ct) >= 5)
            throw new TooManyRequestsException("Finish a pending Slack connection or wait ten minutes.");
        var state = Random(); var browser = Random();
        var slug = await db.Tenants.Where(x => x.Id == tenant).Select(x => x.Slug).SingleAsync(ct);
        db.SlackOAuthAttempts.Add(new SlackOAuthAttempt { TenantId = tenant, UserId = user, StateHash = Hash(state), BrowserHash = Hash(browser),
            ReturnPath = $"/{slug}/settings/slack", ExpiresAt = clock.Now.AddMinutes(10) });
        await db.SaveChangesAsync(ct);
        var url = "https://slack.com/oauth/v2/authorize?client_id=" + Uri.EscapeDataString(_o.ClientId!)
            + "&scope=" + Uri.EscapeDataString(RequestedScopes) + "&redirect_uri=" + Uri.EscapeDataString(_o.RedirectUri!) + "&state=" + state;
        return new(url, browser);
    }

    public async Task<string> CompleteAsync(string? state, string? proof, string? code, string? error, CancellationToken ct)
    {
        if (!_o.Configured || state?.Length != 64 || proof?.Length != 64)
            throw new UnauthorizedException("Restart Slack installation from organization settings.", "SLACK_STATE_INVALID");
        var hash = Hash(state); var browser = Hash(proof);
        var p = await db.SlackOAuthAttempts.AsNoTracking().SingleOrDefaultAsync(x => x.StateHash == hash && x.BrowserHash == browser && x.ExpiresAt > clock.Now && x.ConsumedAt == null, ct)
            ?? throw new UnauthorizedException("Slack installation expired or was already used.", "SLACK_STATE_INVALID");
        if (ctx.UserId is { } uid && uid != p.UserId) throw new UnauthorizedException("The installer account changed.", "SLACK_STATE_INVALID");
        // Public callback establishes only the saved organization/user for installation metadata, then rechecks membership and subscription.
        ctx.TenantId = p.TenantId; ctx.UserId = p.UserId;
        await RequireAdminAsync(p.TenantId, p.UserId, ct); await RequireEligibleAsync(p.TenantId, ct);
        if (await db.SlackOAuthAttempts.Where(x => x.Id == p.Id && x.ConsumedAt == null && x.ExpiresAt > clock.Now)
            .ExecuteUpdateAsync(s => s.SetProperty(x => x.ConsumedAt, clock.Now), ct) != 1)
            throw new UnauthorizedException("This Slack installation was already used.", "SLACK_STATE_INVALID");
        if (!string.IsNullOrEmpty(error) || string.IsNullOrEmpty(code)) return p.ReturnPath + "?slack=declined";
        if (code.Length > 1000) throw new ValidationException("code", "Invalid OAuth code.");
        using var form = new FormUrlEncodedContent(new Dictionary<string, string> { ["client_id"] = _o.ClientId!, ["client_secret"] = _o.ClientSecret!, ["redirect_uri"] = _o.RedirectUri!, ["code"] = code });
        using var response = await http.CreateClient("slack").PostAsync("https://slack.com/api/oauth.v2.access", form, ct);
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
        var root = json.RootElement;
        if (!response.IsSuccessStatusCode || !root.TryGetProperty("ok", out var ok) || !ok.GetBoolean())
            throw new ConflictException("Slack did not complete installation. Start again.", "SLACK_OAUTH_FAILED");
        var appId = root.GetProperty("app_id").GetString();
        if (!root.TryGetProperty("team", out var team) || team.ValueKind != JsonValueKind.Object
            || (root.TryGetProperty("is_enterprise_install", out var enterprise) && enterprise.GetBoolean()))
            throw new ConflictException("Install into a concrete Slack workspace. Enterprise-wide grants are not supported yet.", "SLACK_INSTALL_INVALID");
        var teamId = team.GetProperty("id").GetString();
        var token = root.GetProperty("access_token").GetString(); var botId = root.GetProperty("bot_user_id").GetString();
        var scopes = root.GetProperty("scope").GetString() ?? "";
        if (appId != _o.AppId || string.IsNullOrWhiteSpace(teamId) || teamId.Length > 40 || string.IsNullOrWhiteSpace(botId) || botId.Length > 40
            || token?.StartsWith("xoxb-", StringComparison.Ordinal) != true || root.TryGetProperty("refresh_token", out _)
            || !Scopes.Split(',').All(s => scopes.Split(',').Contains(s)))
            throw new ConflictException("Slack returned an unsupported installation or missing permissions. Review the app configuration.", "SLACK_INSTALL_INVALID");
        // A workspace cannot silently be redirected from one customer's organization to another.
        if (await db.SlackConnections.IgnoreQueryFilters().AnyAsync(x => x.TeamId == teamId || x.TenantId == p.TenantId, ct))
            throw new ConflictException("This organization or Slack workspace already has an installation. Disconnect it first.", "SLACK_INSTALL_CONFLICT");
        await RequireAdminAsync(p.TenantId, p.UserId, ct); await RequireEligibleAsync(p.TenantId, ct);
        var connection = new SlackConnection { TenantId = p.TenantId, TeamId = teamId!, TeamName = team.GetProperty("name").GetString() ?? "Slack workspace",
            AppId = appId!, BotUserId = botId!, BotTokenProtected = secrets.Protect(token!), Scopes = scopes, InstalledBy = p.UserId, ConnectedAt = clock.Now, Active = true };
        db.SlackConnections.Add(connection);
        recorder.Audit("slack.connected", "SlackConnection", connection.Id, tenantId: p.TenantId, userId: p.UserId);
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateException) { throw new ConflictException("Another Slack installation completed first. Review organization settings.", "SLACK_INSTALL_CONFLICT"); }
        return p.ReturnPath + "?slack=connected";
    }

    public async Task DisconnectAsync(CancellationToken ct)
    {
        var tenant = ctx.RequireTenantId(); await RequireAdminAsync(tenant, ctx.RequireUserId(), ct);
        var c = await db.SlackConnections.SingleOrDefaultAsync(x => x.TenantId == tenant, ct);
        if (c is null) return;
        // Remove usable credentials first, even when Slack is unavailable. An explicit disconnect may run after plan expiry.
        var token = c.BotTokenProtected.Length > 0 ? secrets.Unprotect(c.BotTokenProtected) : null;
        db.SlackConnections.Remove(c);
        await db.SlackOAuthAttempts.Where(x => x.TenantId == tenant && x.ConsumedAt == null).ExecuteDeleteAsync(ct);
        recorder.Audit("slack.disconnected", "SlackConnection", c.Id);
        await db.SaveChangesAsync(ct);
        if (token is null) return;
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, "https://slack.com/api/auth.revoke");
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            using var response = await http.CreateClient("slack").SendAsync(request, ct);
            using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
            if (!response.IsSuccessStatusCode || !json.RootElement.GetProperty("ok").GetBoolean())
                throw new ConflictException("Disconnected locally. Remove the app from Slack to finish revoking access.", "SLACK_REVOKE_PENDING");
        }
        catch (HttpRequestException) { throw new ConflictException("Disconnected locally. Remove the app from Slack to finish revoking access.", "SLACK_REVOKE_PENDING"); }
        catch (TaskCanceledException) { throw new ConflictException("Disconnected locally. Remove the app from Slack to finish revoking access.", "SLACK_REVOKE_PENDING"); }
        catch (JsonException) { throw new ConflictException("Disconnected locally. Remove the app from Slack to finish revoking access.", "SLACK_REVOKE_PENDING"); }
    }

    public bool VerifySignature(string timestamp, string signature, ReadOnlySpan<byte> body)
    {
        if (string.IsNullOrEmpty(_o.SigningSecret) || !long.TryParse(timestamp, out var unix)
            || Math.Abs((decimal)new DateTimeOffset(clock.Now).ToUnixTimeSeconds() - unix) > 300 || signature.Length != 67 || !signature.StartsWith("v0=")) return false;
        var prefix = Encoding.UTF8.GetBytes("v0:" + timestamp + ":");
        var input = new byte[prefix.Length + body.Length]; prefix.CopyTo(input, 0); body.CopyTo(input.AsSpan(prefix.Length));
        var expected = "v0=" + Convert.ToHexString(HMACSHA256.HashData(Encoding.UTF8.GetBytes(_o.SigningSecret), input)).ToLowerInvariant();
        return CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(expected), Encoding.ASCII.GetBytes(signature));
    }

    public async Task RevokeFromEventAsync(string appId, string teamId, string eventId, long eventTime, IReadOnlyList<string>? botIds, CancellationToken ct)
    {
        if (appId != _o.AppId || teamId.Length > 40 || string.IsNullOrWhiteSpace(eventId) || eventId.Length > 128) return;
        var c = await db.SlackConnections.IgnoreQueryFilters().AsNoTracking().SingleOrDefaultAsync(x => x.TeamId == teamId && x.AppId == appId, ct);
        if (c is null || eventTime < new DateTimeOffset(c.ConnectedAt).ToUnixTimeSeconds() || (botIds is not null && !botIds.Contains(c.BotUserId))) return;
        ctx.TenantId = c.TenantId; ctx.UserId = null;
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        // Take the same audit lock before touching installation rows as other organization transactions.
        await db.LockTenantLedgerAsync(c.TenantId, ct);
        if (await db.SlackEventReceipts.AnyAsync(x => x.AppId == appId && x.TeamId == teamId && x.EventId == eventId, ct)) return;
        db.SlackEventReceipts.Add(new SlackEventReceipt { AppId = appId, TeamId = teamId, EventId = eventId, ReceivedAt = clock.Now });
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateException)
        {
            await tx.RollbackAsync(ct);
            await tx.DisposeAsync();
            if (await db.SlackEventReceipts.AsNoTracking().AnyAsync(x => x.AppId == appId && x.TeamId == teamId && x.EventId == eventId, ct)) return;
            throw;
        }
        // Idempotent update; events never run an AI model or a business action in this phase.
        var changed = await db.SlackConnections.Where(x => x.Id == c.Id && x.TenantId == c.TenantId && x.Active)
            .ExecuteUpdateAsync(s => s.SetProperty(x => x.Active, false).SetProperty(x => x.BotTokenProtected, "").SetProperty(x => x.LastError, "SLACK_REVOKED"), ct);
        if (changed == 1) { recorder.Audit("slack.revoked", "SlackConnection", c.Id, tenantId: c.TenantId); await db.SaveChangesAsync(ct); }
        await tx.CommitAsync(ct);
    }
}
