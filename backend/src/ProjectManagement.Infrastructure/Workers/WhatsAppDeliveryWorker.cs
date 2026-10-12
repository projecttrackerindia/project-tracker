using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Features.Integrations;
namespace ProjectManagement.Infrastructure.Workers;
public class WhatsAppDeliveryWorker(WhatsAppDeliveryProcessor processor, IOptions<WhatsAppOptions> options,
    WorkerHeartbeats beats, ILogger<WhatsAppDeliveryWorker> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.Value.DeliveryEnabled) return;
        var interval = Math.Clamp(options.Value.DeliveryIntervalSeconds, 5, 60);
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(interval));
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(20), stoppingToken);
            do
            {
                try { await processor.ProcessAsync(stoppingToken); beats.Beat("WhatsApp delivery", interval); }
                catch (Exception ex) when (ex is not OperationCanceledException)
                { log.LogError("WhatsApp processing failed ({Kind})", ex.GetType().Name); beats.Beat("WhatsApp delivery", interval, ex.GetType().Name); }
            } while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
    }
}
