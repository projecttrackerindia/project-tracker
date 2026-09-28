using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Features.Billing;

namespace ProjectManagement.Infrastructure.Workers;

public class MaintenanceOptions
{
    public const string Section = "Maintenance";
    public bool Enabled { get; set; } = true;
    public int IntervalMinutes { get; set; } = 15;
}

/// <summary>Hosted worker: subscription lifecycle, due-date reminders and cleanup (spec section 62).</summary>
public class MaintenanceWorker(IServiceScopeFactory scopes, IOptions<MaintenanceOptions> options, ILogger<MaintenanceWorker> log, ProjectManagement.Application.Common.WorkerHeartbeats beats) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.Value.Enabled) return;
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(Math.Max(1, options.Value.IntervalMinutes)));
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(20), stoppingToken); // let the app finish starting
            do
            {
                try
                {
                    // No request context here: the scope has no tenant, so the job queries explicitly across tenants.
                    using var scope = scopes.CreateScope();
                    await scope.ServiceProvider.GetRequiredService<MaintenanceService>().RunAllAsync(stoppingToken);
                    beats.Beat("Maintenance", Math.Max(1, options.Value.IntervalMinutes) * 60);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    log.LogError(ex, "Maintenance run failed");
                    beats.Beat("Maintenance", Math.Max(1, options.Value.IntervalMinutes) * 60, ex.GetType().Name);
                }
            } while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException) { /* shutting down */ }
    }
}
