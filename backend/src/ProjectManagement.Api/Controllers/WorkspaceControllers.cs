using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Organization;
using ProjectManagement.Application.Features.Teams;
using ProjectManagement.Application.Features.Workspaces;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers;

/// <summary>Workspaces the signed-in user belongs to; switching is validated against membership server-side.</summary>
[Route("api/v1/workspaces")]
public class WorkspacesController(WorkspaceService workspaces) : ApiControllerBase
{
    [HttpGet]
    public async Task<IActionResult> List(CancellationToken ct) => Ok(await workspaces.ListAsync(ct));

    [HttpPost]
    public async Task<IActionResult> CreateOrganization([FromBody] CreateWorkspaceRequest req, CancellationToken ct) =>
        Created(await workspaces.CreateOrganizationAsync(req, ct));

    [HttpPost("{id:guid}/switch")]
    public async Task<IActionResult> Switch(Guid id, CancellationToken ct) => Ok(await workspaces.SwitchAsync(id, ct));
}

/// <summary>The current workspace (resolved from the access token, never from the URL).</summary>
[Route("api/v1/workspace"), RequireWorkspace]
public class CurrentWorkspaceController(WorkspaceService workspaces, ProjectManagement.Application.Features.Organization.OrgSecurityService orgSecurity) : ApiControllerBase
{
    [HttpPut]
    public async Task<IActionResult> Update([FromBody] UpdateWorkspaceRequest req, CancellationToken ct) =>
        Ok(await workspaces.UpdateAsync(req, ct));

    [HttpGet("security")]
    public async Task<IActionResult> Security(CancellationToken ct) => Ok(await orgSecurity.GetAsync(ct));

    [HttpPut("security")]
    public async Task<IActionResult> SetSecurity([FromBody] ProjectManagement.Application.Features.Organization.SetOrgSecurityRequest req, CancellationToken ct) =>
        Ok(await orgSecurity.SetAsync(req, ct));

    // Deliberately not gated by the Members module: this is the shared "who's in the workspace" roster used everywhere
    // people are assigned to things (tasks, projects, teams, timesheets), not just the Members admin page.
    [HttpGet("members")]
    public async Task<IActionResult> Members(CancellationToken ct) => Ok(await workspaces.GetMembersAsync(ct));

    /// <summary>Creates an account and adds it to this organization straight away (the alternative to inviting by email).</summary>
    [HttpPost("members")]
    public async Task<IActionResult> CreateMember([FromBody] CreateMemberRequest req, CancellationToken ct) =>
        Created(await workspaces.CreateMemberAsync(req, ct));

    [HttpPut("members/{userId:guid}")]
    public async Task<IActionResult> UpdateRole(Guid userId, [FromBody] UpdateMemberRoleRequest req, CancellationToken ct) =>
        Ok(await workspaces.UpdateMemberRoleAsync(userId, req, ct));

    [HttpDelete("members/{userId:guid}")]
    public async Task<IActionResult> RemoveMember(Guid userId, CancellationToken ct)
    {
        await workspaces.RemoveMemberAsync(userId, ct);
        return NoContent();
    }

    [HttpGet("invitations"), RequireModule(Modules.Members)]
    public async Task<IActionResult> Invitations(CancellationToken ct) => Ok(await workspaces.GetInvitationsAsync(ct));

    [HttpPost("invitations")]
    public async Task<IActionResult> Invite([FromBody] InviteRequest req, CancellationToken ct) =>
        Created(await workspaces.InviteAsync(req, ct));

    [HttpDelete("invitations/{id:guid}")]
    public async Task<IActionResult> RevokeInvitation(Guid id, CancellationToken ct)
    {
        await workspaces.RevokeInvitationAsync(id, ct);
        return NoContent();
    }

    [HttpGet("permissions")]
    public async Task<IActionResult> Permissions(CancellationToken ct) => Ok(await workspaces.GetPermissionMatrixAsync(ct));

    [HttpPut("permissions")]
    public async Task<IActionResult> SetPermission([FromBody] SetPermissionRequest req, CancellationToken ct)
    {
        await workspaces.SetPermissionAsync(req, ct);
        return Ok(await workspaces.GetPermissionMatrixAsync(ct));
    }
}

[Route("api/v1/invitations")]
public class InvitationsController(WorkspaceService workspaces) : ApiControllerBase
{
    /// <summary>Lets the invitation page show workspace name and invited email before sign-in.</summary>
    [HttpGet("lookup"), AllowAnonymous]
    public async Task<IActionResult> Lookup([FromQuery] string token, CancellationToken ct) =>
        Ok(await workspaces.LookupInvitationAsync(token, ct));

    [HttpPost("accept")]
    public async Task<IActionResult> Accept([FromBody] AcceptInvitationRequest req, CancellationToken ct) =>
        Ok(await workspaces.AcceptInvitationAsync(req, ct));
}

[Route("api/v1/teams"), RequireWorkspace, RequireModule(Modules.Teams)]
public class TeamsController(TeamService teams) : ApiControllerBase
{
    [HttpGet]
    public async Task<IActionResult> List(CancellationToken ct) => Ok(await teams.ListAsync(ct));

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] UpsertTeamRequest req, CancellationToken ct) => Created(await teams.CreateAsync(req, ct));

    [HttpGet("{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct) => Ok(await teams.GetAsync(id, ct));

    [HttpPut("{id:guid}")]
    public async Task<IActionResult> Update(Guid id, [FromBody] UpsertTeamRequest req, CancellationToken ct) => Ok(await teams.UpdateAsync(id, req, ct));

    [HttpDelete("{id:guid}")]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
    {
        await teams.DeleteAsync(id, ct);
        return NoContent();
    }

    [HttpPost("{id:guid}/members")]
    public async Task<IActionResult> AddMember(Guid id, [FromBody] AddTeamMemberRequest req, CancellationToken ct) =>
        Ok(await teams.AddMemberAsync(id, req, ct));

    [HttpDelete("{id:guid}/members/{userId:guid}")]
    public async Task<IActionResult> RemoveMember(Guid id, Guid userId, CancellationToken ct) =>
        Ok(await teams.RemoveMemberAsync(id, userId, ct));
}

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
