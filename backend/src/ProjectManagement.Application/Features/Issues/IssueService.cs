using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.Tasks;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Issues;

/// <summary>What the caller may do with one issue, so the screen only offers what will work.</summary>
public record IssueCan(bool Edit, bool Assign, bool Delete, bool Attach, IReadOnlyList<IssueStatus> MoveTo);

public record IssueDto(Guid Id, string Key, int Number, Guid ProjectId, Guid? StageId, string? StageName, string Title, string? Details, Priority Severity,
    IssueStatus Status, UserRefDto? Reporter, UserRefDto? Assignee, DateTime CreatedAt, DateTime? ResolvedAt, int FileCount, IssueCan Can);

public record IssueEventDto(Guid Id, string Kind, IssueStatus? From, IssueStatus? To, string? Note, UserRefDto? Actor, DateTime At);

public record IssueDetailDto(IssueDto Issue, IReadOnlyList<IssueEventDto> History);

public record CreateIssueRequest(Guid? StageId, string? Title, string? Details, Priority? Severity, Guid? AssigneeId);
public record UpdateIssueRequest(string? Title, string? Details, Priority? Severity, Guid? StageId);
public record AssignIssueRequest(Guid? AssigneeId);
public record ChangeIssueStatusRequest(IssueStatus Status, string? Note);

