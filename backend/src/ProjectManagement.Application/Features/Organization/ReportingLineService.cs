using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.WorkItems;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Organization;

/// <summary>One open item of a person in my reporting line: a project task, a test issue, an action item or operational work.</summary>
public record TeamTaskDto(Guid Id, Guid? ProjectId, string? ProjectName, string Key, string Title, string StatusName, StatusCategory Category, Priority Priority,
    DateOnly? DueDate, bool IsOverdue, WorkItemKind Kind = WorkItemKind.Task);
public record TeamMemberDto(Guid UserId, string Name, string Email, string? JobRole, int Level, string? ReportsTo, int Open, int Overdue, int DoneLast30Days,
    int LoggedMinutesLast7Days, IReadOnlyList<TeamTaskDto> NextUp, int DueThisWeek = 0, WorkKindCounts? OpenByKind = null);
public record TeamTotalsDto(int People, int Open, int Overdue);
public record MyTeamDto(IReadOnlyList<TeamMemberDto> Members, TeamTotalsDto Totals);
public record TeamPersonDto(TeamMemberDto Person, IReadOnlyList<TeamTaskDto> OpenTasks);

/// <summary>
/// Reporting lines: the people who report to me in the organization chart (directly or through others) and how their work is going,
/// across every kind of work they have. This is read-only and does not depend on project membership or the reports permission:
/// managing people means seeing their work.
/// </summary>
public class ReportingLineService(IAppDbContext db, ICurrentContext ctx, AppClock clock, WorkItemService workItems)
{
    private const int MaxDepth = 12;   // deeper than any real organization; also stops a data cycle from looping
    private const int NextUpPerPerson = 5;

    /// <summary>Everyone below <paramref name="managerId"/> in the workspace, with how many steps down they are (1 = direct report).</summary>
    public async Task<Dictionary<Guid, int>> ReportsOfAsync(Guid managerId, Guid tenantId, CancellationToken ct = default)
    {
        var edges = await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tenantId && m.ReportsToUserId != null)
            .Select(m => new { m.UserId, Boss = m.ReportsToUserId!.Value }).ToListAsync(ct);
        var byBoss = edges.GroupBy(e => e.Boss).ToDictionary(g => g.Key, g => g.Select(e => e.UserId).ToList());

        var levels = new Dictionary<Guid, int>();
        var frontier = new List<Guid> { managerId };
        for (var depth = 1; depth <= MaxDepth && frontier.Count > 0; depth++)
        {
            var next = new List<Guid>();
            foreach (var boss in frontier)
                foreach (var person in byBoss.GetValueOrDefault(boss, []))
                    if (person != managerId && levels.TryAdd(person, depth)) next.Add(person);
            frontier = next;
        }
        return levels;
    }

    public async Task<bool> IsInMyLineAsync(Guid userId, CancellationToken ct = default) =>
        userId != ctx.UserId && (await ReportsOfAsync(ctx.RequireUserId(), ctx.RequireTenantId(), ct)).ContainsKey(userId);

    public async Task<int> CountMineAsync(Guid userId, Guid tenantId, CancellationToken ct = default) => (await ReportsOfAsync(userId, tenantId, ct)).Count;

    public async Task<MyTeamDto> GetMyTeamAsync(CancellationToken ct = default)
    {
        var me = ctx.RequireUserId(); var tid = ctx.RequireTenantId();
        var levels = await ReportsOfAsync(me, tid, ct);
        var members = await BuildAsync(levels, tid, WorkItemScope.ReportingLine, ct);
        return new MyTeamDto(members, new TeamTotalsDto(members.Count, members.Sum(m => m.Open), members.Sum(m => m.Overdue)));
    }

    public async Task<TeamPersonDto> GetPersonAsync(Guid userId, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId(); var tid = ctx.RequireTenantId();
        var levels = await ReportsOfAsync(me, tid, ct);
        if (!levels.TryGetValue(userId, out var level)) throw new NotFoundException("That person does not report to you.");
        return await PersonAsync(userId, level, tid, WorkItemScope.ReportingLine, ct);
    }

    /// <summary>One person's row and all of their open work, under the given visibility rules.</summary>
    public async Task<TeamPersonDto> PersonAsync(Guid userId, int level, Guid tid, WorkItemScope scope, CancellationToken ct)
    {
        var person = (await BuildAsync(new Dictionary<Guid, int> { [userId] = level }, tid, scope, ct)).First();
        var open = await workItems.ListAsync(new WorkItemQuery(AssigneeId: userId, OpenOnly: true, Limit: 100), scope, ct);
        return new TeamPersonDto(person, open.Select(ToTask).ToList());
    }

    public static TeamTaskDto ToTask(WorkItemDto w) =>
        new(w.Id, w.ProjectId, w.ProjectName, w.Key, w.Title, w.Status, w.Category, w.Priority, w.DueDate, w.IsOverdue, w.Kind);

    /// <summary>A row per person: who they are in the chart, and their work across every kind (open, overdue, due this week, done, time).</summary>
    public async Task<IReadOnlyList<TeamMemberDto>> BuildAsync(Dictionary<Guid, int> levels, Guid tid, WorkItemScope scope, CancellationToken ct)
    {
        if (levels.Count == 0) return [];
        var ids = levels.Keys.ToList();
        var since7 = clock.Today.AddDays(-6);

        var people = await (from m in db.TenantMembers.AsNoTracking()
                            join u in db.Users on m.UserId equals u.Id
                            where m.TenantId == tid && ids.Contains(m.UserId)
                            select new { m.UserId, u.DisplayName, u.Email, m.OrgRoleId, m.ReportsToUserId }).ToListAsync(ct);
        var roleNames = await db.OrgRoles.AsNoTracking().Select(r => new { r.Id, r.Name }).ToDictionaryAsync(r => r.Id, r => r.Name, ct);
        var bossIds = people.Where(p => p.ReportsToUserId != null).Select(p => p.ReportsToUserId!.Value).Distinct().ToList();
        var bossNames = await db.Users.Where(u => bossIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);

        var counts = await workItems.CountsAsync(ids, scope, ct);
        var logged = await db.TimeEntries.Where(e => ids.Contains(e.UserId) && e.WorkDate >= since7 && !(e.StartedAt != null && e.EndedAt == null))
            .GroupBy(e => e.UserId).Select(g => new { Who = g.Key, Minutes = g.Sum(x => x.Minutes) }).ToDictionaryAsync(x => x.Who, x => x.Minutes, ct);
        var next = await workItems.NextUpAsync(ids, scope, NextUpPerPerson, ct);

        return people.Select(p =>
        {
            var c = counts[p.UserId];
            return new TeamMemberDto(p.UserId, p.DisplayName, p.Email, p.OrgRoleId is { } r ? roleNames.GetValueOrDefault(r) : null, levels[p.UserId],
                p.ReportsToUserId is { } b ? bossNames.GetValueOrDefault(b) : null, c.Open, c.Overdue, c.DoneLast30Days, logged.GetValueOrDefault(p.UserId),
                next[p.UserId].Select(ToTask).ToList(), c.DueThisWeek, c.OpenByKind);
        }).OrderBy(m => m.Level).ThenBy(m => m.Name).ToList();
    }
}
