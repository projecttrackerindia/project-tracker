using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Sso;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Notifications;

public class PushOptions
{
    public const string Section = "Push";
    public bool WorkerEnabled { get; set; } = true;
    public int IntervalSeconds { get; set; } = 10;
    /// <summary>Contact for push services ("mailto:..." or an https URL). Empty = the web address of this installation.</summary>
    public string? Subject { get; set; }
}

/// <summary>The VAPID key pair (base64url: the 65-byte public point, the 32-byte private scalar) and the contact sent with every push.</summary>
public record VapidKeys(string PublicKey, string PrivateKey, string Subject);

/// <summary>Sends one encrypted Web Push message. Returns the push service's status (201 = accepted, 404/410 = the subscription is gone).</summary>
public interface IWebPushSender
{
    Task<int?> SendAsync(PushSubscription subscription, string payload, VapidKeys keys, CancellationToken ct);
}

public record PushKeysRequest(string? P256dh, string? Auth);
public record PushSubscribeRequest(string? Endpoint, PushKeysRequest? Keys);
public record PushStatusDto(string PublicKey, int Devices);

public static class Base64Url
{
    public static string Encode(ReadOnlySpan<byte> b) => Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    public static byte[] Decode(string s)
    {
        var t = s.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(t.PadRight(t.Length + (4 - t.Length % 4) % 4, '='));
    }
}

/// <summary>
/// Push notifications to devices (an installed app, or a browser tab that allowed it), so people hear about things while the app is closed.
/// The server's VAPID key pair is made on first use and kept in the platform settings (the private half encrypted). A person's devices are
/// theirs across workspaces; each notification that uses the "desktop" channel is pushed to them by <see cref="PushDispatcher"/>.
/// </summary>
public class PushService(IAppDbContext db, ICurrentContext ctx, AppClock clock, ISecretProtector protector, IOptions<AppOptions> app, IOptions<PushOptions> options)
{
    public const string KeyPublic = "vapid_public", KeyPrivate = "vapid_private";

    /// <summary>The VAPID keys, created (once, for every server) when first needed.</summary>
    public static async Task<VapidKeys> KeysAsync(IAppDbContext db, ISecretProtector protector, string subject, CancellationToken ct)
    {
        var rows = await db.PlatformSettings.Where(s => s.Key == KeyPublic || s.Key == KeyPrivate).ToListAsync(ct);
        var pub = rows.FirstOrDefault(r => r.Key == KeyPublic)?.Value;
        var priv = rows.FirstOrDefault(r => r.Key == KeyPrivate)?.Value;
        if (pub is null || priv is null)
        {
            using var ec = ECDsa.Create(ECCurve.NamedCurves.nistP256);
            var p = ec.ExportParameters(true);
            pub = Base64Url.Encode([0x04, .. p.Q.X!, .. p.Q.Y!]);
            var d = Base64Url.Encode(p.D!);
            db.PlatformSettings.RemoveRange(rows);
            db.PlatformSettings.Add(new PlatformSetting { Key = KeyPublic, Value = pub, CreatedAt = DateTime.UtcNow });
            db.PlatformSettings.Add(new PlatformSetting { Key = KeyPrivate, Value = protector.Protect(d), CreatedAt = DateTime.UtcNow });
            try { await db.SaveChangesAsync(ct); }
            catch (DbUpdateException)
            {
                // Another server made them at the same moment: use theirs.
                foreach (var e in db.PlatformSettings.Local.Where(s => s.Key is KeyPublic or KeyPrivate).ToList()) db.PlatformSettings.Entry(e).State = EntityState.Detached;
                return await KeysAsync(db, protector, subject, ct);
            }
            return new VapidKeys(pub, d, subject);
        }
        return new VapidKeys(pub, protector.Unprotect(priv), subject);
    }

    public static string SubjectOf(PushOptions o, AppOptions app) =>
        !string.IsNullOrWhiteSpace(o.Subject) ? o.Subject.Trim() : PublicUrls.Web(app) is { Length: > 0 } web && web.StartsWith("https://", StringComparison.Ordinal) ? web : "mailto:support@projecttracker.in";

    public async Task<PushStatusDto> StatusAsync(CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var keys = await KeysAsync(db, protector, SubjectOf(options.Value, app.Value), ct);
        return new PushStatusDto(keys.PublicKey, await db.PushSubscriptions.CountAsync(s => s.UserId == uid, ct));
    }

