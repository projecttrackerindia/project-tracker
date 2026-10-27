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

public enum ProjectHealth { OnTrack, AtRisk, Delayed, Completed, Cancelled, Archived }

public record UserRefDto(Guid Id, string Name);
public record ProjectStatsDto(int Total, int Done, int InProgress, int Todo, int Cancelled, int Overdue);
public record ProjectStatusSummaryDto(string Key, string Name, ProjectStatus Status, int Progress, DateOnly? StartDate, DateOnly? DueDate);
public record ProjectListItemDto(Guid Id, string Key, string Name, string? Description, ProjectStatus Status, Priority Priority,
    UserRefDto? Owner, Guid? TeamId, string? TeamName, DateOnly? StartDate, DateOnly? DueDate, int Progress, ProjectHealth Health,
    ProjectStatsDto Stats, int MemberCount, int Version, double Position, bool EnforceDependencies, Guid? ProjectGroupId = null, string? ProjectGroupName = null, ProjectType ProjectType = ProjectType.Other,
    DeliveryMethod DeliveryMethod = DeliveryMethod.Hybrid, StageScheduleMode StageScheduleMode = StageScheduleMode.Manual,
    int StageCount = 0, int PendingSignOffs = 0, DateTime? UpdatedAt = null);
public record StatusDto(Guid Id, string Name, int Order, StatusCategory Category, string Color);
public record StageDto(Guid Id, string Name, int Order, DateOnly? PlannedStart, DateOnly? PlannedEnd, DateOnly? ActualStart, DateOnly? ActualEnd,
    StageStatus Status, StageStatus EffectiveStatus, UserRefDto? Owner, UserRefDto? Assignee, string? Description,
    int TaskTotal = 0, int TaskDone = 0, bool Locked = false, string? LockedBy = null, int OpenIssues = 0, int TotalIssues = 0, int? DurationDays = null);
public record ProjectMemberDto(Guid UserId, string Name, string Email, TenantRole? Role);
public record ProjectDetailDto(ProjectListItemDto Project, IReadOnlyList<StatusDto> Statuses, IReadOnlyList<StageDto> Stages, IReadOnlyList<ProjectMemberDto> Members);
public record LabelDto(Guid Id, string Name, string Color);

public record CreateProjectRequest(string Name, string? Key, string? Description, Priority Priority, ProjectStatus? Status, Guid? OwnerId,
    Guid? TeamId, DateOnly? StartDate, DateOnly? DueDate, IReadOnlyList<Guid>? MemberIds, string? TimelineTemplate = null, Guid? ProjectGroupId = null, ProjectType? ProjectType = null,
    DeliveryMethod? DeliveryMethod = null, StageScheduleMode? StageScheduleMode = null);
public record UpdateProjectRequest(string Name, string? Description, Priority Priority, ProjectStatus Status, Guid? OwnerId,
    Guid? TeamId, DateOnly? StartDate, DateOnly? DueDate, int Version, bool? EnforceDependencies = null, Guid? ProjectGroupId = null,
    string? DueDateReason = null, string? DueDateDependency = null, ProjectType? ProjectType = null, DeliveryMethod? DeliveryMethod = null, StageScheduleMode? StageScheduleMode = null);
public record ProjectQuery(string? Q, ProjectStatus? Status, Priority? Priority, Guid? OwnerId, Guid? TeamId, bool IncludeArchived = false,
    string? Sort = null, int Page = 1, int PageSize = 25, bool MineOnly = false, Guid? ProjectGroupId = null, ProjectType? ProjectType = null);
public record AddProjectMemberRequest(Guid UserId);
/// <summary>Board move: a new status (column) and/or a new order inside it.</summary>
public record MoveProjectRequest(ProjectStatus Status, double? Position);
/// <summary>A status set by hand: OnTrack, AtRisk or Delayed (empty clears it), why, and until when (optional).</summary>
public record SetProjectHealthRequest(string? Health, string? Note = null, DateOnly? Until = null);
/// <summary>The status shown (Health), the one from dates and progress (Calculated), and the hand-set one when in force.</summary>
public record ProjectHealthDto(string Health, string Calculated, string? Override, string? Note, DateOnly? Until, UserRefDto? SetBy, DateTime? SetAt);
public record UpsertStatusRequest(string Name, StatusCategory Category, string? Color, int? Order);
/// <summary>The whole workflow in its new order: every status of the project exactly once.</summary>
public record ReorderStatusesRequest(IReadOnlyList<Guid> StatusIds);
/// <summary>The whole timeline in its new order: every stage of the project exactly once.</summary>
public record ReorderStagesRequest(IReadOnlyList<Guid> StageIds, string? ScheduleReason = null, int? ProjectVersion = null);
public record UpsertStageRequest(string Name, DateOnly? PlannedStart, DateOnly? PlannedEnd, DateOnly? ActualStart, DateOnly? ActualEnd,
    StageStatus Status, Guid? OwnerId, Guid? AssigneeId, string? Description, int? Order, int? DurationDays = null, string? ScheduleReason = null, int? ProjectVersion = null);
