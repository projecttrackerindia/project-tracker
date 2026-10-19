using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Auth;
using ProjectManagement.Application.Features.Sso;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Billing;

/// <summary>One UPI ID that customers can pay by QR (section Billing:Upi:Accounts).</summary>
public class UpiAccount
{
    /// <summary>The UPI ID (VPA), e.g. name@okaxis.</summary>
    public string Id { get; set; } = "";
    /// <summary>The account holder's name as the bank shows it.</summary>
    public string Name { get; set; } = "";
    /// <summary>Which bank, as shown next to the QR ("Kotak Mahindra Bank").</summary>
    public string? Label { get; set; }
    public bool Enabled { get; set; } = true;
}

public class UpiOptions
{
    public const string Section = "Billing:Upi";
    /// <summary>Pay for plans by UPI QR (confirmed by a platform administrator) instead of the payment provider.</summary>
    public bool Enabled { get; set; }
    /// <summary>In order of preference: one QR is shown at a time, the next one when paying the current one fails.</summary>
    public List<UpiAccount> Accounts { get; set; } = [];
    /// <summary>An account that failed this many times within <see cref="FailureWindowHours"/> (with no confirmed payment since) is skipped for new payments.</summary>
    public int FailureThreshold { get; set; } = 3;
    public int FailureWindowHours { get; set; } = 24;
    /// <summary>How long a QR stays valid for paying.</summary>
    public int ExpiryHours { get; set; } = 48;
    /// <summary>Who is told a payment waits for confirmation (besides the platform administrators).</summary>
    public string? NotifyEmail { get; set; }
}

public record UpiPaymentDto(Guid Id, string Reference, decimal Amount, string Currency, string Description, string PlanCode, string PayeeName, string UpiId,
    string? BankLabel, string UpiUri, string Status, string? Utr, int Attempt, bool OtherQrAvailable, DateTime ExpiresAt, DateTime CreatedAt, string? DecisionNote);
public record UpiSubmitRequest(string? Utr);
public record UpiFailedRequest(string? Reason);
public record UpiDecisionRequest(string? Note);
public record UpiAdminPaymentDto(Guid Id, Guid TenantId, string Workspace, string PlanCode, int Seats, string Period, decimal Amount, string Currency, string Reference,
    string UpiId, string? BankLabel, string Status, string? Utr, int Attempt, string? FailureReason, DateTime CreatedAt, DateTime? SubmittedAt, string? SubmittedByEmail,
    DateTime? DecidedAt, string? DecisionNote);
public record UpiAccountHealthDto(string UpiId, string? BankLabel, bool Enabled, bool InUse, int RecentFailures, int Confirmed, DateTime? LastConfirmedAt, DateTime? LastFailedAt);

