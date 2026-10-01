using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Features.Automation;

namespace ProjectManagement.Infrastructure.Workers;

public class AutomationOptions
{
    public const string Section = "Automation";
    public bool WorkerEnabled { get; set; } = true;
    public int IntervalMinutes { get; set; } = 10;
}

/// <summary>Hosted worker: runs the time-based automation rules (due soon, overdue, no changes for a while) every few minutes.</summary>
public class AutomationWorker(IServiceScopeFactory scopes, IOptions<AutomationOptions> options, ILogger<AutomationWorker> log, ProjectManagement.Application.Common.WorkerHeartbeats beats) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.Value.WorkerEnabled) return;
        var every = Math.Max(1, options.Value.IntervalMinutes);
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(every));
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(40), stoppingToken);
            do
            {
                try
                {
                    // A fresh scope per run: the scheduler sets the workspace and acting person itself, rule by rule.
                    using var scope = scopes.CreateScope();
                    var n = await scope.ServiceProvider.GetRequiredService<AutomationScheduler>().RunAsync(stoppingToken);
                    if (n > 0) log.LogInformation("Scheduled automation acted on {Count} task(s)", n);
                    beats.Beat("Automation", every * 60);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    log.LogError(ex, "Scheduled automation run failed");
                    beats.Beat("Automation", every * 60, ex.GetType().Name);
                }
            } while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException) { /* shutting down */ }
    }
}
