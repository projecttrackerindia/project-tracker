using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.ProjectMeetings;

/// <summary>
/// One session of a meeting as the Meet page shows it. <c>Ref</c> is "p:{id}" (a project meeting) or "w:{id}" (a workspace meeting), the
/// same form the links in notifications and reminders use. <c>JoinUrl</c> is the Google Meet or Teams address, or the app path of a Project
/// Tracker call. <c>MyRsvp</c> is the person's own reply; for Google and Teams it is read back from their calendar, for our own calls it is
/// given here. <c>Notes</c>: the notetaker's state for this session (scheduled, in_call, done, failed) when it came.
/// </summary>
public record MeetItemDto(string Ref, string Kind, Guid Id, string Title, string? Description, DateTimeOffset Start, DateTimeOffset End, string TimeZone,
    Guid? ProjectId, string? ProjectName, string? ProjectKey, string Provider, string ProviderName, string JoinUrl, string? CalendarUrl,
    bool IsScrum, bool Recurring, int? SessionsLeft, string Notetaker, string MyRsvp, bool IsOrganizer, bool CanManage, string OrganizerName,
    int Invited, int Accepted, int Declined, string Status, string? Notes, bool Live,
    string? Cadence = null, string? Recurrence = null, DateTimeOffset? OriginalStart = null, string? Video = null, string? SeriesRef = null, string? Agenda = null);

public record MeetFeedDto(IReadOnlyList<MeetItemDto> Items, DateTimeOffset From, DateTimeOffset To, bool Truncated);

/// <summary>
/// The Meet page's lists, across every project the person can see and the workspace: the sessions in a time window (upcoming or past), and
/// the repeating series with their next session. Without a project: the meetings the person organizes or is invited to. With a project:
/// every meeting of that project they can see. Recurring meetings are expanded into their sessions, in the meeting's own zone.
/// </summary>
public class MeetFeedService(IAppDbContext db, ICurrentContext ctx, AppClock clock, ProjectAccess access, PermissionService permissions)
{
    private const int MaxItems = 400;
    private const int MaxMeetings = 600;

    private sealed record Row(string Kind, Guid Id, string Title, string? Description, DateTime StartUtc, DateTime EndUtc, string TimeZone, string? Rule,
        Guid? ProjectId, string? ProjectName, string? ProjectKey, MeetingProvider Provider, string Uri, string? CalendarUrl, bool IsScrum, MeetingNotetaker Notetaker,
        MeetingStatus Status, Guid OrganizerId, string OrganizerName, string MyRsvp, int Invited, int Accepted, int Declined,
        string? VideoKind = null, string? VideoLink = null, Guid? SeriesRootId = null);

    public async Task<MeetFeedDto> FeedAsync(DateTimeOffset? from, DateTimeOffset? to, Guid? projectId, CancellationToken ct = default)
    {
        var now = clock.Now;
        var start = (from ?? new DateTimeOffset(now.AddHours(-1), TimeSpan.Zero)).UtcDateTime;
        var end = (to ?? new DateTimeOffset(now.AddDays(30), TimeSpan.Zero)).UtcDateTime;
        if (end <= start) throw new ValidationException("to", "The end of the range must be after its start.");
        if (end - start > TimeSpan.FromDays(120)) throw new ValidationException("to", "Ask for at most 120 days at a time.");
        var rows = await RowsAsync(start, end, projectId, ct);
        var changes = await MeetingSessions.ChangesAsync(db, rows.Where(r => r.Rule is not null).Select(r => r.Id), ct);
        var items = new List<MeetItemDto>();
        foreach (var r in rows)
        {
            var length = r.EndUtc - r.StartUtc;
            if (length <= TimeSpan.Zero) length = TimeSpan.FromMinutes(30);
            // One-off changes ("this occurrence") are applied: a cancelled session is gone, a moved one is where it went.
            foreach (var s in MeetingSessions.Expand(r.Rule, r.StartUtc, r.EndUtc, r.TimeZone, changes.GetValueOrDefault(r.Id), start - TimeSpan.FromDays(1), end))
            {
                if (s.End <= start) continue;
                items.Add(Item(r, s.Start, s.End, null) with { OriginalStart = new DateTimeOffset(s.Original, TimeSpan.Zero), Title = s.Title ?? r.Title });
            }
        }
        var ordered = items.OrderBy(i => i.Start).ThenBy(i => i.Title).ToList();
        var truncated = ordered.Count > MaxItems;
        if (truncated) ordered = ordered.Take(MaxItems).ToList();
        return new MeetFeedDto(await DecorateAsync(ordered, ct), new DateTimeOffset(start, TimeSpan.Zero), new DateTimeOffset(end, TimeSpan.Zero), truncated);
    }

