using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Features.Support;
namespace ProjectManagement.Infrastructure.Workers;

/// <summary>Every few seconds: lets the AI support employee answer WhatsApp chats that are waiting.</summary>
public class SupportReplyWorker(SupportReplyProcessor processor, IOptions<SupportOptions> options, WorkerHeartbeats beats, ILogger<SupportReplyWorker> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var interval = Math.Clamp(options.Value.ReplyIntervalSeconds, 1, 60);
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(interval));
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(10), stoppingToken);
            do
            {
                try { await processor.ProcessAsync(stoppingToken); beats.Beat("WhatsApp support replies", interval); }
                catch (Exception ex) when (ex is not OperationCanceledException)
                { log.LogError("WhatsApp support replies failed ({Kind})", ex.GetType().Name); beats.Beat("WhatsApp support replies", interval, ex.GetType().Name); }
            } while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
    }
}
