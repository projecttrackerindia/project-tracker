using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.Tasks;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.ProjectMeetings;

public record ReviewDecisionDto(Guid Id, string Decision, string? Reason, UserRefDto? By, DateTimeOffset At, DateOnly? FromDue, DateOnly? ToDue, UserRefDto? FromOwner, UserRefDto? ToOwner,
    Guid? ConvertedTaskId, string? ConvertedKey);
/// <summary>
/// One action item in a review. <see cref="State"/>: open, in_progress, blocked (on hold), done or cancelled. <see cref="NoUpdateDays"/>: days
/// since the owner last said anything (or since it was given to them); <see cref="NoUpdate"/> once that is three days or more on open work.
/// <see cref="OwnerLeft"/>: the owner is no longer an active member, so it has to be re-planned to someone else.
/// </summary>
public record ReviewItemDto(Guid Id, string Key, string Title, Guid? ProjectId, string? ProjectName, UserRefDto? Owner, DateOnly? DueDate, bool IsOverdue, int DaysOverdue,
    string State, string StatusLabel, string? SourceTitle, DateTimeOffset? SourceOccurrence, string? SeriesRef, string? LatestNote, DateTimeOffset? LastUpdateAt, int NoUpdateDays, bool NoUpdate,
    bool OwnerLeft, bool CanEdit, ReviewDecisionDto? Decision, DateTime CreatedAt);
public record ReviewCountsDto(int Total, int Reviewed, int Done, int InProgress, int Overdue, int Blocked, int NoUpdate);
/// <summary>One line of the minutes. <see cref="Group"/>: decided, carried, replanned, new or dropped.</summary>
public record MinutesLineDto(string Group, string Text, UserRefDto? Owner, DateOnly? Date, Guid? WorkItemId);
/// <summary>
/// A review of action items: <see cref="Scope"/> series (one meeting series since its last session), all (every open one in the projects the
/// caller can see) or mine. Two people reviewing the same session share it; each decision says who made it.
/// </summary>
public record ReviewDto(Guid? SessionId, string Scope, string? SeriesRef, string Title, string Cadence, DateTimeOffset? Occurrence, DateTimeOffset? PreviousSession,
    DateTimeOffset? NextSession, int Attendees, ReviewCountsDto Counts, IReadOnlyList<ReviewItemDto> Items, bool Finished, bool Sent, IReadOnlyList<MinutesLineDto> Draft, Guid? ProjectId);
/// <summary>"done", "carry", "replan", "convert" or "drop". Re-plan takes a new owner and/or due date and a reason; drop takes a reason; carry takes a date only when there is no next session.</summary>
public record ReviewDecideRequest(Guid WorkItemId, string? Decision, string? Reason = null, Guid? OwnerId = null, DateOnly? DueDate = null, bool ClearOwner = false);
public record ReviewOpenRequest(string? Scope, string? SeriesRef, DateTimeOffset? Occurrence);
public record ReviewUndoRequest(Guid? DecisionId = null);
public record MinutesDto(Guid SessionId, string Title, DateTimeOffset Occurrence, DateTimeOffset? NextSession, int Reviewed, int Total, int DurationMinutes, int Done, int Carried,
    int Replanned, int Dropped, int New, int ReassignedCount, int RedatedCount, IReadOnlyList<MinutesLineDto> Lines, string Text, bool Sent, int Attendees);
public record SendMinutesRequest(string? Text);
public record OwnerUpdateRequest(string? Note, string? Signal);
public record SeriesInfoDto(string SeriesRef, string Title, string Cadence, DateTimeOffset? NextSession);
/// <summary>My action items: what needs my update, what is due this week, what I am waiting on from others, and what is done (last 30 days).</summary>
public record MyActionItemsDto(IReadOnlyList<ReviewItemDto> NeedsUpdate, IReadOnlyList<ReviewItemDto> DueThisWeek, IReadOnlyList<ReviewItemDto> WaitingOnOthers, IReadOnlyList<ReviewItemDto> Done,
    IReadOnlyList<SeriesInfoDto> Series);

