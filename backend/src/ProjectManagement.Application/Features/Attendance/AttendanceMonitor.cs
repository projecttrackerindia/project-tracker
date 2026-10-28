using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Attendance;

/// <summary>
/// Attendance reminders, on each organization's own clock (its time zone and working hours):
/// <list type="bullet">
/// <item>start + grace: someone who has used the app today but not checked in gets "Good morning — check in?";</item>
/// <item>end + grace: someone still checked in gets "You're still checked in. Check out?";</item>
/// <item>end + the auto-close hours: a day still open is closed at the end time (marked auto-closed) and the person is told.</item>
/// </list>
/// Never on weekends (the workspace's working days), holidays or planned leave, and not during the person's quiet hours (the reminder waits
/// until they end). Each goes out once per person per day (de-duplication keys), however often the worker runs.
/// </summary>
public class AttendanceMonitor(IAppDbContext db, AppClock clock, NotificationRouter router, ILogger<AttendanceMonitor> log)
{
    private const int Batch = 5000;

    public async Task<int> RunAsync(CancellationToken ct = default)
    {
        var now = clock.Now;
        var tenants = await db.Tenants.IgnoreQueryFilters().AsNoTracking()
            .Where(t => t.Status == TenantStatus.Active && !t.IsDeleted && t.Type == WorkspaceType.Organization)
            .Select(t => new { t.Id, t.TimeZone }).ToListAsync(ct);
        if (tenants.Count == 0) return 0;
        var tids = tenants.Select(t => t.Id).ToList();
        var policies = await db.AttendancePolicies.IgnoreQueryFilters().AsNoTracking().Where(p => tids.Contains(p.TenantId)).ToDictionaryAsync(p => p.TenantId, ct);

        var notes = new List<Notification>();
        var closed = 0;
        foreach (var t in tenants)
        {
            var policy = policies.GetValueOrDefault(t.Id) ?? new AttendancePolicy { TenantId = t.Id };
            if (!policy.Enabled) continue;
            var zone = AttendanceService.ZoneOf(t.TimeZone, clock);
            var local = ZoneTime.ToLocal(now, zone);
            var today = DateOnly.FromDateTime(local);
            var time = TimeOnly.FromDateTime(local);
            var midnight = ZoneTime.ToUtc(ZoneTime.At(today, TimeOnly.MinValue), zone);

            var people = await (
                from m in db.TenantMembers.IgnoreQueryFilters()
                join u in db.Users on m.UserId equals u.Id
                where m.TenantId == t.Id && u.IsActive && m.Role != TenantRole.Guest
                select new { m.UserId, u.TimeZone }).Take(Batch).ToListAsync(ct);
            if (people.Count == 0) continue;
            var ids = people.Select(p => p.UserId).ToList();
            var own = await db.ReminderSettings.AsNoTracking().Where(s => ids.Contains(s.UserId)).ToDictionaryAsync(s => s.UserId, ct);
            var holiday = await db.Holidays.IgnoreQueryFilters().AsNoTracking().AnyAsync(h => h.TenantId == t.Id && h.Date == today, ct);
            var leave = (await db.PlannedLeaves.IgnoreQueryFilters().AsNoTracking().Where(l => l.TenantId == t.Id && l.WorkDate == today && !l.IsDeleted)
                .Select(l => l.UserId).ToListAsync(ct)).ToHashSet();
            var seen = (await db.UserSessions.AsNoTracking().Where(s => ids.Contains(s.UserId) && s.LastSeenAt >= midnight).Select(s => s.UserId).Distinct().ToListAsync(ct)).ToHashSet();
            var days = await db.AttendanceDays.IgnoreQueryFilters().Where(a => a.TenantId == t.Id && a.Date >= today.AddDays(-7) && a.Date <= today
                && (a.Date == today || a.CheckOutAt == null)).ToListAsync(ct);

            foreach (var p in people)
            {
                var hours = AttendanceHours.For(policy, policy.HoursSource == "personal" ? own.GetValueOrDefault(p.UserId) : null);
                var settings = own.GetValueOrDefault(p.UserId) ?? new ReminderSettings { UserId = p.UserId };
                var quiet = QuietHours.Until(settings, ZoneTime.IsKnown(p.TimeZone) ? ZoneTime.Find(p.TimeZone) : zone, now) is not null;
                var mine = days.Where(d => d.UserId == p.UserId).ToList();
                var todays = mine.FirstOrDefault(d => d.Date == today);

                // Days left open: closed at the day's end time once the auto-close hours have passed.
                foreach (var open in mine.Where(d => d.CheckOutAt is null))
                {
                    var endUtc = ZoneTime.ToUtc(ZoneTime.At(open.Date, hours.End), zone);
                    if (policy.AutoClose && now >= endUtc.AddHours(policy.AutoCloseAfterHours))
                    {
                        open.CheckOutAt = endUtc > open.CheckInAt ? endUtc : open.CheckInAt;
                        open.AutoClosed = true;
                        open.UpdatedAt = now;
                        closed++;
                        notes.Add(Note(t.Id, p.UserId, $"att-auto:{t.Id:N}:{p.UserId:N}:{open.Date:yyyyMMdd}", now,
                            $"We checked you out at {AttendanceService.Hm(hours.End)}",
                            $"You were still checked in on {open.Date:ddd d MMM}. Correct the time from the calendar if you left at another time.",
                            $"/?tab=calendar&attendance=day&date={open.Date:yyyy-MM-dd}"));
                    }
                    else if (open.Date == today && time >= hours.End.AddMinutes(policy.CheckOutGraceMinutes) && hours.End.AddMinutes(policy.CheckOutGraceMinutes) > hours.End && !quiet)
                        notes.Add(Note(t.Id, p.UserId, $"att-out:{t.Id:N}:{p.UserId:N}:{today:yyyyMMdd}", now,
                            "You're still checked in. Check out?", "Check out to close your day, or ignore this if you are still working.",
                            "/?tab=calendar&attendance=checkout"));
                }

                // Not checked in yet on a working day, though they have been using the app today.
                if (todays is null && hours.IsWorkingDay(today) && !holiday && !leave.Contains(p.UserId) && seen.Contains(p.UserId) && !quiet
                    && time >= hours.Start.AddMinutes(policy.CheckInGraceMinutes) && time < hours.End && hours.Start.AddMinutes(policy.CheckInGraceMinutes) > hours.Start)
                    notes.Add(Note(t.Id, p.UserId, $"att-in:{t.Id:N}:{p.UserId:N}:{today:yyyyMMdd}", now,
                        "Good morning — check in?", "Say where you are working today: office, home or a client's office.", "/?tab=calendar&attendance=checkin"));
            }
        }

        var added = 0;
        if (notes.Count > 0)
        {
            var keys = notes.Select(n => n.DedupeKey!).ToList();
            var sent = (await db.Notifications.IgnoreQueryFilters().Where(n => n.DedupeKey != null && keys.Contains(n.DedupeKey)).Select(n => n.DedupeKey!).ToListAsync(ct)).ToHashSet();
            await router.PreloadAsync(notes.Select(n => n.UserId), ct);
            foreach (var n in notes)
            {
                if (!sent.Add(n.DedupeKey!)) continue;
                if (await router.ApplyAsync(n, ct)) { db.Notifications.Add(n); added++; }
            }
        }
        if (added > 0 || closed > 0) await db.SaveChangesAsync(ct);
        if (added > 0 || closed > 0) log.LogInformation("Attendance: {Notes} reminders, {Closed} days closed", added, closed);
        return added;
    }

    private static Notification Note(Guid tenantId, Guid userId, string key, DateTime now, string title, string body, string link) => new()
    {
        TenantId = tenantId, UserId = userId, Type = NotificationType.Reminder, CreatedAt = now, DedupeKey = key, Title = title, Body = body, Link = link,
    };
}
