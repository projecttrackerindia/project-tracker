using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Common;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Calls;

namespace ProjectManagement.Api.Controllers.Workspaces;

/// <summary>Our own video calls: start one (in a project, a chat or on its own), join with a short-lived pass, end it for everyone.</summary>
[Route("api/v1/calls"), RequireWorkspace]
public sealed class CallsController(CallService calls) : ApiControllerBase
{
    [HttpGet("status")]
    public IActionResult Status() => Ok(calls.Status());

    [HttpGet("live")]
    public async Task<IActionResult> Live(CancellationToken ct) => Ok(await calls.LiveAsync(ct));

    [HttpPost]
    public async Task<IActionResult> Start([FromBody] StartCallRequest req, CancellationToken ct) => Created(await calls.StartAsync(req, ct));

    [HttpGet("{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct) => Ok(await calls.GetAsync(id, ct));

    [HttpPost("{id:guid}/join")]
    public async Task<IActionResult> Join(Guid id, CancellationToken ct) => Ok(await calls.JoinAsync(id, ct));

    [HttpPost("{id:guid}/end")]
    public async Task<IActionResult> End(Guid id, CancellationToken ct) => Ok(await calls.EndAsync(id, ct));
}
