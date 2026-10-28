using System.Globalization;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Organization;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Attendance;

public record AttendanceDto(Guid Id, Guid UserId, string UserName, DateOnly Date, DateTime CheckInAt, DateTime? CheckOutAt, string Mode, string? Place, string? Note,
    string Source, bool AutoClosed, int Minutes, string CheckInLocal, string? CheckOutLocal);
public record AttendancePolicyDto(bool Enabled, string HoursSource, string WorkDays, string WorkStart, string WorkEnd, int CheckInGraceMinutes, int CheckOutGraceMinutes,
    bool AutoClose, int AutoCloseAfterHours, IReadOnlyList<string> AllowedModes, bool RequireClientPlace, bool PromptAtSignIn, string TimeZone);
/// <summary>
/// Today for the signed-in person, in the organization's time: the rules, whether today is a working day for them (not a weekend, holiday or
/// leave), their check-in if any, and whether the app should ask them to check in now (between two hours before the start and the end).
/// </summary>
public record AttendanceTodayDto(DateOnly Date, string TimeZone, string LocalTime, string WorkStart, string WorkEnd, bool WorkingDay, bool OnLeave, string? Holiday,
    bool ShouldPrompt, AttendanceDto? Record, IReadOnlyList<string> RecentPlaces, bool CanViewTeam, AttendancePolicyDto Policy);
public record AttendanceCheckOutDto(AttendanceDto Day, int Minutes, int TasksDone, int LoggedMinutes);
public record AttendancePersonDto(Guid UserId, string Name, string Status, string? Place, string? CheckInLocal, string? CheckOutLocal);
public record AttendanceTeamTodayDto(DateOnly Date, int Office, int Home, int ClientSite, int OnLeave, int NotIn, IReadOnlyList<AttendancePersonDto> People);
public record CheckInRequest(string? Mode, string? Place, string? Note, string? Source);
public record CheckOutRequest(string? Note);
/// <summary>Correct one's own day (today only): times as "HH:mm" in the organization's time.</summary>
public record CorrectAttendanceRequest(string? Mode, string? Place, string? Note, string? CheckIn, string? CheckOut);
public record SaveAttendancePolicyRequest(bool? Enabled, string? HoursSource, string? WorkDays, string? WorkStart, string? WorkEnd, int? CheckInGraceMinutes,
    int? CheckOutGraceMinutes, bool? AutoClose, int? AutoCloseAfterHours, IReadOnlyList<string>? AllowedModes, bool? RequireClientPlace, bool? PromptAtSignIn);

/// <summary>The working hours that apply to one person on one day (the workspace's, or their own when the workspace says so).</summary>
public readonly record struct AttendanceHours(TimeOnly Start, TimeOnly End, HashSet<DayOfWeek> Days)
{
    public bool IsWorkingDay(DateOnly d) => Days.Contains(d.DayOfWeek);

    public static AttendanceHours For(AttendancePolicy p, ReminderSettings? own) =>
        p.HoursSource == "personal" && own is not null && own.WorkEnd > own.WorkStart
            ? new(own.WorkStart, own.WorkEnd, WorkCalendar.ParseDays(own.WorkDays))
            : new(p.WorkStart, p.WorkEnd, WorkCalendar.ParseDays(p.WorkDays));
}

/// <summary>
/// Check-in and check-out (attendance): where people work today (the office, from home or at a client's) and when they started and stopped.
/// Everything is on the organization's clock: "today" is the date in the workspace's time zone whatever zone the person's browser is in, and
/// the working hours are the workspace's (or each person's own, when Settings › Attendance says so). People see and correct their own days;
/// managers see their reporting line, owners and admins everyone.
/// </summary>
public class AttendanceService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, ReportingLineService reporting)
{
    public static readonly string[] Modes = ["Office", "Home", "ClientSite"];
    public static readonly string[] Sources = ["web", "phone", "desktop"];
    public const int MaxRangeDays = 62;

    // ------------------------------------------------------------------ the organization's clock

    public static NodaTime.DateTimeZone ZoneOf(string? tenantZone, AppClock clock) => ZoneTime.IsKnown(tenantZone) ? ZoneTime.Find(tenantZone) : clock.DefaultZone;

