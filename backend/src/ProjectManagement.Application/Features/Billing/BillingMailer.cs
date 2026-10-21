using System.Globalization;
using System.Net;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Features.Auth;
using ProjectManagement.Application.Features.Sso;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Billing;

/// <summary>
/// The e-mails about money, sent to the workspace owner whatever their notification settings, because they are records people need: a receipt for
/// every payment, a warning when a renewal fails (and what happens next), confirmation of a cancellation, notice when a plan ends, and every refund
/// and its outcome. Each is sent once per event: callers send only after the payment, refund or change was newly saved, never on a repeat report.
/// A message that cannot be sent is logged and retried by the mail queue; it never fails the payment itself.
/// </summary>
public class BillingMailer(IAppDbContext db, IEmailSender email, IOptions<AppOptions> app, ILogger<BillingMailer> log)
{
    private static readonly TimeZoneInfo Ist = FindIst();
    private string Web => PublicUrls.Web(app.Value);
    private string BillingLink => $"{Web}/settings/billing";

    /// <summary>"₹1,24,999.00" for rupees (Indian digit grouping), "USD 12.00" for anything else.</summary>
    public static string Money(decimal amount, string currency) =>
        currency.Equals("INR", StringComparison.OrdinalIgnoreCase) ? "₹" + IndianGrouping(amount) : $"{currency.ToUpperInvariant()} {amount.ToString("N2", CultureInfo.InvariantCulture)}";

    /// <summary>1,24,999.50: the last three digits, then pairs (the server runs without locale data, so this is done by hand).</summary>
    private static string IndianGrouping(decimal amount)
    {
        var text = Math.Abs(amount).ToString("0.00", CultureInfo.InvariantCulture);
        var whole = text[..^3];
        var grouped = whole.Length <= 3 ? whole : whole[^3..];
        for (var rest = whole.Length <= 3 ? "" : whole[..^3]; rest.Length > 0; rest = rest.Length <= 2 ? "" : rest[..^2])
            grouped = (rest.Length <= 2 ? rest : rest[^2..]) + "," + grouped;
        return (amount < 0 ? "-" : "") + grouped + text[^3..];
    }

