using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Ai;

public record AiCreditBalance(string Month, long Limit, long Spent, long Reserved, long Available, bool Unlimited);

/// <summary>Short tenant-row locks serialize ledger changes across replicas. Model calls never hold this lock.</summary>
public class AiCreditService(IAppDbContext db, ICurrentContext ctx, AppClock clock, EntitlementService entitlements)
{
    private DateTime Period => new(clock.Now.Year, clock.Now.Month, 1, 0, 0, 0, DateTimeKind.Utc);

    public async Task<AiCreditBalance> BalanceAsync(CancellationToken ct = default)
    {
        ctx.RequireTenantId();
        var limit = await entitlements.GetValueAsync(FeatureKeys.AiMonthlyCredits, ct);
        var account = await db.AiCreditAccounts.AsNoTracking().FirstOrDefaultAsync(a => a.PeriodStart == Period, ct);
        var spent = account?.Spent ?? await LegacySpentAsync(ct);
        var reserved = account?.Reserved ?? 0;
        return new(Period.ToString("yyyy-MM"), limit, spent, reserved, limit < 0 ? -1 : Math.Max(0, limit - spent - reserved), limit < 0);
    }

    private Task<long> LegacySpentAsync(CancellationToken ct) => db.AiMessages
        .Where(m => m.Role == "assistant" && m.CreatedAt >= Period && m.CreatedAt < Period.AddMonths(1))
        .SumAsync(m => (long)m.Credits, ct);

    private async Task LockAsync(CancellationToken ct)
    {
        var tid = ctx.RequireTenantId();
        // No-op UPDATE acquires a transaction row lock in PostgreSQL and a write lock in SQLite.
        if (await db.LockTenantLedgerAsync(tid, ct) != 1)
            throw new NotFoundException("Workspace not found.");
    }

    public async Task<AiCreditLease> ReserveAsync(Guid operationId, int amount, string feature, CancellationToken ct = default)
    {
        if (amount <= 0 || amount > 10000 || string.IsNullOrWhiteSpace(feature) || feature.Length > 64)
            throw new ArgumentOutOfRangeException(nameof(amount));
        var tid = ctx.RequireTenantId(); var uid = ctx.RequireUserId();
        await using var tx = await db.Database.BeginOwnedTransactionAsync(ct);
        await LockAsync(ct);
        var existing = await db.AiCreditReservations.AsNoTracking().FirstOrDefaultAsync(r => r.OperationId == operationId, ct);
        if (existing is not null)
        {
            if (existing.UserId != uid || existing.Amount != amount || existing.Feature != feature)
                throw new ConflictException("This operation belongs to different usage.", "AI_CREDIT_KEY_MISMATCH");
            // A replay must not invoke a provider twice, even while the first run is still active.
            throw new ConflictException("This AI operation was already admitted. Check its saved result.", "AI_OPERATION_ALREADY_ADMITTED");
        }
        await ExpireAsync(ct);
        var account = await db.AiCreditAccounts.AsNoTracking().FirstOrDefaultAsync(a => a.PeriodStart == Period, ct);
        if (account is null)
        {
            account = new AiCreditAccount { TenantId = tid, PeriodStart = Period, Spent = await LegacySpentAsync(ct) };
            db.AiCreditAccounts.Add(account);
            db.AiCreditEntries.Add(new AiCreditEntry { TenantId = tid, AccountId = account.Id, Kind = "opening", SpentDelta = account.Spent, PolicyVersion = "legacy-messages-v1" });
            await db.SaveChangesAsync(ct);
            db.AiCreditAccounts.Entry(account).State = EntityState.Detached;
        }
        var limit = await entitlements.GetValueAsync(FeatureKeys.AiMonthlyCredits, ct);
        if (limit >= 0 && account.Spent + account.Reserved > limit - amount)
            throw new ConflictException("The remaining AI credits are used or reserved by another request. Check usage or wait for active work to finish.", "AI_CREDITS_EXHAUSTED");
        await db.AiCreditAccounts.Where(a => a.Id == account.Id).ExecuteUpdateAsync(s => s.SetProperty(a => a.Reserved, a => a.Reserved + amount), ct);
        var row = new AiCreditReservation { TenantId = tid, AccountId = account.Id, UserId = uid, OperationId = operationId,
            Amount = amount, Feature = feature, ExpiresAt = clock.Now.AddMinutes(20) };
        db.AiCreditReservations.Add(row);
        var teams = await db.TeamMembers.Where(m => m.UserId == uid).Select(m => m.TeamId).ToListAsync(ct);
        if (ctx.TeamLens is { } lens && !teams.Contains(lens)) teams.Add(lens);
        var budgets = await db.AiCreditBudgets.AsNoTracking().Where(b => b.Enabled &&
            (b.Scope == "user" && b.SubjectId == uid || b.Scope == "team" && teams.Contains(b.SubjectId))).ToListAsync(ct);
        foreach (var budget in budgets)
        {
            var usage = await db.AiCreditBudgetUsages.AsNoTracking().FirstOrDefaultAsync(u => u.BudgetId == budget.Id && u.AccountId == account.Id, ct);
            if (usage is null)
            {
                usage = new AiCreditBudgetUsage { TenantId = tid, BudgetId = budget.Id, AccountId = account.Id };
                db.AiCreditBudgetUsages.Add(usage);
                await db.SaveChangesAsync(ct);
                db.AiCreditBudgetUsages.Entry(usage).State = EntityState.Detached;
            }
            if (usage.Spent + usage.Reserved > budget.MonthlyLimit - amount)
                throw new ConflictException("The user or team AI budget is used or reserved. Ask an administrator to review the budget.", "AI_BUDGET_EXHAUSTED");
            await db.AiCreditBudgetUsages.Where(u => u.Id == usage.Id).ExecuteUpdateAsync(s => s.SetProperty(u => u.Reserved, u => u.Reserved + amount), ct);
            db.AiCreditBudgetHolds.Add(new AiCreditBudgetHold { TenantId = tid, ReservationId = row.Id, BudgetUsageId = usage.Id, PolicyVersion = budget.Version });
        }
        db.AiCreditEntries.Add(new AiCreditEntry { TenantId = tid, AccountId = account.Id, ReservationId = row.Id, UserId = uid, Kind = "reservation", ReservedDelta = amount });
        await db.SaveChangesAsync(ct); await tx.CommitIfOwnedAsync(ct);
        return new(this, row.Id, amount);
    }

