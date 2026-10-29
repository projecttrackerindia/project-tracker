using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using ClosedXML.Excel;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Application.Features.Reports;
using ProjectManagement.Application.Features.WorkItems;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Projects;

/// <summary>
/// One row of the Plan sheet. <see cref="Kind"/>: project (a summary row with roll-up dates, health and progress), task, subtask or meeting
/// (a project meeting: read-only, with its cadence and next occurrence). <see cref="Late"/> and <see cref="AtRisk"/> are worked out here so the
/// sheet, the export and the phone agree: late is an open item past its due date (and time); at risk is an open item due within 3 days and under
/// 70% done, or a project whose forecast lands after its due date.
/// </summary>
public record PlanSheetRowDto(string Kind, Guid Id, Guid ProjectId, Guid? ParentId, int Level, string Key, string Title, Guid? OwnerId, string? Owner,
    DateOnly? Start, DateOnly? Due, string? DueTime, int? DurationDays, string Status, string Category, Guid? StatusId, int? Progress, IReadOnlyList<string> DependsOn,
    string? Cadence, DateTime? NextAt, DateTime? UpdatedAt, string? UpdatedBy, string? Notes, bool Late, bool AtRisk, int Version, bool CanEdit, DateOnly? Forecast = null,
    decimal? EstimatedHours = null, int? ChecklistTotal = null, int? ChecklistDone = null, bool ManualProgress = false, int? SlipDays = null);
public record PlanSheetStatusDto(Guid Id, Guid ProjectId, string Name, string Category);
/// <summary>A "Viewing" choice. Only what exists today is allowed (everything I can see, my work, one team of the team lens); team-scoped views come later.</summary>
public record PlanSheetScopeDto(string Id, string Label, bool Allowed, string? Why = null, Guid? TeamId = null);
public record PlanSheetDto(DateOnly AsOf, string TimeZone, IReadOnlyList<PlanSheetRowDto> Rows, IReadOnlyList<PortfolioChoiceDto> People, IReadOnlyList<PlanSheetStatusDto> Statuses,
    IReadOnlyList<PlanSheetScopeDto> Scopes, bool Truncated, bool CanEdit, bool Meetings);

/// <summary>One row's change. Send only what changes; <see cref="Version"/> is the version the sheet last read (a newer one is a conflict for that row only).</summary>
public record PlanSheetChange(Guid Id, int? Version = null, Guid? AssigneeId = null, bool Unassign = false, DateOnly? StartDate = null, bool ClearStart = false,
    DateOnly? DueDate = null, string? DueTime = null, bool ClearDueTime = false, Guid? StatusId = null, string? Title = null,
    int? Progress = null, bool ClearProgress = false, string? Notes = null);
/// <summary>Many rows at once. One reason covers every due date in the batch that moves later (the existing date-change rule).</summary>
public record PlanSheetBulkRequest(IReadOnlyList<PlanSheetChange>? Changes, string? DueDateReason = null, string? DueDateDependency = null);
public record PlanSheetRowResultDto(Guid Id, string? Key, bool Ok, string? Error = null, string? Field = null, string? Code = null, int? Version = null);
public record PlanSheetBulkResultDto(int Changed, int Failed, IReadOnlyList<PlanSheetRowResultDto> Rows);

/// <summary>
/// A row dragged on the sheet: to a new place among its project's tasks (between <see cref="AfterId"/> and <see cref="BeforeId"/>), or into another
/// project (<see cref="ProjectId"/>), where it takes the next number and the column of the same name, else of the same kind.
/// </summary>
public record PlanSheetMoveRequest(Guid Id, Guid? ProjectId = null, Guid? AfterId = null, Guid? BeforeId = null, int? Version = null);
public record PlanSheetMoveResultDto(Guid Id, string Key, Guid ProjectId, int Version, double Position, bool MovedProject);

/// <summary>A row pasted from Excel, already split into the sheet's columns by the client's column mapping (values exactly as typed).</summary>
public record PlanSheetPasteRow(string? Title, string? Owner = null, string? Start = null, string? Due = null, string? Status = null);
/// <summary>Dry run (Commit false) says what each row would do; Commit saves the rows listed in <see cref="Include"/> (all ready rows when null).</summary>
public record PlanSheetPasteRequest(Guid ProjectId, IReadOnlyList<PlanSheetPasteRow>? Rows, bool Commit = false, IReadOnlyList<int>? Include = null, string? DueDateReason = null);
/// <summary><see cref="Action"/>: create, update (the title matched an existing task) or error. <see cref="OwnerMatch"/>: exact, fuzzy, none or empty.</summary>
public record PlanSheetPasteResultRowDto(int Index, string Action, string Title, Guid? OwnerId, string? Owner, string OwnerMatch, DateOnly? Start, DateOnly? Due,
    Guid? StatusId, string? Status, Guid? MatchedId, string? MatchedKey, string? Change, IReadOnlyList<string> Problems, bool Ready, bool NeedsReason,
    bool Saved = false, Guid? SavedId = null, string? Error = null);
public record PlanSheetPasteResultDto(Guid ProjectId, string ProjectKey, string ProjectName, bool Committed, int Ready, int Problems, int Saved, IReadOnlyList<PlanSheetPasteResultRowDto> Rows);

