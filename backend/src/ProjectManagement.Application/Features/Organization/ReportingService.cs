using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Organization;

public record TeamTaskDto(Guid Id, Guid ProjectId, string ProjectName, string Key, string Title, string StatusName, StatusCategory Category, Priority Priority,
    DateOnly? DueDate, bool IsOverdue);
public record TeamMemberDto(Guid UserId, string Name, string Email, string? JobRole, int Level, string? ReportsTo, int Open, int Overdue, int DoneLast30Days,
    int LoggedMinutesLast7Days, IReadOnlyList<TeamTaskDto> NextUp);
public record TeamTotalsDto(int People, int Open, int Overdue);
public record MyTeamDto(IReadOnlyList<TeamMemberDto> Members, TeamTotalsDto Totals);
public record TeamPersonDto(TeamMemberDto Person, IReadOnlyList<TeamTaskDto> OpenTasks);

/// <summary>
/// Reporting-line visibility: the people who report to me in the organization chart (directly or through others) and how their work is going.
/// This is read-only and does not depend on project membership or the reports permission: managing people means seeing their work.
/// </summary>
public class ReportingService(IAppDbContext db, ICurrentContext ctx, AppClock clock)
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
        var members = await BuildAsync(levels, tid, ct);
        return new MyTeamDto(members, new TeamTotalsDto(members.Count, members.Sum(m => m.Open), members.Sum(m => m.Overdue)));
    }

    public async Task<TeamPersonDto> GetPersonAsync(Guid userId, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId(); var tid = ctx.RequireTenantId();
        var levels = await ReportsOfAsync(me, tid, ct);
        if (!levels.TryGetValue(userId, out var level)) throw new NotFoundException("That person does not report to you.");
        var person = (await BuildAsync(new Dictionary<Guid, int> { [userId] = level }, tid, ct)).First();
        var today = clock.Today;
        var open = await OpenTasks(userId).OrderBy(t => t.DueDate == null).ThenBy(t => t.DueDate).Take(100)
            .Select(t => new { t.Id, t.ProjectId, Project = t.Project!.Name, Key = t.Project.Key, t.Number, t.Title, Status = t.Status!.Name, t.Status.Category, t.Priority, t.DueDate }).ToListAsync(ct);
        return new TeamPersonDto(person, open.Select(t => ToTask(t.Id, t.ProjectId, t.Project, t.Key, t.Number, t.Title, t.Status, t.Category, t.Priority, t.DueDate, today)).ToList());
    }

    private IQueryable<Domain.Entities.TaskItem> OpenTasks(Guid assignee) =>
        db.Tasks.Where(t => t.AssigneeId == assignee && t.Status!.Category != StatusCategory.Done && t.Status.Category != StatusCategory.Cancelled);

    private static TeamTaskDto ToTask(Guid id, Guid projectId, string project, string key, int number, string title, string status, StatusCategory cat, Priority prio, DateOnly? due, DateOnly today) =>
        new(id, projectId, project, $"{key}-{number}", title, status, cat, prio, due, due is { } d && d < today);

    private async Task<IReadOnlyList<TeamMemberDto>> BuildAsync(Dictionary<Guid, int> levels, Guid tid, CancellationToken ct)
    {
        if (levels.Count == 0) return [];
        var ids = levels.Keys.ToList();
        var today = clock.Today;
        var since30 = clock.Now.AddDays(-30);
        var since7 = clock.Today.AddDays(-6);

        var people = await (from m in db.TenantMembers.AsNoTracking()
                            join u in db.Users on m.UserId equals u.Id
                            where m.TenantId == tid && ids.Contains(m.UserId)
                            select new { m.UserId, u.DisplayName, u.Email, m.OrgRoleId, m.ReportsToUserId }).ToListAsync(ct);
        var roleNames = await db.OrgRoles.AsNoTracking().Select(r => new { r.Id, r.Name }).ToDictionaryAsync(r => r.Id, r => r.Name, ct);
        var bossIds = people.Where(p => p.ReportsToUserId != null).Select(p => p.ReportsToUserId!.Value).Distinct().ToList();
        var bossNames = await db.Users.Where(u => bossIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);

        var counts = await db.Tasks.Where(t => t.AssigneeId != null && ids.Contains(t.AssigneeId.Value))
            .GroupBy(t => new { Who = t.AssigneeId!.Value, t.Status!.Category, Overdue = t.DueDate != null && t.DueDate < today })
            .Select(g => new { g.Key.Who, g.Key.Category, g.Key.Overdue, N = g.Count() }).ToListAsync(ct);
        var done30 = await db.Tasks.Where(t => t.AssigneeId != null && ids.Contains(t.AssigneeId.Value) && t.CompletedAt != null && t.CompletedAt >= since30 && t.Status!.Category == StatusCategory.Done)
            .GroupBy(t => t.AssigneeId!.Value).Select(g => new { Who = g.Key, N = g.Count() }).ToDictionaryAsync(x => x.Who, x => x.N, ct);
        var logged = await db.TimeEntries.Where(e => ids.Contains(e.UserId) && e.WorkDate >= since7 && !(e.StartedAt != null && e.EndedAt == null))
            .GroupBy(e => e.UserId).Select(g => new { Who = g.Key, Minutes = g.Sum(x => x.Minutes) }).ToDictionaryAsync(x => x.Who, x => x.Minutes, ct);

        var upcoming = await db.Tasks.Where(t => t.AssigneeId != null && ids.Contains(t.AssigneeId.Value) && t.Status!.Category != StatusCategory.Done && t.Status.Category != StatusCategory.Cancelled)
            .OrderBy(t => t.DueDate == null).ThenBy(t => t.DueDate).Take(1000)
            .Select(t => new { Who = t.AssigneeId!.Value, t.Id, t.ProjectId, Project = t.Project!.Name, Key = t.Project.Key, t.Number, t.Title, Status = t.Status!.Name, t.Status.Category, t.Priority, t.DueDate }).ToListAsync(ct);

        return people.Select(p =>
        {
            var mine = counts.Where(c => c.Who == p.UserId).ToList();
            var open = mine.Where(c => c.Category is not (StatusCategory.Done or StatusCategory.Cancelled)).ToList();
            var next = upcoming.Where(t => t.Who == p.UserId).Take(NextUpPerPerson)
                .Select(t => ToTask(t.Id, t.ProjectId, t.Project, t.Key, t.Number, t.Title, t.Status, t.Category, t.Priority, t.DueDate, today)).ToList();
            return new TeamMemberDto(p.UserId, p.DisplayName, p.Email, p.OrgRoleId is { } r ? roleNames.GetValueOrDefault(r) : null, levels[p.UserId],
                p.ReportsToUserId is { } b ? bossNames.GetValueOrDefault(b) : null, open.Sum(c => c.N), open.Where(c => c.Overdue).Sum(c => c.N),
                done30.GetValueOrDefault(p.UserId), logged.GetValueOrDefault(p.UserId), next);
        }).OrderBy(m => m.Level).ThenBy(m => m.Name).ToList();
    }
}