    private async Task<(Tenant Tenant, NodaTime.DateTimeZone Zone)> OrgAsync(CancellationToken ct)
    {
        var tid = ctx.RequireTenantId();
        var t = await db.Tenants.AsNoTracking().FirstOrDefaultAsync(x => x.Id == tid, ct) ?? throw new NotFoundException("Workspace not found.");
        if (t.Type != WorkspaceType.Organization) throw new ForbiddenException("Attendance is for organization workspaces.", "ATTENDANCE_ORG_ONLY");
        return (t, ZoneOf(t.TimeZone, clock));
    }

    public static string Hm(TimeOnly t) => t.ToString("HH:mm", CultureInfo.InvariantCulture);
    private static string LocalHm(DateTime utc, NodaTime.DateTimeZone z) => ZoneTime.ToLocal(utc, z).ToString("HH:mm", CultureInfo.InvariantCulture);

    public async Task<AttendancePolicy> PolicyAsync(CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        return await db.AttendancePolicies.AsNoTracking().FirstOrDefaultAsync(p => p.TenantId == tid, ct) ?? new AttendancePolicy { TenantId = tid };
    }

    public static IReadOnlyList<string> AllowedOf(AttendancePolicy p)
    {
        var list = p.AllowedModes.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Where(m => Modes.Contains(m)).Distinct().ToList();
        return list.Count == 0 ? Modes : list;
    }

    private static AttendancePolicyDto ToDto(AttendancePolicy p, NodaTime.DateTimeZone z) =>
        new(p.Enabled, p.HoursSource, p.WorkDays, Hm(p.WorkStart), Hm(p.WorkEnd), p.CheckInGraceMinutes, p.CheckOutGraceMinutes, p.AutoClose, p.AutoCloseAfterHours,
            AllowedOf(p), p.RequireClientPlace, p.PromptAtSignIn, z.Id);

    private AttendanceDto ToDto(AttendanceDay d, string name, NodaTime.DateTimeZone z)
    {
        var end = d.CheckOutAt ?? clock.Now;
        var minutes = (int)Math.Max(0, Math.Round((end - d.CheckInAt).TotalMinutes));
        return new(d.Id, d.UserId, name, d.Date, d.CheckInAt, d.CheckOutAt, d.Mode, d.Place, d.Note, d.Source, d.AutoClosed, minutes, LocalHm(d.CheckInAt, z),
            d.CheckOutAt is { } o ? LocalHm(o, z) : null);
    }

    private async Task<AttendanceHours> HoursAsync(AttendancePolicy p, Guid userId, CancellationToken ct) =>
        AttendanceHours.For(p, p.HoursSource == "personal" ? await db.ReminderSettings.AsNoTracking().FirstOrDefaultAsync(s => s.UserId == userId, ct) : null);

    private async Task<bool> CanViewTeamAsync(CancellationToken ct) =>
        ctx.Role is TenantRole.Owner or TenantRole.Admin || (await reporting.ReportsOfAsync(ctx.RequireUserId(), ctx.RequireTenantId(), ct)).Count > 0;

    // ------------------------------------------------------------------ me

    public async Task<AttendanceTodayDto> TodayAsync(CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var (_, zone) = await OrgAsync(ct);
        var policy = await PolicyAsync(ct);
        var hours = await HoursAsync(policy, me, ct);
        var local = ZoneTime.ToLocal(clock.Now, zone);
        var today = DateOnly.FromDateTime(local);
        var mine = await db.AttendanceDays.AsNoTracking().FirstOrDefaultAsync(a => a.UserId == me && a.Date == today, ct);
        var holiday = await db.Holidays.AsNoTracking().Where(h => h.Date == today).Select(h => h.Name).FirstOrDefaultAsync(ct);
        var onLeave = await db.PlannedLeaves.AsNoTracking().AnyAsync(l => l.UserId == me && l.WorkDate == today, ct);
        var working = hours.IsWorkingDay(today) && holiday is null && !onLeave;
        var time = TimeOnly.FromDateTime(local);
        var opens = hours.Start.Hour >= 2 ? hours.Start.AddHours(-2) : TimeOnly.MinValue;   // two hours before the start (AddHours would wrap past midnight)
        var window = time >= opens && time < hours.End;
        var prompt = policy.Enabled && policy.PromptAtSignIn && mine is null && working && window;
        var since = today.AddDays(-60);
        var places = await db.AttendanceDays.AsNoTracking().Where(a => a.UserId == me && a.Mode == "ClientSite" && a.Place != null && a.Date >= since)
            .OrderByDescending(a => a.Date).Select(a => a.Place!).Take(20).ToListAsync(ct);
        var name = await db.Users.AsNoTracking().Where(u => u.Id == me).Select(u => u.DisplayName).FirstOrDefaultAsync(ct) ?? "";
        return new AttendanceTodayDto(today, zone.Id, local.ToString("HH:mm", CultureInfo.InvariantCulture), Hm(hours.Start), Hm(hours.End), working, onLeave, holiday,
            prompt, mine is null ? null : ToDto(mine, name, zone), places.Distinct(StringComparer.OrdinalIgnoreCase).Take(5).ToList(), await CanViewTeamAsync(ct), ToDto(policy, zone));
    }

