using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Organization;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Time;

public record PlannedLeaveDto(Guid Id, Guid UserId, DateOnly Date, string? Note, string Status = "Planned");
public record PlanLeaveRequest(IReadOnlyList<Guid> UserIds, DateOnly From, DateOnly To, string? Note, Guid RequestId);

public class PlannedLeaveService(IAppDbContext db, ICurrentContext ctx, AppClock clock, PermissionService permissions,
    ReportingLineService reporting, TimesheetApprovalService approvals, Recorder recorder)
{
    public async Task RequirePersonAsync(Guid user, bool write, CancellationToken ct)
    {
        var tasks = await permissions.LevelAsync(Modules.Tasks, ct);
        var work = await permissions.LevelAsync(Modules.Work, ct);
        var required = write ? AccessLevel.Edit : AccessLevel.View;
        if (tasks < required && work < required) throw new ForbiddenException("Timesheet access is required.");
        if (ctx.Role == TenantRole.Guest) throw new ForbiddenException("Guests cannot access planned leave.");
        if (!await db.TenantMembers.AnyAsync(m => m.UserId == user && m.TenantId == ctx.RequireTenantId(), ct))
            throw new NotFoundException("Person not found in this workspace.");
        if (user != ctx.UserId && ctx.Role is not (TenantRole.Owner or TenantRole.Admin) && !await reporting.IsInMyLineAsync(user, ct))
            throw new ForbiddenException("You can only manage your own leave or the leave of people who report to you.");
    }

    public async Task<IReadOnlyList<PlannedLeaveDto>> ListAsync(Guid? user, DateOnly from, DateOnly to, CancellationToken ct)
    {
        if (to < from || to.DayNumber - from.DayNumber > 92) throw new ValidationException("to", "Choose a range of up to 93 days.");
        var id = user ?? ctx.RequireUserId();
        await RequirePersonAsync(id, false, ct);
        return await db.PlannedLeaves.AsNoTracking().Where(l => l.UserId == id && l.WorkDate >= from && l.WorkDate <= to)
            .OrderBy(l => l.WorkDate).Select(l => new PlannedLeaveDto(l.Id, l.UserId, l.WorkDate, l.Note, "Planned")).ToListAsync(ct);
    }

    public async Task<IReadOnlyList<PlannedLeaveDto>> CreateAsync(PlanLeaveRequest req, CancellationToken ct)
    {
        var people = (req.UserIds ?? []).Distinct().ToArray();
        if (people.Length is < 1 or > 10 || req.RequestId == Guid.Empty) throw new ValidationException("userIds", "Choose one to ten people and a request identity.");
        if (req.To < req.From || req.To.DayNumber - req.From.DayNumber > 30) throw new ValidationException("to", "Choose up to 31 consecutive days.");
        if (req.From < clock.Today || req.To > clock.Today.AddYears(2)) throw new ValidationException("from", "Planned leave must be between today and two years from now.");
        var note = string.IsNullOrWhiteSpace(req.Note) ? null : req.Note.Trim();
        if (note?.Length > 1000) throw new ValidationException("note", "Keep the note under 1000 characters.");
        foreach (var person in people) await RequirePersonAsync(person, true, ct);
        // The tenant ledger lock serializes overlapping requests without adding a new locking service.
        await using var tx = await db.BeginEvidenceSnapshotAsync(ct);
        await db.LockTenantLedgerAsync(ctx.RequireTenantId(), ct);
        var existing = await db.PlannedLeaves.Where(l => l.RequestId == req.RequestId).ToListAsync(ct);
        if (existing.Count > 0)
        {
            if (existing.Count != people.Length * (req.To.DayNumber - req.From.DayNumber + 1)
                || existing.Any(l => !people.Contains(l.UserId) || l.WorkDate < req.From || l.WorkDate > req.To || l.Note != note))
                throw new ConflictException("This request identity belongs to a different leave plan.", "LEAVE_REQUEST_MISMATCH");
            await tx.CommitAsync(ct);
            return existing.Select(Dto).ToList();
        }
        if (await db.PlannedLeaves.IgnoreQueryFilters().AnyAsync(l => l.TenantId == ctx.RequireTenantId() && l.RequestId == req.RequestId, ct))
            throw new ConflictException("This leave request was cancelled. Create a new plan.", "LEAVE_CANCELLED");
        if (await db.PlannedLeaves.AnyAsync(l => people.Contains(l.UserId) && l.WorkDate >= req.From && l.WorkDate <= req.To, ct))
            throw new ConflictException("Some of these dates already have planned leave. Review the timesheet before creating a new plan.", "LEAVE_OVERLAP");
        var days = Enumerable.Range(0, req.To.DayNumber - req.From.DayNumber + 1).Select(n => req.From.AddDays(n)).ToArray();
        if ((await approvals.LockedWeeksAsync(people.SelectMany(person => days.Select(date => (person, date))), ct)).Count > 0)
            throw new ConflictException("Some of these weeks are submitted or approved. Return or withdraw them before changing leave.", "TIMESHEET_LOCKED");
        var rows = new List<PlannedLeave>();
        foreach (var person in people)
            for (var date = req.From; date <= req.To; date = date.AddDays(1))
            {
                rows.Add(new PlannedLeave { TenantId = ctx.RequireTenantId(), UserId = person, WorkDate = date, Note = note, RequestId = req.RequestId });
            }
        db.PlannedLeaves.AddRange(rows);
        recorder.Activity("time.leave_planned", "PlannedLeave", req.RequestId, $"Planned leave for {people.Length} people, {req.From:yyyy-MM-dd} to {req.To:yyyy-MM-dd}");
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return rows.Select(Dto).ToList();
    }

    public async Task CancelAsync(Guid id, CancellationToken ct)
    {
        var row = await db.PlannedLeaves.FirstOrDefaultAsync(l => l.Id == id, ct) ?? throw new NotFoundException("Leave entry not found.");
        await RequirePersonAsync(row.UserId, true, ct);
        await approvals.EnsureOpenAsync(row.UserId, row.WorkDate, ct);
        row.IsDeleted = true; row.DeletedAt = clock.Now; row.DeletedBy = ctx.RequireUserId();
        recorder.Activity("time.leave_cancelled", "PlannedLeave", row.Id, $"Cancelled planned leave on {row.WorkDate:yyyy-MM-dd}");
        await db.SaveChangesAsync(ct);
    }
    private static PlannedLeaveDto Dto(PlannedLeave l) => new(l.Id, l.UserId, l.WorkDate, l.Note);
}
