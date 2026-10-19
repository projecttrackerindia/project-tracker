using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Application.Features.Tasks;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Agent;

/// <summary>
/// Follows up on commitments: work someone agreed to by a date. It keeps each commitment's state honest (kept when the work is done on time,
/// missed when its day passes, moved when a new date is approved, dropped when the work goes away), and on the due day asks the owner how it
/// stands. "I need more time" or "I'm blocked" becomes a proposal for the project lead, with what the new date would move - nothing changes
/// until the lead decides. Plain rules; no model is involved.
/// </summary>
public class AgentFollowUpService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, NotificationService notifications, TaskService tasks,
    ActionItemService actionItems, AgentImpactService impact, IOptions<AgentOptions> options)
{
    /// <summary>One tick for one project (in its workspace's context): update states, then send the day's check-ins.</summary>
    public async Task<int> RunAsync(ProjectAgentSettings s, CancellationToken ct)
    {
        if (!s.Enabled) return 0;
        var zone = await db.Tenants.AsNoTracking().Where(t => t.Id == s.TenantId).Select(t => t.TimeZone).FirstOrDefaultAsync(ct);
        var tz = ZoneTime.Find(ZoneTime.IsKnown(zone) ? zone : AppClock.FallbackZoneId);
        var local = ZoneTime.ToLocal(clock.Now, tz);
        var today = DateOnly.FromDateTime(local);
        await RefreshAsync(s.ProjectId, today, tz, ct);
        if (!s.FollowUps || local.Hour < Math.Clamp(options.Value.DailyUpdateHour + 1, 0, 23)) return 0;

        var due = await db.AgentCommitments.Where(c => c.ProjectId == s.ProjectId && c.Status == "open" && c.DueDate == today && c.CheckInSentAt == null)
            .OrderBy(c => c.CreatedAt).Take(50).ToListAsync(ct);
        if (due.Count == 0) return 0;
        var owners = due.Select(c => c.OwnerUserId).Distinct().ToList();
        var optedOut = await db.AgentPersonalSettings.AsNoTracking().Where(p => owners.Contains(p.UserId) && !p.CheckIns).Select(p => p.UserId).ToListAsync(ct);
        var project = await db.Projects.AsNoTracking().FirstAsync(p => p.Id == s.ProjectId, ct);
        var sent = 0;
        foreach (var c in due)
        {
            // Claim it: with several servers, only one sends.
            if (await db.AgentCommitments.Where(x => x.Id == c.Id && x.CheckInSentAt == null).ExecuteUpdateAsync(u => u.SetProperty(x => x.CheckInSentAt, clock.Now), ct) != 1) continue;
            if (optedOut.Contains(c.OwnerUserId)) continue;
            var what = c.EntityKey ?? c.Title;
            var said = c.Quote is { Length: > 0 } q ? $"You said: “{AgentAnalysisService.Cut(q, 140)}”{(c.SourceLabel is null ? "" : $" ({c.SourceLabel})")}. " : "";
            await notifications.AddAsync(c.OwnerUserId, NotificationType.Reminder, Text.Truncate($"Is {what} on track for today?", 200)!,
                Text.Truncate($"{said}One tap tells {project.Name}: on track, done, need more time, or blocked.", 500), $"/command-center?checkin={c.Id}",
                $"agent-checkin:{c.Id:N}", toSelf: true, ct: ct);
            sent++;
        }
        await db.SaveChangesAsync(ct);
        return sent;
    }

    /// <summary>Keeps open commitments in step with the work they are about.</summary>
    private async Task RefreshAsync(Guid projectId, DateOnly today, NodaTime.DateTimeZone tz, CancellationToken ct)
    {
        var open = await db.AgentCommitments.Where(c => c.ProjectId == projectId && (c.Status == "open" || c.Status == "missed") && c.ResolvedAt == null)
            .OrderBy(c => c.DueDate).Take(300).ToListAsync(ct);
        if (open.Count == 0) return;
        var taskIds = open.Where(c => c.TaskId is not null).Select(c => c.TaskId!.Value).ToList();
        var workIds = open.Where(c => c.WorkTaskId is not null).Select(c => c.WorkTaskId!.Value).ToList();
        var taskRows = await db.Tasks.AsNoTracking().Where(t => taskIds.Contains(t.Id))
            .Select(t => new { t.Id, t.DueDate, t.CompletedAt, Cat = t.Status!.Category }).ToDictionaryAsync(t => t.Id, ct);
        var workRows = await db.WorkTasks.AsNoTracking().Where(t => workIds.Contains(t.Id))
            .Select(t => new { t.Id, t.DueDate, t.CompletedAt, t.Status }).ToDictionaryAsync(t => t.Id, ct);
        foreach (var c in open)
        {
            bool gone, finished; DateTime? completedAt; DateOnly? dueNow;
            if (c.TaskId is { } tid)
            {
                var t = taskRows.GetValueOrDefault(tid);
                gone = t is null || t.Cat == StatusCategory.Cancelled; finished = t?.Cat == StatusCategory.Done; completedAt = t?.CompletedAt; dueNow = t?.DueDate;
            }
            else if (c.WorkTaskId is { } wid)
            {
                var w = workRows.GetValueOrDefault(wid);
                gone = w is null || w.Status == WorkTaskStatus.Cancelled; finished = w?.Status == WorkTaskStatus.Completed; completedAt = w?.CompletedAt; dueNow = w?.DueDate;
            }
            else continue;
            if (gone) { c.Status = "dropped"; c.ResolvedAt = clock.Now; }
            else if (finished)
            {
                var day = completedAt is { } at ? DateOnly.FromDateTime(ZoneTime.ToLocal(at, tz)) : today;
                c.Status = day <= c.DueDate ? "kept" : "missed";
                c.ResolvedAt = clock.Now;
            }
            // Someone gave the work a later date outside the agent (on the task itself): the commitment moved with it.
            else if (dueNow is { } d && d > c.DueDate && c.Status == "open") { c.Status = "moved"; c.ResolvedAt = clock.Now; }
            else if (c.Status == "open" && c.DueDate < today) c.Status = "missed";
            else continue;
            c.UpdatedAt = clock.Now;
        }
        await db.SaveChangesAsync(ct);
    }

    // ---------------------------------------------------------------- the owner's side

    /// <summary>My commitments: open, recently missed, and the check-ins waiting for my answer.</summary>
    public async Task<IReadOnlyList<AgentCommitmentDto>> MineAsync(CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var since = clock.Today.AddDays(-14);
        var rows = await db.AgentCommitments.AsNoTracking().Where(c => c.OwnerUserId == me
                && (c.Status == "open" || c.Status == "missed" && c.ResolvedAt == null && c.DueDate >= since))
            .OrderBy(c => c.DueDate).Take(50).ToListAsync(ct);
        return await DtosAsync(rows, ct);
    }

    public async Task<AgentCommitmentDto> GetAsync(Guid id, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var c = await db.AgentCommitments.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id, ct) ?? throw new NotFoundException("That commitment was not found.");
        if (c.OwnerUserId != me && c.ApprovedBy != me && !await CanManageAsync(c.ProjectId, ct)) throw new NotFoundException("That commitment was not found.");
        return (await DtosAsync([c], ct))[0];
    }

    /// <summary>
    /// The owner answers a check-in. on_track and done are recorded (done also completes the work); more_time (a later date and why) and blocked
    /// (what it waits on) become a proposal for the project lead - the date only changes when the lead approves it.
    /// </summary>
    public async Task<AgentCommitmentDto> AnswerAsync(Guid id, AgentCheckInRequest req, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var c = await db.AgentCommitments.FirstOrDefaultAsync(x => x.Id == id, ct) ?? throw new NotFoundException("That commitment was not found.");
        if (c.OwnerUserId != me) throw new ForbiddenException("Only the person who made this commitment can answer for it.", "PERMISSION_DENIED");
        if (c.Status is not ("open" or "missed") || c.ResolvedAt is not null) throw new ConflictException("This commitment is already settled.", "AGENT_COMMITMENT_SETTLED");
        var answer = req.Answer?.Trim().ToLowerInvariant();
        if (answer is not ("on_track" or "done" or "more_time" or "blocked")) throw new ValidationException("answer", "Answer on_track, done, more_time or blocked.");
        var note = req.Note?.Trim();
        if (note is { Length: > 500 }) throw new ValidationException("note", "Keep the note to 500 characters.");
        if (answer is "more_time" or "blocked" && string.IsNullOrEmpty(note))
            throw new ValidationException("note", answer == "blocked" ? "Say what it is waiting on, so the lead can unblock it." : "Say why, so the lead can decide.");
        if (answer == "more_time")
        {
            if (req.NewDate is not { } nd || nd <= c.DueDate) throw new ValidationException("newDate", "Choose a date after the current one.");
            if (nd > clock.Today.AddDays(366)) throw new ValidationException("newDate", "Choose a date within a year.");
        }
        if (c.ChangeFindingId is { } pending && await db.AgentFindings.AnyAsync(f => f.Id == pending && f.Status == AgentFindingStatus.Proposed, ct)
            && answer is "more_time" or "blocked")
            throw new ConflictException("Your last request is still with the lead.", "AGENT_REQUEST_PENDING");

        c.CheckInAnswer = answer; c.CheckInNote = string.IsNullOrEmpty(note) ? null : note; c.AnsweredAt = clock.Now; c.UpdatedAt = clock.Now;
        c.CheckInSentAt ??= clock.Now;
        recorder.Audit("agent.check_in", "AgentCommitment", c.Id, null, new { answer, c.EntityKey, req.NewDate });
        switch (answer)
        {
            case "done":
                await CompleteAsync(c, ct);
                break;
            case "more_time" or "blocked":
                await RequestChangeAsync(c, answer, note!, answer == "more_time" ? req.NewDate : null, ct);
                break;
        }
        await db.SaveChangesAsync(ct);
        return (await DtosAsync([c], ct))[0];
    }

    private async Task CompleteAsync(AgentCommitment c, CancellationToken ct)
    {
        if (c.TaskId is { } taskId)
        {
            var task = await db.Tasks.AsNoTracking().FirstOrDefaultAsync(t => t.Id == taskId, ct) ?? throw new NotFoundException("The task was deleted.");
            var done = await db.WorkflowStatuses.Where(s => s.ProjectId == task.ProjectId && s.Category == StatusCategory.Done).OrderBy(s => s.Order).Select(s => (Guid?)s.Id).FirstOrDefaultAsync(ct)
                ?? throw new ConflictException("The project has no finished status.", "NO_DONE_STATUS");
            if (task.StatusId != done) await tasks.MoveAsync(taskId, new MoveTaskRequest(done, null), ct);
        }
        else if (c.WorkTaskId is { } itemId)
            await actionItems.SetStatusAsync(c.ProjectId, itemId, new SetActionItemStatusRequest(ActionItemStatus.Completed), ct);
        c.Status = clock.Today <= c.DueDate ? "kept" : "missed"; c.ResolvedAt = clock.Now;
    }

    private async Task RequestChangeAsync(AgentCommitment c, string answer, string note, DateOnly? newDate, CancellationToken ct)
    {
        var me = ctx.RequireUserId();
        var who = await db.Users.AsNoTracking().Where(u => u.Id == me).Select(u => u.DisplayName).FirstAsync(ct);
        var what = c.EntityKey ?? c.Title;
        var f = new AgentFinding
        {
            TenantId = c.TenantId, ProjectId = c.ProjectId, RunId = c.Id, Kind = AgentFindingKind.Delay, Status = AgentFindingStatus.Proposed,
            Title = AgentAnalysisService.Cut(newDate is { } nd ? $"Move {what} to {nd:d MMM}" : $"{what} is blocked", 200)!,
            Detail = AgentAnalysisService.Cut(note, 1500), Evidence = AgentAnalysisService.Cut(note, 400),
            SourceLabel = AgentAnalysisService.Cut($"Check-in from {who} · {clock.Today:d MMM}", 200), TaskId = c.TaskId, DueDate = newDate,
            Confidence = 100, Grounded = true, CommitmentId = c.Id, CreatedAt = clock.Now, CreatedBy = me,
        };
        db.AgentFindings.Add(f);
        c.ChangeFindingId = f.Id; c.ProposedDate = newDate;
        var project = await db.Projects.AsNoTracking().FirstAsync(p => p.Id == c.ProjectId, ct);
        string? effect = null;
        if (newDate is { } d && c.TaskId is { } taskId)
        {
            try { effect = (await impact.AnalyzeAsync(taskId, d, ct)).Summary; }
            catch (AppException) { /* the task may have gone; the request still stands */ }
        }
        var title = newDate is { } d2 ? $"{who} asks to move {what} to {d2:d MMM}" : $"{who} is blocked on {what}";
        foreach (var uid in new[] { c.ApprovedBy ?? project.OwnerId, project.OwnerId }.Distinct())
            await notifications.AddAsync(uid, NotificationType.ProjectUpdated, Text.Truncate(title, 200)!, Text.Truncate($"“{note}”{(effect is null ? "" : $" {effect}")}", 500),
                "/command-center", $"agent-ask:{f.Id:N}:{uid:N}", ct: ct);
    }

    private async Task<bool> CanManageAsync(Guid projectId, CancellationToken ct)
    {
        var project = await db.Projects.AsNoTracking().FirstOrDefaultAsync(p => p.Id == projectId, ct);
        return project is not null && ctx.Role is TenantRole.Owner or TenantRole.Admin || project?.OwnerId == ctx.UserId;
    }

    public async Task<List<AgentCommitmentDto>> DtosAsync(IReadOnlyList<AgentCommitment> rows, CancellationToken ct)
    {
        if (rows.Count == 0) return [];
        var projectIds = rows.Select(r => r.ProjectId).Distinct().ToList();
        var projects = await db.Projects.AsNoTracking().Where(p => projectIds.Contains(p.Id)).ToDictionaryAsync(p => p.Id, p => new { p.Key, p.Name }, ct);
        var userIds = rows.Select(r => r.OwnerUserId).Distinct().ToList();
        var users = await db.Users.AsNoTracking().Where(u => userIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        return rows.Select(c => new AgentCommitmentDto(c.Id, c.ProjectId, projects.GetValueOrDefault(c.ProjectId)?.Key ?? "", projects.GetValueOrDefault(c.ProjectId)?.Name ?? "",
            c.EntityKey, c.TaskId, c.Title, c.DueDate, new AgentPersonRef(c.OwnerUserId, users.GetValueOrDefault(c.OwnerUserId) ?? "Someone"), c.Status, c.Quote, c.SourceLabel,
            c.CheckInSentAt, c.CheckInAnswer, c.CheckInNote, c.ProposedDate, c.AnsweredAt,
            c.CheckInSentAt is not null && c.AnsweredAt is null && c.Status is "open" or "missed" && c.ResolvedAt is null)).ToList();
    }
}
