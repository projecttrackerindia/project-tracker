using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Integrations;

public class WebhookOptions
{
    public const string Section = "Webhooks";
    public bool WorkerEnabled { get; set; } = true;
    public int IntervalSeconds { get; set; } = 5;
    /// <summary>Development and tests only: allow plain http and addresses on private networks (normally refused so a webhook cannot probe the server's own network).</summary>
    public bool AllowPrivateTargets { get; set; }
    /// <summary>How long new activity waits before it is turned into deliveries, so events that are still being saved are not missed.</summary>
    public double SettleSeconds { get; set; } = 2;
}

public record WebhookSendResult(int? Status, string? Error, string? Snippet);

/// <summary>Sends one signed request. The real implementation refuses private addresses and redirects.</summary>
public interface IWebhookTransport
{
    Task<WebhookSendResult> SendAsync(string url, IReadOnlyDictionary<string, string> headers, string body, CancellationToken ct);
}

/// <summary>What a webhook may be told about, in groups so a receiver can subscribe with "task.*".</summary>
public static class WebhookEvents
{
    public static readonly string[] All =
    [
        "task.created", "task.updated", "task.status_changed", "task.assigned", "task.priority_changed", "task.due_changed", "task.commented", "task.deleted",
        "task.dependency_added", "task.dependency_removed", "task.time_logged", "task.checklist_completed", "task.fields_changed", "task.imported",
        "project.created", "project.updated", "project.status_changed", "project.due_changed", "project.member_added", "project.deleted",
        "milestone.created", "milestone.status_changed", "milestone.deleted",
        "sprint.created", "sprint.started", "sprint.completed", "sprint.deleted",
        "attachment.added", "attachment.deleted", "member.invited", "member.role_changed", "team.created", "team.deleted",
    ];

    public static bool IsValidPattern(string p) => p == "*" || All.Contains(p) || (p.EndsWith(".*") && All.Any(e => e.StartsWith(p[..^1])));
    public static bool Matches(string patterns, string action) =>
        patterns.Split(',', StringSplitOptions.RemoveEmptyEntries).Any(p => p == "*" || p == action || (p.EndsWith(".*") && action.StartsWith(p[..^1])));
}

/// <summary>Which addresses a webhook may point at. Anything that reaches the server's own or an internal network is refused (SSRF).</summary>
public static class WebhookUrlRules
{
    public static bool IsBlocked(IPAddress ip)
    {
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
        if (IPAddress.IsLoopback(ip) || ip.Equals(IPAddress.Any) || ip.Equals(IPAddress.IPv6Any) || ip.Equals(IPAddress.None)) return true;
        if (ip.AddressFamily == AddressFamily.InterNetworkV6)
        {
            if (ip.IsIPv6LinkLocal || ip.IsIPv6SiteLocal || ip.IsIPv6Multicast) return true;
            var b6 = ip.GetAddressBytes();
            return (b6[0] & 0xFE) == 0xFC; // fc00::/7 unique local
        }
        var b = ip.GetAddressBytes();
        return b[0] == 10 || b[0] == 0 || b[0] >= 224
            || (b[0] == 172 && b[1] is >= 16 and <= 31)
            || (b[0] == 192 && b[1] == 168)
            || (b[0] == 169 && b[1] == 254)            // link-local, includes cloud metadata services
            || (b[0] == 100 && b[1] is >= 64 and <= 127); // carrier-grade NAT
    }

    /// <summary>Returns the reason a URL cannot be used, or null when it is fine.</summary>
    public static async Task<string?> CheckAsync(string? url, bool allowPrivate, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(url) || url.Length > 500 || !Uri.TryCreate(url.Trim(), UriKind.Absolute, out var uri)) return "Enter a full web address, such as https://example.com/hooks.";
        if (uri.Scheme != Uri.UriSchemeHttps && !(allowPrivate && uri.Scheme == Uri.UriSchemeHttp)) return "Webhook addresses must start with https://.";
        if (!string.IsNullOrEmpty(uri.UserInfo)) return "Do not put a user name or password in the address.";
        if (allowPrivate) return null;
        try
        {
            var addresses = IPAddress.TryParse(uri.Host, out var literal) ? [literal] : await Dns.GetHostAddressesAsync(uri.Host, ct);
            if (addresses.Length == 0) return "That address could not be found.";
            if (addresses.Any(IsBlocked)) return "That address points to a private or internal network, which webhooks cannot use.";
        }
        catch (SocketException) { return "That address could not be found."; }
        return null;
    }
}

