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
    /// <summary>Check "tell me when…" watches on the same loop (tests turn it off and run the check themselves).</summary>
    public bool WatchesEnabled { get; set; } = true;
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
                    // Chat messages scheduled to be sent now (each is sent as its writer, in its own scope).
                    var chats = await ProjectManagement.Application.Features.Chat.ChatService.SendDueAsync(scope.ServiceProvider,
                        scope.ServiceProvider.GetRequiredService<ProjectManagement.Application.Services.AppClock>(), log, stoppingToken);
                    if (chats > 0) log.LogInformation("Sent {Count} scheduled chat message(s)", chats);
                    // "Tell me when…" watches (checked every couple of minutes; each fires once).
                    var watched = !options.Value.WatchesEnabled ? 0 : await scope.ServiceProvider.GetRequiredService<ProjectManagement.Application.Features.Ai.AiWatchService>().CheckAsync(ct: stoppingToken);
                    if (watched > 0) log.LogInformation("{Count} watch(es) fired", watched);
                    // Calls left marked live after a missed media-server event.
                    await ProjectManagement.Application.Features.Calls.CallService.SweepAsync(scope.ServiceProvider, stoppingToken);
                    // Calls that rang without an answer: "Missed call from …" in the person's inbox.
                    await ProjectManagement.Application.Features.Calls.CallService.NotifyMissedAsync(scope.ServiceProvider, stoppingToken);
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
