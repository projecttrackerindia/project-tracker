using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Common;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Ai;

namespace ProjectManagement.Api.Controllers.Workspaces;

[Route("api/v1/ai/credits"), RequireWorkspace]
public class AiCreditsController(AiCreditService service, AiCreditBudgetService budgets) : ApiControllerBase
{
    [HttpGet("balance")]
    public async Task<IActionResult> Balance(CancellationToken ct) => Ok(await service.BalanceAsync(ct));
    [HttpGet("budgets")]
    public async Task<IActionResult> Budgets(CancellationToken ct) => Ok(await budgets.ListAsync(ct));
    [HttpPut("budgets")]
    public async Task<IActionResult> SetBudget(SetAiBudgetRequest req, CancellationToken ct) { await budgets.SetAsync(req, ct); return NoContent(); }
}
