using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Platform;

namespace ProjectManagement.Api.Controllers.Platform;

/// <summary>Saved views of My Work, Work lists, the Desk queue and the Portfolio (scope = mywork, work, desk, portfolio). See <see cref="SavedViewService"/>.</summary>
[Route("api/v1/saved-views"), RequireWorkspace]
public class SavedViewsController(SavedViewService views) : ApiControllerBase
{
    [HttpGet]
    public async Task<IActionResult> List([FromQuery] string scope, CancellationToken ct) => Ok(await views.ListAsync(scope, ct));

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] SaveViewRequest req, CancellationToken ct) => Created(await views.CreateAsync(req, ct));

    [HttpPut("{id:guid}")]
    public async Task<IActionResult> Update(Guid id, [FromBody] SaveViewRequest req, CancellationToken ct) => Ok(await views.UpdateAsync(id, req, ct));

    [HttpDelete("{id:guid}")]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
    {
        await views.DeleteAsync(id, ct);
        return NoContent();
    }
}
