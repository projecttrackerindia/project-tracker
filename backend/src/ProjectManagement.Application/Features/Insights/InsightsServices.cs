using System.Text;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.Tasks;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Insights;

public record ActivityDto(Guid Id, string Action, string EntityType, Guid? EntityId, string Summary, UserRefDto? Actor, Guid? ProjectId, DateTime CreatedAt);
public record AuditLogDto(Guid Id, Guid? TenantId, string? TenantName, Guid? UserId, string? UserName, string Action, string EntityType,
    Guid? EntityId, string? OldValue, string? NewValue, string? IpAddress, DateTime CreatedAt);

public record DashboardCounts(int MyDueToday, int MyCompletedToday, int MyOpen, int MyOverdue, int ActiveProjects, int CompletedProjects,
    int TotalProjects, int OpenTasks, int OverdueTasks, int Members, int OverallProgress, int MyLoggedMinutesThisWeek);
public record WorkloadItem(Guid UserId, string Name, int Open, int Overdue, int Done);
public record DashboardDto(DashboardCounts Counts, IReadOnlyList<TaskDto> MyTasks, IReadOnlyList<ProjectListItemDto> Projects,
    IReadOnlyList<ActivityDto> Activity);

public record CalendarEventDto(string Type, Guid Id, string Title, DateOnly Date, string? Status, StatusCategory? Category, bool Overdue,
    Guid? ProjectId, string? ProjectName, Priority? Priority);
public record SearchHit(string Type, Guid Id, string Title, string? Subtitle, Guid? ProjectId, Guid? TaskId);
public record SearchResultDto(IReadOnlyList<SearchHit> Hits);

public record DayCount(DateOnly Date, int Count);
public record StatusCount(StatusCategory Category, int Count);
public record ProjectProgressItem(Guid Id, string Key, string Name, int Progress, ProjectHealth Health, DateOnly? DueDate, int Total, int Done);
public record ReportTotals(int Total, int Completed, int Pending, int InProgress, int Overdue, int Cancelled, int CompletionRate);
public record ReportSummaryDto(int Days, ReportTotals Totals, IReadOnlyList<DayCount> CompletedPerDay, IReadOnlyList<StatusCount> StatusDistribution,
    IReadOnlyList<ProjectProgressItem> ProjectProgress, int CompletedThisWeek, int CompletedThisMonth, IReadOnlyList<WorkloadItem>? Workload, bool AdvancedAvailable);

public class ActivityService(IAppDbContext db, ICurrentContext ctx, AppClock clock, ProjectAccess access, PermissionService permissions, EntitlementService entitlements)
{
    public async Task<PagedResult<ActivityDto>> ListAsync(Guid? projectId, int page, int pageSize, CancellationToken ct = default)
    {
        ctx.RequireTenantId();
        var q = db.Activities.AsNoTracking().AsQueryable();

        if (projectId is { } pid)
        {
            await access.GetProjectAsync(pid, ct); // 404 when the caller cannot see the project
            q = q.Where(a => a.ProjectId == pid);
        }
        else if (access.IsRestricted)
        {
            var visible = access.VisibleProjects().Select(p => p.Id);
            q = q.Where(a => a.ProjectId != null && visible.Contains(a.ProjectId.Value));
        }

        // Retention is a plan entitlement (Free = 30 days).
        var days = await entitlements.GetValueAsync(FeatureKeys.ActivityRetentionDays, ct);
        if (days > 0) { var since = clock.Now.AddDays(-days); q = q.Where(a => a.CreatedAt >= since); }

        var p = new PageQuery(page, pageSize);
        var total = await q.CountAsync(ct);
        var rows = await q.OrderByDescending(a => a.CreatedAt).Skip((p.SafePage - 1) * p.SafeSize()).Take(p.SafeSize())
            .Select(a => new { Activity = a, ActorName = a.Actor!.DisplayName }).ToListAsync(ct);
        var items = rows.Select(r => new ActivityDto(r.Activity.Id, r.Activity.Action, r.Activity.EntityType, r.Activity.EntityId, r.Activity.Summary,
            r.ActorName is null ? null : new UserRefDto(r.Activity.ActorId!.Value, r.ActorName), r.Activity.ProjectId, r.Activity.CreatedAt)).ToList();
        return new PagedResult<ActivityDto>(items, p.SafePage, p.SafeSize(), total);
    }

