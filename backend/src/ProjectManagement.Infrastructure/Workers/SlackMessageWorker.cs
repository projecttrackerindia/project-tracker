using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Features.Integrations;
using ProjectManagement.Application.Features.Notifications;

namespace ProjectManagement.Infrastructure.Workers;

/// <summary>Hosted worker: sends waiting notifications as Slack direct messages every few seconds (only when Slack is set up).</summary>
public class SlackMessageWorker(SlackMessageDispatcher dispatcher, IOptions<SlackOptions> slack, IOptions<PushOptions> push, ILogger<SlackMessageWorker> log,
    ProjectManagement.Application.Common.WorkerHeartbeats beats) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Same switch as push: tests and one-off tools run without background senders.
        if (!slack.Value.Configured || !push.Value.WorkerEnabled) return;
        var every = Math.Max(5, push.Value.IntervalSeconds);
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(every));
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(20), stoppingToken);
            do
            {
                try { var n = await dispatcher.RunAsync(stoppingToken); if (n > 0) log.LogInformation("Sent {Count} notification(s) to Slack", n); beats.Beat("Slack", every); }
                catch (Exception ex) when (ex is not OperationCanceledException) { log.LogError(ex, "Slack message run failed"); beats.Beat("Slack", every, ex.GetType().Name); }
            } while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException) { /* shutting down */ }
    }
}
