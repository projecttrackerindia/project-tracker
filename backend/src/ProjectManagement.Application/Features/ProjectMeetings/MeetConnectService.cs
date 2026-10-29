using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.Time;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.ProjectMeetings;

/// <summary>One session of a meeting: where it is now and where the rule put it (the key for changing it on its own).</summary>
public record MeetingSessionDto(DateTimeOffset Start, DateTimeOffset End, DateTimeOffset OriginalStart, string Title, bool Changed);
/// <summary>A meeting's sessions in a window, expanded on the server from its stored rule, with its cadence and the rule in words.</summary>
public record MeetingSessionsDto(string Ref, string SeriesRef, string Title, string Cadence, string Recurrence, IReadOnlyList<MeetingSessionDto> Sessions);

/// <summary>A time someone is busy (a meeting or a day of planned leave). Only the time: what it is stays private.</summary>
public record BusyBlockDto(DateTimeOffset Start, DateTimeOffset End, string Kind);
public record PersonBusyDto(Guid UserId, string Name, IReadOnlyList<BusyBlockDto> Busy, bool FreeAtSlot);
/// <summary>Free/busy for the schedule form: each person's busy times in the window, and whether the slot asked about is free for everyone.</summary>
public record FreeBusyDto(DateTimeOffset From, DateTimeOffset To, IReadOnlyList<PersonBusyDto> People, bool EveryoneFree, int BusyCount);

/// <summary>
/// "Log 45m to UPI AutoPay?": a proposed time entry for a session the person was in. <see cref="AssignedToMe"/>: action items given to them
/// in that session. <see cref="Overlap"/>: another meeting of theirs at the same time (each proposes its own time; the overlap is flagged).
/// </summary>
public record TimeProposalDto(Guid Id, string MeetingRef, Guid MeetingId, string MeetingTitle, Guid ProjectId, string ProjectName, string? ProjectKey,
    DateTimeOffset Start, DateTimeOffset End, int Minutes, string Status, bool Billable, int AssignedToMe, string? Overlap);
public record LogProposalRequest(int? Minutes, string? Note, bool? Billable);
public record DismissProposalRequest(string? Reason);

/// <summary>One typed line in a meeting ("Confirm bank sandbox date @Ravi fri"); the owner and date may also be given as chips.</summary>
public record CaptureActionItemRequest(string? Text, DateTimeOffset? OccurrenceStart = null, Guid? ProjectId = null, Guid? AssigneeId = null, DateOnly? DueDate = null);
/// <summary>How the line reads: the title, who it is for and when it is due (the chips under the line), before Enter creates it.</summary>
public record CapturePreviewDto(string Title, UserRefDto? Owner, string? OwnerToken, bool OwnerAmbiguous, DateOnly? Due, string? DateToken, Guid? ProjectId, string? ProjectName);
public record CapturedItemDto(ActionItemDto Item, string MeetingRef, string SeriesRef, DateTimeOffset? OccurrenceStart);

/// <summary>What a meeting page shows beside the notes: the items made in this session, and the series' open ones to review.</summary>
public record MeetingItemRowDto(Guid Id, string Key, string Title, UserRefDto? Owner, DateOnly? DueDate, string Status, bool IsOverdue, DateTimeOffset? OccurrenceStart);
public record MeetingItemsDto(string MeetingRef, string SeriesRef, string Title, string Cadence, string Recurrence, DateTimeOffset? NextSession, DateTimeOffset? PreviousSession,
    IReadOnlyList<MeetingItemRowDto> CreatedHere, int OpenInSeries, Guid? ProjectId, string? ProjectName);

