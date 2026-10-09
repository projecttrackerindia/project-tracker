using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Infrastructure.Persistence;

namespace ProjectManagement.Infrastructure.Workers;

/// <summary>Optional traces expire independently of private conversations and credit accounting.</summary>
public sealed class AiTraceRetentionWorker(IServiceScopeFactory scopes, IOptions<AiOptions> options, ILogger<AiTraceRetentionWorker> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromHours(6));
        try
        {
            while (await timer.WaitForNextTickAsync(ct))
            {
                try
                {
                    using var scope = scopes.CreateScope();
                    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                    var before = DateTime.UtcNow.AddDays(-Math.Clamp(options.Value.TraceRetentionDays, 1, 365));
                    var ids = await db.AiMessages.IgnoreQueryFilters().Where(m => m.ExecutionJson != null && m.CreatedAt < before).OrderBy(m => m.CreatedAt).Select(m => m.Id).Take(1000).ToListAsync(ct);
                    await db.AiMessages.IgnoreQueryFilters().Where(m => ids.Contains(m.Id)).ExecuteUpdateAsync(s => s.SetProperty(m => m.ExecutionJson, (string?)null), ct);
                }
                catch (Exception ex) when (ex is not OperationCanceledException) { log.LogWarning(ex, "AI trace cleanup failed; business services remain available"); }
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
    }
}