/// <summary>
/// Reviewing a meeting series' action items: they are ordinary work items whose source is the series, grouped by owner, and each decision is
/// a work-item change made through the action items' own rules - Done (status), Carry (due moved to the next session, "carried" in its
/// history), Re-plan (owner and/or due, with the reason a delayed date always needs), Convert (a project task is made, keeping the source,
/// and the action item is closed with a link to it) and Drop (cancelled, with a reason). Decisions are kept, so Undo works until the minutes
/// are sent, and the minutes are written from them.
/// </summary>
public class MeetReviewService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, NotificationService notifications, ActionItemService actions,
    TaskService tasks, MeetConnectService connect, PermissionService permissions)
{
    private const int MaxItems = 300;
    public const int NoUpdateAfterDays = 3;
    private static readonly string[] Decisions = ["done", "carry", "replan", "convert", "drop"];

    private static DateTimeOffset At(DateTime utc) => new(DateTime.SpecifyKind(utc, DateTimeKind.Utc), TimeSpan.Zero);

    // ------------------------------------------------------------------ open a review

    /// <summary>
    /// The review: for a series, the session (asked for, else the one going on or the last one) is found or started; for all/mine, the
    /// caller's own pass for today. Items are listed with any decision already made in it.
    /// </summary>
    public async Task<ReviewDto> OpenAsync(ReviewOpenRequest req, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var tid = ctx.RequireTenantId();
        var scope = (req.Scope ?? "series").Trim().ToLowerInvariant();
        if (scope is not ("series" or "all" or "mine")) throw new ValidationException("scope", "Review this series, all projects or my items.");
        MeetConnectService.Meeting? m = null;
        List<MeetConnectService.Meeting> parts = [];
        Dictionary<Guid, List<MeetingOccurrenceChange>> changes = new();
        DateTime occurrence;
        MeetingSession? previous = null, next = null;
        var now = clock.Now;
        string key;
        if (scope == "series")
        {
            m = await connect.LoadAsync(req.SeriesRef, ct);
            (parts, changes) = await connect.SeriesAsync(m, ct);
            var sessions = MeetConnectService.SessionsOf(parts, changes, m.Start.AddDays(-1), now + MeetingRecurrence.LongestSeries).ToList();
            if (req.Occurrence is { } asked)
            {
                var at = asked.UtcDateTime;
                var hit = sessions.FirstOrDefault(s => s.Original == at || s.Start == at);
                if (hit == default) throw new ValidationException("occurrence", "That is not one of this meeting's sessions.");
                occurrence = hit.Original;
            }
            else occurrence = (sessions.LastOrDefault(s => s.Start <= now.AddMinutes(30)) is { Start.Ticks: > 0 } cur ? cur : sessions.FirstOrDefault()).Original;
            if (occurrence == default) occurrence = m.Start;
            var occ = occurrence;
            var i = sessions.FindIndex(s => s.Original == occ);
            if (i > 0) previous = sessions[i - 1];
            if (i >= 0 && i + 1 < sessions.Count) next = sessions[i + 1];
            key = m.SeriesRef;
        }
        else
        {
            occurrence = clock.StartOfDayUtc(clock.Today);
            key = scope == "all" ? "all" : "mine";
        }

        var session = await db.MeetingReviewSessions.Where(s => s.SeriesRef == key && s.OccurrenceStartUtc == occurrence && (scope == "series" || s.StartedBy == me))
            .OrderByDescending(s => s.StartedAt).FirstOrDefaultAsync(ct);
        if (session is null)
        {
            session = new MeetingReviewSession { TenantId = tid, SeriesRef = key, MeetingTitle = Cut(m?.Title ?? (scope == "all" ? "All projects" : "My items"), 200), OccurrenceStartUtc = occurrence,
                StartedBy = me, StartedAt = now, CreatedAt = now, CreatedBy = me };
            db.MeetingReviewSessions.Add(session);
            await db.SaveChangesAsync(ct);
        }
        return await BuildAsync(session, scope, m, previous, next, ct);
    }

    private async Task<ReviewDto> BuildAsync(MeetingReviewSession session, string scope, MeetConnectService.Meeting? m, MeetingSession? previous, MeetingSession? next, CancellationToken ct)
    {
        var me = ctx.RequireUserId();
        var decisions = await db.MeetingReviewDecisions.AsNoTracking().Where(d => d.SessionId == session.Id && d.UndoneAt == null).OrderBy(d => d.DecidedAt).ToListAsync(ct);
        var decidedIds = decisions.Select(d => d.WorkItemId).ToList();
        var q = db.WorkTasks.AsNoTracking().Where(w => w.Kind == WorkTaskKind.ActionItem && w.RelatedProjectId != null);
        var open = new[] { WorkTaskStatus.ToDo, WorkTaskStatus.InProgress, WorkTaskStatus.OnHold };
        var since = previous?.Start ?? session.OccurrenceStartUtc.AddDays(-7);
        q = scope switch
        {
            "series" => q.Where(w => w.SourceSeriesRef == session.SeriesRef
                && (open.Contains(w.Status) || decidedIds.Contains(w.Id) || (w.UpdatedAt != null && w.UpdatedAt >= since))),
            "mine" => q.Where(w => w.AssigneeId == me && (open.Contains(w.Status) || decidedIds.Contains(w.Id))),
            _ => q.Where(w => open.Contains(w.Status) || decidedIds.Contains(w.Id)),
        };
        var rows = await q.OrderBy(w => w.DueDate == null).ThenBy(w => w.DueDate).ThenBy(w => w.CreatedAt).Take(MaxItems).ToListAsync(ct);
        var items = await ItemsAsync(rows, decisions, ct);
        var counts = new ReviewCountsDto(items.Count, items.Count(i => i.Decision is not null), items.Count(i => i.State == "done"), items.Count(i => i.State == "in_progress"),
            items.Count(i => i.IsOverdue), items.Count(i => i.State == "blocked"), items.Count(i => i.NoUpdate));
        var attendees = m?.People.Count ?? 0;
        var draft = await LinesAsync(session, decisions, rows, ct);
        return new ReviewDto(session.Id, scope, scope == "series" ? session.SeriesRef : null, m?.Title ?? session.MeetingTitle, m is null ? "Ad hoc" : MeetingRecurrence.Cadence(m.Rule),
            At(session.OccurrenceStartUtc), previous is { } p ? At(p.Start) : null, next is { } n ? At(n.Start) : null, attendees, counts,
            items, session.FinishedAt is not null, session.SentAt is not null, draft, m?.ProjectId);
    }

    private async Task<List<ReviewItemDto>> ItemsAsync(IReadOnlyList<WorkTask> rows, IReadOnlyList<MeetingReviewDecision> decisions, CancellationToken ct)
    {
        var me = ctx.RequireUserId();
        var tid = ctx.RequireTenantId();
        var people = rows.Select(r => r.AssigneeId).Concat(decisions.SelectMany(d => new[] { d.DecidedBy, d.FromOwnerId, d.ToOwnerId }))
            .Where(x => x is not null).Select(x => x!.Value).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => people.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        var active = (await db.TenantMembers.AsNoTracking().Where(t => t.TenantId == tid && people.Contains(t.UserId) && t.Status == MemberStatus.Active && t.User!.IsActive)
            .Select(t => t.UserId).ToListAsync(ct)).ToHashSet();
        var projectIds = rows.Select(r => r.RelatedProjectId!.Value).Distinct().ToList();
        var projects = await db.Projects.AsNoTracking().Where(p => projectIds.Contains(p.Id)).Select(p => new { p.Id, p.Name, p.OwnerId }).ToDictionaryAsync(p => p.Id, ct);
        var converted = decisions.Where(d => d.ConvertedTaskId != null).Select(d => d.ConvertedTaskId!.Value).ToList();
        var convertedKeys = await db.Tasks.AsNoTracking().Where(t => converted.Contains(t.Id)).Select(t => new { t.Id, t.Number, Key = t.Project!.Key }).ToDictionaryAsync(t => t.Id, t => $"{t.Key}-{t.Number}", ct);
        var canEditAll = await permissions.HasAsync(Permissions.TasksEdit, ct);
        UserRefDto? Ref(Guid? id) => id is { } u && names.TryGetValue(u, out var n) ? new UserRefDto(u, n) : null;
        var today = clock.Today;
        var now = clock.Now;
        return rows.Select(r =>
        {
            var d = decisions.LastOrDefault(x => x.WorkItemId == r.Id);
            var state = r.Status switch { WorkTaskStatus.ToDo => "open", WorkTaskStatus.InProgress => "in_progress", WorkTaskStatus.OnHold => "blocked", WorkTaskStatus.Completed => "done", _ => "cancelled" };
            var isOpen = state is "open" or "in_progress" or "blocked";
            var overdue = isOpen && clock.IsPastDue(r.DueDate, r.DueTime);
            var lastWord = r.LastUpdateAt ?? r.CreatedAt;
            var quiet = Math.Max(0, (int)Math.Floor((now - lastWord).TotalDays));
            var p = projects.GetValueOrDefault(r.RelatedProjectId!.Value);
            return new ReviewItemDto(r.Id, ProjectManagement.Application.Features.WorkItems.WorkItemService.KeyOf(r.Kind, r.Number), r.Title, r.RelatedProjectId, p?.Name, Ref(r.AssigneeId),
                r.DueDate, overdue, overdue && r.DueDate is { } due ? today.DayNumber - due.DayNumber : 0, state,
                ProjectManagement.Application.Features.WorkItems.WorkItemService.ActionLabel(r.Status), r.SourceMeetingTitle, r.SourceOccurrenceStartUtc is { } so ? At(so) : null, r.SourceSeriesRef,
                r.LatestNote, r.LastUpdateAt is { } lu ? At(lu) : null, quiet, isOpen && quiet >= NoUpdateAfterDays,
                r.AssigneeId is { } a && !active.Contains(a), canEditAll || r.CreatedBy == me || r.AssigneeId == me || p?.OwnerId == me,
                d is null ? null : new ReviewDecisionDto(d.Id, d.Decision, d.Reason, Ref(d.DecidedBy), At(d.DecidedAt), d.FromDue, d.ToDue, Ref(d.FromOwnerId), Ref(d.ToOwnerId), d.ConvertedTaskId,
                    d.ConvertedTaskId is { } ctid ? convertedKeys.GetValueOrDefault(ctid) : null), r.CreatedAt);
        }).ToList();
    }

    // ------------------------------------------------------------------ decisions

    private async Task<MeetingReviewSession> SessionAsync(Guid sessionId, CancellationToken ct)
    {
        var me = ctx.RequireUserId();
        var s = await db.MeetingReviewSessions.FirstOrDefaultAsync(x => x.Id == sessionId, ct) ?? throw new NotFoundException("Review not found.", "REVIEW_NOT_FOUND");
        if (s.SeriesRef is "all" or "mine" ? s.StartedBy != me : false) throw new NotFoundException("Review not found.", "REVIEW_NOT_FOUND");
        if (s.SeriesRef is not ("all" or "mine")) await connect.LoadAsync(s.SeriesRef, ct);   // still someone who may see the meeting
        return s;
    }

    private async Task<WorkTask> ItemAsync(MeetingReviewSession s, Guid id, CancellationToken ct)
    {
        var item = await db.WorkTasks.AsNoTracking().FirstOrDefaultAsync(w => w.Id == id && w.Kind == WorkTaskKind.ActionItem && w.RelatedProjectId != null, ct)
            ?? throw new NotFoundException("Action item not found.", "ACTION_ITEM_NOT_FOUND");
        if (s.SeriesRef is not ("all" or "mine") && item.SourceSeriesRef != s.SeriesRef)
            throw new ValidationException("workItemId", "That action item is not from this meeting series.");
        return item;
    }

    /// <summary>
    /// One decision on one item, then the review moves on. A second decision on the same item replaces the first (that one is undone first).
    /// </summary>
    public async Task<ReviewDto> DecideAsync(Guid sessionId, ReviewDecideRequest req, CancellationToken ct = default)
    {
        var decision = (req.Decision ?? "").Trim().ToLowerInvariant();
        if (!Decisions.Contains(decision)) throw new ValidationException("decision", "Choose Done, Carry, Re-plan, Convert or Drop.");
        var s = await SessionAsync(sessionId, ct);
        if (s.SentAt is not null) throw new ConflictException("The minutes were sent; this review is closed.", "REVIEW_SENT");
        var item = await ItemAsync(s, req.WorkItemId, ct);
        var pid = item.RelatedProjectId!.Value;
        var earlier = await db.MeetingReviewDecisions.Where(d => d.SessionId == s.Id && d.WorkItemId == item.Id && d.UndoneAt == null).OrderByDescending(d => d.DecidedAt).FirstOrDefaultAsync(ct);
        if (earlier is not null) { await RevertAsync(earlier, ct); item = await ItemAsync(s, req.WorkItemId, ct); }
        var tid = ctx.RequireTenantId();
        var me = ctx.RequireUserId();
        var row = new MeetingReviewDecision
        {
            TenantId = tid, SessionId = s.Id, WorkItemId = item.Id, ItemTitle = Cut(item.Title, 200), Decision = decision, FromOwnerId = item.AssigneeId, ToOwnerId = item.AssigneeId,
            FromDue = item.DueDate, ToDue = item.DueDate, FromStatus = item.Status.ToString(), DecidedBy = me, DecidedAt = clock.Now, CreatedAt = clock.Now, CreatedBy = me,
        };
        var ownerLeft = item.AssigneeId is { } owner && !await db.TenantMembers.AsNoTracking().AnyAsync(t => t.TenantId == tid && t.UserId == owner && t.Status == MemberStatus.Active && t.User!.IsActive, ct);
        switch (decision)
        {
            case "done":
                await actions.SetStatusAsync(pid, item.Id, new SetActionItemStatusRequest(ActionItemStatus.Completed), ct);
                break;
            case "carry":
            {
                if (ownerLeft) throw new ValidationException("decision", "Its owner has left the workspace. Re-plan it to someone else.");
                var to = req.DueDate ?? await NextSessionDayAsync(s, ct)
                    ?? throw new ValidationException("dueDate", "This meeting has no next session. Choose the date to carry it to.");
                var why = string.IsNullOrWhiteSpace(req.Reason) ? "Carried over to the next meeting" : req.Reason.Trim();
                await actions.ReplanAsync(pid, item.Id, null, false, to, true, why, "carried", ct);
                row.ToDue = to; row.Reason = Cut(why, 500);
                break;
            }
            case "replan":
            {
                var why = req.Reason?.Trim();
                if (string.IsNullOrEmpty(why)) throw new ValidationException("reason", "Say why it is re-planned (the owner changed, waiting on someone outside, the scope changed …).");
                var changeOwner = req.ClearOwner || (req.OwnerId is { } o && o != item.AssigneeId);
                var changeDue = req.DueDate is { } dd && dd != item.DueDate;
                if (!changeOwner && !changeDue) throw new ValidationException("ownerId", "Change the owner, the date, or both.");
                if (ownerLeft && !changeOwner) throw new ValidationException("ownerId", "Its owner has left the workspace. Choose someone else.");
                await actions.ReplanAsync(pid, item.Id, req.ClearOwner ? null : req.OwnerId, changeOwner, req.DueDate, changeDue, why, "replanned", ct);
                row.ToOwnerId = changeOwner ? (req.ClearOwner ? null : req.OwnerId) : item.AssigneeId; row.ToDue = changeDue ? req.DueDate : item.DueDate; row.Reason = Cut(why, 500);
                break;
            }
            case "convert":
            {
                // A full project task in the same project, keeping the meeting as its source; the action item is closed, pointing at it.
                var made = await tasks.CreateAsync(pid, new CreateTaskRequest(item.Title, item.Description, null, item.Priority, ownerLeft ? null : item.AssigneeId, null, item.DueDate, null, null, null), ct);
                var task = await db.Tasks.FirstAsync(t => t.Id == made.Id, ct);
                task.SourceMeetingRef = item.SourceMeetingRef; task.SourceSeriesRef = item.SourceSeriesRef; task.SourceMeetingTitle = item.SourceMeetingTitle;
                task.SourceOccurrenceStartUtc = item.SourceOccurrenceStartUtc;
                await db.SaveChangesAsync(ct);
                await actions.SetStatusAsync(pid, item.Id, new SetActionItemStatusRequest(ActionItemStatus.Completed), ct);
                recorder.Activity("actionitem.converted", "ActionItem", item.Id, $"Converted “{item.Title}” to task {made.Key}", pid);
                row.ConvertedTaskId = made.Id; row.Reason = $"Converted to task {made.Key}";
                break;
            }
            case "drop":
            {
                var why = req.Reason?.Trim();
                if (string.IsNullOrEmpty(why)) throw new ValidationException("reason", "Say why it is dropped.");
                await actions.CancelAsync(pid, item.Id, why, ct);
                row.Reason = Cut(why, 500);
                break;
            }
        }
        db.MeetingReviewDecisions.Add(row);
        await db.SaveChangesAsync(ct);
        return await ReloadAsync(s, ct);
    }

    /// <summary>The day of the series' next session after the one reviewed (in the meeting's zone), when there is one.</summary>
    private async Task<DateOnly?> NextSessionDayAsync(MeetingReviewSession s, CancellationToken ct)
    {
        if (s.SeriesRef is "all" or "mine") return null;
        var m = await connect.LoadAsync(s.SeriesRef, ct);
        var (parts, changes) = await connect.SeriesAsync(m, ct);
        var after = s.OccurrenceStartUtc;
        var next = MeetConnectService.SessionsOf(parts, changes, after.AddMinutes(1), after + MeetingRecurrence.LongestSeries).Select(x => (MeetingSession?)x).FirstOrDefault();
        if (next is not { } n) return null;
        return DateOnly.FromDateTime(ProjectManagement.Application.Features.Reminders.ZoneTime.ToLocal(n.Start, ProjectManagement.Application.Features.Reminders.ZoneTime.Find(m.Zone)));
    }

    /// <summary>Undo: the latest decision of the session (or the one named), whoever made it, put back - until the minutes are sent.</summary>
    public async Task<ReviewDto> UndoAsync(Guid sessionId, ReviewUndoRequest req, CancellationToken ct = default)
    {
        var s = await SessionAsync(sessionId, ct);
        if (s.SentAt is not null) throw new ConflictException("The minutes were sent; decisions can no longer be undone here.", "REVIEW_SENT");
        var q = db.MeetingReviewDecisions.Where(d => d.SessionId == s.Id && d.UndoneAt == null);
        if (req.DecisionId is { } id) q = q.Where(d => d.Id == id);
        var d = await q.OrderByDescending(x => x.DecidedAt).FirstOrDefaultAsync(ct) ?? throw new ConflictException("There is nothing to undo.", "NOTHING_TO_UNDO");
        await RevertAsync(d, ct);
        await db.SaveChangesAsync(ct);
        return await ReloadAsync(s, ct);
    }

    private async Task RevertAsync(MeetingReviewDecision d, CancellationToken ct)
    {
        var item = await db.WorkTasks.AsNoTracking().FirstOrDefaultAsync(w => w.Id == d.WorkItemId, ct) ?? throw new NotFoundException("Action item not found.", "ACTION_ITEM_NOT_FOUND");
        var pid = item.RelatedProjectId!.Value;
        var status = Enum.TryParse<WorkTaskStatus>(d.FromStatus, out var st) ? st : (WorkTaskStatus?)null;
        if (d.ConvertedTaskId is { } taskId)
        {
            try { await tasks.DeleteAsync(taskId, ct); } catch (NotFoundException) { /* already gone */ }
        }
        await actions.RestoreFieldsAsync(pid, item.Id, d.Decision is "done" or "drop" or "convert" ? status : null,
            d.FromOwnerId, d.Decision is "replan" && d.FromOwnerId != d.ToOwnerId, d.FromDue, d.Decision is "carry" or "replan" && d.FromDue != d.ToDue, ct);
        d.UndoneAt = clock.Now; d.UpdatedAt = clock.Now; d.UpdatedBy = ctx.UserId;
    }

    private async Task<ReviewDto> ReloadAsync(MeetingReviewSession s, CancellationToken ct)
    {
        if (s.SeriesRef is "all" or "mine") return await BuildAsync(s, s.SeriesRef, null, null, null, ct);
        return await OpenAsync(new ReviewOpenRequest("series", s.SeriesRef, At(s.OccurrenceStartUtc)), ct);
    }

    // ------------------------------------------------------------------ minutes

    private async Task<List<MinutesLineDto>> LinesAsync(MeetingReviewSession s, IReadOnlyList<MeetingReviewDecision> decisions, IReadOnlyList<WorkTask> rows, CancellationToken ct)
    {
        var people = decisions.SelectMany(d => new[] { d.FromOwnerId, d.ToOwnerId }).Concat(rows.Select(r => r.AssigneeId)).Where(x => x is not null).Select(x => x!.Value).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => people.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        UserRefDto? Ref(Guid? id) => id is { } u && names.TryGetValue(u, out var n) ? new UserRefDto(u, n) : null;
        string First(Guid? id) => id is { } u && names.TryGetValue(u, out var n) ? n.Split(' ')[0] : "nobody";
        var lines = new List<MinutesLineDto>();
        foreach (var d in decisions)
        {
            switch (d.Decision)
            {
                case "done": lines.Add(new("decided", d.ItemTitle, Ref(d.ToOwnerId), null, d.WorkItemId)); break;
                case "carry": lines.Add(new("carried", d.ItemTitle, Ref(d.ToOwnerId), d.ToDue, d.WorkItemId)); break;
                case "replan":
                    var bits = new List<string> { d.ItemTitle };
                    if (d.FromOwnerId != d.ToOwnerId) bits.Add($"{First(d.FromOwnerId)} → {First(d.ToOwnerId)}");
                    if (!string.IsNullOrEmpty(d.Reason)) bits.Add($"“{d.Reason}”");
                    lines.Add(new("replanned", string.Join(" · ", bits), Ref(d.ToOwnerId), d.ToDue, d.WorkItemId)); break;
                case "convert": lines.Add(new("new", $"{d.Reason ?? "Converted to task"}: {d.ItemTitle}", Ref(d.ToOwnerId), d.ToDue, d.WorkItemId)); break;
                case "drop": lines.Add(new("dropped", $"{d.ItemTitle}{(string.IsNullOrEmpty(d.Reason) ? "" : $" · “{d.Reason}”")}", Ref(d.FromOwnerId), null, d.WorkItemId)); break;
            }
        }
        // New: what was agreed in the session reviewed (captured during it).
        if (s.SeriesRef is not ("all" or "mine"))
        {
            var occ = s.OccurrenceStartUtc;
            var fresh = await db.WorkItems.AsNoTracking().Where(w => w.SourceSeriesRef == s.SeriesRef && w.SourceOccurrenceStartUtc == occ)
                .OrderBy(w => w.CreatedAt).Select(w => new { w.Id, w.Title, w.AssigneeId, w.DueDate }).Take(100).ToListAsync(ct);
            var freshPeople = fresh.Where(f => f.AssigneeId is not null && !names.ContainsKey(f.AssigneeId.Value)).Select(f => f.AssigneeId!.Value).Distinct().ToList();
            foreach (var u in await db.Users.AsNoTracking().Where(u => freshPeople.Contains(u.Id)).Select(u => new { u.Id, u.DisplayName }).ToListAsync(ct)) names[u.Id] = u.DisplayName;
            var convertedTasks = decisions.Where(d => d.ConvertedTaskId != null).Select(d => d.ConvertedTaskId!.Value).ToHashSet();
            foreach (var f in fresh.Where(f => !convertedTasks.Contains(f.Id) && !decisions.Any(d => d.WorkItemId == f.Id)))
                lines.Add(new("new", f.Title, Ref(f.AssigneeId), f.DueDate, f.Id));
        }
        return lines;
    }

    private static readonly (string Group, string Heading)[] Groups = [("decided", "Decided"), ("carried", "Carried over"), ("replanned", "Re-planned"), ("new", "New action items"), ("dropped", "Dropped")];

    private static string TextOf(string title, DateTime occurrence, IReadOnlyList<MinutesLineDto> lines)
    {
        var sb = new System.Text.StringBuilder();
        sb.AppendLine($"Minutes: {title} · {occurrence:d MMM yyyy}");
        foreach (var (group, heading) in Groups)
        {
            var g = lines.Where(l => l.Group == group).ToList();
            if (g.Count == 0) continue;
            sb.AppendLine().AppendLine(heading);
            foreach (var l in g)
                sb.AppendLine($"- {l.Text}{(l.Owner is { } o ? $" — {o.Name}" : "")}{(l.Date is { } d ? $" · {d:d MMM}" : "")}");
        }
        return sb.ToString().TrimEnd();
    }

    /// <summary>Finish &amp; write minutes: the counts and the lines grouped Decided / Carried over / Re-planned / New / Dropped, drafted from the decisions.</summary>
    public async Task<MinutesDto> FinishAsync(Guid sessionId, CancellationToken ct = default)
    {
        var s = await SessionAsync(sessionId, ct);
        var review = await ReloadAsync(s, ct);
        var decisions = await db.MeetingReviewDecisions.AsNoTracking().Where(d => d.SessionId == s.Id && d.UndoneAt == null).ToListAsync(ct);
        if (s.FinishedAt is null) { s.FinishedAt = clock.Now; }
        var text = s.SentAt is not null && s.Minutes is not null ? s.Minutes : TextOf(review.Title, s.OccurrenceStartUtc, review.Draft);
        if (s.SentAt is null) s.Minutes = text;
        s.UpdatedAt = clock.Now; s.UpdatedBy = ctx.UserId;
        await db.SaveChangesAsync(ct);
        var lines = review.Draft;
        var replans = decisions.Where(d => d.Decision == "replan").ToList();
        return new MinutesDto(s.Id, review.Title, At(s.OccurrenceStartUtc), review.NextSession, review.Counts.Reviewed, review.Counts.Total,
            Math.Max(1, (int)Math.Round(((s.FinishedAt ?? clock.Now) - s.StartedAt).TotalMinutes)),
            lines.Count(l => l.Group == "decided"), lines.Count(l => l.Group == "carried"), lines.Count(l => l.Group == "replanned"), lines.Count(l => l.Group == "dropped"),
            lines.Count(l => l.Group == "new"), replans.Count(d => d.FromOwnerId != d.ToOwnerId), replans.Count(d => d.FromDue != d.ToDue), lines, text, s.SentAt is not null, review.Attendees);
    }

    /// <summary>Send to attendees: the minutes (as edited) are kept with the review and everyone in the meeting is told in the app.</summary>
    public async Task<MinutesDto> SendAsync(Guid sessionId, SendMinutesRequest req, CancellationToken ct = default)
    {
        var s = await SessionAsync(sessionId, ct);
        if (s.SeriesRef is "all" or "mine") throw new ConflictException("Only a meeting's review has attendees to send minutes to.", "REVIEW_NO_ATTENDEES");
        if (s.SentAt is not null) throw new ConflictException("These minutes were already sent.", "REVIEW_SENT");
        var minutes = await FinishAsync(sessionId, ct);
        var text = string.IsNullOrWhiteSpace(req.Text) ? minutes.Text : req.Text.Replace("\r\n", "\n").Trim();
        if (text.Length > 20000) throw new ValidationException("text", "The minutes can be at most 20,000 characters.");
        var m = await connect.LoadAsync(s.SeriesRef, ct);
        s.Minutes = text; s.SentAt = clock.Now; s.UpdatedAt = clock.Now; s.UpdatedBy = ctx.UserId;
        var link = $"/meetings?review={Uri.EscapeDataString(s.SeriesRef)}&at={Uri.EscapeDataString(At(s.OccurrenceStartUtc).ToString("O"))}";
        var body = string.Join(" · ", text.Split('\n').Skip(1).Where(l => l.StartsWith("- ", StringComparison.Ordinal)).Take(4).Select(l => l[2..]));
        foreach (var u in m.People)
            await notifications.AddAsync(u, NotificationType.Meeting, $"Minutes: {m.Title} · {s.OccurrenceStartUtc:d MMM}", body.Length == 0 ? "No decisions recorded." : body, link,
                $"minutes:{s.Id:N}:{u:N}", ct: ct);
        recorder.Audit("meeting.minutes_sent", m.Workspace ? "WorkspaceMeeting" : "ProjectMeeting", m.Id, newValue: new { Session = s.Id, Attendees = m.People.Count });
        if (m.ProjectId is { } pid) recorder.Activity("meeting.minutes_sent", "ProjectMeeting", m.Id, $"Sent the minutes of “{m.Title}” to {m.People.Count} attendees", pid);
        await db.SaveChangesAsync(ct);
        return minutes with { Text = text, Sent = true };
    }

    // ------------------------------------------------------------------ owners

    /// <summary>Nudge: the owner is asked for an update (at most once in 12 hours for the same item).</summary>
    public async Task NudgeAsync(Guid workItemId, CancellationToken ct = default)
    {
        var item = await db.WorkTasks.AsNoTracking().FirstOrDefaultAsync(w => w.Id == workItemId && w.Kind == WorkTaskKind.ActionItem && w.RelatedProjectId != null, ct)
            ?? throw new NotFoundException("Action item not found.", "ACTION_ITEM_NOT_FOUND");
        if (item.AssigneeId is not { } owner) throw new ValidationException("workItemId", "Nobody owns this item yet. Re-plan it to someone first.");
        var me = ctx.RequireUserId();
        if (owner == me) throw new ValidationException("workItemId", "This one is yours: add an update instead.");
        var bucket = clock.Now.Ticks / TimeSpan.FromHours(12).Ticks;
        var who = await db.Users.AsNoTracking().Where(u => u.Id == me).Select(u => u.DisplayName).FirstOrDefaultAsync(ct) ?? "Someone";
        await notifications.AddAsync(owner, NotificationType.Nudge, $"{who} asked for an update: {item.Title}",
            item.SourceMeetingTitle is { } t ? $"From {t}. Add a one-line update in My Work." : "Add a one-line update in My Work.",
            ActionItemService.LinkOf(item.RelatedProjectId!.Value, item.Id), $"nudge:{item.Id:N}:{bucket}", ct: ct);
        recorder.Activity("actionitem.nudged", "ActionItem", item.Id, $"Asked for an update on “{item.Title}”", item.RelatedProjectId);
        await db.SaveChangesAsync(ct);
    }

    /// <summary>The owner's one-line update with On track / Need help / Ask to move date / Done; it shows in everyone's review.</summary>
    public async Task<ActionItemDto> OwnerUpdateAsync(Guid workItemId, OwnerUpdateRequest req, CancellationToken ct = default)
    {
        var item = await db.WorkTasks.AsNoTracking().FirstOrDefaultAsync(w => w.Id == workItemId && w.Kind == WorkTaskKind.ActionItem && w.RelatedProjectId != null, ct)
            ?? throw new NotFoundException("Action item not found.", "ACTION_ITEM_NOT_FOUND");
        return await actions.OwnerUpdateAsync(item.RelatedProjectId!.Value, item.Id, req.Note, (req.Signal ?? "note").Trim().ToLowerInvariant(), ct);
    }

    /// <summary>My action items, for the "My action items" view under My Work (only items from meetings).</summary>
    public async Task<MyActionItemsDto> MineAsync(CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var open = new[] { WorkTaskStatus.ToDo, WorkTaskStatus.InProgress, WorkTaskStatus.OnHold };
        var since = clock.Now.AddDays(-30);
        var rows = await db.WorkTasks.AsNoTracking().Where(w => w.Kind == WorkTaskKind.ActionItem && w.RelatedProjectId != null && w.SourceMeetingRef != null
                && ((w.AssigneeId == me && (open.Contains(w.Status) || (w.Status == WorkTaskStatus.Completed && w.CompletedAt >= since)))
                    || (w.CreatedBy == me && w.AssigneeId != me && w.AssigneeId != null && open.Contains(w.Status))))
            .OrderBy(w => w.DueDate == null).ThenBy(w => w.DueDate).Take(MaxItems).ToListAsync(ct);
        var items = await ItemsAsync(rows, [], ct);
        var today = clock.Today;
        var weekEnd = today.AddDays(6 - ((int)today.DayOfWeek + 6) % 7);
        bool Mine(ReviewItemDto i) => i.Owner?.Id == me;
        bool IsOpen(ReviewItemDto i) => i.State is "open" or "in_progress" or "blocked";
        var needs = items.Where(i => Mine(i) && IsOpen(i) && (i.LastUpdateAt is null || i.NoUpdateDays >= NoUpdateAfterDays || i.IsOverdue)).ToList();
        var week = items.Where(i => Mine(i) && IsOpen(i) && i.DueDate is { } d && d <= weekEnd).ToList();
        var waiting = items.Where(i => !Mine(i) && IsOpen(i)).ToList();
        var done = items.Where(i => Mine(i) && i.State == "done").ToList();
        var seriesRefs = items.Where(i => i.SeriesRef is not null).Select(i => i.SeriesRef!).Distinct().Take(30).ToList();
        var series = new List<SeriesInfoDto>();
        foreach (var r in seriesRefs)
        {
            try
            {
                var m = await connect.LoadAsync(r, ct);
                var (parts, changes) = await connect.SeriesAsync(m, ct);
                var next = MeetConnectService.SessionsOf(parts, changes, clock.Now, clock.Now + MeetingRecurrence.LongestSeries).Select(x => (MeetingSession?)x).FirstOrDefault();
                series.Add(new SeriesInfoDto(r, m.Title, MeetingRecurrence.Cadence(m.Rule), next is { } n ? At(n.Start) : null));
            }
            catch (NotFoundException) { /* a meeting since deleted: its items keep the tag as plain text */ }
        }
        return new MyActionItemsDto(needs, week, waiting, done, series);
    }

    private static string Cut(string s, int max) => s.Length <= max ? s : s[..(max - 1)] + "…";
}