public record WebhookDto(Guid Id, string Name, string Url, IReadOnlyList<string> Events, bool IsActive, string? DisabledReason, DateTime CreatedAt,
    DateTime? LastDeliveryAt, string? LastStatus, int ConsecutiveFailures);
public record CreatedWebhookDto(WebhookDto Webhook, string Secret);
public record UpsertWebhookRequest(string Name, string Url, IReadOnlyList<string>? Events, bool? IsActive);
public record WebhookDeliveryDto(Guid Id, string EventType, WebhookDeliveryStatus Status, int Attempts, int? ResponseStatus, string? Error, DateTime CreatedAt, DateTime? DeliveredAt, DateTime? NextAttemptAt);

/// <summary>Managing a workspace's webhooks. Owners and admins only, on plans with API access.</summary>
public class WebhookService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, EntitlementService entitlements,
    ISecretProtector protector, Microsoft.Extensions.Options.IOptions<WebhookOptions> options)
{
    private const int MaxWebhooks = 10;

    private void RequireAdmin()
    {
        if (ctx.Role is not (TenantRole.Owner or TenantRole.Admin)) throw new ForbiddenException("Only owners and admins can manage webhooks.", "PERMISSION_DENIED");
    }

    public static WebhookDto ToDto(Webhook w) => new(w.Id, w.Name, w.Url, w.Events.Split(',', StringSplitOptions.RemoveEmptyEntries), w.IsActive, w.DisabledReason,
        w.CreatedAt, w.LastDeliveryAt, w.LastStatus, w.ConsecutiveFailures);

    public static string NewSecret() => "whsec_" + Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    public IReadOnlyList<string> Catalogue() => WebhookEvents.All;

    public async Task<IReadOnlyList<WebhookDto>> ListAsync(CancellationToken ct = default)
    {
        RequireAdmin();
        return (await db.Webhooks.AsNoTracking().OrderBy(w => w.CreatedAt).ToListAsync(ct)).Select(ToDto).ToList();
    }

    private async Task<(string Name, string Url, string Events)> CleanAsync(UpsertWebhookRequest req, CancellationToken ct)
    {
        var name = (req.Name ?? "").Trim();
        if (name.Length is < 1 or > 60) throw new ValidationException("name", "Give the webhook a name (up to 60 characters).");
        if (await WebhookUrlRules.CheckAsync(req.Url, options.Value.AllowPrivateTargets, ct) is { } problem) throw new ValidationException("url", problem);
        var events = (req.Events is { Count: > 0 } ? req.Events : ["*"]).Select(e => (e ?? "").Trim()).Where(e => e.Length > 0).Distinct().ToList();
        var bad = events.FirstOrDefault(e => !WebhookEvents.IsValidPattern(e));
        if (bad is not null) throw new ValidationException("events", $"“{bad}” is not an event this system sends.");
        return (name, req.Url!.Trim(), string.Join(',', events));
    }

    public async Task<CreatedWebhookDto> CreateAsync(UpsertWebhookRequest req, CancellationToken ct = default)
    {
        RequireAdmin();
        await entitlements.EnsureFeatureAsync(FeatureKeys.ApiAccess, ct);
        var (name, url, events) = await CleanAsync(req, ct);
        if (await db.Webhooks.CountAsync(ct) >= MaxWebhooks) throw new ConflictException($"A workspace can have at most {MaxWebhooks} webhooks.", "LIMIT_REACHED");

        var secret = NewSecret();
        var hook = new Webhook
        {
            TenantId = ctx.RequireTenantId(), Name = name, Url = url, Events = events, SecretProtected = protector.Protect(secret),
            CursorAt = clock.Now, CreatedAt = clock.Now, CreatedBy = ctx.RequireUserId(),
        };
        db.Webhooks.Add(hook);
        recorder.Audit("webhook.created", "Webhook", hook.Id, newValue: new { hook.Name, hook.Url, hook.Events });
        await db.SaveChangesAsync(ct);
        return new CreatedWebhookDto(ToDto(hook), secret);
    }

    public async Task<WebhookDto> UpdateAsync(Guid id, UpsertWebhookRequest req, CancellationToken ct = default)
    {
        RequireAdmin();
        var hook = await db.Webhooks.FirstOrDefaultAsync(w => w.Id == id, ct) ?? throw new NotFoundException("Webhook not found.");
        var (name, url, events) = await CleanAsync(req, ct);
        hook.Name = name; hook.Url = url; hook.Events = events; hook.UpdatedAt = clock.Now;
        if (req.IsActive is { } active && active != hook.IsActive)
        {
            if (active) await entitlements.EnsureFeatureAsync(FeatureKeys.ApiAccess, ct);
            hook.IsActive = active; hook.DisabledReason = active ? null : "Turned off by an administrator.";
            if (active) { hook.ConsecutiveFailures = 0; hook.CursorAt = clock.Now; } // do not flood it with what happened while it was off
        }
        recorder.Audit("webhook.updated", "Webhook", id, newValue: new { hook.Name, hook.Url, hook.Events, hook.IsActive });
        await db.SaveChangesAsync(ct);
        return ToDto(hook);
    }

    public async Task<CreatedWebhookDto> RotateSecretAsync(Guid id, CancellationToken ct = default)
    {
        RequireAdmin();
        var hook = await db.Webhooks.FirstOrDefaultAsync(w => w.Id == id, ct) ?? throw new NotFoundException("Webhook not found.");
        var secret = NewSecret();
        hook.SecretProtected = protector.Protect(secret); hook.UpdatedAt = clock.Now;
        recorder.Audit("webhook.secret_rotated", "Webhook", id);
        await db.SaveChangesAsync(ct);
        return new CreatedWebhookDto(ToDto(hook), secret);
    }

    public async Task DeleteAsync(Guid id, CancellationToken ct = default)
    {
        RequireAdmin();
        var hook = await db.Webhooks.FirstOrDefaultAsync(w => w.Id == id, ct) ?? throw new NotFoundException("Webhook not found.");
        db.WebhookDeliveries.RemoveRange(await db.WebhookDeliveries.Where(d => d.WebhookId == id).ToListAsync(ct));
        db.Webhooks.Remove(hook);
        recorder.Audit("webhook.deleted", "Webhook", id, oldValue: new { hook.Name, hook.Url });
        await db.SaveChangesAsync(ct);
    }

    public async Task<IReadOnlyList<WebhookDeliveryDto>> DeliveriesAsync(Guid id, CancellationToken ct = default)
    {
        RequireAdmin();
        if (!await db.Webhooks.AnyAsync(w => w.Id == id, ct)) throw new NotFoundException("Webhook not found.");
        return await db.WebhookDeliveries.AsNoTracking().Where(d => d.WebhookId == id).OrderByDescending(d => d.CreatedAt).Take(50)
            .Select(d => new WebhookDeliveryDto(d.Id, d.EventType, d.Status, d.Attempts, d.ResponseStatus, d.Error, d.CreatedAt, d.DeliveredAt, d.Status == WebhookDeliveryStatus.Pending ? d.NextAttemptAt : null))
            .ToListAsync(ct);
    }

    /// <summary>Queues a harmless "ping" so an administrator can check the receiver end to end.</summary>
    public async Task<WebhookDeliveryDto> SendTestAsync(Guid id, CancellationToken ct = default)
    {
        RequireAdmin();
        var hook = await db.Webhooks.FirstOrDefaultAsync(w => w.Id == id, ct) ?? throw new NotFoundException("Webhook not found.");
        var delivery = WebhookProcessor.NewDelivery(hook, null, "ping", clock.Now, new { message = "This is a test from your workspace.", webhookId = hook.Id });
        db.WebhookDeliveries.Add(delivery);
        await db.SaveChangesAsync(ct);
        return new WebhookDeliveryDto(delivery.Id, delivery.EventType, delivery.Status, 0, null, null, delivery.CreatedAt, null, delivery.NextAttemptAt);
    }

    public async Task RetryAsync(Guid id, Guid deliveryId, CancellationToken ct = default)
    {
        RequireAdmin();
        var d = await db.WebhookDeliveries.FirstOrDefaultAsync(x => x.Id == deliveryId && x.WebhookId == id, ct) ?? throw new NotFoundException("Delivery not found.");
        if (d.Status != WebhookDeliveryStatus.Failed) throw new ConflictException("Only failed deliveries can be retried.", "NOT_FAILED");
        d.Status = WebhookDeliveryStatus.Pending; d.Attempts = 0; d.NextAttemptAt = clock.Now; d.Error = null;
        await db.SaveChangesAsync(ct);
    }
}

