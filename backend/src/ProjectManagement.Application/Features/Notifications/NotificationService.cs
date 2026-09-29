using System.Net;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Auth;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Notifications;

public record NotificationDto(Guid Id, NotificationType Type, string Title, string? Body, string? Link, bool IsRead, DateTime CreatedAt, bool Browser);
public record UnreadCountDto(int Count);

public record NotificationPreferenceDto(NotificationType Type, string Label, string Description, bool InApp, bool Email, bool Browser, bool Locked);
public record PreferenceInput(NotificationType Type, bool InApp, bool Email, bool Browser);
public record SetPreferencesRequest(IReadOnlyList<PreferenceInput> Items);
public record TestEmailResultDto(string Provider, bool Delivered, string Message);

/// <summary>Which channels a notification uses for one recipient.</summary>
public readonly record struct Channels(bool InApp, bool Email, bool Browser)
{
    public bool Any => InApp || Email || Browser;
}

/// <summary>Turns a recipient's preferences (or the catalog defaults) into channels. Preferences are loaded once per user and cached for the request.</summary>
public class NotificationRouter(IAppDbContext db)
{
    private readonly Dictionary<(Guid, NotificationType), Channels> _chosen = new();
    private readonly HashSet<Guid> _loaded = [];

    public async Task PreloadAsync(IEnumerable<Guid> userIds, CancellationToken ct = default)
    {
        var missing = userIds.Where(u => !_loaded.Contains(u)).Distinct().ToList();
        if (missing.Count == 0) return;
        var rows = await db.NotificationPreferences.AsNoTracking().Where(p => missing.Contains(p.UserId)).ToListAsync(ct);
        foreach (var r in rows) _chosen[(r.UserId, r.Type)] = new Channels(r.InApp, r.Email, r.Browser);
        foreach (var u in missing) _loaded.Add(u);
    }

    public static Channels Defaults(NotificationType type)
    {
        var k = NotificationCatalog.For(type);
        return new Channels(k.InApp, k.Email, k.Browser);
    }

    public async Task<Channels> ChannelsAsync(Guid userId, NotificationType type, CancellationToken ct = default)
    {
        await PreloadAsync([userId], ct);
        var c = _chosen.TryGetValue((userId, type), out var chosen) ? chosen : Defaults(type);
        if (NotificationCatalog.For(type).Locked) c = c with { InApp = true, Email = true }; // security alerts cannot be switched off
        return c;
    }

    /// <summary>Applies the recipient's channels to a new notification. Returns false when they have switched every channel off.</summary>
    public async Task<bool> ApplyAsync(Notification n, CancellationToken ct = default)
    {
        var c = await ChannelsAsync(n.UserId, n.Type, ct);
        n.InApp = c.InApp;
        n.EmailPending = c.Email;
        n.Browser = c.Browser && c.InApp; // a desktop notification needs the in-app item to open
        return c.Any;
    }
}

public class NotificationService(IAppDbContext db, ICurrentContext ctx, AppClock clock, NotificationRouter router)
{
    /// <summary>
    /// Queues a notification in the current unit of work (caller saves), honouring the recipient's channel preferences.
    /// People are not notified about their own actions unless <paramref name="toSelf"/> (security alerts).
    /// </summary>
    public async Task AddAsync(Guid userId, NotificationType type, string title, string? body = null, string? link = null,
        string? dedupeKey = null, bool toSelf = false, CancellationToken ct = default)
    {
        if (userId == ctx.UserId && !toSelf) return;
        var n = new Notification
        {
            TenantId = ctx.RequireTenantId(), UserId = userId, Type = type, Title = Text.Truncate(title, 200)!,
            Body = Text.Truncate(body, 500), Link = link, DedupeKey = dedupeKey, CreatedAt = clock.Now,
        };
        if (await router.ApplyAsync(n, ct)) db.Notifications.Add(n);
    }

    public async Task<PagedResult<NotificationDto>> ListAsync(bool unreadOnly, int page, int pageSize, CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var q = db.Notifications.AsNoTracking().Where(n => n.UserId == uid && n.InApp);
        if (unreadOnly) q = q.Where(n => n.ReadAt == null);
        var p = new PageQuery(page, pageSize);
        var total = await q.CountAsync(ct);
        var rows = await q.OrderByDescending(n => n.CreatedAt).Skip((p.SafePage - 1) * p.SafeSize()).Take(p.SafeSize()).ToListAsync(ct);
        return new PagedResult<NotificationDto>(
            rows.Select(n => new NotificationDto(n.Id, n.Type, n.Title, n.Body, n.Link, n.ReadAt != null, n.CreatedAt, n.Browser)).ToList(),
            p.SafePage, p.SafeSize(), total);
    }

    public async Task<UnreadCountDto> UnreadCountAsync(CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        return new UnreadCountDto(await db.Notifications.CountAsync(n => n.UserId == uid && n.InApp && n.ReadAt == null, ct));
    }

    public async Task MarkReadAsync(Guid id, CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var n = await db.Notifications.FirstOrDefaultAsync(x => x.Id == id && x.UserId == uid, ct)
            ?? throw new NotFoundException("Notification not found.");
        n.ReadAt ??= clock.Now;
        await db.SaveChangesAsync(ct);
    }

    public async Task MarkAllReadAsync(CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var now = clock.Now;
        foreach (var n in await db.Notifications.Where(x => x.UserId == uid && x.InApp && x.ReadAt == null).ToListAsync(ct)) n.ReadAt = now;
        await db.SaveChangesAsync(ct);
    }
}