    private async Task ExpireAsync(CancellationToken ct)
    {
        var rows = await db.AiCreditReservations.AsNoTracking().Where(r => r.Status == "reserved" && r.ExpiresAt <= clock.Now).ToListAsync(ct);
        foreach (var row in rows) await CompleteLockedAsync(row, 0, "expired", ct);
    }

    public async Task RecoverExpiredAsync(CancellationToken ct)
    {
        await using var tx = await db.Database.BeginOwnedTransactionAsync(ct);
        await LockAsync(ct);
        await ExpireAsync(ct);
        await db.SaveChangesAsync(ct); await tx.CommitIfOwnedAsync(ct);
    }

    internal async Task CompleteAsync(Guid id, int charged, CancellationToken ct)
    {
        await using var tx = await db.Database.BeginOwnedTransactionAsync(ct);
        await LockAsync(ct);
        var row = await db.AiCreditReservations.AsNoTracking().SingleAsync(r => r.Id == id && r.UserId == ctx.RequireUserId(), ct);
        if (row.Status == "reserved") await CompleteLockedAsync(row, charged, charged == 0 ? "released" : "settled", ct);
        else if (row.Charged != charged) throw new ConflictException("This usage has already been reconciled.", "AI_CREDIT_SETTLEMENT_MISMATCH");
        // Saves the pending assistant message and audit in the same transaction as its charge.
        await db.SaveChangesAsync(ct); await tx.CommitIfOwnedAsync(ct);
    }

    private async Task CompleteLockedAsync(AiCreditReservation row, int charged, string status, CancellationToken ct)
    {
        if (charged < 0 || charged > row.Amount) throw new ArgumentOutOfRangeException(nameof(charged));
        await db.AiCreditReservations.Where(r => r.Id == row.Id && r.Status == "reserved")
            .ExecuteUpdateAsync(s => s.SetProperty(r => r.Status, status).SetProperty(r => r.Charged, charged).SetProperty(r => r.SettledAt, clock.Now), ct);
        await db.AiCreditAccounts.Where(a => a.Id == row.AccountId)
            .ExecuteUpdateAsync(s => s.SetProperty(a => a.Reserved, a => a.Reserved - row.Amount).SetProperty(a => a.Spent, a => a.Spent + charged), ct);
        var usageIds = await db.AiCreditBudgetHolds.Where(h => h.ReservationId == row.Id).Select(h => h.BudgetUsageId).ToListAsync(ct);
        await db.AiCreditBudgetUsages.Where(u => usageIds.Contains(u.Id))
            .ExecuteUpdateAsync(s => s.SetProperty(u => u.Reserved, u => u.Reserved - row.Amount).SetProperty(u => u.Spent, u => u.Spent + charged), ct);
        db.AiCreditEntries.Add(new AiCreditEntry { TenantId = row.TenantId, AccountId = row.AccountId, ReservationId = row.Id,
            UserId = row.UserId, Kind = status, SpentDelta = charged, ReservedDelta = -row.Amount });
    }
}

public sealed class AiCreditLease(AiCreditService service, Guid id, int amount) : IAsyncDisposable
{
    private bool complete;
    private bool settling;
    public int Amount => amount;
    public async Task SettleAsync(int charged, CancellationToken ct = default)
    {
        if (complete) return;
        settling = true;
        await service.CompleteAsync(id, charged, ct); complete = true;
    }
    public async ValueTask DisposeAsync()
    {
        if (!complete && !settling) await SettleAsync(0, CancellationToken.None);
    }
}
