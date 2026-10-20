using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Features.Time;

namespace ProjectManagement.Infrastructure.Workers;

public class TimesheetNudgeOptions
{
    public const string Section = "TimesheetNudges";
    public bool WorkerEnabled { get; set; } = true;
    public int IntervalSeconds { get; set; } = 1800;
}

/// <summary>Hosted worker: every half hour, timesheet reminders for people whose working day has begun (see <see cref="TimesheetNudgeMonitor"/>).</summary>
public class TimesheetNudgeWorker(IServiceScopeFactory scopes, IOptions<TimesheetNudgeOptions> options, ILogger<TimesheetNudgeWorker> log, ProjectManagement.Application.Common.WorkerHeartbeats beats) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.Value.WorkerEnabled) return;
        var every = Math.Max(300, options.Value.IntervalSeconds);
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(every));
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(90), stoppingToken);
            do
            {
                try
                {
                    // No request context: the monitor queries explicitly across workspaces.
                    using var scope = scopes.CreateScope();
                    await scope.ServiceProvider.GetRequiredService<TimesheetNudgeMonitor>().RunAsync(stoppingToken);
                    beats.Beat("Timesheet reminders", every);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    log.LogError(ex, "Timesheet reminders failed");
                    beats.Beat("Timesheet reminders", every, ex.GetType().Name);
                }
            } while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException) { /* shutting down */ }
    }
}
