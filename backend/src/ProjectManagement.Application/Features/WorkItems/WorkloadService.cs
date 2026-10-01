using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Organization;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.WorkItems;

/// <summary>Whose workload to show: the people who report to me, everyone in the workspace, or just me.</summary>
public enum WorkloadScope { Reports, Everyone, Me }

public record WorkloadDto(WorkloadScope Scope, IReadOnlyList<WorkloadScope> Available, IReadOnlyList<TeamMemberDto> Members, TeamTotalsDto Totals);

/// <summary>
/// The Workload view (Insights): open, overdue and finished work per person across every kind of work, with what each person has next.
/// One page for what used to be split between "My team" and the workload part of Reports. A manager sees their reporting line (all of
/// their people's work, as before); people with broad reports access can also see everyone (limited to what they themselves may see);
/// everyone can see their own.
/// </summary>
public class WorkloadService(IAppDbContext db, ICurrentContext ctx, PermissionService permissions, ReportingLineService reporting)
{
    public async Task<IReadOnlyList<WorkloadScope>> AvailableAsync(CancellationToken ct = default)
    {
        var list = new List<WorkloadScope>();
        if (await reporting.CountMineAsync(ctx.RequireUserId(), ctx.RequireTenantId(), ct) > 0) list.Add(WorkloadScope.Reports);
        if (await permissions.HasBroadReportsAccessAsync(ct)) list.Add(WorkloadScope.Everyone);
        list.Add(WorkloadScope.Me);
        return list;
    }

    public async Task<WorkloadDto> GetAsync(WorkloadScope? requested, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId(); var tid = ctx.RequireTenantId();
        var available = await AvailableAsync(ct);
        var scope = requested ?? available[0];
        if (!available.Contains(scope)) throw new ForbiddenException("You cannot see that workload.", "PERMISSION_DENIED");

        IReadOnlyList<TeamMemberDto> members = scope switch
        {
            WorkloadScope.Reports => await reporting.BuildAsync(await reporting.ReportsOfAsync(me, tid, ct), tid, WorkItemScope.ReportingLine, ct),
            WorkloadScope.Everyone => await reporting.BuildAsync(await EveryoneAsync(tid, ct), tid, WorkItemScope.Caller, ct),
            _ => await reporting.BuildAsync(new Dictionary<Guid, int> { [me] = 0 }, tid, WorkItemScope.Caller, ct),
        };
        var ordered = scope == WorkloadScope.Everyone ? members.OrderByDescending(m => m.Open).ThenBy(m => m.Name).ToList() : members;
        return new WorkloadDto(scope, available, ordered, new TeamTotalsDto(members.Count, members.Sum(m => m.Open), members.Sum(m => m.Overdue)));
    }

    /// <summary>One person's open work, when the caller may see their workload in that scope.</summary>
    public async Task<TeamPersonDto> PersonAsync(Guid userId, WorkloadScope? requested, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId(); var tid = ctx.RequireTenantId();
        if (userId == me) return await reporting.PersonAsync(me, 0, tid, WorkItemScope.Caller, ct);
        var line = await reporting.ReportsOfAsync(me, tid, ct);
        if (requested != WorkloadScope.Everyone && line.TryGetValue(userId, out var level)) return await reporting.PersonAsync(userId, level, tid, WorkItemScope.ReportingLine, ct);
        if (await permissions.HasBroadReportsAccessAsync(ct) && await db.TenantMembers.AnyAsync(m => m.TenantId == tid && m.UserId == userId, ct))
            return await reporting.PersonAsync(userId, 0, tid, WorkItemScope.Caller, ct);
        throw new NotFoundException("That person is not in a workload you can see.");
    }

    /// <summary>Every member who can be given work (guests cannot), at level 0 since this view is not about the chart.</summary>
    private async Task<Dictionary<Guid, int>> EveryoneAsync(Guid tid, CancellationToken ct) =>
        await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid && m.Role != TenantRole.Guest).Select(m => m.UserId).Take(1000)
            .ToDictionaryAsync(id => id, _ => 0, ct);
}
