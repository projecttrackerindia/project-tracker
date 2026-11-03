using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Auth;

/// <summary>What the new device is given: the request to watch, the secret only it holds, and what to show (the code and how it is described).</summary>
public record SessionApprovalStartDto(Guid ApprovalId, string Secret, int Code, string Device, string App, string? Location, string? IpAddress, DateTime ExpiresAt);
public record SessionApprovalSecretRequest(string? Secret);
public record SessionApprovalCodeRequest(string? Secret, string? Code);
public record SessionApprovalDecideRequest(string? Token, string? Decision);
public record SessionApprovalEmailRequest(string? Token);
/// <summary>
/// Where a waiting sign-in stands: pending, approved (with the session), rejected, timed_out (the fallback may be used: an emailed link always,
/// an authenticator code when the account has one) or closed (nothing more can happen).
/// </summary>
public record SessionApprovalStatusDto(string Status, int Code, string Device, DateTime ExpiresAt, bool CanEmail, bool CanCode, bool EmailSent, string? Message = null);
public record SessionApprovalPollResult(SessionApprovalStatusDto Status, AuthResult? Session);
/// <summary>What a signed-in device is asked: who is signing in, from where, the code the new device shows, and a signed one-time token to answer with.</summary>
public record SessionApprovalPendingDto(Guid Id, string Device, string App, string? Location, string? IpAddress, string Method, int Code, DateTime CreatedAt, DateTime ExpiresAt, string Token);
public record SessionApprovalHistoryDto(Guid Id, DateTime CreatedAt, string Device, string App, string? Location, string? IpAddress, string Outcome, string? DecidedVia, DateTime? DecidedAt);
public record SessionApprovalEmailPreviewDto(string Device, string App, string? Location, string? IpAddress, DateTime CreatedAt);
public record SessionPolicyDto(bool SingleSession, bool Effective, IReadOnlyList<string> RequiredBy);
public record SetSessionPolicyRequest(bool SingleSession);
public record WorkspaceSessionPolicyDto(bool SingleActiveSession, bool CanManage);
public record SetWorkspaceSessionPolicyRequest(bool SingleActiveSession);

/// <summary>
/// The sign-in has passed its password (and two-step) checks, but a device already signed in must allow it first. Caught by the API layer, which
/// gives the new device its secret (HttpOnly cookie, or the body for API clients) and the details to show on the waiting screen.
/// </summary>
public class SessionApprovalRequired(SessionApprovalStartDto start) : Exception("Approval on another signed-in device is required.")
{
    public SessionApprovalStartDto Start { get; } = start;
}

/// <summary>Live delivery of approval prompts and "you were signed out" to open apps (SignalR in the API; nothing in background jobs).</summary>
public interface ISessionApprovalNotifier
{
    Task PromptAsync(Guid userId, SessionApprovalPendingDto prompt, CancellationToken ct = default);
    Task ClosedAsync(Guid userId, Guid approvalId, string outcome, CancellationToken ct = default);
    Task SignedOutAsync(Guid userId, IReadOnlyCollection<Guid> sessionIds, string message, CancellationToken ct = default);
}

/// <summary>Facts about the client that the request headers carry (filled in by the API for each request): client hints, the device's time zone and,
/// only when Geo:TrustProxyHeaders is on, the country and city a trusted proxy in front of the API (Cloudflare) worked out.</summary>
public class SignInClient
{
    public string? Platform { get; set; }
    public bool Mobile { get; set; }
    public string? TimeZone { get; set; }
    public string? Country { get; set; }
    public string? City { get; set; }
}

/// <summary>How a device is described to a person: "Chrome on Windows", web / desktop / phone, and an approximate place. Pure, so it is unit-tested.</summary>
public static class SessionDevice
{
    public static string App(string? ua, bool mobileHint)
    {
        ua ??= "";
        if (ua.Contains("ProjectTrackerDesktop/")) return "desktop";
        if (ua.Contains("ProjectTrackerApp") || mobileHint || ua.Contains("iPhone") || (ua.Contains("Android") && ua.Contains("Mobile"))) return "phone";
        return "web";
    }

    public static string Describe(string? ua, string? platformHint, string app)
    {
        var platform = Clean(platformHint);
        if (app == "desktop") return Text.Truncate($"Desktop app on {OsOf(ua) ?? platform ?? "a computer"}", 80)!;
        if (app == "phone" && (ua ?? "").Contains("ProjectTrackerApp")) return "Android app";
        var described = DeviceLoginService.Describe(ua);
        // Client hints name the system more reliably than an old or frozen browser string does.
        if (platform is not null && !described.Contains(" on ") && !string.IsNullOrWhiteSpace(ua)) described = $"{described} on {platform}";
        return Text.Truncate(described, 80)!;
    }

    private static string? OsOf(string? ua)
    {
        var d = DeviceLoginService.Describe(ua);
        var i = d.IndexOf(" on ", StringComparison.Ordinal);
        return i < 0 ? null : d[(i + 4)..];
    }

    private static string? Clean(string? hint)
    {
        var v = (hint ?? "").Trim().Trim('"').Trim();
        return v.Length is 0 or > 24 || v.Equals("Unknown", StringComparison.OrdinalIgnoreCase) ? null : v;
    }

