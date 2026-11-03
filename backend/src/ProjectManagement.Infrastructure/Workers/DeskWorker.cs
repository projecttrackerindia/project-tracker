using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Features.Desk;
namespace ProjectManagement.Infrastructure.Workers;

/// <summary>Every few seconds: the Desk's inbound queue (WhatsApp intake), unaccepted and overdue tickets, and expired voice recordings.</summary>
public class DeskWorker(DeskQueueProcessor processor, IOptions<DeskOptions> options, WorkerHeartbeats beats, ILogger<DeskWorker> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var interval = Math.Clamp(options.Value.WorkerIntervalSeconds, 1, 300);
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(interval));
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(12), stoppingToken);
            do
            {
                try { await processor.RunAsync(stoppingToken); beats.Beat("Desk intake and routing", interval); }
                catch (Exception ex) when (ex is not OperationCanceledException)
                { log.LogError("Desk intake and routing failed ({Kind})", ex.GetType().Name); beats.Beat("Desk intake and routing", interval, ex.GetType().Name); }
            } while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
    }
}