/// <summary>
/// Background work for webhooks, in two steps: turn new activity into deliveries (one per matching webhook), then send what is due, with
/// growing delays between retries. A receiver that keeps failing is switched off so it does not stay in the queue for ever.
/// </summary>
public class WebhookProcessor(IServiceScopeFactory scopes, TimeProvider time, ILogger<WebhookProcessor> log, Microsoft.Extensions.Options.IOptions<WebhookOptions> options)
{
    public const int MaxAttempts = 6;
    private const int DisableAfterFailures = 10;
    private static readonly TimeSpan[] Backoff = [TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(30), TimeSpan.FromHours(2), TimeSpan.FromHours(12)];
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private DateTime Now => time.GetUtcNow().UtcDateTime;

    public static WebhookDelivery NewDelivery(Webhook hook, Guid? activityId, string eventType, DateTime now, object data) => new()
    {
        TenantId = hook.TenantId, WebhookId = hook.Id, ActivityId = activityId, EventType = eventType, NextAttemptAt = now, CreatedAt = now,
        Payload = JsonSerializer.Serialize(new { id = Guid.NewGuid(), @event = eventType, occurredAt = now, workspaceId = hook.TenantId, data }, Json),
    };

    /// <summary>One round: fan out new events, then deliver. Returns how many requests were sent.</summary>
    public async Task<int> RunAsync(CancellationToken ct = default)
    {
        await DispatchAsync(ct);
        return await DeliverAsync(ct);
    }