    /// <summary>
    /// The approximate place: the city and country a trusted proxy reported; otherwise the region of the device's own time zone ("Kolkata region");
    /// a private or loopback address is "Local network". Nothing is looked up with a third party.
    /// </summary>
    public static string? Location(string? ip, SignInClient? client, bool trustProxy)
    {
        if (IPAddress.TryParse(ip ?? "", out var a))
        {
            if (a.IsIPv4MappedToIPv6) a = a.MapToIPv4();
            if (IPAddress.IsLoopback(a) || ProjectManagement.Application.Features.Voice.ConnectorCaller.Private(a)) return "Local network";
        }
        if (trustProxy && client?.Country is { Length: 2 } cc && cc != "XX" && cc != "T1")
        {
            var country = CountryName(cc);
            var city = Text.Truncate(client.City?.Trim(), 60);
            return string.IsNullOrWhiteSpace(city) ? country : $"{city}, {country}";
        }
        var zone = client?.TimeZone?.Trim();
        if (!string.IsNullOrEmpty(zone) && zone.Contains('/') && zone.Length <= 40 && !zone.StartsWith("Etc/", StringComparison.Ordinal))
            return $"{zone[(zone.LastIndexOf('/') + 1)..].Replace('_', ' ')} region";
        return null;
    }

    private static string CountryName(string code)
    {
        try { return new System.Globalization.RegionInfo(code).EnglishName; }
        catch (ArgumentException) { return code.ToUpperInvariant(); }
    }
}

/// <summary>Signed, expiring tokens for answering an approval (HMAC-SHA256 with a key derived from the JWT signing key). Single use is enforced by the row.</summary>
public static class ApprovalTokens
{
    public static byte[] KeyFrom(IConfiguration config) =>
        SHA256.HashData(Encoding.UTF8.GetBytes("session-approval|" + (config["Jwt:SigningKey"] ?? throw new InvalidOperationException("Jwt:SigningKey is not set."))));

    private static string Sign(byte[] key, string payload) => Base64Url(HMACSHA256.HashData(key, Encoding.UTF8.GetBytes(payload)));
    private static string Base64Url(byte[] b) => Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    /// <summary>For a signed-in device's Allow / Reject: names the request, the account and when it stops being valid.</summary>
    public static string Decision(byte[] key, Guid approvalId, Guid userId, DateTime expiresAt)
    {
        var payload = $"d.{approvalId:N}.{userId:N}.{new DateTimeOffset(DateTime.SpecifyKind(expiresAt, DateTimeKind.Utc)).ToUnixTimeSeconds()}";
        return $"{payload}.{Sign(key, payload)}";
    }

    public static bool CheckDecision(byte[] key, string? token, Guid approvalId, Guid userId, DateTime now)
    {
        var parts = (token ?? "").Split('.');
        if (parts.Length != 5 || parts[0] != "d" || parts[1] != approvalId.ToString("N") || parts[2] != userId.ToString("N") || !long.TryParse(parts[3], out var exp)) return false;
        var payload = string.Join('.', parts[..4]);
        if (!CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(Sign(key, payload)), Encoding.ASCII.GetBytes(parts[4]))) return false;
        return DateTimeOffset.FromUnixTimeSeconds(exp).UtcDateTime > now;
    }

    /// <summary>For the emailed fallback link: the request and a random nonce (only its hash is kept, cleared when used).</summary>
    public static string Email(byte[] key, Guid approvalId, string nonce)
    {
        var payload = $"e.{approvalId:N}.{nonce}";
        return $"{payload}.{Sign(key, payload)}";
    }

    public static (Guid Id, string Nonce)? ReadEmail(byte[] key, string? token)
    {
        var parts = (token ?? "").Split('.');
        if (parts.Length != 4 || parts[0] != "e" || !Guid.TryParseExact(parts[1], "N", out var id) || parts[2].Length is 0 or > 128) return null;
        var payload = string.Join('.', parts[..3]);
        if (!CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(Sign(key, payload)), Encoding.ASCII.GetBytes(parts[3]))) return null;
        return (id, parts[2]);
    }
}