/// <summary>
/// Test findings on a project's stages. A tester marks something as Observed / Failed with the details and supporting files; it is worked
/// through In progress and Fixed, and the tester confirms it as Resolved. A stage cannot be completed while any of its issues is open
/// (see <see cref="TaskCompletionService"/>), so a project only moves on once testing has passed.
/// </summary>
public class IssueService(IAppDbContext db, ICurrentContext ctx, PermissionService permissions, ProjectAccess access, Recorder recorder, AppClock clock,
    NotificationService notifications, TaskCompletionService completion, IFileStorage storage, ILogger<IssueService> log)
{
    public const string OpenIssuesCode = "STAGE_HAS_OPEN_ISSUES";
    public const int MaxFilesPerIssue = 20;
    private const int MaxListed = 500;

    // ------------------------------------------------------------------ rules

    /// <summary>The status changes a person may make. Whoever fixes it (assignee) moves it along; whoever found it (reporter) confirms or rejects the fix; managers may do both.</summary>
    public static bool MayMove(IssueStatus from, IssueStatus to, bool reporter, bool assignee, bool manager)
    {
        if (from == to) return false;
        var fixer = assignee || manager;
        var tester = reporter || manager;
        return to switch
        {
            IssueStatus.InProgress => fixer && from == IssueStatus.Observed,
            IssueStatus.Fixed => fixer && from is IssueStatus.Observed or IssueStatus.InProgress,
            IssueStatus.Resolved => tester,
            IssueStatus.Observed => (tester && from is IssueStatus.Fixed or IssueStatus.Resolved) || (fixer && from == IssueStatus.InProgress),
            _ => false,
        };
    }

    private static readonly IssueStatus[] AllStatuses = [IssueStatus.Observed, IssueStatus.InProgress, IssueStatus.Fixed, IssueStatus.Resolved];

    public static string KeyOf(string projectKey, int number) => $"{projectKey}-I{number}";

    /// <summary>Whether the caller can oversee issues: managers and up (task editors), or the owner of the project.</summary>
    private async Task<bool> IsManagerAsync(Project project, CancellationToken ct) =>
        await permissions.HasAsync(Permissions.TasksEdit, ct) || (project.OwnerId == ctx.UserId && !access.IsRestricted);

    private async Task<Project> ViewableProjectAsync(Guid projectId, CancellationToken ct)
    {
        var project = await access.GetProjectAsync(projectId, ct);
        await permissions.RequireModuleAsync(Modules.Tasks, AccessLevel.View, ct);
        return project;
    }

    private static void RequireOpen(Project project)
    {
        if (project.Status == ProjectStatus.Archived)
            throw new ConflictException("This project is archived and read-only. Restore it to work on its issues.", "PROJECT_ARCHIVED");
    }

    private async Task<StageIssue> FindAsync(Guid projectId, Guid issueId, CancellationToken ct) =>
        await db.StageIssues.FirstOrDefaultAsync(i => i.Id == issueId && i.ProjectId == projectId, ct) ?? throw new NotFoundException("Issue not found.", "ISSUE_NOT_FOUND");

    // ------------------------------------------------------------------ read

    public async Task<IReadOnlyList<IssueDto>> ListAsync(Guid projectId, Guid? stageId, bool openOnly, CancellationToken ct = default)
    {
        var project = await ViewableProjectAsync(projectId, ct);
        var q = db.StageIssues.AsNoTracking().Where(i => i.ProjectId == projectId);
        if (stageId is { } s) q = q.Where(i => i.StageId == s);
        if (openOnly) q = q.Where(i => i.Status != IssueStatus.Resolved);
        var rows = await q.OrderBy(i => i.Status == IssueStatus.Resolved).ThenByDescending(i => i.Severity).ThenByDescending(i => i.CreatedAt).Take(MaxListed).ToListAsync(ct);
        return await ToDtosAsync(project, rows, ct);
    }

    public async Task<IssueDetailDto> GetAsync(Guid projectId, Guid issueId, CancellationToken ct = default)
    {
        var project = await ViewableProjectAsync(projectId, ct);
        var issue = await db.StageIssues.AsNoTracking().FirstOrDefaultAsync(i => i.Id == issueId && i.ProjectId == projectId, ct)
            ?? throw new NotFoundException("Issue not found.", "ISSUE_NOT_FOUND");
        return await DetailAsync(project, issue, ct);
    }

    private async Task<IssueDetailDto> DetailAsync(Project project, StageIssue issue, CancellationToken ct)
    {
        var dto = (await ToDtosAsync(project, [issue], ct))[0];
        var events = await db.StageIssueEvents.AsNoTracking().Where(e => e.IssueId == issue.Id).OrderBy(e => e.CreatedAt).ThenBy(e => e.Id).ToListAsync(ct);
        var ids = events.Where(e => e.ActorId != null).Select(e => e.ActorId!.Value).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => ids.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        var history = events.Select(e => new IssueEventDto(e.Id, e.Kind, e.FromStatus, e.ToStatus, e.Note,
            e.ActorId is { } a && names.TryGetValue(a, out var n) ? new UserRefDto(a, n) : null, e.CreatedAt)).ToList();
        return new IssueDetailDto(dto, history);
    }

    private async Task<IReadOnlyList<IssueDto>> ToDtosAsync(Project project, IReadOnlyList<StageIssue> rows, CancellationToken ct)
    {
        if (rows.Count == 0) return [];
        var me = ctx.UserId;
        var manager = await IsManagerAsync(project, ct);
        var archived = project.Status == ProjectStatus.Archived;
        var people = rows.SelectMany(r => new[] { (Guid?)r.ReporterId, r.AssigneeId }).Where(x => x != null).Select(x => x!.Value).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => people.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        var stageIds = rows.Where(r => r.StageId != null).Select(r => r.StageId!.Value).Distinct().ToList();
        var stages = await db.ProjectStages.AsNoTracking().Where(s => stageIds.Contains(s.Id)).ToDictionaryAsync(s => s.Id, s => s.Name, ct);
        var issueIds = rows.Select(r => r.Id).ToList();
        var files = await db.Attachments.AsNoTracking().Where(a => a.IssueId != null && issueIds.Contains(a.IssueId!.Value))
            .GroupBy(a => a.IssueId!.Value).Select(g => new { g.Key, Count = g.Count() }).ToDictionaryAsync(x => x.Key, x => x.Count, ct);

        UserRefDto? Ref(Guid? id) => id is { } u && names.TryGetValue(u, out var n) ? new UserRefDto(u, n) : null;
        return rows.Select(r =>
        {
            var reporter = r.ReporterId == me; var assignee = r.AssigneeId == me;
            var can = new IssueCan(
                Edit: !archived && (reporter || manager), Assign: !archived && (reporter || manager), Delete: !archived && (reporter || manager),
                Attach: !archived && (reporter || assignee || manager),
                MoveTo: archived ? [] : AllStatuses.Where(s => MayMove(r.Status, s, reporter, assignee, manager)).ToList());
            return new IssueDto(r.Id, KeyOf(project.Key, r.Number), r.Number, r.ProjectId, r.StageId, r.StageId is { } sid && stages.TryGetValue(sid, out var sn) ? sn : null,
                r.Title, r.Details, r.Severity, r.Status, Ref(r.ReporterId), Ref(r.AssigneeId), r.CreatedAt, r.ResolvedAt, files.GetValueOrDefault(r.Id), can);
        }).ToList();
    }

    // ------------------------------------------------------------------ write

    private static string CleanTitle(string? title)
    {
        var t = (title ?? "").Trim();
        if (t.Length == 0) throw new ValidationException("title", "Give the issue a short title.");
        if (t.Length > 200) throw new ValidationException("title", "The title can be at most 200 characters.");
        return t;
    }

    private static string? CleanDetails(string? details)
    {
        var d = details?.Replace("\r\n", "\n").Trim();
        if (string.IsNullOrEmpty(d)) return null;
        if (d.Length > 4000) throw new ValidationException("details", "The details can be at most 4000 characters.");
        return d;
    }

    private static string? CleanNote(string? note)
    {
        var n = note?.Replace("\r\n", "\n").Trim();
        if (string.IsNullOrEmpty(n)) return null;
        if (n.Length > 1000) throw new ValidationException("note", "A note can be at most 1000 characters.");
        return n;
    }

    /// <summary>The stage an issue goes to. With none named, the one being worked on now (or the first that is not finished).</summary>
    private async Task<ProjectStage?> ResolveStageAsync(Guid projectId, Guid? wanted, CancellationToken ct)
    {
        var stages = await db.ProjectStages.Where(s => s.ProjectId == projectId).OrderBy(s => s.Order).ToListAsync(ct);
        ProjectStage? stage;
        if (wanted is { } id) stage = stages.FirstOrDefault(s => s.Id == id) ?? throw new ValidationException("stageId", "That stage does not belong to this project.");
        else stage = stages.FirstOrDefault(s => s.Status == StageStatus.InProgress) ?? stages.FirstOrDefault(s => s.Status != StageStatus.Completed && !StageSequence.IsLocked(StageSequence.PreviousOf(stages, s), s.Status));
        if (stage is not null && StageSequence.IsLocked(StageSequence.PreviousOf(stages, stage), stage.Status))
        {
            var previous = StageSequence.PreviousOf(stages, stage)!;
            throw new ConflictException($"“{stage.Name}” has not started yet, so it cannot have issues. Please complete {previous.Name} first.", StageSequence.PreviousIncompleteCode);
        }
        return stage;
    }

    private void AddEvent(StageIssue issue, string kind, IssueStatus? from, IssueStatus? to, string? note) =>
        db.StageIssueEvents.Add(new StageIssueEvent
        {
            TenantId = issue.TenantId, IssueId = issue.Id, Kind = kind, FromStatus = from, ToStatus = to, Note = note, ActorId = ctx.UserId, CreatedAt = clock.Now,
        });

    private async Task NotifyAsync(IEnumerable<Guid?> who, string title, string? body, Project project, StageIssue issue, CancellationToken ct)
    {
        var link = $"/projects/{project.Id}?tab=issues&issue={issue.Id}";
        foreach (var u in who.Where(x => x != null).Select(x => x!.Value).Distinct())
            await notifications.AddAsync(u, NotificationType.Issue, title, body, link, ct: ct);
    }

    public async Task<IssueDetailDto> CreateAsync(Guid projectId, CreateIssueRequest req, CancellationToken ct = default)
    {
        var project = await ViewableProjectAsync(projectId, ct);
        await permissions.RequireAsync(Permissions.TasksComment, ct);
        RequireOpen(project);
        var title = CleanTitle(req.Title);
        var details = CleanDetails(req.Details);
        var stage = await ResolveStageAsync(projectId, req.StageId, ct);
        if (req.AssigneeId is { } a) await access.EnsureTenantMemberAsync(a, "assigneeId", ct);

        var me = ctx.RequireUserId();
        var number = (await db.StageIssues.IgnoreQueryFilters().Where(i => i.ProjectId == projectId).MaxAsync(i => (int?)i.Number, ct) ?? 0) + 1;
        var issue = new StageIssue
        {
            TenantId = project.TenantId, ProjectId = projectId, StageId = stage?.Id, Number = number, Title = title, Details = details,
            Severity = req.Severity ?? Priority.Medium, Status = IssueStatus.Observed, ReporterId = me, AssigneeId = req.AssigneeId, CreatedAt = clock.Now,
        };
        db.StageIssues.Add(issue);
        AddEvent(issue, "reported", null, IssueStatus.Observed, null);
        var key = KeyOf(project.Key, number);
        recorder.Activity("issue.reported", "Issue", issue.Id, $"Reported issue {key} “{title}”{(stage is null ? "" : $" in {stage.Name}")}", projectId, null, IssueStatus.Observed.ToString());
        await NotifyAsync([issue.AssigneeId, stage?.OwnerId, stage?.AssigneeId, project.OwnerId], $"New issue {key}: {title}",
            $"Observed / Failed{(stage is null ? "" : $" in {stage.Name}")} on {project.Name}", project, issue, ct);
        await db.SaveChangesAsync(ct);

        // An open issue keeps its stage from completing (and reopens it if it was already completed).
        await completion.SyncStagesAsync([issue.StageId], ct);
        return await DetailAsync(project, issue, ct);
    }

    public async Task<IssueDetailDto> UpdateAsync(Guid projectId, Guid issueId, UpdateIssueRequest req, CancellationToken ct = default)
    {
        var project = await ViewableProjectAsync(projectId, ct);
        RequireOpen(project);
        var issue = await FindAsync(projectId, issueId, ct);
        if (!(issue.ReporterId == ctx.UserId || await IsManagerAsync(project, ct)))
            throw new ForbiddenException("Only the person who reported an issue, or a manager, can edit it.", "PERMISSION_DENIED");

        var oldStage = issue.StageId;
        var title = req.Title is null ? issue.Title : CleanTitle(req.Title);
        var details = req.Details is null ? issue.Details : CleanDetails(req.Details);
        var stageChanged = req.StageId is { } sid && sid != issue.StageId;
        if (stageChanged) issue.StageId = (await ResolveStageAsync(projectId, req.StageId, ct))?.Id;

        var changes = new List<string>();
        if (title != issue.Title) changes.Add("title");
        if (details != issue.Details) changes.Add("details");
        if (req.Severity is { } sev && sev != issue.Severity) changes.Add($"severity → {sev}");
        if (stageChanged) changes.Add("stage");
        issue.Title = title; issue.Details = details;
        if (req.Severity is { } s2) issue.Severity = s2;
        if (changes.Count > 0)
        {
            AddEvent(issue, "edited", null, null, string.Join(", ", changes));
            recorder.Activity("issue.updated", "Issue", issue.Id, $"Edited issue {KeyOf(project.Key, issue.Number)} ({string.Join(", ", changes)})", projectId);
        }
        await db.SaveChangesAsync(ct);
        if (stageChanged) await completion.SyncStagesAsync([oldStage, issue.StageId], ct);
        return await DetailAsync(project, issue, ct);
    }

    public async Task<IssueDetailDto> AssignAsync(Guid projectId, Guid issueId, AssignIssueRequest req, CancellationToken ct = default)
    {
        var project = await ViewableProjectAsync(projectId, ct);
        RequireOpen(project);
        var issue = await FindAsync(projectId, issueId, ct);
        if (!(issue.ReporterId == ctx.UserId || await IsManagerAsync(project, ct)))
            throw new ForbiddenException("Only the person who reported an issue, or a manager, can assign it.", "PERMISSION_DENIED");
        if (req.AssigneeId is { } a) await access.EnsureTenantMemberAsync(a, "assigneeId", ct);
        if (req.AssigneeId == issue.AssigneeId) return await DetailAsync(project, issue, ct);

        issue.AssigneeId = req.AssigneeId;
        var who = req.AssigneeId is { } id ? await db.Users.AsNoTracking().Where(u => u.Id == id).Select(u => u.DisplayName).FirstOrDefaultAsync(ct) : null;
        var key = KeyOf(project.Key, issue.Number);
        AddEvent(issue, "assigned", null, null, who is null ? "Unassigned" : $"Assigned to {who}");
        recorder.Activity("issue.assigned", "Issue", issue.Id, who is null ? $"Unassigned issue {key}" : $"Assigned issue {key} to {who}", projectId);
        if (req.AssigneeId is not null) await NotifyAsync([req.AssigneeId], $"Issue {key} was assigned to you", issue.Title, project, issue, ct);
        await db.SaveChangesAsync(ct);
        return await DetailAsync(project, issue, ct);
    }

    public async Task<IssueDetailDto> ChangeStatusAsync(Guid projectId, Guid issueId, ChangeIssueStatusRequest req, CancellationToken ct = default)
    {
        var project = await ViewableProjectAsync(projectId, ct);
        RequireOpen(project);
        var issue = await FindAsync(projectId, issueId, ct);
        var me = ctx.RequireUserId();
        var manager = await IsManagerAsync(project, ct);
        var from = issue.Status; var to = req.Status;
        if (from == to) return await DetailAsync(project, issue, ct);
        if (!MayMove(from, to, issue.ReporterId == me, issue.AssigneeId == me, manager))
            throw new ForbiddenException(
                to is IssueStatus.Resolved or IssueStatus.Observed
                    ? "Only the tester who reported this issue, or a manager, can confirm a fix or send an issue back."
                    : "Only the person the issue is assigned to, or a manager, can change its progress.",
                "ISSUE_STATUS_DENIED");
        var note = CleanNote(req.Note);
        if (to == IssueStatus.Observed && from is IssueStatus.Fixed or IssueStatus.Resolved && note is null)
            throw new ValidationException("note", "Say what still fails, so it can be fixed.");

        issue.Status = to;
        if (to == IssueStatus.Resolved) { issue.ResolvedAt = clock.Now; issue.ResolvedBy = me; }
        else { issue.ResolvedAt = null; issue.ResolvedBy = null; }
        AddEvent(issue, "status", from, to, note);
        var key = KeyOf(project.Key, issue.Number);
        recorder.Activity("issue.status", "Issue", issue.Id, $"Issue {key}: {from} → {to}", projectId, from.ToString(), to.ToString());

        var stage = issue.StageId is { } sid ? await db.ProjectStages.AsNoTracking().FirstOrDefaultAsync(s => s.Id == sid, ct) : null;
        switch (to)
        {
            case IssueStatus.Fixed:
                await NotifyAsync([issue.ReporterId], $"Issue {key} is fixed - please retest", issue.Title, project, issue, ct); break;
            case IssueStatus.Observed:
                await NotifyAsync([issue.AssigneeId, stage?.OwnerId], $"Issue {key} failed again", note ?? issue.Title, project, issue, ct); break;
            case IssueStatus.Resolved:
                await NotifyAsync([issue.AssigneeId, issue.ReporterId], $"Issue {key} is resolved", issue.Title, project, issue, ct); break;
            case IssueStatus.InProgress:
                await NotifyAsync([issue.ReporterId], $"Work has started on issue {key}", issue.Title, project, issue, ct); break;
        }
        await db.SaveChangesAsync(ct);
        // The last open issue being resolved lets the stage complete; a reopened one puts a completed stage back in progress.
        await completion.SyncStagesAsync([issue.StageId], ct);
        return await DetailAsync(project, issue, ct);
    }

    public async Task DeleteAsync(Guid projectId, Guid issueId, CancellationToken ct = default)
    {
        var project = await ViewableProjectAsync(projectId, ct);
        RequireOpen(project);
        var issue = await FindAsync(projectId, issueId, ct);
        if (!(issue.ReporterId == ctx.UserId || await IsManagerAsync(project, ct)))
            throw new ForbiddenException("Only the person who reported an issue, or a manager, can delete it.", "PERMISSION_DENIED");

        var files = await db.Attachments.Where(a => a.IssueId == issueId).ToListAsync(ct);
        db.Attachments.RemoveRange(files);
        db.StageIssueEvents.RemoveRange(await db.StageIssueEvents.Where(e => e.IssueId == issueId).ToListAsync(ct));
        db.StageIssues.Remove(issue);
        recorder.Activity("issue.deleted", "Issue", issue.Id, $"Deleted issue {KeyOf(project.Key, issue.Number)} “{issue.Title}”", projectId);
        await db.SaveChangesAsync(ct);
        foreach (var f in files)
        {
            try { await storage.DeleteAsync(f.StorageKey, ct); }
            catch (Exception ex) { log.LogWarning(ex, "Could not delete stored file {Key} of a deleted issue", f.StorageKey); }
        }
        await completion.SyncStagesAsync([issue.StageId], ct);   // it may have been the last thing holding its stage open
    }

    // ------------------------------------------------------------------ files

    /// <summary>Checks that the caller may add a supporting file to the issue and returns it. Used by the file service.</summary>
    public async Task<StageIssue> RequireCanAttachAsync(Project project, Guid issueId, CancellationToken ct)
    {
        await permissions.RequireModuleAsync(Modules.Tasks, AccessLevel.View, ct);
        RequireOpen(project);
        var issue = await FindAsync(project.Id, issueId, ct);
        var me = ctx.UserId;
        if (!(issue.ReporterId == me || issue.AssigneeId == me || await IsManagerAsync(project, ct)))
            throw new ForbiddenException("Only the tester who reported this issue, the person fixing it, or a manager can attach files to it.", "PERMISSION_DENIED");
        if (await db.Attachments.CountAsync(a => a.IssueId == issueId, ct) >= MaxFilesPerIssue)
            throw new ValidationException("file", $"An issue can have up to {MaxFilesPerIssue} files.");
        return issue;
    }

    /// <summary>Checks that the caller can see the issue (and so its files).</summary>
    public async Task RequireVisibleAsync(Guid projectId, Guid issueId, CancellationToken ct)
    {
        await ViewableProjectAsync(projectId, ct);
        if (!await db.StageIssues.AnyAsync(i => i.Id == issueId && i.ProjectId == projectId, ct)) throw new NotFoundException("Issue not found.", "ISSUE_NOT_FOUND");
    }
}
