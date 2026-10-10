using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Ai;

public record SetAiBudgetRequest(string Scope, Guid SubjectId, long MonthlyLimit, bool Enabled = true);
public record AiBudgetDto(Guid Id, string Scope, Guid SubjectId, string Name, long MonthlyLimit, bool Enabled, int Version, long Spent, long Reserved);

public class AiCreditBudgetService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder)
{
    private void Authorize()
    {
        ctx.RequireTenantId(); ctx.RequireUserId();
        if (ctx.Role is not (TenantRole.Owner or TenantRole.Admin))
            throw new ForbiddenException("Only owners and admins may manage AI budgets.", "PERMISSION_DENIED");
    }

    public async Task<IReadOnlyList<AiBudgetDto>> ListAsync(CancellationToken ct)
    {
        Authorize();
        var period = new DateTime(clock.Now.Year, clock.Now.Month, 1, 0, 0, 0, DateTimeKind.Utc);
        var budgets = await db.AiCreditBudgets.AsNoTracking().OrderBy(b => b.Scope).ThenBy(b => b.SubjectId).Take(500).ToListAsync(ct);
        var ids = budgets.Select(b => b.SubjectId).ToList();
        var tid = ctx.RequireTenantId();
        var users = await db.TenantMembers.Where(m => m.TenantId == tid && ids.Contains(m.UserId)).Select(m => new { m.UserId, m.User!.DisplayName }).ToDictionaryAsync(m => m.UserId, m => m.DisplayName, ct);
        var teams = await db.Teams.Where(t => ids.Contains(t.Id)).ToDictionaryAsync(t => t.Id, t => t.Name, ct);
        var account = await db.AiCreditAccounts.AsNoTracking().FirstOrDefaultAsync(a => a.PeriodStart == period, ct);
        var usages = account is null ? [] : await db.AiCreditBudgetUsages.AsNoTracking().Where(u => u.AccountId == account.Id).ToListAsync(ct);
        return budgets.Select(b => { var u = usages.FirstOrDefault(u => u.BudgetId == b.Id);
            return new AiBudgetDto(b.Id, b.Scope, b.SubjectId, b.Scope == "user" ? users.GetValueOrDefault(b.SubjectId, "Former member") : teams.GetValueOrDefault(b.SubjectId, "Former team"),
                b.MonthlyLimit, b.Enabled, b.Version, u?.Spent ?? 0, u?.Reserved ?? 0); }).ToList();
    }

    public async Task SetAsync(SetAiBudgetRequest req, CancellationToken ct)
    {
        Authorize();
        if (req.Scope is not ("user" or "team")) throw new ValidationException("scope", "Choose user or team.");
        if (req.MonthlyLimit is < 0 or > 1_000_000_000) throw new ValidationException("monthlyLimit", "Use a non-negative credit cap up to one billion.");
        var exists = req.Scope == "user" ? await db.TenantMembers.AnyAsync(m => m.TenantId == ctx.RequireTenantId() && m.UserId == req.SubjectId, ct) : await db.Teams.AnyAsync(t => t.Id == req.SubjectId, ct);
        if (!exists) throw new NotFoundException("Budget subject not found in this workspace.");
        await using var tx = await db.Database.BeginOwnedTransactionAsync(ct);
        if (await db.LockTenantLedgerAsync(ctx.RequireTenantId(), ct) != 1) throw new NotFoundException("Workspace not found.");
        var row = await db.AiCreditBudgets.FirstOrDefaultAsync(b => b.Scope == req.Scope && b.SubjectId == req.SubjectId, ct);
        if (row is null) db.AiCreditBudgets.Add(row = new AiCreditBudget { TenantId = ctx.RequireTenantId(), Scope = req.Scope, SubjectId = req.SubjectId });
        else row.Version++;
        row.MonthlyLimit = req.MonthlyLimit; row.Enabled = req.Enabled;
        recorder.Audit("ai.budget_changed", "AiCreditBudget", row.Id, null, new { row.Scope, row.SubjectId, row.MonthlyLimit, row.Enabled, row.Version });
        await db.SaveChangesAsync(ct); await tx.CommitIfOwnedAsync(ct);
    }
}
