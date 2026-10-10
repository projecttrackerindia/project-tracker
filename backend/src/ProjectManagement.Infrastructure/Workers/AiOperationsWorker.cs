using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Features.Ai;

namespace ProjectManagement.Infrastructure.Workers;

public class AiOperationsOptions
{
    public const string Section = "Ai:Operations";
    public bool WorkerEnabled { get; set; } = true;
    public int IntervalSeconds { get; set; } = 15;
}

public class AiOperationsWorker(AiOperationsProcessor processor, IOptions<AiOperationsOptions> options, WorkerHeartbeats beats, ILogger<AiOperationsWorker> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.Value.WorkerEnabled) return;
        var interval = Math.Clamp(options.Value.IntervalSeconds, 5, 300);
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(interval));
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(15), stoppingToken);
            do
            {
                try { await processor.ProcessAsync(stoppingToken); beats.Beat("Agent workflows", interval); }
                catch (Exception ex) when (ex is not OperationCanceledException)
                { log.LogError("Agent workflow processing failed ({Kind})", ex.GetType().Name); beats.Beat("Agent workflows", interval, ex.GetType().Name); }
            } while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
    }
}