    /// <summary>Tenant-scoped audit trail (Business plan and above).</summary>
    public async Task<PagedResult<AuditLogDto>> ListAuditAsync(string? action, int page, int pageSize, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.AuditView, ct);
        await entitlements.EnsureFeatureAsync(FeatureKeys.AuditLog, ct);
        var tid = ctx.RequireTenantId();

        var q = db.AuditLogs.AsNoTracking().Where(a => a.TenantId == tid);
        if (!string.IsNullOrWhiteSpace(action)) { var a0 = action.Trim().ToLowerInvariant(); q = q.Where(a => a.Action.ToLower().StartsWith(a0)); }

        var p = new PageQuery(page, pageSize);
        var total = await q.CountAsync(ct);
        var rows = await q.OrderByDescending(a => a.CreatedAt).Skip((p.SafePage - 1) * p.SafeSize()).Take(p.SafeSize())
            .Select(a => new { Log = a, UserName = a.User!.DisplayName }).ToListAsync(ct);
        return new PagedResult<AuditLogDto>(rows.Select(r => new AuditLogDto(r.Log.Id, r.Log.TenantId, null, r.Log.UserId, r.UserName, r.Log.Action,
            r.Log.EntityType, r.Log.EntityId, r.Log.OldValue, r.Log.NewValue, r.Log.IpAddress, r.Log.CreatedAt)).ToList(), p.SafePage, p.SafeSize(), total);
    }
}

