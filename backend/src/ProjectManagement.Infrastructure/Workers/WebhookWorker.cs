using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Features.Integrations;

namespace ProjectManagement.Infrastructure.Workers;

/// <summary>Turns activity into webhook deliveries and sends them, with retries (see <see cref="WebhookProcessor"/>).</summary>
public class WebhookWorker(WebhookProcessor processor, IOptions<WebhookOptions> options, ILogger<WebhookWorker> log, ProjectManagement.Application.Common.WorkerHeartbeats beats) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.Value.WorkerEnabled) return;
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(Math.Max(2, options.Value.IntervalSeconds)));
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(12), stoppingToken);
            do
            {
                try { var n = await processor.RunAsync(stoppingToken); if (n > 0) log.LogInformation("Sent {Count} webhook request(s)", n); beats.Beat("Webhooks", Math.Max(2, options.Value.IntervalSeconds)); }
                catch (Exception ex) when (ex is not OperationCanceledException) { log.LogError(ex, "Webhook run failed"); beats.Beat("Webhooks", Math.Max(2, options.Value.IntervalSeconds), ex.GetType().Name); }
            } while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException) { /* shutting down */ }
    }
}
