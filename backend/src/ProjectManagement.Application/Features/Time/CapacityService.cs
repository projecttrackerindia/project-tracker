using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Admin;
using ProjectManagement.Application.Features.Billing;
using ProjectManagement.Application.Features.Organization;
using ProjectManagement.Application.Features.WorkItems;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Time;

public record MemberRateDto(Guid UserId, string Name, string Email, TenantRole Role, decimal WeeklyCapacityHours, bool StandardCapacity, decimal? CostRate, decimal? BillRate);
public record RatesDto(string Currency, bool Entitled, bool CanEdit, IReadOnlyList<MemberRateDto> Members, IReadOnlyList<CurrencyDto> Currencies);
/// <summary>Empty capacity = the standard 40 hours; empty rates = none.</summary>
public record SetMemberRateRequest(decimal? WeeklyCapacityHours, decimal? CostRate, decimal? BillRate);
public record SetCurrencyRequest(string? Currency);

public record UtilisationPersonDto(Guid UserId, string Name, int CapacityMinutes, int LoggedMinutes, int BillableMinutes, int ProjectMinutes, int OperationalMinutes,
    decimal? Utilisation, decimal? BillableShare, decimal? Cost, decimal? BillableValue);
public record UtilisationDto(DateOnly From, DateOnly To, WorkloadScope Scope, IReadOnlyList<WorkloadScope> Available, string Currency, bool ShowMoney, bool Entitled,
    int WorkingDays, IReadOnlyList<UtilisationPersonDto> People, UtilisationPersonDto Totals);

public record ProjectBudgetRequest(bool IsBillable, decimal? BudgetHours, decimal? BudgetAmount, decimal? BillRate);
public record FinancialPersonDto(Guid UserId, string Name, int Minutes, int BillableMinutes, decimal? Cost, decimal? BillableValue);
public record ProjectFinancialsDto(Guid ProjectId, string Currency, bool Entitled, bool CanEdit, bool ShowMoney, bool IsBillable, decimal? BudgetHours, decimal? BudgetAmount,
    decimal? BillRate, int LoggedMinutes, int BillableMinutes, decimal? Cost, decimal? BillableValue, decimal? HoursUsed, decimal? BudgetUsed, decimal? ForecastHours,
    decimal? ForecastCost, int PeopleWithoutCostRate, IReadOnlyList<FinancialPersonDto> ByPerson);

