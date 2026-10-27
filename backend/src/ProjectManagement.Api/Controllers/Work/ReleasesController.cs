using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Quality;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Work;

/// <summary>
/// Releases: the work going out together, the test runs that check it, and the go/no-go. Behind the Work module like Quality: reading
/// needs View, every change needs Edit. See <see cref="ReleaseService"/>.
/// </summary>
[Route("api/v1/releases"), RequireWorkspace, RequireModule(Modules.Work)]
public class ReleasesController(ReleaseService releases) : ApiControllerBase
{
    [HttpGet]
    public async Task<IActionResult> List([FromQuery] Guid? projectId, CancellationToken ct) => Ok(await releases.ListAsync(projectId, ct));

    [HttpPost, RequireModule(Modules.Work, AccessLevel.Edit)]
    public async Task<IActionResult> Create([FromBody] UpsertReleaseRequest req, CancellationToken ct) => Created(await releases.CreateAsync(req, ct));

    [HttpPut("{id:guid}"), RequireModule(Modules.Work, AccessLevel.Edit)]
    public async Task<IActionResult> Update(Guid id, [FromBody] UpsertReleaseRequest req, CancellationToken ct) => Ok(await releases.UpdateAsync(id, req, ct));

    /// <summary>The release with its items, runs, the checks and the decision.</summary>
    [HttpGet("{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct) => Ok(await releases.GoNoGoAsync(id, ct));

    [HttpPut("{id:guid}/items"), RequireModule(Modules.Work, AccessLevel.Edit)]
    public async Task<IActionResult> Items(Guid id, [FromBody] ReleaseItemsRequest req, CancellationToken ct) => Ok(await releases.SetItemsAsync(id, req, ct));

    [HttpPut("{id:guid}/runs/{runId:guid}"), RequireModule(Modules.Work, AccessLevel.Edit)]
    public async Task<IActionResult> AttachRun(Guid id, Guid runId, CancellationToken ct) => Ok(await releases.SetRunAsync(id, runId, true, ct));

    [HttpDelete("{id:guid}/runs/{runId:guid}"), RequireModule(Modules.Work, AccessLevel.Edit)]
    public async Task<IActionResult> DetachRun(Guid id, Guid runId, CancellationToken ct) => Ok(await releases.SetRunAsync(id, runId, false, ct));

    /// <summary>Who signs off and in which role (the whole list).</summary>
    [HttpPut("{id:guid}/signoffs"), RequireModule(Modules.Work, AccessLevel.Edit)]
    public async Task<IActionResult> SignOffs(Guid id, [FromBody] SetSignOffsRequest req, CancellationToken ct) => Ok(await releases.SetSignOffsAsync(id, req, ct));

    /// <summary>The caller signs or declines (with a note) their own sign-off.</summary>
    [HttpPost("{id:guid}/signoffs/sign")]
    public async Task<IActionResult> Sign(Guid id, [FromBody] SignRequest req, CancellationToken ct) => Ok(await releases.SignAsync(id, req, ct));

    [HttpPost("{id:guid}/signoffs/remind"), RequireModule(Modules.Work, AccessLevel.Edit)]
    public async Task<IActionResult> Remind(Guid id, CancellationToken ct) => Ok(await releases.RemindAsync(id, ct));

    public record ApproveRequest(string? Reason);

    [HttpPost("{id:guid}/approve"), RequireModule(Modules.Work, AccessLevel.Edit)]
    public async Task<IActionResult> Approve(Guid id, [FromBody] ApproveRequest? req, CancellationToken ct) => Ok(await releases.ApproveAsync(id, req?.Reason, ct));

    [HttpPost("{id:guid}/ship"), RequireModule(Modules.Work, AccessLevel.Edit)]
    public async Task<IActionResult> Ship(Guid id, CancellationToken ct) => Ok(await releases.ShipAsync(id, ct));
}
