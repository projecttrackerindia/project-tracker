using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Features.ProjectMeetings;

namespace ProjectManagement.Infrastructure.Workers;

public class GoogleMeetSyncOptions
{
    public const string Section = "GoogleMeetSync";
    public bool WorkerEnabled { get; set; } = true;
    /// <summary>15 minutes by default - RSVP status is not urgent, and anything shorter would be the "aggressive polling" the spec says not to do.</summary>
    public int IntervalSeconds { get; set; } = 900;
}

/// <summary>Hosted worker: periodically pulls attendee RSVP responses for current/upcoming meetings (spec section 19), so the status shown in
/// the app stays reasonably fresh even for a meeting nobody has reopened since someone replied.</summary>
public class GoogleMeetSyncWorker(IServiceScopeFactory scopes, IOptions<GoogleMeetSyncOptions> options, ILogger<GoogleMeetSyncWorker> log, ProjectManagement.Application.Common.WorkerHeartbeats beats) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.Value.WorkerEnabled) return;
        var every = Math.Max(120, options.Value.IntervalSeconds);
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(every));
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(40), stoppingToken);
            do
            {
                try
                {
                    // No request context: the engine queries explicitly across every active tenant.
                    using var scope = scopes.CreateScope();
                    await scope.ServiceProvider.GetRequiredService<MeetingSyncEngine>().RunAsync(stoppingToken);
                    beats.Beat("Google Meet RSVP sync", every);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    log.LogError(ex, "Google Meet RSVP sync failed");
                    beats.Beat("Google Meet RSVP sync", every, ex.GetType().Name);
                }
            } while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException) { /* shutting down */ }
    }
}
