using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Work;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Work;

/// <summary>Service-level targets for operational work: everyone with Work management can read them; changing them needs the work types permission.</summary>
[Route("api/v1/work/sla"), RequireWorkspace, RequireModule(Modules.Work)]
public class SlaController(SlaService sla) : ApiControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken ct) => Ok(await sla.GetAsync(ct));

    /// <summary>Replace the default targets (no work type) or one work type's own targets.</summary>
    [HttpPut, RequireModule(Modules.Work, AccessLevel.Edit)]
    public async Task<IActionResult> Save([FromBody] SaveSlaRequest req, CancellationToken ct) => Ok(await sla.SaveAsync(req, ct));

    /// <summary>The work type goes back to the default targets.</summary>
    [HttpDelete("{workTypeId:guid}"), RequireModule(Modules.Work, AccessLevel.Edit)]
    public async Task<IActionResult> Clear(Guid workTypeId, CancellationToken ct) => Ok(await sla.ClearOverrideAsync(workTypeId, ct));
}