public class DashboardService(IAppDbContext db, ICurrentContext ctx, AppClock clock, ProjectAccess access, ProjectService projects,
    TaskService tasks, ActivityService activity, PermissionService permissions)
{
    public async Task<DashboardDto> GetAsync(CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        var me = ctx.RequireUserId();
        var today = clock.Today;

        var visible = access.VisibleTasks().Where(t => t.ParentTaskId == null);
        var open = visible.Where(t => t.Status!.Category != StatusCategory.Done && t.Status.Category != StatusCategory.Cancelled);
        var mine = open.Where(t => t.AssigneeId == me);

        var doneToday = await access.VisibleTasks().CountAsync(t => t.AssigneeId == me && t.CompletedAt != null && t.CompletedAt >= LocalDayStartUtc(today), ct);
        var projectRows = await access.VisibleProjects().AsNoTracking().Select(p => new { p.Id, p.Status }).ToListAsync(ct);
        var stats = await projects.GetStatsAsync(projectRows.Select(p => p.Id).ToList(), ct);
        var allTotal = stats.Values.Sum(s => s.Total - s.Cancelled);
        var allDone = stats.Values.Sum(s => s.Done);
        var weekStart = today.AddDays(-(((int)today.DayOfWeek + 6) % 7));   // Monday of the current week
        var loggedThisWeek = await db.TimeEntries.Where(e => e.UserId == me && e.WorkDate >= weekStart && e.WorkDate <= today && !(e.StartedAt != null && e.EndedAt == null))
            .SumAsync(e => (int?)e.Minutes, ct) ?? 0;

        var counts = new DashboardCounts(
            MyDueToday: await mine.CountAsync(t => t.DueDate == today, ct),
            MyCompletedToday: doneToday,
            MyOpen: await mine.CountAsync(ct),
            MyOverdue: await mine.CountAsync(t => t.DueDate != null && t.DueDate < today, ct),
            ActiveProjects: projectRows.Count(p => p.Status is ProjectStatus.Planning or ProjectStatus.Active or ProjectStatus.OnHold),
            CompletedProjects: projectRows.Count(p => p.Status == ProjectStatus.Completed),
            TotalProjects: projectRows.Count(p => p.Status != ProjectStatus.Archived),
            OpenTasks: await open.CountAsync(ct),
            OverdueTasks: await open.CountAsync(t => t.DueDate != null && t.DueDate < today, ct),
            Members: await db.TenantMembers.CountAsync(m => m.TenantId == tid, ct),
            OverallProgress: allTotal <= 0 ? 0 : (int)Math.Round(allDone * 100.0 / allTotal),
            MyLoggedMinutesThisWeek: loggedThisWeek);

        var myTasks = await tasks.ListAsync(new TaskQuery(null, Mine: true, OpenOnly: true, Sort: "due", PageSize: 8), ct);
        var projectList = await projects.ListAsync(new ProjectQuery(null, null, null, null, null, Sort: "due", PageSize: 5), ct);
        var recent = await activity.ListAsync(null, 1, 8, ct);

        // Sections the person's job role cannot open are emptied rather than leaked through the dashboard.
        var lv = await permissions.LevelsAsync(ct);
        var (showTasks, showProjects, showActivity) = (lv[Modules.Tasks] > 0, lv[Modules.Projects] > 0, lv[Modules.Activity] > 0);
        if (!showTasks) counts = counts with { MyDueToday = 0, MyCompletedToday = 0, MyOpen = 0, MyOverdue = 0, OpenTasks = 0, OverdueTasks = 0, OverallProgress = 0, MyLoggedMinutesThisWeek = 0 };
        if (!showProjects) counts = counts with { ActiveProjects = 0, CompletedProjects = 0, TotalProjects = 0, OverallProgress = 0 };
        return new DashboardDto(counts, showTasks ? myTasks.Items : myTasks.Items.Take(0).ToList(), showProjects ? projectList.Items : projectList.Items.Take(0).ToList(),
            showActivity ? recent.Items : recent.Items.Take(0).ToList());
    }

    private DateTime LocalDayStartUtc(DateOnly today) =>
        DateTime.SpecifyKind(today.ToDateTime(TimeOnly.MinValue), DateTimeKind.Utc).AddMinutes(-clock.OffsetMinutes);
}

