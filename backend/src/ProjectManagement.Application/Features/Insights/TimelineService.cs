using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Organization;
using ProjectManagement.Application.Features.WorkItems;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Insights;

/// <summary>
/// One thing on a person's day. <c>Type</c>: meeting, call, time, done, due, reminder, attendance, leave or holiday. <c>Start</c>/<c>End</c> are UTC
/// instants; <c>Date</c> is the day it falls on in the person's zone (the response's <c>TimeZone</c>). An all-day event starts at that day's
/// midnight. <c>Approximated</c>: a time entry typed in as minutes only, placed on the day by the server (see <see cref="TimelineService"/>).
/// <c>Colour</c> is a key the client maps to its palette (meet, call, time, done, due, overdue, reminder, attendance, leave).
/// <c>ItemId</c>/<c>ItemType</c>: the work item a time entry was logged on, or a reminder is about ("task" | "work"), so a day can tell which
/// work already has time today. <c>Origin</c>: what made a reminder (personal, nudge, dueDate, overdue, escalation, meeting) - an automatic
/// due-date one is not drawn beside its own deadline.
/// </summary>
public record TimelineEventDto(string Id, string Type, string Title, DateTime Start, DateTime? End, bool AllDay, DateOnly Date,
    string SourceType, Guid SourceId, string? Link, Guid? ProjectId, string? ProjectName, IReadOnlyList<string> People, string? Status, string Colour,
    string? Key = null, bool Approximated = false, bool Overdue = false, string? Priority = null, int? Minutes = null, string? Note = null,
    string? JoinUrl = null, bool Notes = false, Guid? UserId = null, string? Mode = null, bool Running = false,
    DateTime? DueAt = null, DateTime? SlaBreachAt = null, string? SlaState = null,
    Guid? ItemId = null, string? ItemType = null, string? Origin = null);

public record TimelineDto(DateOnly From, DateOnly To, string TimeZone, string Scope, DateTime GeneratedAt, IReadOnlyList<TimelineEventDto> Events);

