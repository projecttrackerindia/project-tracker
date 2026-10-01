using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Admin;
using ProjectManagement.Application.Features.Billing;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Infrastructure.Services;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Billing;

[Route("api/v1/billing"), RequireWorkspace, RequireModule(Modules.Billing)]
public class BillingController(BillingService billing) : ApiControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Overview(CancellationToken ct) => Ok(await billing.GetOverviewAsync(ct));

    [HttpPost("checkout")]
    public async Task<IActionResult> Checkout([FromBody] CheckoutRequest req, CancellationToken ct) => Ok(await billing.CheckoutAsync(req, ct));

    [HttpPost("cancel")]
    public async Task<IActionResult> Cancel(CancellationToken ct) => Ok(await billing.CancelAsync(ct));

    [HttpPost("resume")]
    public async Task<IActionResult> Resume(CancellationToken ct) => Ok(await billing.ResumeAsync(ct));
}
