using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Features.SupportWorkflows;
namespace ProjectManagement.Infrastructure.Workers;
public class SupportWorkflowOptions
{
    public const string Section="Support:Workflows";
    public bool WorkerEnabled {get;set;}=true;
    public int IntervalSeconds {get;set;}=5;
}
public class SupportWorkflowWorker(SupportWorkflowProcessor processor,IOptions<SupportWorkflowOptions> options,WorkerHeartbeats beats,ILogger<SupportWorkflowWorker> log):BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if(!options.Value.WorkerEnabled)return;
        var interval=Math.Clamp(options.Value.IntervalSeconds,2,60);
        using var timer=new PeriodicTimer(TimeSpan.FromSeconds(interval));
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(20),stoppingToken);
            do
            {
                try{await processor.ProcessAsync(stoppingToken);beats.Beat("Support workflows",interval);}
                catch(Exception ex)when(ex is not OperationCanceledException){log.LogError("Support workflow processing failed ({Kind})",ex.GetType().Name);beats.Beat("Support workflows",interval,ex.GetType().Name);}
            }while(await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch(OperationCanceledException)when(stoppingToken.IsCancellationRequested){}
    }
}