    // ---------------------------------------------------------------- activity → deliveries

    public async Task DispatchAsync(CancellationToken ct = default)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<IAppDbContext>();
        var until = Now - TimeSpan.FromSeconds(options.Value.SettleSeconds); // give in-flight requests time to commit, so nothing is skipped
        var hooks = await db.Webhooks.IgnoreQueryFilters().Where(w => w.IsActive && db.Tenants.IgnoreQueryFilters().Any(t => t.Id == w.TenantId && t.Status == TenantStatus.Active && !t.IsDeleted)).ToListAsync(ct);

        foreach (var hook in hooks)
        {
            var activities = await db.Activities.IgnoreQueryFilters().AsNoTracking().Where(a => a.TenantId == hook.TenantId && a.CreatedAt >= hook.CursorAt && a.CreatedAt <= until)
                .OrderBy(a => a.CreatedAt).ThenBy(a => a.Id).Take(200).ToListAsync(ct);
            if (activities.Count == 0) continue;

            var ids = activities.Select(a => a.Id).ToList();
            var done = (await db.WebhookDeliveries.IgnoreQueryFilters().Where(d => d.WebhookId == hook.Id && d.ActivityId != null && ids.Contains(d.ActivityId.Value)).Select(d => d.ActivityId!.Value).ToListAsync(ct)).ToHashSet();
            var actors = activities.Where(a => a.ActorId != null).Select(a => a.ActorId!.Value).Distinct().ToList();
            var names = await db.Users.IgnoreQueryFilters().Where(u => actors.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);

            foreach (var a in activities.Where(a => !done.Contains(a.Id) && WebhookEvents.Matches(hook.Events, a.Action)))
                db.WebhookDeliveries.Add(NewDelivery(hook, a.Id, a.Action, a.CreatedAt, new
                {
                    summary = a.Summary, entity = new { type = a.EntityType, id = a.EntityId }, projectId = a.ProjectId,
                    actor = a.ActorId is { } id ? new { id, name = names.GetValueOrDefault(id) } : null, oldValue = a.OldValue, newValue = a.NewValue,
                }));
            hook.CursorAt = activities[^1].CreatedAt;
            await db.SaveChangesAsync(ct);
        }
    }

    // ---------------------------------------------------------------- deliveries → HTTP

    public async Task<int> DeliverAsync(CancellationToken ct = default)
    {
        var claimed = new List<Guid>();
        using (var scope = scopes.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<IAppDbContext>();
            var now = Now;
            var due = await db.WebhookDeliveries.IgnoreQueryFilters().Where(d => d.Status == WebhookDeliveryStatus.Pending && d.NextAttemptAt <= now).OrderBy(d => d.NextAttemptAt).Take(25).Select(d => d.Id).ToListAsync(ct);
            foreach (var id in due)
            {
                // Claim by pushing the next attempt out, so two servers never send the same delivery at once.
                var lockUntil = now.AddMinutes(2);
                if (await db.WebhookDeliveries.IgnoreQueryFilters().Where(d => d.Id == id && d.Status == WebhookDeliveryStatus.Pending && d.NextAttemptAt <= now)
                        .ExecuteUpdateAsync(s => s.SetProperty(d => d.NextAttemptAt, lockUntil), ct) == 1) claimed.Add(id);
            }
        }
        foreach (var id in claimed)
        {
            try { await SendOneAsync(id, ct); }
            catch (Exception ex) when (ex is not OperationCanceledException) { log.LogError(ex, "Webhook delivery {Id} failed unexpectedly", id); }
        }
        return claimed.Count;
    }

    private async Task SendOneAsync(Guid id, CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        var sp = scope.ServiceProvider;
        var db = sp.GetRequiredService<IAppDbContext>();
        var d = await db.WebhookDeliveries.IgnoreQueryFilters().FirstAsync(x => x.Id == id, ct);
        var hook = await db.Webhooks.IgnoreQueryFilters().FirstOrDefaultAsync(w => w.Id == d.WebhookId, ct);
        var now = Now;

        if (hook is null || !hook.IsActive && d.EventType != "ping")
        {
            d.Status = WebhookDeliveryStatus.Failed; d.Error = "The webhook is switched off or was removed."; await db.SaveChangesAsync(ct);
            return;
        }

        var secret = sp.GetRequiredService<ISecretProtector>().Unprotect(hook.SecretProtected);
        var stamp = new DateTimeOffset(now).ToUnixTimeSeconds();
        var signature = Convert.ToHexString(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), Encoding.UTF8.GetBytes($"{stamp}.{d.Payload}"))).ToLowerInvariant();
        var headers = new Dictionary<string, string>
        {
            ["X-PM-Event"] = d.EventType, ["X-PM-Delivery"] = d.Id.ToString(), ["X-PM-Timestamp"] = stamp.ToString(), ["X-PM-Signature"] = $"t={stamp},v1={signature}",
        };

        using var span = ProjectManagement.Application.Common.AppTelemetry.Source.StartActivity("webhook.deliver");
        span?.SetTag("webhook.event", d.EventType);
        var result = await sp.GetRequiredService<IWebhookTransport>().SendAsync(hook.Url, headers, d.Payload, ct);
        d.Attempts++;
        d.ResponseStatus = result.Status; d.ResponseSnippet = result.Snippet;
        var ok = result.Status is >= 200 and < 300;
        hook.LastDeliveryAt = now;

        ProjectManagement.Application.Common.AppTelemetry.Count(ProjectManagement.Application.Common.AppTelemetry.WebhookDeliveries, ok ? "succeeded" : d.Attempts >= MaxAttempts ? "failed" : "retry");
        span?.SetTag("http.response.status_code", result.Status);
        if (ok)
        {
            d.Status = WebhookDeliveryStatus.Succeeded; d.DeliveredAt = now; d.Error = null;
            hook.LastStatus = "ok"; hook.ConsecutiveFailures = 0;
        }
        else
        {
            d.Error = result.Error ?? $"The receiver answered {result.Status}.";
            hook.LastStatus = "failed";
            if (d.Attempts >= MaxAttempts)
            {
                d.Status = WebhookDeliveryStatus.Failed;
                if (d.EventType != "ping" && ++hook.ConsecutiveFailures >= DisableAfterFailures && hook.IsActive)
                {
                    hook.IsActive = false; hook.DisabledReason = $"Switched off automatically after {DisableAfterFailures} deliveries in a row failed.";
                }
            }
            else d.NextAttemptAt = now + Backoff[Math.Min(d.Attempts - 1, Backoff.Length - 1)];
        }
        await db.SaveChangesAsync(ct);
    }

    /// <summary>Removes old delivery history (kept two weeks).</summary>
    public async Task<int> PurgeAsync(CancellationToken ct = default)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<IAppDbContext>();
        var cutoff = Now.AddDays(-14);
        return await db.WebhookDeliveries.IgnoreQueryFilters().Where(d => d.CreatedAt < cutoff && d.Status != WebhookDeliveryStatus.Pending).ExecuteDeleteAsync(ct);
    }
}