/// <summary>
/// Portfolio › Plan sheet: every project the person can see with its tasks, sub-items and meetings in one grid, edited like a spreadsheet. Reading
/// follows the same visibility as the rest of the Portfolio (the team lens and the portfolio filters); every write goes through the item's own path
/// (<see cref="WorkItemApiService.PatchAsync"/> for tasks, <see cref="ProjectService.UpdateAsync"/> for projects), one row at a time, so permissions,
/// workflow, the due-date reason rule and version checks apply exactly as when the row is edited on its own. What fails is reported per row.
/// </summary>
public class PlanSheetService(IAppDbContext db, ICurrentContext ctx, AppClock clock, AiPortfolio portfolio, ProjectAccess access, WorkItemApiService work,
    ProjectService projects, Recorder recorder, PermissionService permissions)
{
    public const int MaxRows = 5000, MaxBulk = 500, MaxPaste = 500;

    // ---------------------------------------------------------------- read

    public async Task<PlanSheetDto> GetAsync(PortfolioFilter filter, bool mine = false, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var brief = await portfolio.BriefAsync(filter.TeamId, ct);
        var lens = await access.RequireLensAsync(filter.TeamId, ct);
        var meta = await access.LensProjects(lens).AsNoTracking().Where(p => p.Status != ProjectStatus.Archived && p.Status != ProjectStatus.Completed && p.Status != ProjectStatus.Cancelled)
            .Select(p => new { p.Id, p.OwnerId, p.ProjectGroupId, p.Version, p.UpdatedAt, p.UpdatedBy, p.CreatedAt, p.Description }).Take(500).ToListAsync(ct);
        var byId = meta.ToDictionary(m => m.Id);
        var ranked = brief.Ranked.Where(r => byId.ContainsKey(r.ProjectId)
            && (filter.OwnerId is null || byId[r.ProjectId].OwnerId == filter.OwnerId)
            && (filter.GroupId is null || byId[r.ProjectId].ProjectGroupId == filter.GroupId)
            && (string.IsNullOrWhiteSpace(filter.Health) || string.Equals(r.Health, filter.Health, StringComparison.OrdinalIgnoreCase))
            && (filter.DueFrom is null || r.DueDate >= filter.DueFrom) && (filter.DueTo is null || r.DueDate <= filter.DueTo))
            .OrderBy(r => r.Name).ToList();
        var ids = ranked.Select(r => r.ProjectId).ToList();
        var today = clock.Today;
        var canEdit = ctx.Role is not (null or TenantRole.Guest);

        var tasks = ids.Count == 0 ? [] : await access.VisibleTasks().AsNoTracking().Where(t => ids.Contains(t.ProjectId))
            .OrderBy(t => t.ProjectId).ThenBy(t => t.Position).ThenBy(t => t.Number)
            .Select(t => new { t.Id, t.ProjectId, t.ParentTaskId, t.Number, t.Title, t.AssigneeId, t.StartDate, t.DueDate, t.DueTime, t.StatusId, StatusName = t.Status!.Name,
                Cat = t.Status.Category, t.Version, t.UpdatedAt, t.UpdatedBy, t.CreatedAt, t.CreatedBy, t.Description, t.EstimatedHours, t.ManualProgress })
            .Take(MaxRows + 1).ToListAsync(ct);
        var truncated = tasks.Count > MaxRows || brief.Truncated;
        tasks = tasks.Take(MaxRows).ToList();
        var taskIds = tasks.Select(t => t.Id).ToHashSet();

        var checklists = ids.Count == 0 ? [] : await (from c in db.ChecklistItems.AsNoTracking()
                                                      join t in access.VisibleTasks().AsNoTracking() on c.TaskId equals t.Id
                                                      where ids.Contains(t.ProjectId)
                                                      group c by c.TaskId into g
                                                      select new { TaskId = g.Key, Total = g.Count(), Done = g.Count(x => x.IsDone) }).ToListAsync(ct);
        var checks = checklists.ToDictionary(c => c.TaskId, c => (c.Total, c.Done));
        var deps = ids.Count == 0 ? [] : await (from d in db.TaskDependencies.AsNoTracking()
                                                join t in access.VisibleTasks().AsNoTracking() on d.TaskId equals t.Id
                                                join o in access.VisibleTasks().AsNoTracking() on d.DependsOnTaskId equals o.Id
                                                where ids.Contains(t.ProjectId)
                                                select new { d.TaskId, o.Number, Key = o.Project!.Key }).ToListAsync(ct);
        var depsBy = deps.GroupBy(d => d.TaskId).ToDictionary(g => g.Key, g => (IReadOnlyList<string>)g.Select(d => $"{d.Key}-{d.Number}").Distinct().OrderBy(k => k).ToList());
        // Slip: how far the due date has moved from the first one it had (the date history), shown as "+3d" next to the dates.
        var firstDue = ids.Count == 0 ? [] : await db.DueDateChanges.AsNoTracking().Where(d => ids.Contains(d.ProjectId) && d.TaskId != null && d.Previous != null)
            .OrderBy(d => d.CreatedAt).Select(d => new { TaskId = d.TaskId!.Value, d.Previous }).Take(20000).ToListAsync(ct);
        var originalDue = new Dictionary<Guid, DateOnly>();
        foreach (var d in firstDue) originalDue.TryAdd(d.TaskId, d.Previous!.Value);
        var statuses = ids.Count == 0 ? [] : await db.WorkflowStatuses.AsNoTracking().Where(s => ids.Contains(s.ProjectId)).OrderBy(s => s.ProjectId).ThenBy(s => s.Order)
            .Select(s => new PlanSheetStatusDto(s.Id, s.ProjectId, s.Name, s.Category.ToString())).ToListAsync(ct);

        // Meetings: read their cadence only (no meeting services are called).
        var meetings = ids.Count == 0 ? [] : await db.ProjectMeetings.AsNoTracking().Where(m => ids.Contains(m.ProjectId) && m.Status == MeetingStatus.Scheduled)
            .OrderBy(m => m.StartTimeUtc).Select(m => new { m.Id, m.ProjectId, m.Title, m.OrganizerUserId, m.StartTimeUtc, m.EndTimeUtc, m.RecurrenceRule, m.UpdatedAt, m.CreatedAt, m.Description })
            .Take(500).ToListAsync(ct);

        var tenant = ctx.RequireTenantId();
        var people = await (from m in db.TenantMembers.AsNoTracking()
                            join u in db.Users.AsNoTracking() on m.UserId equals u.Id
                            where m.TenantId == tenant && m.Role != TenantRole.Guest
                            orderby u.DisplayName
                            select new PortfolioChoiceDto(u.Id, u.DisplayName)).Take(2000).ToListAsync(ct);
        var nameIds = tasks.Select(t => t.UpdatedBy ?? t.CreatedBy).Concat(meta.Select(m => m.UpdatedBy)).Concat(tasks.Select(t => t.AssigneeId)).Concat(meta.Select(m => (Guid?)m.OwnerId))
            .Concat(meetings.Select(m => (Guid?)m.OrganizerUserId)).Where(x => x != null).Select(x => x!.Value).Distinct().ToList();
        var names = people.ToDictionary(p => p.Id, p => p.Name);
        foreach (var missing in await db.Users.AsNoTracking().Where(u => nameIds.Contains(u.Id)).Select(u => new { u.Id, u.DisplayName }).ToListAsync(ct)) names[missing.Id] = missing.DisplayName;
        string? Name(Guid? id) => id is { } x ? names.GetValueOrDefault(x) : null;

        var byParent = tasks.Where(t => t.ParentTaskId != null).GroupBy(t => t.ParentTaskId!.Value).ToDictionary(g => g.Key, g => g.ToList());
        var rows = new List<PlanSheetRowDto>();
        foreach (var r in ranked)
        {
            var m = byId[r.ProjectId];
            var mine0 = tasks.Where(t => t.ProjectId == r.ProjectId).ToList();
            if (mine && m.OwnerId != me && !mine0.Any(t => t.AssigneeId == me)) continue;
            var health = r.Health;
            var slip = TimelineForecast.Slip(r.DueDate, r.ProjectedFinish);
            rows.Add(new PlanSheetRowDto("project", r.ProjectId, r.ProjectId, null, 0, r.Key, r.Name, m.OwnerId, r.Owner, r.StartDate, r.DueDate, null,
                PlanSheetMath.Duration(r.StartDate, r.DueDate), PlanSheetMath.HealthLabel(health), health, null, r.Progress, [], null, null, m.UpdatedAt ?? m.CreatedAt, Name(m.UpdatedBy),
                slip > 0 ? $"Forecast slipping {slip}d" : PlanSheetMath.FirstLine(m.Description), health == "Delayed", health == "AtRisk" || (health != "Delayed" && slip > 0), m.Version, canEdit, r.ProjectedFinish));
            var visible = new HashSet<Guid>(mine0.Select(t => t.Id));
            // Top-level tasks, and tasks whose parent the person cannot see, start a branch; sub-items follow their parent (any depth, shown one level in).
            var roots = mine0.Where(t => t.ParentTaskId is null || !visible.Contains(t.ParentTaskId.Value)).ToList();
            foreach (var t in roots) AddTask(t.Id, 1);
            void AddTask(Guid id, int level)
            {
                var t = mine0.First(x => x.Id == id);
                var subs = byParent.GetValueOrDefault(id) ?? [];
                if (!mine || t.AssigneeId == me || subs.Any(s => s.AssigneeId == me) || m.OwnerId == me)
                {
                    var open = t.Cat is not (StatusCategory.Done or StatusCategory.Cancelled);
                    var check = checks.TryGetValue(t.Id, out var c) ? c : ((int Total, int Done)?)null;
                    var progress = PlanSheetMath.Progress(t.Cat, check, subs.Count, subs.Count(s => s.Cat == StatusCategory.Done), t.ManualProgress);
                    var late = open && clock.IsPastDue(t.DueDate, t.DueTime);
                    var risk = open && !late && PlanSheetMath.AtRisk(t.DueDate, today, progress);
                    rows.Add(new PlanSheetRowDto(level == 1 ? "task" : "subtask", t.Id, t.ProjectId, t.ParentTaskId, Math.Min(level, 2), $"{r.Key}-{t.Number}", t.Title, t.AssigneeId, Name(t.AssigneeId),
                        t.StartDate, t.DueDate, t.DueTime?.ToString("HH:mm", CultureInfo.InvariantCulture), PlanSheetMath.Duration(t.StartDate, t.DueDate), t.StatusName, t.Cat.ToString(), t.StatusId, progress,
                        depsBy.GetValueOrDefault(t.Id) ?? [], null, null, t.UpdatedAt ?? t.CreatedAt, Name(t.UpdatedBy ?? t.CreatedBy), PlanSheetMath.FirstLine(t.Description), late, risk, t.Version, canEdit, null,
                        t.EstimatedHours, check?.Total, check?.Done, t.ManualProgress is not null && t.Cat != StatusCategory.Done,
                        t.DueDate is { } due && originalDue.TryGetValue(t.Id, out var first) && due > first ? due.DayNumber - first.DayNumber : null));
                }
                foreach (var s in subs) AddTask(s.Id, level + 1);
            }
            foreach (var mt in meetings.Where(x => x.ProjectId == r.ProjectId))
            {
                var (cadence, next) = PlanSheetMath.Cadence(mt.RecurrenceRule, mt.StartTimeUtc, clock.Now);
                if (next is null) continue;   // a one-off meeting that has passed
                rows.Add(new PlanSheetRowDto("meeting", mt.Id, mt.ProjectId, null, 1, "MTG", mt.Title, mt.OrganizerUserId, Name(mt.OrganizerUserId), null, null, null, null,
                    "Scheduled", "Meeting", null, null, [], cadence, next, mt.UpdatedAt ?? mt.CreatedAt, null,
                    PlanSheetMath.FirstLine(mt.Description) ?? $"{Math.Max(0, (int)(mt.EndTimeUtc - mt.StartTimeUtc).TotalMinutes)} min", false, false, 0, false));
            }
        }
        var scopes = new List<PlanSheetScopeDto>
        {
            new("all", lens is null ? "Everything I can see" : "This team", true),
            new("mine", "My work", true),
            new("managed", "Teams I manage", false, "Comes with the organisation tree"),
        };
        foreach (var t in await access.LensTeamsAsync(ct)) scopes.Add(new PlanSheetScopeDto("team", t.Name, true, null, t.Id));
        return new PlanSheetDto(today, clock.ZoneId, rows, people, statuses, scopes, truncated, canEdit, meetings.Count > 0);
    }

    // ---------------------------------------------------------------- bulk edit

    /// <summary>
    /// Each change goes through the row's own path, one at a time: a task through the Work API's PATCH (with the batch's due-date reason when its due
    /// date moves), a project through its own update. A row that fails (no permission, version conflict, a later due date without a reason, a
    /// column the project does not have) is reported with the reason and changes nothing; the rest are saved.
    /// </summary>
    public async Task<PlanSheetBulkResultDto> BulkAsync(PlanSheetBulkRequest req, CancellationToken ct = default)
    {
        ctx.RequireTenantId();
        var changes = (req.Changes ?? []).GroupBy(c => c.Id).Select(g => g.Last()).ToList();
        if (changes.Count == 0) throw new ValidationException("changes", "Choose at least one row to change.");
        if (changes.Count > MaxBulk) throw new ValidationException("changes", $"Change at most {MaxBulk} rows at a time.");
        var reason = string.IsNullOrWhiteSpace(req.DueDateReason) ? null : req.DueDateReason.Trim();
        var dependency = string.IsNullOrWhiteSpace(req.DueDateDependency) ? null : req.DueDateDependency.Trim();
        var ids = changes.Select(c => c.Id).ToList();
        var items = await db.WorkItems.AsNoTracking().Where(w => ids.Contains(w.Id)).ToDictionaryAsync(w => w.Id, ct);
        var projectRows = await access.VisibleProjects().AsNoTracking().Where(p => ids.Contains(p.Id)).ToDictionaryAsync(p => p.Id, ct);
        var results = new List<PlanSheetRowResultDto>();
        var changed = 0;
        foreach (var c in changes)
        {
            string? key = null;
            try
            {
                if (projectRows.TryGetValue(c.Id, out var p))
                {
                    key = p.Key;
                    if (c.Unassign) throw new ValidationException("ownerId", "A project always has an owner.");
                    if (c.StatusId is not null || c.Title is not null || c.DueTime is not null || c.ClearDueTime || c.Progress is not null || c.ClearProgress || c.Notes is not null)
                        throw new ValidationException("changes", "On a project row only the owner and the dates can be changed here.");
                    if (c.AssigneeId is null && c.StartDate is null && !c.ClearStart && c.DueDate is null) throw new ValidationException("changes", "Say what to change.");
                    var d = await projects.UpdateAsync(p.Id, new UpdateProjectRequest(p.Name, p.Description, p.Priority, p.Status, c.AssigneeId ?? p.OwnerId, p.TeamId,
                        c.ClearStart ? null : c.StartDate ?? p.StartDate, c.DueDate ?? p.DueDate, c.Version ?? p.Version, null, p.ProjectGroupId,
                        c.DueDate is not null ? reason : null, c.DueDate is not null ? dependency : null), ct);
                    await db.SaveChangesAsync(ct);
                    results.Add(new(c.Id, key, true, Version: d.Project.Version));
                }
                else if (items.TryGetValue(c.Id, out var item) && item is TaskItem)
                {
                    var version = c.Version ?? item.Version;
                    var progressOnly = c.Progress is not null || c.ClearProgress;
                    if (progressOnly && c.Progress is { } pv && (pv < 0 || pv > 100)) throw new ValidationException("progress", "Progress is between 0 and 100.");
                    var body = Body(c with { Version = version }, item.Version, reason, dependency, item.Description, allowEmpty: progressOnly);
                    if (body is { } b)
                    {
                        var saved = await work.PatchAsync(c.Id, b, ct);
                        key = saved.Key;
                        version = saved.Version;
                        await db.SaveChangesAsync(ct);
                    }
                    if (progressOnly)
                    {
                        // Progress is the sheet's own field: the same edit rights and archive rule as any other change to the task, and its version.
                        var task = await access.VisibleTasks().FirstOrDefaultAsync(t => t.Id == c.Id, ct) ?? throw new NotFoundException("Not found, or you cannot see it.");
                        await permissions.RequireTaskEditAsync(task, ct);
                        await access.EnsureWritableAsync(task.ProjectId, "change its tasks", ct);
                        if (task.Version != version) throw new ConflictException("This task was changed by someone else. Reload and try again.", "VERSION_CONFLICT");
                        db.Tasks.Entry(task).Property(x => x.Version).OriginalValue = version;
                        task.ManualProgress = c.ClearProgress ? null : c.Progress;
                        task.Version++;
                        await db.SaveChangesAsync(ct);
                        version = task.Version;
                        key ??= $"{await db.Projects.Where(p => p.Id == task.ProjectId).Select(p => p.Key).FirstAsync(ct)}-{task.Number}";
                    }
                    recorder.Audit("plansheet.row_updated", "WorkItem", c.Id, newValue: new { c.AssigneeId, c.Unassign, c.StartDate, c.DueDate, c.DueTime, c.StatusId, c.Progress, c.ClearProgress, Notes = c.Notes is not null, Reason = c.DueDate is null ? null : reason });
                    await db.SaveChangesAsync(ct);
                    results.Add(new(c.Id, key, true, Version: version));
                }
                else throw new NotFoundException("Not found, or you cannot see it.");
                changed++;
            }
            catch (AppException ex)
            {
                // Whatever the failed change left half-done stays unsaved: the next row starts clean.
                if (db is DbContext dc) dc.ChangeTracker.Clear();
                var first = ex.Errors.FirstOrDefault();
                results.Add(new(c.Id, key ?? (items.TryGetValue(c.Id, out var i) ? $"#{i.Number}" : null), false, first?.Message ?? ex.Message, first?.Field, ex.Code));
            }
        }
        return new PlanSheetBulkResultDto(changed, results.Count(r => !r.Ok), results);
    }

    private static JsonElement? Body(PlanSheetChange c, int currentVersion, string? reason, string? dependency, string? description = null, bool allowEmpty = false)
    {
        var o = new JsonObject { ["version"] = c.Version ?? currentVersion };
        if (c.Title is { } title) o["title"] = title;
        if (c.Notes is { } notes) o["description"] = PlanSheetMath.ReplaceFirstLine(description, notes);
        if (c.Unassign) o["assigneeId"] = null;
        else if (c.AssigneeId is { } a) o["assigneeId"] = a.ToString();
        if (c.ClearStart) o["startDate"] = null;
        else if (c.StartDate is { } s) o["startDate"] = s.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        if (c.DueDate is { } d) o["dueDate"] = d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        if (c.ClearDueTime) o["dueTime"] = null;
        else if (!string.IsNullOrWhiteSpace(c.DueTime)) o["dueTime"] = c.DueTime.Trim();
        if (c.StatusId is { } sid) o["statusId"] = sid.ToString();
        if (o.Count == 1)
        {
            if (allowEmpty) return null;
            throw new ValidationException("changes", "Say what to change.");
        }
        if (c.DueDate is not null || o.ContainsKey("dueTime"))
        {
            if (reason is not null) o["dueDateReason"] = reason;
            if (dependency is not null) o["dueDateDependency"] = dependency;
        }
        return JsonSerializer.SerializeToElement(o);
    }

    // ---------------------------------------------------------------- drag a row

    /// <summary>
    /// A task dragged to a new place: its position among the tasks of its project (between the two neighbours it was dropped between), or into
    /// another project. Moving project is for a top-level task without sub-items or dependencies (dependencies stay inside one project): it takes
    /// the next number there, the column of the same name (else the first of the same kind) and leaves its stage, milestone and sprint behind.
    /// </summary>
    public async Task<PlanSheetMoveResultDto> MoveAsync(PlanSheetMoveRequest req, CancellationToken ct = default)
    {
        ctx.RequireTenantId();
        var task = await access.VisibleTasks().FirstOrDefaultAsync(t => t.Id == req.Id, ct) ?? throw new NotFoundException("Not found, or you cannot see it.");
        await permissions.RequireTaskEditAsync(task, ct);
        await access.EnsureWritableAsync(task.ProjectId, "move its tasks", ct);
        if (req.Version is { } seen)
        {
            if (task.Version != seen) throw new ConflictException("This task was changed by someone else. Reload and try again.", "VERSION_CONFLICT");
            db.Tasks.Entry(task).Property(x => x.Version).OriginalValue = seen;
        }
        var from = await db.Projects.AsNoTracking().FirstAsync(p => p.Id == task.ProjectId, ct);
        var target = req.ProjectId ?? task.ProjectId;
        var moved = target != task.ProjectId;
        var oldKey = $"{from.Key}-{task.Number}";
        var dest = from;
        if (moved)
        {
            dest = await access.GetProjectAsync(target, ct);
            ProjectAccess.EnsureNotArchived(dest, "add tasks");
            await permissions.RequireAsync(Permissions.TasksCreate, ct);
            if (task.ParentTaskId is not null) throw new ValidationException("projectId", "A sub-item moves with its parent task.");
            if (await db.Tasks.AnyAsync(t => t.ParentTaskId == task.Id, ct)) throw new ValidationException("projectId", "Move its sub-items out first, or move them with it from the project.");
            if (await db.TaskDependencies.AnyAsync(d => d.TaskId == task.Id || d.DependsOnTaskId == task.Id, ct))
                throw new ValidationException("projectId", "Remove its dependencies first: dependencies stay inside one project.");
            var statuses = await db.WorkflowStatuses.Where(s => s.ProjectId == target).OrderBy(s => s.Order).ToListAsync(ct);
            var current = await db.WorkflowStatuses.AsNoTracking().FirstAsync(s => s.Id == task.StatusId, ct);
            var status = statuses.FirstOrDefault(s => PlanSheetMath.Norm(s.Name) == PlanSheetMath.Norm(current.Name)) ?? statuses.FirstOrDefault(s => s.Category == current.Category)
                ?? statuses.FirstOrDefault() ?? throw new ValidationException("projectId", $"{dest.Key} has no columns to put the task in.");
            // Numbers are never reused, deleted tasks included, so the highest number of the target project is read past the soft-delete filter
            // (the project id is the caller's own, checked just above).
            task.Number = (await db.Tasks.IgnoreQueryFilters().Where(t => t.ProjectId == target).MaxAsync(t => (int?)t.Number, ct) ?? 0) + 1;
            task.ProjectId = target;
            task.StatusId = status.Id;
            task.CompletedAt = status.Category == StatusCategory.Done ? task.CompletedAt ?? clock.Now : null;
            task.StageId = null;
            task.MilestoneId = null;
            task.SprintId = null;
            if (task.AssigneeId is { } who) await access.ShareWithAssigneeAsync(target, who, ct);
        }
        // Position between the neighbours it was dropped between (in the target project).
        var after = req.AfterId is { } a ? await db.Tasks.Where(t => t.Id == a && t.ProjectId == target).Select(t => (double?)t.Position).FirstOrDefaultAsync(ct) : null;
        var before = req.BeforeId is { } b ? await db.Tasks.Where(t => t.Id == b && t.ProjectId == target).Select(t => (double?)t.Position).FirstOrDefaultAsync(ct) : null;
        task.Position = PlanSheetMath.Between(after, before, await db.Tasks.Where(t => t.ProjectId == target && t.Id != task.Id).MaxAsync(t => (double?)t.Position, ct));
        task.Version++;
        var key = $"{dest.Key}-{task.Number}";
        if (moved) recorder.Activity("task.moved", "Task", task.Id, $"Moved {oldKey} to {dest.Name} as {key}", target, oldKey, key);
        recorder.Audit("plansheet.row_moved", "WorkItem", task.Id, new { from = from.Id, oldKey }, new { to = target, key, task.Position });
        await db.SaveChangesAsync(ct);
        return new PlanSheetMoveResultDto(task.Id, key, target, task.Version, task.Position, moved);
    }

    // ---------------------------------------------------------------- paste from Excel

    /// <summary>
    /// Rows pasted from Excel into one project. Owners are matched by name (exact, else a unique first-name / initial match such as "Ravi M"); dates
    /// accept 2026-11-07, 7 Nov, 7 Nov 2026 and 7/11/2026 (day first); status matches a column of the project or a plain word (not started, in
    /// progress, done). A row whose title matches a task of the project updates it instead of adding a duplicate. A row with an owner that matches
    /// nobody or a date that is not a date is an error and is never saved. The dry run changes nothing; commit saves the chosen ready rows through the
    /// Work API (create or PATCH, with the reason when an update moves a due date later).
    /// </summary>
    public async Task<PlanSheetPasteResultDto> PasteAsync(PlanSheetPasteRequest req, CancellationToken ct = default)
    {
        var tenant = ctx.RequireTenantId();
        var rows = req.Rows ?? [];
        if (rows.Count == 0) throw new ValidationException("rows", "Paste at least one row.");
        if (rows.Count > MaxPaste) throw new ValidationException("rows", $"Paste at most {MaxPaste} rows at a time.");
        var project = await access.GetProjectAsync(req.ProjectId, ct);
        var people = await (from m in db.TenantMembers.AsNoTracking()
                            join u in db.Users.AsNoTracking() on m.UserId equals u.Id
                            where m.TenantId == tenant && m.Role != TenantRole.Guest
                            select new PortfolioChoiceDto(u.Id, u.DisplayName)).Take(2000).ToListAsync(ct);
        var statuses = await db.WorkflowStatuses.AsNoTracking().Where(s => s.ProjectId == project.Id).OrderBy(s => s.Order).ToListAsync(ct);
        var existing = await access.VisibleTasks().AsNoTracking().Where(t => t.ProjectId == project.Id)
            .Select(t => new { t.Id, t.Number, t.Title, t.DueDate, t.StartDate, t.AssigneeId, t.StatusId, t.Version }).Take(MaxRows).ToListAsync(ct);
        var byTitle = existing.GroupBy(t => PlanSheetMath.Norm(t.Title)).ToDictionary(g => g.Key, g => g.First());
        var include = req.Include?.ToHashSet();
        var reason = string.IsNullOrWhiteSpace(req.DueDateReason) ? null : req.DueDateReason.Trim();
        var outRows = new List<PlanSheetPasteResultRowDto>();
        var seen = new HashSet<string>();
        for (var i = 0; i < rows.Count; i++)
        {
            var r = rows[i];
            var problems = new List<string>();
            var title = (r.Title ?? "").Trim();
            if (title.Length == 0) problems.Add("No title");
            else if (title.Length > 300) problems.Add("Title is longer than 300 characters");
            else if (!seen.Add(PlanSheetMath.Norm(title))) problems.Add("Same title as an earlier pasted row");
            var (ownerId, owner, match) = PlanSheetMath.MatchOwner(r.Owner, people);
            if (match == "none") problems.Add($"Owner unknown: “{r.Owner!.Trim()}”");
            var start = PlanSheetMath.ParseDate(r.Start, clock.Today, out var badStart);
            var due = PlanSheetMath.ParseDate(r.Due, clock.Today, out var badDue);
            if (badStart) problems.Add($"Start “{r.Start!.Trim()}” is not a date");
            if (badDue) problems.Add($"Due “{r.Due!.Trim()}” is not a date");
            if (start is { } s0 && due is { } d0 && d0 < s0) problems.Add("Due is before start");
            var status = PlanSheetMath.MatchStatus(r.Status, statuses.Select(s => (s.Id, s.Name, s.Category)).ToList());
            if (!string.IsNullOrWhiteSpace(r.Status) && status is null) problems.Add($"Status “{r.Status!.Trim()}” is not a column of {project.Key}");
            var hit = title.Length > 0 ? byTitle.GetValueOrDefault(PlanSheetMath.Norm(title)) : null;
            var needsReason = hit is not null && due is not null && DueDateHistory.NeedsReason(hit.DueDate, due);
            string? change = null;
            if (hit is not null)
            {
                var parts = new List<string>();
                if (due is not null && due != hit.DueDate) parts.Add($"due {PlanSheetMath.Day(hit.DueDate)}→{PlanSheetMath.Day(due)}");
                if (start is not null && start != hit.StartDate) parts.Add($"start {PlanSheetMath.Day(hit.StartDate)}→{PlanSheetMath.Day(start)}");
                if (ownerId is not null && ownerId != hit.AssigneeId) parts.Add($"owner → {owner}");
                if (status is { } st && st.Id != hit.StatusId) parts.Add($"status → {st.Name}");
                change = $"Updates {project.Key}-{hit.Number}" + (parts.Count == 0 ? " · no change" : " · " + string.Join(", ", parts));
            }
            else if (match == "fuzzy") change = $"Owner matched → {owner}";
            var ready = problems.Count == 0;
            outRows.Add(new PlanSheetPasteResultRowDto(i, ready ? hit is null ? "create" : "update" : "error", title, ownerId, owner, match, start, due, status?.Id, status?.Name,
                hit?.Id, hit is null ? null : $"{project.Key}-{hit.Number}", change ?? (hit is null ? "New task" : null), problems, ready, needsReason));
        }

        var saved = 0;
        if (req.Commit)
        {
            if (outRows.Any(r => r.Ready && r.NeedsReason && (include is null || include.Contains(r.Index))) && reason is null)
                throw new ValidationException("dueDateReason", "Say why the due dates are moving (for example a dependency, a change in scope or waiting on a client).");
            for (var k = 0; k < outRows.Count; k++)
            {
                var r = outRows[k];
                if (!r.Ready || (include is not null && !include.Contains(r.Index))) continue;
                try
                {
                    if (r.MatchedId is { } id)
                    {
                        var hit = existing.First(t => t.Id == id);
                        var body = new JsonObject { ["version"] = hit.Version };
                        if (r.OwnerId is { } o && o != hit.AssigneeId) body["assigneeId"] = o.ToString();
                        if (r.Start is { } s && s != hit.StartDate) body["startDate"] = s.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
                        if (r.Due is { } d && d != hit.DueDate) { body["dueDate"] = d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture); if (reason is not null) body["dueDateReason"] = reason; }
                        if (r.StatusId is { } st && st != hit.StatusId) body["statusId"] = st.ToString();
                        if (body.Count > 1) await work.PatchAsync(id, JsonSerializer.SerializeToElement(body), ct);
                        outRows[k] = r with { Saved = true, SavedId = id };
                    }
                    else
                    {
                        var made = await work.CreateAsync(new CreateWorkItemRequest("task", r.Title, null, project.Id, r.OwnerId, null, r.Start, r.Due, r.StatusId), ct);
                        outRows[k] = r with { Saved = true, SavedId = made.Id };
                    }
                    await db.SaveChangesAsync(ct);
                    saved++;
                }
                catch (AppException ex)
                {
                    if (db is DbContext dc) dc.ChangeTracker.Clear();
                    outRows[k] = r with { Error = ex.Errors.FirstOrDefault()?.Message ?? ex.Message };
                }
            }
            recorder.Audit("plansheet.pasted", "Project", project.Id, newValue: new { rows = rows.Count, saved });
        }
        return new PlanSheetPasteResultDto(project.Id, project.Key, project.Name, req.Commit, outRows.Count(r => r.Ready), outRows.Count(r => !r.Ready), saved, outRows);
    }

    // ---------------------------------------------------------------- export

    public static readonly string[] Columns = ["Key", "Title", "Owner", "Start", "Due", "Duration", "Status", "Progress", "Depends on", "Meeting", "Updated", "Notes"];

    /// <summary>
    /// The sheet as Excel or CSV: the same rows the screen shows (same visibility and filters), only the visible columns when given, with project › task ›
    /// sub-item kept as outline levels in Excel and late / at-risk dates coloured. Dates are in the workspace time zone, said in the footer.
    /// </summary>
    public async Task<ReportFile> ExportAsync(PortfolioFilter filter, ReportFormat format, IReadOnlyList<string>? columns, bool mine, bool meetings, IReadOnlyList<Guid>? only,
        CancellationToken ct = default)
    {
        if (format is not (ReportFormat.Xlsx or ReportFormat.Csv)) throw new ValidationException("format", "Choose Excel (.xlsx) or CSV (.csv).");
        var sheet = await GetAsync(filter, mine, ct);
        var cols = columns is { Count: > 0 } ? Columns.Where(c => columns.Contains(c, StringComparer.OrdinalIgnoreCase)).ToList() : Columns.ToList();
        if (cols.Count == 0) throw new ValidationException("columns", "Choose at least one column.");
        var keep = only is { Count: > 0 } ? only.ToHashSet() : null;
        var rows = sheet.Rows.Where(r => (meetings || r.Kind != "meeting") && (keep is null || keep.Contains(r.Id))).ToList();
        object? Cell(PlanSheetRowDto r, string c) => c switch
        {
            "Key" => r.Key,
            "Title" => r.Title,
            "Owner" => r.Owner,
            "Start" => r.Start,
            "Due" => r.Due is { } d ? (r.DueTime is { } t ? (object)$"{d:yyyy-MM-dd} {t}" : d) : null,
            "Duration" => r.DurationDays,
            "Status" => r.Kind == "meeting" ? r.Cadence : r.Status,
            "Progress" => r.Progress,
            "Depends on" => string.Join(", ", r.DependsOn),
            "Meeting" => r.Kind == "meeting" ? $"{r.Cadence} · next {(r.NextAt is { } n ? clock.LocalDate(n).ToString("d MMM", CultureInfo.InvariantCulture) : "-")}" : null,
            "Updated" => r.UpdatedAt,
            "Notes" => r.Notes,
            _ => null,
        };
        recorder.Audit("plansheet.exported", "Tenant", ctx.RequireTenantId(), null, new { format = format.ToString(), rows = rows.Count, columns = cols.Count });
        var footer = $"{rows.Count} rows · dates in {sheet.TimeZone} · as of {sheet.AsOf:d MMM yyyy}";
        if (format == ReportFormat.Csv)
            return new ReportFile(ReportWriter.WriteTableCsv(new ReportSection("Plan sheet", cols, rows.Select(r => (IReadOnlyList<object?>)cols.Select(c => Cell(r, c)).ToList()).ToList())), "text/csv", "csv");

        using var wb = new XLWorkbook();
        wb.Properties.Title = "Plan sheet";
        var ws = wb.Worksheets.Add("Plan sheet");
        for (var c = 0; c < cols.Count; c++)
        {
            var h = ws.Cell(1, c + 1);
            h.Value = cols[c];
            h.Style.Font.Bold = true;
            h.Style.Fill.BackgroundColor = XLColor.FromHtml("#F2F2F4");
        }
        var row = 2;
        foreach (var r in rows)
        {
            for (var c = 0; c < cols.Count; c++)
            {
                var cell = ws.Cell(row, c + 1);
                var v = Cell(r, cols[c]);
                switch (v)
                {
                    case null: break;
                    case DateOnly d: cell.Value = d.ToDateTime(TimeOnly.MinValue); cell.Style.DateFormat.Format = "d mmm yyyy"; break;
                    case DateTime t: cell.Value = clock.LocalDate(t).ToDateTime(TimeOnly.MinValue); cell.Style.DateFormat.Format = "d mmm yyyy"; break;
                    case int n: cell.Value = n; break;
                    default: cell.Value = ReportWriter.Safe(ReportWriter.Text(v)); break;
                }
                if (cols[c] == "Due" && (r.Late || r.AtRisk)) { cell.Style.Font.FontColor = XLColor.FromHtml(r.Late ? "#E5342B" : "#E07B00"); cell.Style.Font.Bold = true; }
                if (cols[c] == "Title" && r.Level > 0) cell.Style.Alignment.Indent = r.Level;
            }
            if (r.Kind == "project") { ws.Row(row).Style.Font.Bold = true; ws.Row(row).Style.Fill.BackgroundColor = XLColor.FromHtml("#F2F2F4"); }
            else ws.Row(row).OutlineLevel = Math.Min(r.Level, 2);
            row++;
        }
        ws.Cell(row + 1, 1).Value = footer;
        ws.Cell(row + 1, 1).Style.Font.Italic = true;
        ws.SheetView.FreezeRows(1);
        ws.SheetView.FreezeColumns(Math.Min(2, cols.Count));
        // Widths are set by hand: automatic fitting needs system fonts, which a slim container does not have.
        for (var c = 0; c < cols.Count; c++)
        {
            var longest = rows.Select(r => ReportWriter.Text(Cell(r, cols[c])).Length).DefaultIfEmpty(0).Max();
            ws.Column(c + 1).Width = Math.Clamp(Math.Max(longest, cols[c].Length) * 1.15 + 2, 8, 60);
        }
        using var ms = new MemoryStream();
        wb.SaveAs(ms);
        return new ReportFile(ms.ToArray(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx");
    }
}

/// <summary>The Plan sheet's arithmetic and matching, kept pure so it is the same on every screen and easy to check.</summary>
public static class PlanSheetMath
{
    private static readonly string[] DateFormats = ["yyyy-MM-dd", "d MMM yyyy", "d MMMM yyyy", "d/M/yyyy", "d-M-yyyy", "d.M.yyyy", "d/M/yy", "d MMM yy", "d-MMM-yyyy", "d-MMM-yy", "MMM d yyyy", "MMM d, yyyy"];
    private static readonly string[] ShortFormats = ["d MMM", "d MMMM", "d/M", "d-MMM", "MMM d"];

    public static string Day(DateOnly? d) => d is { } x ? x.ToString("d MMM", CultureInfo.InvariantCulture) : "none";
    public static string Norm(string s) => string.Join(' ', s.Trim().ToLowerInvariant().Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
    public static int? Duration(DateOnly? start, DateOnly? due) => start is { } s && due is { } d && d >= s ? d.DayNumber - s.DayNumber + 1 : null;
    public static string? FirstLine(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        var line = text.Trim().Split('\n')[0].Trim().TrimStart('#', '-', '*', ' ');
        return line.Length > 120 ? line[..117] + "…" : line.Length == 0 ? null : line;
    }

    /// <summary>A position between two neighbours (either may be missing: then just after the one there is, else after the last).</summary>
    public static double Between(double? after, double? before, double? last)
    {
        const double step = 1024;
        return (after, before) switch
        {
            ({ } a, { } b) => (a + b) / 2,
            ({ } a, null) => a + step,
            (null, { } b) => b - step,
            _ => (last ?? 0) + step,
        };
    }

    /// <summary>The note is the description's first line: replace that line and keep the rest of the description as it was.</summary>
    public static string? ReplaceFirstLine(string? description, string note)
    {
        var line = note.Replace("\r", "").Replace('\n', ' ').Trim();
        if (string.IsNullOrWhiteSpace(description)) return line.Length == 0 ? null : line;
        var text = description.Replace("\r\n", "\n");
        var i = text.IndexOf('\n');
        var rest = i < 0 ? "" : text[i..];
        var result = (line + rest).Trim('\n');
        return result.Length == 0 ? null : result;
    }

    public static string HealthLabel(string health) => health switch { "Delayed" => "Late", "AtRisk" => "At risk", "OnHold" => "On hold", "OnTrack" => "On track", _ => health };

    /// <summary>Checklist share when the task has one, else the share of finished sub-items, else 100 for done and 0 for not started (unknown while in progress).</summary>
    public static int? Progress(StatusCategory category, (int Total, int Done)? checklist, int subs, int subsDone, int? manual = null)
    {
        if (category == StatusCategory.Done) return 100;
        if (manual is { } m) return Math.Clamp(m, 0, 100);
        if (checklist is { Total: > 0 } c) return (int)Math.Round(c.Done * 100.0 / c.Total);
        if (subs > 0) return (int)Math.Round(subsDone * 100.0 / subs);
        return category == StatusCategory.Todo ? 0 : null;
    }

    /// <summary>Due within the next 3 days and under 70% done (unknown progress counts as under).</summary>
    public static bool AtRisk(DateOnly? due, DateOnly today, int? progress) =>
        due is { } d && d >= today && d.DayNumber - today.DayNumber <= 3 && (progress ?? 0) < 70;

    /// <summary>
    /// The cadence of a meeting from its recurrence rule (RRULE FREQ / INTERVAL / BYDAY / UNTIL / COUNT) and its next occurrence at or after
    /// <paramref name="now"/>. No rule is "Ad hoc" (next is its start, or null when it has passed).
    /// </summary>
    public static (string Cadence, DateTime? Next) Cadence(string? rule, DateTime start, DateTime now)
    {
        if (string.IsNullOrWhiteSpace(rule)) return ("Ad hoc", start >= now ? start : null);
        var parts = rule.Replace("RRULE:", "", StringComparison.OrdinalIgnoreCase).Split(';', StringSplitOptions.RemoveEmptyEntries)
            .Select(p => p.Split('=', 2)).Where(p => p.Length == 2).ToDictionary(p => p[0].Trim().ToUpperInvariant(), p => p[1].Trim().ToUpperInvariant());
        var freq = parts.GetValueOrDefault("FREQ");
        var interval = int.TryParse(parts.GetValueOrDefault("INTERVAL"), out var iv) && iv > 0 ? iv : 1;
        DateTime? until = parts.TryGetValue("UNTIL", out var u) && DateTime.TryParseExact(u.TrimEnd('Z'), ["yyyyMMdd'T'HHmmss", "yyyyMMdd"], CultureInfo.InvariantCulture,
            DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var ut) ? ut : null;
        var count = int.TryParse(parts.GetValueOrDefault("COUNT"), out var cn) && cn > 0 ? cn : (int?)null;
        var days = parts.TryGetValue("BYDAY", out var bd)
            ? bd.Split(',').Select(x => new string(x.Where(char.IsLetter).ToArray())).Select(x => x switch
                { "MO" => DayOfWeek.Monday, "TU" => DayOfWeek.Tuesday, "WE" => DayOfWeek.Wednesday, "TH" => DayOfWeek.Thursday, "FR" => DayOfWeek.Friday, "SA" => DayOfWeek.Saturday, "SU" => DayOfWeek.Sunday, _ => (DayOfWeek?)null })
                .Where(x => x is not null).Select(x => x!.Value).ToHashSet()
            : [];
        var cadence = freq switch
        {
            "DAILY" => interval == 1 ? "Daily" : $"Every {interval} days",
            "WEEKLY" when interval == 1 && days.Count >= 5 && !days.Contains(DayOfWeek.Saturday) && !days.Contains(DayOfWeek.Sunday) => "Daily",
            "WEEKLY" => interval == 1 ? "Weekly" : interval == 2 ? "Fortnightly" : $"Every {interval} weeks",
            "MONTHLY" => interval == 1 ? "Monthly" : $"Every {interval} months",
            "YEARLY" => "Yearly",
            _ => "Custom",
        };
        // Walk occurrences (bounded) to the first one at or after now.
        var n = 0;
        var cur = start;
        for (var guard = 0; guard < 5000; guard++)
        {
            var candidates = freq == "WEEKLY" && days.Count > 0
                ? Enumerable.Range(0, 7).Select(k => cur.AddDays(k - (int)cur.DayOfWeek + (int)start.DayOfWeek)).Where(x => x >= start && days.Contains(x.DayOfWeek)).OrderBy(x => x).ToList()
                : [cur];
            foreach (var x in candidates)
            {
                n++;
                if (count is { } c && n > c) return (cadence, null);
                if (until is { } un && x > un) return (cadence, null);
                if (x >= now) return (cadence, x);
            }
            cur = freq switch
            {
                "DAILY" => cur.AddDays(interval),
                "WEEKLY" => cur.AddDays(7 * interval),
                "MONTHLY" => cur.AddMonths(interval),
                "YEARLY" => cur.AddYears(interval),
                _ => DateTime.MaxValue,
            };
            if (cur == DateTime.MaxValue) return (cadence, start >= now ? start : null);
        }
        return (cadence, null);
    }

    /// <summary>A pasted date (day first). Empty is no date; <paramref name="bad"/> is set when something was typed that is not a date (11/31).</summary>
    public static DateOnly? ParseDate(string? text, DateOnly today, out bool bad)
    {
        bad = false;
        if (string.IsNullOrWhiteSpace(text)) return null;
        var t = text.Trim();
        if (DateOnly.TryParseExact(t, DateFormats, CultureInfo.InvariantCulture, DateTimeStyles.AllowWhiteSpaces, out var d)) return d;
        // Excel's serial day numbers (1 = 1 Jan 1900, with its 1900 leap-year quirk).
        if (int.TryParse(t, NumberStyles.None, CultureInfo.InvariantCulture, out var serial) && serial is > 20000 and < 80000)
            return DateOnly.FromDateTime(new DateTime(1899, 12, 30).AddDays(serial));
        if (DateOnly.TryParseExact(t + " " + today.Year, ShortFormats.Select(f => f + " yyyy").ToArray(), CultureInfo.InvariantCulture, DateTimeStyles.AllowWhiteSpaces, out var s)) return s;
        bad = true;
        return null;
    }

    /// <summary>Owner by name: exact (case and spacing ignored), else one person whose name starts with every word typed ("Ravi M" → Ravi Menon). Empty is empty.</summary>
    public static (Guid? Id, string? Name, string Match) MatchOwner(string? typed, IReadOnlyList<PortfolioChoiceDto> people)
    {
        if (string.IsNullOrWhiteSpace(typed)) return (null, null, "empty");
        var n = Norm(typed.Trim().Trim('"', '“', '”'));
        var exact = people.Where(p => Norm(p.Name) == n).ToList();
        if (exact.Count == 1) return (exact[0].Id, exact[0].Name, "exact");
        var words = n.Split(' ');
        var fuzzy = people.Where(p =>
        {
            var pw = Norm(p.Name).Split(' ');
            return words.Length <= pw.Length && words.Select((w, i) => pw[i].StartsWith(w, StringComparison.Ordinal)).All(x => x);
        }).ToList();
        if (fuzzy.Count == 1) return (fuzzy[0].Id, fuzzy[0].Name, "fuzzy");
        return (null, null, "none");
    }

    /// <summary>A status by the project's column name, else by a plain word for its kind (not started / to do, in progress, done, cancelled).</summary>
    public static (Guid Id, string Name)? MatchStatus(string? typed, IReadOnlyList<(Guid Id, string Name, StatusCategory Category)> statuses)
    {
        if (string.IsNullOrWhiteSpace(typed)) return null;
        var n = Norm(typed);
        var byName = statuses.FirstOrDefault(s => Norm(s.Name) == n);
        if (byName.Name is not null) return (byName.Id, byName.Name);
        StatusCategory? cat = n switch
        {
            "not started" or "to do" or "todo" or "open" or "new" or "planned" => StatusCategory.Todo,
            "in progress" or "started" or "active" or "doing" or "wip" => StatusCategory.Active,
            "done" or "complete" or "completed" or "closed" or "finished" => StatusCategory.Done,
            "cancelled" or "canceled" or "dropped" => StatusCategory.Cancelled,
            _ => null,
        };
        if (cat is null) return null;
        var hit = statuses.FirstOrDefault(s => s.Category == cat);
        return hit.Name is null ? null : (hit.Id, hit.Name);
    }
}
