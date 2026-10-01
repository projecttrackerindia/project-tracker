using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Features.Notifications;

namespace ProjectManagement.Infrastructure.Workers;

/// <summary>Hosted worker: pushes waiting notifications to people's devices every few seconds.</summary>
public class PushWorker(PushDispatcher dispatcher, IOptions<PushOptions> options, ILogger<PushWorker> log, ProjectManagement.Application.Common.WorkerHeartbeats beats) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.Value.WorkerEnabled) return;
        var every = Math.Max(3, options.Value.IntervalSeconds);
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(every));
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(15), stoppingToken);
            do
            {
                try { var n = await dispatcher.RunAsync(stoppingToken); if (n > 0) log.LogInformation("Pushed {Count} notification(s) to devices", n); beats.Beat("Push", every); }
                catch (Exception ex) when (ex is not OperationCanceledException) { log.LogError(ex, "Push run failed"); beats.Beat("Push", every, ex.GetType().Name); }
            } while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException) { /* shutting down */ }
    }
}
