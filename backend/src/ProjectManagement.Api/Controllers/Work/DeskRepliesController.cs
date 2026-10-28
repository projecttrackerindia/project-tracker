using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Support;
using ProjectManagement.Application.Features.Work;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Work;

/// <summary>The Desk's reply box: saved replies the ticket fills in, and replies that go to the customer on the ticket's channel.</summary>
[Route("api/v1"), RequireWorkspace, RequireModule(Modules.Work)]
public class DeskRepliesController(WorkTaskService work, DeskReplies replies) : ApiControllerBase
{
    [HttpGet("desk/reply-templates")]
    public async Task<IActionResult> Templates(CancellationToken ct) => Ok(await replies.TemplatesAsync(ct));

    [HttpPost("work-tasks/{id:guid}/fill-reply")]
    public async Task<IActionResult> Fill(Guid id, [FromBody] DeskFillRequest req, CancellationToken ct) => Ok(await work.FillReplyAsync(id, req, replies, ct));

    [HttpPost("work-tasks/{id:guid}/tell-customer"), RequireModule(Modules.Work, AccessLevel.Edit)]
    public async Task<IActionResult> Tell(Guid id, [FromBody] TicketTellRequest req, CancellationToken ct) => Ok(await work.TellCustomerAsync(id, req, ct));
}