public class CalendarService(IAppDbContext db, ICurrentContext ctx, AppClock clock, ProjectAccess access,
    ProjectManagement.Application.Features.Organization.ReportingService reporting, PermissionService permissions)
{
    /// <summary>
    /// Regular users see only their own task assignments; a manager's default view adds everyone in their reporting
    /// line (their "team" - empty for someone nobody reports to, which just means "own"); anyone with broad reports
    /// access (Owner/Admin, or a job-role profile that explicitly grants it) sees the whole visible workspace by
    /// default, same as before. Picking one specific person (<paramref name="userId"/>) or the legacy "only my
    /// tasks" flag (<paramref name="mine"/>) both narrow to that one person's tasks alone, dropping project /
    /// milestone / stage events since those aren't personal to begin with.
    /// </summary>
    public async Task<IReadOnlyList<CalendarEventDto>> GetAsync(DateOnly from, DateOnly to, Guid? projectId, bool mine, Guid? userId, CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        var me = ctx.RequireUserId();
        if (to < from) throw new ValidationException("to", "End date must not be before the start date.");
        if (to.DayNumber - from.DayNumber > 62) throw new ValidationException("to", "The date range may span at most 62 days.");
        var today = clock.Today;
        var events = new List<CalendarEventDto>();

        HashSet<Guid>? assignees; bool showWorkspaceEvents;
        if (userId is { } who && who != me)
        {
            if (!await reporting.IsInMyLineAsync(who, ct) && !await permissions.HasBroadReportsAccessAsync(ct))
                throw new ForbiddenException("You can only view the calendar of people in your reporting line.", "PERMISSION_DENIED");
            (assignees, showWorkspaceEvents) = ([who], false);
        }
        else if (mine || userId == me)
            (assignees, showWorkspaceEvents) = ([me], false);
        else if (await permissions.HasBroadReportsAccessAsync(ct))
            (assignees, showWorkspaceEvents) = (null, true);
        else
        {
            var team = (await reporting.ReportsOfAsync(me, tid, ct)).Keys.ToHashSet();
            team.Add(me);
            (assignees, showWorkspaceEvents) = (team, true);
        }

        var tq = access.VisibleTasks().Where(t => t.DueDate != null && t.DueDate >= from && t.DueDate <= to);
        if (projectId is { } pid) tq = tq.Where(t => t.ProjectId == pid);
        if (assignees is { } ids) tq = tq.Where(t => t.AssigneeId != null && ids.Contains(t.AssigneeId.Value));
        var taskRows = await tq.AsNoTracking().OrderBy(t => t.DueDate).Take(500)
            .Select(t => new { t.Id, t.Title, t.DueDate, t.Priority, t.ProjectId, ProjectName = t.Project!.Name, Status = t.Status!.Name, Category = t.Status.Category })
            .ToListAsync(ct);
        events.AddRange(taskRows.Select(t => new CalendarEventDto("task", t.Id, t.Title, t.DueDate!.Value, t.Status, t.Category,
            t.Category is not (StatusCategory.Done or StatusCategory.Cancelled) && t.DueDate < today, t.ProjectId, t.ProjectName, t.Priority)));

        if (showWorkspaceEvents)
        {
            var pq = access.VisibleProjects().Where(p => p.DueDate != null && p.DueDate >= from && p.DueDate <= to
                                                        && p.Status != ProjectStatus.Cancelled && p.Status != ProjectStatus.Archived);
            if (projectId is { } only) pq = pq.Where(p => p.Id == only);
            var projectRows = await pq.AsNoTracking().Select(p => new { p.Id, p.Name, p.DueDate, p.Status }).ToListAsync(ct);
            events.AddRange(projectRows.Select(p => new CalendarEventDto("project", p.Id, p.Name, p.DueDate!.Value, p.Status.ToString(), null,
                p.Status != ProjectStatus.Completed && p.DueDate < today, p.Id, p.Name, null)));

            var visibleForMilestones = access.VisibleProjects().Select(p => p.Id);
            var mq = db.Milestones.Where(m => m.DueDate != null && m.DueDate >= from && m.DueDate <= to && visibleForMilestones.Contains(m.ProjectId));
            if (projectId is { } mp) mq = mq.Where(m => m.ProjectId == mp);
            var milestoneRows = await mq.AsNoTracking().OrderBy(m => m.DueDate).ThenBy(m => m.Name).Take(200)
                .Select(m => new { m.Id, m.Name, m.DueDate, m.Status, m.ProjectId, ProjectName = db.Projects.Where(p => p.Id == m.ProjectId).Select(p => p.Name).FirstOrDefault() })
                .ToListAsync(ct);
            events.AddRange(milestoneRows.Select(m => new CalendarEventDto("milestone", m.Id, m.Name, m.DueDate!.Value, m.Status.ToString(), null,
                m.Status != StageStatus.Completed && m.DueDate < today, m.ProjectId, m.ProjectName, null)));

            var visible = access.VisibleProjects().Select(p => p.Id);
            var sq = db.ProjectStages.Where(s => s.PlannedEnd != null && s.PlannedEnd >= from && s.PlannedEnd <= to
                                                && s.Status != StageStatus.Completed && visible.Contains(s.ProjectId));
            if (projectId is { } sp) sq = sq.Where(s => s.ProjectId == sp);
            var stageRows = await sq.AsNoTracking().Take(200)
                .Select(s => new { s.Id, s.Name, s.PlannedEnd, s.Status, s.ProjectId, ProjectName = db.Projects.Where(p => p.Id == s.ProjectId).Select(p => p.Name).FirstOrDefault() })
                .ToListAsync(ct);
            events.AddRange(stageRows.Select(s => new CalendarEventDto("stage", s.Id, s.Name, s.PlannedEnd!.Value, s.Status.ToString(), null,
                s.PlannedEnd < today, s.ProjectId, s.ProjectName, null)));
        }
        return events.OrderBy(e => e.Date).ThenBy(e => e.Type).ToList();
    }
}

