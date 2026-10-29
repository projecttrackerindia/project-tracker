using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Reminders;

/// <summary>
/// The rules that keep due-date reminders sensible: one planned after its time has passed goes off at the next sensible moment (never
/// straight away), a due-day reminder is skipped when the person plainly already knows (they set the date themselves after the reminder
/// time, or worked on the item in the last two hours), and every reminder says in a few words why it came.
/// </summary>
public static class DueReminderRules
{
    /// <summary>How soon after planning a late reminder may go off, at the earliest.</summary>
    public static readonly TimeSpan MinLead = TimeSpan.FromMinutes(30);
    /// <summary>A due-day reminder planned late goes off no earlier than this long before the end of the working day.</summary>
    public static readonly TimeSpan BeforeShiftEnd = TimeSpan.FromHours(2);
    /// <summary>Work on the item this recently means the person knows it is due: the due-day reminder is skipped.</summary>
    public static readonly TimeSpan RecentWork = TimeSpan.FromHours(2);
    /// <summary>The first line of a reminder notification's body that carries its reason (split out again for the notification centre).</summary>
    public const string ReasonPrefix = "Why: ";

    /// <summary>
    /// When a reminder whose planned (local) time has already passed should go off instead, in the person's own clock: not sooner than 30
    /// minutes from <paramref name="nowLocal"/>, rounded up to the quarter hour (so due-today reminders of one slot go out together), at a
    /// good time (working hours, outside quiet hours). A due-date reminder also waits until two hours before the end of the working day it was
    /// planned for (<paramref name="day"/>, the due day itself by default) and must still fall on that day - otherwise null: it is not sent at all (the overdue follow-up takes over the next working day).
    /// </summary>
    public static DateTime? LateSlot(DateTime nowLocal, WorkCalendar cal, ReminderSource source, DateOnly day)
    {
        var at = QuarterUp(nowLocal + MinLead);
        if (source == ReminderSource.DueDate)
        {
            var shiftEnd = ZoneTime.At(day, cal.Settings.WorkEnd);
            if (at < shiftEnd - BeforeShiftEnd) at = shiftEnd - BeforeShiftEnd;
            at = cal.NextGoodTime(at);
            return DateOnly.FromDateTime(at) == day && at < shiftEnd ? at : null;
        }
        return cal.NextGoodTime(at);
    }

    public static DateTime QuarterUp(DateTime t)
    {
        var q = TimeSpan.FromMinutes(15).Ticks;
        var rem = t.Ticks % q;
        return rem == 0 ? t : new DateTime(t.Ticks - rem + q, t.Kind);
    }

    /// <summary>
    /// Whether the person worked on (or changed) the item at or after <paramref name="sinceUtc"/>: logged time on it, commented, changed its
    /// status or any field (the item's own last change, or its activity), or created it. One small query per source, for one item.
    /// </summary>
    public static async Task<bool> TouchedAsync(IAppDbContext db, ReminderTarget type, Guid itemId, Guid userId, DateTime sinceUtc, CancellationToken ct)
    {
        if (await db.Activities.IgnoreQueryFilters().AnyAsync(a => a.EntityId == itemId && a.ActorId == userId && a.CreatedAt >= sinceUtc, ct)) return true;
        if (await db.TimeEntries.IgnoreQueryFilters().AnyAsync(e => (e.TaskId == itemId || e.WorkTaskId == itemId) && e.UserId == userId
                && (e.CreatedAt >= sinceUtc || e.UpdatedAt >= sinceUtc || e.EndedAt >= sinceUtc || (e.StartedAt != null && e.EndedAt == null)), ct)) return true;
        switch (type)
        {
            case ReminderTarget.Task:
                return await db.TaskComments.IgnoreQueryFilters().AnyAsync(c => c.TaskId == itemId && c.AuthorId == userId && c.CreatedAt >= sinceUtc, ct)
                    || await db.Tasks.IgnoreQueryFilters().AnyAsync(t => t.Id == itemId && ((t.UpdatedBy == userId && t.UpdatedAt >= sinceUtc) || (t.CreatedBy == userId && t.CreatedAt >= sinceUtc)), ct);
            case ReminderTarget.ActionItem or ReminderTarget.Operational:
                return await db.WorkTaskComments.IgnoreQueryFilters().AnyAsync(c => c.WorkTaskId == itemId && c.AuthorId == userId && c.CreatedAt >= sinceUtc, ct)
                    || await db.WorkTasks.IgnoreQueryFilters().AnyAsync(w => w.Id == itemId && ((w.UpdatedBy == userId && w.UpdatedAt >= sinceUtc) || (w.CreatedBy == userId && w.CreatedAt >= sinceUtc)), ct);
            case ReminderTarget.Issue:
                return await db.StageIssues.IgnoreQueryFilters().AnyAsync(i => i.Id == itemId && ((i.UpdatedBy == userId && i.UpdatedAt >= sinceUtc) || (i.CreatedBy == userId && i.CreatedAt >= sinceUtc)), ct);
            case ReminderTarget.Milestone:
                return await db.Milestones.IgnoreQueryFilters().AnyAsync(m => m.Id == itemId && ((m.UpdatedBy == userId && m.UpdatedAt >= sinceUtc) || (m.CreatedBy == userId && m.CreatedAt >= sinceUtc)), ct);
            default:
                return false;
        }
    }