/// <summary>
/// Decides whether a sign-in must wait for approval, and starts the wait: the person (or an organization they belong to) has "Single active
/// session" on and the account is signed in somewhere else. The signed-in devices are prompted at once (in the app, and by push).
/// </summary>
public class SessionApprovalGate(IAppDbContext db, ICurrentContext ctx, AppClock clock, ITokenService tokens, Recorder recorder, SignInClient client,
    IConfiguration config, IServiceScopeFactory scopes, ILogger<SessionApprovalGate> log, ISessionApprovalNotifier? notifier = null)
{
    public static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(2);
    /// <summary>How long after asking the person can still let themselves in with the fallback (an emailed link or a code).</summary>
    public static readonly TimeSpan FallbackWindow = TimeSpan.FromMinutes(30);
    public const int MaxRequestsPer10Minutes = 5;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private bool TrustProxy => string.Equals(config["Geo:TrustProxyHeaders"], "true", StringComparison.OrdinalIgnoreCase);

    /// <summary>The person's own setting or the rule of any active organization they belong to.</summary>
    public async Task<bool> PolicyOnAsync(User user, CancellationToken ct = default)
    {
        if (user.SingleSession) return true;
        return await (from m in db.TenantMembers.IgnoreQueryFilters()
                      join s in db.TenantSecuritySettings.IgnoreQueryFilters() on m.TenantId equals s.TenantId
                      join t in db.Tenants.IgnoreQueryFilters() on m.TenantId equals t.Id
                      where m.UserId == user.Id && s.SingleActiveSession && !t.IsDeleted && t.Status == ProjectManagement.Domain.Enums.TenantStatus.Active
                      select m.Id).AnyAsync(ct);
    }

    /// <summary>The names of the organizations whose rule applies to the person (for the settings screen).</summary>
    public async Task<List<string>> RequiredByAsync(Guid userId, CancellationToken ct = default) =>
        await (from m in db.TenantMembers.IgnoreQueryFilters()
               join s in db.TenantSecuritySettings.IgnoreQueryFilters() on m.TenantId equals s.TenantId
               join t in db.Tenants.IgnoreQueryFilters() on m.TenantId equals t.Id
               where m.UserId == userId && s.SingleActiveSession && !t.IsDeleted && t.Status == ProjectManagement.Domain.Enums.TenantStatus.Active
               orderby t.Name
               select t.Name).ToListAsync(ct);

    public async Task<bool> RequiredAsync(User user, CancellationToken ct = default)
    {
        if (!await PolicyOnAsync(user, ct)) return false;
        var now = clock.Now;
        return await db.UserSessions.AnyAsync(s => s.UserId == user.Id && s.RevokedAt == null && s.ExpiresAt > now, ct);
    }

    public async Task<SessionApprovalStartDto> StartAsync(User user, string method, Guid? workspaceId, Guid? ssoTenantId, CancellationToken ct = default)
    {
        var now = clock.Now;
        var recent = await db.SessionApprovals.CountAsync(a => a.UserId == user.Id && a.CreatedAt > now.AddMinutes(-10), ct);
        if (recent >= MaxRequestsPer10Minutes)
        {
            recorder.Audit("session.approval_rate_limited", "User", user.Id, userId: user.Id);
            await db.SaveChangesAsync(ct);
            throw new TooManyRequestsException("Too many sign-in requests are waiting for approval. Try again in a few minutes.", "APPROVAL_RATE_LIMITED");
        }
        var agent = Text.Truncate(ctx.UserAgent, 300);
        var app = SessionDevice.App(agent, client.Mobile);
        var (raw, hash) = tokens.CreateOpaqueToken();
        var approval = new SessionApproval
        {
            UserId = user.Id, WorkspaceId = workspaceId, SsoTenantId = ssoTenantId, Method = Text.Truncate(method, 32)!, SecretHash = hash,
            Code = RandomNumberGenerator.GetInt32(10, 100), Status = SessionApprovalStatus.Pending, CreatedAt = now, ExpiresAt = now.Add(Lifetime),
            IpAddress = Text.Truncate(ctx.IpAddress, 64), UserAgent = agent, App = app, Device = SessionDevice.Describe(agent, client.Platform, app),
            Location = Text.Truncate(SessionDevice.Location(ctx.IpAddress, client, TrustProxy), 120),
        };
        db.SessionApprovals.Add(approval);
        // The history keeps 90 days.
        await db.SessionApprovals.Where(a => a.UserId == user.Id && a.CreatedAt < now.AddDays(-90)).ExecuteDeleteAsync(ct);
        recorder.Audit("session.approval_requested", "User", user.Id, newValue: new { approval.Device, approval.App, approval.IpAddress, approval.Location, Method = method }, userId: user.Id);
        await db.SaveChangesAsync(ct);
        await PromptAsync(approval, ct);
        return new SessionApprovalStartDto(approval.Id, raw, approval.Code, approval.Device, approval.App, approval.Location, approval.IpAddress, approval.ExpiresAt);
    }

    public SessionApprovalPendingDto PendingOf(SessionApproval a) =>
        new(a.Id, a.Device, a.App, a.Location, a.IpAddress, a.Method, a.Code, a.CreatedAt, a.ExpiresAt, ApprovalTokens.Decision(ApprovalTokens.KeyFrom(config), a.Id, a.UserId, a.ExpiresAt));

    private async Task PromptAsync(SessionApproval a, CancellationToken ct)
    {
        var prompt = PendingOf(a);
        if (notifier is not null)
        {
            try { await notifier.PromptAsync(a.UserId, prompt, ct); }
            catch (Exception ex) when (ex is not OperationCanceledException) { log.LogDebug(ex, "The approval prompt could not be sent live"); }
        }
        await PushAsync(a, ct);
    }

    /// <summary>Web and desktop push to every device of the person that has notifications on: sent at once, someone is waiting at the other screen.</summary>
    private async Task PushAsync(SessionApproval a, CancellationToken ct)
    {
        try
        {
            var devices = await db.PushSubscriptions.Where(s => s.UserId == a.UserId && s.Failures < 20).ToListAsync(ct);
            if (devices.Count == 0) return;
            using var scope = scopes.CreateScope();
            var sp = scope.ServiceProvider;
            var keys = await PushService.KeysAsync(sp.GetRequiredService<IAppDbContext>(), sp.GetRequiredService<ISecretProtector>(),
                PushService.SubjectOf(sp.GetRequiredService<IOptions<PushOptions>>().Value, sp.GetRequiredService<IOptions<AppOptions>>().Value), ct);
            var sender = sp.GetRequiredService<IWebPushSender>();
            var place = a.Location is null ? "" : $" near {a.Location}";
            var payload = JsonSerializer.Serialize(new
            {
                title = "Allow this sign-in?", body = $"{a.Device}{place} is signing in to your account. Code {a.Code}. Open to allow or reject.",
                link = $"/settings/security/account?approval={a.Id}", tag = $"approval-{a.Id:N}", type = "SignInRequest", urgent = true,
            }, Json);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct); timeout.CancelAfter(TimeSpan.FromSeconds(8));
            foreach (var d in devices)
            {
                int? status;
                try { status = await sender.SendAsync(d, payload, keys, timeout.Token); }
                catch (Exception ex) when (ex is not OperationCanceledException) { log.LogDebug(ex, "An approval prompt could not be pushed to a device"); status = null; }
                if (status is >= 200 and < 300) { d.LastSuccessAt = clock.Now; d.Failures = 0; }
                else if (status is 404 or 410) db.PushSubscriptions.Remove(d);
                else d.Failures++;
            }
            await db.SaveChangesAsync(ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException) { log.LogWarning(ex, "Sending approval prompts failed"); }
    }

    /// <summary>Ends every other session of the person (not saved yet): they signed in on <paramref name="device"/>. Returns the ended sessions.</summary>
    public async Task<List<Guid>> EndOtherSessionsAsync(Guid userId, Guid keepSessionId, string device, CancellationToken ct = default)
    {
        var now = clock.Now;
        var reason = Text.Truncate($"Signed out because you signed in on {device}.", 200);
        var others = await db.UserSessions.Where(s => s.UserId == userId && s.RevokedAt == null && s.Id != keepSessionId).ToListAsync(ct);
        foreach (var s in others) { s.RevokedAt = now; s.EndedReason = reason; }
        if (others.Count > 0) recorder.Audit("session.replaced", "User", userId, newValue: new { Device = device, Ended = others.Count }, userId: userId);
        return others.Select(s => s.Id).ToList();
    }

    public async Task AnnounceSignedOutAsync(Guid userId, IReadOnlyCollection<Guid> sessionIds, string device, CancellationToken ct = default)
    {
        if (notifier is null || sessionIds.Count == 0) return;
        try { await notifier.SignedOutAsync(userId, sessionIds, $"Signed out because you signed in on {device}.", ct); }
        catch (Exception ex) when (ex is not OperationCanceledException) { log.LogDebug(ex, "Signed-out devices could not be told live"); }
    }

    public async Task AnnounceClosedAsync(Guid userId, Guid approvalId, string outcome, CancellationToken ct = default)
    {
        if (notifier is null) return;
        try { await notifier.ClosedAsync(userId, approvalId, outcome, ct); }
        catch (Exception ex) when (ex is not OperationCanceledException) { log.LogDebug(ex, "The approval outcome could not be sent live"); }
    }
}

