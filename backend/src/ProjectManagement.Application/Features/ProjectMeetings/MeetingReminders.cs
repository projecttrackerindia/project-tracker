using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.ProjectMeetings;

/// <summary>
/// Every meeting someone is invited to becomes a reminder in their Reminders list, one per session: it goes off ten minutes before and
/// opens the meeting (a Project Tracker call opens the call itself). The organizer and everyone who has not declined get one; replying "no",
/// moving the meeting or cancelling it takes the waiting reminder back (and makes the right one). This is the one "starts soon" signal: the
/// notice, the e-mail or push and the line in Reminders are the same reminder.
/// <para>The key "meet:{meeting}:{user}:{session start, yyyyMMddHHmm}" identifies each reminder, so planning again never doubles one and a
/// reminder someone dismissed is not brought back.</para>
/// </summary>
public static class MeetingReminders
{
    /// <summary>How long before a session its reminder goes off.</summary>
    public static readonly TimeSpan Ahead = TimeSpan.FromMinutes(10);
    /// <summary>How far ahead sessions are planned. Re-planned every few minutes, so this only has to cover the gap between runs.</summary>
    private static readonly TimeSpan Horizon = TimeSpan.FromDays(2);
    private const int Batch = 500;

    public static string Key(Guid meetingId, Guid userId, DateTime sessionUtc) => $"meet:{meetingId:N}:{userId:N}:{sessionUtc:yyyyMMddHHmm}";

    private sealed record Session(Guid TenantId, Guid MeetingId, bool Workspace, Guid? ProjectId, string Title, string ProjectKey, MeetingProvider Provider,
        string TimeZone, DateTime Start, IReadOnlyList<Guid> People);

