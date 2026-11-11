using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Features.Recurring;

namespace ProjectManagement.Infrastructure.Workers;

public class RecurringWorkOptions
{
    public const string Section = "RecurringWork";
    public bool WorkerEnabled { get; set; } = true;
    public int IntervalSeconds { get; set; } = 300;
}

/// <summary>
/// Hosted worker: every five minutes, makes the next occurrence of repeating tasks that need one (<see cref="RecurrenceJob"/>) and sends the
/// Monday manager e-mails that have come due in each person's own time zone (<see cref="ManagerDigestService"/>).
/// </summary>
public class RecurringWorkWorker(IServiceScopeFactory scopes, IOptions<RecurringWorkOptions> options, TimeProvider time, ILogger<RecurringWorkWorker> log,
    ProjectManagement.Application.Common.WorkerHeartbeats beats) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.Value.WorkerEnabled) return;
        var every = Math.Max(60, options.Value.IntervalSeconds);
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(every));
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(75), stoppingToken);
            do
            {
                var now = time.GetUtcNow().UtcDateTime;
                try
                {
                    using (var scope = scopes.CreateScope())
                        await scope.ServiceProvider.GetRequiredService<RecurrenceJob>().RunAsync(now, stoppingToken);
                    using (var scope = scopes.CreateScope())
                        await scope.ServiceProvider.GetRequiredService<ManagerDigestService>().SendAsync(now, stoppingToken);
                    using (var scope = scopes.CreateScope())
                        await scope.ServiceProvider.GetRequiredService<ProjectManagement.Application.Features.Insights.AuraFridayJob>().RunAsync(now, stoppingToken);
                    beats.Beat("Repeating tasks and manager e-mail", every);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    log.LogError(ex, "Repeating tasks or the manager e-mail failed");
                    beats.Beat("Repeating tasks and manager e-mail", every, ex.GetType().Name);
                }
            } while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException) { /* shutting down */ }
    }
}
