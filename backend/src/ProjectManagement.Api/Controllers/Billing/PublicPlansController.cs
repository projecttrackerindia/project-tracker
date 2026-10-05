using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Application.Features.Billing;

namespace ProjectManagement.Api.Controllers.Billing;

/// <summary>The price list, readable without signing in: the public pricing page shows the live prices from here instead of a copy that could drift.</summary>
[Route("api/v1/public/plans")]
public class PublicPlansController(BillingService billing) : ApiControllerBase
{
    [HttpGet, AllowAnonymous]
    public async Task<IActionResult> List(CancellationToken ct) => Ok(await billing.GetPublicPlansAsync(ct));
}
