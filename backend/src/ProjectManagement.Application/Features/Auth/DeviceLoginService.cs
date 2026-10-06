using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Auth;

public record DeviceLoginStartRequest(string? Email);
/// <summary>What the computer is given: the request to watch, the secret only it may redeem it with, and the number to show on screen.</summary>
public record DeviceLoginStartDto(Guid RequestId, string Secret, int Number, DateTime ExpiresAt);
public record DeviceLoginPollRequest(string? Secret);
public record DeviceLoginApproveRequest(int Number);
/// <summary>What the phone shows: who is asking (the browser, the address, when) and three numbers to choose from.</summary>
public record DeviceLoginPendingDto(Guid Id, int[] Choices, string Device, string? Ip, DateTime CreatedAt, DateTime ExpiresAt);
public record DeviceLoginPollResult(string Status, AuthResult? Session);
public record SignInDeviceDto(bool Enabled, int Devices, int SignInDevices, bool PlanAllows);

/// <summary>
/// Signing in on a computer by approving on a phone, like a bank's or an authenticator's prompt, but with the safeguards that make it hard to abuse:
/// the computer shows a number and the phone must pick the same one out of three (so a prompt nobody expected is not approved by reflex), a request
/// lasts two minutes and can be redeemed once, only the browser that asked holds the secret to redeem it, at most three prompts per person per ten
/// minutes are ever sent, and an address that has no phone set up gets exactly the same answer as one that does (nothing is revealed about who has an
/// account). A phone must have been chosen, while signed in, for this; that choice is a feature of the plan.
/// </summary>
public class DeviceLoginService(IAppDbContext db, ICurrentContext ctx, AppClock clock, ITokenService tokens, AuthService auth, Recorder recorder,
    EntitlementService entitlements, ProjectManagement.Application.Features.Sso.SsoPolicy ssoPolicy, IServiceScopeFactory scopes,
    IOptions<AppOptions> app, ILogger<DeviceLoginService> log, ProjectManagement.Application.Features.Notifications.SecurityAlerts alerts)
{
    public static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(2);
    private const int MaxPromptsPer10Minutes = 3, MaxWrongNumbers = 2;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    // ------------------------------------------------------------------ the computer asks

    public async Task<DeviceLoginStartDto> StartAsync(DeviceLoginStartRequest req, CancellationToken ct = default)
    {
        var now = clock.Now;
        var email = Text.NormalizeEmail(req.Email ?? "");
        var (raw, hash) = tokens.CreateOpaqueToken();
        var request = new DeviceLoginRequest
        {
            SecretHash = hash, Number = RandomNumberGenerator.GetInt32(10, 100), CreatedAt = now, ExpiresAt = now.Add(Lifetime),
            RequesterIp = Text.Truncate(ctx.IpAddress, 64), RequesterAgent = Text.Truncate(ctx.UserAgent, 300), Status = DeviceLoginStatus.Ignored,
        };

        var user = email.Length == 0 ? null : await db.Users.FirstOrDefaultAsync(u => u.NormalizedEmail == email, ct);
        List<PushSubscription> devices = [];
        if (user is not null && await EligibleAsync(user, now, ct))
        {
            request.UserId = user.Id;
            var recent = await db.DeviceLoginRequests.CountAsync(r => r.UserId == user.Id && r.Status != DeviceLoginStatus.Ignored && r.CreatedAt > now.AddMinutes(-10), ct);
            if (recent < MaxPromptsPer10Minutes)
            {
                request.Status = DeviceLoginStatus.Pending;
                devices = await db.PushSubscriptions.Where(s => s.UserId == user.Id && s.AllowsSignIn && s.Failures < 20).ToListAsync(ct);
            }
        }
        db.DeviceLoginRequests.Add(request);
        // Old requests are of no use to anyone: forgotten as new ones arrive.
        await db.DeviceLoginRequests.Where(r => r.CreatedAt < now.AddHours(-1)).ExecuteDeleteAsync(ct);
        await db.SaveChangesAsync(ct);

        if (request.Status == DeviceLoginStatus.Pending)
        {
            recorder.Audit("user.device_login_requested", "User", user!.Id, newValue: new { request.RequesterIp, Device = Describe(request.RequesterAgent) }, userId: user.Id);
            await db.SaveChangesAsync(ct);
            await PushAsync(devices, request, ct);
        }
        return new DeviceLoginStartDto(request.Id, raw, request.Number, request.ExpiresAt);
    }

    private async Task<bool> EligibleAsync(User user, DateTime now, CancellationToken ct)
    {
        if (!user.IsActive || (user.LockoutEnd is { } l && l > now)) return false;
        if (!user.EmailVerified && app.Value.RequireEmailVerification) return false;
        if (await ssoPolicy.EnforcedForAsync(user.Email, user.Id, ct) is not null) return false;   // an organization that requires its own sign-on
        if (!await db.PushSubscriptions.AnyAsync(s => s.UserId == user.Id && s.AllowsSignIn, ct)) return false;
        // The plan feature is checked at the moment of use too: a person whose organizations have all dropped below it stops being prompted.
        var tenantIds = await (from m in db.TenantMembers.IgnoreQueryFilters() join t in db.Tenants.IgnoreQueryFilters() on m.TenantId equals t.Id
                               where m.UserId == user.Id && t.Status == ProjectManagement.Domain.Enums.TenantStatus.Active select t.Id).ToListAsync(ct);
        foreach (var id in tenantIds)
            if ((await entitlements.GetEntitlementsAsync(id, ct)).GetValueOrDefault(FeatureKeys.MobileApp) > 0) return true;
        return false;
    }

    /// <summary>Sent at once, not left for the notification worker: someone is waiting at the other screen.</summary>
    private async Task PushAsync(List<PushSubscription> devices, DeviceLoginRequest request, CancellationToken ct)
    {
        if (devices.Count == 0) return;
        try
        {
            using var scope = scopes.CreateScope();
            var sp = scope.ServiceProvider;
            var pushDb = sp.GetRequiredService<IAppDbContext>();
            var keys = await PushService.KeysAsync(pushDb, sp.GetRequiredService<ISecretProtector>(),
                PushService.SubjectOf(sp.GetRequiredService<IOptions<PushOptions>>().Value, sp.GetRequiredService<IOptions<AppOptions>>().Value), ct);
            var sender = sp.GetRequiredService<IWebPushSender>();
            var payload = JsonSerializer.Serialize(new
            {
                title = "Approve this sign-in?", body = $"Someone is signing in from {Describe(request.RequesterAgent)}. Open to check the number and approve.",
                link = $"/approve/{request.Id}", tag = $"signin-{request.Id:N}", type = "SignInRequest", urgent = true, number = (int?)null,
            }, Json);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct); timeout.CancelAfter(TimeSpan.FromSeconds(8));
            foreach (var d in devices)
            {
                int? status;
                try { status = await sender.SendAsync(d, payload, keys, timeout.Token); }
                catch (Exception ex) when (ex is not OperationCanceledException) { log.LogDebug(ex, "A sign-in prompt could not be pushed to a device"); status = null; }
                var stored = await db.PushSubscriptions.FirstOrDefaultAsync(s => s.Id == d.Id, ct);
                if (stored is null) continue;
                if (status is >= 200 and < 300) { stored.LastSuccessAt = clock.Now; stored.Failures = 0; }
                else if (status is 404 or 410) db.PushSubscriptions.Remove(stored);
                else stored.Failures++;
            }
            await db.SaveChangesAsync(ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException) { log.LogWarning(ex, "Sending sign-in prompts failed"); }
    }

    /// <summary>The computer asks whether the phone has answered; an approval is redeemed here, once, with the secret.</summary>
    public async Task<DeviceLoginPollResult> PollAsync(Guid id, DeviceLoginPollRequest req, CancellationToken ct = default)
    {
        var now = clock.Now;
        var r = await db.DeviceLoginRequests.FirstOrDefaultAsync(x => x.Id == id, ct);
        if (r is null || string.IsNullOrEmpty(req.Secret) || !CryptographicOperations.FixedTimeEquals(System.Text.Encoding.UTF8.GetBytes(tokens.Hash(req.Secret)), System.Text.Encoding.UTF8.GetBytes(r.SecretHash)))
            return new DeviceLoginPollResult("expired", null);
        if (r.ExpiresAt <= now && r.Status is DeviceLoginStatus.Pending or DeviceLoginStatus.Ignored) return new DeviceLoginPollResult("expired", null);
        switch (r.Status)
        {
            case DeviceLoginStatus.Pending or DeviceLoginStatus.Ignored: return new DeviceLoginPollResult("pending", null);
            case DeviceLoginStatus.Denied: return new DeviceLoginPollResult("denied", null);
            case DeviceLoginStatus.Approved:
                if (now > r.ExpiresAt.AddSeconds(30)) return new DeviceLoginPollResult("expired", null);   // approved in time, but the computer never came back for it
                var claimed = await db.DeviceLoginRequests.Where(x => x.Id == id && x.Status == DeviceLoginStatus.Approved).ExecuteUpdateAsync(s => s.SetProperty(x => x.Status, DeviceLoginStatus.Redeemed), ct);
                if (claimed == 0) return new DeviceLoginPollResult("expired", null);   // another poll got there first
                var user = await db.Users.FirstOrDefaultAsync(u => u.Id == r.UserId && u.IsActive, ct);
                if (user is null) return new DeviceLoginPollResult("expired", null);
                var session = await auth.SignInExternalAsync(user, "device", null, null, ct);
                // A sign-in the person approved on their phone is still worth a line in their inbox: if it was not them, they learn at once.
                await alerts.SendAsync(user, "A sign-in was approved on your phone", $"{Describe(r.RequesterAgent)}{(string.IsNullOrEmpty(r.RequesterIp) ? "" : " from " + r.RequesterIp)} signed in after you approved it on your phone. If this was not you, sign out of all devices under Account → Sign-in & security and change your password.", ct);
                return new DeviceLoginPollResult("approved", session);
            default: return new DeviceLoginPollResult("expired", null);
        }
    }

    // ------------------------------------------------------------------ the phone answers

    public async Task<IReadOnlyList<DeviceLoginPendingDto>> PendingAsync(CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId(); var now = clock.Now;
        var rows = await db.DeviceLoginRequests.AsNoTracking().Where(r => r.UserId == uid && r.Status == DeviceLoginStatus.Pending && r.ExpiresAt > now).OrderByDescending(r => r.CreatedAt).Take(5).ToListAsync(ct);
        return rows.Select(r => new DeviceLoginPendingDto(r.Id, Choices(r), Describe(r.RequesterAgent), r.RequesterIp, r.CreatedAt, r.ExpiresAt)).ToList();
    }

    /// <summary>The real number and two others, in an order that does not give the real one away.</summary>
    private static int[] Choices(DeviceLoginRequest r)
    {
        var rng = new Random(HashCode.Combine(r.Id.GetHashCode(), 7));
        var set = new List<int> { r.Number };
        while (set.Count < 3) { var n = rng.Next(10, 100); if (!set.Contains(n)) set.Add(n); }
        return set.OrderBy(_ => rng.Next()).ToArray();
    }

    public async Task<DeviceLoginPendingDto?> GetAsync(Guid id, CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var r = await db.DeviceLoginRequests.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id && x.UserId == uid, ct);
        return r is null || r.Status != DeviceLoginStatus.Pending || r.ExpiresAt <= clock.Now ? null : new DeviceLoginPendingDto(r.Id, Choices(r), Describe(r.RequesterAgent), r.RequesterIp, r.CreatedAt, r.ExpiresAt);
    }

    public async Task ApproveAsync(Guid id, DeviceLoginApproveRequest req, CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId(); var now = clock.Now;
        var r = await db.DeviceLoginRequests.FirstOrDefaultAsync(x => x.Id == id && x.UserId == uid, ct) ?? throw new NotFoundException("This sign-in request is no longer there.");
        if (r.Status != DeviceLoginStatus.Pending || r.ExpiresAt <= now) throw new ConflictException("This sign-in request has expired. Start again on the other screen.", "DEVICE_LOGIN_EXPIRED");
        if (req.Number != r.Number)
        {
            r.WrongAttempts++;
            if (r.WrongAttempts >= MaxWrongNumbers) { r.Status = DeviceLoginStatus.Denied; r.DecidedAt = now; recorder.Audit("user.device_login_wrong_number", "User", uid, userId: uid, tenantId: ctx.TenantId); }
            await db.SaveChangesAsync(ct);
            throw new ValidationException("number", r.Status == DeviceLoginStatus.Denied ? "That is not the number on the other screen. The sign-in was stopped." : "That is not the number on the other screen.");
        }
        r.Status = DeviceLoginStatus.Approved; r.DecidedAt = now;
        recorder.Audit("user.device_login_approved", "User", uid, newValue: new { r.RequesterIp, Device = Describe(r.RequesterAgent) }, userId: uid, tenantId: ctx.TenantId);
        await db.SaveChangesAsync(ct);
    }

    public async Task DenyAsync(Guid id, CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var r = await db.DeviceLoginRequests.FirstOrDefaultAsync(x => x.Id == id && x.UserId == uid, ct);
        if (r is null || r.Status != DeviceLoginStatus.Pending) return;
        r.Status = DeviceLoginStatus.Denied; r.DecidedAt = clock.Now;
        recorder.Audit("user.device_login_denied", "User", uid, newValue: new { r.RequesterIp, Device = Describe(r.RequesterAgent) }, userId: uid, tenantId: ctx.TenantId);
        await db.SaveChangesAsync(ct);
    }

    // ------------------------------------------------------------------ choosing the phone

    public async Task<SignInDeviceDto> StatusAsync(string? endpoint, CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var subs = await db.PushSubscriptions.AsNoTracking().Where(s => s.UserId == uid).Select(s => new { s.Endpoint, s.AllowsSignIn }).ToListAsync(ct);
        var plan = await entitlements.GetValueAsync(FeatureKeys.MobileApp, ct) > 0;
        return new SignInDeviceDto(endpoint is not null && subs.Any(s => s.Endpoint == endpoint && s.AllowsSignIn), subs.Count, subs.Count(s => s.AllowsSignIn), plan);
    }

    /// <summary>Makes this device (the one that holds this push subscription) the one that approves sign-ins, or stops it. Needs the plan feature.</summary>
    public async Task<SignInDeviceDto> SetDeviceAsync(string? endpoint, bool enabled, CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        if (enabled) await entitlements.EnsureFeatureAsync(FeatureKeys.MobileApp, ct);
        var sub = await db.PushSubscriptions.FirstOrDefaultAsync(s => s.UserId == uid && s.Endpoint == endpoint, ct)
            ?? throw new ValidationException("endpoint", "Turn on notifications on this device first.");
        sub.AllowsSignIn = enabled;
        recorder.Audit(enabled ? "user.device_login_enabled" : "user.device_login_disabled", "User", uid, userId: uid, tenantId: ctx.TenantId);
        await db.SaveChangesAsync(ct);
        return await StatusAsync(endpoint, ct);
    }

    /// <summary>"Chrome on Windows": enough for a person to recognise the screen that is asking, without the raw browser string.</summary>
    public static string Describe(string? ua)
    {
        if (string.IsNullOrWhiteSpace(ua)) return "an unknown browser";
        var browser = ua.Contains("Edg/") ? "Edge" : ua.Contains("OPR/") ? "Opera" : ua.Contains("Firefox/") ? "Firefox" : ua.Contains("Chrome/") ? "Chrome" : ua.Contains("Safari/") ? "Safari" : "a browser";
        var os = ua.Contains("Windows") ? "Windows" : ua.Contains("Android") ? "Android" : ua.Contains("iPhone") || ua.Contains("iPad") ? "iOS" : ua.Contains("Mac OS") ? "macOS" : ua.Contains("Linux") ? "Linux" : null;
        return os is null ? browser : $"{browser} on {os}";
    }
}