/// <summary>A user's own choices: which kinds of notification reach them, and where (in the app, by e-mail, on the desktop).</summary>
public class NotificationPreferenceService(IAppDbContext db, ICurrentContext ctx, IEmailSender email, IOptions<AppOptions> options)
{
    public async Task<IReadOnlyList<NotificationPreferenceDto>> GetAsync(CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var mine = await db.NotificationPreferences.AsNoTracking().Where(p => p.UserId == uid).ToDictionaryAsync(p => p.Type, ct);
        return NotificationCatalog.All.Select(k =>
        {
            var has = mine.TryGetValue(k.Type, out var p);
            return new NotificationPreferenceDto(k.Type, k.Label, k.Description,
                k.Locked || (has ? p!.InApp : k.InApp), k.Locked || (has ? p!.Email : k.Email), has ? p!.Browser : k.Browser, k.Locked);
        }).ToList();
    }

    public async Task<IReadOnlyList<NotificationPreferenceDto>> SetAsync(SetPreferencesRequest req, CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var existing = await db.NotificationPreferences.Where(p => p.UserId == uid).ToDictionaryAsync(p => p.Type, ct);
        foreach (var item in req.Items.GroupBy(i => i.Type).Select(g => g.Last()))
        {
            var locked = NotificationCatalog.For(item.Type).Locked;
            var (inApp, mail) = locked ? (true, true) : (item.InApp, item.Email);
            if (existing.TryGetValue(item.Type, out var row)) { row.InApp = inApp; row.Email = mail; row.Browser = item.Browser; }
            else db.NotificationPreferences.Add(new NotificationPreference { UserId = uid, Type = item.Type, InApp = inApp, Email = mail, Browser = item.Browser });
        }
        await db.SaveChangesAsync(ct);
        return await GetAsync(ct);
    }

    /// <summary>Sends a message to the caller right now, so they can confirm delivery works. Reports the outcome instead of throwing.</summary>
    public async Task<TestEmailResultDto> SendTestEmailAsync(CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var user = await db.Users.AsNoTracking().FirstAsync(u => u.Id == uid, ct);
        var link = options.Value.WebBaseUrl.TrimEnd('/') + "/settings";
        try
        {
            await email.SendAsync(new EmailMessage(user.Email, "Test notification",
                EmailTemplates.Wrap("Your notifications work", WebUtility.HtmlEncode($"Hi {user.DisplayName},"), "This is a test message from your project workspace.", "Open settings", link),
                $"This is a test message from your project workspace. {link}"), ct).WaitAsync(EmailSenderExtensions.DefaultSendTimeout, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return new TestEmailResultDto(email.Name, false, $"The message could not be sent: {ex.Message}");
        }
        return email.Name == "log"
            ? new TestEmailResultDto("log", true, "Email is not connected to a mail server yet, so nothing was delivered. The message was written to the server log (see the README to set up SMTP).")
            : new TestEmailResultDto(email.Name, true, $"A test email was sent to {user.Email}.");
    }
}

/// <summary>
/// Background delivery of notification e-mails (spec section 62): the request that creates a notification never waits for the mail server,
/// and a failing server is retried a few times before the message is given up.
/// </summary>
public class NotificationEmailService(IAppDbContext db, IEmailSender email, IOptions<AppOptions> options, AppClock clock, ILogger<NotificationEmailService> log)
{
    public const int MaxAttempts = 5;

    public async Task<int> SendPendingAsync(int batch = 50, CancellationToken ct = default)
    {
        var rows = await db.Notifications.IgnoreQueryFilters().Where(n => n.EmailPending && n.EmailAttempts < MaxAttempts)
            .OrderBy(n => n.CreatedAt).Take(batch).ToListAsync(ct);
        if (rows.Count == 0) return 0;

        var userIds = rows.Select(n => n.UserId).Distinct().ToList();
        var users = await db.Users.Where(u => userIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, ct);
        var tenantIds = rows.Select(n => n.TenantId).Distinct().ToList();
        var tenants = await db.Tenants.IgnoreQueryFilters().Where(t => tenantIds.Contains(t.Id)).ToDictionaryAsync(t => t.Id, t => t.Name, ct);
        var baseUrl = options.Value.WebBaseUrl.TrimEnd('/');
        var sent = 0;

        foreach (var n in rows)
        {
            if (!users.TryGetValue(n.UserId, out var user) || !user.IsActive || !user.EmailVerified) { n.EmailPending = false; continue; }
            var workspace = tenants.GetValueOrDefault(n.TenantId);
            var link = baseUrl + (n.Link ?? "/");
            var body = string.IsNullOrWhiteSpace(n.Body) ? n.Title : n.Body!;
            try
            {
                await email.SendAsync(new EmailMessage(user.Email, workspace is null ? n.Title : $"{n.Title} · {workspace}",
                    EmailTemplates.Wrap(n.Title, WebUtility.HtmlEncode($"Hi {user.DisplayName},"), body, "Open in the app", link,
                        "You get this email because of your notification settings. Change them under Settings → Notifications."),
                    $"{n.Title}\n{body}\n{link}"), ct).WaitAsync(EmailSenderExtensions.DefaultSendTimeout, ct);
                n.EmailPending = false;
                n.EmailedAt = clock.Now;
                sent++;
                AppTelemetry.Count(AppTelemetry.Emails, "sent");
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                n.EmailAttempts++;
                AppTelemetry.Count(AppTelemetry.Emails, "failed");
                if (n.EmailAttempts >= MaxAttempts) n.EmailPending = false; // give up; the in-app notification is unaffected
                log.LogWarning(ex, "Could not e-mail notification {Id} (attempt {Attempt}/{Max})", n.Id, n.EmailAttempts, MaxAttempts);
            }
        }
        await db.SaveChangesAsync(ct);
        return sent;
    }
}
