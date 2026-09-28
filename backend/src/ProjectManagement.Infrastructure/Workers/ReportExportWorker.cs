using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Features.Reports;

namespace ProjectManagement.Infrastructure.Workers;

public class ReportOptions
{
    public const string Section = "Reports";
    public bool WorkerEnabled { get; set; } = true;
    public int IntervalSeconds { get; set; } = 5;
}

/// <summary>Builds queued report files in the background, so asking for a big report never keeps a web request open.</summary>
public class ReportExportWorker(ReportExportProcessor processor, IOptions<ReportOptions> options, ILogger<ReportExportWorker> log, ProjectManagement.Application.Common.WorkerHeartbeats beats) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.Value.WorkerEnabled) return;
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(Math.Max(2, options.Value.IntervalSeconds)));
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(8), stoppingToken);
            do
            {
                try { var n = await processor.ProcessPendingAsync(ct: stoppingToken); if (n > 0) log.LogInformation("Processed {Count} report request(s)", n); beats.Beat("Report exports", Math.Max(2, options.Value.IntervalSeconds)); }
                catch (Exception ex) when (ex is not OperationCanceledException) { log.LogError(ex, "Report export run failed"); beats.Beat("Report exports", Math.Max(2, options.Value.IntervalSeconds), ex.GetType().Name); }
            } while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException) { /* shutting down */ }
    }
}