/// <summary>
/// The canonical day/week timeline that Today ("Your day") and the Calendar (day, week, month) both draw: what is scheduled (meetings, deadlines,
/// reminders), what happened (calls held, time logged, work finished, attendance) and days off - in one response, in the person's zone, so the
/// two screens can never disagree. Every source keeps its own visibility rules: meetings and deadlines come from <see cref="CalendarService"/>
/// (which decides who the caller may look at), finished work from <see cref="WorkItemService"/>, calls only those the caller was in, reminders
/// only the caller's own. Each source is one query for everyone in view (no per-person or per-item reads).
/// </summary>
public class TimelineService(IAppDbContext db, ICurrentContext ctx, AppClock clock, CalendarService calendar, WorkItemService workItems,
    ReportingLineService reporting)
{
    public const int MaxDays = 62;

    public async Task<TimelineDto> GetAsync(DateOnly from, DateOnly to, string? scope, Guid? userId, CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        var me = ctx.RequireUserId();
        if (from.Year < 2000 || to.Year > 2200) throw new ValidationException("from", "Pick a date range.");
        if (to < from) throw new ValidationException("to", "End date must not be before the start date.");
        if (to.DayNumber - from.DayNumber > MaxDays) throw new ValidationException("to", $"The date range may span at most {MaxDays} days.");
        var mode = (scope ?? "me").Trim().ToLowerInvariant();
        if (mode is not ("me" or "user" or "team")) throw new ValidationException("scope", "Scope is me, user or team.");
        if (mode == "user" && userId is null) throw new ValidationException("userId", "Pick the person to show.");
        if (mode == "user" && userId == me) mode = "me";

        var now = clock.Now;
        var fromUtc = clock.StartOfDayUtc(from);
        var toUtc = clock.StartOfDayUtc(to.AddDays(1));
        var events = new List<TimelineEventDto>();

        // ---- scheduled: meetings and deadlines (CalendarService throws 403 for someone outside the caller's reach)
        var cal = await calendar.GetAsync(from, to, null, mine: mode == "me", userId: mode == "user" ? userId : null, ct);
        HashSet<Guid> people; WorkItemScope workScope;
        if (mode == "me") (people, workScope) = ([me], WorkItemScope.Caller);
        else if (mode == "user") (people, workScope) = ([userId!.Value], await reporting.IsInMyLineAsync(userId.Value, ct) ? WorkItemScope.ReportingLine : WorkItemScope.Caller);
        else
        {
            people = (await reporting.ReportsOfAsync(me, tid, ct)).Keys.ToHashSet();
            people.Add(me);
            workScope = WorkItemScope.ReportingLine;
        }

        foreach (var e in cal)
        {
            if (e.Type == "meeting" && e.StartsAt is { } at)
            {
                var end = at.AddMinutes(e.DurationMinutes ?? 30);
                var refId = $"{(e.ProjectId is null ? "w" : "p")}:{e.Id}";
                events.Add(new TimelineEventDto($"meeting:{e.Id}:{at:yyyyMMddHHmm}", "meeting", e.Title, at, end, false, clock.LocalDate(at),
                    e.ProjectId is null ? "workspaceMeeting" : "projectMeeting", e.Id,
                    $"/meetings?open={refId}&at={Uri.EscapeDataString(at.ToString("yyyy-MM-ddTHH:mm:ssZ"))}",
                    e.ProjectId, e.ProjectName, e.People ?? [], e.Status, "meet", JoinUrl: e.JoinUrl, Notes: e.Notes));
                continue;
            }
            if (e.Type == "meeting") continue;
            var done = e.Category is StatusCategory.Done or StatusCategory.Cancelled || e.Status is "Completed" or "Cancelled" or "Done";
            if (done) continue;   // finished work shows where it was finished (below), not on its due day
            var dayStart = clock.StartOfDayUtc(e.Date);
            events.Add(new TimelineEventDto($"due:{e.Type}:{e.Id}", "due", e.Title, dayStart, null, true, e.Date, e.Type, e.Id, LinkOf(e.Type, e.Id, e.ProjectId),
                e.ProjectId, e.ProjectName, [], e.Status, e.Overdue ? "overdue" : "due", Overdue: e.Overdue, Priority: e.Priority?.ToString()));
        }

        // Keys (INFRA-4, WT-12, AI-3, INFRA-I2) for the open work, so a focus block can name the item: three batched reads, never one per item.
        var dueIds = events.Where(e => e.Type == "due").GroupBy(e => e.SourceType).ToDictionary(g => g.Key, g => g.Select(e => e.SourceId).ToList());
        var keys = new Dictionary<Guid, string>();
        if (dueIds.TryGetValue("task", out var taskIds))
            foreach (var k in await db.Tasks.AsNoTracking().Where(t => taskIds.Contains(t.Id)).Select(t => new { t.Id, t.Number, ProjectKey = t.Project!.Key }).ToListAsync(ct))
                keys[k.Id] = $"{k.ProjectKey}-{k.Number}";
        if (dueIds.TryGetValue("issue", out var issueIds))
            foreach (var k in await db.StageIssues.AsNoTracking().Where(i => issueIds.Contains(i.Id))
                         .Select(i => new { i.Id, i.Number, ProjectKey = db.Projects.Where(p => p.Id == i.ProjectId).Select(p => p.Key).FirstOrDefault() }).ToListAsync(ct))
                keys[k.Id] = $"{k.ProjectKey}-I{k.Number}";
        var workIds = (dueIds.TryGetValue("action", out var a1) ? a1 : []).Concat(dueIds.TryGetValue("work", out var a2) ? a2 : []).ToList();
        if (workIds.Count > 0)
            foreach (var k in await db.WorkTasks.AsNoTracking().Where(w => workIds.Contains(w.Id)).Select(w => new { w.Id, w.Number, w.Kind }).ToListAsync(ct))
                keys[k.Id] = WorkItemService.KeyOf(k.Kind, k.Number);
        for (var i = 0; i < events.Count; i++)
            if (events[i].Type == "due" && keys.TryGetValue(events[i].SourceId, out var key)) events[i] = events[i] with { Key = key };

        await AddDueTimesAsync(events, people, workScope, fromUtc, toUtc, ct);

        // ---- done: every kind of work finished in the range by the people in view, at the moment it was finished
        var finished = await workItems.ListAsync(new WorkItemQuery(null, OpenOnly: false, Limit: WorkItemService.MaxLimit, AssigneeIds: people,
            CompletedFrom: fromUtc, CompletedTo: toUtc), workScope, ct);
        foreach (var w in finished.Where(w => w.CompletedAt is not null && w.Category == StatusCategory.Done))
        {
            var at = DateTime.SpecifyKind(w.CompletedAt!.Value, DateTimeKind.Utc);
            var type = TypeOf(w.Kind);
            events.Add(new TimelineEventDto($"done:{type}:{w.Id}", "done", w.Title, at, null, false, clock.LocalDate(at), type, w.Id, LinkOf(type, w.Id, w.ProjectId),
                w.ProjectId, w.ProjectName, w.Assignee is { Name.Length: > 0 } a ? [a.Name] : [], w.Status, "done", Key: w.Key, Priority: w.Priority.ToString(),
                UserId: w.Assignee?.Id));
        }

        // ---- attendance (check-in to check-out), read first: typed-in time is placed from the day's check-in
        var attendance = await db.AttendanceDays.AsNoTracking().Where(a => people.Contains(a.UserId) && a.Date >= from && a.Date <= to)
            .Select(a => new { a.Id, a.UserId, a.Date, a.CheckInAt, a.CheckOutAt, a.Mode, a.Place, a.AutoClosed }).ToListAsync(ct);
        foreach (var a in attendance)
            events.Add(new TimelineEventDto($"attendance:{a.Id}", "attendance", a.Mode == "ClientSite" ? (a.Place ?? "Client site") : a.Mode, Utc(a.CheckInAt),
                a.CheckOutAt is { } o ? Utc(o) : null, false, a.Date, "attendance", a.Id, "/?tab=attendance", null, null, [], a.CheckOutAt is null ? "in" : a.AutoClosed ? "auto-closed" : "out",
                "attendance", UserId: a.UserId, Mode: a.Mode, Running: a.CheckOutAt is null));

        // ---- time logged: timer entries at the hours they ran; typed-in minutes placed on their day (approximated)
        var entries = await (from t in db.TimeEntries.AsNoTracking()
                             where people.Contains(t.UserId) && t.WorkDate >= @from && t.WorkDate <= to
                             select new
                             {
                                 t.Id, t.UserId, t.WorkDate, t.Minutes, t.Note, t.StartedAt, t.EndedAt, t.CreatedAt, t.ProjectId, t.TaskId, t.WorkTaskId,
                                 Title = t.TaskId != null ? db.Tasks.Where(x => x.Id == t.TaskId).Select(x => x.Title).FirstOrDefault()
                                     : db.WorkTasks.Where(x => x.Id == t.WorkTaskId).Select(x => x.Title).FirstOrDefault(),
                                 ProjectName = db.Projects.Where(p => p.Id == t.ProjectId).Select(p => p.Name).FirstOrDefault(),
                                 ProjectKey = db.Projects.Where(p => p.Id == t.ProjectId).Select(p => p.Key).FirstOrDefault(),
                                 TaskNumber = db.Tasks.Where(x => x.Id == t.TaskId).Select(x => (int?)x.Number).FirstOrDefault(),
                                 WorkNumber = db.WorkTasks.Where(x => x.Id == t.WorkTaskId).Select(x => (int?)x.Number).FirstOrDefault(),
                                 WorkKind = db.WorkTasks.Where(x => x.Id == t.WorkTaskId).Select(x => (WorkTaskKind?)x.Kind).FirstOrDefault(),
                             }).OrderBy(t => t.WorkDate).ThenBy(t => t.StartedAt ?? t.CreatedAt).Take(1000).ToListAsync(ct);
        var cursor = new Dictionary<(Guid, DateOnly), DateTime>();
        foreach (var t in entries)
        {
            DateTime start, end; var approx = false;
            if (t.StartedAt is { } s)
            {
                start = Utc(s);
                end = t.EndedAt is { } e ? Utc(e) : (now > start ? now : start.AddMinutes(1));
                // An older entry saved to end in the future (logged as "2h" from the morning's check-in) is drawn up to now, never past it.
                if (t.EndedAt is not null && end > now) { end = now; start = now.AddMinutes(-t.Minutes); }
            }
            else
            {
                // Minutes only: ending when it was typed in (when that was on its day and late enough), else stacked from the day's check-in or 9:00.
                approx = true;
                var created = Utc(t.CreatedAt);
                var dayFloor = attendance.Where(a => a.UserId == t.UserId && a.Date == t.WorkDate).Select(a => (DateTime?)Utc(a.CheckInAt)).FirstOrDefault()
                               ?? clock.StartOfDayUtc(t.WorkDate).AddHours(9);
                var key = (t.UserId, t.WorkDate);
                var next = cursor.TryGetValue(key, out var c) ? c : dayFloor;
                if (clock.LocalDate(created) == t.WorkDate && created.AddMinutes(-t.Minutes) >= next) { start = created.AddMinutes(-t.Minutes); end = created; }
                else { start = next; end = next.AddMinutes(t.Minutes); }
                // Logged time is time that has happened: an entry stacked past the present ends now and starts that much earlier.
                if (end > now) { end = now; start = now.AddMinutes(-t.Minutes); }
                cursor[key] = end > next ? end : next;
            }
            var itemType = t.TaskId is not null ? "task" : "work";
            var itemId = t.TaskId ?? t.WorkTaskId ?? t.Id;
            var timeKey = t.WorkNumber is { } wn && t.WorkKind is { } wk ? WorkItemService.KeyOf(wk, wn)
                : t.TaskNumber is { } tn && t.ProjectKey is { } pk ? $"{pk}-{tn}" : null;
            events.Add(new TimelineEventDto($"time:{t.Id}", "time", t.Title ?? "Time", start, end, false, t.WorkDate, "timeEntry", t.Id,
                t.TaskId is null && t.WorkTaskId is null ? "/time" : LinkOf(itemType, itemId, t.ProjectId), t.ProjectId, t.ProjectName, [],
                t.StartedAt is not null && t.EndedAt is null ? "running" : "logged", "time", Key: timeKey, Approximated: approx, Minutes: t.Minutes, Note: t.Note, UserId: t.UserId,
                Running: t.StartedAt is not null && t.EndedAt is null,
                ItemId: t.TaskId ?? t.WorkTaskId, ItemType: t.TaskId is null && t.WorkTaskId is null ? null : itemType));
        }

        // ---- calls held in the app: the ones the caller was in, with someone in view taking part
        var callRows = await db.CallRooms.AsNoTracking()
            .Where(c => c.StartedAt < toUtc && (c.EndedAt == null || c.EndedAt >= fromUtc)
                        && (c.StartedBy == me || db.CallParticipants.Any(p => p.CallId == c.Id && p.UserId == me))
                        && (people.Contains(c.StartedBy) || db.CallParticipants.Any(p => p.CallId == c.Id && people.Contains(p.UserId) && p.JoinedAt != null)))
            .OrderBy(c => c.StartedAt).Take(300)
            .Select(c => new { c.Id, c.Title, c.Kind, c.StartedAt, c.EndedAt, c.Status, c.ProjectId, c.MeetingId, c.WorkspaceMeetingId, c.ConversationId, c.AgentEnabled,
                ProjectName = db.Projects.Where(p => p.Id == c.ProjectId).Select(p => p.Name).FirstOrDefault() })
            .ToListAsync(ct);
        var callIds = callRows.Select(c => c.Id).ToList();
        var callPeople = await (from p in db.CallParticipants.AsNoTracking()
                                                          join u in db.Users.AsNoTracking() on p.UserId equals u.Id
                                                          where callIds.Contains(p.CallId) && p.JoinedAt != null
                                                          orderby p.Role descending, u.DisplayName
                                                          select new { p.CallId, u.DisplayName }).ToListAsync(ct);
        var namesByCall = callPeople.GroupBy(p => p.CallId).ToDictionary(g => g.Key, g => (IReadOnlyList<string>)g.Select(x => x.DisplayName).Distinct().Take(8).ToList());
        foreach (var c in callRows)
        {
            var start = Utc(c.StartedAt);
            var live = c.Status == "live" && c.EndedAt is null;
            var end = c.EndedAt is { } e ? Utc(e) : live ? (now > start ? now : start.AddMinutes(1)) : start.AddMinutes(1);
            var link = live ? $"/calls/{c.Id}"
                : c.MeetingId is { } pm ? $"/meetings?open=p:{pm}"
                : c.WorkspaceMeetingId is { } wm ? $"/meetings?open=w:{wm}"
                : c.ConversationId is { } cv ? $"/messages/{cv}" : null;
            events.Add(new TimelineEventDto($"call:{c.Id}", "call", c.Title, start, end, false, clock.LocalDate(start), "call", c.Id, link, c.ProjectId, c.ProjectName,
                namesByCall.TryGetValue(c.Id, out var n) ? n : [], live ? "live" : "ended", "call", Notes: c.AgentEnabled, Mode: c.Kind, Running: live));
        }

        // ---- reminders: only ever the caller's own (scheduled in the range, or fired in it)
        if (people.Contains(me))
        {
            var rems = await db.Reminders.AsNoTracking()
                .Where(r => r.UserId == me && r.State != ReminderState.Cancelled
                            && ((r.NextFireAt != null && r.NextFireAt >= fromUtc && r.NextFireAt < toUtc) || (r.LastFiredAt != null && r.LastFiredAt >= fromUtc && r.LastFiredAt < toUtc)))
                .OrderBy(r => r.NextFireAt ?? r.LastFiredAt).Take(300)
                .Select(r => new { r.Id, r.Title, r.Note, r.State, r.NextFireAt, r.LastFiredAt, r.Link, r.TargetKey, r.TargetProjectId, r.Source, r.TargetId }).ToListAsync(ct);
            foreach (var r in rems)
            {
                var upcoming = r.State == ReminderState.Scheduled && r.NextFireAt is { } nf && nf >= fromUtc && nf < toUtc;
                var at = Utc(upcoming ? r.NextFireAt!.Value : r.LastFiredAt ?? r.NextFireAt!.Value);
                events.Add(new TimelineEventDto($"reminder:{r.Id}", "reminder", r.Title, at, null, false, clock.LocalDate(at), "reminder", r.Id, r.Link ?? "/?tab=reminders",
                    r.TargetProjectId, null, [], upcoming ? "scheduled" : r.State == ReminderState.Done ? "done" : "fired", "reminder", Key: r.TargetKey, Note: r.Note,
                    ItemId: r.TargetId, Origin: OriginOf(r.Source)));
            }
        }

        // ---- days off: planned leave of the people in view and the workspace's holidays
        var leave = await db.PlannedLeaves.AsNoTracking().Where(l => people.Contains(l.UserId) && l.WorkDate >= from && l.WorkDate <= to)
            .Select(l => new { l.Id, l.UserId, l.WorkDate, l.Note, Name = db.Users.Where(u => u.Id == l.UserId).Select(u => u.DisplayName).FirstOrDefault() }).ToListAsync(ct);
        foreach (var l in leave)
            events.Add(new TimelineEventDto($"leave:{l.Id}", "leave", people.Count > 1 ? $"{l.Name ?? "Someone"} · leave" : "Leave", clock.StartOfDayUtc(l.WorkDate), null, true, l.WorkDate,
                "plannedLeave", l.Id, "/time", null, null, l.Name is null ? [] : [l.Name], "planned", "leave", Note: l.Note, UserId: l.UserId));
        var holidays = await db.Holidays.AsNoTracking().Where(h => h.TenantId == tid && h.Date >= from && h.Date <= to).Select(h => new { h.Id, h.Date, h.Name, h.Region }).ToListAsync(ct);
        foreach (var h in holidays)
            events.Add(new TimelineEventDto($"holiday:{h.Id}", "holiday", h.Name, clock.StartOfDayUtc(h.Date), null, true, h.Date, "holiday", h.Id, null, null, null, [], h.Region, "leave"));

        var ordered = events.OrderBy(e => e.Date).ThenByDescending(e => e.AllDay).ThenBy(e => e.Start).ThenBy(e => e.Id, StringComparer.Ordinal).ToList();
        return new TimelineDto(from, to, clock.ZoneId, mode, now, ordered);

        static DateTime Utc(DateTime d) => DateTime.SpecifyKind(d, DateTimeKind.Utc);
    }

    /// <summary>
    /// Deadlines at their time: an open item with a due time gets <c>DueAt</c> (the instant on its day); an open ticket gets its SLA resolve-by
    /// as <c>SlaBreachAt</c> (and as <c>DueAt</c> when it has no due time of its own), so Today and the Calendar can mark the breach at its hour.
    /// Tickets of the people in view that have no due date but whose resolve-by falls in the range are added as deadlines on the breach day.
    /// One read for the dated items and one for the SLA-only tickets.
    /// </summary>
    private async Task AddDueTimesAsync(List<TimelineEventDto> events, HashSet<Guid> people, WorkItemScope workScope, DateTime fromUtc, DateTime toUtc, CancellationToken ct)
    {
        var now = clock.Now;
        var dueIds = events.Where(e => e.Type == "due" && e.SourceType is "task" or "issue" or "action" or "work").Select(e => e.SourceId).Distinct().ToList();
        if (dueIds.Count > 0)
        {
            var times = await db.WorkItems.AsNoTracking().Where(w => dueIds.Contains(w.Id)).Select(w => new { w.Id, w.DueDate, w.DueTime }).ToListAsync(ct);
            var slas = await db.WorkTasks.AsNoTracking().Where(w => dueIds.Contains(w.Id) && w.Kind == WorkTaskKind.Operational).ToDictionaryAsync(w => w.Id, ct);
            var byId = times.ToDictionary(t => t.Id);
            for (var i = 0; i < events.Count; i++)
            {
                var e = events[i];
                if (e.Type != "due" || !byId.TryGetValue(e.SourceId, out var t)) continue;
                var at = clock.DueAt(t.DueDate, t.DueTime);
                DateTime? breach = null; string? state = null;
                if (slas.TryGetValue(e.SourceId, out var w) && ProjectManagement.Application.Features.Work.SlaService.State(w, now) is { Resolution: { } res } sla && res.State is "OnTrack" or "AtRisk" or "Breached" or "Paused")
                    (breach, state) = (res.DueAt, sla.State);
                events[i] = e with { DueAt = at ?? breach, SlaBreachAt = breach, SlaState = state, Overdue = e.Overdue || (at is { } x && x < now) };
            }
        }

        // Tickets held to an SLA in the range that have no due date (so the calendar does not list them): a deadline on the breach day.
        var kinds = await workItems.VisibleKindsAsync(workScope, ct);
        if (!kinds.Contains(WorkItemKind.Operational)) return;
        var open = new[] { WorkTaskStatus.ToDo, WorkTaskStatus.InProgress, WorkTaskStatus.OnHold };
        var shown = events.Where(e => e.Type == "due").Select(e => e.SourceId).ToHashSet();
        var slaOnly = await db.WorkTasks.AsNoTracking()
            .Where(w => w.Kind == WorkTaskKind.Operational && open.Contains(w.Status) && w.DueDate == null && w.AssigneeId != null && people.Contains(w.AssigneeId.Value)
                        && w.ResolutionDueAt != null && w.ResolutionDueAt >= fromUtc && w.ResolutionDueAt < toUtc)
            .OrderBy(w => w.ResolutionDueAt).Take(200).ToListAsync(ct);
        foreach (var w in slaOnly.Where(w => !shown.Contains(w.Id)))
        {
            if (ProjectManagement.Application.Features.Work.SlaService.State(w, now) is not { Resolution: { } res } sla) continue;
            var at = res.DueAt;
            var day = clock.LocalDate(at);
            events.Add(new TimelineEventDto($"due:work:{w.Id}", "due", w.Title, clock.StartOfDayUtc(day), null, true, day, "work", w.Id, LinkOf("work", w.Id, null),
                null, null, [], WorkItemService.WorkLabel(w.Status), res.State == "Breached" ? "overdue" : "due",
                Key: WorkItemService.KeyOf(w.Kind, w.Number), Overdue: res.State == "Breached", Priority: w.Priority.ToString(), UserId: w.AssigneeId,
                DueAt: at, SlaBreachAt: at, SlaState: sla.State));
        }
    }

    private static string TypeOf(WorkItemKind k) => k switch
    {
        WorkItemKind.Task => "task", WorkItemKind.Issue => "issue", WorkItemKind.ActionItem => "action", _ => "work",
    };

    /// <summary>A reminder's source as the client reads it: "personal", "nudge", "dueDate", "overdue", "escalation", "meeting".</summary>
    public static string OriginOf(ReminderSource source) { var n = source.ToString(); return char.ToLowerInvariant(n[0]) + n[1..]; }

    /// <summary>Where a click goes: work items open in Work, projects/milestones/stages in their project.</summary>
    private static string LinkOf(string type, Guid id, Guid? projectId) => type switch
    {
        "task" or "issue" or "action" or "work" => $"/work?item={id}",
        _ => projectId is { } p ? $"/work/projects/{p}" : "/work/projects",
    };
}
