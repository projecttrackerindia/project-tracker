using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Organization;
using ProjectManagement.Application.Features.Teams;
using ProjectManagement.Application.Features.Workspaces;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Workspaces;

/// <summary>The current workspace (resolved from the access token, never from the URL).</summary>
[Route("api/v1/workspace"), RequireWorkspace]
public class CurrentWorkspaceController(WorkspaceService workspaces, ProjectManagement.Application.Features.Organization.OrgSecurityService orgSecurity, WorkspaceLogoService logo,
    ProjectManagement.Application.Features.People.MemberProfileService profiles, ProjectManagement.Application.Features.People.UserAvatarService avatars) : ApiControllerBase
{
    /// <summary>The logo printed on document PDFs.</summary>
    [HttpGet("logo")]
    public async Task<IActionResult> Logo(CancellationToken ct) => Ok(await logo.GetAsync(ct));

    [HttpGet("logo/file")]
    public async Task<IActionResult> LogoFile(CancellationToken ct)
    {
        var f = await logo.OpenAsync(ct);
        return f is null ? NotFound() : File(f.Value.Bytes, f.Value.ContentType);
    }

    [HttpPost("logo"), RequestSizeLimit(2_000_000)]
    public async Task<IActionResult> SetLogo(IFormFile file, CancellationToken ct)
    {
        await using var stream = file.OpenReadStream();
        return Ok(await logo.SetAsync(stream, file.Length, ct));
    }

    [HttpDelete("logo")]
    public async Task<IActionResult> RemoveLogo(CancellationToken ct) => Ok(await logo.RemoveAsync(ct));

    [HttpPut]
    public async Task<IActionResult> Update([FromBody] UpdateWorkspaceRequest req, CancellationToken ct) =>
        Ok(await workspaces.UpdateAsync(req, ct));

    [HttpGet("security")]
    public async Task<IActionResult> Security(CancellationToken ct) => Ok(await orgSecurity.GetAsync(ct));

    [HttpPut("security")]
    public async Task<IActionResult> SetSecurity([FromBody] ProjectManagement.Application.Features.Organization.SetOrgSecurityRequest req, CancellationToken ct) =>
        Ok(await orgSecurity.SetAsync(req, ct));

    [HttpGet("project-visibility")]
    public async Task<IActionResult> ProjectVisibility(CancellationToken ct) => Ok(await orgSecurity.GetVisibilityAsync(ct));

    [HttpPut("project-visibility")]
    public async Task<IActionResult> SetProjectVisibility([FromBody] ProjectManagement.Application.Features.Organization.SetProjectVisibilityRequest req, CancellationToken ct) =>
        Ok(await orgSecurity.SetVisibilityAsync(req, ct));

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

    /// <summary>A member's profile card: role, job role, team(s), who they report to, and how their work is going.</summary>
    [HttpGet("members/{userId:guid}/profile")]
    public async Task<IActionResult> MemberProfile(Guid userId, CancellationToken ct) => Ok(await profiles.GetAsync(userId, ct));

    /// <summary>A member's own profile photo, for anyone who shares this workspace with them.</summary>
    [HttpGet("members/{userId:guid}/avatar")]
    public async Task<IActionResult> MemberAvatar(Guid userId, CancellationToken ct)
    {
        var f = await avatars.OpenForMemberAsync(userId, ct);
        return f is null ? NotFound() : File(f.Value.Bytes, f.Value.ContentType);
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
