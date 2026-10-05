using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Tasks;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Projects;

public enum ProjectHealth { OnTrack, AtRisk, Delayed, Completed, Cancelled, Archived }

public record UserRefDto(Guid Id, string Name);
public record ProjectStatsDto(int Total, int Done, int InProgress, int Todo, int Cancelled, int Overdue);
public record ProjectListItemDto(Guid Id, string Key, string Name, string? Description, ProjectStatus Status, Priority Priority,
    UserRefDto? Owner, Guid? TeamId, string? TeamName, DateOnly? StartDate, DateOnly? DueDate, int Progress, ProjectHealth Health,
    ProjectStatsDto Stats, int MemberCount, int Version, double Position, bool EnforceDependencies, Guid? ProjectGroupId = null, string? ProjectGroupName = null, ProjectType ProjectType = ProjectType.Other,
    DeliveryMethod DeliveryMethod = DeliveryMethod.Hybrid);
public record StatusDto(Guid Id, string Name, int Order, StatusCategory Category, string Color);
public record StageDto(Guid Id, string Name, int Order, DateOnly? PlannedStart, DateOnly? PlannedEnd, DateOnly? ActualStart, DateOnly? ActualEnd,
    StageStatus Status, StageStatus EffectiveStatus, UserRefDto? Owner, UserRefDto? Assignee, string? Description,
    int TaskTotal = 0, int TaskDone = 0, bool Locked = false, string? LockedBy = null, int OpenIssues = 0, int TotalIssues = 0);
public record ProjectMemberDto(Guid UserId, string Name, string Email, TenantRole? Role);
public record ProjectDetailDto(ProjectListItemDto Project, IReadOnlyList<StatusDto> Statuses, IReadOnlyList<StageDto> Stages, IReadOnlyList<ProjectMemberDto> Members);
public record LabelDto(Guid Id, string Name, string Color);

public record CreateProjectRequest(string Name, string? Key, string? Description, Priority Priority, ProjectStatus? Status, Guid? OwnerId,
    Guid? TeamId, DateOnly? StartDate, DateOnly? DueDate, IReadOnlyList<Guid>? MemberIds, string? TimelineTemplate = null, Guid? ProjectGroupId = null, ProjectType? ProjectType = null,
    DeliveryMethod? DeliveryMethod = null);
public record UpdateProjectRequest(string Name, string? Description, Priority Priority, ProjectStatus Status, Guid? OwnerId,
    Guid? TeamId, DateOnly? StartDate, DateOnly? DueDate, int Version, bool? EnforceDependencies = null, Guid? ProjectGroupId = null,
    string? DueDateReason = null, string? DueDateDependency = null, ProjectType? ProjectType = null, DeliveryMethod? DeliveryMethod = null);
public record ProjectQuery(string? Q, ProjectStatus? Status, Priority? Priority, Guid? OwnerId, Guid? TeamId, bool IncludeArchived = false,
    string? Sort = null, int Page = 1, int PageSize = 25, bool MineOnly = false, Guid? ProjectGroupId = null, ProjectType? ProjectType = null);
public record AddProjectMemberRequest(Guid UserId);
/// <summary>Board move: a new status (column) and/or a new order inside it.</summary>
public record MoveProjectRequest(ProjectStatus Status, double? Position);
public record UpsertStatusRequest(string Name, StatusCategory Category, string? Color, int? Order);
/// <summary>The whole workflow in its new order: every status of the project exactly once.</summary>
public record ReorderStatusesRequest(IReadOnlyList<Guid> StatusIds);
/// <summary>The whole timeline in its new order: every stage of the project exactly once.</summary>
public record ReorderStagesRequest(IReadOnlyList<Guid> StageIds);
public record UpsertStageRequest(string Name, DateOnly? PlannedStart, DateOnly? PlannedEnd, DateOnly? ActualStart, DateOnly? ActualEnd,
    StageStatus Status, Guid? OwnerId, Guid? AssigneeId, string? Description, int? Order);
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
        var progress = Progress(s);
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

    public static StageStatus EffectiveStage(ProjectStage s, DateOnly today) =>
        s.Status is StageStatus.Pending or StageStatus.InProgress && s.PlannedEnd is { } end && end < today ? StageStatus.Delayed : s.Status;

    [GeneratedRegex("^[A-Z][A-Z0-9]{1,9}$")] public static partial Regex KeyPattern();
}

