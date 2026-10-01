using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Features.Work;

namespace ProjectManagement.Infrastructure.Workers;

public class SlaOptions
{
    public const string Section = "Sla";
    public bool WorkerEnabled { get; set; } = true;
    public int IntervalSeconds { get; set; } = 60;
}

/// <summary>Hosted worker: every minute, tells people about operational work that is at risk of, or has missed, its service-level targets.</summary>
public class SlaWorker(IServiceScopeFactory scopes, IOptions<SlaOptions> options, ILogger<SlaWorker> log, ProjectManagement.Application.Common.WorkerHeartbeats beats) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.Value.WorkerEnabled) return;
        var every = Math.Max(15, options.Value.IntervalSeconds);
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(every));
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(25), stoppingToken);
            do
            {
                try
                {
                    // No request context: the monitor queries explicitly across workspaces.
                    using var scope = scopes.CreateScope();
                    await scope.ServiceProvider.GetRequiredService<SlaMonitor>().RunAsync(stoppingToken);
                    beats.Beat("Service levels", every);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    log.LogError(ex, "Service-level run failed");
                    beats.Beat("Service levels", every, ex.GetType().Name);
                }
            } while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException) { /* shutting down */ }
    }
}
