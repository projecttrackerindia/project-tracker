using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Admin;
using ProjectManagement.Application.Features.Billing;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Infrastructure.Services;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Admin;

/// <summary>What every visitor may know about the platform right now (announcement, maintenance).</summary>
[Route("api/v1/platform"), AllowAnonymous]
public class PlatformStatusController(ProjectManagement.Application.Features.Admin.PlatformService platform) : ApiControllerBase
{
    [HttpGet("status")]
    public async Task<IActionResult> Status(CancellationToken ct) => Ok(await platform.StatusAsync(ct));
}