public record UpsertLabelRequest(string Name, string? Color);

public static partial class ProjectMetrics
{
    public static int Progress(ProjectStatsDto s)
    {
        var denominator = s.Total - s.Cancelled;
        return denominator <= 0 ? 0 : (int)Math.Round(s.Done * 100.0 / denominator);
    }

    /// <summary>The share of the project's tasks being worked on right now (the In progress category), so a project with work under way does not look untouched at 0% done.</summary>
    public static int ActiveShare(ProjectStatsDto s)
    {
        var denominator = s.Total - s.Cancelled;
        return denominator <= 0 ? 0 : Math.Min(100 - Progress(s), (int)Math.Round(s.InProgress * 100.0 / denominator));
    }

    /// <summary>Automatically calculated health (progress vs. elapsed time, deadline).</summary>
    public static ProjectHealth Health(Project p, ProjectStatsDto s, DateOnly today)
    {
        switch (p.Status)
        {
            case ProjectStatus.Completed: return ProjectHealth.Completed;
            case ProjectStatus.Cancelled: return ProjectHealth.Cancelled;
            case ProjectStatus.Archived: return ProjectHealth.Archived;
        }
        // A status set by hand stands until its date (or until cleared): the person who knows the project overrides the arithmetic.
        if (p.HealthOverride is { } manual && (p.HealthUntil is not { } until || today <= until) && Enum.TryParse<ProjectHealth>(manual, out var set)
            && set is ProjectHealth.OnTrack or ProjectHealth.AtRisk or ProjectHealth.Delayed) return set;
        return CalculatedHealth(p, s, today);
    }

    /// <summary>The status from dates and progress alone, ignoring a status set by hand.</summary>
    public static ProjectHealth CalculatedHealth(Project p, ProjectStatsDto s, DateOnly today)
    {
        switch (p.Status)
        {
            case ProjectStatus.Completed: return ProjectHealth.Completed;
            case ProjectStatus.Cancelled: return ProjectHealth.Cancelled;
            case ProjectStatus.Archived: return ProjectHealth.Archived;
        }
        var progress = Progress(s);
        // All the work is done: the project reads as Completed everywhere (Projects, Portfolio, Insights), never "On track" at 100%.
        if (s.Total - s.Cancelled > 0 && progress >= 100) return ProjectHealth.Completed;
        if (p.DueDate is { } due && today > due && progress < 100) return ProjectHealth.Delayed;
        if (s.Total > 0)
        {
            if (p.StartDate is { } start && p.DueDate is { } end && end > start)
            {
                var span = end.DayNumber - start.DayNumber;
                var elapsed = Math.Clamp(today.DayNumber - start.DayNumber, 0, span);
                if (progress < (int)Math.Round(elapsed * 100.0 / span) - 15) return ProjectHealth.AtRisk;
            }
            if (p.DueDate is { } d && d.DayNumber - today.DayNumber <= 7 && progress < 85) return ProjectHealth.AtRisk;
        }
        return ProjectHealth.OnTrack;
    }

    /// <summary>
    /// A stage reads as Delayed once its planned end has passed while it is still open - except on a project that is itself finished
    /// (Completed, Cancelled or Archived): there is nothing left to be late for, and a red "Delayed" stage under a 100% complete project
    /// reads as a problem that needs fixing when it is really just a stage nobody walked through the timeline for.
    /// </summary>
    public static StageStatus EffectiveStage(ProjectStage s, DateOnly today, ProjectStatus projectStatus = ProjectStatus.Active) =>
        projectStatus is ProjectStatus.Completed or ProjectStatus.Cancelled or ProjectStatus.Archived ? s.Status
        : s.Status is StageStatus.Pending or StageStatus.InProgress && s.PlannedEnd is { } end && end < today ? StageStatus.Delayed : s.Status;

    [GeneratedRegex("^[A-Z][A-Z0-9]{1,9}$")] public static partial Regex KeyPattern();
}

