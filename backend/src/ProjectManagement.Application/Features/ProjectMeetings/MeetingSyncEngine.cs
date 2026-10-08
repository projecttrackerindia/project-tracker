using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Integrations;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.ProjectMeetings;

/// <summary>
/// Two background jobs on the same slow interval, so a meeting nobody has reopened recently still stays current (spec sections 5, 7 and
/// 19): RSVP synchronization (MeetingService already syncs on every Get/List, which covers the common case - this is for the rest), and
/// the "meeting starts soon" notice. Runs across every active tenant, in one batch, deliberately slow: neither RSVP status nor a
/// starts-soon notice is urgent enough to justify polling Google harder, and reusing this one worker rather than adding a second
/// scheduler is itself part of the point.
/// </summary>
public class MeetingSyncEngine(IAppDbContext db, AppClock clock, GoogleMeetingClient google, Recorder recorder, NotificationRouter router, ILogger<MeetingSyncEngine> log)
{
    private const int Batch = 200;
    /// <summary>How far ahead "starts soon" looks. Wider than the worker's own interval on purpose, so the notice still lands once even if
    /// a tick lands a little early or late - DedupeKey (not exact timing) is what stops it firing twice.</summary>
    private static readonly TimeSpan StartsSoonWindow = TimeSpan.FromMinutes(20);

    public async Task<int> RunAsync(CancellationToken ct = default)
    {
        var now = clock.Now;
        // A meeting matters here from shortly before it starts until a couple of hours after it ends (attendees often reply late), and not
        // further out than two weeks (nothing is lost - MeetingService syncs it anyway the moment anyone actually opens it).
        var meetings = await db.ProjectMeetings.IgnoreQueryFilters()
            .Where(m => m.Status == MeetingStatus.Scheduled && m.EndTimeUtc >= now.AddHours(-2) && m.StartTimeUtc <= now.AddDays(14)
                        && db.Tenants.IgnoreQueryFilters().Any(t => t.Id == m.TenantId && t.Status == TenantStatus.Active))
            .Include(m => m.Participants)
            .OrderBy(m => m.StartTimeUtc).Take(Batch).ToListAsync(ct);
        if (meetings.Count == 0) return 0;

        var changed = 0;
        foreach (var m in meetings)
        {
            changed += await SyncRsvpAsync(m, ct);
            if (m.StartTimeUtc > now && m.StartTimeUtc <= now.Add(StartsSoonWindow)) await NotifyStartsSoonAsync(m, ct);
        }
        await db.SaveChangesAsync(ct);
        return changed;
    }

    private async Task<int> SyncRsvpAsync(ProjectMeeting m, CancellationToken ct)
    {
        IReadOnlyList<GoogleAttendeeStatus> statuses;
        try { statuses = await google.GetAttendeeStatusAsync(m.OrganizerUserId, m.GoogleCalendarEventId, ct); }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // One organizer's expired connection, or one flaky call, must never stop the rest of the batch from syncing.
            log.LogWarning(ex, "RSVP sync failed for meeting {MeetingId}", m.Id);
            return 0;
        }
        if (statuses.Count == 0) return 0;
        var byEmail = statuses.ToDictionary(s => s.Email, s => s.ResponseStatus, StringComparer.OrdinalIgnoreCase);
        var changed = 0;
        foreach (var p in m.Participants)
        {
            if (p.Role == MeetingParticipantRole.Organizer || !byEmail.TryGetValue(p.Email, out var status)) continue;
            var mapped = status switch { "accepted" => AttendeeRsvpStatus.Accepted, "declined" => AttendeeRsvpStatus.Declined, "tentative" => AttendeeRsvpStatus.Tentative, _ => AttendeeRsvpStatus.NeedsAction };
            if (p.RsvpStatus == mapped) continue;
            var old = p.RsvpStatus;
            p.RsvpStatus = mapped;
            changed++;
            // Low volume by construction (only when the status actually moved, never once per poll), so this is worth a real audit entry,
            // not just noise - GOOGLE_MEET_RSVP_UPDATED is one of the events the spec explicitly asks to be traceable.
            recorder.Audit("meeting.rsvp_updated", "ProjectMeeting", m.Id, oldValue: new { Rsvp = old.ToString(), p.Email }, newValue: new { Rsvp = mapped.ToString(), p.Email }, tenantId: m.TenantId, userId: p.UserId);
        }
        return changed;
    }

    private async Task NotifyStartsSoonAsync(ProjectMeeting m, CancellationToken ct)
    {
        var key = $"meeting-soon:{m.Id:N}";
        if (await db.Notifications.IgnoreQueryFilters().AnyAsync(n => n.DedupeKey == key, ct)) return;
        var minutes = Math.Max(1, (int)Math.Round((m.StartTimeUtc - clock.Now).TotalMinutes));
        foreach (var p in m.Participants)
        {
            if (p.UserId is not { } uid) continue;
            var n = new Notification
            {
                TenantId = m.TenantId, UserId = uid, Type = NotificationType.Meeting, CreatedAt = clock.Now,
                Title = $"Meeting starts in {minutes} minute{(minutes == 1 ? "" : "s")}", Body = m.Title, Link = $"/projects/{m.ProjectId}?tab=meetings&meeting={m.Id}", DedupeKey = key,
            };
            if (await router.ApplyAsync(n, ct)) db.Notifications.Add(n);
        }
    }
}
