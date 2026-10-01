using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Organization;
using ProjectManagement.Application.Features.Teams;
using ProjectManagement.Application.Features.Workspaces;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Organization;

/// <summary>The organization chart: job roles, who holds which role and who reports to whom.</summary>
[Route("api/v1/org"), RequireWorkspace, RequireModule(Modules.Organization)]
public class OrgController(OrgService org, AccessService access) : ApiControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Structure(CancellationToken ct) => Ok(await org.GetAsync(ct));

    [HttpPost("roles")]
    public async Task<IActionResult> CreateRole([FromBody] CreateOrgRoleRequest req, CancellationToken ct) => Created(await org.CreateRoleAsync(req, ct));

    [HttpPut("roles/{id:guid}")]
    public async Task<IActionResult> UpdateRole(Guid id, [FromBody] UpdateOrgRoleRequest req, CancellationToken ct)
    {
        await org.UpdateRoleAsync(id, req, ct);
        return Ok(await org.GetAsync(ct));
    }

    [HttpPatch("roles/{id:guid}/parent")]
    public async Task<IActionResult> MoveRole(Guid id, [FromBody] MoveOrgRoleRequest req, CancellationToken ct)
    {
        await org.MoveRoleAsync(id, req, ct);
        return Ok(await org.GetAsync(ct));
    }

    [HttpPut("layout")]
    public async Task<IActionResult> SaveLayout([FromBody] OrgLayoutRequest req, CancellationToken ct)
    {
        await org.SaveLayoutAsync(req, ct);
        return NoContent();
    }

    /// <summary>Soft delete. People and sub-roles move to <c>moveTo</c> (default: the role's parent).</summary>
    [HttpDelete("roles/{id:guid}")]
    public async Task<IActionResult> DeleteRole(Guid id, [FromQuery] Guid? moveTo, CancellationToken ct)
    {
        var (people, roles) = await org.DeleteRoleAsync(id, moveTo, ct);
        return Ok(new { movedPeople = people, movedRoles = roles });
    }

    [HttpPost("roles/{id:guid}/restore")]
    public async Task<IActionResult> RestoreRole(Guid id, CancellationToken ct) => Ok(await org.RestoreRoleAsync(id, ct));

    [HttpPut("members/{userId:guid}/role")]
    public async Task<IActionResult> AssignRole(Guid userId, [FromBody] AssignOrgRoleRequest req, CancellationToken ct)
    {
        await org.AssignRoleAsync(userId, req, ct);
        return NoContent();
    }

    [HttpPut("members/{userId:guid}/reports-to")]
    public async Task<IActionResult> SetReportsTo(Guid userId, [FromBody] SetReportsToRequest req, CancellationToken ct)
    {
        await org.SetReportsToAsync(userId, req, ct);
        return NoContent();
    }

    /// <summary>What each job role can see and do (needs the "manage job-role access" permission).</summary>
    [HttpGet("access")]
    public async Task<IActionResult> Access(CancellationToken ct) => Ok(await access.GetAsync(ct));

    [HttpPut("roles/{id:guid}/access")]
    public async Task<IActionResult> SetAccess(Guid id, [FromBody] SetAccessRequest req, CancellationToken ct)
    {
        await access.SetAsync(id, req, ct);
        return Ok(await access.GetAsync(ct));
    }

    /// <summary>Everyone's effective access and which rule decided it (job role, or access-level defaults).</summary>
    [HttpGet("access/effective")]
    public async Task<IActionResult> EffectiveAccess(CancellationToken ct) => Ok(await access.EffectiveAsync(ct));

    /// <summary>Remove a role's own profile: its people fall back to their access level's defaults.</summary>
    [HttpDelete("roles/{id:guid}/access")]
    public async Task<IActionResult> ResetAccess(Guid id, CancellationToken ct)
    {
        await access.ResetAsync(id, ct);
        return Ok(await access.GetAsync(ct));
    }

    [HttpPost("template")]
    public async Task<IActionResult> ApplyTemplate([FromBody] ApplyOrgTemplateRequest req, CancellationToken ct) =>
        Ok(new { created = await org.ApplyTemplateAsync(req, ct) });
}
