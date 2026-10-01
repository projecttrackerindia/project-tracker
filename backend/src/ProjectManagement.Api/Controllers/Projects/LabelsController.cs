using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Insights;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.Tasks;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Projects;

[Route("api/v1/labels"), RequireWorkspace]
public class LabelsController(ProjectService projects) : ApiControllerBase
{
    [HttpGet]
    public async Task<IActionResult> List(CancellationToken ct) => Ok(await projects.GetLabelsAsync(ct));

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] UpsertLabelRequest req, CancellationToken ct) => Created(await projects.CreateLabelAsync(req, ct));

    [HttpPut("{id:guid}")]
    public async Task<IActionResult> Update(Guid id, [FromBody] UpsertLabelRequest req, CancellationToken ct) => Ok(await projects.UpdateLabelAsync(id, req, ct));

    [HttpDelete("{id:guid}")]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
    {
        await projects.DeleteLabelAsync(id, ct);
        return NoContent();
    }
}