    /// <summary>
    /// Plans the reminders for the sessions starting in the next two days, across every workspace (the reminder engine's planning step), or
    /// for one meeting only (right after it was created, moved, answered or cancelled, so nobody waits for the next run).
    /// </summary>
    public static async Task<int> PlanAsync(IAppDbContext db, DateTime now, CancellationToken ct, Guid? onlyMeeting = null)
    {
        var to = now + Horizon;
        var floor = now - MeetingRecurrence.LongestSeries;
        var sessions = new List<Session>();

        var projectQ = db.ProjectMeetings.IgnoreQueryFilters().AsNoTracking()
            .Where(m => m.Status == MeetingStatus.Scheduled && m.CancelledAt == null && m.StartTimeUtc < to && (m.RecurrenceRule != null ? m.StartTimeUtc >= floor : m.StartTimeUtc > now - Ahead)
                && db.Projects.IgnoreQueryFilters().Any(p => p.Id == m.ProjectId && !p.IsDeleted)
                && db.Tenants.IgnoreQueryFilters().Any(t => t.Id == m.TenantId && !t.IsDeleted && t.Status == TenantStatus.Active));
        if (onlyMeeting is { } pm) projectQ = projectQ.Where(m => m.Id == pm);
        var projectRows = await projectQ.OrderBy(m => m.StartTimeUtc).Take(Batch)
            .Select(m => new { m.TenantId, m.Id, m.ProjectId, m.Title, Key = m.Project!.Key, m.Provider, m.TimeZone, m.StartTimeUtc, m.RecurrenceRule, m.OrganizerUserId,
                People = m.Participants.Where(p => p.UserId != null && p.RsvpStatus != AttendeeRsvpStatus.Declined).Select(p => p.UserId!.Value).ToList() })
            .ToListAsync(ct);
        foreach (var m in projectRows)
            foreach (var at in MeetingRecurrence.Occurrences(m.RecurrenceRule, m.StartTimeUtc, m.TimeZone, now, to))
                sessions.Add(new(m.TenantId, m.Id, false, m.ProjectId, m.Title, m.Key, m.Provider, m.TimeZone, at, m.People.Append(m.OrganizerUserId).Distinct().ToList()));

        var workspaceQ = db.WorkspaceMeetings.IgnoreQueryFilters().AsNoTracking()
            .Where(m => m.Status == MeetingStatus.Scheduled && m.CancelledAt == null && m.StartTimeUtc < to && (m.RecurrenceRule != null ? m.StartTimeUtc >= floor : m.StartTimeUtc > now - Ahead)
                && db.Tenants.IgnoreQueryFilters().Any(t => t.Id == m.TenantId && !t.IsDeleted && t.Status == TenantStatus.Active));
        if (onlyMeeting is { } wm) workspaceQ = workspaceQ.Where(m => m.Id == wm);
        var workspaceRows = await workspaceQ.OrderBy(m => m.StartTimeUtc).Take(Batch)
            .Select(m => new { m.TenantId, m.Id, m.Title, m.Provider, m.TimeZone, m.StartTimeUtc, m.RecurrenceRule, m.OrganizerUserId,
                People = m.Attendees.Where(a => a.RsvpStatus != AttendeeRsvpStatus.Declined).Select(a => a.UserId).ToList() })
            .ToListAsync(ct);
        foreach (var m in workspaceRows)
            foreach (var at in MeetingRecurrence.Occurrences(m.RecurrenceRule, m.StartTimeUtc, m.TimeZone, now, to))
                sessions.Add(new(m.TenantId, m.Id, true, null, m.Title, "", m.Provider, m.TimeZone, at, m.People.Append(m.OrganizerUserId).Distinct().ToList()));

        // Wanted: one per person per session still to come (a session starting in under ten minutes still gets one, at once).
        var wanted = new Dictionary<string, (Session S, Guid User)>();
        foreach (var s in sessions)
            foreach (var u in s.People)
                wanted[Key(s.MeetingId, u, s.Start)] = (s, u);

        var keys = wanted.Keys.ToList();
        var existing = new HashSet<string>();
        foreach (var chunk in keys.Chunk(400))
        {
            var list = chunk.ToList();
            existing.UnionWith(await db.Reminders.IgnoreQueryFilters().Where(r => r.SystemKey != null && list.Contains(r.SystemKey)).Select(r => r.SystemKey!).ToListAsync(ct));
        }
        var added = new List<Reminder>();
        foreach (var (key, (s, user)) in wanted.Where(w => !existing.Contains(w.Key)))
        {
            var fire = s.Start - Ahead < now ? now : s.Start - Ahead;
            var tz = ZoneTime.Find(s.TimeZone);
            var time = ZoneTime.ToLocal(s.Start, tz);
            var reminder = new Reminder
            {
                TenantId = s.TenantId, UserId = user, Source = ReminderSource.Meeting,
                Title = Cut($"Starts in {(int)Math.Max(1, Math.Round((s.Start - fire).TotalMinutes))} minutes: {s.Title}", 200),
                Note = $"{time:h:mm tt} ({s.TimeZone}) · {MeetingCalendar.Name(s.Provider)}",
                TargetType = ReminderTarget.Meeting, TargetId = s.MeetingId, TargetKey = s.Workspace ? "Meeting" : Cut($"{s.ProjectKey} meeting", 40), TargetTitle = Cut(s.Title, 200),
                TargetProjectId = s.ProjectId, Link = Link(s.MeetingId, s.Workspace, s.Provider),
                TimeZone = s.TimeZone, LocalAt = ZoneTime.Write(ZoneTime.ToLocal(fire, tz)), OnlyIfOpen = true, Exact = true, NextFireAt = fire, SystemKey = key, CreatedAt = now,
            };
            db.Reminders.Add(reminder);
            added.Add(reminder);
        }
        var created = added.Count;
        if (created > 0)
        {
            try { await db.SaveChangesAsync(ct); }
            catch (DbUpdateException)
            {
                // Another server planned the same sessions at the same moment: its rows stand, ours are dropped.
                foreach (var r in added) db.Reminders.Entry(r).State = EntityState.Detached;
                created = 0;
            }
        }

        // Taken back: waiting meeting reminders no session asks for any more (declined, moved, cancelled, someone removed). Only the ones in the
        // window planned above: a reminder for a session further ahead was made by an earlier plan and is checked when its time comes closer.
        var waitingQ = db.Reminders.IgnoreQueryFilters().Where(r => r.Source == ReminderSource.Meeting && r.State == ReminderState.Scheduled && r.SystemKey != null);
        if (onlyMeeting is { } one) waitingQ = waitingQ.Where(r => r.TargetId == one);
        var waiting = await waitingQ.Select(r => new { r.Id, r.SystemKey }).Take(5000).ToListAsync(ct);
        var stale = waiting.Where(r => !wanted.ContainsKey(r.SystemKey!)).Select(r => r.Id).ToList();
        foreach (var chunk in stale.Chunk(400))
        {
            var ids = chunk.ToList();
            await db.Reminders.IgnoreQueryFilters().Where(r => ids.Contains(r.Id) && r.State == ReminderState.Scheduled).ExecuteDeleteAsync(ct);
        }
        return created;
    }

    /// <summary>Where a meeting opens: a Project Tracker call straight into the call, the others on the Meet page with their join link.</summary>
    public static string Link(Guid meetingId, bool workspace, MeetingProvider provider) =>
        provider == MeetingProvider.ProjectTracker ? MeetingCalendar.JoinPath(meetingId, workspace) : MeetLink(meetingId, workspace);

    /// <summary>The meeting on the Meet page (the one place meetings are kept).</summary>
    public static string MeetLink(Guid meetingId, bool workspace) => $"/meet?open={(workspace ? "w" : "p")}:{meetingId}";

    private static string Cut(string s, int max) => s.Length <= max ? s : s[..(max - 1)] + "…";
}