public class ProjectService(
    IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, PermissionService permissions,
    EntitlementService entitlements, ProjectAccess access, TaskCompletionService completion, TimelineTemplateService timelines, DueDateHistory dueHistory, ProjectGroupService groupService)
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

    private ProjectListItemDto ToItem(Project p, string? ownerName, string? teamName, int memberCount, ProjectStatsDto stats, string? groupName = null) =>
        new(p.Id, p.Key, p.Name, p.Description, p.Status, p.Priority,
            ownerName is null ? null : new UserRefDto(p.OwnerId, ownerName), p.TeamId, teamName, p.StartDate, p.DueDate,
            ProjectMetrics.Progress(stats), ProjectMetrics.Health(p, stats, clock.Today), stats, memberCount, p.Version, p.Position, p.EnforceDependencies, p.ProjectGroupId, groupName, p.ProjectType,
            p.DeliveryMethod);

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
        var items = rows.Select(r => ToItem(r.Project, r.OwnerName, r.TeamName, r.MemberCount, stats[r.Project.Id], r.GroupName)).ToList();
        return new PagedResult<ProjectListItemDto>(items, page.SafePage, page.SafeSize(), total);
    }

    public async Task<ProjectDetailDto> GetAsync(Guid id, CancellationToken ct = default)
    {
        var project = await access.GetProjectAsync(id, ct);
        return await BuildDetailAsync(project, ct);
    }

    private async Task<ProjectDetailDto> BuildDetailAsync(Project project, CancellationToken ct)
    {
        var owner = await db.Users.AsNoTracking().Where(u => u.Id == project.OwnerId).Select(u => u.DisplayName).FirstOrDefaultAsync(ct);
        var teamName = project.TeamId is { } tid ? await db.Teams.AsNoTracking().Where(t => t.Id == tid).Select(t => t.Name).FirstOrDefaultAsync(ct) : null;
        var members = await GetMembersAsync(project.Id, ct);
        var stats = (await GetStatsAsync([project.Id], ct))[project.Id];
        var groupName = project.ProjectGroupId is { } gid ? await db.ProjectGroups.AsNoTracking().Where(g => g.Id == gid).Select(g => g.Name).FirstOrDefaultAsync(ct) : null;
        return new ProjectDetailDto(ToItem(project, owner, teamName, members.Count, stats, groupName),
            await GetStatusesAsync(project.Id, ct), await GetStagesAsync(project.Id, ct), members);
    }

    // ---------------------------------------------------------------- create / update / delete

    public async Task<ProjectDetailDto> CreateAsync(CreateProjectRequest req, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.ProjectsCreate, ct);
        var tid = ctx.RequireTenantId();
        var userId = ctx.RequireUserId();

        var activeCount = await db.Projects.CountAsync(p => p.Status != ProjectStatus.Archived, ct);
        await entitlements.EnsureWithinLimitAsync(FeatureKeys.ProjectLimit, activeCount, 1, ct);
        ValidateDates(req.StartDate, req.DueDate);
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
        };
        db.Projects.Add(project);

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
        await db.SaveChangesAsync(ct);
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
                Status = StageStatus.Pending,
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
            if (await db.Projects.AnyAsync(p => p.Key == key, ct))
                throw new ConflictException($"A project with key \"{key}\" already exists.", "KEY_TAKEN");
            return key;
        }
        var baseKey = Text.KeyFrom(name);
        var candidate = baseKey;
        for (var n = 2; await db.Projects.AnyAsync(p => p.Key == candidate, ct); n++) candidate = $"{baseKey}{n}";
        return candidate;
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
        ValidateDates(req.StartDate, req.DueDate);
        var dueNote = DueDateHistory.Prepare(project.DueDate, req.DueDate, req.DueDateReason, req.DueDateDependency);   // a delay needs a reason
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
            var active = await db.Projects.CountAsync(p => p.Status != ProjectStatus.Archived, ct);
            await entitlements.EnsureWithinLimitAsync(FeatureKeys.ProjectLimit, active, 1, ct);
        }

        var oldStatus = project.Status;
        var oldDue = project.DueDate;
        project.Name = req.Name.Trim();
        project.Description = req.Description?.Trim();
        project.Priority = req.Priority;
        project.TeamId = req.TeamId;
        project.StartDate = req.StartDate;
        project.DueDate = req.DueDate;
        if (req.EnforceDependencies is { } enforce) project.EnforceDependencies = enforce;
        SetStatus(project, req.Status);
        project.Version++;

        if (oldStatus != req.Status)
        {
            recorder.Activity("project.status_changed", "Project", id, $"Changed project \"{project.Name}\" status: {oldStatus} → {req.Status}", id, oldStatus.ToString(), req.Status.ToString());
            recorder.Audit("project.status_changed", "Project", id, oldStatus.ToString(), req.Status.ToString());
        }
        if (dueNote is not null)
        {
            dueHistory.Record(project.TenantId, id, null, oldDue, req.DueDate, dueNote);
            recorder.Activity("project.due_changed", "Project", id, $"\"{project.Name}\": {DueDateHistory.Describe(oldDue, req.DueDate, dueNote.Reason)}", id,
                oldDue?.ToString("yyyy-MM-dd"), req.DueDate?.ToString("yyyy-MM-dd"));
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
            var active = await db.Projects.CountAsync(p => p.Status != ProjectStatus.Archived, ct);
            await entitlements.EnsureWithinLimitAsync(FeatureKeys.ProjectLimit, active, 1, ct);
        }

        if (old != req.Status)
        {
            SetStatus(project, req.Status);
            recorder.Activity("project.status_changed", "Project", id, $"Changed project \"{project.Name}\" status: {old} → {req.Status}", id, old.ToString(), req.Status.ToString());
            recorder.Audit("project.status_changed", "Project", id, old.ToString(), req.Status.ToString());
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

    // ---------------------------------------------------------------- workflow statuses (per project)

    public async Task<IReadOnlyList<StatusDto>> GetStatusesAsync(Guid projectId, CancellationToken ct = default) =>
        await db.WorkflowStatuses.AsNoTracking().Where(s => s.ProjectId == projectId).OrderBy(s => s.Order)
            .Select(s => new StatusDto(s.Id, s.Name, s.Order, s.Category, s.Color)).ToListAsync(ct);

    private async Task<Project> RequireWorkflowAccessAsync(Guid projectId, CancellationToken ct)
    {
        await permissions.RequireAsync(Permissions.WorkflowManage, ct);
        await entitlements.EnsureFeatureAsync(FeatureKeys.CustomWorkflows, ct);
        return await access.GetProjectAsync(projectId, ct);
    }

    public async Task<IReadOnlyList<StatusDto>> CreateStatusAsync(Guid projectId, UpsertStatusRequest req, CancellationToken ct = default)
    {
        var project = await RequireWorkflowAccessAsync(projectId, ct);
        var existing = await db.WorkflowStatuses.Where(s => s.ProjectId == projectId).ToListAsync(ct);
        if (existing.Any(s => s.Name.Equals(req.Name.Trim(), StringComparison.OrdinalIgnoreCase)))
            throw new ConflictException("A status with this name already exists.", "STATUS_EXISTS");
        db.WorkflowStatuses.Add(new WorkflowStatus
        {
            TenantId = project.TenantId, ProjectId = projectId, Name = req.Name.Trim(), Category = req.Category,
            Color = req.Color ?? "#8b5cf6", Order = req.Order ?? (existing.Count == 0 ? 0 : existing.Max(s => s.Order) + 1), CreatedAt = clock.Now,
        });
        recorder.Activity("workflow.status_added", "Project", projectId, $"Added status \"{req.Name.Trim()}\" to \"{project.Name}\"", projectId);
        await db.SaveChangesAsync(ct);
        return await GetStatusesAsync(projectId, ct);
    }

    public async Task<IReadOnlyList<StatusDto>> UpdateStatusAsync(Guid projectId, Guid statusId, UpsertStatusRequest req, CancellationToken ct = default)
    {
        await RequireWorkflowAccessAsync(projectId, ct);
        var all = await db.WorkflowStatuses.Where(s => s.ProjectId == projectId).ToListAsync(ct);
        var status = all.FirstOrDefault(s => s.Id == statusId) ?? throw new NotFoundException("Status not found.");
        if (all.Any(s => s.Id != statusId && s.Name.Equals(req.Name.Trim(), StringComparison.OrdinalIgnoreCase)))
            throw new ConflictException("A status with this name already exists.", "STATUS_EXISTS");

        if (status.Category != req.Category)
        {
            var remaining = all.Where(s => s.Id != statusId).Select(s => s.Category).ToList();
            if (status.Category is StatusCategory.Todo or StatusCategory.Done && !remaining.Contains(status.Category))
                throw new ConflictException($"A project needs at least one {status.Category} status.", "STATUS_REQUIRED");
        }
        status.Name = req.Name.Trim(); status.Category = req.Category;
        if (req.Color is not null) status.Color = req.Color;
        if (req.Order is { } order) status.Order = order;

        // Tasks moved into / out of a Done category keep completion timestamps consistent.
        var tasks = await db.Tasks.Where(t => t.StatusId == statusId).ToListAsync(ct);
        foreach (var t in tasks)
            t.CompletedAt = req.Category == StatusCategory.Done ? t.CompletedAt ?? clock.Now : null;
        await db.SaveChangesAsync(ct);
        // Tasks that just became (or stopped being) done change how far their stages have got.
        await completion.SyncStagesAsync(tasks.Select(t => t.StageId), ct);
        return await GetStatusesAsync(projectId, ct);
    }

    public async Task<IReadOnlyList<StatusDto>> ReorderStatusesAsync(Guid projectId, ReorderStatusesRequest req, CancellationToken ct = default)
    {
        var project = await RequireWorkflowAccessAsync(projectId, ct);
        var all = await db.WorkflowStatuses.Where(s => s.ProjectId == projectId).ToListAsync(ct);
        var wanted = req.StatusIds ?? [];
        if (wanted.Count != all.Count || wanted.Distinct().Count() != wanted.Count || all.Any(s => !wanted.Contains(s.Id)))
            throw new ValidationException("statusIds", "List every status of this project exactly once.");
        var before = string.Join(", ", all.OrderBy(s => s.Order).Select(s => s.Name));
        for (var i = 0; i < wanted.Count; i++) all.First(s => s.Id == wanted[i]).Order = i;
        var after = string.Join(", ", all.OrderBy(s => s.Order).Select(s => s.Name));
        if (before != after) recorder.Activity("project.workflow_reordered", "Project", projectId, $"Reordered the workflow of \"{project.Name}\": {after}", projectId);
        await db.SaveChangesAsync(ct);
        return await GetStatusesAsync(projectId, ct);
    }

    public async Task<IReadOnlyList<StatusDto>> DeleteStatusAsync(Guid projectId, Guid statusId, CancellationToken ct = default)
    {
        await RequireWorkflowAccessAsync(projectId, ct);
        var all = await db.WorkflowStatuses.Where(s => s.ProjectId == projectId).ToListAsync(ct);
        var status = all.FirstOrDefault(s => s.Id == statusId) ?? throw new NotFoundException("Status not found.");
        if (await db.Tasks.IgnoreQueryFilters().AnyAsync(t => t.StatusId == statusId && !t.IsDeleted, ct))
            throw new ConflictException("Move the tasks in this status before deleting it.", "STATUS_IN_USE");
        if (status.Category is StatusCategory.Todo or StatusCategory.Done && all.Count(s => s.Category == status.Category) == 1)
            throw new ConflictException($"A project needs at least one {status.Category} status.", "STATUS_REQUIRED");
        db.WorkflowStatuses.Remove(status);
        await db.SaveChangesAsync(ct);
        return await GetStatusesAsync(projectId, ct);
    }

    // ---------------------------------------------------------------- timeline stages

    public async Task<IReadOnlyList<StageDto>> GetStagesAsync(Guid projectId, CancellationToken ct = default)
    {
        var today = clock.Today;
        var rows = await (from s in db.ProjectStages
                          join o in db.Users on s.OwnerId equals (Guid?)o.Id into owners
                          from owner in owners.DefaultIfEmpty()
                          join a in db.Users on s.AssigneeId equals (Guid?)a.Id into assignees
                          from assignee in assignees.DefaultIfEmpty()
                          where s.ProjectId == projectId
                          orderby s.Order
                          select new { Stage = s, OwnerName = owner.DisplayName, AssigneeName = assignee.DisplayName })
            .AsNoTracking().ToListAsync(ct);
        // Progress of a stage = its top-level tasks (cancelled ones do not count), the same rule that completes it.
        var counts = (await db.Tasks.AsNoTracking()
            .Where(t => t.ProjectId == projectId && t.StageId != null && t.ParentTaskId == null && t.Status!.Category != StatusCategory.Cancelled)
            .GroupBy(t => t.StageId)
            .Select(g => new { StageId = g.Key, Total = g.Count(), Done = g.Count(t => t.Status!.Category == StatusCategory.Done) })
            .ToListAsync(ct)).ToDictionary(x => x.StageId!.Value);
        // Test issues found in a stage: the open ones keep it from completing.
        var issues = (await db.StageIssues.AsNoTracking().Where(i => i.ProjectId == projectId && i.StageId != null)
            .GroupBy(i => i.StageId)
            .Select(g => new { StageId = g.Key, Total = g.Count(), Open = g.Count(i => i.Status != IssueStatus.Resolved) })
            .ToListAsync(ct)).ToDictionary(x => x.StageId!.Value);
        return rows.Select((r, i) =>
        {
            // Locked while the stage before it is unfinished, so the timeline can only be worked through in order.
            var previous = i > 0 ? rows[i - 1].Stage : null;
            var locked = StageSequence.IsLocked(previous, r.Stage.Status);
            return new StageDto(r.Stage.Id, r.Stage.Name, r.Stage.Order, r.Stage.PlannedStart, r.Stage.PlannedEnd,
                r.Stage.ActualStart, r.Stage.ActualEnd, r.Stage.Status, ProjectMetrics.EffectiveStage(r.Stage, today),
                r.OwnerName is null ? null : new UserRefDto(r.Stage.OwnerId!.Value, r.OwnerName),
                r.AssigneeName is null ? null : new UserRefDto(r.Stage.AssigneeId!.Value, r.AssigneeName),
                r.Stage.Description,
                counts.TryGetValue(r.Stage.Id, out var c) ? c.Total : 0, counts.TryGetValue(r.Stage.Id, out var d) ? d.Done : 0,
                locked, locked ? previous!.Name : null,
                issues.TryGetValue(r.Stage.Id, out var iss) ? iss.Open : 0, iss?.Total ?? 0);
        }).ToList();
    }

    private async Task ApplyStageAsync(ProjectStage stage, UpsertStageRequest req, CancellationToken ct)
    {
        if (req.PlannedStart is { } ps && req.PlannedEnd is { } pe && pe < ps)
            throw new ValidationException("plannedEnd", "Planned end must not be before planned start.");
        if (req.Status == StageStatus.Completed && await completion.OpenTaskCountAsync(stage.Id, ct) is var open and > 0)
            throw new ConflictException(
                $"Unable to complete this stage. {open} task{(open == 1 ? " is" : "s are")} still open. A stage is completed once all of its tasks are completed.",
                TaskCompletionService.StageOpenTasksCode);
        if (req.Status == StageStatus.Completed && await completion.OpenIssueCountAsync(stage.Id, ct) is var openIssues and > 0)
            throw new ConflictException(
                $"Unable to complete this stage. {openIssues} test issue{(openIssues == 1 ? " is" : "s are")} still unresolved. Fix and resolve {(openIssues == 1 ? "it" : "them")} first, then complete the stage.",
                TaskCompletionService.StageOpenIssuesCode);
        if (req.OwnerId is { } o) await access.EnsureTenantMemberAsync(o, "ownerId", ct);
        if (req.AssigneeId is { } a) await access.EnsureTenantMemberAsync(a, "assigneeId", ct);

        var today = clock.Today;
        stage.Name = req.Name.Trim();
        stage.PlannedStart = req.PlannedStart; stage.PlannedEnd = req.PlannedEnd;
        stage.ActualStart = req.ActualStart; stage.ActualEnd = req.ActualEnd;
        stage.OwnerId = req.OwnerId; stage.AssigneeId = req.AssigneeId;
        stage.Description = req.Description?.Trim();
        stage.Status = req.Status;
        if (req.Status is StageStatus.InProgress or StageStatus.Completed) stage.ActualStart ??= today;
        if (req.Status == StageStatus.Completed) stage.ActualEnd ??= today;
        if (req.Status is StageStatus.Pending or StageStatus.InProgress) stage.ActualEnd = null;
    }

    public async Task<IReadOnlyList<StageDto>> CreateStageAsync(Guid projectId, UpsertStageRequest req, CancellationToken ct = default)
    {
        var project = await access.GetProjectAsync(projectId, ct);
        await access.RequireProjectEditAsync(project, ct);
        var stages = await db.ProjectStages.Where(s => s.ProjectId == projectId).OrderBy(s => s.Order).ToListAsync(ct);
        var stage = new ProjectStage { TenantId = project.TenantId, ProjectId = projectId, CreatedAt = clock.Now };

        // Insert at the requested position, shifting later stages down. The stage before it decides whether it may already be started.
        var index = Math.Clamp(req.Order ?? stages.Count, 0, stages.Count);
        stages.Insert(index, stage);
        StageSequence.EnsureAllowed(StageSequence.PreviousOf(stages, stage), stage, req.Status);
        await ApplyStageAsync(stage, req, ct);
        for (var i = 0; i < stages.Count; i++) stages[i].Order = i;
        db.ProjectStages.Add(stage);
        recorder.Activity("project.stage_added", "Project", projectId, $"Added stage \"{stage.Name}\" to \"{project.Name}\"", projectId);
        await db.SaveChangesAsync(ct);
        await completion.SyncStagesAsync([StageSequence.NextOf(stages, stage)?.Id], ct);
        return await GetStagesAsync(projectId, ct);
    }

    public async Task<IReadOnlyList<StageDto>> UpdateStageAsync(Guid projectId, Guid stageId, UpsertStageRequest req, CancellationToken ct = default)
    {
        var project = await access.GetProjectAsync(projectId, ct);
        await access.RequireProjectEditAsync(project, ct);
        var stages = await db.ProjectStages.Where(s => s.ProjectId == projectId).OrderBy(s => s.Order).ToListAsync(ct);
        var stage = stages.FirstOrDefault(s => s.Id == stageId) ?? throw new NotFoundException("Stage not found.");
        var old = stage.Status;

        // Work out where the stage will sit first: what comes before it decides whether it may be started or completed.
        if (req.Order is { } order && order != stage.Order)
        {
            stages.Remove(stage);
            stages.Insert(Math.Clamp(order, 0, stages.Count), stage);
        }
        StageSequence.EnsureAllowed(StageSequence.PreviousOf(stages, stage), stage, req.Status);
        await ApplyStageAsync(stage, req, ct);
        for (var i = 0; i < stages.Count; i++) stages[i].Order = i;

        if (old != stage.Status)
            recorder.Activity("project.stage_status", "Project", projectId, $"Stage \"{stage.Name}\" of \"{project.Name}\": {old} → {stage.Status}", projectId, old.ToString(), stage.Status.ToString());
        await db.SaveChangesAsync(ct);
        // Finishing a stage opens the next one (whose own tasks may already say where it stands).
        await completion.SyncStagesAsync([StageSequence.NextOf(stages, stage)?.Id], ct);
        return await GetStagesAsync(projectId, ct);
    }

    /// <summary>
    /// Saves a new order for the whole timeline. Nothing about a stage's own state changes, but who is locked does: a stage is locked
    /// while the one before it is unfinished, so moving stages around can open some and hold back others (never complete anything).
    /// </summary>
    public async Task<IReadOnlyList<StageDto>> ReorderStagesAsync(Guid projectId, ReorderStagesRequest req, CancellationToken ct = default)
    {
        var project = await access.GetProjectAsync(projectId, ct);
        await access.RequireProjectEditAsync(project, ct);
        var stages = await db.ProjectStages.Where(s => s.ProjectId == projectId).OrderBy(s => s.Order).ToListAsync(ct);
        var wanted = req.StageIds ?? [];
        if (wanted.Count != stages.Count || wanted.Distinct().Count() != wanted.Count || stages.Any(s => !wanted.Contains(s.Id)))
            throw new ValidationException("stageIds", "List every stage of this project exactly once.");

        var before = string.Join(", ", stages.Select(s => s.Name));
        for (var i = 0; i < wanted.Count; i++) stages.First(s => s.Id == wanted[i]).Order = i;
        var after = string.Join(", ", stages.OrderBy(s => s.Order).Select(s => s.Name));
        if (before != after)
            recorder.Activity("project.timeline_reordered", "Project", projectId, $"Reordered the timeline of \"{project.Name}\": {after}", projectId);
        await db.SaveChangesAsync(ct);
        // The stages that are now next in line may already have all their tasks done.
        await completion.SyncStagesAsync(stages.Select(s => (Guid?)s.Id), ct);
        return await GetStagesAsync(projectId, ct);
    }

    public async Task<IReadOnlyList<StageDto>> DeleteStageAsync(Guid projectId, Guid stageId, CancellationToken ct = default)
    {
        var project = await access.GetProjectAsync(projectId, ct);
        await access.RequireProjectEditAsync(project, ct);
        var stages = await db.ProjectStages.Where(s => s.ProjectId == projectId).OrderBy(s => s.Order).ToListAsync(ct);
        var stage = stages.FirstOrDefault(s => s.Id == stageId) ?? throw new NotFoundException("Stage not found.");
        var index = stages.IndexOf(stage);
        db.ProjectStages.Remove(stage);
        stages.Remove(stage);
        for (var i = 0; i < stages.Count; i++) stages[i].Order = i;
        await db.SaveChangesAsync(ct);
        // The stage that now follows the one before it may have just become available.
        if (index < stages.Count) await completion.SyncStagesAsync([stages[index].Id], ct);
        return await GetStagesAsync(projectId, ct);
    }

    // ---------------------------------------------------------------- labels (workspace-wide)

    public async Task<IReadOnlyList<LabelDto>> GetLabelsAsync(CancellationToken ct = default) =>
        await db.Labels.AsNoTracking().OrderBy(l => l.Name).Select(l => new LabelDto(l.Id, l.Name, l.Color)).ToListAsync(ct);

    public async Task<LabelDto> CreateLabelAsync(UpsertLabelRequest req, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.LabelsManage, ct);
        var name = req.Name.Trim();
        if (await db.Labels.AnyAsync(l => l.Name.ToLower() == name.ToLower(), ct))
            throw new ConflictException("A label with this name already exists.", "LABEL_EXISTS");
        var label = new Label { TenantId = ctx.RequireTenantId(), Name = name, Color = req.Color ?? "#8b5cf6", CreatedAt = clock.Now };
        db.Labels.Add(label);
        await db.SaveChangesAsync(ct);
        return new LabelDto(label.Id, label.Name, label.Color);
    }

    public async Task<LabelDto> UpdateLabelAsync(Guid id, UpsertLabelRequest req, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.LabelsManage, ct);
        var label = await db.Labels.FirstOrDefaultAsync(l => l.Id == id, ct) ?? throw new NotFoundException("Label not found.");
        var name = req.Name.Trim();
        if (await db.Labels.AnyAsync(l => l.Id != id && l.Name.ToLower() == name.ToLower(), ct))
            throw new ConflictException("A label with this name already exists.", "LABEL_EXISTS");
        label.Name = name;
        if (req.Color is not null) label.Color = req.Color;
        await db.SaveChangesAsync(ct);
        return new LabelDto(label.Id, label.Name, label.Color);
    }

    public async Task DeleteLabelAsync(Guid id, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.LabelsManage, ct);
        var label = await db.Labels.FirstOrDefaultAsync(l => l.Id == id, ct) ?? throw new NotFoundException("Label not found.");
        db.TaskLabels.RemoveRange(await db.TaskLabels.Where(l => l.LabelId == id).ToListAsync(ct));
        db.Labels.Remove(label);
        await db.SaveChangesAsync(ct);
    }
}
