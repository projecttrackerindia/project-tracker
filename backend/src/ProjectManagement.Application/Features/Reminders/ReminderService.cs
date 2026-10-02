using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.Work;
using ProjectManagement.Application.Features.WorkItems;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Reminders;

public record ReminderDto(Guid Id, ReminderSource Source, ReminderState State, string Title, string? Note,
    ReminderTarget TargetType, Guid? TargetId, string? TargetKey, string? TargetTitle, string? Link,
    string TimeZone, string? LocalAt, int? AnchorDays, string? AnchorTime, string? Recurrence, string? RecurrenceText,
    bool OnlyIfOpen, bool Exact, DateTime? NextFireAt, bool IsSnoozed, int SnoozeCount, int FireCount, DateTime? LastFiredAt, bool Quiet,
    DateTime? CompletedAt, Guid? SeriesId, UserRefDto? From, UserRefDto? For, bool CanEdit, DateTime CreatedAt);

public record ReminderCountsDto(int Now, int Today, int Upcoming, int Completed);
public record ReminderLimitsDto(long Open, long Recurring, int OpenUsed, int RecurringUsed);
public record ReminderListDto(IReadOnlyList<ReminderDto> Open, IReadOnlyList<ReminderDto> Completed, IReadOnlyList<ReminderDto> Sent, ReminderCountsDto Counts, ReminderLimitsDto Limits);

/// <summary>When: <see cref="At"/> ("yyyy-MM-ddTHH:mm") in <see cref="TimeZone"/>; or <see cref="AnchorDays"/> from the work's due date at <see cref="AnchorTime"/>;
/// a <see cref="Recurrence"/> repeats from <see cref="At"/>.</summary>
public record ReminderWhen(string? At, string? TimeZone, int? AnchorDays, string? AnchorTime, string? Recurrence);
public record SaveReminderRequest(string? Title, string? Note, ReminderTarget TargetType, Guid? TargetId, Guid? ForUserId, ReminderWhen? When, bool? OnlyIfOpen, bool? Exact);
public record SnoozeRequest(string? Preset, string? Until, string? TimeZone);
public record TimeZoneRequest(string? TimeZone);

public record ReminderSettingsDto(int[] WorkDays, string WorkStart, string WorkEnd, string? QuietStart, string? QuietEnd, string DefaultTime,
    bool AutoEnabled, int[] DueLeads, int[] OverdueSteps, int DailyAutoLimit, bool BriefingEnabled, string BriefingTime,
    bool FollowDeviceTimeZone, bool MuteNudges, string TimeZone);
public record ReminderInsightsDto(int DoneThisWeek, int FiredThisWeek, int OnTimePercent, string? UsualTime, IReadOnlyList<ReminderDto> SnoozedOften);
public record ReminderPolicyDto(bool Available, bool CanManage, bool EscalationEnabled, string Steps, int SentLast30Days, int DoneLast30Days, int EscalatedLast30Days);
public record SavePolicyRequest(bool EscalationEnabled, string? Steps);
public record ReminderActionInfoDto(bool Valid, string? Title, string? Note, string? TargetKey, string? Link, ReminderState? State, DateTime? NextFireAt, bool IsSnoozed, string? TimeZone, string? Workspace);
public record ReminderActionRequest(string? Action, string? Preset);

/// <summary>What a reminder points at, read with the caller's own access.</summary>
public record ReminderTargetInfo(ReminderTarget Type, Guid Id, string Key, string Title, Guid? ProjectId, string Link, DateOnly? Due, Guid? AssigneeId, bool Open);

