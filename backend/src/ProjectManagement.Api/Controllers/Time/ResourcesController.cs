using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Time;
using ProjectManagement.Application.Features.WorkItems;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Time;

/// <summary>Capacity and cost: people's weekly capacity and rates, utilisation, and project budgets.</summary>
[Route("api/v1/resources"), RequireWorkspace]
public class ResourcesController(CapacityService capacity) : ApiControllerBase
{
    /// <summary>Everyone's capacity, cost rate and bill rate (Owners and Admins).</summary>
    [HttpGet("rates")]
    public async Task<IActionResult> Rates(CancellationToken ct) => Ok(await capacity.RatesAsync(ct));

    [HttpPut("rates/{userId:guid}")]
    public async Task<IActionResult> SetRates(Guid userId, [FromBody] SetMemberRateRequest req, CancellationToken ct) => Ok(await capacity.SetMemberAsync(userId, req, ct));

    [HttpPut("currency")]
    public async Task<IActionResult> SetCurrency([FromBody] SetCurrencyRequest req, CancellationToken ct) => Ok(await capacity.SetCurrencyAsync(req, ct));

    /// <summary>Logged and billable time against capacity, per person, for a date range and a group (the same groups as Workload).</summary>
    [HttpGet("utilisation")]
    public async Task<IActionResult> Utilisation([FromQuery] DateOnly? from, [FromQuery] DateOnly? to, [FromQuery] WorkloadScope? scope, CancellationToken ct) =>
        Ok(await capacity.UtilisationAsync(from, to, scope, ct));

    [HttpGet("projects/{projectId:guid}"), RequireModule(Modules.Projects)]
    public async Task<IActionResult> Project(Guid projectId, CancellationToken ct) => Ok(await capacity.ProjectAsync(projectId, ct));

    [HttpPut("projects/{projectId:guid}/budget"), RequireModule(Modules.Projects, AccessLevel.Edit)]
    public async Task<IActionResult> SetBudget(Guid projectId, [FromBody] ProjectBudgetRequest req, CancellationToken ct) => Ok(await capacity.SetProjectBudgetAsync(projectId, req, ct));
}
