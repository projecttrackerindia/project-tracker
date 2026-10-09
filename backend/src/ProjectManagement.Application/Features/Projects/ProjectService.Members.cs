using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Tasks;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Projects;

public partial class ProjectService
{
    // ---------------------------------------------------------------- members

    public async Task<IReadOnlyList<ProjectMemberDto>> GetMembersAsync(Guid projectId, CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        var rows = await (from pm in db.ProjectMembers
                          join u in db.Users on pm.UserId equals u.Id
                          join tm in db.TenantMembers on new { pm.UserId, TenantId = pm.TenantId } equals new { tm.UserId, tm.TenantId }
                          where pm.ProjectId == projectId && tm.TenantId == tid
                          orderby u.DisplayName
                          select new { u.Id, u.DisplayName, u.Email, tm.Role }).AsNoTracking().ToListAsync(ct);
        var hideEmail = ctx.Role == TenantRole.Guest;
        return rows.Select(r => new ProjectMemberDto(r.Id, r.DisplayName, hideEmail ? "" : r.Email, r.Role)).ToList();
    }

    public async Task<IReadOnlyList<ProjectMemberDto>> AddMemberAsync(Guid projectId, AddProjectMemberRequest req, CancellationToken ct = default)
    {
        var project = await access.GetProjectAsync(projectId, ct);
        await access.RequireProjectEditAsync(project, ct);
        await access.EnsureTenantMemberAsync(req.UserId, "userId", ct);
        if (!await db.ProjectMembers.AnyAsync(m => m.ProjectId == projectId && m.UserId == req.UserId, ct))
        {
            db.ProjectMembers.Add(new ProjectMember { TenantId = project.TenantId, ProjectId = projectId, UserId = req.UserId, CreatedAt = clock.Now });
            var name = await db.Users.Where(u => u.Id == req.UserId).Select(u => u.DisplayName).FirstAsync(ct);
            recorder.Activity("project.member_added", "Project", projectId, $"Added {name} to \"{project.Name}\"", projectId);
            await db.SaveChangesAsync(ct);
        }
        return await GetMembersAsync(projectId, ct);
    }

    public async Task RemoveMemberAsync(Guid projectId, Guid userId, CancellationToken ct = default)
    {
        var project = await access.GetProjectAsync(projectId, ct);
        await access.RequireProjectEditAsync(project, ct);
        if (userId == project.OwnerId) throw new ConflictException("The project owner cannot be removed from the project.", "OWNER_REQUIRED");
        var row = await db.ProjectMembers.FirstOrDefaultAsync(m => m.ProjectId == projectId && m.UserId == userId, ct)
            ?? throw new NotFoundException("Member not found.");
        db.ProjectMembers.Remove(row);
        await db.SaveChangesAsync(ct);
    }
}