    /// <summary>Repeating meetings (stand-ups and series) that still have sessions to come, each with its next session and how many are left.</summary>
    public async Task<IReadOnlyList<MeetItemDto>> SeriesAsync(Guid? projectId, CancellationToken ct = default)
    {
        var now = clock.Now;
        var rows = (await RowsAsync(now.AddHours(-12), now.AddDays(1), projectId, ct, seriesOnly: true)).Where(r => r.Rule is not null).ToList();
        var changes = await MeetingSessions.ChangesAsync(db, rows.Select(r => r.Id), ct);
        var items = new List<MeetItemDto>();
        foreach (var r in rows)
        {
            var length = r.EndUtc - r.StartUtc;
            var left = MeetingSessions.Expand(r.Rule, r.StartUtc, r.EndUtc, r.TimeZone, changes.GetValueOrDefault(r.Id), now - length, now + MeetingRecurrence.LongestSeries).ToList();
            if (left.Count == 0) continue;
            items.Add(Item(r, left[0].Start, left[0].End, left.Count) with { OriginalStart = new DateTimeOffset(left[0].Original, TimeSpan.Zero) });
        }
        return await DecorateAsync(items.OrderBy(i => i.Start).ToList(), ct);
    }

    private async Task<List<Row>> RowsAsync(DateTime start, DateTime end, Guid? projectId, CancellationToken ct, bool seriesOnly = false)
    {
        var me = ctx.RequireUserId();
        var floor = start - MeetingRecurrence.LongestSeries;
        if (projectId is { } pid) await access.GetProjectAsync(pid, ct);   // 404 when it is not visible

        // Project meetings (the query filter already limits them to projects the person can see).
        var pq = db.ProjectMeetings.AsNoTracking().Where(m => m.Status == MeetingStatus.Scheduled && m.StartTimeUtc < end
            && (m.RecurrenceRule != null ? m.StartTimeUtc >= floor : !seriesOnly && m.EndTimeUtc > start));
        pq = projectId is { } p ? pq.Where(m => m.ProjectId == p) : pq.Where(m => m.OrganizerUserId == me || m.Participants.Any(x => x.UserId == me));
        var project = await pq.OrderBy(m => m.StartTimeUtc).Take(MaxMeetings).Select(m => new
        {
            m.Id, m.Title, m.Description, m.StartTimeUtc, m.EndTimeUtc, m.TimeZone, m.RecurrenceRule, m.ProjectId, ProjectName = m.Project!.Name, ProjectKey = m.Project.Key,
            m.Provider, m.GoogleMeetUri, m.CalendarUrl, m.IsScrum, m.Notetaker, m.Status, m.OrganizerUserId, Organizer = m.Organizer!.DisplayName, m.VideoKind, m.VideoLink, m.SeriesRootId,
            Mine = m.Participants.Where(x => x.UserId == me).Select(x => (AttendeeRsvpStatus?)x.RsvpStatus).FirstOrDefault(),
            Invited = m.Participants.Count(), Accepted = m.Participants.Count(x => x.RsvpStatus == AttendeeRsvpStatus.Accepted),
            Declined = m.Participants.Count(x => x.RsvpStatus == AttendeeRsvpStatus.Declined),
        }).ToListAsync(ct);
        var rows = project.Select(m => new Row("project", m.Id, m.Title, m.Description, m.StartTimeUtc, m.EndTimeUtc, m.TimeZone, m.RecurrenceRule, m.ProjectId, m.ProjectName, m.ProjectKey,
            m.Provider, m.GoogleMeetUri, m.CalendarUrl, m.IsScrum, m.Notetaker, m.Status, m.OrganizerUserId, m.Organizer,
            m.OrganizerUserId == me ? "Organizer" : (m.Mine ?? AttendeeRsvpStatus.NeedsAction).ToString(), m.Invited, m.Accepted, m.Declined, m.VideoKind, m.VideoLink, m.SeriesRootId)).ToList();

        // Workspace meetings (no project): the ones the person is invited to or organizes.
        if (projectId is null)
        {
            var wq = db.WorkspaceMeetings.AsNoTracking().Where(m => m.Status == MeetingStatus.Scheduled && m.StartTimeUtc < end
                && (m.RecurrenceRule != null ? m.StartTimeUtc >= floor : !seriesOnly && m.EndTimeUtc > start)
                && (m.OrganizerUserId == me || m.Attendees.Any(a => a.UserId == me)));
            var workspace = await wq.OrderBy(m => m.StartTimeUtc).Take(MaxMeetings).Select(m => new
            {
                m.Id, m.Title, m.Description, m.StartTimeUtc, m.EndTimeUtc, m.TimeZone, m.RecurrenceRule, m.Provider, m.GoogleMeetUri, m.CalendarUrl, m.IsScrum, m.Notetaker,
                m.Status, m.OrganizerUserId, Organizer = m.Organizer!.DisplayName, m.VideoKind, m.VideoLink, m.SeriesRootId,
                Mine = m.Attendees.Where(a => a.UserId == me).Select(a => (AttendeeRsvpStatus?)a.RsvpStatus).FirstOrDefault(),
                Invited = m.Attendees.Count(), Accepted = m.Attendees.Count(a => a.RsvpStatus == AttendeeRsvpStatus.Accepted),
                Declined = m.Attendees.Count(a => a.RsvpStatus == AttendeeRsvpStatus.Declined),
            }).ToListAsync(ct);
            rows.AddRange(workspace.Select(m => new Row("workspace", m.Id, m.Title, m.Description, m.StartTimeUtc, m.EndTimeUtc, m.TimeZone, m.RecurrenceRule, null, null, null,
                m.Provider, m.GoogleMeetUri, m.CalendarUrl, m.IsScrum, m.Notetaker, m.Status, m.OrganizerUserId, m.Organizer,
                m.OrganizerUserId == me ? "Organizer" : (m.Mine ?? AttendeeRsvpStatus.NeedsAction).ToString(), m.Invited, m.Accepted, m.Declined, m.VideoKind, m.VideoLink, m.SeriesRootId)));
        }
        return rows;
    }

