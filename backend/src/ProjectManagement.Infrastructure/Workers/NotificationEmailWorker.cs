using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Features.Notifications;

namespace ProjectManagement.Infrastructure.Workers;

public class NotificationOptions
{
    public const string Section = "Notifications";
    public bool EmailWorkerEnabled { get; set; } = true;
    public int IntervalSeconds { get; set; } = 20;
}

/// <summary>Sends queued notification e-mails in the background so requests never wait for the mail server (spec section 62).</summary>
public class NotificationEmailWorker(IServiceScopeFactory scopes, IOptions<NotificationOptions> options, ILogger<NotificationEmailWorker> log, ProjectManagement.Application.Common.WorkerHeartbeats beats) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.Value.EmailWorkerEnabled) return;
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(Math.Max(5, options.Value.IntervalSeconds)));
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(10), stoppingToken); // let the app finish starting
            do
            {
                try
                {
                    using var scope = scopes.CreateScope();
                    var sent = await scope.ServiceProvider.GetRequiredService<NotificationEmailService>().SendPendingAsync(ct: stoppingToken);
                    if (sent > 0) log.LogInformation("Sent {Count} notification e-mail(s)", sent);
                    // Messages that could not be delivered the first time (verification and reset links, invitations, security alerts) are tried again.
                    var retried = await scope.ServiceProvider.GetRequiredService<EmailRetryService>().RetryDueAsync(ct: stoppingToken);
                    if (retried > 0) log.LogInformation("Delivered {Count} e-mail(s) on a retry", retried);
                    beats.Beat("Notification e-mail", Math.Max(5, options.Value.IntervalSeconds));
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    log.LogError(ex, "Notification e-mail run failed");
                    beats.Beat("Notification e-mail", Math.Max(5, options.Value.IntervalSeconds), ex.GetType().Name);
                }
            } while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException) { /* shutting down */ }
    }
}
