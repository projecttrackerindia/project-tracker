using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Auth;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Workspaces;

namespace ProjectManagement.Api.Controllers.Auth;

/// <summary>The current Terms of Service / Privacy Policy, and accepting them. The public GET is read by the sign-up page.</summary>
[Route("api/v1/consent")]
public class ConsentController(ProjectManagement.Application.Features.Consent.ConsentService consent) : ApiControllerBase
{
    [HttpGet("documents"), AllowAnonymous]
    public async Task<IActionResult> Documents(CancellationToken ct) => Ok(await consent.GetCurrentAsync(ct));

    [HttpGet("status")]
    public async Task<IActionResult> Status(CancellationToken ct) => Ok(await consent.GetMyStatusAsync(ct));

    [HttpPost("accept")]
    public async Task<IActionResult> Accept([FromBody] ProjectManagement.Application.Features.Consent.AcceptConsentRequest req, CancellationToken ct) => Ok(await consent.AcceptAsync(req, ct));
}
