using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.RateLimiting;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Auth;

namespace ProjectManagement.Api.Controllers.Auth;

/// <summary>What a sign-in that must wait for approval answers: the request to watch and what to show. The secret goes in an HttpOnly cookie (and in the body only for API clients).</summary>
public record SessionApprovalResponse(bool ApprovalRequired, Guid ApprovalId, int Code, string Device, string App, string? Location, string? IpAddress, DateTime ExpiresAt, string? Secret);

/// <summary>On a sign-in endpoint: "Single active session" turns the sign-in into a request waiting on the signed-in device (see SessionApprovalGate).</summary>
[AttributeUsage(AttributeTargets.Method)]
public sealed class SessionApprovalResultAttribute : ExceptionFilterAttribute
{
    public override void OnException(ExceptionContext context)
    {
        if (context.Exception is not SessionApprovalRequired wait) return;
        var http = context.HttpContext;
        var s = wait.Start;
        AuthCookies.WriteApproval(http.Response, AuthCookies.IsSecure(http.Request), s.Secret);
        var body = http.Request.Headers["X-Token-Delivery"] == "body";
        context.Result = new OkObjectResult(new SessionApprovalResponse(true, s.ApprovalId, s.Code, s.Device, s.App, s.Location, s.IpAddress, s.ExpiresAt, body ? s.Secret : null));
        context.ExceptionHandled = true;
    }
}

/// <summary>
/// "Single active session": the new device watches its request (and may fall back to an emailed link or an authenticator code after the timeout);
/// a signed-in device answers it. The new device is identified only by the secret it was given; a device never answers its own request.
/// </summary>
[Route("api/v1/auth/session-approval")]
public class SessionApprovalController(SessionApprovalService approvals) : ApiControllerBase
{
    private string? Secret(string? fromBody) => string.IsNullOrWhiteSpace(fromBody) ? Request.Cookies[AuthCookies.Approval] : fromBody;
    private bool Https => AuthCookies.IsSecure(Request);

    /// <summary>Polled every couple of seconds by the waiting device. An approval is redeemed here, once, and opens the session like any sign-in.</summary>
    [HttpPost("{id:guid}/status"), AllowAnonymous]
    public async Task<IActionResult> Status(Guid id, [FromBody(EmptyBodyBehavior = Microsoft.AspNetCore.Mvc.ModelBinding.EmptyBodyBehavior.Allow)] SessionApprovalSecretRequest? req, CancellationToken ct)
    {
        var r = await approvals.StatusAsync(id, Secret(req?.Secret), ct);
        if (r.Status.Status is "closed" or "rejected") AuthCookies.ClearApproval(Response, Https);
        if (r.Session is not { } s) return Ok(r.Status);
        AuthCookies.ClearApproval(Response, Https);
        AuthCookies.WriteRefresh(Response, Https, s);
        var body = Request.Headers["X-Token-Delivery"] == "body";
        return Ok(new { r.Status.Status, r.Status.Code, r.Status.Device, auth = new AuthResponse(s.AccessToken, s.ExpiresAt, s.User, body ? s.RefreshToken : null) });
    }

    /// <summary>After the timeout: email a one-time approval link to the account's verified address.</summary>
    [HttpPost("{id:guid}/email"), AllowAnonymous, EnableRateLimiting("auth")]
    public async Task<IActionResult> Email(Guid id, [FromBody(EmptyBodyBehavior = Microsoft.AspNetCore.Mvc.ModelBinding.EmptyBodyBehavior.Allow)] SessionApprovalSecretRequest? req, CancellationToken ct) =>
        Ok(await approvals.SendEmailAsync(id, Secret(req?.Secret), ct));

    /// <summary>After the timeout: an authenticator or recovery code approves it.</summary>
    [HttpPost("{id:guid}/code"), AllowAnonymous, EnableRateLimiting("auth")]
    public async Task<IActionResult> Code(Guid id, [FromBody] SessionApprovalCodeRequest req, CancellationToken ct) =>
        Ok(await approvals.ApproveWithCodeAsync(id, req with { Secret = Secret(req.Secret) }, ct));

    /// <summary>The emailed link's page: what it would approve (opening it changes nothing).</summary>
    [HttpPost("email/preview"), AllowAnonymous, EnableRateLimiting("auth")]
    public async Task<IActionResult> EmailPreview([FromBody] SessionApprovalEmailRequest req, CancellationToken ct) => Ok(await approvals.PreviewEmailAsync(req, ct));

    [HttpPost("email/confirm"), AllowAnonymous, EnableRateLimiting("auth")]
    public async Task<IActionResult> EmailConfirm([FromBody] SessionApprovalEmailRequest req, CancellationToken ct) => Ok(await approvals.ConfirmEmailAsync(req, ct));

    /// <summary>
    /// A signed-in device answers: allow, reject or not-me. Here (under /auth) so the browser that holds the request's own secret is recognised and
    /// refused: a new device cannot approve itself.
    /// </summary>
    [HttpPost("{id:guid}/decide"), EnableRateLimiting("sensitive")]
    public async Task<IActionResult> Decide(Guid id, [FromBody] SessionApprovalDecideRequest req, CancellationToken ct)
    {
        var requesterHere = await approvals.IsRequesterAsync(id, Request.Cookies[AuthCookies.Approval], ct);
        return Ok(new { outcome = await approvals.DecideAsync(id, req, requesterHere, ct) });
    }
}

/// <summary>My side of "Single active session": requests waiting for me, the history, and my own setting.</summary>
[Route("api/v1/me")]
public class MySessionApprovalsController(SessionApprovalService approvals) : ApiControllerBase
{
    [HttpGet("session-approvals/pending")]
    public async Task<IActionResult> Pending(CancellationToken ct) => Ok(await approvals.PendingAsync(ct));

    [HttpGet("session-approvals")]
    public async Task<IActionResult> History(CancellationToken ct) => Ok(await approvals.HistoryAsync(ct));

    [HttpGet("session-policy")]
    public async Task<IActionResult> Policy(CancellationToken ct) => Ok(await approvals.PolicyAsync(ct));

    [HttpPut("session-policy")]
    public async Task<IActionResult> SetPolicy([FromBody] SetSessionPolicyRequest req, CancellationToken ct) => Ok(await approvals.SetPolicyAsync(req, ct));
}

/// <summary>The organization's rule: every member must allow a new device from the one already signed in (owners and admins change it).</summary>
[Route("api/v1/workspace/session-policy"), RequireWorkspace]
public class WorkspaceSessionPolicyController(SessionApprovalService approvals) : ApiControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken ct) => Ok(await approvals.WorkspacePolicyAsync(ct));

    [HttpPut]
    public async Task<IActionResult> Set([FromBody] SetWorkspaceSessionPolicyRequest req, CancellationToken ct) => Ok(await approvals.SetWorkspacePolicyAsync(req, ct));
}