    private MeetItemDto Item(Row r, DateTime at, DateTime until, int? left)
    {
        var workspace = r.Kind == "workspace";
        // A pasted Teams / Meet / Zoho address is where people join; "none" has no join link at all.
        var join = r.VideoKind == "none" ? "" : !string.IsNullOrEmpty(r.VideoLink) ? r.VideoLink : r.Provider == MeetingProvider.ProjectTracker ? MeetingCalendar.JoinPath(r.Id, workspace) : r.Uri;
        return new MeetItemDto($"{(workspace ? "w" : "p")}:{r.Id}", r.Kind, r.Id, r.Title, r.Description, new DateTimeOffset(at, TimeSpan.Zero), new DateTimeOffset(until, TimeSpan.Zero),
            r.TimeZone, r.ProjectId, r.ProjectName, r.ProjectKey, MeetingCalendar.Key(r.Provider), MeetingCalendar.Name(r.Provider), join, r.CalendarUrl,
            r.IsScrum, r.Rule is not null, left, MeetNotetaker.Key(r.Notetaker), r.MyRsvp, r.OrganizerId == ctx.UserId, false, r.OrganizerName,
            r.Invited, r.Accepted, r.Declined, r.Status.ToString(), null, false,
            MeetingRecurrence.Cadence(r.Rule), r.Rule is null ? "Once" : MeetingRecurrence.Describe(r.Rule, r.StartUtc, r.TimeZone), null,
            r.VideoKind ?? MeetingCalendar.Key(r.Provider), MeetingSessions.Ref(workspace, r.SeriesRootId ?? r.Id), r.Description);
    }

    /// <summary>Adds who may change each meeting, the notetaker's state for each session, and whether its call is going on now.</summary>
    private async Task<List<MeetItemDto>> DecorateAsync(List<MeetItemDto> items, CancellationToken ct)
    {
        if (items.Count == 0) return items;
        var ids = items.Select(i => i.Id).Distinct().ToList();
        var bots = await db.AgentMeetingBots.AsNoTracking().Where(b => ids.Contains(b.MeetingId) && b.Kind == "bot")
            .Select(b => new { b.MeetingId, b.SessionStartUtc, b.Status }).ToListAsync(ct);
        var live = (await db.CallRooms.AsNoTracking().Where(c => c.Status == "live" && (c.MeetingId != null && ids.Contains(c.MeetingId.Value) || c.WorkspaceMeetingId != null && ids.Contains(c.WorkspaceMeetingId.Value)))
            .Select(c => new { c.MeetingId, c.WorkspaceMeetingId }).ToListAsync(ct)).Select(c => c.MeetingId ?? c.WorkspaceMeetingId!.Value).ToHashSet();
        var canEditProjects = await permissions.HasAsync(Permissions.ProjectsEdit, ct);
        var admin = ctx.Role is TenantRole.Owner or TenantRole.Admin;
        var now = clock.Now;
        return items.Select(i =>
        {
            var bot = bots.Where(b => b.MeetingId == i.Id && Math.Abs((b.SessionStartUtc - i.Start.UtcDateTime).TotalMinutes) < 1).Select(b => b.Status).FirstOrDefault();
            var happening = live.Contains(i.Id) && i.Start.UtcDateTime <= now.AddMinutes(15) && i.End.UtcDateTime >= now.AddMinutes(-60);
            return i with { CanManage = i.IsOrganizer || (i.Kind == "project" ? canEditProjects : admin), Notes = bot, Live = happening };
        }).ToList();
    }
}