    /// <summary>
    /// From when the person's own work on the item makes the due-day reminder pointless: the last two hours; or, when the reminder was only
    /// planned after its time had passed (the due date became that day after the reminder time), everything since that time - so setting the
    /// date yourself at 10:28 never earns you "due today" at 10:30.
    /// </summary>
    public static DateTime KnowsSince(Reminder r, DateTime nowUtc)
    {
        var recent = nowUtc - RecentWork;
        if (r.LocalAt is { } text && ZoneTime.TryParseLocal(text, out var local))
        {
            var slot = ZoneTime.ToUtc(local, ZoneTime.Find(r.TimeZone));
            if (r.CreatedAt > slot && slot < recent) return slot;
        }
        return recent;
    }

    /// <summary>"Due today · no time set", "Due tomorrow", "Was due Mon 26 Oct", "You set this for 15:30": why a reminder came, in a few words.</summary>
    public static string Reason(Reminder r, DateOnly? due, DateOnly today, string? from = null)
    {
        static string Day(DateOnly d) => d.ToString("ddd d MMM", System.Globalization.CultureInfo.InvariantCulture);
        switch (r.Source)
        {
            case ReminderSource.DueDate when due is { } d:
                return d == today ? "Due today · no time set" : d == today.AddDays(1) ? "Due tomorrow" : $"Due {Day(d)}";
            case ReminderSource.Overdue when due is { } d:
                return $"Overdue · was due {Day(d)}";
            case ReminderSource.Escalation when due is { } d:
                return $"Escalation · {Math.Max(0, today.DayNumber - d.DayNumber)} days overdue";
            case ReminderSource.Nudge:
                return from is null ? "Someone asked to remind you" : $"{from} asked to remind you";
            case ReminderSource.Meeting:
                return "Meeting coming up";
            case ReminderSource.Personal:
                if (r.Recurrence is not null) return "Your repeating reminder";
                return r.LocalAt is { } t && ZoneTime.TryParseLocal(t, out var at) ? $"You set this for {at:HH:mm}" : "You set this reminder";
            default:
                return r.Source == ReminderSource.DueDate ? "Due date reminder" : "Reminder";
        }
    }

    /// <summary>The body with its reason as the first line ("Why: Due today · no time set").</summary>
    public static string WithReason(string reason, string? body) => string.IsNullOrWhiteSpace(body) ? ReasonPrefix + reason : $"{ReasonPrefix}{reason}\n{body}";

    /// <summary>The reason line split off a notification body again (null when it has none).</summary>
    public static (string? Reason, string? Body) SplitReason(string? body)
    {
        if (body is null || !body.StartsWith(ReasonPrefix, StringComparison.Ordinal)) return (null, body);
        var nl = body.IndexOf('\n');
        return nl < 0 ? (body[ReasonPrefix.Length..], null) : (body[ReasonPrefix.Length..nl], body[(nl + 1)..]);
    }
}
