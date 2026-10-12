using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.SupportWorkflows;
namespace ProjectManagement.Api.Controllers.Work;
[RequireWorkspace,Route("api/v1/support/workflows")]
public class SupportWorkflowsController(SupportWorkflowService service):ApiControllerBase
{
    [HttpGet]public async Task<IActionResult> List(CancellationToken ct)=>Ok(await service.ListAsync(ct));
    [HttpPost]public async Task<IActionResult> Create(SaveSupportWorkflowRequest req,CancellationToken ct)=>Ok(await service.SaveAsync(null,req,ct));
    [HttpPut("{id:guid}")]public async Task<IActionResult> Save(Guid id,SaveSupportWorkflowRequest req,CancellationToken ct)=>Ok(await service.SaveAsync(id,req,ct));
    [HttpPost("{id:guid}/publish")]public async Task<IActionResult> Publish(Guid id,PublishSupportWorkflowRequest req,CancellationToken ct)=>Ok(await service.PublishAsync(id,req,ct));
    [HttpPost("{id:guid}/disable")]public async Task<IActionResult> Disable(Guid id,int version,CancellationToken ct){await service.DisableAsync(id,version,ct);return NoContent();}
    [HttpPost("{id:guid}/runs")]public async Task<IActionResult> Run(Guid id,RunSupportWorkflowRequest req,CancellationToken ct)=>Ok(await service.RunAsync(id,req,ct));
    [HttpGet("runs")]public async Task<IActionResult> Runs(Guid ticketId,CancellationToken ct)=>Ok(await service.RunsAsync(ticketId,ct));
    [HttpGet("runs/{id:guid}")]public async Task<IActionResult> GetRun(Guid id,CancellationToken ct)=>Ok(await service.GetRunAsync(id,ct));
    [HttpPost("runs/{id:guid}/decide")]public async Task<IActionResult> Decide(Guid id,DecideSupportWorkflowRequest req,CancellationToken ct)=>Ok(await service.DecideAsync(id,req,ct));
    [HttpPost("runs/{id:guid}/cancel")]public async Task<IActionResult> Cancel(Guid id,int version,CancellationToken ct){await service.CancelAsync(id,version,ct);return NoContent();}
    [HttpPost("{id:guid}/schedules")]public async Task<IActionResult> Schedule(Guid id,Guid ticketId,int intervalMinutes,CancellationToken ct)=>Ok(await service.ScheduleAsync(id,ticketId,intervalMinutes,ct));
    [HttpGet("schedules")]public async Task<IActionResult> Schedules(Guid ticketId,CancellationToken ct)=>Ok(await service.SchedulesAsync(ticketId,ct));
    [HttpDelete("schedules/{id:guid}")]public async Task<IActionResult> RemoveSchedule(Guid id,CancellationToken ct){await service.RemoveScheduleAsync(id,ct);return NoContent();}
    [HttpPost("runs/{id:guid}/retry")]public async Task<IActionResult> Retry(Guid id,int version,CancellationToken ct){await service.RetryAsync(id,version,ct);return NoContent();}
}