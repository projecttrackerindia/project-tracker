using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Organization;

/// <summary>One person on the reporting tree: their manager (TenantMember.ReportsToUserId), their job role and their teams.</summary>
public record OrgTreePersonDto(Guid UserId, string DisplayName, string? RoleName, TenantRole AccessRole, Guid? ManagerId, IReadOnlyList<Guid> TeamIds, int ReportCount);
public record OrgTreeTeamDto(Guid Id, string Name, Guid? ParentTeamId, int MemberCount);
public record OrgTreeDto(IReadOnlyList<OrgTreePersonDto> People, IReadOnlyList<OrgTreeTeamDto> Teams, bool CanManage);

/// <summary>Move a person under a new manager (<c>kind = "person"</c>) or a team under a new parent team (<c>kind = "team"</c>).</summary>
public record OrgMoveRequest(string Kind, Guid Id, Guid? NewParentId);
/// <summary>What a move changes, shown before it is confirmed.</summary>
public record OrgMoveImpactDto(string Kind, Guid Id, string Name, Guid? FromParentId, string? FromParentName, Guid? ToParentId, string? ToParentName,
    int MovesWith, IReadOnlyList<string> Effects);

/// <summary>
/// The org chart canvas: the whole reporting tree in one read, and drag-to-move with an impact preview and an explicit confirm.
/// Every confirmed move is written to the audit log (<c>org.member_moved</c> / <c>org.team_moved</c>) on top of the underlying change's own entry.
/// </summary>
public class OrgMoveService(IAppDbContext db, ICurrentContext ctx, PermissionService permissions, Recorder recorder, OrgService org)
{
    private Guid RequireOrganization()
    {
        var tid = ctx.RequireTenantId();
        if (ctx.WorkspaceType == WorkspaceType.Personal)
            throw new ForbiddenException("Personal workspaces do not have an organization chart.", "PERSONAL_WORKSPACE");
        if (ctx.Role == TenantRole.Guest)
            throw new ForbiddenException("Guests cannot view the organization chart.", "PERMISSION_DENIED");
        return tid;
    }

    public async Task<OrgTreeDto> TreeAsync(CancellationToken ct = default)
    {
        var tid = RequireOrganization();
        var members = await db.TenantMembers.AsNoTracking().Include(m => m.User).Where(m => m.TenantId == tid && m.Status == MemberStatus.Active)
            .OrderBy(m => m.User!.DisplayName).ToListAsync(ct);
        var roles = await db.OrgRoles.AsNoTracking().ToDictionaryAsync(r => r.Id, r => r.Name, ct);
        var teams = await db.Teams.AsNoTracking().OrderBy(t => t.Name).ToListAsync(ct);
        var links = await db.TeamMembers.AsNoTracking().Select(m => new { m.TeamId, m.UserId }).ToListAsync(ct);
        var teamsOf = links.GroupBy(l => l.UserId).ToDictionary(g => g.Key, g => (IReadOnlyList<Guid>)g.Select(l => l.TeamId).ToList());
        var reports = members.Where(m => m.ReportsToUserId != null).GroupBy(m => m.ReportsToUserId!.Value).ToDictionary(g => g.Key, g => g.Count());

        return new OrgTreeDto(
            members.Select(m => new OrgTreePersonDto(m.UserId, m.User!.DisplayName, m.OrgRoleId is { } r ? roles.GetValueOrDefault(r) : null, m.Role,
                m.ReportsToUserId, teamsOf.GetValueOrDefault(m.UserId) ?? [], reports.GetValueOrDefault(m.UserId))).ToList(),
            teams.Select(t => new OrgTreeTeamDto(t.Id, t.Name, t.ParentTeamId, links.Count(l => l.TeamId == t.Id))).ToList(),
            await permissions.HasAsync(Permissions.OrgStructure, ct));
    }

    public async Task<OrgMoveImpactDto> PreviewAsync(OrgMoveRequest req, CancellationToken ct = default)
    {
        var tid = RequireOrganization();
        await permissions.RequireAsync(Permissions.OrgStructure, ct);
        return IsTeam(req) ? await TeamImpactAsync(req, ct) : await PersonImpactAsync(tid, req, ct);
    }

    public async Task<OrgMoveImpactDto> MoveAsync(OrgMoveRequest req, CancellationToken ct = default)
    {
        var tid = RequireOrganization();
        await permissions.RequireAsync(Permissions.OrgStructure, ct);
        if (IsTeam(req))
        {
            var impact = await TeamImpactAsync(req, ct);
            var team = await db.Teams.FirstOrDefaultAsync(t => t.Id == req.Id, ct) ?? throw new NotFoundException("Team not found.");
            if (team.ParentTeamId == req.NewParentId) return impact;
            team.ParentTeamId = req.NewParentId;
            recorder.Audit("org.team_moved", "Team", team.Id, new { ParentTeamId = impact.FromParentId }, new { req.NewParentId, Team = team.Name, impact.MovesWith });
            await db.SaveChangesAsync(ct);
            return impact;
        }
        var personImpact = await PersonImpactAsync(tid, req, ct);
        if (personImpact.FromParentId == req.NewParentId) return personImpact;
        // SetReportsToAsync checks loops and the grant guard, and writes org.reports_to_changed.
        await org.SetReportsToAsync(req.Id, new SetReportsToRequest(req.NewParentId), ct);
        recorder.Audit("org.member_moved", "TenantMember", req.Id, new { ManagerId = personImpact.FromParentId },
            new { ManagerId = req.NewParentId, Member = personImpact.Name, personImpact.MovesWith });
        await db.SaveChangesAsync(ct);
        return personImpact;
    }

