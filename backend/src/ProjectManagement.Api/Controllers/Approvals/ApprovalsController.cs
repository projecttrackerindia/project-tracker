using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Approvals;

namespace ProjectManagement.Api.Controllers.Approvals;

/// <summary>
/// Approvals: requests that walk a chain of approvers (see <see cref="ApprovalService"/>). The workspace's default chain per type is under
/// <c>policies</c> (Settings › Approvals).
/// </summary>
[Route("api/v1/approvals"), RequireWorkspace]
public class ApprovalsController(ApprovalService approvals) : ApiControllerBase
{
    /// <param name="view">needs (waiting on me, the default), mine, all or history.</param>
    [HttpGet]
    public async Task<IActionResult> List([FromQuery] string? view, [FromQuery] string? type, CancellationToken ct) => Ok(await approvals.ListAsync(view, type, ct));

    /// <summary>The Approvals tab's number: requests waiting on the caller.</summary>
    [HttpGet("counts")]
    public async Task<IActionResult> Counts(CancellationToken ct) => Ok(new { needsMe = await approvals.NeedsMeCountAsync(ct) });

    /// <summary>The chain a new request of this type would get (the request sheet's "suggested chain").</summary>
    [HttpGet("chain")]
    public async Task<IActionResult> Chain([FromQuery] string type, CancellationToken ct) => Ok(await approvals.PreviewAsync(type, ct));

    [HttpGet("policies")]
    public async Task<IActionResult> Policies(CancellationToken ct) => Ok(await approvals.PoliciesAsync(ct));

    [HttpPut("policies/{type}")]
    public async Task<IActionResult> SavePolicy(string type, [FromBody] SaveApprovalPolicyRequest req, CancellationToken ct) => Ok(await approvals.SavePolicyAsync(type, req, ct));

    [HttpGet("{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct) => Ok(await approvals.GetAsync(id, ct));

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] CreateApprovalRequest req, CancellationToken ct) => Created(await approvals.CreateAsync(req, ct));

    /// <summary>approve, reject, comment, withdraw or remind.</summary>
    [HttpPost("{id:guid}/decide")]
    public async Task<IActionResult> Decide(Guid id, [FromBody] DecideApprovalRequest req, CancellationToken ct) => Ok(await approvals.DecideAsync(id, req, ct));
}