public class SearchService(IAppDbContext db, ICurrentContext ctx, ProjectAccess access, PermissionService permissions)
{
    private const int PerType = 5;

    public async Task<SearchResultDto> SearchAsync(string query, CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        var q = query.Trim().ToLowerInvariant();
        if (q.Length < 2) return new SearchResultDto([]);
        var hits = new List<SearchHit>();
        var lv = await permissions.LevelsAsync(ct); // results only come from areas the person's job role can open

        var tasks = lv[Modules.Tasks] == 0 ? [] : await access.VisibleTasks().AsNoTracking()
            .Where(t => t.Title.ToLower().Contains(q) || (t.Description != null && t.Description.ToLower().Contains(q)))
            .OrderByDescending(t => t.UpdatedAt ?? t.CreatedAt).Take(PerType)
            .Select(t => new { t.Id, t.Title, t.ProjectId, t.Number, Key = t.Project!.Key, Status = t.Status!.Name }).ToListAsync(ct);
        hits.AddRange(tasks.Select(t => new SearchHit("task", t.Id, t.Title, $"{t.Key}-{t.Number} · {t.Status}", t.ProjectId, t.Id)));

        var projects = lv[Modules.Projects] == 0 ? [] : await access.VisibleProjects().AsNoTracking()
            .Where(p => p.Name.ToLower().Contains(q) || p.Key.ToLower().Contains(q) || (p.Description != null && p.Description.ToLower().Contains(q)))
            .OrderBy(p => p.Name).Take(PerType).Select(p => new { p.Id, p.Name, p.Key, p.Status }).ToListAsync(ct);
        hits.AddRange(projects.Select(p => new SearchHit("project", p.Id, p.Name, $"{p.Key} · {p.Status}", p.Id, null)));

        var teams = lv[Modules.Teams] == 0 ? [] : await db.Teams.AsNoTracking().Where(t => t.Name.ToLower().Contains(q)).OrderBy(t => t.Name).Take(PerType).ToListAsync(ct);
        hits.AddRange(teams.Select(t => new SearchHit("team", t.Id, t.Name, t.Description, null, null)));

        if (!access.IsRestricted && lv[Modules.Members] > 0)
        {
            var users = await (from m in db.TenantMembers join u in db.Users on m.UserId equals u.Id
                               where m.TenantId == tid && (u.DisplayName.ToLower().Contains(q) || u.Email.ToLower().Contains(q))
                               orderby u.DisplayName select new { u.Id, u.DisplayName, u.Email, m.Role }).AsNoTracking().Take(PerType).ToListAsync(ct);
            hits.AddRange(users.Select(u => new SearchHit("member", u.Id, u.DisplayName, $"{u.Email} · {u.Role}", null, null)));

        }

        if (!access.IsRestricted && lv[Modules.Tasks] > 0)
        {
            var visibleTasks = access.VisibleTasks().Select(t => t.Id);
            var comments = await db.TaskComments.AsNoTracking().Where(c => c.Body.ToLower().Contains(q) && visibleTasks.Contains(c.TaskId))
                .OrderByDescending(c => c.CreatedAt).Take(PerType)
                .Select(c => new { c.Id, c.Body, c.TaskId, ProjectId = db.Tasks.Where(t => t.Id == c.TaskId).Select(t => t.ProjectId).FirstOrDefault() })
                .ToListAsync(ct);
            hits.AddRange(comments.Select(c => new SearchHit("comment", c.Id, Text.Truncate(c.Body, 90)!, "Comment", c.ProjectId, c.TaskId)));
        }

        var labels = lv[Modules.Tasks] == 0 && lv[Modules.Projects] == 0 ? [] : await db.Labels.AsNoTracking().Where(l => l.Name.ToLower().Contains(q)).OrderBy(l => l.Name).Take(PerType).ToListAsync(ct);
        hits.AddRange(labels.Select(l => new SearchHit("label", l.Id, l.Name, null, null, null)));

        // Files, by name: only those of projects (and tasks) the person can see.
        var seesTasks = lv[Modules.Tasks] > 0;
        var files = lv[Modules.Projects] == 0 ? [] : await db.Attachments.AsNoTracking()
            .Where(a => a.FileName.ToLower().Contains(q) && access.VisibleProjects().Any(p => p.Id == a.ProjectId)
                        && (a.TaskId == null || (seesTasks && access.VisibleTasks().Any(t => t.Id == a.TaskId))))
            .OrderByDescending(a => a.CreatedAt).Take(PerType)
            .Select(a => new { a.Id, a.FileName, a.ProjectId, a.TaskId, a.SizeBytes }).ToListAsync(ct);
        hits.AddRange(files.Select(f => new SearchHit("file", f.Id, f.FileName, f.SizeBytes >= 1024 * 1024 ? $"{f.SizeBytes / 1048576.0:0.#} MB" : $"{Math.Max(1, f.SizeBytes / 1024)} KB", f.ProjectId, f.TaskId)));
        return new SearchResultDto(hits);
    }
}