    public async Task<AttendanceDto> CheckInAsync(CheckInRequest req, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId(); var tid = ctx.RequireTenantId();
        if (ctx.ViaApiKey) throw new ForbiddenException("API keys cannot check in.", "API_KEY_NOT_ALLOWED");
        var (_, zone) = await OrgAsync(ct);
        var policy = await PolicyAsync(ct);
        if (!policy.Enabled) throw new ConflictException("Attendance is switched off for this workspace.", "ATTENDANCE_OFF");
        var mode = ParseMode(req.Mode, policy);
        var place = Clean(req.Place, 120, "place", "Keep the place to 120 characters.");
        if (mode != "ClientSite") place = null;
        else if (place is null && policy.RequireClientPlace) throw new ValidationException("place", "Say which client or place.");
        var note = Clean(req.Note, 300, "note", "Keep the note to 300 characters.");
        var source = (req.Source ?? "web").Trim().ToLowerInvariant();
        if (!Sources.Contains(source)) source = "web";
        var today = clock.TodayIn(zone);
        if (await db.AttendanceDays.AnyAsync(a => a.UserId == me && a.Date == today, ct))
            throw new ConflictException("You have already checked in today.", "ALREADY_CHECKED_IN");
        var row = new AttendanceDay { TenantId = tid, UserId = me, Date = today, CheckInAt = clock.Now, Mode = mode, Place = place, Note = note, Source = source, CreatedAt = clock.Now, CreatedBy = me };
        db.AttendanceDays.Add(row);
        recorder.Audit("attendance.checked_in", nameof(AttendanceDay), row.Id, newValue: new { today, mode, place, source });
        await db.SaveChangesAsync(ct);
        return ToDto(row, await NameAsync(me, ct), zone);
    }

    public async Task<AttendanceCheckOutDto> CheckOutAsync(CheckOutRequest req, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        if (ctx.ViaApiKey) throw new ForbiddenException("API keys cannot check out.", "API_KEY_NOT_ALLOWED");
        var (_, zone) = await OrgAsync(ct);
        var today = clock.TodayIn(zone);
        // The open day: today's, or yesterday's when someone works past midnight.
        var row = await db.AttendanceDays.Where(a => a.UserId == me && a.CheckOutAt == null && a.Date >= today.AddDays(-1)).OrderByDescending(a => a.Date).FirstOrDefaultAsync(ct)
            ?? throw new ConflictException("You are not checked in.", "NOT_CHECKED_IN");
        var note = Clean(req.Note, 300, "note", "Keep the note to 300 characters.");
        row.CheckOutAt = clock.Now;
        if (note is not null) row.Note = row.Note is null ? note : Truncate($"{row.Note} · {note}", 300);
        row.UpdatedAt = clock.Now; row.UpdatedBy = me;
        recorder.Audit("attendance.checked_out", nameof(AttendanceDay), row.Id, newValue: new { row.Date, row.CheckOutAt });
        await db.SaveChangesAsync(ct);

        // The day in numbers: hours checked in, work finished and time logged on that day.
        var dayStart = ZoneTime.ToUtc(ZoneTime.At(row.Date, TimeOnly.MinValue), zone);
        var dayEnd = ZoneTime.ToUtc(ZoneTime.At(row.Date.AddDays(1), TimeOnly.MinValue), zone);
        var done = await db.Tasks.AsNoTracking().CountAsync(t => t.AssigneeId == me && t.CompletedAt >= dayStart && t.CompletedAt < dayEnd, ct)
                   + await db.WorkTasks.AsNoTracking().CountAsync(t => t.AssigneeId == me && t.CompletedAt >= dayStart && t.CompletedAt < dayEnd, ct);
        var logged = await db.TimeEntries.AsNoTracking().Where(e => e.UserId == me && e.WorkDate == row.Date).SumAsync(e => (int?)e.Minutes, ct) ?? 0;
        var dto = ToDto(row, await NameAsync(me, ct), zone);
        return new AttendanceCheckOutDto(dto, dto.Minutes, done, logged);
    }

