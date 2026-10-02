using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Features.Reminders;

namespace ProjectManagement.Infrastructure.Workers;

public class ReminderOptions
{
    public const string Section = "Reminders";
    public bool WorkerEnabled { get; set; } = true;
    public int IntervalSeconds { get; set; } = 30;
}

/// <summary>Hosted worker: fires reminders, keeps the automatic ones in step with the work, and sends morning briefings.</summary>
public class ReminderWorker(IServiceScopeFactory scopes, IOptions<ReminderOptions> options, ILogger<ReminderWorker> log, ProjectManagement.Application.Common.WorkerHeartbeats beats) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.Value.WorkerEnabled) return;
        var every = Math.Clamp(options.Value.IntervalSeconds, 5, 300);
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(every));
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(15), stoppingToken);
            do
            {
                try
                {
                    using var scope = scopes.CreateScope();
                    var n = await scope.ServiceProvider.GetRequiredService<ReminderEngine>().RunAsync(ct: stoppingToken);
                    if (n > 0) log.LogInformation("Sent {Count} reminder(s)", n);
                    beats.Beat("Reminders", every);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    log.LogError(ex, "Reminder run failed");
                    beats.Beat("Reminders", every, ex.GetType().Name);
                }
            } while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException) { /* shutting down */ }
    }
}
