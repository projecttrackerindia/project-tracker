using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Features.Ai;

namespace ProjectManagement.Infrastructure.Workers;

public class AiSearchOptions
{
    public const string Section = "Ai:Search";
    public bool WorkerEnabled { get; set; } = true;
    public int IntervalSeconds { get; set; } = 120;
    /// <summary>Pages and work items embedded per pass (all workspaces together).</summary>
    public int Budget { get; set; } = 200;
}

/// <summary>Keeps meaning-based search up to date: embeds what changed since the last pass and drops what was deleted. Idle when no embedding model is set.</summary>
public class AiSemanticWorker(IServiceScopeFactory scopes, IOptions<AiSearchOptions> options, WorkerHeartbeats beats, ILogger<AiSemanticWorker> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.Value.WorkerEnabled) return;
        var interval = Math.Clamp(options.Value.IntervalSeconds, 30, 3600);
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(interval));
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(45), stoppingToken);
            do
            {
                try
                {
                    using var scope = scopes.CreateScope();
                    var index = scope.ServiceProvider.GetRequiredService<AiSemanticIndex>();
                    if (!index.Enabled) { beats.Beat("Meaning search", interval); continue; }
                    var n = await index.IndexPendingAsync(Math.Clamp(options.Value.Budget, 10, 2000), stoppingToken);
                    if (n > 0) log.LogInformation("Indexed {Count} page(s) and work item(s) for meaning search", n);
                    beats.Beat("Meaning search", interval);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    log.LogError("Meaning search indexing failed ({Kind})", ex.GetType().Name);
                    beats.Beat("Meaning search", interval, ex.GetType().Name);
                }
            } while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
    }
}