/// <summary>
/// Reminders as people use them: set one about anything they can see (or a plain note), for themselves or - within limits - for someone
/// else; see what is coming and what needs them now; snooze, finish, restore. The scheduler (<see cref="ReminderEngine"/>) does the firing.
/// </summary>
public class ReminderService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, EntitlementService entitlements,
    PermissionService permissions, ProjectAccess access)
{
    public const int FreeOpenLimit = 50, FreeRecurringLimit = 5;
    private static readonly ReminderSource[] Automatic = [ReminderSource.DueDate, ReminderSource.Overdue, ReminderSource.Escalation];

    // ------------------------------------------------------------------ reading

    public async Task<ReminderListDto> ListAsync(CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var since = clock.Now.AddDays(-30);
        var open = await db.Reminders.AsNoTracking().Where(r => r.UserId == uid && (r.State == ReminderState.Scheduled || r.State == ReminderState.Fired))
            .OrderBy(r => r.NextFireAt == null ? 0 : 1).ThenBy(r => r.NextFireAt).Take(500).ToListAsync(ct);
        var done = await db.Reminders.AsNoTracking().Where(r => r.UserId == uid && r.State == ReminderState.Done && r.CompletedAt >= since)
            .OrderByDescending(r => r.CompletedAt).Take(200).ToListAsync(ct);
        var sent = await db.Reminders.AsNoTracking().Where(r => r.CreatedBy == uid && r.UserId != uid && r.Source == ReminderSource.Nudge
                && (r.State == ReminderState.Scheduled || r.State == ReminderState.Fired || r.CompletedAt >= since))
            .OrderByDescending(r => r.CreatedAt).Take(100).ToListAsync(ct);
        var names = await NamesAsync(open.Concat(done).Concat(sent), ct);
        var counts = Counts(open, done.Count, Zone(await UserZoneAsync(uid, ct)));
        return new ReminderListDto(open.Select(r => Dto(r, names)).ToList(), done.Select(r => Dto(r, names)).ToList(), sent.Select(r => Dto(r, names)).ToList(),
            counts, await LimitsAsync(uid, ct));
    }

    public async Task<ReminderCountsDto> CountsAsync(CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var open = await db.Reminders.AsNoTracking().Where(r => r.UserId == uid && (r.State == ReminderState.Scheduled || r.State == ReminderState.Fired))
            .Select(r => new Reminder { State = r.State, NextFireAt = r.NextFireAt }).ToListAsync(ct);
        return Counts(open, 0, Zone(await UserZoneAsync(uid, ct)));
    }

    /// <summary>Now: went off and waits for the person. Today: still to come before the end of the person's own day.</summary>
    private ReminderCountsDto Counts(IReadOnlyCollection<Reminder> open, int completed, NodaTime.DateTimeZone tz)
    {
        var now = clock.Now;
        var endOfDay = ZoneTime.ToUtc(ZoneTime.At(DateOnly.FromDateTime(ZoneTime.ToLocal(now, tz)).AddDays(1), TimeOnly.MinValue), tz);
        return new ReminderCountsDto(open.Count(r => r.State == ReminderState.Fired), open.Count(r => r.State == ReminderState.Scheduled && r.NextFireAt < endOfDay),
            open.Count(r => r.State == ReminderState.Scheduled), completed);
    }

    /// <summary>The caller's open reminders about one piece of work (for the "Remind me" button on it).</summary>
    public async Task<IReadOnlyList<ReminderDto>> ForTargetAsync(ReminderTarget type, Guid id, CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var rows = await db.Reminders.AsNoTracking().Where(r => r.UserId == uid && r.TargetType == type && r.TargetId == id
            && (r.State == ReminderState.Scheduled || r.State == ReminderState.Fired)).OrderBy(r => r.NextFireAt).ToListAsync(ct);
        var names = await NamesAsync(rows, ct);
        return rows.Select(r => Dto(r, names)).ToList();
    }

    // ------------------------------------------------------------------ creating and changing

    public async Task<ReminderDto> CreateAsync(SaveReminderRequest req, CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var tid = ctx.RequireTenantId();
        var forUser = req.ForUserId is { } f && f != uid ? f : uid;
        var target = req.TargetType != ReminderTarget.None && req.TargetId is { } t ? await ResolveTargetAsync(req.TargetType, t, ct) : null;
        if (req.TargetType != ReminderTarget.None && target is null) throw new ValidationException("targetId", "Choose what the reminder is about.");

        var r = new Reminder
        {
            TenantId = tid, UserId = forUser, Source = forUser == uid ? ReminderSource.Personal : ReminderSource.Nudge,
            Title = Clean(req.Title, 200) ?? target?.Title ?? throw new ValidationException("title", "Say what to remind you about."),
            Note = Clean(req.Note, 1000), OnlyIfOpen = req.OnlyIfOpen ?? true, CreatedAt = clock.Now, CreatedBy = uid,
        };
        Apply(r, target);
        if (forUser != uid) await CheckNudgeAsync(forUser, target, ct);
        // Someone else's reminder arrives in their working hours unless the sender insists; one's own goes off at the exact time.
        r.Exact = req.Exact ?? forUser == uid;
        await ScheduleAsync(r, req.When, target, ct);
        await EnsureWithinLimitsAsync(uid, r.Recurrence is not null, ct);

        db.Reminders.Add(r);
        if (r.Source == ReminderSource.Nudge) recorder.Audit("reminder.nudge", "Reminder", r.Id, null, new { to = forUser, target = target?.Key });
        await db.SaveChangesAsync(ct);
        return Dto(r, await NamesAsync([r], ct));
    }

    public async Task<ReminderDto> UpdateAsync(Guid id, SaveReminderRequest req, CancellationToken ct = default)
    {
        var r = await EditableAsync(id, ct);
        if (Automatic.Contains(r.Source)) throw new ConflictException("Automatic reminders follow the work's due date. Snooze or dismiss them instead.", "REMINDER_AUTOMATIC");
        var target = r.TargetType != ReminderTarget.None && r.TargetId is { } t ? await ResolveTargetAsync(r.TargetType, t, ct) : null;
        r.Title = Clean(req.Title, 200) ?? r.Title;
        r.Note = Clean(req.Note, 1000);
        if (req.OnlyIfOpen is { } o) r.OnlyIfOpen = o;
        if (req.Exact is { } e) r.Exact = e;
        var wasRecurring = r.Recurrence is not null;
        if (req.When is not null)
        {
            await ScheduleAsync(r, req.When, target, ct);
            r.State = ReminderState.Scheduled; r.IsSnoozed = false; r.Quiet = false;
            if (!wasRecurring && r.Recurrence is not null) await EnsureWithinLimitsAsync(ctx.RequireUserId(), true, ct, excluding: r.Id);
        }
        r.UpdatedAt = clock.Now; r.UpdatedBy = ctx.UserId;
        await db.SaveChangesAsync(ct);
        return Dto(r, await NamesAsync([r], ct));
    }

    public async Task<ReminderDto> SnoozeAsync(Guid id, SnoozeRequest req, CancellationToken ct = default)
    {
        var r = await OwnAsync(id, ct);
        var settings = await SettingsRowAsync(r.UserId, ct);
        var tz = Zone(req.TimeZone ?? await UserZoneAsync(r.UserId, ct));
        Snooze(r, req, settings, tz, clock.Now);
        await db.SaveChangesAsync(ct);
        return Dto(r, await NamesAsync([r], ct));
    }

    /// <summary>Moves a reminder to a later time: a preset ("10m", "1h", "3h", "evening", "tomorrow", "nextweek") or a local time.</summary>
    public static void Snooze(Reminder r, SnoozeRequest req, ReminderSettings settings, NodaTime.DateTimeZone tz, DateTime now)
    {
        if (r.State is ReminderState.Done or ReminderState.Cancelled) throw new ConflictException("This reminder is already finished.", "REMINDER_FINISHED");
        var local = ZoneTime.ToLocal(now, tz);
        var cal = new WorkCalendar(settings);
        DateTime until;
        if (!string.IsNullOrWhiteSpace(req.Until))
        {
            if (!ZoneTime.TryParseLocal(req.Until, out var at)) throw new ValidationException("until", "Pick a date and time.");
            until = ZoneTime.ToUtc(at, tz);
        }
        else
        {
            var today = DateOnly.FromDateTime(local);
            until = (req.Preset ?? "1h").Trim().ToLowerInvariant() switch
            {
                "10m" => now.AddMinutes(10),
                "30m" => now.AddMinutes(30),
                "1h" => now.AddHours(1),
                "3h" => now.AddHours(3),
                "evening" => ZoneTime.ToUtc(ZoneTime.At(local.Hour >= 18 ? today.AddDays(1) : today, new TimeOnly(18, 0)), tz),
                "tomorrow" => ZoneTime.ToUtc(ZoneTime.At(cal.WorkingOnOrAfter(today.AddDays(1)), settings.DefaultTime), tz),
                "nextweek" => ZoneTime.ToUtc(ZoneTime.At(cal.WorkingOnOrAfter(today.AddDays(8 - (((int)today.DayOfWeek + 6) % 7 + 1))), settings.DefaultTime), tz),
                "workday" => ZoneTime.ToUtc(cal.NextGoodTime(local.AddMinutes(1)), tz),
                _ => throw new ValidationException("preset", "Choose how long to snooze."),
            };
        }
        if (until <= now.AddSeconds(30)) throw new ValidationException("until", "Pick a time in the future.");
        if (until > now.AddYears(2)) throw new ValidationException("until", "Pick a time within two years.");
        r.NextFireAt = until;
        r.State = ReminderState.Scheduled;
        r.IsSnoozed = true;
        r.Quiet = false;
        r.SnoozeCount++;
    }

    public async Task<ReminderDto> CompleteAsync(Guid id, CancellationToken ct = default)
    {
        var r = await OwnAsync(id, ct);
        var done = Complete(db, r, clock.Now);
        await db.SaveChangesAsync(ct);
        return Dto(done, await NamesAsync([done], ct));
    }

    /// <summary>
    /// Finishes a reminder. A repeating one keeps going: this occurrence is kept as a finished copy (so it shows under Completed) and the
    /// series waits for its next time. Returns the record that is now finished.
    /// </summary>
    public static Reminder Complete(IAppDbContext db, Reminder r, DateTime now)
    {
        if (r.State == ReminderState.Done) return r;
        if (r.State == ReminderState.Cancelled) throw new ConflictException("This reminder was dismissed.", "REMINDER_FINISHED");
        if (r.Recurrence is null)
        {
            // The e-mail and push links stop working but still show where the reminder stands.
            r.State = ReminderState.Done; r.CompletedAt = now; r.NextFireAt = null; r.IsSnoozed = false; r.Quiet = false;
            if (r.ActionTokenExpiresAt > now) r.ActionTokenExpiresAt = now;
            return r;
        }
        // Which occurrence is finished: the one that went off, or - finishing ahead of time - the one coming up (which is then skipped).
        var ahead = r.State == ReminderState.Scheduled && !r.IsSnoozed && r.NextFireAt > now;
        var occurrence = ahead ? r.NextFireAt : r.LastFiredAt;
        var copy = new Reminder
        {
            TenantId = r.TenantId, UserId = r.UserId, Source = r.Source, Title = r.Title, Note = r.Note, TargetType = r.TargetType, TargetId = r.TargetId,
            TargetKey = r.TargetKey, TargetTitle = r.TargetTitle, TargetProjectId = r.TargetProjectId, Link = r.Link, TimeZone = r.TimeZone,
            LocalAt = occurrence is { } o ? ZoneTime.Write(ZoneTime.ToLocal(o, ZoneTime.Find(r.TimeZone))) : r.LocalAt,
            State = ReminderState.Done, CompletedAt = now, SeriesId = r.Id, FireCount = 1, LastFiredAt = r.LastFiredAt, SnoozeCount = r.SnoozeCount,
            CreatedAt = now, CreatedBy = r.CreatedBy,
        };
        db.Reminders.Add(copy);
        // The series goes back to waiting; if a snooze had pushed it, its next regular time is worked out again.
        r.NextFireAt = NextOccurrence(r, ahead ? r.NextFireAt!.Value : now);
        r.State = ReminderState.Scheduled; r.IsSnoozed = false; r.Quiet = false; r.SnoozeCount = 0;
        if (r.ActionTokenExpiresAt > now) r.ActionTokenExpiresAt = now;
        return copy;
    }

    public async Task<ReminderDto> ReopenAsync(Guid id, CancellationToken ct = default)
    {
        var r = await OwnAsync(id, ct, finished: true);
        if (r.State != ReminderState.Done) return Dto(r, await NamesAsync([r], ct));
        var now = clock.Now;
        if (r.SeriesId is not null) { r.SeriesId = null; r.State = ReminderState.Fired; r.NextFireAt = null; }   // an occurrence comes back on its own
        else r.State = r.NextFireAt is { } next && next > now ? ReminderState.Scheduled : ReminderState.Fired;
        r.CompletedAt = null;
        await db.SaveChangesAsync(ct);
        return Dto(r, await NamesAsync([r], ct));
    }

    /// <summary>Deletes the caller's own reminder, or dismisses one that came from the system or from someone else (so it is not made again).</summary>
    public async Task DeleteAsync(Guid id, CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var r = await db.Reminders.FirstOrDefaultAsync(x => x.Id == id && (x.UserId == uid || x.CreatedBy == uid), ct) ?? throw new NotFoundException("Reminder not found.");
        if (r.Source == ReminderSource.Personal || r.CreatedBy == uid && r.UserId != uid && r.State == ReminderState.Scheduled) db.Reminders.Remove(r);
        else { r.State = ReminderState.Cancelled; r.NextFireAt = null; r.ActionTokenHash = null; }
        await db.SaveChangesAsync(ct);
    }

    // ------------------------------------------------------------------ scheduling

    private async Task ScheduleAsync(Reminder r, ReminderWhen? when, ReminderTargetInfo? target, CancellationToken ct)
    {
        if (when is null) throw new ValidationException("when", "Choose when to be reminded.");
        var zoneId = !string.IsNullOrWhiteSpace(when.TimeZone) ? when.TimeZone.Trim() : await UserZoneAsync(r.UserId, ct);
        if (!ZoneTime.IsKnown(zoneId)) throw new ValidationException("timeZone", "That time zone is not known.");
        r.TimeZone = zoneId;
        r.LocalAt = null; r.AnchorDays = null; r.AnchorTime = null; r.Recurrence = null;
        var now = clock.Now;

        if (when.AnchorDays is { } days)
        {
            if (target?.Due is null) throw new ValidationException("anchorDays", "That work has no due date to count from.");
            if (days is < -60 or > 60) throw new ValidationException("anchorDays", "Choose up to 60 days before or after the due date.");
            r.AnchorDays = days;
            r.AnchorTime = ZoneTime.TryParseTime(when.AnchorTime, out var at) ? at : (await SettingsRowAsync(r.UserId, ct)).DefaultTime;
            r.NextFireAt = AnchoredFire(r, target.Due.Value);
            if (r.NextFireAt <= now) throw new ValidationException("anchorDays", "That moment has already passed.");
            return;
        }
        if (!ZoneTime.TryParseLocal(when.At, out var local)) throw new ValidationException("at", "Choose a date and time.");
        r.LocalAt = ZoneTime.Write(local);
        if (!string.IsNullOrWhiteSpace(when.Recurrence))
        {
            var rule = RecurrenceRule.Parse(when.Recurrence) ?? throw new ValidationException("recurrence", "That repeat rule is not supported.");
            r.Recurrence = rule.ToRRule();
            r.NextFireAt = NextOccurrence(r, now.AddSeconds(-1));
            if (r.NextFireAt is null) throw new ValidationException("recurrence", "That rule never comes round.");
            return;
        }
        var utc = ZoneTime.ToUtc(local, ZoneTime.Find(zoneId));
        if (utc <= now.AddSeconds(-30)) throw new ValidationException("at", "That time has already passed.");
        if (utc > now.AddYears(5)) throw new ValidationException("at", "Choose a time within five years.");
        r.NextFireAt = utc < now ? now : utc;
    }

    public static DateTime AnchoredFire(Reminder r, DateOnly due) =>
        ZoneTime.ToUtc(ZoneTime.At(due.AddDays(r.AnchorDays ?? 0), r.AnchorTime ?? new TimeOnly(9, 0)), ZoneTime.Find(r.TimeZone));

    /// <summary>A repeating reminder's next time after <paramref name="after"/>, in its own zone, counted from its first occurrence.</summary>
    public static DateTime? NextOccurrence(Reminder r, DateTime after)
    {
        if (RecurrenceRule.Parse(r.Recurrence) is not { } rule || !ZoneTime.TryParseLocal(r.LocalAt, out var first)) return null;
        var tz = ZoneTime.Find(r.TimeZone);
        var time = TimeOnly.FromDateTime(first);
        var start = DateOnly.FromDateTime(first);
        var localAfter = ZoneTime.ToLocal(after, tz);
        var day = rule.NextDate(DateOnly.FromDateTime(localAfter), start, inclusive: true);
        for (var i = 0; i < 3 && day is { } d; i++)
        {
            var utc = ZoneTime.ToUtc(ZoneTime.At(d, time), tz);
            if (utc > after) return utc;
            day = rule.NextDate(d, start, inclusive: false);
        }
        return null;
    }

    // ------------------------------------------------------------------ settings, insights, policy

    public async Task<ReminderSettingsDto> GetSettingsAsync(CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        return SettingsDto(await SettingsRowAsync(uid, ct), await UserZoneAsync(uid, ct));
    }

    public async Task<ReminderSettingsDto> SaveSettingsAsync(ReminderSettingsDto req, CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var row = await db.ReminderSettings.FirstOrDefaultAsync(s => s.UserId == uid, ct);
        if (row is null) { row = new ReminderSettings { UserId = uid }; db.ReminderSettings.Add(row); }
        TimeOnly T(string? v, string field) => ZoneTime.TryParseTime(v, out var t) ? t : throw new ValidationException(field, "Use a time like 09:00.");
        TimeOnly? Opt(string? v, string field) => string.IsNullOrWhiteSpace(v) ? null : T(v, field);
        var days = (req.WorkDays ?? []).Where(d => d is >= 1 and <= 7).Distinct().OrderBy(d => d).ToArray();
        if (days.Length == 0) throw new ValidationException("workDays", "Choose at least one working day.");
        row.WorkDays = string.Join(',', days);
        row.WorkStart = T(req.WorkStart, "workStart");
        row.WorkEnd = T(req.WorkEnd, "workEnd");
        if (row.WorkEnd <= row.WorkStart) throw new ValidationException("workEnd", "The working day must end after it starts.");
        row.QuietStart = Opt(req.QuietStart, "quietStart");
        row.QuietEnd = Opt(req.QuietEnd, "quietEnd");
        if (row.QuietStart is null != row.QuietEnd is null) throw new ValidationException("quietEnd", "Give both ends of the quiet hours, or neither.");
        row.DefaultTime = T(req.DefaultTime, "defaultTime");
        row.AutoEnabled = req.AutoEnabled;
        row.DueLeads = string.Join(',', (req.DueLeads ?? []).Where(n => n is >= 0 and <= 10).Distinct().OrderByDescending(n => n));
        row.OverdueSteps = string.Join(',', (req.OverdueSteps ?? []).Where(n => n is >= 1 and <= 30).Distinct().OrderBy(n => n));
        row.DailyAutoLimit = Math.Clamp(req.DailyAutoLimit, 1, 100);
        row.BriefingEnabled = req.BriefingEnabled;
        row.BriefingTime = T(req.BriefingTime, "briefingTime");
        row.FollowDeviceTimeZone = req.FollowDeviceTimeZone;
        row.MuteNudges = req.MuteNudges;
        await db.SaveChangesAsync(ct);
        return SettingsDto(row, await UserZoneAsync(uid, ct));
    }

    /// <summary>Follows the device: the profile's zone (which automatic reminders use) changes when the person's device is elsewhere.</summary>
    public async Task<ReminderSettingsDto> SetTimeZoneAsync(TimeZoneRequest req, CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        if (!ZoneTime.IsKnown(req.TimeZone)) throw new ValidationException("timeZone", "That time zone is not known.");
        var user = await db.Users.FirstAsync(u => u.Id == uid, ct);
        var settings = await SettingsRowAsync(uid, ct);
        if (settings.FollowDeviceTimeZone && user.TimeZone != req.TimeZone!.Trim())
        {
            user.TimeZone = req.TimeZone.Trim();
            // Automatic reminders are worked out again by the planner in the new zone; nothing else needs to move.
            await db.SaveChangesAsync(ct);
        }
        return SettingsDto(settings, user.TimeZone);
    }

    public async Task<ReminderInsightsDto> InsightsAsync(CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var weekAgo = clock.Now.AddDays(-7);
        var rows = await db.Reminders.AsNoTracking().Where(r => r.UserId == uid && (r.LastFiredAt >= weekAgo || r.CompletedAt >= weekAgo)).ToListAsync(ct);
        var done = rows.Where(r => r.State == ReminderState.Done && r.CompletedAt >= weekAgo).ToList();
        var fired = rows.Count(r => r.LastFiredAt >= weekAgo);
        var onTime = done.Count(r => r.LastFiredAt is null || r.CompletedAt <= r.LastFiredAt.Value.AddHours(4));
        var snoozed = await db.Reminders.AsNoTracking().Where(r => r.UserId == uid && r.SnoozeCount >= 3 && (r.State == ReminderState.Scheduled || r.State == ReminderState.Fired))
            .OrderByDescending(r => r.SnoozeCount).Take(5).ToListAsync(ct);
        var names = await NamesAsync(snoozed, ct);
        return new ReminderInsightsDto(done.Count, fired, done.Count == 0 ? 0 : (int)Math.Round(onTime * 100.0 / done.Count), await UsualTimeAsync(uid, ct),
            snoozed.Select(r => Dto(r, names)).ToList());
    }

    /// <summary>When this person usually gets things done: the most common hour of their own changes over the last month, in their zone.</summary>
    private async Task<string?> UsualTimeAsync(Guid uid, CancellationToken ct)
    {
        var since = clock.Now.AddDays(-30);
        var times = await db.Activities.AsNoTracking().Where(a => a.ActorId == uid && a.CreatedAt >= since).OrderByDescending(a => a.CreatedAt).Take(1500).Select(a => a.CreatedAt).ToListAsync(ct);
        if (times.Count < 10) return null;
        var tz = Zone(await UserZoneAsync(uid, ct));
        var hour = times.Select(t => ZoneTime.ToLocal(t, tz).Hour).Where(h => h is >= 6 and <= 21).GroupBy(h => h).OrderByDescending(g => g.Count()).Select(g => (int?)g.Key).FirstOrDefault();
        return hour is { } h ? $"{h:00}:00" : null;
    }

    public async Task<ReminderPolicyDto> GetPolicyAsync(CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        var row = await db.ReminderPolicies.AsNoTracking().FirstOrDefaultAsync(p => p.TenantId == tid, ct);
        var since = clock.Now.AddDays(-30);
        var all = db.Reminders.AsNoTracking().Where(r => r.TenantId == tid);
        var sent = await all.CountAsync(r => r.LastFiredAt >= since, ct);
        var done = await all.CountAsync(r => r.CompletedAt >= since, ct);
        var escalated = await all.CountAsync(r => r.Source == ReminderSource.Escalation && r.LastFiredAt >= since, ct);
        return new ReminderPolicyDto(await entitlements.GetValueAsync(FeatureKeys.ReminderEscalation, ct) > 0, ctx.Role is TenantRole.Owner or TenantRole.Admin,
            row?.EscalationEnabled ?? false, row?.Steps ?? new ReminderPolicy().Steps, sent, done, escalated);
    }

    public async Task<ReminderPolicyDto> SavePolicyAsync(SavePolicyRequest req, CancellationToken ct = default)
    {
        if (ctx.Role is not (TenantRole.Owner or TenantRole.Admin)) throw new ForbiddenException("Only owners and admins can change reminder escalation.", "PERMISSION_DENIED");
        await entitlements.EnsureFeatureAsync(FeatureKeys.ReminderEscalation, ct);
        var steps = EscalationStep.Parse(req.Steps);
        if (req.EscalationEnabled && steps.Count == 0) throw new ValidationException("steps", "Add at least one step, like \"2 days: manager\".");
        var tid = ctx.RequireTenantId();
        var row = await db.ReminderPolicies.FirstOrDefaultAsync(p => p.TenantId == tid, ct);
        if (row is null) { row = new ReminderPolicy { TenantId = tid, CreatedAt = clock.Now }; db.ReminderPolicies.Add(row); }
        row.EscalationEnabled = req.EscalationEnabled;
        row.Steps = EscalationStep.Write(steps);
        recorder.Audit("reminder.policy", "ReminderPolicy", row.Id, null, new { row.EscalationEnabled, row.Steps });
        await db.SaveChangesAsync(ct);
        return await GetPolicyAsync(ct);
    }

    // ------------------------------------------------------------------ one-time links in e-mails and push notifications

    public static string NewActionToken(Reminder r, DateTime now)
    {
        var token = Base64Url.Encode(RandomNumberGenerator.GetBytes(32));
        r.ActionTokenHash = HashToken(token);
        r.ActionTokenExpiresAt = now.AddDays(7);
        return token;
    }

    public static string HashToken(string token) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token))).ToLowerInvariant();

    // ------------------------------------------------------------------ helpers

    private async Task<Reminder> OwnAsync(Guid id, CancellationToken ct, bool finished = false)
    {
        var uid = ctx.RequireUserId();
        var r = await db.Reminders.FirstOrDefaultAsync(x => x.Id == id && x.UserId == uid, ct) ?? throw new NotFoundException("Reminder not found.");
        if (!finished && r.State == ReminderState.Cancelled) throw new NotFoundException("Reminder not found.");
        return r;
    }

    /// <summary>The person reminded may change it; so may whoever sent it, until it goes off.</summary>
    private async Task<Reminder> EditableAsync(Guid id, CancellationToken ct)
    {
        var uid = ctx.RequireUserId();
        var r = await db.Reminders.FirstOrDefaultAsync(x => x.Id == id && (x.UserId == uid || x.CreatedBy == uid && x.State == ReminderState.Scheduled), ct)
            ?? throw new NotFoundException("Reminder not found.");
        if (r.State is ReminderState.Done or ReminderState.Cancelled) throw new ConflictException("This reminder is already finished.", "REMINDER_FINISHED");
        return r;
    }

    private static void Apply(Reminder r, ReminderTargetInfo? t)
    {
        r.TargetType = t?.Type ?? ReminderTarget.None;
        r.TargetId = t?.Id; r.TargetKey = t?.Key; r.TargetTitle = Text.Truncate(t?.Title, 200); r.TargetProjectId = t?.ProjectId; r.Link = t?.Link;
        if (t is null) r.OnlyIfOpen = false;
    }

    private async Task CheckNudgeAsync(Guid to, ReminderTargetInfo? target, CancellationToken ct)
    {
        var uid = ctx.RequireUserId();
        var tid = ctx.RequireTenantId();
        var member = await db.TenantMembers.AsNoTracking().FirstOrDefaultAsync(m => m.TenantId == tid && m.UserId == to, ct)
            ?? throw new ValidationException("forUserId", "That person is not in this workspace.");
        var broad = ctx.Role is TenantRole.Owner or TenantRole.Admin || member.ReportsToUserId == uid;
        var theirWork = target is not null && target.AssigneeId == to;
        if (!broad && !theirWork)
            throw new ForbiddenException(target is null ? "You can remind someone about their own work, or anyone who reports to you." : "You can remind people about work assigned to them.", "PERMISSION_DENIED");
        var settings = await db.ReminderSettings.AsNoTracking().FirstOrDefaultAsync(s => s.UserId == to, ct);
        if (settings?.MuteNudges == true) throw new ConflictException("They have paused reminders from other people.", "NUDGES_MUTED");
        var since = clock.Now.AddHours(-20);
        var targetId = target?.Id;
        if (await db.Reminders.AnyAsync(r => r.Source == ReminderSource.Nudge && r.CreatedBy == uid && r.UserId == to && r.TargetId == targetId && r.CreatedAt >= since, ct))
            throw new ConflictException("You already reminded them about this today.", "NUDGE_REPEATED");
    }

    private async Task EnsureWithinLimitsAsync(Guid uid, bool recurring, CancellationToken ct, Guid? excluding = null)
    {
        var limits = await LimitsAsync(uid, ct, excluding);
        if (limits.Open != FeatureKeys.Unlimited && limits.OpenUsed + 1 > limits.Open) throw new PlanLimitException(FeatureKeys.ReminderLimit, limits.Open);
        if (recurring && limits.Recurring != FeatureKeys.Unlimited && limits.RecurringUsed + 1 > limits.Recurring)
            throw new PlanLimitException(FeatureKeys.RecurringReminderLimit, limits.Recurring);
    }

    /// <summary>
    /// The plan's reminder allowances (a plan without the setting - one an administrator made before reminders existed - gets the Free
    /// plan's), against what this person has set and is still open.
    /// </summary>
    private async Task<ReminderLimitsDto> LimitsAsync(Guid uid, CancellationToken ct, Guid? excluding = null)
    {
        var open = await entitlements.GetValueAsync(FeatureKeys.ReminderLimit, ct);
        var recurring = await entitlements.GetValueAsync(FeatureKeys.RecurringReminderLimit, ct);
        var mine = db.Reminders.Where(r => r.CreatedBy == uid && r.Id != excluding && (r.Source == ReminderSource.Personal || r.Source == ReminderSource.Nudge)
            && (r.State == ReminderState.Scheduled || r.State == ReminderState.Fired));
        return new ReminderLimitsDto(open == 0 ? FreeOpenLimit : open, recurring == 0 ? FreeRecurringLimit : recurring,
            await mine.CountAsync(ct), await mine.CountAsync(r => r.Recurrence != null, ct));
    }

    private async Task<ReminderSettings> SettingsRowAsync(Guid uid, CancellationToken ct) =>
        await db.ReminderSettings.FirstOrDefaultAsync(s => s.UserId == uid, ct) ?? new ReminderSettings { UserId = uid };

    private async Task<string> UserZoneAsync(Guid uid, CancellationToken ct) =>
        await db.Users.Where(u => u.Id == uid).Select(u => u.TimeZone).FirstOrDefaultAsync(ct) ?? "UTC";

    private static NodaTime.DateTimeZone Zone(string? id) => ZoneTime.Find(id);

    private static ReminderSettingsDto SettingsDto(ReminderSettings s, string zone) => new(
        [.. WorkCalendar.ParseDays(s.WorkDays).Select(d => d == DayOfWeek.Sunday ? 7 : (int)d).OrderBy(d => d)],
        s.WorkStart.ToString("HH:mm"), s.WorkEnd.ToString("HH:mm"), s.QuietStart?.ToString("HH:mm"), s.QuietEnd?.ToString("HH:mm"), s.DefaultTime.ToString("HH:mm"),
        s.AutoEnabled, [.. WorkCalendar.ParseNumbers(s.DueLeads, 0, 10).OrderByDescending(n => n)], [.. WorkCalendar.ParseNumbers(s.OverdueSteps, 1, 30)],
        s.DailyAutoLimit, s.BriefingEnabled, s.BriefingTime.ToString("HH:mm"), s.FollowDeviceTimeZone, s.MuteNudges, zone);

    private static string? Clean(string? s, int max)
    {
        var t = s?.Trim();
        return string.IsNullOrEmpty(t) ? null : t.Length > max ? t[..max] : t;
    }

    private async Task<Dictionary<Guid, string>> NamesAsync(IEnumerable<Reminder> rows, CancellationToken ct)
    {
        var ids = rows.SelectMany(r => new[] { r.CreatedBy ?? Guid.Empty, r.UserId }).Where(i => i != Guid.Empty).Distinct().ToList();
        return ids.Count == 0 ? [] : await db.Users.AsNoTracking().Where(u => ids.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
    }

    private ReminderDto Dto(Reminder r, IReadOnlyDictionary<Guid, string> names)
    {
        var uid = ctx.UserId;
        var from = r.CreatedBy is { } c && c != r.UserId ? new UserRefDto(c, names.GetValueOrDefault(c, "")) : null;
        var forUser = r.UserId != uid ? new UserRefDto(r.UserId, names.GetValueOrDefault(r.UserId, "")) : null;
        var text = RecurrenceRule.Parse(r.Recurrence) is { } rule && ZoneTime.TryParseLocal(r.LocalAt, out var first) ? rule.Describe(DateOnly.FromDateTime(first)) : null;
        var canEdit = !Automatic.Contains(r.Source) && r.State is ReminderState.Scheduled or ReminderState.Fired && (r.UserId == uid || r.CreatedBy == uid && r.State == ReminderState.Scheduled);
        return new ReminderDto(r.Id, r.Source, r.State, r.Title, r.Note, r.TargetType, r.TargetId, r.TargetKey, r.TargetTitle, r.Link,
            r.TimeZone, r.LocalAt, r.AnchorDays, r.AnchorTime?.ToString("HH:mm"), r.Recurrence, text, r.OnlyIfOpen, r.Exact, r.NextFireAt, r.IsSnoozed,
            r.SnoozeCount, r.FireCount, r.LastFiredAt, r.Quiet, r.CompletedAt, r.SeriesId, from, forUser, canEdit, r.CreatedAt);
    }

    /// <summary>Reads what a reminder would point at, as the caller: work they cannot see cannot be the subject of a reminder.</summary>
    public async Task<ReminderTargetInfo?> ResolveTargetAsync(ReminderTarget type, Guid id, CancellationToken ct)
    {
        var levels = await permissions.LevelsAsync(ct);
        int Lv(string m) => levels.TryGetValue(m, out var v) ? v : 0;
        switch (type)
        {
            case ReminderTarget.Task when Lv(Modules.Tasks) > 0:
                var t = await access.VisibleTasks().AsNoTracking().Where(x => x.Id == id)
                    .Select(x => new { x.Id, x.Number, x.Title, x.ProjectId, Key = x.Project!.Key, x.DueDate, x.AssigneeId, Cat = x.Status!.Category }).FirstOrDefaultAsync(ct);
                return t is null ? null : new(type, t.Id, $"{t.Key}-{t.Number}", t.Title, t.ProjectId, $"/projects/{t.ProjectId}?task={t.Id}", t.DueDate, t.AssigneeId,
                    t.Cat is not (StatusCategory.Done or StatusCategory.Cancelled));
            case ReminderTarget.Issue when Lv(Modules.Projects) > 0:
                var i = await (from x in db.StageIssues.AsNoTracking()
                               join p in access.VisibleProjects().AsNoTracking() on x.ProjectId equals p.Id
                               where x.Id == id
                               select new { x.Id, x.Number, x.Title, x.ProjectId, p.Key, x.AssigneeId, x.Status }).FirstOrDefaultAsync(ct);
                return i is null ? null : new(type, i.Id, $"{i.Key}-I{i.Number}", i.Title, i.ProjectId, $"/projects/{i.ProjectId}?tab=issues&issue={i.Id}", null, i.AssigneeId,
                    i.Status != IssueStatus.Resolved);
            case ReminderTarget.ActionItem when Lv(Modules.Projects) > 0:
            case ReminderTarget.Operational when Lv(Modules.Work) > 0:
                var kind = type == ReminderTarget.ActionItem ? WorkTaskKind.ActionItem : WorkTaskKind.Operational;
                var w = await db.WorkTasks.AsNoTracking().Where(x => x.Id == id && x.Kind == kind)
                    .Select(x => new { x.Id, x.Number, x.Title, x.RelatedProjectId, x.DueDate, x.AssigneeId, x.Status }).FirstOrDefaultAsync(ct);
                if (w is null) return null;
                if (kind == WorkTaskKind.ActionItem && (w.RelatedProjectId is not { } pid || !await access.VisibleProjects().AnyAsync(p => p.Id == pid, ct))) return null;
                return new(type, w.Id, WorkItemService.KeyOf(kind, w.Number), w.Title, w.RelatedProjectId,
                    kind == WorkTaskKind.ActionItem ? ActionItemService.LinkOf(w.RelatedProjectId!.Value, w.Id) : WorkTaskService.LinkOf(w.Id), w.DueDate, w.AssigneeId,
                    w.Status is WorkTaskStatus.ToDo or WorkTaskStatus.InProgress or WorkTaskStatus.OnHold);
            case ReminderTarget.Milestone when Lv(Modules.Projects) > 0:
                var m = await (from x in db.Milestones.AsNoTracking()
                               join p in access.VisibleProjects().AsNoTracking() on x.ProjectId equals p.Id
                               where x.Id == id
                               select new { x.Id, x.Name, x.ProjectId, p.Key, x.DueDate, x.OwnerId, x.Status }).FirstOrDefaultAsync(ct);
                return m is null ? null : new(type, m.Id, $"{m.Key} milestone", m.Name, m.ProjectId, $"/projects/{m.ProjectId}?tab=plan", m.DueDate, m.OwnerId,
                    m.Status != StageStatus.Completed);
            case ReminderTarget.ChatMessage:
                var uid = ctx.RequireUserId();
                var c = await db.ChatMessages.AsNoTracking().Where(x => x.Id == id && x.DeletedAt == null)
                    .Select(x => new { x.Id, x.Body, x.ConversationId, ProjectId = db.Conversations.Where(v => v.Id == x.ConversationId).Select(v => v.ProjectId).FirstOrDefault() })
                    .FirstOrDefaultAsync(ct);
                if (c is null) return null;
                var member = await db.ConversationMembers.AnyAsync(x => x.ConversationId == c.ConversationId && x.UserId == uid, ct)
                    || c.ProjectId is { } cp && await access.VisibleProjects().AnyAsync(p => p.Id == cp, ct);
                if (!member) return null;
                var snippet = c.Body.Replace('\n', ' ').Trim();
                return new(type, c.Id, "Message", snippet.Length > 120 ? snippet[..117] + "…" : snippet, c.ProjectId, $"/chat/{c.ConversationId}", null, null, true);
            default:
                return null;
        }
    }
}

/// <summary>One step of an escalation ladder: after so many days overdue, tell the manager or the owner.</summary>
public sealed record EscalationStep(int Days, string Who)
{
    public static IReadOnlyList<EscalationStep> Parse(string? text) =>
        (text ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries).Select(p => p.Split(':', 2))
            .Where(p => p.Length == 2 && int.TryParse(p[0].Trim(), out var d) && d is >= 1 and <= 60 && p[1].Trim() is "Manager" or "Owner")
            .Select(p => new EscalationStep(int.Parse(p[0].Trim()), p[1].Trim())).DistinctBy(s => (s.Days, s.Who)).OrderBy(s => s.Days).Take(5).ToList();

    public static string Write(IEnumerable<EscalationStep> steps) => string.Join(',', steps.Select(s => $"{s.Days}:{s.Who}"));
}