    private static bool IsTeam(OrgMoveRequest req) => string.Equals(req.Kind, "team", StringComparison.OrdinalIgnoreCase);

    private async Task<OrgMoveImpactDto> PersonImpactAsync(Guid tid, OrgMoveRequest req, CancellationToken ct)
    {
        var members = await db.TenantMembers.AsNoTracking().Include(m => m.User).Where(m => m.TenantId == tid).ToListAsync(ct);
        var me = members.FirstOrDefault(m => m.UserId == req.Id) ?? throw new NotFoundException("Member not found.");
        TenantMember? to = null;
        if (req.NewParentId is { } boss)
        {
            if (boss == req.Id) throw new ConflictException("Nobody can report to themselves.", "ORG_CYCLE");
            to = members.FirstOrDefault(m => m.UserId == boss) ?? throw new NotFoundException("The new manager is not a member of this organization.");
            var chain = members.ToDictionary(m => m.UserId, m => m.ReportsToUserId);
            var seen = new HashSet<Guid>();
            for (Guid? cur = boss; cur is { } id && seen.Add(id); cur = chain.GetValueOrDefault(id))
                if (id == req.Id) throw new ConflictException("That would create a reporting loop.", "ORG_CYCLE");
        }
        var from = me.ReportsToUserId is { } f ? members.FirstOrDefault(m => m.UserId == f) : null;
        var below = CountBelow(req.Id, members.Select(m => (m.UserId, m.ReportsToUserId)).ToList());
        var name = me.User!.DisplayName;
        var effects = new List<string>
        {
            to is null ? $"{name} will no longer report to anyone." : $"{name} will report to {to.User!.DisplayName}.",
        };
        if (below > 0) effects.Add($"{below} {(below == 1 ? "person moves" : "people move")} with them.");
        if (from is not null) effects.Add($"{from.User!.DisplayName} loses sight of {name}'s work and approvals.");
        if (to is not null) effects.Add($"{to.User!.DisplayName} will approve {name}'s leave and see their work.");
        return new OrgMoveImpactDto("person", req.Id, name, from?.UserId, from?.User!.DisplayName, to?.UserId, to?.User!.DisplayName, below, effects);
    }

    private async Task<OrgMoveImpactDto> TeamImpactAsync(OrgMoveRequest req, CancellationToken ct)
    {
        var teams = await db.Teams.AsNoTracking().ToListAsync(ct);
        var team = teams.FirstOrDefault(t => t.Id == req.Id) ?? throw new NotFoundException("Team not found.");
        Team? to = null;
        if (req.NewParentId is { } p)
        {
            if (p == req.Id) throw new ConflictException("A team cannot sit inside itself.", "ORG_CYCLE");
            to = teams.FirstOrDefault(t => t.Id == p) ?? throw new NotFoundException("The new parent team was not found.");
            // Departments are one level deep (the TeamService rule).
            if (to.ParentTeamId is not null) throw new ValidationException("newParentId", "Departments are one level deep: choose a top-level team.");
            if (teams.Any(t => t.ParentTeamId == team.Id)) throw new ValidationException("newParentId", "This team has teams under it, so it cannot be placed inside another.");
        }
        var from = team.ParentTeamId is { } f ? teams.FirstOrDefault(t => t.Id == f) : null;
        var people = await db.TeamMembers.AsNoTracking().CountAsync(m => m.TeamId == team.Id, ct);
        var effects = new List<string>
        {
            to is null ? $"{team.Name} becomes a top-level team." : $"{team.Name} moves under {to.Name}.",
            $"{people} {(people == 1 ? "member stays" : "members stay")} on the team.",
        };
        if (to is not null) effects.Add($"{to.Name}'s leads can manage {team.Name}.");
        return new OrgMoveImpactDto("team", team.Id, team.Name, from?.Id, from?.Name, to?.Id, to?.Name, people, effects);
    }

    private static int CountBelow(Guid root, IReadOnlyList<(Guid User, Guid? Boss)> rows)
    {
        var kids = rows.Where(r => r.Boss != null).GroupBy(r => r.Boss!.Value).ToDictionary(g => g.Key, g => g.Select(r => r.User).ToList());
        var seen = new HashSet<Guid> { root };
        var stack = new Stack<Guid>([root]);
        var count = 0;
        while (stack.Count > 0)
            foreach (var k in kids.GetValueOrDefault(stack.Pop()) ?? [])
                if (seen.Add(k)) { count++; stack.Push(k); }
        return count;
    }
}
