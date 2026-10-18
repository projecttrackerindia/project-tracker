using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Issues;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.Tasks;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Agent;

/// <summary>
/// The review queue: what the agent proposed, approved (and carried out with the approver's own rights, through the same services the screens
/// use) or dismissed by someone who may edit the project. Notes - delays, missed points, suggestions, decisions - are recorded when approved.
/// </summary>
public class AgentReviewService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, ProjectAccess access, AgentSettingsService settings,
    TaskService tasks, ActionItemService actionItems, IssueService issues, NotificationService notifications, AgentMinutesService minutes,
    ILogger<AgentReviewService> log)
{
    private const int PageSize = 100;

    public async Task<AgentFindingPageDto> ListAsync(Guid projectId, string? status, CancellationToken ct = default)
    {
        var project = await access.GetProjectAsync(projectId, ct);
        var wanted = StatusOf(status);
        var q = db.AgentFindings.AsNoTracking().Where(f => f.ProjectId == projectId);
        q = wanted is { } w ? q.Where(f => f.Status == w) : q;
        var pending = await db.AgentFindings.CountAsync(f => f.ProjectId == projectId && f.Status == AgentFindingStatus.Proposed, ct);
        // What the agent read (quotes from mail, meetings and members' inboxes) is shown only to the people who decide on it.
        if (!await settings.CanManageAsync(project, ct)) return new AgentFindingPageDto([], pending, false);
        var rows = await q.OrderByDescending(f => f.CreatedAt).Take(PageSize).ToListAsync(ct);
        return new AgentFindingPageDto(await DtosAsync(rows, ct), pending, true);
    }

    /// <summary>Everything waiting across the projects this person may decide on - the workspace's agent inbox.</summary>
    public async Task<AgentFindingPageDto> InboxAsync(CancellationToken ct = default)
    {
        ctx.RequireTenantId();
        var projectIds = await db.AgentFindings.AsNoTracking().Where(f => f.Status == AgentFindingStatus.Proposed).Select(f => f.ProjectId).Distinct().Take(200).ToListAsync(ct);
        var mine = new List<Guid>();
        foreach (var p in await db.Projects.Where(p => projectIds.Contains(p.Id)).ToListAsync(ct))
            if (await settings.CanManageAsync(p, ct)) mine.Add(p.Id);
        var rows = await db.AgentFindings.AsNoTracking().Where(f => mine.Contains(f.ProjectId) && f.Status == AgentFindingStatus.Proposed)
            .OrderByDescending(f => f.CreatedAt).Take(PageSize).ToListAsync(ct);
        var pending = await db.AgentFindings.CountAsync(f => mine.Contains(f.ProjectId) && f.Status == AgentFindingStatus.Proposed, ct);
        return new AgentFindingPageDto(await DtosAsync(rows, ct), pending, true);
    }

    public async Task<AgentFindingDto> DismissAsync(Guid id, CancellationToken ct = default)
    {
        var f = await DecidableAsync(id, ct);
        f.Status = AgentFindingStatus.Dismissed; f.DecidedBy = ctx.RequireUserId(); f.DecidedAt = clock.Now; f.UpdatedAt = clock.Now;
        recorder.Audit("agent.finding_dismissed", "AgentFinding", f.Id, null, new { f.Kind });
        await db.SaveChangesAsync(ct);
        await MinutesAsync([f.RunId], ct);
        return (await DtosAsync([f], ct))[0];
    }

    public async Task<AgentFindingDto> ApproveAsync(Guid id, ApproveFindingRequest? edits, CancellationToken ct = default)
    {
        var f = await DecidableAsync(id, ct);
        if (edits is not null) await EditAsync(f, edits, ct);
        await ApplyAsync(f, ct);
        await MinutesAsync([f.RunId], ct);
        return (await DtosAsync([await db.AgentFindings.AsNoTracking().FirstAsync(x => x.Id == id, ct)], ct))[0];
    }

    public async Task<ApproveAllResult> ApproveAllAsync(Guid projectId, CancellationToken ct = default)
    {
        var project = await access.GetProjectAsync(projectId, ct);
        if (!await settings.CanManageAsync(project, ct)) throw new ForbiddenException("Only people who may edit this project can approve the agent's proposals.", "PERMISSION_DENIED");
        // In one go only what adds: new tasks, tickets, action items and notes. Changes to existing work (status, owner, dates) are approved one by one.
        var ids = await db.AgentFindings.Where(f => f.ProjectId == projectId && f.Status == AgentFindingStatus.Proposed
                && f.Kind != AgentFindingKind.UpdateTask && f.Kind != AgentFindingKind.UpdateIssue && !(f.Kind == AgentFindingKind.Delay && f.DueDate != null))
            .OrderBy(f => f.CreatedAt).Select(f => f.Id).Take(50).ToListAsync(ct);
        var skipped = await db.AgentFindings.CountAsync(f => f.ProjectId == projectId && f.Status == AgentFindingStatus.Proposed, ct) - ids.Count;
        int applied = 0, failed = 0;
        foreach (var id in ids)
        {
            var f = await db.AgentFindings.FirstAsync(x => x.Id == id, ct);
            await ApplyAsync(f, ct);
            if (f.Status == AgentFindingStatus.Applied) applied++; else failed++;
        }
        var rows = await db.AgentFindings.AsNoTracking().Where(f => ids.Contains(f.Id)).OrderBy(f => f.CreatedAt).ToListAsync(ct);
        await MinutesAsync(rows.Select(r => r.RunId), ct);
        return new ApproveAllResult(applied, failed, await DtosAsync(rows, ct), skipped);
    }

    /// <summary>Minutes go out once a meeting is fully decided; a failure there never undoes the decision.</summary>
    private async Task MinutesAsync(IEnumerable<Guid> runIds, CancellationToken ct)
    {
        try { await minutes.SendIfDecidedAsync(runIds, ct); }
        catch (Exception ex) when (ex is not OperationCanceledException) { log.LogWarning(ex, "Project agent minutes could not be sent"); }
    }

    // ---------------------------------------------------------------- the assignee's answer

    private static readonly AgentFindingKind[] Gives = [AgentFindingKind.CreateTask, AgentFindingKind.CreateActionItem, AgentFindingKind.CreateIssue];

    /// <summary>Work the agent gave me in the last month (approved by someone else), so I can say it is mine - or that it is not.</summary>
    public async Task<AgentFindingPageDto> AssignedAsync(CancellationToken ct = default)
    {
        var me = ctx.RequireUserId(); ctx.RequireTenantId();
        var since = clock.Now.AddDays(-30);
        var rows = await db.AgentFindings.AsNoTracking().Where(f => f.AssigneeId == me && f.Status == AgentFindingStatus.Applied && Gives.Contains(f.Kind)
                && f.DecidedAt >= since && f.DecidedBy != me)
            .OrderBy(f => f.OwnerResponse != null).ThenByDescending(f => f.DecidedAt).Take(PageSize).ToListAsync(ct);
        var waiting = await db.AgentFindings.CountAsync(f => f.AssigneeId == me && f.Status == AgentFindingStatus.Applied && Gives.Contains(f.Kind)
            && f.DecidedAt >= since && f.DecidedBy != me && f.OwnerResponse == null, ct);
        // Only the short quote it came from; nothing else of what the agent read.
        var dtos = (await DtosAsync(rows, ct)).Select(d => d with { Evidence = AgentAnalysisService.Cut(d.Evidence, 200) }).ToList();
        return new AgentFindingPageDto(dtos, waiting, false);
    }

    /// <summary>The assignee accepts the work the agent gave them, or says it is not theirs (the approver and the project owner hear why).</summary>
    public async Task<AgentFindingDto> RespondAsync(Guid id, AgentOwnerResponseRequest req, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var f = await db.AgentFindings.FirstOrDefaultAsync(x => x.Id == id, ct) ?? throw new NotFoundException("That item was not found.");
        if (f.AssigneeId != me || f.Status != AgentFindingStatus.Applied || !Gives.Contains(f.Kind))
            throw new ForbiddenException("Only the person the agent gave this to can answer.", "PERMISSION_DENIED");
        var answer = req.Response?.Trim().ToLowerInvariant();
        if (answer is not ("accepted" or "declined")) throw new ValidationException("response", "Answer accepted or declined.");
        var note = req.Note?.Trim();
        if (note is { Length: > 500 }) throw new ValidationException("note", "Keep the note to 500 characters.");
        if (answer == "declined" && string.IsNullOrEmpty(note)) throw new ValidationException("note", "Say why, or whose it is, so the lead can pass it on.");
        f.OwnerResponse = answer; f.OwnerNote = string.IsNullOrEmpty(note) ? null : note; f.OwnerRespondedAt = clock.Now; f.UpdatedAt = clock.Now;
        recorder.Audit(answer == "accepted" ? "agent.owner_accepted" : "agent.owner_declined", "AgentFinding", f.Id, null, new { f.AppliedKey });
        if (answer == "declined")
        {
            var project = await db.Projects.AsNoTracking().FirstAsync(p => p.Id == f.ProjectId, ct);
            var who = await db.Users.AsNoTracking().Where(u => u.Id == me).Select(u => u.DisplayName).FirstAsync(ct);
            var what = f.AppliedKey ?? f.Title;
            foreach (var uid in new[] { f.DecidedBy ?? project.OwnerId, project.OwnerId }.Distinct())
                await notifications.AddAsync(uid, NotificationType.ProjectUpdated, Text.Truncate($"{who} says {what} is not theirs", 200)!, $"{f.Title}: {note}",
                    $"/projects/{project.Id}?tab=agent", $"agent-declined:{f.Id}:{uid}", ct: ct);
            // On the task too, so whoever looks at it sees the question.
            if (f.Kind == AgentFindingKind.CreateTask && f.AppliedEntityId is { } taskId)
            {
                try { await tasks.AddCommentAsync(taskId, new CreateCommentRequest(AgentAnalysisService.Cut($"Not mine: {note}", 4000)!, null, null), ct); }
                catch (AppException) { /* they may not be allowed to comment; the notice is enough */ }
            }
        }
        await db.SaveChangesAsync(ct);
        return (await DtosAsync([f], ct))[0];
    }

    // ---------------------------------------------------------------- deciding

    private async Task<AgentFinding> DecidableAsync(Guid id, CancellationToken ct)
    {
        var f = await db.AgentFindings.FirstOrDefaultAsync(x => x.Id == id, ct) ?? throw new NotFoundException("That proposal was not found.");
        var project = await access.GetProjectAsync(f.ProjectId, ct);
        if (!await settings.CanManageAsync(project, ct)) throw new ForbiddenException("Only people who may edit this project can decide on the agent's proposals.", "PERMISSION_DENIED");
        if (f.Status is not (AgentFindingStatus.Proposed or AgentFindingStatus.Failed)) throw new ConflictException("Someone already decided on this proposal.", "AGENT_ALREADY_DECIDED");
        return f;
    }

    private async Task EditAsync(AgentFinding f, ApproveFindingRequest e, CancellationToken ct)
    {
        // What the approver changed is kept, so the agent learns how this team wants things written and given out.
        var changed = new List<string>();
        var before = (f.Title, f.Detail, f.AssigneeId, f.DueDate, f.Priority, f.NewStatus, f.Comment);
        if (e.Title is { } title)
        {
            title = title.Trim();
            if (title.Length is < 2 or > 200) throw new ValidationException("title", "Give it a title of 2 to 200 characters.");
            f.Title = title;
        }
        if (e.Detail is not null) f.Detail = AgentAnalysisService.Cut(e.Detail.Trim(), 1500);
        if (e.ClearAssignee == true) f.AssigneeId = null;
        else if (e.AssigneeId is { } who) { await access.EnsureTenantMemberAsync(who, "assigneeId", ct); f.AssigneeId = who; }
        if (e.ClearDueDate == true) f.DueDate = null; else if (e.DueDate is { } due) f.DueDate = due;
        if (e.Priority is { } p) f.Priority = p;
        Changes();
        void Changes()
        {
            if (f.Title != before.Title) { f.OriginalTitle ??= before.Title; changed.Add("title"); }
            if (f.Detail != before.Detail) changed.Add("description");
            if (f.AssigneeId != before.AssigneeId) changed.Add("owner");
            if (f.DueDate != before.DueDate) changed.Add("date");
            if (f.Priority != before.Priority) changed.Add("priority");
        }
        if (e.NewStatus is { } st)
        {
            var ok = f.Kind == AgentFindingKind.UpdateTask ? st is "todo" or "in_progress" or "done" : f.Kind == AgentFindingKind.UpdateIssue && st is "in_progress" or "fixed" or "resolved";
            if (!ok && st.Length > 0) throw new ValidationException("newStatus", "That status does not fit this proposal.");
            f.NewStatus = st.Length == 0 ? null : st;
        }
        if (e.Comment is not null) f.Comment = e.Comment.Trim().Length == 0 ? null : AgentAnalysisService.Cut(e.Comment.Trim(), 4000);
        if (f.NewStatus != before.NewStatus) changed.Add("status");
        if (f.Comment != before.Comment) changed.Add("comment");
        if (changed.Count > 0) f.Edits = AgentAnalysisService.Cut(string.Join(", ", changed.Distinct()), 500);
    }

    /// <summary>Carries the proposal out as the person approving it. A failure is kept on the proposal (they can edit it and try again).</summary>
    private async Task ApplyAsync(AgentFinding f, CancellationToken ct)
    {
        var id = f.Id; var me = ctx.RequireUserId();
        Guid? entity = null; string? key = null;
        try
        {
            (entity, key) = await CarryOutAsync(f, ct);
        }
        catch (AppException ex)
        {
            AgentDb.ClearTracking(db);
            var failed = await db.AgentFindings.FirstAsync(x => x.Id == id, ct);
            Copy(f, failed);
            failed.Status = AgentFindingStatus.Failed; failed.Error = AgentAnalysisService.Cut(ex.Message, 500); failed.UpdatedAt = clock.Now;
            await db.SaveChangesAsync(ct);
            f.Status = AgentFindingStatus.Failed; f.Error = failed.Error;
            return;
        }
        var row = await db.AgentFindings.FirstAsync(x => x.Id == id, ct);
        if (!ReferenceEquals(row, f)) Copy(f, row);
        row.Status = AgentFindingStatus.Applied; row.Error = null; row.DecidedBy = me; row.DecidedAt = clock.Now; row.UpdatedAt = clock.Now;
        row.AppliedEntityId = entity; row.AppliedKey = key;
        recorder.Audit("agent.finding_applied", "AgentFinding", row.Id, null, new { row.Kind, entity, key });
        if (row.Kind is AgentFindingKind.Delay or AgentFindingKind.Missed or AgentFindingKind.Suggestion or AgentFindingKind.Decision)
            recorder.Activity("agent.note", "Project", row.ProjectId, $"{Noun(row.Kind)} noted by the project agent: {row.Title}", row.ProjectId);
        // Work given to someone else: they are asked to confirm it is theirs (one tap), so a wrong owner is caught the same day.
        if (row.AssigneeId is { } owner && owner != me && Gives.Contains(row.Kind))
            await notifications.AddAsync(owner, NotificationType.TaskAssigned, Text.Truncate($"Is {(key ?? row.Title)} yours? The project agent gave it to you", 200)!,
                $"{row.Title}{(row.SourceLabel is null ? "" : $" - from {row.SourceLabel}")}. Accept it, or say whose it is.", "/project-agent/assigned",
                $"agent-owner:{row.Id}", ct: ct);
        await db.SaveChangesAsync(ct);
        f.Status = row.Status;
    }

    private static void Copy(AgentFinding from, AgentFinding to)
    {
        to.Title = from.Title; to.Detail = from.Detail; to.AssigneeId = from.AssigneeId; to.DueDate = from.DueDate; to.Priority = from.Priority;
        to.NewStatus = from.NewStatus; to.Comment = from.Comment; to.Edits = from.Edits; to.OriginalTitle = from.OriginalTitle;
    }

    private static string Noun(AgentFindingKind k) => k switch
    {
        AgentFindingKind.Delay => "Delay", AgentFindingKind.Missed => "Missed point", AgentFindingKind.Suggestion => "Suggestion", _ => "Decision",
    };

    private string Footer(AgentFinding f) =>
        $"\n\n— From the project agent{(f.SourceLabel is null ? "" : $" ({f.SourceLabel})")}{(f.Evidence is null ? "" : $": “{f.Evidence}”")}";

    private async Task<(Guid? Entity, string? Key)> CarryOutAsync(AgentFinding f, CancellationToken ct)
    {
        switch (f.Kind)
        {
            case AgentFindingKind.CreateTask:
            {
                var created = await tasks.CreateAsync(f.ProjectId, new CreateTaskRequest(f.Title, Describe(f), null, f.Priority ?? Priority.Medium, f.AssigneeId, null, f.DueDate,
                    null, null, null), ct);
                return (created.Id, created.Key);
            }
            case AgentFindingKind.CreateActionItem:
            {
                var created = await actionItems.CreateAsync(f.ProjectId, new CreateActionItemRequest(f.Title, Describe(f, 2000), f.AssigneeId, f.DueDate, f.Priority), ct);
                return (created.Id, null);
            }
            case AgentFindingKind.CreateIssue:
            {
                var created = await issues.CreateAsync(f.ProjectId, new CreateIssueRequest(null, f.Title, Describe(f), f.Priority, f.AssigneeId), ct);
                return (created.Issue.Id, created.Issue.Key);
            }
            case AgentFindingKind.UpdateTask:
                return await UpdateTaskAsync(f, ct);
            case AgentFindingKind.UpdateIssue:
            {
                var issueId = f.IssueId ?? throw new ValidationException("issueId", "This proposal is not about a ticket.");
                IssueDetailDto? detail = null;
                if (f.AssigneeId is { } who) detail = await issues.AssignAsync(f.ProjectId, issueId, new AssignIssueRequest(who), ct);
                if (f.NewStatus is { } st)
                {
                    var to = st switch { "fixed" => IssueStatus.Fixed, "resolved" => IssueStatus.Resolved, _ => IssueStatus.InProgress };
                    detail = await issues.ChangeStatusAsync(f.ProjectId, issueId, new ChangeIssueStatusRequest(to, AgentAnalysisService.Cut(f.Comment ?? f.Detail, 1000)), ct);
                }
                detail ??= await issues.GetAsync(f.ProjectId, issueId, ct);
                return (issueId, detail.Issue.Key);
            }
            case AgentFindingKind.Delay when f.TaskId is { } taskId:
            {
                // A delay with a new date moves the task (the reason is the agent's note); otherwise it is written on the task.
                if (f.DueDate is not null) return await UpdateTaskAsync(f, ct);
                await tasks.AddCommentAsync(taskId, new CreateCommentRequest(AgentAnalysisService.Cut($"Delay flagged: {f.Detail ?? f.Title}{Footer(f)}", 4000)!, null, null), ct);
                return (taskId, await KeyOfAsync(taskId, ct));
            }
            default:
                return (f.TaskId ?? f.IssueId, f.TaskId is { } t ? await KeyOfAsync(t, ct) : null);
        }
    }

    private string Describe(AgentFinding f, int max = 3900) => AgentAnalysisService.Cut((f.Detail ?? "") + Footer(f), max)!.Trim();

    private async Task<string?> KeyOfAsync(Guid taskId, CancellationToken ct) =>
        await db.Tasks.Where(t => t.Id == taskId).Select(t => t.Project!.Key + "-" + t.Number).FirstOrDefaultAsync(ct);

    private async Task<(Guid? Entity, string? Key)> UpdateTaskAsync(AgentFinding f, CancellationToken ct)
    {
        var taskId = f.TaskId ?? throw new ValidationException("taskId", "This proposal is not about a task.");
        var task = await db.Tasks.AsNoTracking().FirstOrDefaultAsync(t => t.Id == taskId, ct) ?? throw new NotFoundException("The task was deleted.");
        var changes = f.NewStatus is not null || f.AssigneeId is { } a && a != task.AssigneeId || f.DueDate is { } d && d != task.DueDate || f.Priority is { } p && p != task.Priority;
        if (changes)
        {
            var statusId = task.StatusId;
            if (f.NewStatus is { } st)
            {
                var category = st switch { "done" => StatusCategory.Done, "in_progress" => StatusCategory.Active, _ => StatusCategory.Todo };
                var current = await db.WorkflowStatuses.Where(s => s.Id == task.StatusId).Select(s => s.Category).FirstAsync(ct);
                if (current != category)
                    statusId = await db.WorkflowStatuses.Where(s => s.ProjectId == task.ProjectId && s.Category == category).OrderBy(s => s.Order).Select(s => (Guid?)s.Id).FirstOrDefaultAsync(ct)
                        ?? throw new ValidationException("newStatus", "The project has no status for that.");
            }
            var labels = await db.TaskLabels.Where(l => l.TaskId == taskId).Select(l => l.LabelId).ToListAsync(ct);
            var due = f.DueDate ?? task.DueDate;
            var reason = due != task.DueDate ? AgentAnalysisService.Cut($"Project agent: {f.Detail ?? f.Title}", 480) : null;
            await tasks.UpdateAsync(taskId, new UpdateTaskRequest(task.Title, task.Description, statusId, f.Priority ?? task.Priority, f.AssigneeId ?? task.AssigneeId,
                task.StartDate, due, task.EstimatedHours, task.ActualHours, labels, task.Version, task.MilestoneId, null, reason, null), ct);
        }
        if (f.Comment is { } comment)
            await tasks.AddCommentAsync(taskId, new CreateCommentRequest(AgentAnalysisService.Cut(comment + Footer(f), 4000)!, null, null), ct);
        else if (!changes)
            await tasks.AddCommentAsync(taskId, new CreateCommentRequest(AgentAnalysisService.Cut((f.Detail ?? f.Title) + Footer(f), 4000)!, null, null), ct);
        return (taskId, await KeyOfAsync(taskId, ct));
    }

    // ---------------------------------------------------------------- shaping

    private static AgentFindingStatus? StatusOf(string? s) => s?.ToLowerInvariant() switch
    {
        null or "" or "proposed" => AgentFindingStatus.Proposed,
        "applied" => AgentFindingStatus.Applied,
        "dismissed" => AgentFindingStatus.Dismissed,
        "failed" => AgentFindingStatus.Failed,
        "all" => null,
        _ => throw new ValidationException("status", "Choose proposed, applied, dismissed, failed or all."),
    };

    private async Task<List<AgentFindingDto>> DtosAsync(IReadOnlyList<AgentFinding> rows, CancellationToken ct)
    {
        if (rows.Count == 0) return [];
        var projectIds = rows.Select(r => r.ProjectId).Distinct().ToList();
        var projects = await db.Projects.AsNoTracking().Where(p => projectIds.Contains(p.Id)).ToDictionaryAsync(p => p.Id, p => new { p.Key, p.Name }, ct);
        var userIds = rows.SelectMany(r => new[] { r.AssigneeId, r.DecidedBy }).Where(x => x is not null).Select(x => x!.Value).Distinct().ToList();
        var users = await db.Users.AsNoTracking().Where(u => userIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        var taskIds = rows.Where(r => r.TaskId is not null).Select(r => r.TaskId!.Value).Distinct().ToList();
        var taskRows = await db.Tasks.AsNoTracking().Where(t => taskIds.Contains(t.Id)).Select(t => new { t.Id, t.Number, t.Title, t.ProjectId }).ToListAsync(ct);
        var issueIds = rows.Where(r => r.IssueId is not null).Select(r => r.IssueId!.Value).Distinct().ToList();
        var issueRows = await db.StageIssues.AsNoTracking().Where(i => issueIds.Contains(i.Id)).Select(i => new { i.Id, i.Number, i.ProjectId }).ToListAsync(ct);
        var signalIds = rows.Where(r => r.SignalId is not null).Select(r => r.SignalId!.Value).Distinct().ToList();
        var sources = await db.AgentSignals.AsNoTracking().Where(s => signalIds.Contains(s.Id)).ToDictionaryAsync(s => s.Id, s => s.Source, ct);
        AgentPersonRef? Person(Guid? id) => id is { } x && users.TryGetValue(x, out var n) ? new AgentPersonRef(x, n) : null;
        return rows.Select(r =>
        {
            var p = projects.GetValueOrDefault(r.ProjectId);
            var t = r.TaskId is { } tid ? taskRows.FirstOrDefault(x => x.Id == tid) : null;
            var i = r.IssueId is { } iid ? issueRows.FirstOrDefault(x => x.Id == iid) : null;
            return new AgentFindingDto(r.Id, r.ProjectId, p?.Key ?? "", p?.Name ?? "", r.RunId, r.Kind, r.Status, r.Title, r.Detail, r.Evidence, r.SourceLabel,
                r.SignalId is { } sid && sources.TryGetValue(sid, out var src) ? src : null,
                r.TaskId, t is null ? null : $"{p?.Key}-{t.Number}", t?.Title, r.IssueId, i is null ? null : $"{p?.Key}-I{i.Number}",
                Person(r.AssigneeId), r.DueDate, r.Priority, r.NewStatus, r.Comment, r.Confidence, r.CreatedAt, Person(r.DecidedBy), r.DecidedAt,
                r.AppliedEntityId, r.AppliedKey, r.Error, r.Grounded, r.Edits, r.OwnerResponse, r.OwnerNote, r.OwnerRespondedAt);
        }).ToList();
    }
}