public partial class ProjectService(
    IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, PermissionService permissions,
    EntitlementService entitlements, ProjectAccess access, TaskCompletionService completion, TimelineTemplateService timelines, DueDateHistory dueHistory,
    ProjectGroupService groupService, NotificationService notifications)
{
    private static readonly (string Name, StatusCategory Category, string Color)[] DefaultStatuses =
    [
        ("Yet To Start", StatusCategory.Todo, "#38bdf8"),
        ("In Progress", StatusCategory.Active, "#8b5cf6"),
        ("Review", StatusCategory.Active, "#fbbf24"),
        ("Testing", StatusCategory.Active, "#c084fc"),
        ("Done", StatusCategory.Done, "#34d399"),
    ];

    // ---------------------------------------------------------------- stats

    public async Task<Dictionary<Guid, ProjectStatsDto>> GetStatsAsync(IReadOnlyCollection<Guid> projectIds, CancellationToken ct = default)
    {
        var today = clock.Today;
        var rows = await db.Tasks.AsNoTracking()
            .Where(t => projectIds.Contains(t.ProjectId) && t.ParentTaskId == null)
            .GroupBy(t => new { t.ProjectId, Category = t.Status!.Category, Overdue = t.DueDate != null && t.DueDate < today })
            .Select(g => new { g.Key.ProjectId, g.Key.Category, g.Key.Overdue, Count = g.Count() })
            .ToListAsync(ct);

        return projectIds.ToDictionary(id => id, id =>
        {
            var mine = rows.Where(r => r.ProjectId == id).ToList();
            int Sum(Func<StatusCategory, bool> cat) => mine.Where(r => cat(r.Category)).Sum(r => r.Count);
            var open = mine.Where(r => r.Category is not (StatusCategory.Done or StatusCategory.Cancelled) && r.Overdue).Sum(r => r.Count);
            return new ProjectStatsDto(mine.Sum(r => r.Count), Sum(c => c == StatusCategory.Done), Sum(c => c == StatusCategory.Active),
                Sum(c => c == StatusCategory.Todo), Sum(c => c == StatusCategory.Cancelled), open);
        });
    }

    /// <summary>
    /// Per project: how many timeline stages it has and how many are not yet signed off (a stage is signed off once its status is Completed).
    /// A project only truly reads as finished when every stage is signed off; until then the UI shows "100% work · N sign-offs pending".
    /// Marking a project Completed with unsigned stages is allowed (the board drags projects freely) - the response carries PendingSignOffs and the UI warns.
    /// </summary>
    public async Task<Dictionary<Guid, (int Total, int Pending)>> GetSignOffsAsync(IReadOnlyCollection<Guid> projectIds, CancellationToken ct = default)
    {
        var rows = await db.ProjectStages.AsNoTracking()
            .Where(s => projectIds.Contains(s.ProjectId))
            .GroupBy(s => s.ProjectId)
            .Select(g => new { ProjectId = g.Key, Total = g.Count(), Pending = g.Count(s => s.Status != StageStatus.Completed) })
            .ToListAsync(ct);
        return projectIds.ToDictionary(id => id, id =>
        {
            var row = rows.FirstOrDefault(r => r.ProjectId == id);
            return row is null ? (0, 0) : (row.Total, row.Pending);
        });
    }

    private ProjectListItemDto ToItem(Project p, string? ownerName, string? teamName, int memberCount, ProjectStatsDto stats, string? groupName = null,
        (int Total, int Pending) signOffs = default) =>
        new(p.Id, p.Key, p.Name, p.Description, p.Status, p.Priority,
            ownerName is null ? null : new UserRefDto(p.OwnerId, ownerName), p.TeamId, teamName, p.StartDate, p.DueDate,
            ProjectMetrics.Progress(stats), ProjectMetrics.Health(p, stats, clock.Today), stats, memberCount, p.Version, p.Position, p.EnforceDependencies, p.ProjectGroupId, groupName, p.ProjectType,
            p.DeliveryMethod, p.StageScheduleMode, signOffs.Total, signOffs.Pending, p.UpdatedAt ?? p.CreatedAt);

    // ---------------------------------------------------------------- queries

    public async Task<PagedResult<ProjectListItemDto>> ListAsync(ProjectQuery query, CancellationToken ct = default)
    {
        ctx.RequireTenantId();
        var q = access.VisibleProjects().AsNoTracking();
        // The Projects page asks for MineOnly: only projects the signed-in person actually belongs to, not every
        // project in the tenant. Other callers (the dashboard widget, the task-creation project picker) keep the
        // wider view they already had - direct links (search, notifications, a task's project) are unaffected
        // either way, since this only narrows what's *listed*, not who may open a specific project.
        if (query.MineOnly) { var uid = ctx.UserId; q = q.Where(p => p.Members.Any(m => m.UserId == uid)); }

        if (query.Status is { } status) q = q.Where(p => p.Status == status);
        else if (!query.IncludeArchived) q = q.Where(p => p.Status != ProjectStatus.Archived);
        if (query.Priority is { } prio) q = q.Where(p => p.Priority == prio);
        if (query.OwnerId is { } owner) q = q.Where(p => p.OwnerId == owner);
        if (query.TeamId is { } team) q = q.Where(p => p.TeamId == team);
        if (query.ProjectGroupId is { } group) q = q.Where(p => p.ProjectGroupId == group);
        if (query.ProjectType is { } kind) q = q.Where(p => p.ProjectType == kind);
        if (!string.IsNullOrWhiteSpace(query.Q))
        {
            var s = query.Q.Trim().ToLowerInvariant();
            q = q.Where(p => EF.Functions.Like(p.Name.ToLower(), SearchText.Pattern(s), SearchText.Escape) || EF.Functions.Like(p.Key.ToLower(), SearchText.Pattern(s), SearchText.Escape) || (p.Description != null && EF.Functions.Like(p.Description.ToLower(), SearchText.Pattern(s), SearchText.Escape)));
        }

        q = query.Sort switch
        {
            "name" => q.OrderBy(p => p.Name),
            "-name" => q.OrderByDescending(p => p.Name),
            "due" => q.OrderBy(p => p.DueDate == null).ThenBy(p => p.DueDate),
            "-due" => q.OrderByDescending(p => p.DueDate),
            "created" => q.OrderByDescending(p => p.CreatedAt),
            "position" => q.OrderBy(p => p.Position).ThenByDescending(p => p.CreatedAt),
            _ => q.OrderByDescending(p => p.UpdatedAt ?? p.CreatedAt),
        };

        var page = new PageQuery(query.Page, query.PageSize);
        var total = await q.CountAsync(ct);
        var rows = await q.Skip((page.SafePage - 1) * page.SafeSize()).Take(page.SafeSize())
            .Select(p => new { Project = p, OwnerName = p.Owner!.DisplayName, TeamName = p.Team!.Name, GroupName = p.Group!.Name, MemberCount = p.Members.Count() })
            .ToListAsync(ct);
        var stats = await GetStatsAsync(rows.Select(r => r.Project.Id).ToList(), ct);
        var signOffs = await GetSignOffsAsync(rows.Select(r => r.Project.Id).ToList(), ct);
        var items = rows.Select(r => ToItem(r.Project, r.OwnerName, r.TeamName, r.MemberCount, stats[r.Project.Id], r.GroupName, signOffs[r.Project.Id])).ToList();
        return new PagedResult<ProjectListItemDto>(items, page.SafePage, page.SafeSize(), total);
    }

    public async Task<ProjectDetailDto> GetAsync(Guid id, CancellationToken ct = default)
    {
        var project = await access.GetProjectAsync(id, ct);
        return await BuildDetailAsync(project, ct);
    }

    /// <summary>The same authorized status and task-derived progress, without loading unrelated project detail.</summary>
    public async Task<ProjectStatusSummaryDto> GetStatusSummaryAsync(Guid id, CancellationToken ct = default)
    {
        var project = await access.VisibleProjects().AsNoTracking().Where(p => p.Id == id)
            .Select(p => new { p.Key, p.Name, p.Status, p.StartDate, p.DueDate }).FirstOrDefaultAsync(ct)
            ?? throw new NotFoundException("Project not found.");
        var stats = (await GetStatsAsync([id], ct))[id];
        return new(project.Key, project.Name, project.Status, ProjectMetrics.Progress(stats), project.StartDate, project.DueDate);
    }

    private async Task<ProjectDetailDto> BuildDetailAsync(Project project, CancellationToken ct)
    {
        var owner = await db.Users.AsNoTracking().Where(u => u.Id == project.OwnerId).Select(u => u.DisplayName).FirstOrDefaultAsync(ct);
        var teamName = project.TeamId is { } tid ? await db.Teams.AsNoTracking().Where(t => t.Id == tid).Select(t => t.Name).FirstOrDefaultAsync(ct) : null;
        var members = await GetMembersAsync(project.Id, ct);
        var stats = (await GetStatsAsync([project.Id], ct))[project.Id];
        var groupName = project.ProjectGroupId is { } gid ? await db.ProjectGroups.AsNoTracking().Where(g => g.Id == gid).Select(g => g.Name).FirstOrDefaultAsync(ct) : null;
        var signOffs = (await GetSignOffsAsync([project.Id], ct))[project.Id];
        return new ProjectDetailDto(ToItem(project, owner, teamName, members.Count, stats, groupName, signOffs),
            await GetStatusesAsync(project.Id, ct), await GetStagesAsync(project.Id, ct), members);
    }

    // ---------------------------------------------------------------- create / update / delete

    public async Task<ProjectDetailDto> CreateAsync(CreateProjectRequest req, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.ProjectsCreate, ct);
        var tid = ctx.RequireTenantId();
        var userId = ctx.RequireUserId();

        var activeCount = await entitlements.ActiveProjectCountAsync(ct);
        await entitlements.EnsureWithinLimitAsync(FeatureKeys.ProjectLimit, activeCount, 1, ct);
        ValidateDates(req.StartDate, req.DueDate);
        if (req.StageScheduleMode is { } requestedMode && (!Enum.IsDefined(requestedMode) || (requestedMode != StageScheduleMode.Manual && (req.StartDate is null || req.DueDate is null))))
            throw new ValidationException("stageScheduleMode", "Automatic scheduling needs project start and end dates.");
        var groupId = await RequireGroupAsync(req.ProjectGroupId, null, ct);
        var projectType = req.ProjectType ?? throw new ValidationException("projectType", "Choose a project type.");

        var ownerId = req.OwnerId ?? userId;
        await access.EnsureTenantMemberAsync(ownerId, "ownerId", ct);
        if (req.TeamId is { } teamId && !await db.Teams.AnyAsync(t => t.Id == teamId, ct))
            throw new ValidationException("teamId", "Team not found.");

        var timeline = await timelines.ResolveAsync(req.TimelineTemplate, ct);
        var key = await ResolveKeyAsync(req.Key, req.Name, ct);
        var now = clock.Now;
        var project = new Project
        {
            TenantId = tid, Name = req.Name.Trim(), Key = key, Description = req.Description?.Trim(), Status = req.Status ?? ProjectStatus.Planning,
            Priority = req.Priority, OwnerId = ownerId, TeamId = req.TeamId, StartDate = req.StartDate, DueDate = req.DueDate, ProjectGroupId = groupId, ProjectType = projectType,
            DeliveryMethod = req.DeliveryMethod ?? DeliveryMethod.Hybrid, Position = await NextPositionAsync(ct), CreatedAt = now, CreatedBy = userId,
            StageScheduleMode = req.StageScheduleMode ?? (req.StartDate is not null && req.DueDate is not null ? StageScheduleMode.FollowSchedule : StageScheduleMode.Manual),
        };
        db.Projects.Add(project);
        ctx.GrantProject(project.Id);   // a project made in this request is in view, whatever team it is for

        var memberIds = new HashSet<Guid>(req.MemberIds ?? []) { ownerId };
        foreach (var uid in memberIds)
        {
            await access.EnsureTenantMemberAsync(uid, "memberIds", ct);
            db.ProjectMembers.Add(new ProjectMember { TenantId = tid, ProjectId = project.Id, UserId = uid, CreatedAt = now });
        }
        // The creator can always see their own project, even as a restricted role.
        if (!memberIds.Contains(userId))
            db.ProjectMembers.Add(new ProjectMember { TenantId = tid, ProjectId = project.Id, UserId = userId, CreatedAt = now });

        for (var i = 0; i < DefaultStatuses.Length; i++)
        {
            var (name, category, color) = DefaultStatuses[i];
            db.WorkflowStatuses.Add(new WorkflowStatus { TenantId = tid, ProjectId = project.Id, Name = name, Order = i, Category = category, Color = color, CreatedAt = now });
        }
        BuildStages(project, timeline, tid, now).ForEach(s => db.ProjectStages.Add(s));

        recorder.Activity("project.created", "Project", project.Id, $"Created project \"{project.Name}\" ({timeline.Name} timeline)", project.Id);
        recorder.Audit("project.created", "Project", project.Id, newValue: new { project.Name, project.Key });
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateException ex) when (DbErrors.IsProjectKeyTaken(ex))
        {
            // Someone created a project with the same key a moment ago.
            throw new ConflictException($"A project with key \"{key}\" already exists. Please try again.", "KEY_TAKEN");
        }
        return await BuildDetailAsync(project, ct);
    }

    /// <summary>The project's first stages, copied from the chosen timeline template with their planned dates spread over the project's duration.</summary>
    private List<ProjectStage> BuildStages(Project project, TimelineTemplate timeline, Guid tid, DateTime now)
    {
        var today = clock.Today;
        var totalWeight = Math.Max(1, timeline.Stages.Sum(s => s.Weight));
        var span = project.StartDate is { } s0 && project.DueDate is { } d0 ? Math.Max(0, d0.DayNumber - s0.DayNumber) : 0;
        var stages = new List<ProjectStage>();
        var cumulative = 0;
        var startedOne = false;
        for (var i = 0; i < timeline.Stages.Count; i++)
        {
            var (name, weight) = timeline.Stages[i];
            DateOnly? start = null, end = null;
            if (project.StartDate is { } from && project.DueDate is not null)
            {
                start = from.AddDays((int)Math.Round(span * cumulative / (double)totalWeight));
                cumulative += weight;
                end = from.AddDays((int)Math.Round(span * cumulative / (double)totalWeight));
            }
            var stage = new ProjectStage
            {
                TenantId = tid, ProjectId = project.Id, Name = name, Order = i, PlannedStart = start, PlannedEnd = end, CreatedAt = now,
                Status = StageStatus.Pending, DurationDays = start is { } ps && end is { } pe ? pe.DayNumber - ps.DayNumber : null,
            };
            // A leading stage with no duration (such as "Project Created") is a marker that is done from the start; the first stage after
            // those is under way as soon as the project is Active.
            if (i == 0 && weight == 0) { stage.Status = StageStatus.Completed; stage.ActualStart = today; stage.ActualEnd = today; }
            else if (!startedOne && stages.All(s => s.Status == StageStatus.Completed) && project.Status == ProjectStatus.Active) { stage.Status = StageStatus.InProgress; stage.ActualStart = today; startedOne = true; }
            stages.Add(stage);
        }
        return stages;
    }

    private async Task<string> ResolveKeyAsync(string? requested, string name, CancellationToken ct)
    {
        if (!string.IsNullOrWhiteSpace(requested))
        {
            var key = requested.Trim().ToUpperInvariant();
            if (!ProjectMetrics.KeyPattern().IsMatch(key))
                throw new ValidationException("key", "Key must be 2-10 characters: letters and digits, starting with a letter.");
            if (await KeyTakenAsync(key, ct))
                throw new ConflictException($"A project with key \"{key}\" already exists.", "KEY_TAKEN");
            return key;
        }
        var baseKey = Text.KeyFrom(name);
        var candidate = baseKey;
        for (var n = 2; await KeyTakenAsync(candidate, ct); n++) candidate = $"{baseKey}{n}";
        return candidate;
    }

    /// <summary>
    /// A key is unique in the workspace (an index enforces it), including projects this person cannot see and deleted projects - whose task
    /// keys (ATL-12) still appear in history, links and commits. So this looks past the per-person and soft-delete filters on purpose.
    /// </summary>
    private Task<bool> KeyTakenAsync(string key, CancellationToken ct)
    {
        var tid = ctx.RequireTenantId();
        return db.Projects.IgnoreQueryFilters().AnyAsync(p => p.TenantId == tid && p.Key == key, ct);
    }


    /// <summary>
    /// The project group a project is put in: required, it must exist, and it must be active (an inactive group keeps its projects but takes no new ones,
    /// so a project that is already in one may stay there).
    /// </summary>
    private async Task<Guid> RequireGroupAsync(Guid? id, Guid? current, CancellationToken ct)
    {
        await groupService.EnsureDefaultAsync(ct);
        if (id is not { } gid) throw new ValidationException("projectGroupId", "Choose a project group for this project.");
        var group = await db.ProjectGroups.AsNoTracking().FirstOrDefaultAsync(g => g.Id == gid, ct) ?? throw new ValidationException("projectGroupId", "That project group was not found.");
        if (!group.IsActive && gid != current) throw new ValidationException("projectGroupId", $"The project group “{group.Name}” is inactive. Choose an active group.");
        return gid;
    }

    private static void ValidateDates(DateOnly? start, DateOnly? due)
    {
        if (start is { } s && due is { } d && d < s)
            throw new ValidationException("dueDate", "Due date must not be before the start date.");
    }

    public async Task<ProjectDetailDto> UpdateAsync(Guid id, UpdateProjectRequest req, CancellationToken ct = default)
    {
        var project = await access.GetProjectAsync(id, ct);
        await access.RequireProjectEditAsync(project, ct);
        if (project.Version != req.Version)
            throw new ConflictException("This project was changed by someone else. Reload and try again.", "VERSION_CONFLICT");
        if ((req.StageScheduleMode ?? project.StageScheduleMode) != StageScheduleMode.FollowSchedule || req.DueDate != project.DueDate)
            ValidateDates(req.StartDate, req.DueDate);
        var oldStart = project.StartDate;
        var oldOwner = project.OwnerId; var oldMethod = project.DeliveryMethod; var oldType = project.ProjectType;
        if (req.ProjectType is { } newType) project.ProjectType = newType;
        if (req.DeliveryMethod is { } method && method != project.DeliveryMethod)
        {
            recorder.Activity("project.delivery_method", "Project", id, $"Delivery method {project.DeliveryMethod} → {method}", id, project.DeliveryMethod.ToString(), method.ToString());
            project.DeliveryMethod = method;
        }
        if (req.ProjectGroupId is { } newGroup && newGroup != project.ProjectGroupId) project.ProjectGroupId = await RequireGroupAsync(newGroup, project.ProjectGroupId, ct);

        if (req.OwnerId is { } ownerId && ownerId != project.OwnerId)
        {
            await access.EnsureTenantMemberAsync(ownerId, "ownerId", ct);
            if (!await db.ProjectMembers.AnyAsync(m => m.ProjectId == id && m.UserId == ownerId, ct))
                db.ProjectMembers.Add(new ProjectMember { TenantId = project.TenantId, ProjectId = id, UserId = ownerId, CreatedAt = clock.Now });
            project.OwnerId = ownerId;
        }
        if (req.TeamId is { } teamId && !await db.Teams.AnyAsync(t => t.Id == teamId, ct))
            throw new ValidationException("teamId", "Team not found.");

        if (project.Status == ProjectStatus.Archived && req.Status != ProjectStatus.Archived)
        {
            // Restoring an archived project consumes a project slot again.
            var active = await entitlements.ActiveProjectCountAsync(ct);
            await entitlements.EnsureWithinLimitAsync(FeatureKeys.ProjectLimit, active, 1, ct);
        }

        var oldStatus = project.Status;
        var oldDue = project.DueDate;
        var oldName = project.Name; var oldDescription = project.Description; var oldPriority = project.Priority; var oldTeam = project.TeamId;
        var oldStartDate = project.StartDate;
        project.Name = req.Name.Trim();
        project.Description = req.Description?.Trim();
        project.Priority = req.Priority;
        project.TeamId = req.TeamId;
        project.StartDate = req.StartDate;
        project.DueDate = req.DueDate;
        if (req.StageScheduleMode is { } scheduleMode)
        {
            if (!Enum.IsDefined(scheduleMode)) throw new ValidationException("stageScheduleMode", "Choose a valid scheduling mode.");
            project.StageScheduleMode = scheduleMode;
        }
        if (project.StageScheduleMode != StageScheduleMode.Manual && (oldStart != req.StartDate || oldDue != req.DueDate || req.StageScheduleMode is not null))
        {
            var stageRows = await db.ProjectStages.Where(s => s.ProjectId == id).OrderBy(s => s.Order).ToListAsync(ct);
            ApplyCalculatedSchedule(project, stageRows, originStart: oldStart,
                alignFinish: project.StageScheduleMode == StageScheduleMode.FollowSchedule && oldDue != req.DueDate && oldStart == req.StartDate);
        }
        var dueNote = DueDateHistory.Prepare(oldDue, project.DueDate, req.DueDateReason, req.DueDateDependency);
        if (req.EnforceDependencies is { } enforce) project.EnforceDependencies = enforce;
        SetStatus(project, req.Status);
        project.Version++;

        {
            var people = await ProjectManagement.Application.Features.Platform.FieldDiff.NamesAsync(db, [oldOwner, project.OwnerId], ct);
            var teamIds = new[] { oldTeam, project.TeamId }.Where(x => x is not null).Select(x => x!.Value).ToList();
            var teams = teamIds.Count == 0 ? new Dictionary<Guid, string>() : await db.Teams.AsNoTracking().Where(t => teamIds.Contains(t.Id)).ToDictionaryAsync(t => t.Id, t => t.Name, ct);
            new ProjectManagement.Application.Features.Platform.FieldDiff()
                .Add("Name", oldName, project.Name).Add("Status", oldStatus.ToString(), project.Status.ToString())
                .Add("Owner", ProjectManagement.Application.Features.Platform.FieldDiff.Name(people, oldOwner), ProjectManagement.Application.Features.Platform.FieldDiff.Name(people, project.OwnerId))
                .Add("Priority", oldPriority.ToString(), project.Priority.ToString()).Add("Start date", oldStartDate, project.StartDate).Add("Due date", oldDue, project.DueDate)
                .Add("Team", oldTeam is { } a ? teams.GetValueOrDefault(a) : null, project.TeamId is { } b2 ? teams.GetValueOrDefault(b2) : null)
                .Add("Delivery method", oldMethod.ToString(), project.DeliveryMethod.ToString()).Add("Type", oldType.ToString(), project.ProjectType.ToString())
                .Add("Description", oldDescription, project.Description, 60)
                .Record(recorder, "project", "Project", id);
        }
        if (oldStatus != req.Status)
        {
            recorder.Activity("project.status_changed", "Project", id, $"Changed project \"{project.Name}\" status: {oldStatus} → {req.Status}", id, oldStatus.ToString(), req.Status.ToString());
            recorder.Audit("project.status_changed", "Project", id, oldStatus.ToString(), req.Status.ToString());
            var memberIds = await db.ProjectMembers.Where(m => m.ProjectId == id).Select(m => m.UserId).ToListAsync(ct);
            foreach (var who in memberIds.Append(project.OwnerId).Distinct())
                await notifications.AddAsync(who, NotificationType.ProjectUpdated, $"\"{project.Name}\" is now {req.Status}", $"Status changed: {oldStatus} → {req.Status}", $"/projects/{id}", ct: ct);
        }
        if (dueNote is not null)
        {
            dueHistory.Record(project.TenantId, id, null, oldDue, project.DueDate, dueNote);
            recorder.Activity("project.due_changed", "Project", id, $"\"{project.Name}\": {DueDateHistory.Describe(oldDue, project.DueDate, dueNote.Reason)}", id,
                oldDue?.ToString("yyyy-MM-dd"), project.DueDate?.ToString("yyyy-MM-dd"));
        }
        if (oldStatus == req.Status && dueNote is null)
            recorder.Activity("project.updated", "Project", id, $"Updated project \"{project.Name}\"", id);

        await db.SaveChangesAsync(ct);
        return await BuildDetailAsync(project, ct);
    }

    private async Task<double> NextPositionAsync(CancellationToken ct) =>
        (await db.Projects.MaxAsync(p => (double?)p.Position, ct) ?? 0) + 1024;

    private void SetStatus(Project project, ProjectStatus next)
    {
        project.Status = next;
        project.ArchivedAt = next == ProjectStatus.Archived ? project.ArchivedAt ?? clock.Now : null;
        project.ArchivedBy = next == ProjectStatus.Archived ? project.ArchivedBy ?? ctx.UserId : null;
    }

    // ------------------------------------------------------------------ status set by hand

    public static readonly string[] ManualHealth = ["OnTrack", "AtRisk", "Delayed"];

    /// <summary>The calculated status and, when one is set and still in force, the one set by hand (why, until when, who, when).</summary>
    public async Task<ProjectHealthDto> GetHealthAsync(Guid id, CancellationToken ct = default)
    {
        var project = await access.GetProjectAsync(id, ct);
        return await HealthDtoAsync(project, ct);
    }

    private async Task<ProjectHealthDto> HealthDtoAsync(Project project, CancellationToken ct)
    {
        var stats = (await GetStatsAsync([project.Id], ct)).GetValueOrDefault(project.Id) ?? new ProjectStatsDto(0, 0, 0, 0, 0, 0);
        var today = clock.Today;
        var inForce = project.HealthOverride is not null && (project.HealthUntil is not { } u || today <= u);
        var by = inForce && project.HealthSetById is { } b ? await db.Users.AsNoTracking().Where(x => x.Id == b).Select(x => new UserRefDto(x.Id, x.DisplayName)).FirstOrDefaultAsync(ct) : null;
        return new ProjectHealthDto(ProjectMetrics.Health(project, stats, today).ToString(), ProjectMetrics.CalculatedHealth(project, stats, today).ToString(),
            inForce ? project.HealthOverride : null, inForce ? project.HealthNote : null, inForce ? project.HealthUntil : null, by, inForce ? project.HealthSetAt : null);
    }

    /// <summary>
    /// Sets the project's status by hand (OnTrack, AtRisk or Delayed) with a reason and an optional end date, or clears it (null). Recorded
    /// in the project's activity. Needs the right to edit the project.
    /// </summary>
    public async Task<ProjectHealthDto> SetHealthAsync(Guid id, SetProjectHealthRequest req, CancellationToken ct = default)
    {
        var project = await access.GetProjectAsync(id, ct);
        await access.RequireProjectEditAsync(project, ct);
        var before = project.HealthOverride;
        if (string.IsNullOrWhiteSpace(req.Health))
        {
            project.HealthOverride = null; project.HealthNote = null; project.HealthUntil = null; project.HealthSetById = null; project.HealthSetAt = null;
            recorder.Activity("project.health_cleared", "Project", id, $"Cleared the status set by hand on \"{project.Name}\"", id, before, null);
        }
        else
        {
            var h = ManualHealth.FirstOrDefault(x => string.Equals(x, req.Health.Trim(), StringComparison.OrdinalIgnoreCase))
                ?? throw new ValidationException("health", "Choose OnTrack, AtRisk or Delayed.");
            var note = (req.Note ?? "").Trim();
            if (note.Length == 0) throw new ValidationException("note", "Say why, so everyone reading the status knows.");
            if (note.Length > 300) throw new ValidationException("note", "Keep the reason under 300 characters.");
            if (req.Until is { } until && until < clock.Today) throw new ValidationException("until", "Pick today or a later date.");
            project.HealthOverride = h; project.HealthNote = note; project.HealthUntil = req.Until; project.HealthSetById = ctx.UserId; project.HealthSetAt = clock.Now;
            recorder.Activity("project.health_set", "Project", id, $"Set \"{project.Name}\" to {h}: {note}", id, before, h);
        }
        recorder.Audit("project.health_set", "Project", id, before, project.HealthOverride);
        new ProjectManagement.Application.Features.Platform.FieldDiff().Add("Health", before, project.HealthOverride).Record(recorder, "project", "Project", id);
        project.Version++;
        await db.SaveChangesAsync(ct);
        return await HealthDtoAsync(project, ct);
    }

    /// <summary>
    /// Projects board: dropping a card in another column changes its status; dropping it inside its own column only re-orders it.
    /// </summary>
    public async Task<ProjectListItemDto> MoveAsync(Guid id, MoveProjectRequest req, CancellationToken ct = default)
    {
        var project = await access.GetProjectAsync(id, ct);
        await access.RequireProjectEditAsync(project, ct);
        var old = project.Status;

        if (old == ProjectStatus.Archived && req.Status != ProjectStatus.Archived)
        {
            var active = await entitlements.ActiveProjectCountAsync(ct);
            await entitlements.EnsureWithinLimitAsync(FeatureKeys.ProjectLimit, active, 1, ct);
        }

        if (old != req.Status)
        {
            SetStatus(project, req.Status);
            recorder.Activity("project.status_changed", "Project", id, $"Changed project \"{project.Name}\" status: {old} → {req.Status}", id, old.ToString(), req.Status.ToString());
            recorder.Audit("project.status_changed", "Project", id, old.ToString(), req.Status.ToString());
            new ProjectManagement.Application.Features.Platform.FieldDiff().Add("Status", old.ToString(), req.Status.ToString()).Record(recorder, "project", "Project", id);
        }
        project.Position = req.Position ?? await NextPositionAsync(ct);
        project.Version++;
        await db.SaveChangesAsync(ct);
        return (await BuildDetailAsync(project, ct)).Project;
    }

    public async Task DeleteAsync(Guid id, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.ProjectsDelete, ct);
        var project = await access.GetProjectAsync(id, ct);
        var now = clock.Now;

        project.IsDeleted = true; project.DeletedAt = now; project.DeletedBy = ctx.UserId;
        foreach (var t in await db.Tasks.Where(t => t.ProjectId == id).ToListAsync(ct))
        { t.IsDeleted = true; t.DeletedAt = now; t.DeletedBy = ctx.UserId; }

        recorder.Audit("project.deleted", "Project", id, new { project.Name, project.Key });
        recorder.Activity("project.deleted", "Project", id, $"Deleted project \"{project.Name}\"");
        await db.SaveChangesAsync(ct);
    }
}