/// <summary>
/// Capacity and cost. Each person has a weekly capacity (40 hours unless set), a cost rate (what an hour costs the organization) and a bill
/// rate (what a billable hour is charged at; a project's own rate wins). From those and the time people log: utilisation (logged against
/// capacity, and the billable share), and per project the hours and money used against its budget with a straight-line forecast.
/// Rates are set by Owners and Admins; money is shown to them and to people with access to everyone's reports; hours to anyone who may
/// see that person's workload or the project. Costs use each person's current rate.
/// </summary>
public class CapacityService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, PermissionService permissions, EntitlementService entitlements,
    ReportingLineService reporting, WorkloadService workload, ProjectAccess access)
{
    public const int StandardWeekMinutes = 40 * 60;
    private const int MaxRangeDays = 92;

    private bool IsAdmin => ctx.Role is TenantRole.Owner or TenantRole.Admin;
    private async Task<bool> EntitledAsync(CancellationToken ct) => await entitlements.GetValueAsync(FeatureKeys.ResourceManagement, ct) > 0;
    private async Task<bool> ShowMoneyAsync(CancellationToken ct) => IsAdmin || await permissions.HasBroadReportsAccessAsync(ct);

    /// <summary>The workspace's currency for budgets and rates: its own choice, or the platform's billing currency.</summary>
    public async Task<string> CurrencyAsync(CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        var own = await db.Tenants.Where(t => t.Id == tid).Select(t => t.CostCurrency).FirstOrDefaultAsync(ct);
        if (!string.IsNullOrEmpty(own)) return own;
        var platform = await db.PlatformSettings.Where(s => s.Key == PlatformService.KeyBillingCurrency).Select(s => s.Value).FirstOrDefaultAsync(ct);
        return Currencies.Normalize(platform);
    }

    /// <summary>Monday-to-Friday days in the range: what capacity is measured over.</summary>
    public static int WorkingDays(DateOnly from, DateOnly to)
    {
        var n = 0;
        for (var d = from; d <= to; d = d.AddDays(1)) if (d.DayOfWeek is not DayOfWeek.Saturday and not DayOfWeek.Sunday) n++;
        return n;
    }

    private static decimal? Money(decimal? v) => v is { } x ? Math.Round(x, 2) : null;
    private static decimal? Ratio(int part, int whole) => whole > 0 ? Math.Round((decimal)part / whole, 4) : null;

    // ------------------------------------------------------------------ rates

    public async Task<RatesDto> RatesAsync(CancellationToken ct = default)
    {
        if (!IsAdmin) throw new ForbiddenException("Only Owners and Admins can see rates.", "PERMISSION_DENIED");
        var tid = ctx.RequireTenantId();
        var rows = await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid && m.Role != TenantRole.Guest)
            .Select(m => new { m.UserId, m.User!.DisplayName, m.User.Email, m.Role, m.WeeklyCapacityMinutes, m.CostRate, m.BillRate })
            .OrderBy(m => m.DisplayName).Take(1000).ToListAsync(ct);
        return new RatesDto(await CurrencyAsync(ct), await EntitledAsync(ct), true,
            rows.Select(m => new MemberRateDto(m.UserId, m.DisplayName, m.Email, m.Role, Math.Round((m.WeeklyCapacityMinutes ?? StandardWeekMinutes) / 60m, 2),
                m.WeeklyCapacityMinutes is null, m.CostRate, m.BillRate)).ToList(), Currencies.All);
    }

    public async Task<RatesDto> SetMemberAsync(Guid userId, SetMemberRateRequest req, CancellationToken ct = default)
    {
        if (!IsAdmin) throw new ForbiddenException("Only Owners and Admins can set rates.", "PERMISSION_DENIED");
        await entitlements.EnsureFeatureAsync(FeatureKeys.ResourceManagement, ct);
        var tid = ctx.RequireTenantId();
        var m = await db.TenantMembers.FirstOrDefaultAsync(x => x.TenantId == tid && x.UserId == userId, ct) ?? throw new NotFoundException("That person is not in this workspace.");
        if (req.WeeklyCapacityHours is { } h && (h < 0 || h > 100)) throw new ValidationException("weeklyCapacityHours", "Weekly capacity must be between 0 and 100 hours.");
        CheckRate(req.CostRate, "costRate"); CheckRate(req.BillRate, "billRate");
        var before = new { m.WeeklyCapacityMinutes, m.CostRate, m.BillRate };
        m.WeeklyCapacityMinutes = req.WeeklyCapacityHours is { } hours ? (int)Math.Round(hours * 60) : null;
        m.CostRate = Money(req.CostRate); m.BillRate = Money(req.BillRate);
        recorder.Audit("member.rates_changed", "TenantMember", m.Id, before, new { m.WeeklyCapacityMinutes, m.CostRate, m.BillRate });
        await db.SaveChangesAsync(ct);
        return await RatesAsync(ct);
    }

    public async Task<RatesDto> SetCurrencyAsync(SetCurrencyRequest req, CancellationToken ct = default)
    {
        if (!IsAdmin) throw new ForbiddenException("Only Owners and Admins can change the currency.", "PERMISSION_DENIED");
        await entitlements.EnsureFeatureAsync(FeatureKeys.ResourceManagement, ct);
        if (!Currencies.IsSupported(req.Currency)) throw new ValidationException("currency", "Choose one of the listed currencies.");
        var tid = ctx.RequireTenantId();
        var tenant = await db.Tenants.FirstAsync(t => t.Id == tid, ct);
        var before = tenant.CostCurrency;
        tenant.CostCurrency = Currencies.Normalize(req.Currency);
        recorder.Audit("workspace.cost_currency", "Tenant", tid, before, tenant.CostCurrency);
        await db.SaveChangesAsync(ct);
        return await RatesAsync(ct);
    }

    private static void CheckRate(decimal? rate, string field)
    {
        if (rate is { } r && (r < 0 || r > 1_000_000)) throw new ValidationException(field, "Enter a rate between 0 and 1,000,000 per hour.");
    }

    // ------------------------------------------------------------------ utilisation

    public async Task<UtilisationDto> UtilisationAsync(DateOnly? from, DateOnly? to, WorkloadScope? requested, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId(); var tid = ctx.RequireTenantId();
        var end = to ?? TimesheetApprovalService.WeekOf(clock.Today).AddDays(6);
        var start = from ?? TimesheetApprovalService.WeekOf(clock.Today).AddDays(-21);
        if (end < start) throw new ValidationException("to", "The end date must not be before the start date.");
        if (end.DayNumber - start.DayNumber > MaxRangeDays) throw new ValidationException("to", $"Choose a range of at most {MaxRangeDays} days.");

        var available = await workload.AvailableAsync(ct);
        var scope = requested ?? available[0];
        if (!available.Contains(scope)) throw new ForbiddenException("You cannot see that group's utilisation.", "PERMISSION_DENIED");
        var entitled = await EntitledAsync(ct);
        var showMoney = await ShowMoneyAsync(ct);
        var currency = await CurrencyAsync(ct);
        var days = WorkingDays(start, end);
        var empty = new UtilisationPersonDto(Guid.Empty, "Total", 0, 0, 0, 0, 0, null, null, null, null);
        if (!entitled) return new UtilisationDto(start, end, scope, available, currency, showMoney, false, days, [], empty);

        var people = scope switch
        {
            WorkloadScope.Reports => (await reporting.ReportsOfAsync(me, tid, ct)).Keys.ToList(),
            WorkloadScope.Everyone => await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid && m.Role != TenantRole.Guest).Select(m => m.UserId).Take(1000).ToListAsync(ct),
            _ => [me],
        };
        var members = await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid && people.Contains(m.UserId))
            .Select(m => new { m.UserId, m.User!.DisplayName, m.WeeklyCapacityMinutes, m.CostRate, m.BillRate }).ToListAsync(ct);
        // Group in the database (person x project x kind x billable), then price in memory.
        var time = await db.TimeEntries.AsNoTracking()
            .Where(e => people.Contains(e.UserId) && e.WorkDate >= start && e.WorkDate <= end && !(e.StartedAt != null && e.EndedAt == null))
            .GroupBy(e => new { e.UserId, e.ProjectId, OnWork = e.WorkTaskId != null, e.Billable })
            .Select(g => new { g.Key.UserId, g.Key.ProjectId, g.Key.OnWork, g.Key.Billable, Minutes = g.Sum(x => x.Minutes) }).ToListAsync(ct);
        var projectIds = time.Where(t => t.ProjectId != null).Select(t => t.ProjectId!.Value).Distinct().ToList();
        var projectRates = await db.Projects.IgnoreQueryFilters().Where(p => p.TenantId == tid && projectIds.Contains(p.Id)).Select(p => new { p.Id, p.BillRate }).ToDictionaryAsync(p => p.Id, p => p.BillRate, ct);

        var rows = members.Select(m =>
        {
            var mine = time.Where(t => t.UserId == m.UserId).ToList();
            var capacity = (int)Math.Round((m.WeeklyCapacityMinutes ?? StandardWeekMinutes) * days / 5m);
            var logged = mine.Sum(t => t.Minutes);
            var billable = mine.Where(t => t.Billable).Sum(t => t.Minutes);
            decimal? value = null;
            foreach (var t in mine.Where(t => t.Billable))
            {
                var rate = (t.ProjectId is { } p ? projectRates.GetValueOrDefault(p) : null) ?? m.BillRate;
                if (rate is { } r) value = (value ?? 0) + t.Minutes / 60m * r;
            }
            return new UtilisationPersonDto(m.UserId, m.DisplayName, capacity, logged, billable, mine.Where(t => !t.OnWork).Sum(t => t.Minutes), mine.Where(t => t.OnWork).Sum(t => t.Minutes),
                Ratio(logged, capacity), Ratio(billable, capacity),
                showMoney && m.CostRate is { } c ? Money(logged / 60m * c) : null, showMoney ? Money(value) : null);
        }).OrderByDescending(r => r.Utilisation ?? 0).ThenBy(r => r.Name).ToList();

        var cap = rows.Sum(r => r.CapacityMinutes); var log = rows.Sum(r => r.LoggedMinutes); var bill = rows.Sum(r => r.BillableMinutes);
        var totals = new UtilisationPersonDto(Guid.Empty, "Total", cap, log, bill, rows.Sum(r => r.ProjectMinutes), rows.Sum(r => r.OperationalMinutes), Ratio(log, cap), Ratio(bill, cap),
            showMoney && rows.Any(r => r.Cost != null) ? rows.Sum(r => r.Cost ?? 0) : null, showMoney && rows.Any(r => r.BillableValue != null) ? rows.Sum(r => r.BillableValue ?? 0) : null);
        return new UtilisationDto(start, end, scope, available, currency, showMoney, true, days, rows, totals);
    }

    // ------------------------------------------------------------------ project budget

    public async Task<ProjectFinancialsDto> ProjectAsync(Guid projectId, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.ReportsView, ct);
        var project = await access.GetProjectAsync(projectId, ct);
        var tid = ctx.RequireTenantId();
        var entitled = await EntitledAsync(ct);
        var showMoney = await ShowMoneyAsync(ct);
        var canEdit = entitled && showMoney && await CanEditProjectAsync(project, ct);
        var currency = await CurrencyAsync(ct);

        // Time spent delivering the project: entries on its tasks (work tasks only refer to a project, as in the project's Time tab).
        var time = await db.TimeEntries.AsNoTracking().Where(e => e.ProjectId == projectId && e.TaskId != null && !(e.StartedAt != null && e.EndedAt == null))
            .GroupBy(e => new { e.UserId, e.Billable }).Select(g => new { g.Key.UserId, g.Key.Billable, Minutes = g.Sum(x => x.Minutes) }).ToListAsync(ct);
        var userIds = time.Select(t => t.UserId).Distinct().ToList();
        var members = await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid && userIds.Contains(m.UserId))
            .Select(m => new { m.UserId, m.CostRate, m.BillRate }).ToDictionaryAsync(m => m.UserId, ct);
        var names = await db.Users.AsNoTracking().Where(u => userIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);

        var byPerson = userIds.Select(u =>
        {
            var minutes = time.Where(t => t.UserId == u).Sum(t => t.Minutes);
            var billable = time.Where(t => t.UserId == u && t.Billable).Sum(t => t.Minutes);
            var rates = members.GetValueOrDefault(u);
            var billRate = project.BillRate ?? rates?.BillRate;
            return new FinancialPersonDto(u, names.GetValueOrDefault(u) ?? "Former member", minutes, billable,
                showMoney && rates?.CostRate is { } c ? Money(minutes / 60m * c) : null, showMoney && billRate is { } b ? Money(billable / 60m * b) : null);
        }).OrderByDescending(p => p.Minutes).ToList();

        var logged = byPerson.Sum(p => p.Minutes);
        var billed = byPerson.Sum(p => p.BillableMinutes);
        decimal? cost = showMoney && byPerson.Any(p => p.Cost != null) ? byPerson.Sum(p => p.Cost ?? 0) : null;
        decimal? value = showMoney && byPerson.Any(p => p.BillableValue != null) ? byPerson.Sum(p => p.BillableValue ?? 0) : null;
        var hours = logged / 60m;

        // Straight-line forecast from the planned dates: what the whole project will use if it goes on at the pace so far.
        decimal? forecastHours = null, forecastCost = null;
        if (project.StartDate is { } s && project.DueDate is { } d && d > s)
        {
            var elapsed = (decimal)(Math.Min(clock.Today.DayNumber, d.DayNumber) - s.DayNumber) / (d.DayNumber - s.DayNumber);
            if (elapsed >= 0.1m && logged > 0)
            {
                forecastHours = Math.Round(hours / elapsed, 1);
                if (cost is { } c) forecastCost = Money(c / elapsed);
            }
        }

        var noRate = byPerson.Count(p => members.GetValueOrDefault(p.UserId)?.CostRate is null);
        return new ProjectFinancialsDto(projectId, currency, entitled, canEdit, showMoney, project.IsBillable, project.BudgetHours, showMoney ? project.BudgetAmount : null,
            showMoney ? project.BillRate : null, logged, billed, cost, value,
            project.BudgetHours is > 0 ? Math.Round(hours / project.BudgetHours.Value, 4) : null,
            showMoney && project.BudgetAmount is > 0 && cost is { } spent ? Math.Round(spent / project.BudgetAmount.Value, 4) : null,
            forecastHours, forecastCost, showMoney ? noRate : 0, entitled ? byPerson : []);
    }

    private async Task<bool> CanEditProjectAsync(ProjectManagement.Domain.Entities.Project project, CancellationToken ct)
    {
        try { await access.RequireProjectEditAsync(project, ct); return true; }
        catch (ForbiddenException) { return false; }
    }

    public async Task<ProjectFinancialsDto> SetProjectBudgetAsync(Guid projectId, ProjectBudgetRequest req, CancellationToken ct = default)
    {
        await entitlements.EnsureFeatureAsync(FeatureKeys.ResourceManagement, ct);
        var project = await access.GetProjectAsync(projectId, ct);
        if (!await ShowMoneyAsync(ct)) throw new ForbiddenException("Budgets are set by Owners, Admins and people with access to everyone's reports.", "PERMISSION_DENIED");
        await access.RequireProjectEditAsync(project, ct);
        if (req.BudgetHours is { } h && (h < 0 || h > 1_000_000)) throw new ValidationException("budgetHours", "Enter between 0 and 1,000,000 hours.");
        if (req.BudgetAmount is { } a && (a < 0 || a > 1_000_000_000_000)) throw new ValidationException("budgetAmount", "Enter a budget of 0 or more.");
        CheckRate(req.BillRate, "billRate");

        var before = new { project.IsBillable, project.BudgetHours, project.BudgetAmount, project.BillRate };
        project.IsBillable = req.IsBillable;
        project.BudgetHours = req.BudgetHours is { } bh ? Math.Round(bh, 2) : null;
        project.BudgetAmount = Money(req.BudgetAmount);
        project.BillRate = Money(req.BillRate);
        project.UpdatedAt = clock.Now; project.UpdatedBy = ctx.UserId;
        recorder.Activity("project.budget", "Project", project.Id, $"Changed the budget of {project.Name}", project.Id);
        recorder.Audit("project.budget", "Project", project.Id, before, new { project.IsBillable, project.BudgetHours, project.BudgetAmount, project.BillRate });
        await db.SaveChangesAsync(ct);
        return await ProjectAsync(projectId, ct);
    }
}