/// <summary>
/// Meetings connected everywhere: their sessions expanded on the server, people's free/busy for the schedule form, the time each attendee
/// spent proposed when a session ends (logged only when they confirm), and action items captured during a meeting as ordinary work items
/// with that meeting as their source.
/// </summary>
public class MeetConnectService(IAppDbContext db, ICurrentContext ctx, AppClock clock, ProjectAccess access, Recorder recorder, NotificationService notifications,
    ActionItemService actions, TimeService time, MeetingService meetings)
{
    /// <summary>How long after a session ends its time is still offered.</summary>
    private static readonly TimeSpan ProposalWindow = TimeSpan.FromDays(3);
    private static readonly TimeSpan Snooze = TimeSpan.FromHours(2);

    /// <summary>A meeting as these features need it, loaded with the caller's own visibility.</summary>
    internal sealed record Meeting(bool Workspace, Guid Id, Guid? ProjectId, string? ProjectName, string? ProjectKey, string Title, string? Description, DateTime Start, DateTime End,
        string Zone, string? Rule, Guid OrganizerId, Guid? SeriesRootId, MeetingStatus Status, IReadOnlyList<Guid> People)
    {
        public string Ref => MeetingSessions.Ref(Workspace, Id);
        public string SeriesRef => MeetingSessions.Ref(Workspace, SeriesRootId ?? Id);
    }

    private static string Zone(string z) => ProjectManagement.Application.Features.Reminders.ZoneTime.IsKnown(z) ? z : "UTC";

    /// <summary>
    /// A meeting by its ref. Project meetings: anyone who can see the project (the query filter). Workspace meetings: the people invited,
    /// or an Owner/Admin. Anyone else: not found.
    /// </summary>
    internal async Task<Meeting> LoadAsync(string? meetingRef, CancellationToken ct)
    {
        if (!MeetingSessions.TryParseRef(meetingRef, out var workspace, out var id)) throw new ValidationException("meetingRef", "Name the meeting as p:{id} or w:{id}.");
        var me = ctx.RequireUserId();
        if (!workspace)
        {
            var m = await db.ProjectMeetings.AsNoTracking().Where(x => x.Id == id).Select(x => new
            {
                x.Id, x.ProjectId, ProjectName = x.Project!.Name, ProjectKey = x.Project.Key, x.Title, x.Description, x.StartTimeUtc, x.EndTimeUtc, x.TimeZone, x.RecurrenceRule,
                x.OrganizerUserId, x.SeriesRootId, x.Status,
                People = x.Participants.Where(p => p.UserId != null && p.RsvpStatus != AttendeeRsvpStatus.Declined).Select(p => p.UserId!.Value).ToList(),
            }).FirstOrDefaultAsync(ct) ?? throw new NotFoundException("Meeting not found.");
            return new Meeting(false, m.Id, m.ProjectId, m.ProjectName, m.ProjectKey, m.Title, m.Description, m.StartTimeUtc, m.EndTimeUtc, Zone(m.TimeZone), m.RecurrenceRule,
                m.OrganizerUserId, m.SeriesRootId, m.Status, m.People.Append(m.OrganizerUserId).Distinct().ToList());
        }
        var w = await db.WorkspaceMeetings.AsNoTracking().Where(x => x.Id == id).Select(x => new
        {
            x.Id, x.Title, x.Description, x.StartTimeUtc, x.EndTimeUtc, x.TimeZone, x.RecurrenceRule, x.OrganizerUserId, x.SeriesRootId, x.Status,
            People = x.Attendees.Where(a => a.RsvpStatus != AttendeeRsvpStatus.Declined).Select(a => a.UserId).ToList(),
            Invited = x.Attendees.Any(a => a.UserId == me),
        }).FirstOrDefaultAsync(ct) ?? throw new NotFoundException("Meeting not found.");
        if (!w.Invited && w.OrganizerUserId != me && ctx.Role is not (TenantRole.Owner or TenantRole.Admin)) throw new NotFoundException("Meeting not found.");
        return new Meeting(true, w.Id, null, null, null, w.Title, w.Description, w.StartTimeUtc, w.EndTimeUtc, Zone(w.TimeZone), w.RecurrenceRule, w.OrganizerUserId, w.SeriesRootId,
            w.Status, w.People.Append(w.OrganizerUserId).Distinct().ToList());
    }

    /// <summary>Every meeting of a series (its first meeting and the ones that carried it on after a "this and following" change), with their changes.</summary>
    internal async Task<(List<Meeting> Parts, Dictionary<Guid, List<MeetingOccurrenceChange>> Changes)> SeriesAsync(Meeting any, CancellationToken ct)
    {
        var root = any.SeriesRootId ?? any.Id;
        List<Guid> ids = any.Workspace
            ? await db.WorkspaceMeetings.AsNoTracking().Where(m => (m.Id == root || m.SeriesRootId == root) && m.Status == MeetingStatus.Scheduled).Select(m => m.Id).ToListAsync(ct)
            : await db.ProjectMeetings.AsNoTracking().Where(m => (m.Id == root || m.SeriesRootId == root) && m.Status == MeetingStatus.Scheduled).Select(m => m.Id).ToListAsync(ct);
        var parts = new List<Meeting>();
        foreach (var id in ids.Take(20))
            parts.Add(id == any.Id ? any : await LoadAsync(MeetingSessions.Ref(any.Workspace, id), ct));
        if (parts.Count == 0) parts.Add(any);
        return (parts, await MeetingSessions.ChangesAsync(db, parts.Select(p => p.Id), ct));
    }

    /// <summary>The series' sessions in a window, across its parts, in order.</summary>
    internal static IEnumerable<MeetingSession> SessionsOf(List<Meeting> parts, Dictionary<Guid, List<MeetingOccurrenceChange>> changes, DateTime from, DateTime to) =>
        parts.SelectMany(p => MeetingSessions.Expand(p.Rule, p.Start, p.End, p.Zone, changes.GetValueOrDefault(p.Id), from, to)).OrderBy(s => s.Start);

    // ------------------------------------------------------------------ sessions

    /// <summary>A meeting's sessions between two instants (at most 400 days), expanded from its stored rule with its one-off changes.</summary>
    public async Task<MeetingSessionsDto> SessionsAsync(string meetingRef, DateTimeOffset? from, DateTimeOffset? to, CancellationToken ct = default)
    {
        var m = await LoadAsync(meetingRef, ct);
        var start = (from ?? new DateTimeOffset(clock.Now.AddDays(-1), TimeSpan.Zero)).UtcDateTime;
        var end = (to ?? new DateTimeOffset(start.AddDays(60), TimeSpan.Zero)).UtcDateTime;
        if (end <= start) throw new ValidationException("to", "The end of the range must be after its start.");
        if (end - start > TimeSpan.FromDays(400)) throw new ValidationException("to", "Ask for at most 400 days at a time.");
        var changes = await MeetingSessions.ChangesAsync(db, [m.Id], ct);
        var sessions = MeetingSessions.Expand(m.Rule, m.Start, m.End, m.Zone, changes.GetValueOrDefault(m.Id), start, end).Take(400)
            .Select(s => new MeetingSessionDto(At(s.Start), At(s.End), At(s.Original), s.Title ?? m.Title, s.Changed)).ToList();
        return new MeetingSessionsDto(m.Ref, m.SeriesRef, m.Title, MeetingRecurrence.Cadence(m.Rule), m.Rule is null ? "Once" : MeetingRecurrence.Describe(m.Rule, m.Start, m.Zone), sessions);
    }

    private static DateTimeOffset At(DateTime utc) => new(DateTime.SpecifyKind(utc, DateTimeKind.Utc), TimeSpan.Zero);

    // ------------------------------------------------------------------ free / busy

    /// <summary>
    /// When each of these people is busy between two instants (at most two weeks): their meetings (sessions expanded, one-off changes
    /// applied) and their days of planned leave. Only the times are given, never what the meetings are. With a slot
    /// (<paramref name="slotStart"/>, <paramref name="slotEnd"/>), whether each person - and everyone - is free then.
    /// </summary>
    public async Task<FreeBusyDto> FreeBusyAsync(IReadOnlyList<Guid> userIds, IReadOnlyList<Guid>? teamIds, DateTimeOffset from, DateTimeOffset to, DateTimeOffset? slotStart, DateTimeOffset? slotEnd,
        string? ignoreMeetingRef, CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        if (to <= from) throw new ValidationException("to", "The end of the range must be after its start.");
        if (to - from > TimeSpan.FromDays(14)) throw new ValidationException("to", "Ask for at most two weeks at a time.");
        var ids = userIds.Distinct().ToList();
        if (teamIds is { Count: > 0 })
        {
            var teams = teamIds.Distinct().ToList();
            ids.AddRange(await db.TeamMembers.AsNoTracking().Where(m => teams.Contains(m.TeamId)).Select(m => m.UserId).ToListAsync(ct));
            ids = ids.Distinct().ToList();
        }
        if (ids.Count == 0) ids.Add(ctx.RequireUserId());
        if (ids.Count > 60) throw new ValidationException("userIds", "Ask about at most 60 people at a time.");
        // Only members of this workspace (guests see themselves only: a guest learns nothing about other people's days).
        var members = await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid && ids.Contains(m.UserId) && m.Status == MemberStatus.Active)
            .Select(m => new { m.UserId, m.User!.DisplayName }).ToListAsync(ct);
        if (ctx.Role == TenantRole.Guest) members = members.Where(m => m.UserId == ctx.UserId).ToList();
        var who = members.Select(m => m.UserId).ToList();
        var fromUtc = from.UtcDateTime; var toUtc = to.UtcDateTime;
        var floor = fromUtc - MeetingRecurrence.LongestSeries;
        MeetingSessions.TryParseRef(ignoreMeetingRef, out _, out var ignoreId);

        // Every meeting of these people in the workspace, whatever project it is in: free/busy shows times only, so it does not depend on
        // which projects the caller can open.
        var project = await db.ProjectMeetings.IgnoreQueryFilters().AsNoTracking()
            .Where(m => m.TenantId == tid && m.Status == MeetingStatus.Scheduled && m.StartTimeUtc < toUtc && (m.RecurrenceRule != null ? m.StartTimeUtc >= floor : m.EndTimeUtc > fromUtc)
                && m.Id != ignoreId && db.Projects.IgnoreQueryFilters().Any(p => p.Id == m.ProjectId && !p.IsDeleted)
                && (who.Contains(m.OrganizerUserId) || m.Participants.Any(p => p.UserId != null && who.Contains(p.UserId.Value) && p.RsvpStatus != AttendeeRsvpStatus.Declined)))
            .Take(500).Select(m => new { m.Id, m.StartTimeUtc, m.EndTimeUtc, m.TimeZone, m.RecurrenceRule,
                People = m.Participants.Where(p => p.UserId != null && p.RsvpStatus != AttendeeRsvpStatus.Declined).Select(p => p.UserId!.Value).ToList(), m.OrganizerUserId }).ToListAsync(ct);
        var workspace = await db.WorkspaceMeetings.IgnoreQueryFilters().AsNoTracking()
            .Where(m => m.TenantId == tid && m.Status == MeetingStatus.Scheduled && m.StartTimeUtc < toUtc && (m.RecurrenceRule != null ? m.StartTimeUtc >= floor : m.EndTimeUtc > fromUtc)
                && m.Id != ignoreId && m.Attendees.Any(a => who.Contains(a.UserId) && a.RsvpStatus != AttendeeRsvpStatus.Declined))
            .Take(500).Select(m => new { m.Id, m.StartTimeUtc, m.EndTimeUtc, m.TimeZone, m.RecurrenceRule,
                People = m.Attendees.Where(a => a.RsvpStatus != AttendeeRsvpStatus.Declined).Select(a => a.UserId).ToList(), m.OrganizerUserId }).ToListAsync(ct);
        var all = project.Select(m => (m.Id, m.StartTimeUtc, m.EndTimeUtc, m.TimeZone, m.RecurrenceRule, People: m.People.Append(m.OrganizerUserId).ToHashSet()))
            .Concat(workspace.Select(m => (m.Id, m.StartTimeUtc, m.EndTimeUtc, m.TimeZone, m.RecurrenceRule, People: m.People.Append(m.OrganizerUserId).ToHashSet()))).ToList();
        var changes = await MeetingSessions.ChangesAsync(db, all.Where(m => m.RecurrenceRule != null).Select(m => m.Id), ct, ignoreFilters: true);
        var busy = who.ToDictionary(u => u, _ => new List<BusyBlockDto>());
        foreach (var m in all)
            foreach (var s in MeetingSessions.Expand(m.RecurrenceRule, m.StartTimeUtc, m.EndTimeUtc, Zone(m.TimeZone), changes.GetValueOrDefault(m.Id), fromUtc - TimeSpan.FromDays(1), toUtc))
            {
                if (s.End <= fromUtc) continue;
                foreach (var u in m.People.Where(busy.ContainsKey)) busy[u].Add(new BusyBlockDto(At(s.Start), At(s.End), "meeting"));
            }
        var fromDay = clock.LocalDate(fromUtc); var toDay = clock.LocalDate(toUtc);
        var leave = await db.PlannedLeaves.AsNoTracking().Where(l => who.Contains(l.UserId) && l.WorkDate >= fromDay && l.WorkDate <= toDay).Select(l => new { l.UserId, l.WorkDate }).ToListAsync(ct);
        foreach (var l in leave)
            busy[l.UserId].Add(new BusyBlockDto(At(clock.StartOfDayUtc(l.WorkDate)), At(clock.StartOfDayUtc(l.WorkDate.AddDays(1))), "leave"));

        var people = members.OrderBy(m => m.DisplayName).Select(m =>
        {
            var blocks = busy[m.UserId].OrderBy(b => b.Start).ToList();
            var free = slotStart is not { } ss || slotEnd is not { } se || !blocks.Any(b => b.Start < se && b.End > ss);
            return new PersonBusyDto(m.UserId, m.DisplayName, blocks, free);
        }).ToList();
        return new FreeBusyDto(from, to, people, people.All(p => p.FreeAtSlot), people.Count(p => !p.FreeAtSlot));
    }

    // ------------------------------------------------------------------ time spent in meetings: proposed, logged only on confirm

    /// <summary>
    /// The caller's open "Log 45m to …?" prompts: one per session of a project meeting they were in (organizer, or invited and not declined)
    /// that ended in the last three days, made the first time it is asked for (and announced once, in the bell). Snoozed ones ("Later")
    /// come back after two hours; logged or dismissed ones never again. Nothing is ever logged here.
    /// </summary>
    public async Task<IReadOnlyList<TimeProposalDto>> ProposalsAsync(CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var tid = ctx.RequireTenantId();
        var now = clock.Now;
        var since = now - ProposalWindow;
        var floor = since - MeetingRecurrence.LongestSeries;
        var rows = await db.ProjectMeetings.AsNoTracking()
            .Where(m => m.Status == MeetingStatus.Scheduled && m.StartTimeUtc < now && (m.RecurrenceRule != null ? m.StartTimeUtc >= floor : m.EndTimeUtc > since)
                && (m.OrganizerUserId == me || m.Participants.Any(p => p.UserId == me && p.RsvpStatus != AttendeeRsvpStatus.Declined)))
            .Take(200).Select(m => new { m.Id, m.Title, m.ProjectId, m.StartTimeUtc, m.EndTimeUtc, m.TimeZone, m.RecurrenceRule }).ToListAsync(ct);
        var changes = await MeetingSessions.ChangesAsync(db, rows.Where(r => r.RecurrenceRule != null).Select(r => r.Id), ct);
        var ended = new List<(Guid MeetingId, string Title, Guid ProjectId, MeetingSession S)>();
        foreach (var r in rows)
            foreach (var s in MeetingSessions.Expand(r.RecurrenceRule, r.StartTimeUtc, r.EndTimeUtc, Zone(r.TimeZone), changes.GetValueOrDefault(r.Id), since - TimeSpan.FromDays(1), now))
                if (s.End <= now && s.End > since) ended.Add((r.Id, s.Title ?? r.Title, r.ProjectId, s));

        if (ended.Count > 0)
        {
            var ids = ended.Select(e => e.MeetingId).Distinct().ToList();
            var existing = await db.MeetingTimeProposals.AsNoTracking().Where(p => p.UserId == me && ids.Contains(p.MeetingId) && p.OccurrenceEndUtc > since - TimeSpan.FromDays(1))
                .Select(p => new { p.MeetingId, p.OccurrenceStartUtc }).ToListAsync(ct);
            var have = existing.Select(e => (e.MeetingId, e.OccurrenceStartUtc)).ToHashSet();
            // Time already logged for that meeting at that session (by hand, or another device) needs no prompt.
            var refs = ids.Select(i => MeetingSessions.Ref(false, i)).ToList();
            var logged = (await db.TimeEntries.AsNoTracking().Where(e => e.UserId == me && e.MeetingRef != null && refs.Contains(e.MeetingRef) && e.StartedAt != null && e.StartedAt > since - TimeSpan.FromDays(1))
                .Select(e => new { e.MeetingRef, e.StartedAt }).ToListAsync(ct)).Select(e => (e.MeetingRef!, e.StartedAt!.Value)).ToHashSet();
            var projectIds = ended.Select(e => e.ProjectId).Distinct().ToList();
            var names = await db.Projects.AsNoTracking().Where(p => projectIds.Contains(p.Id)).ToDictionaryAsync(p => p.Id, p => p.Name, ct);
            var added = 0;
            foreach (var e in ended.Where(e => !have.Contains((e.MeetingId, e.S.Original))))
            {
                if (logged.Contains((MeetingSessions.Ref(false, e.MeetingId), e.S.Start))) continue;
                var minutes = Math.Clamp((int)Math.Round((e.S.End - e.S.Start).TotalMinutes), 1, 24 * 60);
                db.MeetingTimeProposals.Add(new MeetingTimeProposal
                {
                    TenantId = tid, UserId = me, MeetingRef = MeetingSessions.Ref(false, e.MeetingId), MeetingId = e.MeetingId, MeetingTitle = Cut(e.Title, 200), ProjectId = e.ProjectId,
                    OccurrenceStartUtc = e.S.Original, OccurrenceEndUtc = e.S.End, Minutes = minutes, Status = "Proposed", CreatedAt = now, CreatedBy = me,
                });
                // The person is told once, in the bell (toSelf: it is a prompt for them, not an echo of something they did).
                await notifications.AddAsync(me, NotificationType.Meeting, $"Log {Duration(minutes)} to {names.GetValueOrDefault(e.ProjectId, "the project")}?",
                    $"{e.Title} ended · tap to log it, or say you did not attend", "/?tab=today&log=meetings", $"meetlog:{e.MeetingId:N}:{e.S.Original:yyyyMMddHHmm}", toSelf: true, ct: ct);
                added++;
            }
            if (added > 0)
            {
                try { await db.SaveChangesAsync(ct); }
                catch (DbUpdateException) { /* another tab made the same proposals at the same moment: theirs stand */ }
            }
        }
        return await OpenProposalsAsync(me, now, ct);
    }

    private async Task<IReadOnlyList<TimeProposalDto>> OpenProposalsAsync(Guid me, DateTime now, CancellationToken ct)
    {
        var rows = await db.MeetingTimeProposals.AsNoTracking().Where(p => p.UserId == me && p.Status == "Proposed" && (p.SnoozedUntil == null || p.SnoozedUntil <= now)
                && p.OccurrenceEndUtc > now - ProposalWindow)
            .OrderByDescending(p => p.OccurrenceEndUtc).Take(20).ToListAsync(ct);
        if (rows.Count == 0) return [];
        var projectIds = rows.Select(r => r.ProjectId).Distinct().ToList();
        var projects = await db.Projects.AsNoTracking().Where(p => projectIds.Contains(p.Id)).Select(p => new { p.Id, p.Name, p.Key, p.IsBillable }).ToDictionaryAsync(p => p.Id, ct);
        var refs = rows.Select(r => r.MeetingRef).Distinct().ToList();
        var assigned = await db.WorkItems.AsNoTracking().Where(w => w.AssigneeId == me && w.SourceMeetingRef != null && refs.Contains(w.SourceMeetingRef))
            .Select(w => new { w.SourceMeetingRef, w.SourceOccurrenceStartUtc }).ToListAsync(ct);
        return rows.Where(r => projects.ContainsKey(r.ProjectId)).Select(r =>
        {
            var p = projects[r.ProjectId];
            var start = r.OccurrenceEndUtc.AddMinutes(-r.Minutes);
            var overlap = rows.FirstOrDefault(o => o.Id != r.Id && o.OccurrenceStartUtc < r.OccurrenceEndUtc && o.OccurrenceEndUtc > start);
            return new TimeProposalDto(r.Id, r.MeetingRef, r.MeetingId, r.MeetingTitle, r.ProjectId, p.Name, p.Key, At(r.OccurrenceEndUtc.AddMinutes(-r.Minutes)), At(r.OccurrenceEndUtc),
                r.Minutes, r.Status, p.IsBillable, assigned.Count(a => a.SourceMeetingRef == r.MeetingRef && a.SourceOccurrenceStartUtc == r.OccurrenceStartUtc),
                overlap is null ? null : $"Overlaps {overlap.MeetingTitle}");
        }).ToList();
    }

    private async Task<MeetingTimeProposal> MineAsync(Guid id, CancellationToken ct)
    {
        var me = ctx.RequireUserId();
        var p = await db.MeetingTimeProposals.FirstOrDefaultAsync(x => x.Id == id && x.UserId == me, ct) ?? throw new NotFoundException("Nothing to log.", "TIME_PROPOSAL_NOT_FOUND");
        if (p.Status != "Proposed") throw new ConflictException(p.Status == "Logged" ? "This time is already logged." : "This was already dismissed.", "TIME_PROPOSAL_DECIDED");
        return p;
    }

    /// <summary>
    /// Log: the person confirmed. One time entry for the meeting's project, placed where the session was (it ends when the session ended)
    /// for the minutes they chose (the meeting's length unless changed), through the time service, so the day's limits, closed weeks and
    /// overlap warnings apply as for any entry.
    /// </summary>
    public async Task<TimeEntryDto> LogAsync(Guid id, LogProposalRequest req, CancellationToken ct = default)
    {
        var p = await MineAsync(id, ct);
        var minutes = req.Minutes ?? p.Minutes;
        if (minutes is < 1 or > 24 * 60) throw new ValidationException("minutes", "Enter between 1 minute and 24 hours.");
        var end = p.OccurrenceEndUtc > clock.Now ? clock.Now : p.OccurrenceEndUtc;
        var start = end.AddMinutes(-minutes);
        var entry = await time.LogOnMeetingAsync(p.ProjectId, p.MeetingRef, p.MeetingTitle, new LogTimeRequest(minutes, null, string.IsNullOrWhiteSpace(req.Note) ? p.MeetingTitle : req.Note, req.Billable, start, end), ct);
        p.Status = "Logged"; p.TimeEntryId = entry.Id; p.DecidedAt = clock.Now; p.UpdatedAt = clock.Now; p.UpdatedBy = ctx.UserId;
        await db.SaveChangesAsync(ct);
        return entry;
    }

    /// <summary>Later: asked again in two hours.</summary>
    public async Task LaterAsync(Guid id, CancellationToken ct = default)
    {
        var p = await MineAsync(id, ct);
        p.SnoozedUntil = clock.Now + Snooze; p.UpdatedAt = clock.Now; p.UpdatedBy = ctx.UserId;
        await db.SaveChangesAsync(ct);
    }

    /// <summary>Didn't attend (or any other reason not to log it): never asked again for that session.</summary>
    public async Task DismissAsync(Guid id, DismissProposalRequest req, CancellationToken ct = default)
    {
        var p = await MineAsync(id, ct);
        p.Status = "Dismissed"; p.DismissReason = Cut((req.Reason ?? "didnt_attend").Trim(), 40); p.DecidedAt = clock.Now; p.UpdatedAt = clock.Now; p.UpdatedBy = ctx.UserId;
        await db.SaveChangesAsync(ct);
    }

    // ------------------------------------------------------------------ action items captured in a meeting

    private async Task<(Guid ProjectId, string ProjectName, IReadOnlyList<(Guid Id, string Name)> People)> CaptureScopeAsync(Meeting m, Guid? projectId, CancellationToken ct)
    {
        var pid = m.ProjectId ?? projectId ?? throw new ValidationException("projectId", "Choose the project this action item belongs to.");
        var project = await access.GetProjectAsync(pid, ct);
        // The meeting's people first (an "@ravi" in a meeting means the Ravi in it), then everyone who can be given the project's work.
        var eligible = await meetings.EligibleParticipantsAsync(pid, ct);
        var inMeeting = m.People.ToHashSet();
        var people = eligible.Where(e => e.UserId is { } u && inMeeting.Contains(u)).Select(e => (e.UserId!.Value, e.Name))
            .Concat(eligible.Where(e => e.UserId is { } u && !inMeeting.Contains(u)).Select(e => (e.UserId!.Value, e.Name))).ToList();
        return (pid, project.Name, people);
    }

    private static (Guid? Owner, bool Ambiguous) Owner(string? token, IReadOnlyList<(Guid Id, string Name)> people, IReadOnlyCollection<Guid> inMeeting)
    {
        if (token is null) return (null, false);
        var inside = QuickLine.ResolveOwner(token, people.Where(p => inMeeting.Contains(p.Id)), out var amb1);
        if (inside is not null) return (inside, false);
        var any = QuickLine.ResolveOwner(token, people, out var amb2);
        return (any, any is null && (amb1 || amb2));
    }

    /// <summary>How a typed line reads in this meeting, for the chips under the capture line (nothing is created).</summary>
    public async Task<CapturePreviewDto> PreviewAsync(string meetingRef, CaptureActionItemRequest req, CancellationToken ct = default)
    {
        var m = await LoadAsync(meetingRef, ct);
        var parsed = QuickLine.Parse(req.Text, clock.Today);
        var (pid, pname, people) = await CaptureScopeAsync(m, req.ProjectId, ct);
        var (owner, ambiguous) = Owner(parsed.OwnerToken, people, m.People.ToHashSet());
        var ownerId = req.AssigneeId ?? owner;
        var name = ownerId is { } o ? people.Where(p => p.Id == o).Select(p => p.Name).FirstOrDefault() : null;
        return new CapturePreviewDto(parsed.Title, ownerId is { } oid && name is not null ? new UserRefDto(oid, name) : null, parsed.OwnerToken, ambiguous, req.DueDate ?? parsed.Due, parsed.DateToken, pid, pname);
    }

    /// <summary>
    /// Enter on the capture line: an action item (a work item like any other) in the meeting's project, owned by the "@person" and due on the
    /// date the line names, with this meeting and session as its source. "@ravi" matching more than one person is refused rather than guessed.
    /// </summary>
    public async Task<CapturedItemDto> CaptureAsync(string meetingRef, CaptureActionItemRequest req, CancellationToken ct = default)
    {
        var m = await LoadAsync(meetingRef, ct);
        var parsed = QuickLine.Parse(req.Text, clock.Today);
        if (parsed.Title.Length == 0) throw new ValidationException("text", "Type what needs doing.");
        var (pid, _, people) = await CaptureScopeAsync(m, req.ProjectId, ct);
        var (owner, ambiguous) = Owner(parsed.OwnerToken, people, m.People.ToHashSet());
        if (req.AssigneeId is null && ambiguous) throw new ValidationException("text", $"More than one person matches @{parsed.OwnerToken}. Type more of the name.");
        if (req.AssigneeId is null && parsed.OwnerToken is not null && owner is null) throw new ValidationException("text", $"Nobody on this project matches @{parsed.OwnerToken}.");
        var session = await SessionAsync(m, req.OccurrenceStart, ct);
        var item = await actions.CreateAsync(pid, new CreateActionItemRequest(parsed.Title, null, req.AssigneeId ?? owner, req.DueDate ?? parsed.Due, null), ct);
        var marked = await actions.SetSourceAsync(pid, item.Id, m.Ref, m.SeriesRef, m.Title, session, ct);
        return new CapturedItemDto(marked, m.Ref, m.SeriesRef, session is { } s ? At(s) : null);
    }

    /// <summary>The session an item is captured in: the one asked for (it must be one of the meeting's), else the one going on or the last one.</summary>
    private async Task<DateTime?> SessionAsync(Meeting m, DateTimeOffset? asked, CancellationToken ct)
    {
        var changes = await MeetingSessions.ChangesAsync(db, [m.Id], ct);
        var list = changes.GetValueOrDefault(m.Id);
        if (asked is { } a)
        {
            var at = a.UtcDateTime;
            var hit = MeetingSessions.Expand(m.Rule, m.Start, m.End, m.Zone, list, at.AddDays(-32), at.AddDays(32)).FirstOrDefault(s => s.Original == at || s.Start == at);
            if (hit == default) throw new ValidationException("occurrenceStart", "That is not one of this meeting's sessions.");
            return hit.Original;
        }
        var now = clock.Now;
        return MeetingSessions.Previous(m.Rule, m.Start, m.End, m.Zone, list, now.AddMinutes(15))?.Original ?? m.Start;
    }

    /// <summary>The items made in this meeting (one session, or all of its sessions), and how many of the series' items are still open.</summary>
    public async Task<MeetingItemsDto> ItemsAsync(string meetingRef, DateTimeOffset? occurrence, CancellationToken ct = default)
    {
        var m = await LoadAsync(meetingRef, ct);
        var mref = m.Ref; var sref = m.SeriesRef;
        var q = db.WorkItems.AsNoTracking().Where(w => w.SourceMeetingRef == mref);
        if (occurrence is { } o) { var at = o.UtcDateTime; q = q.Where(w => w.SourceOccurrenceStartUtc == at); }
        var rows = await q.OrderByDescending(w => w.CreatedAt).Take(100).ToListAsync(ct);
        var people = rows.Where(r => r.AssigneeId != null).Select(r => r.AssigneeId!.Value).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => people.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        var openInSeries = await db.WorkTasks.AsNoTracking().CountAsync(w => w.SourceSeriesRef == sref && (w.Status == WorkTaskStatus.ToDo || w.Status == WorkTaskStatus.InProgress || w.Status == WorkTaskStatus.OnHold), ct);
        var (parts, changes) = await SeriesAsync(m, ct);
        var now = clock.Now;
        var next = SessionsOf(parts, changes, now, now + MeetingRecurrence.LongestSeries).Select(s => (MeetingSession?)s).FirstOrDefault();
        var previous = SessionsOf(parts, changes, now - MeetingRecurrence.LongestSeries, now).Select(s => (MeetingSession?)s).LastOrDefault();
        return new MeetingItemsDto(mref, sref, m.Title, MeetingRecurrence.Cadence(m.Rule), m.Rule is null ? "Once" : MeetingRecurrence.Describe(m.Rule, m.Start, m.Zone),
            next is { } n ? At(n.Start) : null, previous is { } pv ? At(pv.Start) : null,
            rows.Select(r =>
            {
                var (key, status, done) = r switch
                {
                    WorkTask w => (ProjectManagement.Application.Features.WorkItems.WorkItemService.KeyOf(w.Kind, w.Number),
                        w.Kind == WorkTaskKind.ActionItem ? ProjectManagement.Application.Features.WorkItems.WorkItemService.ActionLabel(w.Status) : ProjectManagement.Application.Features.WorkItems.WorkItemService.WorkLabel(w.Status),
                        w.Status is WorkTaskStatus.Completed or WorkTaskStatus.Cancelled),
                    _ => ($"#{r.Number}", r.CompletedAt is null ? "Open" : "Done", r.CompletedAt is not null),
                };
                return new MeetingItemRowDto(r.Id, key, r.Title, r.AssigneeId is { } a && names.TryGetValue(a, out var nm) ? new UserRefDto(a, nm) : null, r.DueDate, status,
                    !done && clock.IsPastDue(r.DueDate, r.DueTime), r.SourceOccurrenceStartUtc is { } so ? At(so) : null);
            }).ToList(), openInSeries, m.ProjectId, m.ProjectName);
    }

    private static string Duration(int minutes) => minutes % 60 == 0 ? $"{minutes / 60}h" : minutes < 60 ? $"{minutes}m" : $"{minutes / 60}h {minutes % 60}m";
    private static string Cut(string s, int max) => s.Length <= max ? s : s[..(max - 1)] + "…";
}
