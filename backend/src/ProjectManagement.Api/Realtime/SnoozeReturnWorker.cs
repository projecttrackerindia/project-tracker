using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;

namespace ProjectManagement.Api.Realtime;

/// <summary>
/// A snoozed notification comes back when its time is up - nothing is saved at that moment, so nothing announced it: the bell, the badges,
/// the sound and the desktop notice waited for the next poll. This looks every 20 seconds for snoozes that just ended (and deliveries held
/// for quiet hours or Do not disturb that just became due) and announces them to their recipients' open apps, like a new notification.
/// With several servers only the one holding a short Redis lock looks, so each return is announced once.
/// </summary>
public sealed class SnoozeReturnWorker(IServiceScopeFactory scopes, INotificationFeed feed, TimeProvider clock, ILogger<SnoozeReturnWorker> log,
    StackExchange.Redis.IConnectionMultiplexer? redis = null) : BackgroundService
{
    private static readonly TimeSpan Every = TimeSpan.FromSeconds(20);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var since = clock.GetUtcNow().UtcDateTime;
        using var timer = new PeriodicTimer(Every);
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            var now = clock.GetUtcNow().UtcDateTime;
            try
            {
                if (redis is not null && !await redis.GetDatabase().StringSetAsync("pm:rt:snooze-lock", Environment.MachineName, Every - TimeSpan.FromSeconds(2), StackExchange.Redis.When.NotExists))
                { since = now; continue; }
                await AnnounceAsync(since, now, stoppingToken);
                since = now;
            }
            catch (Exception ex) when (ex is not OperationCanceledException) { log.LogWarning(ex, "Could not announce returning notifications"); }
        }
    }

    /// <summary>Announces the notifications whose snooze ended, or whose held delivery became due, in (from, to].</summary>
    public async Task<int> AnnounceAsync(DateTime from, DateTime to, CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<IAppDbContext>();
        var back = await db.Notifications.IgnoreQueryFilters().AsNoTracking()
            .Where(n => n.InApp && n.ReadAt == null && n.ArchivedAt == null
                && ((n.SnoozedUntil != null && n.SnoozedUntil > from && n.SnoozedUntil <= to) || (n.DeliverAfter != null && n.DeliverAfter > from && n.DeliverAfter <= to)))
            .OrderBy(n => n.Id).Take(2000)
            .Select(n => new { n.TenantId, n.UserId, n.Id, n.Type, n.InApp }).ToListAsync(ct);
        if (back.Count > 0) feed.Announce(back.Select(n => new NotificationAnnouncement(n.TenantId, n.UserId, n.Id, n.Type, n.InApp)).ToList());
        return back.Count;
    }
}