/// <summary>
/// The rest of "Single active session": the new device watches its request and redeems an approval once; a signed-in device allows, rejects or
/// reports it ("This wasn't me" ends every session and requires a new password); after the two-minute timeout the person may approve it with an
/// emailed link or an authenticator code; and the settings (personal and workspace) and the history. Every step is audited.
/// </summary>
public class SessionApprovalService(IAppDbContext db, ICurrentContext ctx, AppClock clock, ITokenService tokens, AuthService auth, SessionApprovalGate gate,
    Recorder recorder, MfaService mfa, IEmailSender email, IOptions<AppOptions> options, IConfiguration config, SecurityAlerts alerts, ILogger<SessionApprovalService> log)
{
    private const int MaxFallbackFailures = 5;
    private static readonly TimeSpan RedeemWindow = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan EmailLifetime = TimeSpan.FromMinutes(15);

    private byte[] Key => ApprovalTokens.KeyFrom(config);

    private bool SecretMatches(SessionApproval r, string? secret) =>
        !string.IsNullOrEmpty(secret) && CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(tokens.Hash(secret)), Encoding.UTF8.GetBytes(r.SecretHash));

    /// <summary>The request is held by the browser that presents this secret (the new device), for the self-approval check.</summary>
    public async Task<bool> IsRequesterAsync(Guid id, string? secret, CancellationToken ct = default)
    {
        if (string.IsNullOrEmpty(secret)) return false;
        var r = await db.SessionApprovals.AsNoTracking().FirstOrDefaultAsync(a => a.Id == id, ct);
        return r is not null && SecretMatches(r, secret);
    }

    private static SessionApprovalStatusDto Dto(SessionApproval r, string status, bool canCode, string? message = null) =>
        new(status, r.Code, r.Device, r.ExpiresAt, status == "timed_out", status == "timed_out" && canCode, r.EmailSentAt is not null, message);

    private static readonly SessionApprovalStatusDto Closed = new("closed", 0, "", DateTime.MinValue, false, false, false, "This sign-in request has ended. Sign in again.");

    // ------------------------------------------------------------------ the new device

    public async Task<SessionApprovalPollResult> StatusAsync(Guid id, string? secret, CancellationToken ct = default)
    {
        var now = clock.Now;
        var r = await db.SessionApprovals.FirstOrDefaultAsync(a => a.Id == id, ct);
        if (r is null || !SecretMatches(r, secret)) return new(Closed, null);
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == r.UserId && u.IsActive, ct);
        if (user is null) return new(Closed, null);
        switch (r.Status)
        {
            case SessionApprovalStatus.Pending when r.ExpiresAt > now:
                return new(Dto(r, "pending", user.MfaEnabled), null);
            case SessionApprovalStatus.Pending:
                if (r.DecidedVia is null)
                {
                    // Seen to time out for the first time: nobody answered within two minutes, which counts as denied.
                    r.DecidedVia = "timeout"; r.DecidedAt = now;
                    recorder.Audit("session.approval_timed_out", "User", r.UserId, newValue: new { r.Device, r.IpAddress }, userId: r.UserId);
                    await db.SaveChangesAsync(ct);
                    await gate.AnnounceClosedAsync(r.UserId, r.Id, "timed_out", ct);
                }
                return now < r.CreatedAt.Add(SessionApprovalGate.FallbackWindow)
                    ? new(Dto(r, "timed_out", user.MfaEnabled, "No signed-in device answered in time."), null)
                    : new(Closed, null);
            case SessionApprovalStatus.Rejected or SessionApprovalStatus.Reported:
                return new(Dto(r, "rejected", false, "This sign-in was rejected on your other device."), null);
            case SessionApprovalStatus.Approved:
                if (r.DecidedAt is { } decided && now > decided.Add(RedeemWindow)) return new(Closed, null);
                var claimed = await db.SessionApprovals.Where(a => a.Id == id && a.Status == SessionApprovalStatus.Approved)
                    .ExecuteUpdateAsync(s => s.SetProperty(a => a.Status, SessionApprovalStatus.Redeemed), ct);
                if (claimed == 0) return new(Closed, null);   // another poll got there first
                r.Status = SessionApprovalStatus.Redeemed;
                var session = await auth.SignInApprovedAsync(user, r, ct);
                if (r.DecidedVia is "email" or "code") await NoteFallbackAsync(user, r, ct);
                return new(Dto(r, "approved", false), session);
            default:
                return new(Closed, null);
        }
    }

    /// <summary>Timed out: send a one-time link to the account's verified email address that lets the person approve the sign-in themselves.</summary>
    public async Task<SessionApprovalStatusDto> SendEmailAsync(Guid id, string? secret, CancellationToken ct = default)
    {
        var (r, user) = await FallbackTargetAsync(id, secret, ct);
        var now = clock.Now;
        if (!user.EmailVerified) throw new ConflictException("Your email address is not verified, so a link cannot be sent. Use a code instead.", "EMAIL_NOT_VERIFIED");
        if (r.EmailSentAt is { } sent && sent > now.AddSeconds(-60)) throw new TooManyRequestsException("A link was just sent. Check your inbox, or try again in a minute.", "APPROVAL_EMAIL_RATE_LIMITED");
        var (nonce, nonceHash) = tokens.CreateOpaqueToken();
        r.EmailTokenHash = nonceHash; r.EmailSentAt = now;
        recorder.Audit("session.approval_email_sent", "User", r.UserId, newValue: new { r.Device }, userId: r.UserId);
        await db.SaveChangesAsync(ct);
        var link = $"{options.Value.WebBaseUrl.TrimEnd('/')}/approve-sign-in?token={Uri.EscapeDataString(ApprovalTokens.Email(Key, r.Id, nonce))}";
        var where = r.Location is null ? "" : $" near {WebUtility.HtmlEncode(r.Location)}";
        await email.TrySendAsync(new EmailMessage(user.Email, "Approve your sign-in",
            EmailTemplates.Wrap("Approve your sign-in", $"Hi {WebUtility.HtmlEncode(user.DisplayName)},",
                $"{WebUtility.HtmlEncode(r.Device)}{where} is waiting to sign in to your account (code {r.Code}). Open this link to allow it. It works once and expires in 15 minutes. If this was not you, ignore this email and change your password.",
                "Review sign-in", link, preheader: "Allow the sign-in that is waiting on your new device.", kind: EmailKind.Security),
            $"Approve your sign-in: {link}", "security"), log, ct);
        return Dto(r, "timed_out", user.MfaEnabled);
    }

    /// <summary>Timed out: an authenticator or recovery code approves it instead (five wrong codes end the request).</summary>
    public async Task<SessionApprovalStatusDto> ApproveWithCodeAsync(Guid id, SessionApprovalCodeRequest req, CancellationToken ct = default)
    {
        var (r, user) = await FallbackTargetAsync(id, req.Secret, ct);
        if (!user.MfaEnabled) throw new ConflictException("Two-step verification is not on for this account. Use the emailed link.", "MFA_NOT_ENABLED");
        if (user.LockoutEnd is { } l && l > clock.Now) throw new TooManyRequestsException("Too many failed attempts. Try again later.", "ACCOUNT_LOCKED");
        if (!await mfa.VerifyCodeAsync(user, req.Code ?? "", ct))
        {
            r.FallbackFailures++;
            if (r.FallbackFailures >= MaxFallbackFailures) { r.Status = SessionApprovalStatus.Rejected; r.DecidedAt = clock.Now; r.DecidedVia = "code"; }
            recorder.Audit("session.approval_code_failed", "User", r.UserId, newValue: new { r.FallbackFailures }, userId: r.UserId);
            await mfa.RegisterFailureAsync(user, "code", ct);
            throw new ValidationException("code", "That code is not correct.");
        }
        r.Status = SessionApprovalStatus.Approved; r.DecidedAt = clock.Now; r.DecidedVia = "code";
        recorder.Audit("session.approval_allowed", "User", r.UserId, newValue: new { r.Device, Via = "code" }, userId: r.UserId);
        await db.SaveChangesAsync(ct);
        return Dto(r, "pending", false);
    }

    private async Task<(SessionApproval, User)> FallbackTargetAsync(Guid id, string? secret, CancellationToken ct)
    {
        var now = clock.Now;
        var r = await db.SessionApprovals.FirstOrDefaultAsync(a => a.Id == id, ct);
        if (r is null || !SecretMatches(r, secret)) throw new NotFoundException("This sign-in request has ended. Sign in again.");
        if (r.Status != SessionApprovalStatus.Pending || r.ExpiresAt > now || now >= r.CreatedAt.Add(SessionApprovalGate.FallbackWindow) || r.FallbackFailures >= MaxFallbackFailures)
            throw new ConflictException(r.Status == SessionApprovalStatus.Pending && r.ExpiresAt > now
                ? "Your other device can still answer. Wait for it, or try again when the request times out."
                : "This sign-in request has ended. Sign in again.", "APPROVAL_CLOSED");
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == r.UserId && u.IsActive, ct) ?? throw new NotFoundException("This sign-in request has ended. Sign in again.");
        return (r, user);
    }

    /// <summary>What the emailed link is for, shown before the person confirms (opening the link changes nothing: mail scanners open links too).</summary>
    public async Task<SessionApprovalEmailPreviewDto> PreviewEmailAsync(SessionApprovalEmailRequest req, CancellationToken ct = default)
    {
        var r = await EmailTargetAsync(req.Token, ct);
        return new(r.Device, r.App, r.Location, r.IpAddress, r.CreatedAt);
    }

    public async Task<SessionApprovalEmailPreviewDto> ConfirmEmailAsync(SessionApprovalEmailRequest req, CancellationToken ct = default)
    {
        var r = await EmailTargetAsync(req.Token, ct);
        var now = clock.Now;
        var used = await db.SessionApprovals.Where(a => a.Id == r.Id && a.Status == SessionApprovalStatus.Pending && a.EmailTokenHash == r.EmailTokenHash)
            .ExecuteUpdateAsync(s => s.SetProperty(a => a.Status, SessionApprovalStatus.Approved).SetProperty(a => a.EmailTokenHash, (string?)null)
                .SetProperty(a => a.DecidedAt, (DateTime?)now).SetProperty(a => a.DecidedVia, "email"), ct);
        if (used == 0) throw new ValidationException("token", "This link has already been used or has expired.");
        recorder.Audit("session.approval_allowed", "User", r.UserId, newValue: new { r.Device, Via = "email" }, userId: r.UserId);
        await db.SaveChangesAsync(ct);
        return new(r.Device, r.App, r.Location, r.IpAddress, r.CreatedAt);
    }

    private async Task<SessionApproval> EmailTargetAsync(string? token, CancellationToken ct)
    {
        var read = ApprovalTokens.ReadEmail(Key, token) ?? throw new ValidationException("token", "This link is not valid.");
        var r = await db.SessionApprovals.AsNoTracking().FirstOrDefaultAsync(a => a.Id == read.Id, ct);
        var now = clock.Now;
        if (r is null || r.EmailTokenHash is null || r.Status != SessionApprovalStatus.Pending || r.EmailSentAt is not { } sent || now > sent.Add(EmailLifetime)
            || now >= r.CreatedAt.Add(SessionApprovalGate.FallbackWindow)
            || !CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(tokens.Hash(read.Nonce)), Encoding.UTF8.GetBytes(r.EmailTokenHash)))
            throw new ValidationException("token", "This link has already been used or has expired.");
        return r;
    }

    // ------------------------------------------------------------------ a signed-in device

    /// <summary>Requests a signed-in device of mine may answer: still pending, and asked after this session started (a device never answers for itself).</summary>
    public async Task<IReadOnlyList<SessionApprovalPendingDto>> PendingAsync(CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId(); var now = clock.Now;
        if (ctx.SessionId is not { } sid) return [];
        var started = await db.UserSessions.AsNoTracking().Where(s => s.Id == sid && s.UserId == uid).Select(s => (DateTime?)s.CreatedAt).FirstOrDefaultAsync(ct);
        if (started is null) return [];
        var rows = await db.SessionApprovals.AsNoTracking()
            .Where(a => a.UserId == uid && a.Status == SessionApprovalStatus.Pending && a.ExpiresAt > now && a.CreatedAt > started)
            .OrderByDescending(a => a.CreatedAt).Take(3).ToListAsync(ct);
        return rows.Select(gate.PendingOf).ToList();
    }

    /// <summary>
    /// Allow, reject or "not-me" from a signed-in device, with the signed token the prompt carried. Refused for a session that did not exist before
    /// the request (the new device itself) and for the browser that holds the request's own secret.
    /// </summary>
    public async Task<string> DecideAsync(Guid id, SessionApprovalDecideRequest req, bool requesterHere, CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId(); var now = clock.Now;
        if (ctx.ViaApiKey || ctx.SessionId is not { } sid) throw new ForbiddenException("Only a signed-in device can answer a sign-in request.", "SELF_APPROVAL");
        var decision = (req.Decision ?? "").Trim().ToLowerInvariant();
        if (decision is not ("allow" or "reject" or "not-me")) throw new ValidationException("decision", "Choose allow, reject or not-me.");
        if (!ApprovalTokens.CheckDecision(Key, req.Token, id, uid, now)) throw new ValidationException("token", "This request is no longer valid.");
        var r = await db.SessionApprovals.FirstOrDefaultAsync(a => a.Id == id && a.UserId == uid, ct) ?? throw new NotFoundException("This sign-in request is no longer there.");
        var approver = await db.UserSessions.AsNoTracking().FirstOrDefaultAsync(s => s.Id == sid && s.UserId == uid && s.RevokedAt == null, ct);
        if (requesterHere || approver is null || approver.CreatedAt >= r.CreatedAt || approver.Id == r.ResultSessionId)
        {
            recorder.Audit("session.approval_self_blocked", "User", uid, newValue: new { r.Device }, userId: uid);
            await db.SaveChangesAsync(ct);
            throw new ForbiddenException("A new device cannot approve its own sign-in. Answer on a device that was already signed in.", "SELF_APPROVAL");
        }
        var status = decision == "allow" ? SessionApprovalStatus.Approved : decision == "reject" ? SessionApprovalStatus.Rejected : SessionApprovalStatus.Reported;
        var changed = await db.SessionApprovals.Where(a => a.Id == id && a.Status == SessionApprovalStatus.Pending && a.ExpiresAt > now)
            .ExecuteUpdateAsync(s => s.SetProperty(a => a.Status, status).SetProperty(a => a.DecidedAt, (DateTime?)now)
                .SetProperty(a => a.DecidedBySessionId, (Guid?)sid).SetProperty(a => a.DecidedVia, "session"), ct);
        if (changed == 0) throw new ConflictException("This sign-in request has already been answered or has timed out.", "APPROVAL_CLOSED");
        var outcome = decision == "allow" ? "allowed" : decision == "reject" ? "rejected" : "reported";
        recorder.Audit($"session.approval_{outcome}", "User", uid, newValue: new { r.Device, r.App, r.IpAddress, r.Location, Via = "session" }, userId: uid, tenantId: ctx.TenantId);
        await db.SaveChangesAsync(ct);
        await gate.AnnounceClosedAsync(uid, id, outcome, ct);
        if (decision == "not-me") await SecureAccountAsync(uid, r, ct);
        return outcome;
    }

    /// <summary>"This wasn't me": every session ends (this one too), the password stops working and a reset link is sent to the verified address.</summary>
    private async Task SecureAccountAsync(Guid userId, SessionApproval r, CancellationToken ct)
    {
        var now = clock.Now;
        var user = await db.Users.FirstAsync(u => u.Id == userId, ct);
        var sessions = await db.UserSessions.Where(s => s.UserId == userId && s.RevokedAt == null).ToListAsync(ct);
        foreach (var s in sessions) { s.RevokedAt = now; s.EndedReason = "Signed out to secure your account. Choose a new password to sign in again."; }
        await db.RefreshTokens.Where(t => t.UserId == userId && t.UsedAt == null).ExecuteUpdateAsync(u => u.SetProperty(t => t.UsedAt, (DateTime?)now), ct);
        user.PasswordHash = PasswordHashes.None;   // the password someone else knows stops working at once
        var (raw, hash) = tokens.CreateOpaqueToken();
        user.PasswordResetTokenHash = hash;
        user.PasswordResetExpiresAt = now.AddHours(options.Value.ResetTokenHours);
        recorder.Audit("user.account_secured", "User", userId, newValue: new { Reason = "session_approval_reported", r.Device, r.IpAddress, Ended = sessions.Count }, userId: userId);
        await db.SaveChangesAsync(ct);
        await gate.AnnounceSignedOutAsync(userId, sessions.Select(s => s.Id).ToList(), r.Device, ct);
        var link = $"{options.Value.WebBaseUrl.TrimEnd('/')}/reset-password?token={Uri.EscapeDataString(raw)}";
        await email.TrySendAsync(new EmailMessage(user.Email, "Secure your account: choose a new password",
            EmailTemplates.Wrap("Choose a new password", $"Hi {WebUtility.HtmlEncode(user.DisplayName)},",
                $"You said a sign-in from {WebUtility.HtmlEncode(r.Device)} was not you. Every device was signed out and your old password no longer works. Choose a new one to sign in again{(user.MfaEnabled ? "" : ", and turn on two-step verification")}.",
                "Choose a new password", link, preheader: "Your account was secured. Choose a new password.", kind: EmailKind.Security), $"Choose a new password: {link}", "reset"), log, ct);
    }

    public async Task<IReadOnlyList<SessionApprovalHistoryDto>> HistoryAsync(CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId(); var now = clock.Now; var since = now.AddDays(-90);
        var rows = await db.SessionApprovals.AsNoTracking().Where(a => a.UserId == uid && a.CreatedAt > since).OrderByDescending(a => a.CreatedAt).Take(50).ToListAsync(ct);
        return rows.Select(a => new SessionApprovalHistoryDto(a.Id, a.CreatedAt, a.Device, a.App, a.Location, a.IpAddress, Outcome(a, now),
            a.DecidedVia == "timeout" ? null : a.DecidedVia, a.DecidedAt)).ToList();
    }

    private static string Outcome(SessionApproval a, DateTime now) => a.Status switch
    {
        SessionApprovalStatus.Pending => a.ExpiresAt > now ? "pending" : "timed_out",
        SessionApprovalStatus.Approved or SessionApprovalStatus.Redeemed => "allowed",
        SessionApprovalStatus.Rejected => "rejected",
        _ => "reported",
    };

    // ------------------------------------------------------------------ settings

    public async Task<SessionPolicyDto> PolicyAsync(CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var mine = await db.Users.AsNoTracking().Where(u => u.Id == uid).Select(u => u.SingleSession).FirstAsync(ct);
        var by = await gate.RequiredByAsync(uid, ct);
        return new SessionPolicyDto(mine, mine || by.Count > 0, by);
    }

    public async Task<SessionPolicyDto> SetPolicyAsync(SetSessionPolicyRequest req, CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        if (ctx.ViaApiKey) throw new ForbiddenException("API keys cannot change sign-in settings.", "API_KEY_NOT_ALLOWED");
        var user = await db.Users.FirstAsync(u => u.Id == uid, ct);
        if (user.SingleSession != req.SingleSession)
        {
            user.SingleSession = req.SingleSession;
            recorder.Audit(req.SingleSession ? "user.single_session_on" : "user.single_session_off", "User", uid, userId: uid, tenantId: ctx.TenantId);
            await db.SaveChangesAsync(ct);
        }
        return await PolicyAsync(ct);
    }

    public async Task<WorkspaceSessionPolicyDto> WorkspacePolicyAsync(CancellationToken ct = default)
    {
        var tenantId = ctx.RequireTenantId();
        var on = await db.TenantSecuritySettings.AsNoTracking().Where(s => s.TenantId == tenantId).Select(s => s.SingleActiveSession).FirstOrDefaultAsync(ct);
        return new WorkspaceSessionPolicyDto(on, CanManage);
    }

    private bool CanManage => !ctx.ViaApiKey && ctx.WorkspaceType == ProjectManagement.Domain.Enums.WorkspaceType.Organization
        && ctx.Role is ProjectManagement.Domain.Enums.TenantRole.Owner or ProjectManagement.Domain.Enums.TenantRole.Admin;

    public async Task<WorkspaceSessionPolicyDto> SetWorkspacePolicyAsync(SetWorkspaceSessionPolicyRequest req, CancellationToken ct = default)
    {
        var tenantId = ctx.RequireTenantId();
        if (!CanManage) throw new ForbiddenException("Only owners and admins of an organization can change its sign-in rules.", "PERMISSION_DENIED");
        var row = await db.TenantSecuritySettings.FirstOrDefaultAsync(s => s.TenantId == tenantId, ct);
        if (row is null) { row = new TenantSecuritySettings { TenantId = tenantId }; db.TenantSecuritySettings.Add(row); }
        if (row.SingleActiveSession != req.SingleActiveSession)
        {
            recorder.Audit("org.single_session_changed", "Tenant", tenantId, oldValue: new { row.SingleActiveSession }, newValue: new { req.SingleActiveSession }, tenantId: tenantId);
            row.SingleActiveSession = req.SingleActiveSession;
        }
        await db.SaveChangesAsync(ct);
        return new WorkspaceSessionPolicyDto(row.SingleActiveSession, true);
    }

    /// <summary>Tells the account owner, by email, that a fallback approval was used (they may not have been at their other device).</summary>
    private Task NoteFallbackAsync(User user, SessionApproval r, CancellationToken ct = default) =>
        alerts.SendAsync(user, "A sign-in was approved without your other device",
            $"{r.Device}{(r.Location is null ? "" : " near " + r.Location)} signed in after you approved it with {(r.DecidedVia == "email" ? "an emailed link" : "a code")}. If this was not you, sign out everywhere and change your password.", ct);
}
