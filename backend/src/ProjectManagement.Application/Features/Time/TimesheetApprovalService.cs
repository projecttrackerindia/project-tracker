using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Organization;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Time;

/// <summary>One person's week: whether it has been sent for approval, what happened to it, and what the caller may do about it.</summary>
public record TimesheetWeekDto(DateOnly WeekStart, DateOnly WeekEnd, Guid UserId, string Status, int TotalMinutes, int BillableMinutes, string? Note,
    DateTime? SubmittedAt, UserRefDto? Reviewer, DateTime? ReviewedAt, string? ReviewNote, bool Locked, bool CanSubmit, bool CanWithdraw, bool CanReview,
    Guid? Id, bool Entitled);
public record SubmitTimesheetRequest(DateOnly WeekStart, string? Note);
public record ReviewTimesheetRequest(string? Note);
/// <summary>A row of the approvals view. <see cref="Status"/> is NotSubmitted, Submitted, Approved or Rejected; minutes are live for
/// weeks nobody has submitted and the submitted snapshot otherwise.</summary>
public record ApprovalRowDto(Guid? Id, UserRefDto User, DateOnly WeekStart, string Status, int TotalMinutes, int BillableMinutes, string? Note,
    DateTime? SubmittedAt, UserRefDto? Reviewer, DateTime? ReviewedAt, string? ReviewNote);
public record ApprovalsDto(DateOnly WeekStart, bool Entitled, IReadOnlyList<ApprovalRowDto> Week, IReadOnlyList<ApprovalRowDto> Pending);

