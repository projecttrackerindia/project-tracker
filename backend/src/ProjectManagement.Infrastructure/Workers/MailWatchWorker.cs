using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Features.Mailbox;

namespace ProjectManagement.Infrastructure.Workers;

public class MailWatchOptions
{
    public const string Section = "MailWatch";
    public bool WorkerEnabled { get; set; } = true;
    /// <summary>How often the watcher wakes up; each mailbox is itself polled at most every two minutes (with back-off on failures).</summary>
    public int IntervalSeconds { get; set; } = 60;
}

/// <summary>Hosted worker: new-mail alerts for connected IMAP mailboxes (see <see cref="MailWatchMonitor"/>).</summary>
public class MailWatchWorker(IServiceScopeFactory scopes, IOptions<MailWatchOptions> options, ILogger<MailWatchWorker> log, ProjectManagement.Application.Common.WorkerHeartbeats beats) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.Value.WorkerEnabled) return;
        var every = Math.Max(30, options.Value.IntervalSeconds);
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(every));
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(45), stoppingToken);
            do
            {
                try
                {
                    using var scope = scopes.CreateScope();
                    await scope.ServiceProvider.GetRequiredService<MailWatchMonitor>().RunAsync(stoppingToken);
                    beats.Beat("Mail alerts", every);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    log.LogError(ex, "Mail alerts failed");
                    beats.Beat("Mail alerts", every, ex.GetType().Name);
                }
            } while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException) { /* shutting down */ }
    }
}
