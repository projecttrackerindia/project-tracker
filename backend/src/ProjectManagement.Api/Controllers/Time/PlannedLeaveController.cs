using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Time;

namespace ProjectManagement.Api.Controllers.Time;

[Route("api/v1/time/leave"), RequireWorkspace]
public class PlannedLeaveController(PlannedLeaveService leave) : ApiControllerBase
{
    [HttpGet]
    public async Task<IActionResult> List([FromQuery] DateOnly from, [FromQuery] DateOnly to, [FromQuery] Guid? userId, CancellationToken ct)
        => Ok(await leave.ListAsync(userId, from, to, ct));
    [HttpPost]
    public async Task<IActionResult> Create([FromBody] PlanLeaveRequest req, CancellationToken ct) => Created(await leave.CreateAsync(req, ct));
    [HttpDelete("{id:guid}")]
    public async Task<IActionResult> Cancel(Guid id, CancellationToken ct) { await leave.CancelAsync(id, ct); return NoContent(); }
}
