using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Teams;

public record TeamDto(Guid Id, string Name, string? Description, int MemberCount, int ProjectCount, UserRefDto? Lead, Guid? ParentTeamId = null);
public record TeamMemberDto(Guid UserId, string Name, string Email, bool IsLead, int OpenTasks);
public record TeamDetailDto(TeamDto Team, IReadOnlyList<TeamMemberDto> Members);
public record UpsertTeamRequest(string Name, string? Description, Guid? ParentTeamId = null);
public record AddTeamMemberRequest(Guid UserId, bool IsLead);

public class TeamService(
    IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, PermissionService permissions,
    EntitlementService entitlements, ProjectAccess access)
{
    public async Task<IReadOnlyList<TeamDto>> ListAsync(CancellationToken ct = default)
    {
        ctx.RequireTenantId();
        var teams = await db.Teams.AsNoTracking().OrderBy(t => t.Name).ToListAsync(ct);
        var ids = teams.Select(t => t.Id).ToList();
        var members = await db.TeamMembers.AsNoTracking().Include(m => m.User).Where(m => ids.Contains(m.TeamId)).ToListAsync(ct);
        var projectCounts = await db.Projects.Where(p => p.TeamId != null && ids.Contains(p.TeamId.Value))
            .GroupBy(p => p.TeamId!.Value).Select(g => new { Id = g.Key, Count = g.Count() }).ToDictionaryAsync(x => x.Id, x => x.Count, ct);
        return teams.Select(t => ToDto(t, members.Where(m => m.TeamId == t.Id).ToList(), projectCounts.GetValueOrDefault(t.Id))).ToList();
    }

    private static TeamDto ToDto(Team t, List<TeamMember> members, int projects)
    {
        var lead = members.FirstOrDefault(m => m.IsLead)?.User;
        return new TeamDto(t.Id, t.Name, t.Description, members.Count, projects, lead is null ? null : new UserRefDto(lead.Id, lead.DisplayName), t.ParentTeamId);
    }

    public async Task<TeamDetailDto> GetAsync(Guid id, CancellationToken ct = default)
    {
        var team = await db.Teams.AsNoTracking().FirstOrDefaultAsync(t => t.Id == id, ct) ?? throw new NotFoundException("Team not found.");
        var members = await db.TeamMembers.AsNoTracking().Include(m => m.User).Where(m => m.TeamId == id).ToListAsync(ct);
        var userIds = members.Select(m => m.UserId).ToList();
        var openByUser = await db.Tasks.Where(t => t.AssigneeId != null && userIds.Contains(t.AssigneeId.Value)
                                                   && t.Status!.Category != StatusCategory.Done && t.Status.Category != StatusCategory.Cancelled)
            .GroupBy(t => t.AssigneeId!.Value).Select(g => new { Id = g.Key, Count = g.Count() }).ToDictionaryAsync(x => x.Id, x => x.Count, ct);
        var projects = await db.Projects.CountAsync(p => p.TeamId == id, ct);
        var hideEmail = ctx.Role == TenantRole.Guest;
        return new TeamDetailDto(ToDto(team, members, projects),
            members.OrderByDescending(m => m.IsLead).ThenBy(m => m.User!.DisplayName)
                .Select(m => new TeamMemberDto(m.UserId, m.User!.DisplayName, hideEmail ? "" : m.User.Email, m.IsLead, openByUser.GetValueOrDefault(m.UserId))).ToList());
    }

    public async Task<TeamDetailDto> CreateAsync(UpsertTeamRequest req, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.TeamsManage, ct);
        await entitlements.EnsureWithinLimitAsync(FeatureKeys.MaxTeams, await db.Teams.CountAsync(ct), 1, ct);
        var name = req.Name.Trim();
        if (await db.Teams.AnyAsync(t => t.Name.ToLower() == name.ToLower(), ct))
            throw new ConflictException("A team with this name already exists.", "TEAM_EXISTS");
        var team = new Team { TenantId = ctx.RequireTenantId(), Name = name, Description = req.Description?.Trim(), CreatedAt = clock.Now, ParentTeamId = await CheckParentAsync(null, req.ParentTeamId, ct) };
        db.Teams.Add(team);
        recorder.Activity("team.created", "Team", team.Id, $"Created team \"{team.Name}\"");
        await db.SaveChangesAsync(ct);
        return await GetAsync(team.Id, ct);
    }

    /// <summary>A department is a team that other teams sit under, one level deep: the parent must exist, must itself be top-level, and a team that has teams under it cannot be placed under another.</summary>
    private async Task<Guid?> CheckParentAsync(Guid? teamId, Guid? parentId, CancellationToken ct)
    {
        if (parentId is not { } pid) return null;
        if (pid == teamId) throw new ValidationException("parentTeamId", "A team cannot be inside itself.");
        var parent = await db.Teams.AsNoTracking().FirstOrDefaultAsync(t => t.Id == pid, ct) ?? throw new ValidationException("parentTeamId", "Department not found.");
        if (parent.ParentTeamId is not null) throw new ValidationException("parentTeamId", "Departments are one level deep: choose a top-level team.");
        if (teamId is { } id && await db.Teams.AnyAsync(t => t.ParentTeamId == id, ct)) throw new ValidationException("parentTeamId", "This team has teams under it, so it cannot be placed inside another.");
        return pid;
    }

    public async Task<TeamDetailDto> UpdateAsync(Guid id, UpsertTeamRequest req, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.TeamsManage, ct);
        var team = await db.Teams.FirstOrDefaultAsync(t => t.Id == id, ct) ?? throw new NotFoundException("Team not found.");
        var name = req.Name.Trim();
        if (await db.Teams.AnyAsync(t => t.Id != id && t.Name.ToLower() == name.ToLower(), ct))
            throw new ConflictException("A team with this name already exists.", "TEAM_EXISTS");
        team.Name = name;
        team.Description = req.Description?.Trim();
        team.ParentTeamId = await CheckParentAsync(id, req.ParentTeamId, ct);
        await db.SaveChangesAsync(ct);
        return await GetAsync(id, ct);
    }

    public async Task DeleteAsync(Guid id, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.TeamsManage, ct);
        var team = await db.Teams.FirstOrDefaultAsync(t => t.Id == id, ct) ?? throw new NotFoundException("Team not found.");
        foreach (var p in await db.Projects.Where(p => p.TeamId == id).ToListAsync(ct)) p.TeamId = null;
        foreach (var child in await db.Teams.Where(t => t.ParentTeamId == id).ToListAsync(ct)) child.ParentTeamId = null;
        db.TeamMembers.RemoveRange(await db.TeamMembers.Where(m => m.TeamId == id).ToListAsync(ct));
        db.Teams.Remove(team);
        recorder.Activity("team.deleted", "Team", id, $"Deleted team \"{team.Name}\"");
        await db.SaveChangesAsync(ct);
    }

    public async Task<TeamDetailDto> AddMemberAsync(Guid teamId, AddTeamMemberRequest req, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.TeamsManage, ct);
        var team = await db.Teams.FirstOrDefaultAsync(t => t.Id == teamId, ct) ?? throw new NotFoundException("Team not found.");
        await access.EnsureTenantMemberAsync(req.UserId, "userId", ct);

        var existing = await db.TeamMembers.FirstOrDefaultAsync(m => m.TeamId == teamId && m.UserId == req.UserId, ct);
        if (existing is null)
        {
            existing = new TeamMember { TenantId = team.TenantId, TeamId = teamId, UserId = req.UserId, CreatedAt = clock.Now };
            db.TeamMembers.Add(existing);
        }
        if (req.IsLead) // exactly one lead per team
            foreach (var other in await db.TeamMembers.Where(m => m.TeamId == teamId && m.UserId != req.UserId && m.IsLead).ToListAsync(ct))
                other.IsLead = false;
        existing.IsLead = req.IsLead;
        await db.SaveChangesAsync(ct);
        return await GetAsync(teamId, ct);
    }

    public async Task<TeamDetailDto> RemoveMemberAsync(Guid teamId, Guid userId, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.TeamsManage, ct);
        var row = await db.TeamMembers.FirstOrDefaultAsync(m => m.TeamId == teamId && m.UserId == userId, ct)
            ?? throw new NotFoundException("Team member not found.");
        db.TeamMembers.Remove(row);
        await db.SaveChangesAsync(ct);
        return await GetAsync(teamId, ct);
    }
}
