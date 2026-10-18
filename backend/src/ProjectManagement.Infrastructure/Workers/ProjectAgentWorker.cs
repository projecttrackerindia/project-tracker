using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Features.Agent;

namespace ProjectManagement.Infrastructure.Workers;

/// <summary>Hosted worker: the project agent's tick (new chat, live meeting bots, finished meetings, readings, morning updates, opted-in inboxes).</summary>
public class ProjectAgentWorker(IServiceScopeFactory scopes, IOptions<AgentOptions> options, ILogger<ProjectAgentWorker> log, ProjectManagement.Application.Common.WorkerHeartbeats beats) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.Value.WorkerEnabled) return;
        var every = Math.Max(30, options.Value.IntervalSeconds);
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(every));
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(50), stoppingToken);
            do
            {
                try
                {
                    // No request context: the engine finds the projects across workspaces and handles each in its own scope.
                    using var scope = scopes.CreateScope();
                    await scope.ServiceProvider.GetRequiredService<AgentEngine>().TickAsync(stoppingToken);
                    beats.Beat("Project agent", every);
                }
                catch (Exception ex) when (!stoppingToken.IsCancellationRequested)   // a timeout somewhere is not a shutdown
                {
                    log.LogError(ex, "Project agent tick failed");
                    beats.Beat("Project agent", every, ex.GetType().Name);
                }
            } while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException) { /* shutting down */ }
    }
}