    /// <summary>"21 Oct 2026" (or with the time, "21 Oct 2026, 9:05 pm IST"), in India time.</summary>
    public static string Day(DateTime utc, bool withTime = false)
    {
        var local = TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(utc, DateTimeKind.Utc), Ist);
        return withTime ? local.ToString("d MMM yyyy, h:mm tt", CultureInfo.InvariantCulture).Replace("AM", "am").Replace("PM", "pm") + " IST" : local.ToString("d MMM yyyy", CultureInfo.InvariantCulture);
    }

    /// <summary>A payment went through: the receipt, with the tax-invoice number, what was bought and when the plan renews.</summary>
    public Task PaymentReceivedAsync(Invoice invoice, string planName, DateTime? paidUntil, bool renews, string? method, CancellationToken ct) => SendAsync(invoice.TenantId, (name, workspace) =>
    {
        var amount = Money(invoice.Amount, invoice.Currency);
        var details = new List<(string, string)> { ("Amount", amount), ("Invoice", invoice.Number), ("Plan", planName), ("For", invoice.Description), ("Paid on", Day(invoice.IssuedAt, true)) };
        if (method is not null) details.Add(("Paid by", method));
        if (paidUntil is { } until) details.Add((renews ? "Renews on" : "Paid until", Day(until)));
        if (invoice.ProviderReference is { Length: > 0 } reference) details.Add(("Reference", reference));
        var body = $"Thank you. We received your payment of {amount} and {planName} is active for {workspace}. " +
            (renews && paidUntil is { } next ? $"Your plan renews automatically on {Day(next)}; you can cancel any time in Billing before then. " : "") +
            "Your tax invoice is attached to your account: open Billing to download it as a PDF.";
        return ($"Payment received: {amount} · Invoice {invoice.Number}", "Payment received", body, "Download invoice", BillingLink, details,
            $"Receipt for {amount} — {planName} is active.");
    }, ct);

    /// <summary>A renewal could not be charged. Says whether it is tried again, until when the plan keeps working, and what to do.</summary>
    public Task PaymentFailedAsync(Guid tenantId, string planName, decimal? amount, string currency, string? reason, bool willRetry, DateTime? keepsWorkingUntil, CancellationToken ct) => SendAsync(tenantId, (name, workspace) =>
    {
        var what = amount is { } a ? $"the payment of {Money(a, currency)}" : "the payment";
        var body = $"We could not collect {what} for the {planName} plan of {workspace}. " +
            (reason is { Length: > 0 } r ? $"Your bank or payment app said: \"{r}\". " : "") +
            (willRetry ? "We will try again automatically over the next few days, so there is nothing to do if the account has funds or the limit allows it. " : "We tried several times and will not try again. ") +
            (keepsWorkingUntil is { } end ? $"Your plan keeps working until {Day(end)}. " : "") +
            "To avoid any interruption, open Billing and pay again or choose another payment method. No money was taken for this attempt; if your account shows a deduction, it is reversed by your bank, usually within 5 to 7 working days.";
        var details = new List<(string, string)> { ("Plan", planName), ("Status", willRetry ? "Retrying automatically" : "Action needed") };
        if (amount is { } amt) details.Insert(0, ("Amount", Money(amt, currency)));
        if (keepsWorkingUntil is { } until) details.Add(("Works until", Day(until)));
        return ($"Action needed: payment failed for {workspace}", "Your payment did not go through", body, "Update payment", BillingLink, details,
            willRetry ? "We will retry automatically; here is what to check." : "Pay again to keep your plan.");
    }, ct);

    /// <summary>The owner cancelled: nothing more is charged, the plan works until the paid period ends, and nothing is deleted.</summary>
    public Task CancelledAsync(Guid tenantId, string planName, DateTime accessUntil, CancellationToken ct) => SendAsync(tenantId, (name, workspace) =>
    (
        $"Your {planName} plan is cancelled", "Subscription cancelled",
        $"As requested, the {planName} plan of {workspace} will not renew and you will not be charged again. Everything keeps working until {Day(accessUntil)}; after that the workspace moves to the Free plan's limits. " +
        "Nothing is deleted, and you can choose a plan again at any time. If you did not ask for this, reply to this e-mail straight away.",
        "Open Billing", BillingLink, new List<(string, string)> { ("Plan", planName), ("Works until", Day(accessUntil)), ("Next charge", "None") },
        $"No further charges; {planName} works until {Day(accessUntil)}."
    ), ct);

    /// <summary>A paid plan or trial ran out and the workspace is now on Free.</summary>
    public Task PlanEndedAsync(Guid tenantId, string planName, bool wasTrial, CancellationToken ct) => SendAsync(tenantId, (name, workspace) =>
    (
        wasTrial ? $"Your {planName} trial has ended" : $"Your {planName} plan has ended", wasTrial ? "Trial ended" : "Plan ended",
        $"{workspace} is now on the Free plan. All your projects, tasks and files are safe, but features and limits beyond the Free plan are paused. " +
        $"Choose {planName} again in Billing to switch everything back on at once.",
        "Choose a plan", BillingLink, new List<(string, string)> { ("Workspace", workspace), ("Now on", "Free plan"), ("Your data", "Kept in full") },
        "Your data is safe; pick a plan to restore everything."
    ), ct);

    /// <summary>A refund was paid out (full or part), or the bank could not complete it.</summary>
    public Task RefundAsync(Invoice invoice, decimal refunded, string currency, string refundId, bool succeeded, bool full, CancellationToken ct) => SendAsync(invoice.TenantId, (name, workspace) =>
    {
        var amount = Money(refunded, currency);
        var details = new List<(string, string)> { ("Refund", amount), ("Of payment", Money(invoice.Amount, invoice.Currency)), ("Invoice", invoice.Number), ("Refund ID", refundId),
            ("Status", succeeded ? "Processed" : "Not completed") };
        var body = succeeded
            ? $"We have refunded {amount} {(full ? "in full " : "")}for invoice {invoice.Number} ({workspace}). It goes back to the account or card you paid with. " +
              "Banks usually show it within 5 to 7 working days; if you cannot see it after that, give your bank the refund ID below."
            : $"A refund of {amount} for invoice {invoice.Number} ({workspace}) could not be completed by the bank. We will pay it again, by another route if needed, and write to you; you do not need to do anything.";
        return (succeeded ? $"Refund of {amount} processed" : $"Refund of {amount} is delayed", succeeded ? "Refund processed" : "Refund delayed", body,
            "View billing", BillingLink, details, succeeded ? $"{amount} is on its way back to you." : "We are paying it again; nothing to do.");
    }, ct);

    private async Task SendAsync(Guid tenantId,
        Func<string, string, (string Subject, string Title, string Body, string Cta, string Link, IReadOnlyList<(string, string)> Details, string Preheader)> build,
        CancellationToken ct)
    {
        try
        {
            var tenant = await db.Tenants.IgnoreQueryFilters().AsNoTracking().Where(t => t.Id == tenantId).Select(t => new { t.Name, t.OwnerUserId }).FirstOrDefaultAsync(ct);
            if (tenant is null) return;
            var owner = await db.Users.IgnoreQueryFilters().AsNoTracking().Where(u => u.Id == tenant.OwnerUserId && u.IsActive).Select(u => new { u.Email, u.DisplayName }).FirstOrDefaultAsync(ct);
            if (owner is null) return;
            var m = build(owner.DisplayName, tenant.Name);
            var html = EmailTemplates.Wrap(m.Title, $"Hi {WebUtility.HtmlEncode(owner.DisplayName)},", m.Body, m.Cta, m.Link,
                "You receive this because you own this workspace. Billing e-mails are always sent; they are your payment records.", m.Preheader, null, EmailKind.Billing, m.Details);
            var text = $"{m.Title}\n\n{m.Body}\n\n" + string.Join("\n", m.Details.Select(d => $"{d.Item1}: {d.Item2}")) + $"\n\n{m.Cta}: {m.Link}\n\nQuestions? {EmailTemplates.SupportEmail}";
            await email.SendAsync(new EmailMessage(owner.Email, m.Subject, html, text, "billing", ReplyTo: EmailTemplates.SupportEmail), ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException) { log.LogWarning(ex, "A billing e-mail for workspace {Tenant} could not be sent", tenantId); }
    }

    private static TimeZoneInfo FindIst()
    {
        try { return TimeZoneInfo.FindSystemTimeZoneById("Asia/Kolkata"); }
        catch (Exception ex) when (ex is TimeZoneNotFoundException or InvalidTimeZoneException) { return TimeZoneInfo.CreateCustomTimeZone("IST", TimeSpan.FromHours(5.5), "India Standard Time", "IST"); }
    }
}
