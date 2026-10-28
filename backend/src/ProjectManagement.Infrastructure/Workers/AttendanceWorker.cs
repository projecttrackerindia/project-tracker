using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Features.Attendance;

namespace ProjectManagement.Infrastructure.Workers;

public class AttendanceOptions
{
    public const string Section = "Attendance";
    public bool WorkerEnabled { get; set; } = true;
    public int IntervalSeconds { get; set; } = 300;
}

/// <summary>Hosted worker: every five minutes, check-in and check-out reminders and closing forgotten days (see <see cref="AttendanceMonitor"/>).</summary>
public class AttendanceWorker(IServiceScopeFactory scopes, IOptions<AttendanceOptions> options, ILogger<AttendanceWorker> log, ProjectManagement.Application.Common.WorkerHeartbeats beats) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.Value.WorkerEnabled) return;
        var every = Math.Max(60, options.Value.IntervalSeconds);
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(every));
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(120), stoppingToken);
            do
            {
                try
                {
                    // No request context: the monitor names each workspace in its queries.
                    using var scope = scopes.CreateScope();
                    await scope.ServiceProvider.GetRequiredService<AttendanceMonitor>().RunAsync(stoppingToken);
                    beats.Beat("Attendance reminders", every);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    log.LogError(ex, "Attendance reminders failed");
                    beats.Beat("Attendance reminders", every, ex.GetType().Name);
                }
            } while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException) { /* shutting down */ }
    }
}
