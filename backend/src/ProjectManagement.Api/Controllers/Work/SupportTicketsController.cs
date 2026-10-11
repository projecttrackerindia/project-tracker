using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Common;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Support;
namespace ProjectManagement.Api.Controllers.Work;
[Route("api/v1/support/tickets"),RequireWorkspace]
public class SupportTicketsController(SupportService service):ApiControllerBase
{
    [HttpGet]public async Task<IActionResult> List(string? state,string? query,int page=1,CancellationToken ct=default)=>Ok(await service.ListAsync(state,query,page,ct));
    [HttpGet("summary")]public async Task<IActionResult> Summary(CancellationToken ct)=>Ok(await service.SummaryAsync(ct));
    [HttpGet("{id:guid}")]public async Task<IActionResult> Get(Guid id,CancellationToken ct)=>Ok(await service.GetAsync(id,ct));
    [HttpGet("{id:guid}/messages")]public async Task<IActionResult> Messages(Guid id,int version,int offset=0,CancellationToken ct=default)=>Ok(await service.MessagesAsync(id,version,offset,ct));
    [HttpPost]public async Task<IActionResult> Create(CreateSupportTicketRequest req,CancellationToken ct)=>Ok(await service.CreateAsync(req,ct));
    [HttpPut("{id:guid}/metadata")]public async Task<IActionResult> Metadata(Guid id,SupportMetadataRequest req,CancellationToken ct)=>Ok(await service.MetadataAsync(id,req,ct));
    [HttpPost("{id:guid}/messages")]public async Task<IActionResult> Message(Guid id,SupportInteractionRequest req,CancellationToken ct)=>Ok(await service.MessageAsync(id,req,ct));
    [HttpPost("{id:guid}/state")]public async Task<IActionResult> State(Guid id,SupportStateRequest req,CancellationToken ct)=>Ok(await service.StateAsync(id,req,ct));
}
