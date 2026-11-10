using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Features.Ai;

namespace ProjectManagement.Infrastructure.Workers;

public class SlipFixOptions
{
    public const string Section = "SlipFix";
    public bool WorkerEnabled { get; set; } = true;
    public int IntervalSeconds { get; set; } = 10_800;
}

/// <summary>
/// Hosted worker: every three hours, Aura looks for projects whose forecast finish is later than the date promised and prepares one fix for each
/// project's owner (see <see cref="SlipFixService"/>). Cheap by design: bulk reads per owner, one card per project per day, nothing changes
/// without the owner's confirmation. Switched off per workspace by the project agent's level (Settings › AI).
/// </summary>
public class SlipFixWorker(IServiceScopeFactory scopes, IOptions<SlipFixOptions> options, ILogger<SlipFixWorker> log, ProjectManagement.Application.Common.WorkerHeartbeats beats) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.Value.WorkerEnabled) return;
        var every = Math.Max(600, options.Value.IntervalSeconds);
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(every));
        try
        {
            await Task.Delay(TimeSpan.FromMinutes(4), stoppingToken);
            do
            {
                try
                {
                    // No request context: the service names each workspace and each owner explicitly.
                    using var scope = scopes.CreateScope();
                    await scope.ServiceProvider.GetRequiredService<SlipFixService>().RunAsync(stoppingToken);
                    beats.Beat("Slip and fix", every);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    log.LogError(ex, "Slip and fix failed");
                    beats.Beat("Slip and fix", every, ex.GetType().Name);
                }
            } while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException) { /* shutting down */ }
    }
}