    /// <summary>Correct one's own day: today only (yesterday's late check-out included), times on the organization's clock and never in the future.</summary>
    public async Task<AttendanceDto> CorrectAsync(DateOnly date, CorrectAttendanceRequest req, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var (_, zone) = await OrgAsync(ct);
        var policy = await PolicyAsync(ct);
        var today = clock.TodayIn(zone);
        if (date != today) throw new ForbiddenException("Only today's check-in can be changed. Ask your manager to correct an earlier day.", "ATTENDANCE_LOCKED");
        var row = await db.AttendanceDays.FirstOrDefaultAsync(a => a.UserId == me && a.Date == date, ct) ?? throw new NotFoundException("You have not checked in on that day.", "ATTENDANCE_NOT_FOUND");
        var before = new { row.Mode, row.Place, row.Note, row.CheckInAt, row.CheckOutAt };
        if (req.Mode is not null) row.Mode = ParseMode(req.Mode, policy);
        if (req.Place is not null || req.Mode is not null) row.Place = row.Mode == "ClientSite" ? Clean(req.Place ?? row.Place, 120, "place", "Keep the place to 120 characters.") : null;
        if (row.Mode == "ClientSite" && row.Place is null && policy.RequireClientPlace) throw new ValidationException("place", "Say which client or place.");
        if (req.Note is not null) row.Note = Clean(req.Note, 300, "note", "Keep the note to 300 characters.");
        DateTime At(string text, string field)
        {
            if (!ZoneTime.TryParseTime(text, out var t)) throw new ValidationException(field, "Use a time like 09:15.");
            return ZoneTime.ToUtc(ZoneTime.At(date, t), zone);
        }
        if (!string.IsNullOrWhiteSpace(req.CheckIn)) row.CheckInAt = At(req.CheckIn, "checkIn");
        if (req.CheckOut is not null) row.CheckOutAt = string.IsNullOrWhiteSpace(req.CheckOut) ? null : At(req.CheckOut, "checkOut");
        if (row.CheckInAt > clock.Now.AddMinutes(1)) throw new ValidationException("checkIn", "The check-in cannot be in the future.");
        if (row.CheckOutAt is { } o)
        {
            if (o <= row.CheckInAt) throw new ValidationException("checkOut", "The check-out must be after the check-in.");
            if (o > clock.Now.AddMinutes(1)) throw new ValidationException("checkOut", "The check-out cannot be in the future.");
        }
        row.AutoClosed = row.AutoClosed && req.CheckOut is null;
        row.UpdatedAt = clock.Now; row.UpdatedBy = me;
        recorder.Audit("attendance.corrected", nameof(AttendanceDay), row.Id, oldValue: before, newValue: new { row.Mode, row.Place, row.Note, row.CheckInAt, row.CheckOutAt });
        await db.SaveChangesAsync(ct);
        return ToDto(row, await NameAsync(me, ct), zone);
    }

    // ------------------------------------------------------------------ calendar, reports and the team