public class ReportService(IAppDbContext db, ICurrentContext ctx, AppClock clock, ProjectAccess access, ProjectService projects,
    PermissionService permissions, EntitlementService entitlements)
{
    public static async Task<IReadOnlyList<WorkloadItem>> BuildWorkloadAsync(IAppDbContext db, ProjectAccess access, DateOnly today, IReadOnlySet<Guid>? restrictTo, CancellationToken ct)
    {
        var rows = await access.VisibleTasks().Where(t => t.AssigneeId != null && (restrictTo == null || restrictTo.Contains(t.AssigneeId.Value)))
            .GroupBy(t => new { Id = t.AssigneeId!.Value, t.Status!.Category, Overdue = t.DueDate != null && t.DueDate < today })
            .Select(g => new { g.Key.Id, g.Key.Category, g.Key.Overdue, Count = g.Count() }).ToListAsync(ct);
        var ids = rows.Select(r => r.Id).Distinct().ToList();
        var names = await db.Users.Where(u => ids.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        return ids.Select(id =>
        {
            var mine = rows.Where(r => r.Id == id).ToList();
            var open = mine.Where(r => r.Category is not (StatusCategory.Done or StatusCategory.Cancelled)).ToList();
            return new WorkloadItem(id, names.GetValueOrDefault(id, "Unknown"), open.Sum(r => r.Count), open.Where(r => r.Overdue).Sum(r => r.Count),
                mine.Where(r => r.Category == StatusCategory.Done).Sum(r => r.Count));
        }).OrderByDescending(w => w.Open).ToList();
    }

    public async Task<ReportSummaryDto> GetSummaryAsync(int days, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.ReportsView, ct);
        ctx.RequireTenantId();
        days = Math.Clamp(days, 1, 90);
        var today = clock.Today;

        var byCategory = await access.VisibleTasks()
            .GroupBy(t => new { t.Status!.Category, Overdue = t.DueDate != null && t.DueDate < today })
            .Select(g => new { g.Key.Category, g.Key.Overdue, Count = g.Count() }).ToListAsync(ct);
        int Sum(Func<StatusCategory, bool> f) => byCategory.Where(r => f(r.Category)).Sum(r => r.Count);
        var total = byCategory.Sum(r => r.Count);
        var completed = Sum(c => c == StatusCategory.Done);
        var cancelled = Sum(c => c == StatusCategory.Cancelled);
        var overdue = byCategory.Where(r => r.Overdue && r.Category is not (StatusCategory.Done or StatusCategory.Cancelled)).Sum(r => r.Count);
        var denominator = total - cancelled;
        var totals = new ReportTotals(total, completed, Sum(c => c == StatusCategory.Todo), Sum(c => c == StatusCategory.Active),
            overdue, cancelled, denominator <= 0 ? 0 : (int)Math.Round(completed * 100.0 / denominator));

        var since = clock.Now.AddDays(-Math.Max(days, 30) - 1);
        var completions = await access.VisibleTasks().Where(t => t.CompletedAt != null && t.CompletedAt >= since)
            .Select(t => t.CompletedAt!.Value).ToListAsync(ct);
        var localDates = completions.Select(d => DateOnly.FromDateTime(d.AddMinutes(clock.OffsetMinutes))).ToList();
        var perDay = Enumerable.Range(0, days).Select(i => today.AddDays(-(days - 1 - i)))
            .Select(d => new DayCount(d, localDates.Count(x => x == d))).ToList();

        var list = await projects.ListAsync(new ProjectQuery(null, null, null, null, null, Sort: "name", PageSize: 100), ct);
        var progress = list.Items.Select(p => new ProjectProgressItem(p.Id, p.Key, p.Name, p.Progress, p.Health, p.DueDate, p.Stats.Total, p.Stats.Done)).ToList();

        var advanced = await entitlements.GetValueAsync(FeatureKeys.AdvancedReports, ct) != 0;
        var workload = advanced && ctx.WorkspaceType == WorkspaceType.Organization ? await BuildWorkloadAsync(db, access, today, null, ct) : null;

        return new ReportSummaryDto(days, totals, perDay,
            Enum.GetValues<StatusCategory>().Select(c => new StatusCount(c, Sum(x => x == c))).Where(s => s.Count > 0).ToList(), progress,
            localDates.Count(d => d >= today.AddDays(-6)), localDates.Count(d => d >= today.AddDays(-29)), workload, advanced);
    }

    public async Task<string> ExportTasksCsvAsync(CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.ReportsView, ct);
        var rows = await access.VisibleTasks().AsNoTracking().OrderBy(t => t.ProjectId).ThenBy(t => t.Number).Take(10_000)
            .Select(t => new
            {
                ProjectKey = t.Project!.Key, t.Number, t.Title, Status = t.Status!.Name, t.Priority, Assignee = t.Assignee!.DisplayName,
                Reporter = t.Reporter!.DisplayName, t.StartDate, t.DueDate, t.EstimatedHours, t.ActualHours, t.CreatedAt, t.CompletedAt,
            }).ToListAsync(ct);

        var sb = new StringBuilder("Key,Title,Status,Priority,Assignee,Reporter,Start date,Due date,Estimated hours,Actual hours,Created,Completed\r\n");
        foreach (var r in rows)
            sb.AppendJoin(',', Csv($"{r.ProjectKey}-{r.Number}"), Csv(r.Title), Csv(r.Status), Csv(r.Priority.ToString()), Csv(r.Assignee), Csv(r.Reporter),
                Csv(r.StartDate?.ToString("yyyy-MM-dd")), Csv(r.DueDate?.ToString("yyyy-MM-dd")), Csv(r.EstimatedHours?.ToString()), Csv(r.ActualHours?.ToString()),
                Csv(r.CreatedAt.ToString("u")), Csv(r.CompletedAt?.ToString("u"))).Append("\r\n");
        return sb.ToString();
    }

    /// <summary>Quotes a CSV cell and neutralises spreadsheet formula injection.</summary>
    private static string Csv(string? value)
    {
        if (string.IsNullOrEmpty(value)) return "";
        if (value[0] is '=' or '+' or '-' or '@' or '\t' or '\r') value = "'" + value;
        return value.IndexOfAny([',', '"', '\n', '\r']) >= 0 ? $"\"{value.Replace("\"", "\"\"")}\"" : value;
    }
}
