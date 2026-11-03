using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Application.Features.Work;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Desk;

public record DeskInsightDto(string Channel, string Category, string Priority, string Department, IReadOnlyList<string> Skills, int Confidence, string Summary, string Source,
    bool NeedsReview, UserRefDto? ReviewedBy, DateTime? ReviewedAt, UserRefDto? Contact, string? Organization);
public record DeskAssignmentDto(Guid Id, UserRefDto? Assignee, string Method, string Reason, int Score, DateTime AssignedAt, DateTime? AcceptDueAt, DateTime? AcceptedAt,
    int Reassignments, DateTime? EscalatedAt, bool Active, UserRefDto? AssignedBy);
public record DeskRoutingDto(Guid WorkTaskId, string Key, bool RoutingEnabled, int Threshold, DeskInsightDto? Insight, DeskAssignmentDto? Current, IReadOnlyList<DeskAssignmentDto> History,
    IReadOnlyList<DeskRanked> Candidates, DateTime? ResponseDueAt, DateTime? ResolutionDueAt, bool CanOverride, bool CanAccept);
public record DeskReassignRequest(Guid? UserId, string? Reason);
public record DeskReviewRequest(bool Approve, string? Category, Priority? Priority);

/// <summary>
/// The Desk's routing engine: puts what was understood about a ticket on it, offers it to the best available engineer (availability, shift,
/// department, skills, workload, priority), waits for them to accept, moves it on or asks the supervisor when nobody does, and lets people
/// reassign and supervisors override. An uncertain AI decision is never applied by itself: it waits for a person (the review step).
/// </summary>
public class DeskRoutingService(IAppDbContext db, ICurrentContext ctx, AppClock clock, PermissionService permissions, NotificationService notifications, Recorder recorder,
    DeskSettingsService settings)
{
    /// <summary>Open operational tickets per assignee (the engineers' current workload).</summary>
    public static async Task<Dictionary<Guid, int>> OpenLoadAsync(IAppDbContext db, CancellationToken ct) =>
        await db.WorkTasks.AsNoTracking()
            .Where(t => t.Kind == WorkTaskKind.Operational && t.AssigneeId != null && (t.Status == WorkTaskStatus.ToDo || t.Status == WorkTaskStatus.InProgress || t.Status == WorkTaskStatus.OnHold))
            .GroupBy(t => t.AssigneeId!.Value).Select(g => new { g.Key, N = g.Count() }).ToDictionaryAsync(x => x.Key, x => x.N, ct);

    private int NowMinutes() { var local = ZoneTime.ToLocal(clock.Now, clock.Zone); return local.Hour * 60 + local.Minute; }

    private async Task<List<DeskCandidate>> CandidatesAsync(CancellationToken ct)
    {
        var tid = ctx.RequireTenantId();
        var rows = await db.DeskEngineers.AsNoTracking().ToListAsync(ct);
        var ids = rows.Select(r => r.UserId).ToList();
        var members = await (from m in db.TenantMembers.AsNoTracking() join u in db.Users.AsNoTracking() on m.UserId equals u.Id
                             where m.TenantId == tid && u.IsActive && ids.Contains(u.Id) select new { u.Id, u.DisplayName }).ToDictionaryAsync(x => x.Id, x => x.DisplayName, ct);
        var load = await OpenLoadAsync(db, ct);
        return rows.Where(r => members.ContainsKey(r.UserId)).Select(r => new DeskCandidate(r.UserId, members[r.UserId], r.Status, DeskRules.SplitSkills(r.Skills), r.Department,
            load.GetValueOrDefault(r.UserId), r.MaxActive, r.ShiftStartMinutes, r.ShiftEndMinutes, r.OnCall)).ToList();
    }

    /// <summary>Stores what was understood about the ticket (once; a later call updates it unless a person already reviewed it).</summary>
    public async Task<DeskTicketInsight> RecordInsightAsync(WorkTask task, DeskClassification c, string channel, Guid? contactUserId, string? organization, CancellationToken ct)
    {
        var s = await settings.CurrentAsync(ct);
        var row = await db.DeskTicketInsights.FirstOrDefaultAsync(i => i.WorkTaskId == task.Id, ct);
        if (row is { ReviewedAt: not null }) return row;
        if (row is null) { row = new DeskTicketInsight { TenantId = task.TenantId, WorkTaskId = task.Id, CreatedAt = clock.Now, CreatedBy = ctx.UserId }; db.DeskTicketInsights.Add(row); }
        else row.UpdatedAt = clock.Now;
        row.Channel = channel; row.Category = Clip(c.Category, 80); row.Priority = c.Priority.ToString(); row.Department = Clip(c.Department, 80);
        row.Skills = Clip(string.Join(",", c.Skills), 300); row.Confidence = c.Confidence; row.Summary = Clip(c.Summary, 2000); row.Source = c.Source;
        row.NeedsReview = DeskRules.NeedsReview(c.Confidence, s.ConfidenceThreshold);
        row.ContactUserId ??= contactUserId; row.Organization ??= organization is null ? null : Clip(organization, 120);
        // Confident enough: the priority is raised (never lowered) on the ticket; uncertain: it waits for the review.
        if (!row.NeedsReview && c.Priority > task.Priority) { task.Priority = c.Priority; task.Version++; task.UpdatedAt = clock.Now; }
        await db.SaveChangesAsync(ct);
        return row;
    }

    /// <summary>Offers a ticket to the best engineer, or to the review queue when the AI is unsure or nobody is free. Does nothing when routing is off.</summary>
    public async Task<DeskAssignment?> RouteAsync(Guid taskId, CancellationToken ct, IReadOnlyCollection<Guid>? exclude = null, string method = "auto")
    {
        var s = await settings.CurrentAsync(ct);
        if (!s.RoutingEnabled) return null;
        var task = await db.WorkTasks.FirstOrDefaultAsync(t => t.Id == taskId, ct) ?? throw new NotFoundException("Ticket not found.");
        var insight = await db.DeskTicketInsights.AsNoTracking().FirstOrDefaultAsync(i => i.WorkTaskId == taskId, ct);
        var current = await db.DeskAssignments.Where(a => a.WorkTaskId == taskId && a.Active).ToListAsync(ct);
        var reassignments = current.Select(a => a.Reassignments).DefaultIfEmpty(0).Max() + (method == "escalated" ? 1 : 0);
        foreach (var a in current) a.Active = false;
        var key = WorkTaskService.KeyOf(task.Number);

        if (insight is { NeedsReview: true })
            return await ReviewQueueAsync(task, s, $"AI is {insight.Confidence}% sure (below {s.ConfidenceThreshold}%): a person decides", reassignments, ct);
        // Someone already owns it (chosen when raised, or by a routing rule): it waits for their acceptance like any offer.
        if (task.AssigneeId is { } owner && method == "auto")
            return await OfferAsync(task, owner, "existing", "Already assigned when raised", 0, reassignments, s, ct);

        var priority = Enum.TryParse<Priority>(insight?.Priority, out var p) && p > task.Priority ? p : task.Priority;
        var ranked = DeskRules.Rank(new DeskRouteRequest(priority, insight?.Department ?? "", DeskRules.SplitSkills(insight?.Skills), NowMinutes(), exclude ?? Array.Empty<Guid>()), await CandidatesAsync(ct));
        if (ranked.Count == 0) return await ReviewQueueAsync(task, s, "No engineer is available, in shift and under their limit", reassignments, ct);
        var best = ranked[0];
        if (task.AssigneeId != best.UserId)
        {
            task.AssigneeId = best.UserId; task.Version++; task.UpdatedAt = clock.Now; task.UpdatedBy = ctx.UserId;
            recorder.Activity("worktask.routed", "WorkTask", task.Id, $"{key} was routed to {best.Name} ({best.Reason})", null);
        }
        return await OfferAsync(task, best.UserId, method, best.Reason, best.Score, reassignments, s, ct);
    }

    private async Task<DeskAssignment> OfferAsync(WorkTask task, Guid assignee, string method, string reason, int score, int reassignments, DeskSettings s, CancellationToken ct)
    {
        var row = new DeskAssignment
        {
            TenantId = task.TenantId, WorkTaskId = task.Id, AssigneeId = assignee, Method = method, Reason = Clip(reason, 300), Score = score, AssignedAt = clock.Now,
            AcceptDueAt = method == "override" ? null : clock.Now.AddMinutes(s.AcceptMinutes), Reassignments = reassignments, AssignedBy = ctx.UserId, CreatedAt = clock.Now, CreatedBy = ctx.UserId,
        };
        db.DeskAssignments.Add(row);
        var key = WorkTaskService.KeyOf(task.Number);
        // TaskAssigned also goes to the engineer's WhatsApp when they linked it and the workspace allows it; Support stays in the app.
        await notifications.AddAsync(assignee, s.NotifyOnWhatsApp ? NotificationType.TaskAssigned : NotificationType.Support, $"Desk: {key} is yours — please accept",
            $"{Clip(task.Title, 120)} · {task.Priority}{(row.AcceptDueAt is { } due ? $" · accept within {s.AcceptMinutes} min" : "")}", DeskLink(task.Id), $"desk-offer:{row.Id:N}", toSelf: true, ct: ct);
        await db.SaveChangesAsync(ct);
        return row;
    }

    private async Task<DeskAssignment> ReviewQueueAsync(WorkTask task, DeskSettings s, string reason, int reassignments, CancellationToken ct)
    {
        var row = new DeskAssignment
        {
            TenantId = task.TenantId, WorkTaskId = task.Id, AssigneeId = null, Method = "review", Reason = Clip(reason, 300), AssignedAt = clock.Now, Reassignments = reassignments,
            AssignedBy = ctx.UserId, CreatedAt = clock.Now, CreatedBy = ctx.UserId,
        };
        db.DeskAssignments.Add(row);
        if (await SupervisorAsync(s, ct) is { } sup)
            await notifications.AddAsync(sup, NotificationType.Support, $"Desk: {WorkTaskService.KeyOf(task.Number)} needs a decision", reason, DeskLink(task.Id), $"desk-review:{task.Id:N}", toSelf: true, ct: ct);
        await db.SaveChangesAsync(ct);
        return row;
    }

    private async Task<Guid?> SupervisorAsync(DeskSettings s, CancellationToken ct) =>
        s.SupervisorId ?? await db.OperationsSettings.AsNoTracking().Select(o => o.EscalateToUserId).FirstOrDefaultAsync(ct);

    public static string DeskLink(Guid taskId) => $"/desk?ticket={taskId}";

    // ------------------------------------------------------------------ people acting on it

    public async Task<DeskRoutingDto> AcceptAsync(Guid taskId, CancellationToken ct)
    {
        await permissions.RequireAsync(Permissions.WorkEdit, ct);
        var me = ctx.RequireUserId();
        var row = await db.DeskAssignments.Where(a => a.WorkTaskId == taskId && a.Active).OrderByDescending(a => a.AssignedAt).FirstOrDefaultAsync(ct)
            ?? throw new ConflictException("This ticket has no open offer.");
        if (row.AssigneeId != me) throw new ForbiddenException("Only the engineer it was offered to can accept it.");
        if (row.AcceptedAt is null)
        {
            row.AcceptedAt = clock.Now; row.UpdatedAt = clock.Now; row.UpdatedBy = me;
            var task = await db.WorkTasks.FirstAsync(t => t.Id == taskId, ct);
            recorder.Activity("worktask.accepted", "WorkTask", taskId, $"{WorkTaskService.KeyOf(task.Number)} accepted on the Desk", null);
            await db.SaveChangesAsync(ct);
        }
        return await PanelAsync(taskId, ct);
    }

    /// <summary>Gives the ticket to someone else (or, with no one chosen, to the next best engineer). Supervisors use override to skip acceptance.</summary>
    public async Task<DeskRoutingDto> ReassignAsync(Guid taskId, DeskReassignRequest req, bool supervisorOverride, CancellationToken ct)
    {
        await permissions.RequireAsync(supervisorOverride ? Permissions.WorkTypesManage : Permissions.WorkEdit, ct);
        var tid = ctx.RequireTenantId();
        var task = await db.WorkTasks.FirstOrDefaultAsync(t => t.Id == taskId && t.Kind == WorkTaskKind.Operational, ct) ?? throw new NotFoundException("Ticket not found.");
        var s = await settings.CurrentAsync(ct);
        var reason = Clip((req.Reason ?? "").Trim(), 200);
        var method = supervisorOverride ? "override" : "manual";
        if (req.UserId is null)
        {
            if (supervisorOverride) throw new ValidationException("userId", "Choose who takes it.");
            var tried = await db.DeskAssignments.AsNoTracking().Where(a => a.WorkTaskId == taskId && a.AssigneeId != null).Select(a => a.AssigneeId!.Value).Distinct().ToListAsync(ct);
            if (task.AssigneeId is { } cur) tried.Add(cur);
            if (!s.RoutingEnabled) throw new ConflictException("Routing is off. Choose someone, or turn routing on in Desk › Integrations.");
            var next = DeskRules.Rank(new DeskRouteRequest(task.Priority, "", [], NowMinutes(), tried), await CandidatesAsync(ct));
            if (next.Count == 0) throw new ConflictException("No other engineer is available right now. Choose someone.");
            task.AssigneeId = null;
            await RouteAsync(task.Id, ct, tried, method);
            return await PanelAsync(taskId, ct);
        }
        var to = req.UserId.Value;
        if (!await db.TenantMembers.AnyAsync(m => m.TenantId == tid && m.UserId == to, ct)) throw new ValidationException("userId", "Choose someone in this workspace.");
        foreach (var a in await db.DeskAssignments.Where(a => a.WorkTaskId == taskId && a.Active).ToListAsync(ct)) a.Active = false;
        var name = await db.Users.AsNoTracking().Where(u => u.Id == to).Select(u => u.DisplayName).FirstAsync(ct);
        if (task.AssigneeId != to)
        {
            task.AssigneeId = to; task.Version++; task.UpdatedAt = clock.Now; task.UpdatedBy = ctx.UserId;
            recorder.Activity(supervisorOverride ? "worktask.override" : "worktask.reassigned", "WorkTask", taskId,
                $"{WorkTaskService.KeyOf(task.Number)} {(supervisorOverride ? "given by a supervisor" : "reassigned")} to {name}{(reason.Length > 0 ? $": {reason}" : "")}", null);
        }
        await OfferAsync(task, to, method, reason.Length > 0 ? reason : supervisorOverride ? "Supervisor override" : "Reassigned by a person", 0, 0, s, ct);
        return await PanelAsync(taskId, ct);
    }

    /// <summary>A person settles an uncertain AI decision: approve it (optionally correcting category or priority) and route, or reject it and route by hand.</summary>
    public async Task<DeskRoutingDto> ReviewAsync(Guid taskId, DeskReviewRequest req, CancellationToken ct)
    {
        await permissions.RequireAsync(Permissions.WorkEdit, ct);
        var row = await db.DeskTicketInsights.FirstOrDefaultAsync(i => i.WorkTaskId == taskId, ct) ?? throw new NotFoundException("Nothing to review on this ticket.");
        var task = await db.WorkTasks.FirstAsync(t => t.Id == taskId, ct);
        row.NeedsReview = false; row.ReviewedBy = ctx.UserId; row.ReviewedAt = clock.Now; row.UpdatedAt = clock.Now;
        if (req.Category is { Length: > 0 } cat) row.Category = Clip(cat.Trim(), 80);
        if (req.Priority is { } pr) row.Priority = pr.ToString();
        if (req.Approve && Enum.TryParse<Priority>(row.Priority, out var p) && p != task.Priority) { task.Priority = p; task.Version++; task.UpdatedAt = clock.Now; }
        recorder.Activity("worktask.triage_reviewed", "WorkTask", taskId, $"{WorkTaskService.KeyOf(task.Number)}: AI triage {(req.Approve ? "approved" : "rejected")} ({row.Category}, {row.Priority})", null);
        await db.SaveChangesAsync(ct);
        if (req.Approve) await RouteAsync(taskId, ct, null, "auto");
        return await PanelAsync(taskId, ct);
    }

    // ------------------------------------------------------------------ escalation (the worker, inside each workspace)

    /// <summary>Offers nobody accepted in time move on (or go to the supervisor); open tickets past their resolution target are raised to the supervisor once.</summary>
    public async Task<int> EscalateAsync(CancellationToken ct)
    {
        var s = await settings.CurrentAsync(ct);
        if (!s.RoutingEnabled) return 0;
        var now = clock.Now;
        var due = await db.DeskAssignments.Where(a => a.Active && a.AcceptedAt == null && a.AcceptDueAt != null && a.AcceptDueAt < now).OrderBy(a => a.AcceptDueAt).Take(50).ToListAsync(ct);
        var moved = 0;
        foreach (var a in due)
        {
            var step = DeskRules.Escalation(now, a.AcceptDueAt, a.AcceptedAt, a.Reassignments, s.MaxReassignments, a.EscalatedAt);
            var task = await db.WorkTasks.FirstOrDefaultAsync(t => t.Id == a.WorkTaskId, ct);
            if (task is null || task.Status is WorkTaskStatus.Completed or WorkTaskStatus.Cancelled) { a.Active = false; continue; }
            if (step == DeskEscalationStep.Reassign)
            {
                var tried = await db.DeskAssignments.AsNoTracking().Where(x => x.WorkTaskId == a.WorkTaskId && x.AssigneeId != null).Select(x => x.AssigneeId!.Value).Distinct().ToListAsync(ct);
                task.AssigneeId = null;
                await RouteAsync(a.WorkTaskId, ct, tried, "escalated");
                moved++;
            }
            else if (step == DeskEscalationStep.Supervisor)
            {
                a.EscalatedAt = now; a.UpdatedAt = now;
                if (await SupervisorAsync(s, ct) is { } sup)
                    await notifications.AddAsync(sup, NotificationType.ServiceLevel, $"Desk: nobody accepted {WorkTaskService.KeyOf(task.Number)}",
                        $"{Clip(task.Title, 120)} · offered {a.Reassignments + 1} times", DeskLink(task.Id), $"desk-unaccepted:{task.Id:N}", toSelf: true, ct: ct);
                moved++;
            }
        }
        // Past the resolution target: the supervisor hears once per ticket.
        var overdue = await (from t in db.WorkTasks
                             join a in db.DeskAssignments on t.Id equals a.WorkTaskId
                             where a.Active && a.EscalatedAt == null && t.ResolutionDueAt != null && t.ResolutionDueAt < now
                                   && (t.Status == WorkTaskStatus.ToDo || t.Status == WorkTaskStatus.InProgress)
                             select a).Take(50).ToListAsync(ct);
        foreach (var a in overdue)
        {
            a.EscalatedAt = now; a.UpdatedAt = now;
            var task = await db.WorkTasks.AsNoTracking().FirstAsync(t => t.Id == a.WorkTaskId, ct);
            if (await SupervisorAsync(s, ct) is { } sup)
                await notifications.AddAsync(sup, NotificationType.ServiceLevel, $"Desk: {WorkTaskService.KeyOf(task.Number)} is past its resolution target",
                    Clip(task.Title, 140), DeskLink(task.Id), $"desk-overdue:{task.Id:N}", toSelf: true, ct: ct);
            moved++;
        }
        await db.SaveChangesAsync(ct);
        return moved;
    }

    // ------------------------------------------------------------------ the ticket's routing panel

    public async Task<DeskRoutingDto> PanelAsync(Guid taskId, CancellationToken ct)
    {
        await permissions.RequireAsync(Permissions.WorkEdit, ct);
        var task = await db.WorkTasks.AsNoTracking().FirstOrDefaultAsync(t => t.Id == taskId && t.Kind == WorkTaskKind.Operational, ct) ?? throw new NotFoundException("Ticket not found.");
        var s = await settings.CurrentAsync(ct);
        var insight = await db.DeskTicketInsights.AsNoTracking().FirstOrDefaultAsync(i => i.WorkTaskId == taskId, ct);
        var rows = await db.DeskAssignments.AsNoTracking().Where(a => a.WorkTaskId == taskId).OrderByDescending(a => a.AssignedAt).Take(20).ToListAsync(ct);
        var names = await NamesAsync(rows.SelectMany(r => new[] { r.AssigneeId, r.AssignedBy }).Append(insight?.ReviewedBy).Append(insight?.ContactUserId), ct);
        UserRefDto? Ref(Guid? id) => id is { } g && names.TryGetValue(g, out var n) ? new UserRefDto(g, n) : null;
        DeskAssignmentDto Dto(DeskAssignment a) => new(a.Id, Ref(a.AssigneeId), a.Method, a.Reason, a.Score, a.AssignedAt, a.AcceptDueAt, a.AcceptedAt, a.Reassignments, a.EscalatedAt, a.Active, Ref(a.AssignedBy));
        var current = rows.FirstOrDefault(a => a.Active);
        var priority = Enum.TryParse<Priority>(insight?.Priority, out var p) && p > task.Priority ? p : task.Priority;
        var candidates = DeskRules.Rank(new DeskRouteRequest(priority, insight?.Department ?? "", DeskRules.SplitSkills(insight?.Skills), NowMinutes(), []), await CandidatesAsync(ct)).Take(5).ToList();
        var insightDto = insight is null ? null : new DeskInsightDto(insight.Channel, insight.Category, insight.Priority, insight.Department, DeskRules.SplitSkills(insight.Skills), insight.Confidence,
            insight.Summary, insight.Source, insight.NeedsReview, Ref(insight.ReviewedBy), insight.ReviewedAt, Ref(insight.ContactUserId), insight.Organization);
        return new(task.Id, WorkTaskService.KeyOf(task.Number), s.RoutingEnabled, s.ConfidenceThreshold, insightDto, current is null ? null : Dto(current), rows.Select(Dto).ToList(), candidates,
            task.ResponseDueAt, task.ResolutionDueAt, await permissions.HasAsync(Permissions.WorkTypesManage, ct), current is { AcceptedAt: null } && current.AssigneeId == ctx.UserId);
    }

    private async Task<Dictionary<Guid, string>> NamesAsync(IEnumerable<Guid?> ids, CancellationToken ct)
    {
        var list = ids.Where(x => x != null).Select(x => x!.Value).Distinct().ToList();
        return list.Count == 0 ? [] : await db.Users.AsNoTracking().Where(u => list.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
    }

    private static string Clip(string? s, int max) { var t = s ?? ""; return t.Length > max ? t[..max] : t; }
}
