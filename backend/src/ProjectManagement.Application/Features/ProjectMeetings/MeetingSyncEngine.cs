using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Integrations;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.ProjectMeetings;

/// <summary>
/// Background RSVP synchronization (spec section 19). MeetingService already syncs a meeting's RSVP state whenever someone opens it
/// (Get/List), which covers the common case; this exists for the rest - a meeting nobody has reopened since an attendee responded still
/// shows a stale "needs action" until something looks again. Runs across every active tenant, in one batch, on a slow interval: RSVP status
/// is not urgent, and polling Google more aggressively than that would be exactly what the spec warns against.
/// </summary>
public class MeetingSyncEngine(IAppDbContext db, AppClock clock, GoogleMeetingClient google, ILogger<MeetingSyncEngine> log)
{
    private const int Batch = 200;

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
            IReadOnlyList<GoogleAttendeeStatus> statuses;
            try { statuses = await google.GetAttendeeStatusAsync(m.OrganizerUserId, m.GoogleCalendarEventId, ct); }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // One organizer's expired connection, or one flaky call, must never stop the rest of the batch from syncing.
                log.LogWarning(ex, "RSVP sync failed for meeting {MeetingId}", m.Id);
                continue;
            }
            if (statuses.Count == 0) continue;
            var byEmail = statuses.ToDictionary(s => s.Email, s => s.ResponseStatus, StringComparer.OrdinalIgnoreCase);
            foreach (var p in m.Participants)
            {
                if (p.Role == MeetingParticipantRole.Organizer || !byEmail.TryGetValue(p.Email, out var status)) continue;
                var mapped = status switch { "accepted" => AttendeeRsvpStatus.Accepted, "declined" => AttendeeRsvpStatus.Declined, "tentative" => AttendeeRsvpStatus.Tentative, _ => AttendeeRsvpStatus.NeedsAction };
                if (p.RsvpStatus != mapped) { p.RsvpStatus = mapped; changed++; }
            }
        }
        if (changed > 0) await db.SaveChangesAsync(ct);
        return changed;
    }
}
