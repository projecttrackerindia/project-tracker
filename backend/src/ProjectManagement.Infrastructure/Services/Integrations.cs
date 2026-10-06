using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Net.Mail;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;

namespace ProjectManagement.Infrastructure.Services;

public record DevEmail(Guid Id, DateTime SentAt, string To, string Subject, string? Text, string Html);

/// <summary>In-memory outbox so verification / reset / invitation links are reachable during development.</summary>
public class DevMailbox
{
    private readonly ConcurrentQueue<DevEmail> _emails = new();

    public void Add(DevEmail email)
    {
        _emails.Enqueue(email);
        while (_emails.Count > 50) _emails.TryDequeue(out _);
    }

    public IReadOnlyList<DevEmail> Recent() => _emails.Reverse().ToList();
}

/// <summary>Development sender: writes to the log and the in-memory <see cref="DevMailbox"/>.</summary>
public class LogEmailSender(ILogger<LogEmailSender> log, DevMailbox mailbox, TimeProvider clock) : IEmailTransport
{
    public string Name => "log";

    public Task SendAsync(EmailMessage message, CancellationToken ct = default)
    {
        mailbox.Add(new DevEmail(Guid.NewGuid(), clock.GetUtcNow().UtcDateTime, message.To, message.Subject, message.Text, message.Html));
        log.LogInformation("Email to {To}: {Subject}\n{Text}", message.To, message.Subject, message.Text);
        return Task.CompletedTask;
    }
}

/// <summary>Settings every provider shares (section Email): the name people see as the sender, and where replies go.</summary>
public class EmailCommonOptions
{
    public string FromName { get; set; } = "Project Tracker";
    public string? ReplyTo { get; set; }

    /// <summary>"Name &lt;address&gt;" unless the configured sender already carries a name.</summary>
    public string Sender(string from) => from.Contains('<') ? from : $"{FromName} <{from}>";
}

public class SmtpOptions
{
    public const string Section = "Email:Smtp";
    public string Host { get; set; } = "";
    public int Port { get; set; } = 587;
    public bool EnableSsl { get; set; } = true;
    public string? Username { get; set; }
    public string? Password { get; set; }
    public string From { get; set; } = "no-reply@example.com";
}

/// <summary>Plain SMTP sender (SES SMTP, SendGrid SMTP, Microsoft 365, ...). Swap for an API-based provider behind the same interface.</summary>
public class SmtpEmailSender(IOptions<SmtpOptions> options, IOptions<EmailCommonOptions>? commonOptions = null) : IEmailTransport
{
    public string Name => "smtp";
    private readonly IOptions<EmailCommonOptions> common = commonOptions ?? Options.Create(new EmailCommonOptions());

    public async Task SendAsync(EmailMessage message, CancellationToken ct = default)
    {
        var o = options.Value;
        // A short timeout matters here: some hosts (Railway among them) block outbound SMTP entirely, and without this the
        // connection attempt hangs for minutes instead of failing fast.
        using var client = new SmtpClient(o.Host, o.Port) { EnableSsl = o.EnableSsl, Timeout = 15_000 };
        if (!string.IsNullOrEmpty(o.Username)) client.Credentials = new NetworkCredential(o.Username, o.Password);
        // Both a plain-text and an HTML version (mail without a text part scores worse with spam filters), a sender name, a reply address and the extra headers.
        using var mail = new MailMessage { From = new MailAddress(o.From, common.Value.FromName), Subject = message.Subject };
        mail.To.Add(message.To);
        if (!string.IsNullOrWhiteSpace(common.Value.ReplyTo)) mail.ReplyToList.Add(common.Value.ReplyTo);
        mail.AlternateViews.Add(AlternateView.CreateAlternateViewFromString(string.IsNullOrWhiteSpace(message.Text) ? System.Net.WebUtility.HtmlDecode(System.Text.RegularExpressions.Regex.Replace(message.Html, "<[^>]+>", " ")) : message.Text, null, "text/plain"));
        mail.AlternateViews.Add(AlternateView.CreateAlternateViewFromString(message.Html, null, "text/html"));
        foreach (var (name, value) in message.Headers ?? new Dictionary<string, string>()) mail.Headers.Add(name, value);
        await client.SendMailAsync(mail, ct);
    }
}

public class ResendOptions
{
    public const string Section = "Email:Resend";
    /// <summary>From resend.com/api-keys.</summary>
    public string ApiKey { get; set; } = "";
    /// <summary>Either a bare address or "Display Name &lt;address@domain&gt;". The domain must be verified in the Resend dashboard.</summary>
    public string From { get; set; } = "";
}

/// <summary>Sends through the Resend HTTPS API (api.resend.com), for hosts that block outbound SMTP.</summary>
public class ResendEmailSender(HttpClient http, IOptions<ResendOptions> options, IOptions<EmailCommonOptions>? commonOptions = null) : IEmailTransport
{
    public string Name => "resend";
    private readonly IOptions<EmailCommonOptions> common = commonOptions ?? Options.Create(new EmailCommonOptions());

    public async Task SendAsync(EmailMessage message, CancellationToken ct = default)
    {
        var o = options.Value;
        if (string.IsNullOrWhiteSpace(o.ApiKey) || string.IsNullOrWhiteSpace(o.From))
            throw new InvalidOperationException("Email:Resend:ApiKey and Email:Resend:From must both be set to use the Resend provider.");

        using var request = new HttpRequestMessage(HttpMethod.Post, "https://api.resend.com/emails")
        {
            Content = JsonContent.Create(new
            {
                from = common.Value.Sender(o.From),
                to = new[] { message.To },
                subject = message.Subject,
                html = message.Html,
                text = message.Text,
                reply_to = string.IsNullOrWhiteSpace(common.Value.ReplyTo) ? null : new[] { common.Value.ReplyTo },
                headers = message.Headers is { Count: > 0 } ? message.Headers : null,
            }),
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", o.ApiKey);

        using var response = await http.SendAsync(request, ct);
        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync(ct);
            throw new InvalidOperationException($"Resend returned {(int)response.StatusCode}: {(body.Length > 300 ? body[..300] : body)}");
        }
    }
}

/// <summary>Simulated payments for development and demos: everything succeeds at once and nothing real is charged. Set Billing:Provider=Razorpay for real money.</summary>
public class MockPaymentProvider(ILogger<MockPaymentProvider> log) : IPaymentProvider
{
    public string Name => "mock";
    public bool RequiresCheckout => false;

    public Task<PaymentResult> ChargeAsync(Guid tenantId, string planCode, decimal amount, string currency, CancellationToken ct = default)
    {
        log.LogInformation("[mock-payments] charged {Amount} {Currency} for tenant {Tenant} ({Plan})", amount, currency, tenantId, planCode);
        return Task.FromResult(new PaymentResult(true, $"mock_{Guid.NewGuid():N}"[..20], null));
    }

    public Task<string> EnsurePlanAsync(string planCode, string name, decimal price, string currency, string? existingId, decimal? existingAmount, CancellationToken ct = default) => throw new NotSupportedException();
    public Task<HostedCheckout> StartSubscriptionAsync(Guid tenantId, string planCode, string planName, string providerPlanId, decimal price, string currency, CancellationToken ct = default) => throw new NotSupportedException();
    public Task CancelSubscriptionAsync(string providerSubscriptionId, bool atCycleEnd, CancellationToken ct = default) => Task.CompletedTask;
    public bool VerifyCheckout(string paymentId, string subscriptionId, string signature) => false;
    public bool VerifyWebhook(string body, string? signature) => false;
}