    /// <summary>Days in a window: one's own (scope me), or the people one may see (scope team: the reporting line; everyone for owners and admins).</summary>
    public async Task<IReadOnlyList<AttendanceDto>> ListAsync(DateOnly from, DateOnly to, string? scope, Guid? userId, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var (_, zone) = await OrgAsync(ct);
        if (to < from) throw new ValidationException("to", "The end date must not be before the start date.");
        if (to.DayNumber - from.DayNumber > MaxRangeDays) throw new ValidationException("to", $"Choose a range of at most {MaxRangeDays} days.");
        IReadOnlyCollection<Guid> who;
        if (scope == "team" || userId is { } && userId != me)
        {
            var people = await TeamAsync(ct);
            if (userId is { } one) { if (!people.Contains(one)) throw new ForbiddenException("You can only see the attendance of people in your team.", "PERMISSION_DENIED"); who = [one]; }
            else who = people;
        }
        else who = [me];
        var ids = who.ToList();
        var rows = await db.AttendanceDays.AsNoTracking().Where(a => ids.Contains(a.UserId) && a.Date >= from && a.Date <= to).OrderBy(a => a.Date).ThenBy(a => a.CheckInAt).Take(5000).ToListAsync(ct);
        var names = await NamesAsync(rows.Select(r => r.UserId), ct);
        return rows.Select(r => ToDto(r, names.GetValueOrDefault(r.UserId, ""), zone)).ToList();
    }

    /// <summary>Who is where today: in the office, at home, at a client's, on leave, or not in yet.</summary>
    public async Task<AttendanceTeamTodayDto> TeamTodayAsync(CancellationToken ct = default)
    {
        var (_, zone) = await OrgAsync(ct);
        var people = (await TeamAsync(ct)).ToList();
        var today = clock.TodayIn(zone);
        var rows = await db.AttendanceDays.AsNoTracking().Where(a => people.Contains(a.UserId) && a.Date == today).ToListAsync(ct);
        var leave = (await db.PlannedLeaves.AsNoTracking().Where(l => people.Contains(l.UserId) && l.WorkDate == today).Select(l => l.UserId).ToListAsync(ct)).ToHashSet();
        var names = await NamesAsync(people, ct);
        var list = people.Select(p =>
        {
            var r = rows.FirstOrDefault(x => x.UserId == p);
            var status = r is not null ? r.Mode : leave.Contains(p) ? "Leave" : "NotIn";
            return new AttendancePersonDto(p, names.GetValueOrDefault(p, ""), status, r?.Place, r is null ? null : LocalHm(r.CheckInAt, zone), r?.CheckOutAt is { } o ? LocalHm(o, zone) : null);
        }).OrderBy(x => x.Status == "NotIn").ThenBy(x => x.Name).ToList();
        return new AttendanceTeamTodayDto(today, list.Count(x => x.Status == "Office"), list.Count(x => x.Status == "Home"), list.Count(x => x.Status == "ClientSite"),
            list.Count(x => x.Status == "Leave"), list.Count(x => x.Status == "NotIn"), list);
    }