    public async Task<PushStatusDto> SubscribeAsync(PushSubscribeRequest req, string? userAgent, CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var endpoint = req.Endpoint?.Trim();
        if (endpoint is null || endpoint.Length > 800 || !Uri.TryCreate(endpoint, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps)
            throw new ValidationException("endpoint", "That is not a push subscription.");
        byte[] key, auth;
        try { key = Base64Url.Decode(req.Keys?.P256dh ?? ""); auth = Base64Url.Decode(req.Keys?.Auth ?? ""); }
        catch (FormatException) { throw new ValidationException("keys", "The subscription's keys could not be read."); }
        if (key.Length != 65 || key[0] != 4 || auth.Length != 16) throw new ValidationException("keys", "The subscription's keys could not be read.");

        var sub = await db.PushSubscriptions.FirstOrDefaultAsync(s => s.Endpoint == endpoint, ct);
        if (sub is null) { sub = new PushSubscription { Endpoint = endpoint, CreatedAt = clock.Now }; db.PushSubscriptions.Add(sub); }
        sub.UserId = uid; sub.P256dh = req.Keys!.P256dh!; sub.Auth = req.Keys.Auth!; sub.Failures = 0;
        sub.UserAgent = userAgent is { Length: > 300 } ? userAgent[..300] : userAgent;
        // A person keeps at most 10 devices: the oldest goes.
        var all = await db.PushSubscriptions.Where(s => s.UserId == uid && s.Endpoint != endpoint).OrderByDescending(s => s.CreatedAt).Skip(9).ToListAsync(ct);
        db.PushSubscriptions.RemoveRange(all);
        await db.SaveChangesAsync(ct);
        return await StatusAsync(ct);
    }

    public async Task<PushStatusDto> UnsubscribeAsync(string? endpoint, CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var sub = await db.PushSubscriptions.FirstOrDefaultAsync(s => s.UserId == uid && s.Endpoint == endpoint, ct);
        if (sub is not null) { db.PushSubscriptions.Remove(sub); await db.SaveChangesAsync(ct); }
        return await StatusAsync(ct);
    }
}

/// <summary>Background work: pushes waiting notifications to their person's devices, and forgets devices the push service no longer knows.</summary>
public class PushDispatcher(IServiceScopeFactory scopes, ILogger<PushDispatcher> log)
{
    private const int Batch = 100;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public async Task<int> RunAsync(CancellationToken ct = default)
    {
        using var scope = scopes.CreateScope();
        var sp = scope.ServiceProvider;
        var db = sp.GetRequiredService<IAppDbContext>();
        var pending = await db.Notifications.IgnoreQueryFilters().Where(n => n.PushPending).OrderBy(n => n.CreatedAt).Take(Batch).ToListAsync(ct);
        if (pending.Count == 0) return 0;
        var users = pending.Select(n => n.UserId).Distinct().ToList();
        var subs = await db.PushSubscriptions.Where(s => users.Contains(s.UserId)).ToListAsync(ct);
        var sent = 0;
        if (subs.Count > 0)
        {
            var keys = await PushService.KeysAsync(db, sp.GetRequiredService<ISecretProtector>(),
                PushService.SubjectOf(sp.GetRequiredService<IOptions<PushOptions>>().Value, sp.GetRequiredService<IOptions<AppOptions>>().Value), ct);
            var sender = sp.GetRequiredService<IWebPushSender>();
            var now = DateTime.UtcNow;
            foreach (var n in pending)
            {
                var token = n.Link is { } l && l.StartsWith("/r/", StringComparison.Ordinal) ? l[3..] : null;
                var payload = JsonSerializer.Serialize(new { title = n.Title, body = n.Body, link = n.Link, tag = n.Id, type = n.Type.ToString(), token }, Json);
                foreach (var s in subs.Where(s => s.UserId == n.UserId && s.Failures < 20))
                {
                    int? status;
                    try { status = await sender.SendAsync(s, payload, keys, ct); }
                    catch (Exception ex) when (ex is not OperationCanceledException) { log.LogDebug(ex, "Push to a device failed"); status = null; }
                    if (status is >= 200 and < 300) { s.LastSuccessAt = now; s.Failures = 0; sent++; }
                    else if (status is 404 or 410) db.PushSubscriptions.Remove(s);   // the device unsubscribed or expired
                    else s.Failures++;
                }
            }
        }
        foreach (var n in pending) n.PushPending = false;
        await db.SaveChangesAsync(ct);
        return sent;
    }
}