/// <summary>
/// Paying for a plan by UPI QR until a payment gateway is connected. Checkout shows one QR (amount and reference included); if paying it fails,
/// the next configured UPI ID is shown; an account that keeps failing is skipped for new payments. The payer enters the UPI transaction id
/// (UTR); a platform administrator checks it against the bank statement and confirms, which activates the plan and records a paid invoice.
/// </summary>
public class UpiBillingService(IAppDbContext db, CurrentContext ctx, AppClock clock, Recorder recorder, PermissionService permissions, SubscriptionActivator activator,
    IEmailSender email, IOptions<UpiOptions> options, IOptions<AppOptions> app, ILogger<UpiBillingService> log)
{
    private static readonly Regex Vpa = new(@"^[A-Za-z0-9._\-]{2,100}@[A-Za-z0-9]{2,40}$", RegexOptions.CultureInvariant);
    private static readonly Regex UtrShape = new(@"^[A-Za-z0-9]{10,22}$", RegexOptions.CultureInvariant);
    public const string ProviderName = "upi";

    private UpiOptions O => options.Value;
    private IReadOnlyList<UpiAccount> Accounts => O.Accounts.Where(a => a.Enabled && Vpa.IsMatch(a.Id.Trim()) && !string.IsNullOrWhiteSpace(a.Name)).ToList();
    public bool Enabled => O.Enabled && Accounts.Count > 0;

    // ---------------------------------------------------------------- choosing a QR

    /// <summary>
    /// The account to show: the first in order that has not failed repeatedly lately and was not already tried in this checkout. When every one
    /// is excluded, the one with the fewest recent failures (a QR is always shown).
    /// </summary>
    private async Task<UpiAccount> ChooseAsync(IReadOnlyCollection<string> tried, CancellationToken ct)
    {
        var accounts = Accounts;
        var since = clock.Now.AddHours(-Math.Max(1, O.FailureWindowHours));
        var ids = accounts.Select(a => a.Id).ToList();
        var recent = await db.UpiPayments.IgnoreQueryFilters().AsNoTracking().Where(p => ids.Contains(p.AccountId) && p.CreatedAt >= since && (p.Status == "failed" || p.Status == "confirmed"))
            .Select(p => new { p.AccountId, p.Status, p.CreatedAt }).ToListAsync(ct);
        int Failures(string id)
        {
            var lastOk = recent.Where(r => r.AccountId == id && r.Status == "confirmed").Select(r => (DateTime?)r.CreatedAt).Max();
            return recent.Count(r => r.AccountId == id && r.Status == "failed" && (lastOk is null || r.CreatedAt > lastOk));
        }
        var healthy = accounts.Where(a => !tried.Contains(a.Id) && Failures(a.Id) < Math.Max(1, O.FailureThreshold)).ToList();
        if (healthy.Count > 0) return healthy[0];
        var untried = accounts.Where(a => !tried.Contains(a.Id)).ToList();
        return (untried.Count > 0 ? untried : accounts.ToList()).OrderBy(a => Failures(a.Id)).First();
    }

    private static string NewReference() => "PT-" + Convert.ToHexString(RandomNumberGenerator.GetBytes(4))[..7];

    // ---------------------------------------------------------------- the payer

    /// <summary>Starts paying for a plan: replaces any open payment of the workspace and shows the first QR.</summary>
    public async Task<UpiPaymentDto> StartAsync(Plan plan, int seats, PriceQuote quote, string description, CancellationToken ct)
    {
        if (!Enabled) throw new ConflictException("UPI payments are not set up.", "UPI_DISABLED");
        if (!plan.Currency.Equals("INR", StringComparison.OrdinalIgnoreCase)) throw new ConflictException("UPI can only be used for prices in rupees.", "UPI_CURRENCY");
        var tid = ctx.RequireTenantId();
        await db.UpiPayments.Where(p => p.TenantId == tid && p.Status == "awaiting").ExecuteUpdateAsync(u => u.SetProperty(p => p.Status, "cancelled"), ct);
        var account = await ChooseAsync([], ct);
        var id = Guid.CreateVersion7();
        var row = new UpiPayment
        {
            Id = id, TenantId = tid, PlanId = plan.Id, PlanCode = plan.Code, Seats = seats, Period = quote.Period, Amount = quote.ChargePerCycle, Currency = "INR",
            Description = Cut(description, 300)!, Reference = NewReference(), ChainId = id, Attempt = 1, AccountId = account.Id.Trim(), AccountLabel = Cut(account.Label, 80),
            Status = "awaiting", ExpiresAt = clock.Now.AddHours(Math.Max(1, O.ExpiryHours)), CreatedAt = clock.Now, CreatedBy = ctx.UserId,
        };
        db.UpiPayments.Add(row);
        recorder.Audit("billing.upi_started", "UpiPayment", row.Id, newValue: new { plan.Code, seats, row.Amount, row.Reference, Account = Mask(row.AccountId) });
        await db.SaveChangesAsync(ct);
        return Dto(row, account);
    }

    /// <summary>The workspace's open UPI payment (waiting to be paid, or paid and waiting for confirmation), if any.</summary>
    public async Task<UpiPaymentDto?> CurrentAsync(CancellationToken ct)
    {
        if (!O.Enabled) return null;
        var tid = ctx.RequireTenantId();
        var row = await db.UpiPayments.AsNoTracking().Where(p => p.TenantId == tid && (p.Status == "awaiting" && p.ExpiresAt > clock.Now || p.Status == "submitted"
                || p.Status == "rejected" && p.DecidedAt > clock.Now.AddDays(-3)))
            .OrderByDescending(p => p.CreatedAt).FirstOrDefaultAsync(ct);
        return row is null ? null : Dto(row, AccountOf(row));
    }

    private async Task<UpiPayment> MineAsync(Guid id, CancellationToken ct)
    {
        await permissions.RequireAsync(Permissions.BillingManage, ct);
        var tid = ctx.RequireTenantId();
        return await db.UpiPayments.FirstOrDefaultAsync(p => p.Id == id && p.TenantId == tid, ct) ?? throw new NotFoundException("That payment was not found.");
    }

    /// <summary>The payer has paid: they give the UPI transaction id, and the platform administrators are asked to confirm it.</summary>
    public async Task<UpiPaymentDto> SubmitAsync(Guid id, UpiSubmitRequest req, CancellationToken ct)
    {
        var row = await MineAsync(id, ct);
        if (row.Status == "submitted") return Dto(row, AccountOf(row));
        if (row.Status != "awaiting") throw new ConflictException("This payment is no longer open. Start the payment again from Billing.", "UPI_NOT_OPEN");
        if (row.ExpiresAt <= clock.Now) throw new ConflictException("This QR has expired. Start the payment again from Billing.", "UPI_EXPIRED");
        var utr = (req.Utr ?? "").Trim().Replace(" ", "").ToUpperInvariant();
        if (!UtrShape.IsMatch(utr))
            throw new ValidationException("utr", "Enter the UPI transaction id from your payment app (UTR or UPI Ref No., usually 12 digits).");
        if (await db.UpiPayments.IgnoreQueryFilters().AnyAsync(p => p.Utr == utr && p.Id != row.Id, ct))
            throw new ConflictException("That UPI transaction id was already used for another payment.", "UPI_UTR_USED");
        row.Utr = utr; row.Status = "submitted"; row.SubmittedAt = clock.Now; row.SubmittedBy = ctx.UserId; row.UpdatedAt = clock.Now;
        recorder.Audit("billing.upi_submitted", "UpiPayment", row.Id, newValue: new { row.Reference, row.Amount });
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateException) { throw new ConflictException("That UPI transaction id was already used for another payment.", "UPI_UTR_USED"); }
        await TellAdminsAsync(row, ct);
        return Dto(row, AccountOf(row));
    }

    /// <summary>Paying this QR did not work: it is noted against the account, and the next QR is shown.</summary>
    public async Task<UpiPaymentDto> ReportFailureAsync(Guid id, UpiFailedRequest req, CancellationToken ct)
    {
        var row = await MineAsync(id, ct);
        if (row.Status != "awaiting") throw new ConflictException("This payment is no longer open. Start the payment again from Billing.", "UPI_NOT_OPEN");
        row.Status = "failed"; row.FailureReason = Cut(req.Reason?.Trim(), 200) ?? "The payment app could not pay this QR."; row.UpdatedAt = clock.Now;
        var tried = await db.UpiPayments.Where(p => p.ChainId == row.ChainId).Select(p => p.AccountId).ToListAsync(ct);
        var account = await ChooseAsync(tried, ct);
        var next = new UpiPayment
        {
            Id = Guid.CreateVersion7(), TenantId = row.TenantId, PlanId = row.PlanId, PlanCode = row.PlanCode, Seats = row.Seats, Period = row.Period, Amount = row.Amount,
            Currency = row.Currency, Description = row.Description, Reference = NewReference(), ChainId = row.ChainId, Attempt = row.Attempt + 1, AccountId = account.Id.Trim(),
            AccountLabel = Cut(account.Label, 80), Status = "awaiting", ExpiresAt = clock.Now.AddHours(Math.Max(1, O.ExpiryHours)), CreatedAt = clock.Now, CreatedBy = ctx.UserId,
        };
        db.UpiPayments.Add(next);
        recorder.Audit("billing.upi_failed", "UpiPayment", row.Id, newValue: new { row.Reference, Account = Mask(row.AccountId), Next = Mask(next.AccountId), row.FailureReason });
        await db.SaveChangesAsync(ct);
        return Dto(next, account);
    }

    public async Task CancelAsync(Guid id, CancellationToken ct)
    {
        var row = await MineAsync(id, ct);
        if (row.Status is "awaiting" or "rejected") { row.Status = "cancelled"; row.UpdatedAt = clock.Now; await db.SaveChangesAsync(ct); }
        else if (row.Status == "submitted") throw new ConflictException("This payment is being confirmed and cannot be cancelled now.", "UPI_SUBMITTED");
    }

    // ---------------------------------------------------------------- platform administrators

    private void RequireAdmin()
    {
        if (!ctx.IsPlatformAdmin) throw new ForbiddenException("Platform administrators only.", "PERMISSION_DENIED");
    }

    public async Task<IReadOnlyList<UpiAdminPaymentDto>> ListAsync(string? status, CancellationToken ct)
    {
        RequireAdmin();
        var q = db.UpiPayments.IgnoreQueryFilters().AsNoTracking();
        q = string.IsNullOrWhiteSpace(status) || status == "all" ? q : q.Where(p => p.Status == status);
        var rows = await q.OrderBy(p => p.Status == "submitted" ? 0 : 1).ThenByDescending(p => p.CreatedAt).Take(200).ToListAsync(ct);
        var tenantIds = rows.Select(r => r.TenantId).Distinct().ToList();
        var names = await db.Tenants.IgnoreQueryFilters().AsNoTracking().Where(t => tenantIds.Contains(t.Id)).ToDictionaryAsync(t => t.Id, t => t.Name, ct);
        var userIds = rows.Where(r => r.SubmittedBy != null).Select(r => r.SubmittedBy!.Value).Distinct().ToList();
        var emails = await db.Users.IgnoreQueryFilters().AsNoTracking().Where(u => userIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.Email, ct);
        return rows.Select(r => new UpiAdminPaymentDto(r.Id, r.TenantId, names.GetValueOrDefault(r.TenantId) ?? "", r.PlanCode, r.Seats, r.Period, r.Amount, r.Currency, r.Reference,
            r.AccountId, r.AccountLabel, r.Status == "awaiting" && r.ExpiresAt <= clock.Now ? "expired" : r.Status, r.Utr, r.Attempt, r.FailureReason, r.CreatedAt, r.SubmittedAt,
            r.SubmittedBy is { } by ? emails.GetValueOrDefault(by) : null, r.DecidedAt, r.DecisionNote)).ToList();
    }

    public async Task<IReadOnlyList<UpiAccountHealthDto>> AccountsAsync(CancellationToken ct)
    {
        RequireAdmin();
        var since = clock.Now.AddHours(-Math.Max(1, O.FailureWindowHours));
        var rows = await db.UpiPayments.IgnoreQueryFilters().AsNoTracking().Where(p => p.Status == "failed" || p.Status == "confirmed")
            .Select(p => new { p.AccountId, p.Status, p.CreatedAt, p.DecidedAt }).ToListAsync(ct);
        var current = O.Enabled ? (await ChooseAsync([], ct)).Id : null;
        return O.Accounts.Where(a => Vpa.IsMatch(a.Id.Trim())).Select(a =>
        {
            var mine = rows.Where(r => r.AccountId == a.Id.Trim()).ToList();
            var lastOk = mine.Where(r => r.Status == "confirmed").Select(r => (DateTime?)r.CreatedAt).Max();
            return new UpiAccountHealthDto(a.Id.Trim(), a.Label, a.Enabled, a.Id == current,
                mine.Count(r => r.Status == "failed" && r.CreatedAt >= since && (lastOk is null || r.CreatedAt > lastOk)), mine.Count(r => r.Status == "confirmed"),
                mine.Where(r => r.Status == "confirmed").Select(r => r.DecidedAt).Max(), mine.Where(r => r.Status == "failed").Select(r => (DateTime?)r.CreatedAt).Max());
        }).ToList();
    }

    /// <summary>The money is in the bank: the plan is activated for the paid period and a paid invoice is recorded.</summary>
    public async Task<UpiAdminPaymentDto> ConfirmAsync(Guid id, UpiDecisionRequest req, CancellationToken ct)
    {
        RequireAdmin();
        var tenant = await db.UpiPayments.IgnoreQueryFilters().AsNoTracking().Where(p => p.Id == id).Select(p => (Guid?)p.TenantId).FirstOrDefaultAsync(ct)
            ?? throw new NotFoundException("That payment was not found.");
        // The administrator acts in the paying workspace for these writes (subscription, invoice, notice), never across it.
        var original = ctx.TenantId;
        ctx.TenantId = tenant;
        try { await ConfirmInTenantAsync(id, req, ct); }
        finally { ctx.TenantId = original; }
        return (await ListAsync(null, ct)).First(p => p.Id == id);
    }

    private async Task ConfirmInTenantAsync(Guid id, UpiDecisionRequest req, CancellationToken ct)
    {
        var row = await db.UpiPayments.IgnoreQueryFilters().FirstOrDefaultAsync(p => p.Id == id, ct) ?? throw new NotFoundException("That payment was not found.");
        if (row.Status == "confirmed") return;
        if (row.Status is not ("submitted" or "awaiting" or "rejected")) throw new ConflictException($"A {row.Status} payment cannot be confirmed.", "UPI_NOT_CONFIRMABLE");
        if (row.Utr is null) throw new ConflictException("The payer has not given a UPI transaction id yet.", "UPI_NO_UTR");
        var plan = await db.Plans.IgnoreQueryFilters().Include(p => p.Features).FirstAsync(p => p.Id == row.PlanId, ct);
        var sub = await db.Subscriptions.IgnoreQueryFilters().FirstAsync(s => s.TenantId == row.TenantId, ct);
        var now = clock.Now;
        var months = Pricing.Months(row.Period);
        // Paying again for the same plan before it ran out adds the time to the end of the paid period.
        var start = sub.PlanId == plan.Id && sub.Status == SubscriptionStatus.Active && sub.Provider == ProviderName && sub.CurrentPeriodEnd is { } end && end > now ? end : now;
        if (sub.ProviderSubscriptionId is { } paying) await activator.CancelAtProviderAsync(paying, atCycleEnd: false, ct);
        sub.PlanId = plan.Id; sub.Status = SubscriptionStatus.Active; sub.Seats = Math.Max(1, row.Seats); sub.BillingPeriod = Pricing.NormalizePeriod(row.Period);
        sub.Provider = ProviderName; sub.ProviderSubscriptionId = null;
        sub.PendingPlanId = null; sub.PendingProviderSubscriptionId = null; sub.PendingSeats = null; sub.PendingBillingPeriod = null;
        sub.TrialEnd = null; sub.CancelAtPeriodEnd = false; sub.CancelledAt = null;
        if (start == now) sub.CurrentPeriodStart = now;
        sub.CurrentPeriodEnd = start.AddMonths(months);
        row.Status = "confirmed"; row.DecidedAt = now; row.DecidedBy = ctx.UserId; row.DecisionNote = Cut(req.Note?.Trim(), 300); row.UpdatedAt = now;
        await db.UpiPayments.IgnoreQueryFilters().Where(p => p.ChainId == row.ChainId && p.Id != row.Id && p.Status == "awaiting")
            .ExecuteUpdateAsync(u => u.SetProperty(p => p.Status, "cancelled"), ct);
        await activator.RecordPaymentAsync(row.TenantId, plan, row.Amount, row.Currency, $"upi:{row.Utr}", true, null, $"{row.Description} — UPI {row.Utr}", ct);
        recorder.Audit("billing.upi_confirmed", "UpiPayment", row.Id, tenantId: row.TenantId, newValue: new { row.Reference, row.Amount, plan.Code, Until = sub.CurrentPeriodEnd });
        Notify(row.TenantId, "Payment received - your plan is active", $"{plan.Name} is active until {sub.CurrentPeriodEnd:dd MMM yyyy}. Thank you!", now);
        await db.SaveChangesAsync(ct);
    }

    /// <summary>The money is not in the bank (wrong or unknown UTR, wrong amount): the payer is told why and can pay again.</summary>
    public async Task<UpiAdminPaymentDto> RejectAsync(Guid id, UpiDecisionRequest req, CancellationToken ct)
    {
        RequireAdmin();
        var row = await db.UpiPayments.IgnoreQueryFilters().FirstOrDefaultAsync(p => p.Id == id, ct) ?? throw new NotFoundException("That payment was not found.");
        var original = ctx.TenantId;
        ctx.TenantId = row.TenantId;
        try { await RejectInTenantAsync(row, req, ct); }
        finally { ctx.TenantId = original; }
        return (await ListAsync(null, ct)).First(p => p.Id == id);
    }

    private async Task RejectInTenantAsync(UpiPayment row, UpiDecisionRequest req, CancellationToken ct)
    {
        if (row.Status != "submitted") throw new ConflictException("Only a payment waiting for confirmation can be rejected.", "UPI_NOT_SUBMITTED");
        var note = req.Note?.Trim();
        if (string.IsNullOrEmpty(note)) throw new ValidationException("note", "Say why, so the payer knows what to fix.");
        row.Status = "rejected"; row.DecidedAt = clock.Now; row.DecidedBy = ctx.UserId; row.DecisionNote = Cut(note, 300); row.UpdatedAt = clock.Now;
        recorder.Audit("billing.upi_rejected", "UpiPayment", row.Id, tenantId: row.TenantId, newValue: new { row.Reference, note });
        Notify(row.TenantId, "We could not confirm your UPI payment", $"{note} Open Billing to pay again, or write to {EmailTemplates.SupportEmail} with reference {row.Reference}.", clock.Now);
        await db.SaveChangesAsync(ct);
    }

    // ---------------------------------------------------------------- shaping and telling people

    private UpiAccount AccountOf(UpiPayment row) =>
        O.Accounts.FirstOrDefault(a => a.Id.Trim() == row.AccountId) ?? new UpiAccount { Id = row.AccountId, Name = "Project Tracker", Label = row.AccountLabel };

    private UpiPaymentDto Dto(UpiPayment row, UpiAccount account)
    {
        var amount = row.Amount.ToString("0.00", CultureInfo.InvariantCulture);
        var uri = $"upi://pay?pa={Uri.EscapeDataString(account.Id.Trim())}&pn={Uri.EscapeDataString(account.Name.Trim())}&am={amount}&cu=INR&tn={Uri.EscapeDataString($"Project Tracker {row.Reference}")}";
        var others = Accounts.Count > 1;
        var status = row.Status == "awaiting" && row.ExpiresAt <= clock.Now ? "expired" : row.Status;
        return new UpiPaymentDto(row.Id, row.Reference, row.Amount, row.Currency, row.Description, row.PlanCode, account.Name.Trim(), account.Id.Trim(), account.Label, uri, status, row.Utr,
            row.Attempt, others, row.ExpiresAt, row.CreatedAt, row.DecisionNote);
    }

    private void Notify(Guid tenantId, string title, string body, DateTime now)
    {
        var owner = db.Tenants.IgnoreQueryFilters().Where(t => t.Id == tenantId).Select(t => t.OwnerUserId).FirstOrDefault();
        if (owner == Guid.Empty) return;
        db.Notifications.Add(new Notification { TenantId = tenantId, UserId = owner, Type = NotificationType.Subscription, CreatedAt = now, Link = "/settings/billing", Title = title, Body = Cut(body, 500) });
    }

    private async Task TellAdminsAsync(UpiPayment row, CancellationToken ct)
    {
        try
        {
            var to = await db.Users.IgnoreQueryFilters().AsNoTracking().Where(u => u.IsPlatformAdmin && u.IsActive).Select(u => u.Email).Take(20).ToListAsync(ct);
            if (O.NotifyEmail is { Length: > 3 } extra && extra.Contains('@')) to.Add(extra.Trim());
            var workspace = await db.Tenants.IgnoreQueryFilters().AsNoTracking().Where(t => t.Id == row.TenantId).Select(t => t.Name).FirstOrDefaultAsync(ct) ?? "A workspace";
            var subject = $"Confirm UPI payment ₹{row.Amount:0.00} from {workspace}";
            var text = $"{workspace} paid ₹{row.Amount:0.00} for {row.Description} to {Mask(row.AccountId)}{(row.AccountLabel is null ? "" : $" ({row.AccountLabel})")}. " +
                $"UTR {row.Utr}, reference {row.Reference}. Check the bank statement, then confirm or reject it in Admin › Payments.";
            var html = EmailTemplates.Wrap(subject, "Hello,", text, "Open Payments", $"{PublicUrls.Web(app.Value)}/admin/payments");
            foreach (var address in to.Distinct(StringComparer.OrdinalIgnoreCase))
                await email.SendAsync(new EmailMessage(address, subject, html, text), ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException) { log.LogWarning(ex, "Admins could not be told about UPI payment {Payment}", row.Id); }
    }

    /// <summary>name@bank shown as na***@bank in logs and messages.</summary>
    public static string Mask(string vpa)
    {
        var at = vpa.IndexOf('@');
        return at <= 2 ? "***" + vpa[Math.Max(0, at)..] : vpa[..2] + "***" + vpa[at..];
    }

    private static string? Cut(string? s, int max) => s is null ? null : s.Length <= max ? s : s[..max];
}