    private async Task<HashSet<Guid>> TeamAsync(CancellationToken ct)
    {
        var me = ctx.RequireUserId(); var tid = ctx.RequireTenantId();
        if (ctx.Role is TenantRole.Owner or TenantRole.Admin)
            return (await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid && m.Role != TenantRole.Guest).Select(m => m.UserId).ToListAsync(ct)).ToHashSet();
        var line = await reporting.ReportsOfAsync(me, tid, ct);
        if (line.Count == 0) throw new ForbiddenException("Only managers can see their team's attendance.", "PERMISSION_DENIED");
        return line.Keys.Append(me).ToHashSet();
    }

    // ------------------------------------------------------------------ settings

    public async Task<AttendancePolicyDto> GetPolicyAsync(CancellationToken ct = default)
    {
        var (_, zone) = await OrgAsync(ct);
        return ToDto(await PolicyAsync(ct), zone);
    }

    public async Task<AttendancePolicyDto> SavePolicyAsync(SaveAttendancePolicyRequest req, CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        if (ctx.ViaApiKey) throw new ForbiddenException("API keys cannot change attendance settings.", "API_KEY_NOT_ALLOWED");
        if (ctx.Role is not (TenantRole.Owner or TenantRole.Admin)) throw new ForbiddenException("Only owners and admins can change attendance settings.", "PERMISSION_DENIED");
        var (_, zone) = await OrgAsync(ct);
        var p = await db.AttendancePolicies.FirstOrDefaultAsync(x => x.TenantId == tid, ct);
        if (p is null) { p = new AttendancePolicy { TenantId = tid, CreatedAt = clock.Now, CreatedBy = ctx.UserId }; db.AttendancePolicies.Add(p); }
        if (req.Enabled is { } en) p.Enabled = en;
        if (req.HoursSource is { } hs)
        {
            if (hs is not ("workspace" or "personal")) throw new ValidationException("hoursSource", "Choose workspace or personal hours.");
            p.HoursSource = hs;
        }
        if (req.WorkDays is { } wd)
        {
            var days = WorkCalendar.ParseNumbers(wd, 1, 7);
            if (days.Count == 0) throw new ValidationException("workDays", "Pick at least one working day.");
            p.WorkDays = string.Join(",", days);
        }
        TimeOnly T(string text, string field) => ZoneTime.TryParseTime(text, out var t) ? t : throw new ValidationException(field, "Use a time like 09:30.");
        if (req.WorkStart is { } ws) p.WorkStart = T(ws, "workStart");
        if (req.WorkEnd is { } we) p.WorkEnd = T(we, "workEnd");
        if (p.WorkEnd <= p.WorkStart) throw new ValidationException("workEnd", "The day must end after it starts.");
        if (req.CheckInGraceMinutes is { } gi) p.CheckInGraceMinutes = gi is >= 0 and <= 240 ? gi : throw new ValidationException("checkInGraceMinutes", "Choose 0 to 240 minutes.");
        if (req.CheckOutGraceMinutes is { } go) p.CheckOutGraceMinutes = go is >= 0 and <= 240 ? go : throw new ValidationException("checkOutGraceMinutes", "Choose 0 to 240 minutes.");
        if (req.AutoClose is { } ac) p.AutoClose = ac;
        if (req.AutoCloseAfterHours is { } ah) p.AutoCloseAfterHours = ah is >= 1 and <= 12 ? ah : throw new ValidationException("autoCloseAfterHours", "Choose 1 to 12 hours.");
        if (req.AllowedModes is { } am)
        {
            var modes = am.Where(m => Modes.Contains(m)).Distinct().ToList();
            if (modes.Count == 0) throw new ValidationException("allowedModes", "Allow at least one way of working.");
            p.AllowedModes = string.Join(",", Modes.Where(modes.Contains));
        }
        if (req.RequireClientPlace is { } rp) p.RequireClientPlace = rp;
        if (req.PromptAtSignIn is { } ps) p.PromptAtSignIn = ps;
        p.UpdatedAt = clock.Now; p.UpdatedBy = ctx.UserId;
        recorder.Audit("attendance.settings_changed", nameof(AttendancePolicy), p.Id, newValue: new { p.Enabled, p.HoursSource, p.WorkDays, p.WorkStart, p.WorkEnd, p.AllowedModes, p.AutoClose });
        await db.SaveChangesAsync(ct);
        return ToDto(p, zone);
    }

    // ------------------------------------------------------------------ helpers

    private static string ParseMode(string? mode, AttendancePolicy p)
    {
        var m = Modes.FirstOrDefault(x => string.Equals(x, mode?.Trim(), StringComparison.OrdinalIgnoreCase))
                ?? throw new ValidationException("mode", "Choose Office, Home or ClientSite.");
        if (!AllowedOf(p).Contains(m)) throw new ValidationException("mode", "Your workspace does not allow that way of working.");
        return m;
    }

    private static string? Clean(string? text, int max, string field, string message)
    {
        var t = string.IsNullOrWhiteSpace(text) ? null : text.Trim();
        if (t is { Length: var n } && n > max) throw new ValidationException(field, message);
        return t;
    }

    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max];

    private async Task<string> NameAsync(Guid id, CancellationToken ct) => await db.Users.AsNoTracking().Where(u => u.Id == id).Select(u => u.DisplayName).FirstOrDefaultAsync(ct) ?? "";

    private async Task<Dictionary<Guid, string>> NamesAsync(IEnumerable<Guid> ids, CancellationToken ct)
    {
        var list = ids.Distinct().ToList();
        return await db.Users.AsNoTracking().Where(u => list.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
    }
}