/// <summary>
/// Weekly timesheet approval. A person submits a Monday-to-Sunday week; their managers (anyone above them in the reporting line) or
/// someone with broad reports access approves it or returns it with a reason. A submitted or approved week is locked - no time can be
/// logged, changed or removed in it - until it is returned or withdrawn, so payroll and invoices see the same numbers the reviewer did.
/// Nobody reviews their own week.
/// </summary>
public class TimesheetApprovalService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, PermissionService permissions,
    EntitlementService entitlements, ReportingLineService reporting, NotificationService notifications)
{
    public const string NotSubmitted = "NotSubmitted";
    private const int MaxPending = 500;

    /// <summary>The Monday of the week <paramref name="d"/> falls in.</summary>
    public static DateOnly WeekOf(DateOnly d) => d.AddDays(-(((int)d.DayOfWeek + 6) % 7));

    private static bool Locks(TimesheetStatus s) => s is TimesheetStatus.Submitted or TimesheetStatus.Approved;

    private async Task<bool> EntitledAsync(CancellationToken ct) => await entitlements.GetValueAsync(FeatureKeys.ResourceManagement, ct) > 0;

    // ------------------------------------------------------------------ locking (used by time tracking)

    /// <summary>Refuses a change to time on <paramref name="date"/> when that week of <paramref name="userId"/> is submitted or approved.</summary>
    public async Task EnsureOpenAsync(Guid userId, DateOnly date, CancellationToken ct = default)
    {
        var week = WeekOf(date);
        var status = await db.TimesheetApprovals.Where(a => a.UserId == userId && a.WeekStart == week).Select(a => (TimesheetStatus?)a.Status).FirstOrDefaultAsync(ct);
        if (status is { } s && Locks(s))
            throw new ConflictException(s == TimesheetStatus.Approved
                ? $"The week of {week:dd MMM} is approved, so its time cannot change. Ask a reviewer to return it first."
                : $"The week of {week:dd MMM} has been submitted for approval. Withdraw it first to change its time.", "TIMESHEET_LOCKED");
    }

    /// <summary>The (person, Monday) pairs among <paramref name="keys"/> whose week is locked.</summary>
    public async Task<HashSet<(Guid User, DateOnly Week)>> LockedWeeksAsync(IEnumerable<(Guid User, DateOnly Date)> keys, CancellationToken ct = default)
    {
        var wanted = keys.Select(k => (k.User, Week: WeekOf(k.Date))).Distinct().ToList();
        if (wanted.Count == 0) return [];
        var users = wanted.Select(w => w.User).Distinct().ToList();
        var weeks = wanted.Select(w => w.Week).Distinct().ToList();
        var rows = await db.TimesheetApprovals.AsNoTracking()
            .Where(a => users.Contains(a.UserId) && weeks.Contains(a.WeekStart) && (a.Status == TimesheetStatus.Submitted || a.Status == TimesheetStatus.Approved))
            .Select(a => new { a.UserId, a.WeekStart }).ToListAsync(ct);
        return rows.Select(r => (r.UserId, r.WeekStart)).ToHashSet();
    }

    // ------------------------------------------------------------------ who may do what

    private async Task<bool> CanReviewAsync(Guid userId, CancellationToken ct) =>
        userId != ctx.UserId && (await reporting.IsInMyLineAsync(userId, ct) || await permissions.HasBroadReportsAccessAsync(ct));

    private async Task RequireReviewerAsync(Guid userId, CancellationToken ct)
    {
        if (userId == ctx.UserId) throw new ForbiddenException("You cannot approve your own timesheet.", "PERMISSION_DENIED");
        if (!await CanReviewAsync(userId, ct)) throw new ForbiddenException("Only this person's managers, or someone with access to everyone's reports, can review their timesheet.", "PERMISSION_DENIED");
    }

    private async Task<(int Total, int Billable, bool Running)> TotalsAsync(Guid userId, DateOnly week, CancellationToken ct)
    {
        var end = week.AddDays(6);
        var rows = await db.TimeEntries.AsNoTracking().Where(e => e.UserId == userId && e.WorkDate >= week && e.WorkDate <= end)
            .Select(e => new { e.Minutes, e.Billable, Running = e.StartedAt != null && e.EndedAt == null }).ToListAsync(ct);
        return (rows.Where(r => !r.Running).Sum(r => r.Minutes), rows.Where(r => !r.Running && r.Billable).Sum(r => r.Minutes), rows.Any(r => r.Running));
    }

    private async Task<Dictionary<Guid, string>> NamesAsync(IEnumerable<Guid?> ids, CancellationToken ct)
    {
        var list = ids.Where(x => x != null).Select(x => x!.Value).Distinct().ToList();
        return list.Count == 0 ? [] : await db.Users.AsNoTracking().Where(u => list.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
    }

    // ------------------------------------------------------------------ one week

    public async Task<TimesheetWeekDto> WeekAsync(DateOnly? weekStart, Guid? userId, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var who = userId ?? me;
        var reviewer = who != me && await CanReviewAsync(who, ct);
        if (who != me && !reviewer) throw new ForbiddenException("You can only see the timesheets of people in your reporting line.", "PERMISSION_DENIED");
        var week = WeekOf(weekStart ?? clock.Today);
        var row = await db.TimesheetApprovals.AsNoTracking().FirstOrDefaultAsync(a => a.UserId == who && a.WeekStart == week, ct);
        var entitled = await EntitledAsync(ct);
        var names = await NamesAsync([row?.ReviewerId], ct);
        int total, billable;
        if (row is null || row.Status == TimesheetStatus.Rejected) (total, billable, _) = await TotalsAsync(who, week, ct);
        else (total, billable) = (row.TotalMinutes, row.BillableMinutes);
        var status = row?.Status.ToString() ?? NotSubmitted;
        var mine = who == me;
        return new TimesheetWeekDto(week, week.AddDays(6), who, status, total, billable, row?.Note, row?.SubmittedAt,
            row?.ReviewerId is { } r && names.TryGetValue(r, out var n) ? new UserRefDto(r, n) : null, row?.ReviewedAt, row?.ReviewNote,
            row is not null && Locks(row.Status),
            CanSubmit: entitled && mine && week <= WeekOf(clock.Today) && (row is null || row.Status == TimesheetStatus.Rejected),
            CanWithdraw: mine && row?.Status == TimesheetStatus.Submitted,
            CanReview: entitled && reviewer && row is not null && row.Status != TimesheetStatus.Rejected,
            row?.Id, entitled);
    }

    public async Task<TimesheetWeekDto> SubmitAsync(SubmitTimesheetRequest req, CancellationToken ct = default)
    {
        await entitlements.EnsureFeatureAsync(FeatureKeys.ResourceManagement, ct);
        var me = ctx.RequireUserId(); var tid = ctx.RequireTenantId();
        var week = WeekOf(req.WeekStart);
        if (week > WeekOf(clock.Today)) throw new ValidationException("weekStart", "You can only submit this week or earlier weeks.");
        var note = Clean(req.Note);
        var (total, billable, running) = await TotalsAsync(me, week, ct);
        if (running) throw new ConflictException("Stop the timer running in this week before submitting it.", "TIMER_RUNNING");

        var row = await db.TimesheetApprovals.FirstOrDefaultAsync(a => a.UserId == me && a.WeekStart == week, ct);
        if (row is not null && Locks(row.Status))
            throw new ConflictException(row.Status == TimesheetStatus.Approved ? "This week is already approved." : "This week is already waiting for approval.", "TIMESHEET_LOCKED");
        var now = clock.Now;
        if (row is null)
        {
            row = new TimesheetApproval { TenantId = tid, UserId = me, WeekStart = week, CreatedAt = now, CreatedBy = me };
            db.TimesheetApprovals.Add(row);
        }
        row.Status = TimesheetStatus.Submitted; row.TotalMinutes = total; row.BillableMinutes = billable; row.Note = note; row.SubmittedAt = now;
        row.ReviewerId = null; row.ReviewedAt = null; row.ReviewNote = null; row.UpdatedAt = now; row.UpdatedBy = me;
        recorder.Activity("timesheet.submitted", "Timesheet", row.Id, $"Submitted the week of {week:dd MMM yyyy} for approval ({TimeService.Format(total)})");

        // Tell whoever reviews it: the person's manager, or the organization's Owner and Admins when nobody is above them.
        var name = await db.Users.Where(u => u.Id == me).Select(u => u.DisplayName).FirstAsync(ct);
        var manager = await db.TenantMembers.Where(m => m.TenantId == tid && m.UserId == me).Select(m => m.ReportsToUserId).FirstOrDefaultAsync(ct);
        var reviewers = manager is { } boss ? [boss]
            : await db.TenantMembers.Where(m => m.TenantId == tid && (m.Role == TenantRole.Owner || m.Role == TenantRole.Admin) && m.UserId != me).Select(m => m.UserId).Take(20).ToListAsync(ct);
        foreach (var r in reviewers)
            await notifications.AddAsync(r, NotificationType.Approval, $"{name} submitted a timesheet", $"Week of {week:dd MMM yyyy} · {TimeService.Format(total)} logged",
                $"/timesheet/approvals?week={week:yyyy-MM-dd}", ct: ct);
        await db.SaveChangesAsync(ct);
        return await WeekAsync(week, me, ct);
    }

    public async Task<TimesheetWeekDto> WithdrawAsync(DateOnly weekStart, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var week = WeekOf(weekStart);
        var row = await db.TimesheetApprovals.FirstOrDefaultAsync(a => a.UserId == me && a.WeekStart == week, ct)
            ?? throw new NotFoundException("This week has not been submitted.", "TIMESHEET_NOT_FOUND");
        if (row.Status != TimesheetStatus.Submitted) throw new ConflictException(row.Status == TimesheetStatus.Approved
            ? "An approved week cannot be withdrawn. Ask a reviewer to return it." : "Only a week that is waiting for approval can be withdrawn.", "TIMESHEET_NOT_PENDING");
        db.TimesheetApprovals.Remove(row);
        recorder.Activity("timesheet.withdrawn", "Timesheet", row.Id, $"Withdrew the week of {week:dd MMM yyyy} from approval");
        await db.SaveChangesAsync(ct);
        return await WeekAsync(week, me, ct);
    }

    public async Task<TimesheetWeekDto> ApproveAsync(Guid id, ReviewTimesheetRequest req, CancellationToken ct = default) => await ReviewAsync(id, true, req.Note, ct);

    public async Task<TimesheetWeekDto> RejectAsync(Guid id, ReviewTimesheetRequest req, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(req.Note)) throw new ValidationException("note", "Say why it is being returned, so they know what to fix.");
        return await ReviewAsync(id, false, req.Note, ct);
    }

    private async Task<TimesheetWeekDto> ReviewAsync(Guid id, bool approve, string? note, CancellationToken ct)
    {
        await entitlements.EnsureFeatureAsync(FeatureKeys.ResourceManagement, ct);
        var row = await db.TimesheetApprovals.FirstOrDefaultAsync(a => a.Id == id, ct) ?? throw new NotFoundException("Timesheet not found.", "TIMESHEET_NOT_FOUND");
        await RequireReviewerAsync(row.UserId, ct);
        if (approve && row.Status != TimesheetStatus.Submitted)
            throw new ConflictException(row.Status == TimesheetStatus.Approved ? "This week is already approved." : "This week was returned; it can be approved once it is submitted again.", "TIMESHEET_NOT_PENDING");
        if (!approve && row.Status == TimesheetStatus.Rejected) throw new ConflictException("This week has already been returned.", "TIMESHEET_NOT_PENDING");

        var me = ctx.RequireUserId();
        var was = row.Status;
        row.Status = approve ? TimesheetStatus.Approved : TimesheetStatus.Rejected;
        row.ReviewerId = me; row.ReviewedAt = clock.Now; row.ReviewNote = Clean(note); row.UpdatedAt = clock.Now; row.UpdatedBy = me;
        var person = await db.Users.Where(u => u.Id == row.UserId).Select(u => u.DisplayName).FirstOrDefaultAsync(ct) ?? "someone";
        recorder.Activity(approve ? "timesheet.approved" : "timesheet.rejected", "Timesheet", row.Id,
            $"{(approve ? "Approved" : was == TimesheetStatus.Approved ? "Reopened" : "Returned")} {person}'s week of {row.WeekStart:dd MMM yyyy}");
        if (was == TimesheetStatus.Approved) recorder.Audit("timesheet.reopened", "Timesheet", row.Id, new { row.UserId, row.WeekStart }, new { row.ReviewNote });
        var reviewer = await db.Users.Where(u => u.Id == me).Select(u => u.DisplayName).FirstAsync(ct);
        await notifications.AddAsync(row.UserId, NotificationType.Approval,
            approve ? $"Your timesheet for the week of {row.WeekStart:dd MMM} was approved" : $"Your timesheet for the week of {row.WeekStart:dd MMM} was returned",
            approve ? $"Approved by {reviewer}{(row.ReviewNote is null ? "" : $": {row.ReviewNote}")}" : $"{reviewer}: {row.ReviewNote}",
            $"/timesheet?week={row.WeekStart:yyyy-MM-dd}", ct: ct);
        await db.SaveChangesAsync(ct);
        return await WeekAsync(row.WeekStart, row.UserId, ct);
    }

    // ------------------------------------------------------------------ the reviewer's view

    /// <summary>
    /// For one week, everyone the caller reviews (their reporting line, or every member with broad reports access) and where their
    /// timesheet stands; plus every submission still waiting for the caller, whatever week it is for.
    /// </summary>
    public async Task<ApprovalsDto> ApprovalsAsync(DateOnly? weekStart, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId(); var tid = ctx.RequireTenantId();
        var week = WeekOf(weekStart ?? clock.Today.AddDays(-7));
        var broad = await permissions.HasBroadReportsAccessAsync(ct);
        var people = broad
            ? await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid && m.Role != TenantRole.Guest && m.UserId != me).Select(m => m.UserId).Take(1000).ToListAsync(ct)
            : (await reporting.ReportsOfAsync(me, tid, ct)).Keys.ToList();
        if (people.Count == 0 && !broad) throw new ForbiddenException("Nobody's timesheet is yours to review.", "PERMISSION_DENIED");

        var end = week.AddDays(6);
        var rows = await db.TimesheetApprovals.AsNoTracking().Where(a => people.Contains(a.UserId) && a.WeekStart == week).ToListAsync(ct);
        var live = await db.TimeEntries.AsNoTracking().Where(e => people.Contains(e.UserId) && e.WorkDate >= week && e.WorkDate <= end && !(e.StartedAt != null && e.EndedAt == null))
            .GroupBy(e => e.UserId).Select(g => new { g.Key, Total = g.Sum(x => x.Minutes), Billable = g.Sum(x => x.Billable ? x.Minutes : 0) }).ToDictionaryAsync(x => x.Key, ct);
        var pending = await db.TimesheetApprovals.AsNoTracking().Where(a => people.Contains(a.UserId) && a.Status == TimesheetStatus.Submitted)
            .OrderBy(a => a.WeekStart).ThenBy(a => a.SubmittedAt).Take(MaxPending).ToListAsync(ct);
        var names = await NamesAsync(people.Select(p => (Guid?)p).Concat(rows.Select(r => r.ReviewerId)), ct);

        UserRefDto Ref(Guid id) => new(id, names.GetValueOrDefault(id) ?? "Unknown");
        ApprovalRowDto ToRow(TimesheetApproval a) => new(a.Id, Ref(a.UserId), a.WeekStart, a.Status.ToString(),
            a.Status == TimesheetStatus.Rejected ? live.GetValueOrDefault(a.UserId)?.Total ?? 0 : a.TotalMinutes,
            a.Status == TimesheetStatus.Rejected ? live.GetValueOrDefault(a.UserId)?.Billable ?? 0 : a.BillableMinutes,
            a.Note, a.SubmittedAt, a.ReviewerId is { } r ? Ref(r) : null, a.ReviewedAt, a.ReviewNote);

        var byUser = rows.ToDictionary(r => r.UserId);
        var weekRows = people.Select(p => byUser.TryGetValue(p, out var a) ? ToRow(a)
                : new ApprovalRowDto(null, Ref(p), week, NotSubmitted, live.GetValueOrDefault(p)?.Total ?? 0, live.GetValueOrDefault(p)?.Billable ?? 0, null, null, null, null, null))
            .OrderBy(r => r.Status switch { "Submitted" => 0, NotSubmitted => 1, "Rejected" => 2, _ => 3 }).ThenBy(r => r.User.Name).ToList();
        // Pending submissions for other weeks carry their own snapshot (the live totals above are for the chosen week only).
        var pendingRows = pending.Select(a => new ApprovalRowDto(a.Id, Ref(a.UserId), a.WeekStart, a.Status.ToString(), a.TotalMinutes, a.BillableMinutes, a.Note, a.SubmittedAt, null, null, null)).ToList();
        return new ApprovalsDto(week, await EntitledAsync(ct), weekRows, pendingRows);
    }

    private static string? Clean(string? note)
    {
        var t = note?.Trim();
        if (string.IsNullOrEmpty(t)) return null;
        return t.Length > 500 ? t[..500] : t;
    }
}
